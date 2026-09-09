import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { loadConfig, requestAuth } from '../src/config.mjs';
import { checkExecution, verify } from '../src/verify.mjs';
import { createMockRouter } from '../scripts/mock-router.mjs';

const marker = 'VERIFIED_123abc';
const completed = item => ({ type: 'item.completed', item });
const command = (cwd, platform = 'win32', extra = {}) => completed({ type: 'command_execution', command: platform === 'win32' ? 'Get-Location' : 'pwd', status: 'completed', exit_code: 0, aggregated_output: cwd + '\n', ...extra });
const message = text => completed({ type: 'agent_message', text });
const end = { type: 'turn.completed' };

test('verification requires a post-completion message with both marker and actual directory', () => {
  for (const [platform, cwd] of [['win32', 'C:\\random workspace\\check-a1'], ['linux', '/tmp/random workspace/check-a1']]) {
    const tool = command(cwd, platform), ack = message(`${cwd}\n${marker}`);
    assert.equal(checkExecution([tool, ack, end], cwd, platform, marker).passed, true);
    const rejected = {
      'prose only': [ack, end],
      'marker and directory before command': [ack, tool, end],
      'early marker followed by unrelated prose': [ack, tool, message('Done'), end],
      'post-completion marker only': [tool, message(marker), end],
      'post-completion directory only': [tool, message(cwd), end],
      'marker and directory in separate messages': [tool, message(marker), message(cwd), end],
      'wrong directory': [tool, message(`/other/place ${marker}`), end],
      'directory prefix is not the directory': [tool, message(`${cwd}-other ${marker}`), end],
      'nested path is not the directory': [tool, message(`${cwd}/child ${marker}`), end],
      'wrong marker': [tool, message(`${cwd} VERIFIED_other`), end],
      'acknowledgement after turn completed': [tool, end, ack],
      'command after turn completed': [end, tool, ack],
      'no turn completion': [tool, ack],
      'started command is not completion': [{ ...tool, type: 'item.started' }, ack, end],
      'failed command': [command(cwd, platform, { exit_code: 1 }), ack, end],
      'failed status with zero exit': [command(cwd, platform, { status: 'failed' }), ack, end],
      'wrong actual output despite correct prose': [command(cwd, platform, { aggregated_output: '/wrong\n' }), ack, end],
      'two commands': [tool, tool, ack, end],
      'extra shell operation': [command(cwd, platform, { command: platform === 'win32' ? 'Get-Location; Get-Date' : 'pwd; id' }), ack, end],
      'turn failure': [tool, ack, { type: 'turn.failed' }, end],
      'error event': [tool, ack, { type: 'error' }, end],
      'unrelated tool': [tool, completed({ type: 'mcp_tool_call' }), ack, end],
    };
    for (const [reason, events] of Object.entries(rejected)) assert.equal(checkExecution(events, cwd, platform, marker).passed, false, `${platform}: ${reason}`);
  }
});

test('directory acknowledgement accepts literal Windows paths but rejects JSON escapes', () => {
  const cwd = 'C:\\random workspace\\check-a1', tool = command(cwd);
  for (const path of [cwd, 'c:/RANDOM WORKSPACE/check-a1']) assert.equal(checkExecution([tool, message(`Directory: \`${path}\`\n${marker}`), end], cwd, 'win32', marker).passed, true);
  assert.equal(checkExecution([tool, message(`${JSON.stringify({ output: cwd })} ${marker}`), end], cwd, 'win32', marker).passed, false);
  assert.equal(checkExecution([command('/tmp/Check', 'linux'), message(`/tmp/check ${marker}`), end], '/tmp/Check', 'linux', marker).passed, false);
});

async function fixture(t, config, { auth, profile } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'doctor-verification-context-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const raw = stringify({ model: 'fixture-model', ...config });
  await writeFile(join(home, 'config.toml'), raw);
  if (auth !== undefined) await writeFile(join(home, 'auth.json'), typeof auth === 'string' ? auth : JSON.stringify(auth));
  if (profile) await writeFile(join(home, `${profile}.config.toml`), stringify(profile.config));
  const context = await loadConfig(home, profile ? { profile: profile.name } : {});
  const binary = { path: join(home, 'fixture-codex'), sha256: 'fixture-hash' };
  return { context, home, raw, binary };
}

function succeed(args, opts, text) {
  const actualMarker = args.at(-1).match(/VERIFIED_[a-f0-9]+/)[0];
  opts.onEvent(command(opts.cwd, process.platform));
  opts.onEvent(message(text ?? `${opts.cwd}\n${actualMarker}`));
  opts.onEvent(end);
  return { code: 0, stderr: '', timedOut: false, overflow: false };
}

test('isolated verification preserves the selected provider identity, auth headers and query parameters', async t => {
  process.env.TOOL_DOCTOR_VERIFY_KEY = 'fixture-provider-key';
  process.env.TOOL_DOCTOR_VERIFY_HEADER = 'fixture-header-secret';
  t.after(() => { delete process.env.TOOL_DOCTOR_VERIFY_KEY; delete process.env.TOOL_DOCTOR_VERIFY_HEADER; });
  const provider = {
    base_url: 'http://127.0.0.1:1234/selected/v1', env_key: 'TOOL_DOCTOR_VERIFY_KEY', wire_api: 'responses', requires_openai_auth: true,
    http_headers: { 'X-Route': 'selected-route' }, env_http_headers: { 'X-Api-Key': 'TOOL_DOCTOR_VERIFY_HEADER' },
    query_params: { token: 'special&token', 'api-version': 'v1' }, request_max_retries: 3,
    stream_max_retries: 2, stream_idle_timeout_ms: 12345, supports_websockets: false,
  };
  const f = await fixture(t, {
    model_provider: 'selected',
    model_providers: { selected: provider, ignored: { base_url: 'http://127.0.0.1:9999' } },
    mcp_servers: { unused: { command: 'never-run' } },
  }, { auth: '{ malformed unrelated auth must not be read' });
  const before = structuredClone(f.context), expectedAuth = await requestAuth(f.context);
  let isolated;
  const report = await verify(f.context, [f.binary], { rounds: 1, run: async (_, args, opts) => {
    isolated = opts.env.CODEX_HOME;
    const config = parse(await readFile(join(isolated, 'config.toml'), 'utf8'));
    assert.equal(config.model_provider, f.context.providerId, 'verification must never rename the selected provider');
    assert.deepEqual(config.model_providers[config.model_provider], { ...f.context.provider, name: 'selected' });
    assert.equal(config.model_providers[config.model_provider].requires_openai_auth, true);
    assert.equal(config.model_providers[config.model_provider].base_url, provider.base_url);
    assert.equal(config.mcp_servers, undefined);
    assert.equal(config.model_providers.ignored, undefined);
    assert.equal(config.sandbox_mode, 'read-only');
    assert.equal(config.approval_policy, 'never');
    assert.equal(config.cli_auth_credentials_store, 'file');
    assert.equal(args[args.indexOf('-s') + 1], 'read-only');
    assert.equal(args[args.indexOf('-C') + 1], opts.cwd);
    assert.equal(args.at(-1).includes(opts.cwd), false);
    assert.equal(args.at(-1).includes(basename(isolated)), false, 'random workspace must not be disclosed in the prompt');
    const replay = await loadConfig(isolated);
    assert.equal(replay.endpoint, f.context.endpoint);
    assert.deepEqual((await requestAuth(replay, opts.env)).headers, expectedAuth.headers);
    assert.equal((await readdir(isolated)).includes('auth.json'), false);
    return succeed(args, opts);
  } });
  assert.equal(report.passed, true);
  assert.deepEqual(f.context, before);
  assert.equal(await readFile(join(f.home, 'config.toml'), 'utf8'), f.raw);
  await assert.rejects(readFile(join(isolated, 'config.toml')), { code: 'ENOENT' });
});

test('OpenAI table overrides fail closed before credentials, execution or receipt creation', async t => {
  const overrides = [
    { env_key: 'MISSING_PROVIDER_KEY' },
    { http_headers: { 'X-Route': 'route-only-for-alias' } },
    { env_http_headers: { 'X-Api-Key': 'MISSING_PROVIDER_HEADER' } },
    { query_params: { route: 'other-route' } },
    { experimental_bearer_token: 'provider-only-token' },
    { requires_openai_auth: false },
    { base_url: 'http://127.0.0.1:9999/other-route' },
  ];
  for (const fields of overrides) {
    // Construct a formerly accepted context directly, so verify also guards stale callers.
    const f = await fixture(t, { openai_base_url: 'http://127.0.0.1:1234/v1' }, { auth: '{ malformed unrelated auth' });
    f.context.config.model_providers = { openai: fields };
    Object.assign(f.context.provider, fields);
    let called = false;
    await assert.rejects(verify(f.context, [f.binary], { rounds: 1, run: async () => { called = true; throw new Error('must not execute'); } }), /model_providers\.openai.*自定义model_provider.*openai_base_url/);
    assert.equal(called, false);
    await assert.rejects(readFile(join(f.context.directory, 'last-verification.json')), { code: 'ENOENT' });
    assert.equal(await readFile(join(f.home, 'config.toml'), 'utf8'), f.raw);
  }
});

test('bare built-in OpenAI retains its identity and copies only the selected account API key', async t => {
  const f = await fixture(t, { openai_base_url: 'http://127.0.0.1:1234/v1' }, { auth: { OPENAI_API_KEY: 'selected-account-key', tokens: { access_token: 'must-not-copy' } } });
  const report = await verify(f.context, [f.binary], { rounds: 1, run: async (_, args, opts) => {
    const config = parse(await readFile(join(opts.env.CODEX_HOME, 'config.toml'), 'utf8'));
    assert.equal(config.model_provider, 'openai');
    assert.equal(config.openai_base_url, f.context.provider.base_url);
    const replay = await loadConfig(opts.env.CODEX_HOME);
    assert.equal(replay.provider.requires_openai_auth, true);
    assert.equal(replay.endpoint, f.context.endpoint);
    assert.deepEqual(JSON.parse(await readFile(join(opts.env.CODEX_HOME, 'auth.json'), 'utf8')), { OPENAI_API_KEY: 'selected-account-key' });
    return succeed(args, opts);
  } });
  assert.equal(report.passed, true);
});

test('account credentials are copied only with opt-in and without provider-specific credentials', async t => {
  process.env.TOOL_DOCTOR_VERIFY_AUTH = 'selected-environment-key';
  t.after(() => { delete process.env.TOOL_DOCTOR_VERIFY_AUTH; });
  const cases = [
    ['custom omitted', 'router', {}, false],
    ['custom false', 'router', { requires_openai_auth: false }, false],
    ['custom true', 'router', { requires_openai_auth: true }, true],
    ['custom env key', 'router', { requires_openai_auth: true, env_key: 'TOOL_DOCTOR_VERIFY_AUTH' }, false],
    ['custom token', 'router', { requires_openai_auth: true, experimental_bearer_token: 'selected-token' }, false],
  ];
  for (const [name, providerId, fields, copies] of cases) await t.test(name, async t => {
    const f = await fixture(t, { model_provider: providerId, model_providers: { [providerId]: { base_url: 'http://127.0.0.1:1234/v1', ...fields } } }, { auth: copies ? { OPENAI_API_KEY: 'chosen-key', tokens: { access_token: 'unrelated-session' } } : '{ unreadable unrelated account data' });
    const report = await verify(f.context, [f.binary], { rounds: 1, run: async (_, args, opts) => {
      const path = join(opts.env.CODEX_HOME, 'auth.json');
      if (copies) assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { OPENAI_API_KEY: 'chosen-key' });
      else await assert.rejects(readFile(path), { code: 'ENOENT' });
      const config = parse(await readFile(join(opts.env.CODEX_HOME, 'config.toml'), 'utf8'));
      assert.deepEqual(config.model_providers[config.model_provider], { ...f.context.provider, name: providerId === 'openai' ? 'OpenAI' : providerId });
      return succeed(args, opts);
    } });
    assert.equal(report.passed, true);
  });
});

test('verifier rejects early acknowledgements and stops instead of issuing a successful receipt', async t => {
  const f = await fixture(t, { model_provider: 'router', model_providers: { router: { base_url: 'http://127.0.0.1:1234/v1', requires_openai_auth: false } } });
  let calls = 0;
  const report = await verify(f.context, [f.binary], { rounds: 2, run: async (_, args, opts) => {
    calls++;
    const actualMarker = args.at(-1).match(/VERIFIED_[a-f0-9]+/)[0];
    opts.onEvent(message(`${opts.cwd}\n${actualMarker}`));
    opts.onEvent(command(opts.cwd, process.platform));
    opts.onEvent(end);
    return { code: 0, stderr: '', timedOut: false, overflow: false };
  } });
  assert.equal(calls, 1);
  assert.equal(report.passed, false);
  assert.equal(report.results[0].failureKind, 'tool-result-not-acknowledged');
  assert.equal(JSON.parse(await readFile(join(f.context.directory, 'last-verification.json'), 'utf8')).passed, false);
});

test('a marker replayed from an earlier round cannot confirm the current command', async t => {
  const f = await fixture(t, { model_provider: 'router', model_providers: { router: { base_url: 'http://127.0.0.1:1234/v1', requires_openai_auth: false } } });
  let previousMarker;
  const report = await verify(f.context, [f.binary], { rounds: 2, run: async (_, args, opts) => {
    const currentMarker = args.at(-1).match(/VERIFIED_[a-f0-9]+/)[0];
    const result = succeed(args, opts, `${opts.cwd}\n${previousMarker || currentMarker}`);
    previousMarker = currentMarker;
    return result;
  } });
  assert.deepEqual(report.results.map(result => result.passed), [true, false]);
  assert.equal(report.passed, false);
});

test('mock router decodes nested terminal output into literal directory acknowledgement', async t => {
  const router = await createMockRouter();
  t.after(() => router.close());
  for (const [platform, cwd] of [['win32', 'C:\\random workspace\\check-a1'], ['linux', '/tmp/random workspace/check-a1']]) {
    const output = platform === 'win32' ? `Path\n----\n${cwd}\n` : cwd + '\n';
    const shapes = [output, JSON.stringify({ output, exit_code: 0 }), [{ type: 'text', text: JSON.stringify({ output }) }]];
    for (const shape of shapes) {
      const response = await fetch(`${router.url}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: [{ role: 'user', content: marker }, { type: 'custom_tool_call_output', call_id: 'fixture', output: shape }] }) });
      assert.equal(response.status, 200);
      const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      const text = events.find(event => event.type === 'response.completed').response.output[0].content[0].text;
      assert.equal(text.includes(cwd), true);
      assert.equal(checkExecution([command(cwd, platform), message(text), end], cwd, platform, marker).passed, true);
    }
  }
});
