# OpenRouter proxy

HTTP API proxy for OpenRouter. Run with Node.js 22 or later using `npm start`.
Deploy `render.yaml` as a Render Blueprint on the Free instance plan.

Set the client's base URL to `https://SERVICE.onrender.com/api/v1` and use its own
OpenRouter API key as `Authorization: Bearer ...`. No server-side API key or relay
token is used. `/v1/*` and unprefixed API paths are also supported.

Request and response bodies are streamed without JSON parsing, model mapping,
retries, or response conversion. Upstream status codes and response cookies are
preserved. Connection inactivity times out after five minutes. HTTP redirects are
returned unchanged. WebSockets and CONNECT tunneling are not supported.

Only the API headers listed in `server.mjs` and `x-openrouter-*` headers are sent
upstream. Client cookies, forwarding/IP headers, browser language, and arbitrary
client headers are not forwarded. Cross-origin browser requests use Bearer keys;
credentialed cookie authentication is not supported. The application does not log
keys, headers, request bodies, or responses. Hosting infrastructure may retain its
own request metadata. The upstream can see the hosting server's connection IP.

`GET /health` is local; all other paths target `https://openrouter.ai` exclusively.
Free Render services sleep after 15 minutes without traffic and share the
workspace's free instance hours and bandwidth. Hosting cannot guarantee upstream
access; verify the deployed service before switching clients.
