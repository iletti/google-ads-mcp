/**
 * Streamable-HTTP MCP endpoint.
 *
 * The path segment doubles as the shared secret: claude.ai custom connectors
 * cannot send custom headers, so the URL itself is the credential. Anything
 * that does not match MCP_SECRET gets an indistinguishable 404.
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createServer } from "../_lib/server.ts";

type VercelRequest = IncomingMessage & {
  query: Record<string, string | string[]>;
  body?: unknown;
};
type VercelResponse = ServerResponse & {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
};

function secretMatches(provided: string): boolean {
  const expected = process.env.MCP_SECRET;
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so compare lengths first — the
  // length of the secret is not itself sensitive.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Reads the raw request body when the platform has not already parsed it. */
async function readBody(req: VercelRequest): Promise<unknown> {
  if (req.body !== undefined && req.body !== null && req.body !== "") {
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/** Copies a web Response onto the Node response, streaming the body if needed. */
async function writeResponse(res: VercelResponse, response: Response) {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const raw = req.query?.secret;
  const provided = Array.isArray(raw) ? raw[0] : raw;

  if (!provided || !secretMatches(provided)) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  if (req.method !== "POST") {
    // Stateless mode has no server-initiated stream and no session to delete,
    // so GET (SSE) and DELETE have nothing to do.
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST." },
      id: null,
    });
    return;
  }

  const server = createServer();
  // Stateless: every serverless invocation is an independent server instance,
  // and the transport must not be reused across requests.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    const parsedBody = await readBody(req);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    // The spec requires clients to accept both content types. Some do not send
    // text/event-stream; since JSON responses are enabled above, honouring them
    // anyway is safe and avoids a spurious 406.
    headers.set("accept", "application/json, text/event-stream");
    headers.set("content-type", "application/json");

    const webRequest = new Request(
      `https://${req.headers.host ?? "localhost"}${req.url ?? "/"}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(parsedBody ?? {}),
      },
    );

    await server.connect(transport);
    const response = await transport.handleRequest(webRequest, { parsedBody });
    await writeResponse(res, response);
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    } else {
      res.end();
    }
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
