/**
 * MCP server definition: Google Ads reporting + Keyword Planner research.
 *
 * Read-only. Nothing here mutates campaigns, budgets, bids or assets.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { GAQL_RESOURCES } from "./gaql-resources.ts";
import {
  API_VERSION,
  GoogleAdsError,
  generateKeywordHistoricalMetrics,
  generateKeywordIdeas,
  listAccessibleCustomers,
  normalizeCustomerId,
  search,
  searchGoogleAdsFields,
  suggestGeoTargetConstants,
} from "./google-ads.ts";

const DEFAULT_LANGUAGE_ID = process.env.GOOGLE_ADS_DEFAULT_LANGUAGE_ID || "1000";
const DEFAULT_GEO_TARGET_IDS = (process.env.GOOGLE_ADS_DEFAULT_GEO_TARGETS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Falls back to the account this deployment is dedicated to. */
function resolveCustomerId(explicit?: string): string {
  const value = explicit || process.env.GOOGLE_ADS_CUSTOMER_ID;
  if (!value) {
    throw new GoogleAdsError(
      "No customer_id given and GOOGLE_ADS_CUSTOMER_ID is not set. " +
        "Call list_accessible_customers to find one.",
      400,
    );
  }
  return normalizeCustomerId(value);
}

function microsToUnits(micros?: string | number | null): number | null {
  if (micros === undefined || micros === null) return null;
  return Number(micros) / 1_000_000;
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const KEYWORD_NETWORKS = [
  "GOOGLE_SEARCH",
  "GOOGLE_SEARCH_AND_PARTNERS",
] as const;

/** Shapes a KeywordPlanIdea/HistoricalMetrics row into a compact record. */
function formatKeywordMetrics(
  text: string,
  metrics: any,
  includeMonthly: boolean,
) {
  return {
    keyword: text,
    avg_monthly_searches: metrics?.avgMonthlySearches
      ? Number(metrics.avgMonthlySearches)
      : 0,
    competition: metrics?.competition ?? "UNSPECIFIED",
    competition_index: metrics?.competitionIndex
      ? Number(metrics.competitionIndex)
      : null,
    low_top_of_page_bid: microsToUnits(metrics?.lowTopOfPageBidMicros),
    high_top_of_page_bid: microsToUnits(metrics?.highTopOfPageBidMicros),
    average_cpc: microsToUnits(metrics?.averageCpcMicros),
    ...(includeMonthly
      ? {
          monthly_search_volumes: (metrics?.monthlySearchVolumes ?? []).map(
            (m: any) => ({
              year: m.year,
              month: m.month,
              searches: m.monthlySearches ? Number(m.monthlySearches) : 0,
            }),
          ),
        }
      : {}),
  };
}

const SEARCH_DESCRIPTION = `Run a Google Ads Query Language (GAQL) query and return the rows.

This is the main reporting tool: campaign/ad group/keyword performance, budgets,
statuses, change history, conversions and so on.

### Writing the query
- Full GAQL syntax: https://developers.google.com/google-ads/api/docs/query/grammar
- Field names in the query are snake_case ('campaign.id', 'metrics.cost_micros').
  Field names in the RESPONSE are camelCase ('campaign.id', 'metrics.costMicros')
  because this server uses the REST transport.
- Use whole field names. Wildcards and partial fields are not allowed.
- Do NOT guess fields — call get_resource_metadata first to find out what a
  resource supports.
- Cost/bid fields are in micros: divide by 1,000,000 for the account currency.

### Dates
Dates are YYYY-MM-DD with dashes. Ranges must be finite (both ends), or use a
predefined range such as LAST_7_DAYS, LAST_30_DAYS, THIS_MONTH.

### Limits
- change_event queries must specify LIMIT <= 10000.
- Results are paged; pass the returned next_page_token to fetch more.
- The account is on the basic API access tier: 15,000 operations/day.

### Conversion issues
Look at offline_conversion_upload_conversion_action_summary, and see
https://developers.google.com/google-ads/api/docs/conversions/upload-summaries

### Valid resources (use in the FROM clause)
${GAQL_RESOURCES.join(", ")}`;

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "google-ads-mcp", version: "0.1.0" },
    {
      instructions:
        "Read-only access to Google Ads reporting (GAQL) and the Keyword " +
        "Planner. Use list_accessible_customers to discover accounts, " +
        "get_resource_metadata before writing a GAQL query, and " +
        "generate_keyword_ideas / keyword_historical_metrics for SEO and SEM " +
        "keyword research.",
    },
  );

  server.registerTool(
    "list_accessible_customers",
    {
      title: "List accessible Google Ads accounts",
      description:
        "Returns the customer IDs directly accessible to the authenticated " +
        "user. Use this first if no customer ID is known. Note that manager " +
        "(MCC) accounts appear here but their child accounts do not — query " +
        "customer_client from a manager account to enumerate those.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const response = await listAccessibleCustomers();
      const ids = (response.resourceNames ?? []).map((name) =>
        name.replace(/^customers\//, ""),
      );
      return json({
        customer_ids: ids,
        default_customer_id: process.env.GOOGLE_ADS_CUSTOMER_ID ?? null,
      });
    },
  );

  server.registerTool(
    "search",
    {
      title: "Run a GAQL query",
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        query: z
          .string()
          .describe("The full GAQL query, e.g. \"SELECT campaign.id, campaign.name, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS\""),
        customer_id: z
          .string()
          .optional()
          .describe(
            "10-digit customer ID (hyphens are stripped). Defaults to the account this server is configured for.",
          ),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe("Rows per page. Defaults to 250; raise it for bulk exports, lower it to save context."),
        page_token: z
          .string()
          .optional()
          .describe("next_page_token from a previous call, to fetch the next page."),
        login_customer_id: z
          .string()
          .optional()
          .describe(
            "Manager (MCC) account ID to authorize through. Only needed when overriding the configured default.",
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, customer_id, page_size, page_token, login_customer_id }) => {
      const result = await search(resolveCustomerId(customer_id), query, {
        pageSize: page_size ?? 250,
        pageToken: page_token,
        loginCustomerId: login_customer_id,
      });
      return json({
        row_count: result.results?.length ?? 0,
        next_page_token: result.nextPageToken ?? null,
        total_results_count: result.totalResultsCount ?? null,
        rows: result.results ?? [],
      });
    },
  );

  server.registerTool(
    "get_resource_metadata",
    {
      title: "Describe a Google Ads resource",
      description:
        "Returns the selectable, filterable and sortable fields for a Google " +
        "Ads resource (e.g. 'campaign', 'ad_group', 'keyword_view'), including " +
        "the metrics and segments that can be selected alongside it. " +
        "You MUST use this before writing a GAQL query rather than guessing " +
        "field names. Results are stable — cache them within a conversation.",
      inputSchema: {
        resource_name: z
          .string()
          .describe("Resource name in snake_case, e.g. 'campaign' or 'ad_group_criterion'."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ resource_name }) => {
      // Reject anything that could break out of the quoted GAQL literal.
      if (!/^[a-z0-9_]+$/.test(resource_name)) {
        throw new GoogleAdsError(
          `Invalid resource name "${resource_name}": expected lowercase snake_case.`,
          400,
        );
      }

      const selectable = new Set<string>();
      const filterable = new Set<string>();
      const sortable = new Set<string>();

      const collect = (rows: Record<string, any>[] | undefined) => {
        for (const field of rows ?? []) {
          if (field.selectable) selectable.add(field.name);
          if (field.filterable) filterable.add(field.name);
          if (field.sortable) sortable.add(field.name);
        }
      };

      // The resource's own attributes...
      const attributes = await searchGoogleAdsFields(
        `SELECT name, selectable, filterable, sortable ` +
          `WHERE name LIKE '${resource_name}.%' AND category = 'ATTRIBUTE'`,
      );
      collect(attributes.results);

      // ...plus every metric and segment compatible with it.
      const compatible = await searchGoogleAdsFields(
        `SELECT name, selectable, filterable, sortable ` +
          `WHERE selectable_with CONTAINS ANY('${resource_name}')`,
      );
      collect(compatible.results);

      if (selectable.size === 0 && filterable.size === 0) {
        throw new GoogleAdsError(
          `No fields found for resource "${resource_name}". Check the spelling ` +
            `against the resource list in the search tool description.`,
          404,
        );
      }

      return json({
        resource: resource_name,
        selectable: [...selectable].sort(),
        filterable: [...filterable].sort(),
        sortable: [...sortable].sort(),
      });
    },
  );

  server.registerTool(
    "generate_keyword_ideas",
    {
      title: "Keyword Planner: discover keywords",
      description:
        "Google Keyword Planner keyword discovery — the tool to use for SEO and " +
        "SEM keyword research. Give it seed keywords, a page URL, or both, and " +
        "it returns related keywords with average monthly search volume, " +
        "competition, and top-of-page bid ranges.\n\n" +
        "Search volumes are Google's own, so they are the same numbers the " +
        "Keyword Planner UI shows: rounded into buckets, and averaged over the " +
        "last 12 months unless a date range is given.\n\n" +
        "Geo targets and language matter a lot. Use find_geo_targets to look up " +
        "location IDs and find_language_constants for language IDs. Common IDs: " +
        "Finland 2246, Sweden 2752, United States 2840, United Kingdom 2826; " +
        "English 1000, Finnish 1019, Swedish 1015.",
      inputSchema: {
        keywords: z
          .array(z.string())
          .max(20)
          .optional()
          .describe("Up to 20 seed keywords. At least one of keywords or page_url is required."),
        page_url: z
          .string()
          .optional()
          .describe("A landing page or competitor URL to derive keyword ideas from."),
        geo_target_ids: z
          .array(z.string())
          .optional()
          .describe(
            "Geo target constant IDs, e.g. ['2246'] for Finland. Defaults to GOOGLE_ADS_DEFAULT_GEO_TARGETS, or worldwide if unset.",
          ),
        language_id: z
          .string()
          .optional()
          .describe(`Language constant ID. Defaults to ${DEFAULT_LANGUAGE_ID}.`),
        network: z
          .enum(KEYWORD_NETWORKS)
          .optional()
          .describe(
            "GOOGLE_SEARCH for Google.com only, GOOGLE_SEARCH_AND_PARTNERS (default) to include search partners.",
          ),
        include_adult_keywords: z.boolean().optional(),
        include_monthly_volumes: z
          .boolean()
          .optional()
          .describe(
            "Include the month-by-month search volume breakdown for each keyword. Verbose — leave off unless seasonality is the question.",
          ),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Maximum ideas to return. Defaults to 100."),
        customer_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const keywords = (args.keywords ?? []).map((k) => k.trim()).filter(Boolean);
      if (keywords.length === 0 && !args.page_url) {
        throw new GoogleAdsError(
          "Provide at least one of `keywords` or `page_url`.",
          400,
        );
      }

      const geoIds = args.geo_target_ids ?? DEFAULT_GEO_TARGET_IDS;
      const body: Record<string, unknown> = {
        language: `languageConstants/${args.language_id ?? DEFAULT_LANGUAGE_ID}`,
        geoTargetConstants: geoIds.map((id) => `geoTargetConstants/${id}`),
        keywordPlanNetwork: args.network ?? "GOOGLE_SEARCH_AND_PARTNERS",
        includeAdultKeywords: args.include_adult_keywords ?? false,
        pageSize: args.page_size ?? 100,
      };

      // The seed field is a oneof — exactly one of the three may be set.
      if (keywords.length > 0 && args.page_url) {
        body.keywordAndUrlSeed = { url: args.page_url, keywords };
      } else if (keywords.length > 0) {
        body.keywordSeed = { keywords };
      } else {
        body.urlSeed = { url: args.page_url };
      }

      const response = await generateKeywordIdeas(
        resolveCustomerId(args.customer_id),
        body,
      );

      const ideas = (response.results ?? []).map((row: any) =>
        formatKeywordMetrics(
          row.text,
          row.keywordIdeaMetrics,
          args.include_monthly_volumes ?? false,
        ),
      );
      ideas.sort(
        (a: any, b: any) => b.avg_monthly_searches - a.avg_monthly_searches,
      );

      return json({
        idea_count: ideas.length,
        geo_target_ids: geoIds,
        language_id: args.language_id ?? DEFAULT_LANGUAGE_ID,
        network: body.keywordPlanNetwork,
        note: "Bids are in the account currency. avg_monthly_searches is a 12-month average unless stated otherwise.",
        ideas,
      });
    },
  );

  server.registerTool(
    "keyword_historical_metrics",
    {
      title: "Keyword Planner: metrics for specific keywords",
      description:
        "Returns search volume, competition and bid ranges for an exact list of " +
        "keywords you already have — no idea expansion. Use this to size up a " +
        "keyword list you drafted, or to compare terms head to head. " +
        "For discovering new keywords use generate_keyword_ideas instead.",
      inputSchema: {
        keywords: z
          .array(z.string())
          .min(1)
          .max(10000)
          .describe("The exact keywords to look up."),
        geo_target_ids: z.array(z.string()).optional(),
        language_id: z.string().optional(),
        network: z.enum(KEYWORD_NETWORKS).optional(),
        include_adult_keywords: z.boolean().optional(),
        include_monthly_volumes: z
          .boolean()
          .optional()
          .describe("Include the month-by-month breakdown. Verbose."),
        customer_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const geoIds = args.geo_target_ids ?? DEFAULT_GEO_TARGET_IDS;
      const response = await generateKeywordHistoricalMetrics(
        resolveCustomerId(args.customer_id),
        {
          keywords: args.keywords,
          language: `languageConstants/${args.language_id ?? DEFAULT_LANGUAGE_ID}`,
          geoTargetConstants: geoIds.map((id) => `geoTargetConstants/${id}`),
          keywordPlanNetwork: args.network ?? "GOOGLE_SEARCH_AND_PARTNERS",
          includeAdultKeywords: args.include_adult_keywords ?? false,
        },
      );

      const rows = (response.results ?? []).map((row: any) => ({
        ...formatKeywordMetrics(
          row.text,
          row.keywordMetrics,
          args.include_monthly_volumes ?? false,
        ),
        // Google folds near-duplicates together and reports them once.
        close_variants: row.closeVariants ?? [],
      }));
      rows.sort(
        (a: any, b: any) => b.avg_monthly_searches - a.avg_monthly_searches,
      );

      return json({
        keyword_count: rows.length,
        geo_target_ids: geoIds,
        language_id: args.language_id ?? DEFAULT_LANGUAGE_ID,
        keywords: rows,
      });
    },
  );

  server.registerTool(
    "find_geo_targets",
    {
      title: "Look up geo target IDs",
      description:
        "Resolves place names (countries, regions, cities) to the geo target " +
        "constant IDs the keyword tools need. Search 'Helsinki' or 'Finland' " +
        "and use the returned id in geo_target_ids.",
      inputSchema: {
        location_names: z
          .array(z.string())
          .min(1)
          .max(25)
          .describe("Place names to resolve, e.g. ['Finland', 'Helsinki']."),
        locale: z
          .string()
          .optional()
          .describe("Locale for the returned names, e.g. 'en' or 'fi'. Defaults to 'en'."),
        country_code: z
          .string()
          .optional()
          .describe("Two-letter country code to scope the search, e.g. 'FI'."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ location_names, locale, country_code }) => {
      const response = await suggestGeoTargetConstants({
        locationNames: { names: location_names },
        locale: locale ?? "en",
        ...(country_code ? { countryCode: country_code.toUpperCase() } : {}),
      });

      const suggestions = (response.geoTargetConstantSuggestions ?? []).map(
        (s: any) => ({
          id: s.geoTargetConstant?.id,
          name: s.geoTargetConstant?.name,
          // e.g. "Helsinki,Uusimaa,Finland" — disambiguates same-named places.
          canonical_name: s.geoTargetConstant?.canonicalName,
          country_code: s.geoTargetConstant?.countryCode,
          target_type: s.geoTargetConstant?.targetType,
          status: s.geoTargetConstant?.status,
          parents: (s.geoTargetConstantParents ?? []).map(
            (p: any) => p.canonicalName ?? p.name,
          ),
          search_term: s.searchTerm,
          reach: s.reach ? Number(s.reach) : null,
        }),
      );

      return json({ match_count: suggestions.length, matches: suggestions });
    },
  );

  server.registerTool(
    "find_language_constants",
    {
      title: "Look up language IDs",
      description:
        "Lists the language constant IDs used by the keyword tools. Optionally " +
        "filter by a language code such as 'fi', 'en' or 'sv'.",
      inputSchema: {
        language_code: z
          .string()
          .optional()
          .describe("Two-letter language code to filter by. Omit to list all languages."),
        customer_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ language_code, customer_id }) => {
      if (language_code && !/^[a-zA-Z_-]{2,10}$/.test(language_code)) {
        throw new GoogleAdsError(
          `Invalid language code "${language_code}".`,
          400,
        );
      }

      const where = language_code
        ? ` WHERE language_constant.code = '${language_code}'`
        : "";
      const result = await search(
        resolveCustomerId(customer_id),
        `SELECT language_constant.id, language_constant.code, ` +
          `language_constant.name, language_constant.targetable ` +
          `FROM language_constant${where} ORDER BY language_constant.name`,
        { pageSize: 500 },
      );

      return json({
        languages: (result.results ?? []).map((row: any) => ({
          id: row.languageConstant?.id,
          code: row.languageConstant?.code,
          name: row.languageConstant?.name,
          targetable: row.languageConstant?.targetable,
        })),
      });
    },
  );

  server.registerResource(
    "api-info",
    "resource://google-ads-mcp/info",
    {
      title: "Server configuration",
      description:
        "Which Google Ads API version and account this server is wired to.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              api_version: API_VERSION,
              default_customer_id: process.env.GOOGLE_ADS_CUSTOMER_ID ?? null,
              login_customer_id: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? null,
              default_language_id: DEFAULT_LANGUAGE_ID,
              default_geo_target_ids: DEFAULT_GEO_TARGET_IDS,
              access_tier:
                "Basic: 15,000 operations/day, 1,000 get requests/day.",
              read_only: true,
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  return server;
}
