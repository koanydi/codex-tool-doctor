import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'smol-toml';
import { loadConfig, loadCredential, requestAuth, responseEndpoint, displayEndpoint, readJson } from '../src/config.mjs';
import { runGuard } from '../src/guard.mjs';

test('loopback, IPv6, LAN and route prefixes preserve exact destination', () => {
  for (const base of ['http://127.0.0.1:8080', 'http://localhost:3000', 'http://[::1]:8080', 'http://192.168.1.5:9000', 'http://172.16.0.2:3000', 'http://10.1.0.8', 'http://router.local', 'http://router']) assert.equal(responseEndpoint(base), base + '/responses');
  assert.equal(responseEndpoint('http://127.0.0.1:3000/router/api/v1///'), 'http://127.0.0.1:3000/router/api/v1/responses');
  assert.equal(responseEndpoint('http://127.0.0.1:3000/v1/responses/'), 'http://127.0.0.1:3000/v1/responses');
  assert.equal(responseEndpoint('https://example.test/v1'), 'https://example.test/v1/responses');
});
test('public plaintext requires an explicit choice and unsupported URLs fail locally', () => {
  for (const base of ['http://example.test', 'http://172.32.0.1', 'http://localhost.evil.test', 'ftp://127.0.0.1', 'https://user:pass@host.test', 'http://127.0.0.1#secret', '127.0.0.1:8000']) assert.throws(() => responseEndpoint(base));
  assert.equal(responseEndpoint('http://example.test/v1', { allowInsecureHttp: true }), 'http://example.test/v1/responses');
});
test('query params are encoded and redacted for reports', () => {
  const url = responseEndpoint('http://127.0.0.1/v1', { queryParams: { token: 'special&secret', 'api-version': 'v1' } });
  assert.equal(new URL(url).searchParams.get('token'), 'special&secret');
  assert.ok(!displayEndpoint(url).includes('special'));
});
test('unauthenticated provider never borrows another account key; custom headers are respected', async () => {
  const context = { home: '/nonexistent', providerId: 'local', provider: { requires_openai_auth: false, http_headers: { 'X-Route': 'local' }, env_http_headers: { 'X-Api-Key': 'ROUTER_KEY' } } };
  assert.equal(await loadCredential(context, { OPENAI_API_KEY: 'unrelated-key' }), '');
  const auth = await requestAuth(context, { ROUTER_KEY: 'route-secret' });
  assert.equal(auth.headers.authorization, undefined);
  assert.equal(auth.headers['x-api-key'], 'route-secret');
  assert.ok(auth.secrets.includes('route-secret'));
  await assert.rejects(requestAuth(context, {}), /ROUTER_KEY/);
  await assert.rejects(requestAuth({ ...context, provider: { requires_openai_auth: false, http_headers: { host: 'evil.test' } } }), /传输请求头/);
});
test('profile files resolve model/provider with a separate state directory', async t => {
  const home = await mkdtemp(join(tmpdir(), 'doctor-profile-')); t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'config.toml'), 'model="base"\nmodel_provider="local"\n[model_providers.local]\nbase_url="http://127.0.0.1:8080/v1"\nrequires_openai_auth=false\n');
  await writeFile(join(home, 'work.config.toml'), 'model="work"\n');
  const context = await loadConfig(home, { profile: 'work' });
  assert.equal(context.config.model, 'work'); assert.ok(context.directory.endsWith(join('profiles', 'work')));
  assert.equal(context.endpoint, 'http://127.0.0.1:8080/v1/responses');
  assert.equal(context.configPath, join(home, 'work.config.toml'));
  await assert.rejects(loadConfig(home, { profile: '../other' }));
});
test('built-in OpenAI supports openai_base_url without a custom provider table', async t => {
  const home = await mkdtemp(join(tmpdir(), 'doctor-openai-')); t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'config.toml'), 'model="m"\nopenai_base_url="http://127.0.0.1:8080/v1"\n');
  assert.equal((await loadConfig(home)).endpoint, 'http://127.0.0.1:8080/v1/responses');
});

test('selected built-in OpenAI table overrides are rejected before constructing a diagnostic route', async t => {
  const home = await mkdtemp(join(tmpdir(), 'doctor-openai-override-')); t.after(() => rm(home, { recursive: true, force: true }));
  const secret = 'FIXTURE_ROUTE_SECRET';
  const fields = [
    { base_url: `http://127.0.0.1:9999/${secret}` },
    { env_key: secret },
    { http_headers: { 'X-Route': secret } },
    { env_http_headers: { 'X-Api-Key': secret } },
    { query_params: { token: secret } },
    { experimental_bearer_token: secret },
    { requires_openai_auth: false },
    { name: secret },
  ];
  for (const explicit of [false, true]) for (const provider of fields) {
    const raw = stringify({ model: 'm', ...(explicit ? { model_provider: 'openai' } : {}), openai_base_url: 'http://127.0.0.1:8080/v1', model_providers: { openai: provider } });
    await writeFile(join(home, 'config.toml'), raw);
    await assert.rejects(loadConfig(home), error => {
      assert.match(error.message, /无法确认model_providers\.openai.*自定义model_provider.*openai_base_url/);
      assert.equal(error.message.includes(secret), false);
      return true;
    });
    assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), raw);
  }
  await assert.rejects(readFile(join(home, 'tool-doctor', 'last-report.json')), { code: 'ENOENT' });
});

test('OpenAI protection follows the merged profile selection and permits explicit custom-provider migration', async t => {
  const home = await mkdtemp(join(tmpdir(), 'doctor-openai-profile-')); t.after(() => rm(home, { recursive: true, force: true }));
  const provider = { name: 'route', base_url: 'http://127.0.0.1:8080/router/v1', wire_api: 'responses', requires_openai_auth: false, env_key: 'ROUTER_KEY', http_headers: { 'X-Route': 'selected' }, env_http_headers: { 'X-Api-Key': 'ROUTER_HEADER' }, query_params: { token: 'special&token' } };
  const base = stringify({ model: 'm', model_provider: 'router', model_providers: { router: provider, openai: provider } });
  await writeFile(join(home, 'config.toml'), base);
  const context = await loadConfig(home);
  assert.equal(context.providerId, 'router');
  assert.deepEqual(context.provider, provider);
  assert.equal(context.endpoint, 'http://127.0.0.1:8080/router/v1/responses?token=special%26token');
  assert.deepEqual((await requestAuth(context, { ROUTER_KEY: 'provider-key', ROUTER_HEADER: 'header-value' })).headers, { authorization: 'Bearer provider-key', 'x-route': 'selected', 'x-api-key': 'header-value' });
  await writeFile(join(home, 'work.config.toml'), 'model_provider="openai"\n');
  await assert.rejects(loadConfig(home, { profile: 'work' }), /model_providers\.openai.*自定义model_provider/);
  await writeFile(join(home, 'config.toml'), 'model="m"\nopenai_base_url="http://127.0.0.1:8080/v1"\n');
  await writeFile(join(home, 'work.config.toml'), '[model_providers.openai.query_params]\nroute="different"\n');
  await assert.rejects(loadConfig(home, { profile: 'work' }), /model_providers\.openai.*自定义model_provider/);
});

test('bare and empty-table built-in OpenAI keep their defaults and top-level URL override', async t => {
  const home = await mkdtemp(join(tmpdir(), 'doctor-openai-defaults-')); t.after(() => rm(home, { recursive: true, force: true }));
  for (const selected of ['', 'model_provider="openai"\n']) for (const table of ['', '[model_providers.openai]\n']) {
    await writeFile(join(home, 'config.toml'), `model="m"\n${selected}openai_base_url="http://127.0.0.1:8080/v1"\n${table}`);
    const context = await loadConfig(home);
    assert.equal(context.providerId, 'openai');
    assert.equal(context.endpoint, 'http://127.0.0.1:8080/v1/responses');
    assert.deepEqual(context.provider, { wire_api: 'responses', requires_openai_auth: true, base_url: 'http://127.0.0.1:8080/v1' });
  }
  await writeFile(join(home, 'config.toml'), 'model="m"\n');
  assert.equal((await loadConfig(home)).endpoint, 'https://api.openai.com/v1/responses');
});

test('custom provider without requires_openai_auth never borrows stored account credentials', async t => {
  const home = await mkdtemp(join(tmpdir(), 'doctor-auth-isolation-')); t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'unrelated-account-secret' }));
  const context = { home, providerId: 'third-party', provider: { http_headers: { 'X-Api-Key': 'router-secret' } } };
  const auth = await requestAuth(context, { OPENAI_API_KEY: 'unrelated-environment-secret' });
  assert.equal(auth.key, ''); assert.equal(auth.headers.authorization, undefined);
  assert.equal(auth.headers['x-api-key'], 'router-secret');
  assert.equal(await loadCredential({ ...context, provider: { requires_openai_auth: true } }), 'unrelated-account-secret');
});

test('malformed configuration never exposes source credentials in errors or guard records', async t => {
  const home = await mkdtemp(join(tmpdir(), 'doctor-parse-secret-')); t.after(() => rm(home, { recursive: true, force: true }));
  const secret = 'FIXTURE_PRIVATE_TOKEN_12345';
  await writeFile(join(home, 'config.toml'), `experimental_bearer_token="${secret}" OOPS\n`);
  await assert.rejects(loadConfig(home), error => /TOML配置格式无效.*第1行/.test(error.message) && !error.message.includes(secret));
  await runGuard({ home, once: true });
  const report = await readFile(join(home, 'tool-doctor', 'last-guard.json'), 'utf8');
  assert.ok(!report.includes(secret)); assert.match(report, /TOML配置格式无效/);
  await writeFile(join(home, 'auth.json'), `{"token":"${secret}" INVALID}`);
  await assert.rejects(readJson(join(home, 'auth.json')), error => !error.message.includes(secret) && /JSON文件格式无效/.test(error.message));
});
