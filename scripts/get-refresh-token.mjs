#!/usr/bin/env node
/**
 * Mints a Google OAuth refresh token with the Google Ads scope.
 *
 * Run this locally (never on a server — it needs a browser and prints a
 * long-lived credential):
 *
 *   GOOGLE_ADS_OAUTH_CLIENT_ID=... GOOGLE_ADS_OAUTH_CLIENT_SECRET=... \
 *     node scripts/get-refresh-token.mjs
 *
 * The OAuth client must be a "Web application" client with
 * http://localhost:8765/oauth2callback listed as an authorized redirect URI.
 *
 * If the client already has a different loopback URI registered, point the
 * script at it instead of editing the client — Google rejects the whole flow
 * with redirect_uri_mismatch unless the two match character for character:
 *
 *   OAUTH_REDIRECT_URI=http://127.0.0.1:9000/callback node scripts/get-refresh-token.mjs
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const REDIRECT_URI =
  process.env.OAUTH_REDIRECT_URI ||
  `http://localhost:${Number(process.env.OAUTH_PORT || 8765)}/oauth2callback`;

const redirect = new URL(REDIRECT_URI);
const PORT = Number(redirect.port || 80);
const CALLBACK_PATH = redirect.pathname;
const SCOPE = "https://www.googleapis.com/auth/adwords";

const clientId = process.env.GOOGLE_ADS_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_ADS_OAUTH_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Set GOOGLE_ADS_OAUTH_CLIENT_ID and GOOGLE_ADS_OAUTH_CLIENT_SECRET first.",
  );
  process.exit(1);
}

const state = randomBytes(16).toString("hex");

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPE);
// Without both of these Google returns an access token but no refresh token.
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");
authUrl.searchParams.set("state", state);

console.log(`\nRedirect URI this run will send: ${REDIRECT_URI}`);
console.log(
  "It must be listed VERBATIM under \"Authorized redirect URIs\" on the OAuth\n" +
    "client, or Google returns redirect_uri_mismatch.\n",
);
console.log("Open this URL in the browser logged in as the Google Ads user:\n");
console.log(authUrl.toString());
console.log("\nWaiting for the redirect back to localhost...\n");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== CALLBACK_PATH) {
    res.writeHead(404).end();
    return;
  }

  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");

  if (error || !code) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end(`Authorization failed: ${error || "no code returned"}`);
    console.error(`Authorization failed: ${error || "no code returned"}`);
    server.close();
    process.exit(1);
  }

  if (url.searchParams.get("state") !== state) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("State mismatch — aborting.");
    console.error("State mismatch — aborting.");
    server.close();
    process.exit(1);
  }

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  const payload = await tokenResponse.json();

  if (!tokenResponse.ok || !payload.refresh_token) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("Token exchange failed — see the terminal.");
    console.error("Token exchange failed:", payload.error_description || payload);
    server.close();
    process.exit(1);
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    "<h1>Done</h1><p>Refresh token printed in your terminal. You can close this tab.</p>",
  );

  console.log("GOOGLE_ADS_REFRESH_TOKEN=" + payload.refresh_token);
  console.log(
    "\nPaste that into the Vercel project environment variables. " +
      "Treat it like a password — it grants ongoing access to the Google Ads account.\n",
  );

  server.close();
  process.exit(0);
});

server.listen(PORT);
