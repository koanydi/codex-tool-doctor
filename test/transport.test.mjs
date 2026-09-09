import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { diagnose, request, parseResponse, classify, summarize } from '../src/probe.mjs';

async function router(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const controls = ['function-flat', 'custom-flat'].flatMap(kind => [1, 2].map(round => ({ kind, round, result: 'pass' })));
test('real loopback HTTP reproduces namespace rejection without any external API', async t => {
  const seen = [];
  const url = await router(t, async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); seen.push({ path: req.url, authorization: req.headers.authorization, routeKey: req.headers['x-api-key'] });
    if (body.input[0].type === 'additional_tools') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {broken json\n\n'); return; }
    if (body.tools[0].type === 'namespace') { res.writeHead(422); res.end('unsupported namespace route-secret'); return; }
    const tool = body.tools[0], marker = JSON.stringify(body.input).match(/CHECK_[a-z0-9]+/)[0];
    const item = tool.type === 'function' ? { type: 'function_call', name: tool.name, arguments: JSON.stringify({ marker }) } : { type: 'custom_tool_call', name: tool.name, input: marker };
    // A real gateway may return JSON despite stream=true.
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'completed', output: [item] }));
  });
  const home = await mkdtemp(join(tmpdir(), 'doctor-http-')); t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'config.toml'), `model="m"\nmodel_provider="local"\n[model_providers.local]\nbase_url="${url}/router/v1"\nrequires_openai_auth=false\nhttp_headers={X-Api-Key="route-secret"}\n`);
  const report = await diagnose(await loadConfig(home));
  assert.equal(report.samples.length, 8); assert.equal(report.summary.patchRecommended, true);
  assert.ok(report.samples.filter(s => s.kind === 'custom-additional').every(s => s.result === 'parse-error'));
  assert.ok(seen.every(s => s.path === '/router/v1/responses' && !s.authorization && s.routeKey === 'route-secret'));
  assert.ok(!(await readFile(join(home, 'tool-doctor', 'last-report.json'), 'utf8')).includes('route-secret'));
});
test('redirects never forward credentials to a second destination', async t => {
  let redirectedRequests = 0;
  const destination = await router(t, (_, res) => { redirectedRequests++; res.end('bad'); });
  const source = await router(t, (_, res) => { res.writeHead(307, { location: destination }); res.end(); });
  assert.equal((await request(source, 'private-token', {}, 1000)).status, 307);
  assert.equal(redirectedRequests, 0);
});
test('request timeout, reset and body size caps reject predictably', async t => {
  const hanging = await router(t, () => {});
  await assert.rejects(request(hanging, '', {}, 40), /超时/);
  const reset = await router(t, req => req.socket.destroy());
  await assert.rejects(request(reset, '', {}, 1000));
  const giant = await router(t, (_, res) => res.end('x'.repeat(2_000_001)));
  await assert.rejects(request(giant, '', {}, 1000), /大小限制/);
});
test('differential HTTP, malformed JSON and stream failures produce candidates with reasons', () => {
  for (const sample of [{ result: 'http-error', status: 400 }, { result: 'http-error', status: 422 }, { result: 'parse-error' }, { result: 'stream-error' }]) {
    const summary = summarize([...controls, { kind: 'custom-namespace', round: 1, ...sample }]);
    assert.equal(summary.patchRecommended, true); assert.equal(summary.decision, 'candidate-verification-required');
  }
  for (const sample of [{ result: 'http-error', status: 401 }, { result: 'http-error', status: 429 }, { result: 'http-error', status: 503 }, { result: 'network-error' }]) {
    const summary = summarize([...controls, { kind: 'custom-namespace', round: 1, ...sample }]);
    assert.equal(summary.patchRecommended, false); assert.equal(summary.blockers[0].code, 'no-format-evidence');
  }
  const failed = summarize([...controls, { kind: 'function-flat', round: 3, result: 'network-error' }, { kind: 'custom-namespace', round: 1, result: 'parse-error' }]);
  assert.equal(failed.patchRecommended, false); assert.ok(failed.blockers.some(b => b.code === 'flat-control-failed'));
});
test('BOM, SSE event-name fallback and multiple tool calls are handled', () => {
  const item = { id: '1', type: 'custom_tool_call', name: 'diagnostic_echo', input: 'X' };
  const raw = '\uFEFF: keepalive\r\n\r\nevent: response.completed\r\ndata: ' + JSON.stringify({ response: { output: [item] } }) + '\r\n\r\n';
  assert.equal(classify(parseResponse(raw), 'custom-flat', 'X'), 'pass');
  assert.equal(classify({ complete: true, output: [item, { ...item, id: '2' }] }, 'custom-flat', 'X'), 'unexpected-output');
  assert.throws(() => parseResponse('<html>router login</html>'), /HTML/);
});
