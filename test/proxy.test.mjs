import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createProxyServer, apiPath, forwardHeaders } from '../server.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function harness(t, handler) {
  let seen;
  const upstream = http.createServer(handler);
  const upstreamBase = await listen(upstream);
  const port = upstream.address().port;
  const proxy = createProxyServer({ upstreamRequest(options, callback) {
    seen = options;
    return http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port }, callback);
  }});
  const base = await listen(proxy);
  t.after(async () => {
    for (const server of [proxy, upstream]) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
  return { base, upstreamBase, seen: () => seen };
}

test('API path aliases preserve all API versions', () => {
  assert.equal(apiPath('/api/v1/chat/completions'), '/api/v1/chat/completions');
  assert.equal(apiPath('/api/v2/anything'), '/api/v2/anything');
  assert.equal(apiPath('/v1/embeddings'), '/api/v1/embeddings');
  assert.equal(apiPath('/models'), '/api/v1/models');
});

test('IP, geographic, browser and cookie headers are not forwarded', () => {
  const result = forwardHeaders({
    authorization: 'Bearer dummy-test-key', 'content-type': 'application/json',
    'x-openrouter-title': 'Test', 'cf-ipcountry': 'XX', 'cf-connecting-ip': '192.0.2.1',
    'true-client-ip': '192.0.2.2', 'x-real-ip': '192.0.2.3',
    forwarded: 'for=192.0.2.4', 'x-forwarded-for': '192.0.2.5',
    cookie: 'country=XX', 'accept-language': 'xx', 'x-country': 'XX',
    'user-agent': 'test-browser', connection: 'x-openrouter-title',
  });
  assert.deepEqual(result, {
    authorization: 'Bearer dummy-test-key', 'content-type': 'application/json',
  });
});

test('body, query, method, key, upstream errors and cookies are preserved', async t => {
  const body = '{ "stream":false, "tools":[], "custom":[1,2] }';
  let received = '';
  const h = await harness(t, async (req, res) => {
    for await (const chunk of req) received += chunk;
    assert.equal(req.url, '/api/v1/chat/completions?tag=a&tag=b');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, 'Bearer dummy-test-key');
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers['x-real-ip'], undefined);
    res.writeHead(429, {
      'content-type': 'application/json', 'retry-after': '3',
      'set-cookie': ['a=1; Secure', 'b=2; Secure'],
    });
    res.end('{"error":{"message":"mock limit"}}');
  });
  const response = await fetch(`${h.base}/v1/chat/completions?tag=a&tag=b`, {
    method: 'POST', headers: {
      authorization: 'Bearer dummy-test-key', 'content-type': 'application/json',
      cookie: 'country=XX', 'x-real-ip': '192.0.2.1',
    }, body,
  });
  assert.equal(response.status, 429);
  assert.equal(await response.text(), '{"error":{"message":"mock limit"}}');
  assert.equal(received, body);
  assert.equal(response.headers.get('retry-after'), '3');
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.equal(h.seen().hostname, 'openrouter.ai');
  assert.equal(h.seen().protocol, 'https:');
});

test('SSE first event arrives before upstream completes', async t => {
  let completed = false;
  let finish;
  const h = await harness(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    finish = () => {
      completed = true;
      res.end('data: [DONE]\n\n');
    };
  });
  const response = await fetch(`${h.base}/chat/completions`, { method: 'POST', body: '{"stream":true}' });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(completed, false);
  assert.match(new TextDecoder().decode(first.value), /hello/);
  finish();
  let rest = '';
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    rest += new TextDecoder().decode(next.value);
  }
  assert.match(rest, /\[DONE\]/);
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
});

test('CORS preflight and health do not contact upstream', async t => {
  const h = await harness(t, () => assert.fail('unexpected upstream request'));
  const preflight = await fetch(`${h.base}/api/v1/chat/completions`, {
    method: 'OPTIONS', headers: {
      origin: 'https://example.com', 'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'authorization,content-type');
  const health = await fetch(`${h.base}/health`);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal(h.seen(), undefined);
});

test('upstream redirects are returned without forwarding keys elsewhere', async t => {
  const h = await harness(t, (_req, res) => {
    res.writeHead(307, { location: 'https://example.com/other' });
    res.end();
  });
  const response = await fetch(`${h.base}/models`, { redirect: 'manual' });
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('location'), 'https://example.com/other');
  assert.equal(h.seen().hostname, 'openrouter.ai');
});

test('client cancellation closes the upstream response', async t => {
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const h = await harness(t, (_req, res) => {
    res.on('close', upstreamClosed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
  });
  const response = await fetch(`${h.base}/chat/completions`);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await closed;
});
