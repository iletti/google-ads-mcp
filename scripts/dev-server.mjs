#!/usr/bin/env node --experimental-strip-types
/**
 * Runs the Vercel function locally so you can exercise the MCP endpoint with
 * curl or an MCP client before deploying.
 *
 *   MCP_SECRET=dev npm run dev
 *   curl -s -X POST http://localhost:3000/mcp/dev \
 *     -H 'content-type: application/json' \
 *     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
 *
 * It reproduces the small bits of the Vercel request/response contract the
 * handler relies on: `req.query`, `res.status()` and `res.json()`.
 */

import { createServer } from "node:http";
import { register } from "node:module";

// Must be registered before the handler is imported — see ts-resolver.mjs.
register("./ts-resolver.mjs", import.meta.url);

const PORT = Number(process.env.PORT || 3000);
const { default: handler } = await import("../api/mcp/[secret].ts");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const match = url.pathname.match(/^\/(?:api\/)?mcp\/([^/]+)$/);

  if (!match) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");

  req.query = { secret: decodeURIComponent(match[1]) };
  req.body = raw ? JSON.parse(raw) : undefined;

  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    if (!res.headersSent) res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };

  await handler(req, res);
});

server.listen(PORT, () => {
  console.log(`MCP dev server: http://localhost:${PORT}/mcp/${process.env.MCP_SECRET || "<MCP_SECRET unset>"}`);
});
