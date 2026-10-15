import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream";
import { pathToFileURL } from "node:url";

const ALLOWED_HEADERS = new Set([
  "authorization",
  "accept",
  "content-type",
  "content-encoding",
  "range",
  "if-none-match",
  "if-modified-since",
  "idempotency-key",
  "http-referer",
  "x-title",
  "openrouter-title",
  "anthropic-version",
  "anthropic-beta",
  "openai-organization",
  "openai-project",
]);

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function apiPath(path) {
  if (path === "/api" || path.startsWith("/api/")) return path;
  if (path === "/v1" || path.startsWith("/v1/")) return `/api${path}`;
  return `/api/v1${path}`;
}

export function forwardHeaders(incoming) {
  const connectionHeaders = new Set(
    String(incoming.connection || "").toLowerCase().split(",").map((s) => s.trim()),
  );
  const headers = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (
      value !== undefined &&
      !connectionHeaders.has(name) &&
      (ALLOWED_HEADERS.has(name) || name.startsWith("x-openrouter-"))
    ) {
      headers[name] = value;
    }
  }
  return headers;
}

function responseHeaders(incoming) {
  const blocked = new Set(HOP_HEADERS);
  for (const name of String(incoming.connection || "").split(",")) {
    blocked.add(name.trim().toLowerCase());
  }
  const headers = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (
      value !== undefined &&
      !blocked.has(name) &&
      !name.startsWith("access-control-")
    ) {
      headers[name] = value;
    }
  }
  if (String(headers["content-type"]).toLowerCase().includes("text/event-stream")) {
    headers["cache-control"] = "no-cache, no-transform";
    headers["x-accel-buffering"] = "no";
  }
  return headers;
}

function cors(headers) {
  return {
    ...headers,
    "access-control-allow-origin": "*",
    "access-control-expose-headers": Object.keys(headers)
      .filter((name) => name !== "set-cookie" && name !== "set-cookie2")
      .join(", "),
  };
}

function sendError(res, status, message) {
  if (res.destroyed) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, cors({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  }));
  res.end(JSON.stringify({ error: { message, type: "proxy_error", code: status } }));
}

export function createProxyServer({ upstreamRequest = https.request } = {}) {
  const server = http.createServer((req, res) => {
    if (req.method === "CONNECT" || req.headers.upgrade) {
      sendError(res, 405, "HTTP API requests only");
      return;
    }

    if (req.method === "OPTIONS" && req.headers["access-control-request-method"]) {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
        "access-control-allow-headers": req.headers["access-control-request-headers"] ||
          "Authorization, Content-Type",
        "access-control-max-age": "86400",
        "vary": "Access-Control-Request-Headers, Access-Control-Request-Method",
      });
      res.end();
      return;
    }

    let url;
    try {
      url = new URL(req.url, "http://proxy.invalid");
    } catch {
      sendError(res, 400, "Invalid URL");
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/health") {
      res.writeHead(200, cors({ "content-type": "application/json" }));
      res.end(req.method === "HEAD" ? undefined : '{"ok":true}');
      return;
    }

    const upstream = upstreamRequest({
      protocol: "https:",
      hostname: "openrouter.ai",
      port: 443,
      method: req.method,
      path: apiPath(url.pathname) + url.search,
      headers: forwardHeaders(req.headers),
    }, (reply) => {
      if (res.destroyed) {
        reply.destroy();
        return;
      }
      res.writeHead(reply.statusCode || 502, cors(responseHeaders(reply.headers)));
      res.flushHeaders();
      pipeline(reply, res, () => {});
    });

    upstream.setTimeout(300_000, () => {
      sendError(res, 504, "OpenRouter connection timed out");
      upstream.destroy();
    });
    upstream.on("error", () => sendError(res, 502, "OpenRouter connection failed"));
    req.on("aborted", () => upstream.destroy());
    req.on("error", () => upstream.destroy());
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  });

  server.requestTimeout = 300_000;
  server.headersTimeout = 60_000;
  server.on("connect", (_req, socket) => {
    socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
  });
  server.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createProxyServer();
  server.listen(Number(process.env.PORT || 10000), "0.0.0.0", () => {
    console.log("OpenRouter proxy listening");
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 10_000).unref();
    });
  }
}
