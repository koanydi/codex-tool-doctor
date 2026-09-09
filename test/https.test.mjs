import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { request } from '../src/probe.mjs';

const execFileAsync = promisify(execFile);
const probeUrl = new URL('../src/probe.mjs', import.meta.url).href;
const caPath = fileURLToPath(new URL('./fixtures/tls/ca.pem', import.meta.url));
// These public test fixtures must never be used outside loopback tests. The CA
// signing key is discarded; only the leaf server's test key is retained.
const [ca, cert, key] = await Promise.all([
  readFile(caPath),
  readFile(new URL('./fixtures/tls/server-cert.pem', import.meta.url)),
  readFile(new URL('./fixtures/tls/server-key.pem', import.meta.url)),
]);
const route = '/router/api/v1/responses?api-version=fixture%2Fv1';
const body = { model: 'fixture-model', input: '本地TLS往返', stream: false };
const token = 'fixture-bearer-token';
const headers = { 'x-route-key': 'fixture-route-key' };
const responseBody = JSON.stringify({ status: 'completed', output: [], marker: '本地响应' });
const expectedResponse = {
  status: 201, requestId: 'fixture-request-id',
  contentType: 'application/json; charset=utf-8', raw: responseBody,
};

async function router(t, protocol) {
  const seen = [], sockets = new Set();
  const handler = (req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method, path: req.url, headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        encrypted: req.socket.encrypted === true,
      });
      res.writeHead(expectedResponse.status, {
        'content-type': expectedResponse.contentType,
        'x-request-id': expectedResponse.requestId,
      });
      res.end(responseBody);
    });
  };
  const server = protocol === 'http'
    ? http.createServer(handler)
    : https.createServer({ key, cert }, handler);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    // Include sockets whose TLS handshake has not completed.
    for (const socket of sockets) socket.destroy();
  }));
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  assert.equal(server.address().address, '127.0.0.1');
  const host = `127.0.0.1:${server.address().port}`;
  return { endpoint: `${protocol}://${host}${route}`, host, seen };
}

function assertRoundTrip(server, response, encrypted) {
  assert.deepEqual(response, expectedResponse);
  assert.equal(server.seen.length, 1);
  const [received] = server.seen;
  assert.equal(received.method, 'POST');
  assert.equal(received.path, route);
  assert.equal(received.headers.host, server.host);
  assert.equal(received.headers.authorization, `Bearer ${token}`);
  assert.equal(received.headers['x-route-key'], headers['x-route-key']);
  assert.equal(received.headers['content-type'], 'application/json');
  assert.equal(received.headers.accept, 'text/event-stream, application/json');
  assert.equal(received.headers['content-length'], String(Buffer.byteLength(JSON.stringify(body))));
  assert.equal(received.body, JSON.stringify(body));
  assert.equal(received.encrypted, encrypted);
}

async function childRequest(endpoint, trustCa = false) {
  // NODE_EXTRA_CA_CERTS is read at process startup. Keep the parent's environment
  // untouched and remove inherited TLS overrides, preload hooks and proxy opt-in.
  const excluded = new Set([
    'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS',
    'NODE_TEST_CONTEXT', 'NODE_USE_SYSTEM_CA', 'NODE_USE_ENV_PROXY',
    'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ]);
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !excluded.has(name.toUpperCase())));
  if (trustCa) env.NODE_EXTRA_CA_CERTS = caPath;
  const script = `
    import { request } from ${JSON.stringify(probeUrl)};
    try {
      const response = await request(process.argv[1], ${JSON.stringify(token)},
        ${JSON.stringify(body)}, 5000, ${JSON.stringify(headers)});
      process.stdout.write(JSON.stringify({ ok: true, response }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
    }
  `;
  const { stdout, stderr } = await execFileAsync(process.execPath,
    ['--input-type=module', '--eval', script, endpoint],
    { env, windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 });
  assert.equal(stderr, '', stderr);
  return JSON.parse(stdout);
}

test('TLS fixture is signed by a separate test CA with IP and localhost SANs', () => {
  const root = new X509Certificate(ca), leaf = new X509Certificate(cert);
  assert.equal(root.ca, true);
  assert.equal(root.verify(root.publicKey), true);
  assert.equal(leaf.ca, false);
  assert.notEqual(leaf.fingerprint256, root.fingerprint256);
  assert.notEqual(leaf.subject, leaf.issuer);
  assert.equal(leaf.checkIssued(root), true);
  assert.equal(leaf.verify(root.publicKey), true);
  assert.equal(leaf.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(leaf.checkHost('localhost', { subject: 'never' }), 'localhost');
});

// transport.test.mjs already covers diagnose, redirects, timeouts and size caps.
// This pair checks request's wire-level contract for both transports directly.
test('request preserves loopback HTTP port, route prefix, headers and UTF-8 body', { timeout: 15000 }, async t => {
  const server = await router(t, 'http');
  const response = await request(server.endpoint, token, body, 5000, headers);
  assertRoundTrip(server, response, false);
});

test('request accepts loopback HTTPS with NODE_EXTRA_CA_CERTS in a fresh child', { timeout: 15000 }, async t => {
  const server = await router(t, 'https');
  const result = await childRequest(server.endpoint, true);
  assert.equal(result.ok, true, JSON.stringify(result));
  assertRoundTrip(server, result.response, true);
});

test('request rejects loopback HTTPS with default trust before sending HTTP data', { timeout: 15000 }, async t => {
  const server = await router(t, 'https');
  const result = await childRequest(server.endpoint);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.code, /^(UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)$/);
  assert.equal(server.seen.length, 0);
});
