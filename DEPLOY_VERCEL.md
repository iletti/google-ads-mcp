# Deploying to Vercel and connecting to claude.ai

This repo contains two servers:

| | Upstream (`ads_mcp/`) | This deployment (`api/`) |
|---|---|---|
| Language | Python (FastMCP) | TypeScript |
| Transport | stdio, or streamable HTTP on Cloud Run | streamable HTTP on Vercel |
| Google Ads client | `google-ads` SDK (gRPC) | REST API via `fetch` |
| Auth to Google | interactive OAuth per user | one stored refresh token |
| Keyword Planner | ✗ | ✓ |

The Python server is untouched and still works locally. It cannot run on
Vercel: `google-ads` ships generated protobufs for every supported API version
plus gRPC, which exceeds the 250 MB function limit, and FastMCP's OAuth
provider needs state that a serverless function does not have.

---

## 1. Google Cloud prerequisites

You need four things. If you already have them, skip to step 2.

1. **A Google Cloud project** with the **Google Ads API** enabled
   (APIs & Services → Library → "Google Ads API" → Enable).
2. **A developer token** — Google Ads UI → Tools → API Center. Basic access is
   enough: 15,000 operations/day and 1,000 `get` requests/day. This server
   never uses `get`; everything goes through `search`, which counts as an
   operation.
3. **An OAuth 2.0 client** — APIs & Services → Credentials → Create credentials
   → OAuth client ID → **Web application**. Under *Authorized redirect URIs*
   add exactly:

   ```
   http://localhost:8765/oauth2callback
   ```

   Note the client ID and client secret.
4. **The customer ID of the account to control** — `678-105-1480`
   (Potero Standard). The server strips the hyphens for you.

If the account you are authorizing (`ottoilarischmidt@gmail.com`, the manager
account `633-084-4584`) reaches the target account through a manager (MCC),
you also need `GOOGLE_ADS_LOGIN_CUSTOMER_ID` set to that manager's ID.

## 2. Mint a refresh token

Run this **locally**, in a browser session logged in as the Google account that
has access to the Ads account:

```bash
npm install
GOOGLE_ADS_OAUTH_CLIENT_ID=xxx.apps.googleusercontent.com \
GOOGLE_ADS_OAUTH_CLIENT_SECRET=xxx \
  npm run get-refresh-token
```

Open the printed URL, approve, and the script prints
`GOOGLE_ADS_REFRESH_TOKEN=...`. Treat it like a password — it grants ongoing
read access to the Ads account and does not expire on its own.

## 3. Generate an endpoint secret

claude.ai custom connectors cannot send custom headers, so the URL itself is
the credential. Generate a long random one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 4. Deploy on Vercel

1. Go to <https://vercel.com/new> and import `iletti/google-ads-mcp`.
2. Set **Production Branch** to `claude/google-ads-mcp-vercel-ycmt2a`
   (Project Settings → Git), or merge this branch to `main` first.
3. Framework preset: **Other**. No build command, no output directory —
   Vercel picks up `api/` automatically.
4. Add the environment variables below, then **Deploy**.

| Variable | Required | Value |
|---|---|---|
| `MCP_SECRET` | ✓ | The random string from step 3 |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | ✓ | Your 22-character developer token |
| `GOOGLE_ADS_OAUTH_CLIENT_ID` | ✓ | OAuth client ID |
| `GOOGLE_ADS_OAUTH_CLIENT_SECRET` | ✓ | OAuth client secret |
| `GOOGLE_ADS_REFRESH_TOKEN` | ✓ | From step 2 |
| `GOOGLE_ADS_CUSTOMER_ID` | recommended | `6781051480` — used when a tool call omits `customer_id` |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | if using an MCC | e.g. `6330844584` |
| `GOOGLE_ADS_DEFAULT_GEO_TARGETS` | optional | Comma-separated geo IDs for keyword research, e.g. `2246` (Finland) |
| `GOOGLE_ADS_DEFAULT_LANGUAGE_ID` | optional | Default `1000` (English). Finnish is `1019` |
| `GOOGLE_ADS_API_VERSION` | optional | Default `v24` |

**Turn off Deployment Protection** (Project Settings → Deployment Protection →
Vercel Authentication → Disabled) for Production. Otherwise Vercel intercepts
claude.ai's requests with a login page. The `MCP_SECRET` path is what protects
the endpoint.

## 5. Verify

```bash
BASE=https://<your-project>.vercel.app
SECRET=<MCP_SECRET>

# Should be 404 — the secret gate works
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/mcp/wrong \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Should list 7 tools
curl -s -X POST $BASE/mcp/$SECRET \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Should return your accessible customer IDs — this one hits Google
curl -s -X POST $BASE/mcp/$SECRET \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_accessible_customers","arguments":{}}}'
```

## 6. Connect to claude.ai

1. claude.ai → Settings → **Connectors** → **Add custom connector**.
2. Name: `Google Ads`.
3. URL: `https://<your-project>.vercel.app/mcp/<MCP_SECRET>`
4. Leave OAuth fields empty. Add.

Then try:

- *"What Google Ads accounts do I have access to?"*
- *"How did my campaigns perform in the last 7 days?"*
- *"Find SEO keyword ideas for potero.fi in Finnish, targeting Finland."*
- *"What's the monthly search volume for these ten keywords in Finland?"*

## Local development

```bash
MCP_SECRET=dev npm run dev
# then: http://localhost:3000/mcp/dev
```

`scripts/dev-server.mjs` reproduces the bits of Vercel's request contract the
handler depends on, so you can exercise the endpoint with curl before
deploying. Add the Google credentials as env vars to test live calls.

## Notes and limits

- **Read-only.** Nothing here can change bids, budgets, or campaign status.
- **Quota.** Basic access is 15,000 operations/day. Each `search` page, keyword
  idea request, and metadata lookup is one operation.
- **Response shape.** Because this uses the REST transport, GAQL queries are
  written in snake_case (`metrics.cost_micros`) but responses come back in
  camelCase (`metrics.costMicros`).
- **Money fields** are in micros — divide by 1,000,000.
- **Rotating the secret**: change `MCP_SECRET` in Vercel, redeploy, and update
  the connector URL in claude.ai.
