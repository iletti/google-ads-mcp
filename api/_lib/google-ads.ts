/**
 * Minimal Google Ads REST client.
 *
 * The official `google-ads` Python/Node SDKs bundle generated protobufs for
 * every supported API version plus grpc, which is far too large for a Vercel
 * serverless function. The REST surface exposes everything this server needs,
 * so we talk to it directly with `fetch`.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v24";
const API_BASE = `https://googleads.googleapis.com/${API_VERSION}`;

/** Access tokens live ~1h; cache across warm invocations of the same lambda. */
let cachedToken: { value: string; expiresAt: number } | null = null;

export class GoogleAdsError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "GoogleAdsError";
    this.status = status;
    this.details = details;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new GoogleAdsError(
      `Missing required environment variable ${name}. Set it in the Vercel project settings.`,
      500,
    );
  }
  return value;
}

/** Strips the 123-456-7890 formatting Google Ads UI uses. */
export function normalizeCustomerId(customerId: string): string {
  const digits = String(customerId).replace(/\D/g, "");
  if (digits.length !== 10) {
    throw new GoogleAdsError(
      `Invalid customer ID "${customerId}": expected 10 digits, got ${digits.length}.`,
      400,
    );
  }
  return digits;
}

async function getAccessToken(): Promise<string> {
  // Refresh a minute early so a token never expires mid-request.
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const body = new URLSearchParams({
    client_id: requireEnv("GOOGLE_ADS_OAUTH_CLIENT_ID"),
    client_secret: requireEnv("GOOGLE_ADS_OAUTH_CLIENT_SECRET"),
    refresh_token: requireEnv("GOOGLE_ADS_REFRESH_TOKEN"),
    grant_type: "refresh_token",
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !payload.access_token) {
    // Never echo the request body back — it carries the client secret.
    throw new GoogleAdsError(
      `Failed to refresh the Google OAuth access token: ${
        payload.error_description || payload.error || response.statusText
      }. Check GOOGLE_ADS_OAUTH_CLIENT_ID / _SECRET / GOOGLE_ADS_REFRESH_TOKEN.`,
      response.status,
    );
  }

  cachedToken = {
    value: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

/** Turns the nested Google Ads failure payload into something an LLM can act on. */
function formatApiError(status: number, payload: any): GoogleAdsError {
  const requestId = payload?.error?.details?.[0]?.requestId;
  const failures: string[] = [];

  for (const detail of payload?.error?.details ?? []) {
    for (const err of detail?.errors ?? []) {
      const code = err?.errorCode ? Object.values(err.errorCode).join("/") : "";
      const location = (err?.location?.fieldPathElements ?? [])
        .map((el: any) => el.fieldName)
        .filter(Boolean)
        .join(".");
      failures.push(
        [err?.message, code && `[${code}]`, location && `(at ${location})`]
          .filter(Boolean)
          .join(" "),
      );
    }
  }

  if (failures.length === 0 && payload?.error?.message) {
    failures.push(payload.error.message);
  }

  const message = [
    `Google Ads API error (HTTP ${status})`,
    requestId ? `request id ${requestId}` : null,
    failures.length ? `\n${failures.join("\n")}` : null,
  ]
    .filter(Boolean)
    .join(": ");

  return new GoogleAdsError(message, status, payload?.error);
}

async function apiRequest<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; loginCustomerId?: string },
): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${await getAccessToken()}`,
    "developer-token": requireEnv("GOOGLE_ADS_DEVELOPER_TOKEN"),
    "content-type": "application/json",
  };

  // The manager account through which the request is authorized. Required when
  // the authenticated user reaches the target account via an MCC.
  const loginCustomerId =
    init.loginCustomerId || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  if (loginCustomerId) {
    headers["login-customer-id"] = normalizeCustomerId(loginCustomerId);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await response.text();
  let payload: any = undefined;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new GoogleAdsError(
        `Google Ads API returned a non-JSON response (HTTP ${response.status}): ${text.slice(0, 500)}`,
        response.status,
      );
    }
  }

  if (!response.ok) {
    throw formatApiError(response.status, payload);
  }
  return payload as T;
}

export interface SearchResult {
  results: Record<string, any>[];
  nextPageToken?: string;
  totalResultsCount?: string;
  fieldMask?: string;
}

/**
 * Runs a GAQL query via GoogleAdsService.Search.
 *
 * We use `search` rather than `searchStream` deliberately: paging keeps a
 * single response bounded, which matters both for the serverless response size
 * and for the model's context window.
 */
export async function search(
  customerId: string,
  query: string,
  options: { pageSize?: number; pageToken?: string; loginCustomerId?: string } = {},
): Promise<SearchResult> {
  const cid = normalizeCustomerId(customerId);
  return apiRequest<SearchResult>(`/customers/${cid}/googleAds:search`, {
    method: "POST",
    loginCustomerId: options.loginCustomerId,
    body: {
      query,
      pageSize: options.pageSize,
      pageToken: options.pageToken,
    },
  });
}

/** Queries GoogleAdsFieldService, which is account-independent. */
export async function searchGoogleAdsFields(
  query: string,
): Promise<{ results?: Record<string, any>[] }> {
  return apiRequest(`/googleAdsFields:search`, {
    method: "POST",
    body: { query },
  });
}

export async function listAccessibleCustomers(): Promise<{
  resourceNames?: string[];
}> {
  return apiRequest(`/customers:listAccessibleCustomers`, { method: "GET" });
}

export async function generateKeywordIdeas(
  customerId: string,
  body: Record<string, unknown>,
  loginCustomerId?: string,
): Promise<any> {
  const cid = normalizeCustomerId(customerId);
  return apiRequest(`/customers/${cid}:generateKeywordIdeas`, {
    method: "POST",
    body,
    loginCustomerId,
  });
}

export async function generateKeywordHistoricalMetrics(
  customerId: string,
  body: Record<string, unknown>,
  loginCustomerId?: string,
): Promise<any> {
  const cid = normalizeCustomerId(customerId);
  return apiRequest(`/customers/${cid}:generateKeywordHistoricalMetrics`, {
    method: "POST",
    body,
    loginCustomerId,
  });
}

export async function suggestGeoTargetConstants(
  body: Record<string, unknown>,
): Promise<any> {
  return apiRequest(`/geoTargetConstants:suggest`, { method: "POST", body });
}
