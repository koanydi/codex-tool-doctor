import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, appendFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { execute } from '../src/engine.mjs';
import { createPlan, applyPlan, status, rollback, recover } from '../src/patch.mjs';
import { loadConfig, hash, saveJson, readJson, readOptionalJson, stateDir } from '../src/config.mjs';
import { summarize } from '../src/probe.mjs';
import { verify } from '../src/verify.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'doctor-lifecycle-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const raw = 'model="m"\nmodel_provider="local"\n[model_providers.local]\nbase_url="http://127.0.0.1:8765/v1"\nrequires_openai_auth=false\n';
  await writeFile(join(home, 'config.toml'), raw);
  const mutable = { version: 1, fail: false, diagnoses: 0, runs: 0, native: false };
  const binary = () => ({ path: join(home, 'fixture-codex'), sha256: `hash-${mutable.version}`, version: `fixture ${mutable.version}`, source: 'desktop' });
  const catalog = async (_, __, path) => path ? readJson(path) : { models: [{ slug: 'm', use_responses_lite: !mutable.native, context_window: mutable.version * 1000 }, { slug: 'other', use_responses_lite: true }] };
  const report = context => {
    const samples = ['function-flat', 'custom-flat', 'custom-namespace', 'custom-additional'].flatMap(kind => [1, 2].map(round => ({ kind, round, result: kind.includes('flat') ? 'pass' : 'parse-error' })));
    return { schema: 2, createdAt: new Date().toISOString(), configHash: context.configHash, contextHash: context.contextHash, endpointHash: hash(context.endpoint), model: context.config.model, samples, summary: summarize(samples) };
  };
  const deps = {
    discover: async () => [binary()], catalog,
    diagnose: async context => { mutable.diagnoses++; const result = report(context); await saveJson(join(context.directory, 'last-report.json'), result); return result; },
    verify: (context, binaries, options) => verify(context, binaries, { ...options, run: async (_, args, opts) => {
      mutable.runs++;
      // Exercise the real verifier and receipt generation with controlled backend events.
      assert.notEqual(opts.env.CODEX_HOME, home);
      const isolatedConfig = parse(await readFile(join(opts.env.CODEX_HOME, 'config.toml'), 'utf8'));
      assert.equal(isolatedConfig.sandbox_mode, 'read-only');
      assert.equal(isolatedConfig.mcp_servers, undefined);
      const marker = args.at(-1).match(/VERIFIED_[a-f0-9]+/)[0];
      if (!mutable.fail) {
        opts.onEvent({ type: 'item.completed', item: { type: 'command_execution', command: process.platform === 'win32' ? 'Get-Location' : 'pwd', exit_code: 0, aggregated_output: opts.cwd + '\n' } });
        opts.onEvent({ type: 'item.completed', item: { type: 'agent_message', text: `${opts.cwd}\n${marker}` } });
        opts.onEvent({ type: 'turn.completed' });
      }
      return { code: mutable.fail ? 1 : 0, stdout: '', stderr: mutable.fail ? 'fixture failure' : '', timedOut: false };
    } }),
  };
  const run = (command, options = {}) => execute(command, { home, ...options }, () => {}, deps);
  return { home, raw, mutable, deps, run, report, binary };
}

test('unknown build: full plan/verify/apply/rollback preserves user edits', async t => {
  const f = await fixture(t), result = await f.run('repair');
  assert.equal(result.status, 'verified'); assert.equal(f.mutable.runs, 2);
  assert.equal((await status(f.home)).catalogIntact, true);
  assert.equal(JSON.parse(await readFile(result.catalogPath, 'utf8')).models[0].use_responses_lite, false);
  await appendFile(join(f.home, 'config.toml'), '\n# later user setting\n');
  await f.run('rollback');
  assert.equal(await readFile(join(f.home, 'config.toml'), 'utf8'), f.raw + '\n# later user setting\n');
});
test('failed candidate never changes the original configuration', async t => {
  const f = await fixture(t); f.mutable.fail = true;
  await assert.rejects(f.run('repair'), /候选终端验证未通过/);
  assert.equal(await readFile(join(f.home, 'config.toml'), 'utf8'), f.raw);
  assert.equal((await status(f.home)).patched, false);
});
test('apply requires a fresh successful receipt for this exact candidate', async t => {
  const f = await fixture(t), context = await loadConfig(f.home);
  const plan = await createPlan(context, f.report(context), [f.binary()], { load: f.deps.catalog });
  await assert.rejects(applyPlan(f.home, plan, { discover: f.deps.discover }));
  await f.deps.verify(context, plan.binaries, { catalogPath: plan.catalogPath });
  const receiptPath = join(context.directory, 'last-verification.json');
  const receipt = await readJson(receiptPath); receipt.catalogHash = 'tampered'; await saveJson(receiptPath, receipt);
  await assert.rejects(applyPlan(f.home, plan, { discover: f.deps.discover }), /验证/);
  assert.equal(await readFile(join(f.home, 'config.toml'), 'utf8'), f.raw);
});

test('apply rejects a newly selected binary or changed build before running verification', async t => {
  for (const change of ['path', 'sha256']) await t.test(change, async t => {
    const f = await fixture(t), context = await loadConfig(f.home), plannedBinary = f.binary();
    const plan = await createPlan(context, f.report(context), [plannedBinary], { load: f.deps.catalog });
    const selected = { ...plannedBinary, [change]: change === 'path' ? join(f.home, 'other-codex') : 'new-build' };
    const calls = [];
    f.deps.discover = async path => {
      calls.push(path);
      return [path === selected.path ? selected : plannedBinary];
    };
    await assert.rejects(f.run('apply', { binary: selected.path }), /当前选择.*不匹配.*重新生成计划/);
    assert.deepEqual(calls, [selected.path]);
    assert.equal(f.mutable.runs, 0);
    assert.equal(await readFile(join(f.home, 'config.toml'), 'utf8'), f.raw);
    assert.equal(await readOptionalJson(join(context.directory, 'active.json')), null);
    assert.equal(await readOptionalJson(join(context.directory, 'last-verification.json')), null);
    assert.equal((await readJson(join(context.directory, 'last-plan.json'))).id, plan.id);
  });
});
test('stale, future, mismatched and fabricated summary-only reports are rejected', async t => {
  const f = await fixture(t), context = await loadConfig(f.home), report = f.report(context);
  for (const changed of [{ createdAt: '2020-01-01T00:00:00Z' }, { createdAt: new Date(Date.now() + 86400000).toISOString() }, { contextHash: 'changed' }, { samples: [], summary: { patchRecommended: true } }]) await assert.rejects(createPlan(context, { ...report, ...changed }, [f.binary()], { load: f.deps.catalog }));
});
test('catalog tampering and configuration races prevent installation', async t => {
  const f = await fixture(t), context = await loadConfig(f.home);
  const plan = await createPlan(context, f.report(context), [f.binary()], { load: f.deps.catalog });
  await f.deps.verify(context, plan.binaries, { catalogPath: plan.catalogPath });
  await appendFile(plan.catalogPath, ' ');
  await assert.rejects(applyPlan(f.home, plan, { discover: f.deps.discover }), /已被修改/);
  await appendFile(join(f.home, 'config.toml'), '\n# concurrently saved\n');
  await assert.rejects(applyPlan(f.home, plan, { discover: f.deps.discover }), /配置/);
});
test('upgrade rebuilds fresh metadata; unchanged maintenance sends no API requests', async t => {
  const f = await fixture(t), first = await f.run('repair');
  const before = f.mutable.diagnoses;
  assert.equal((await f.run('maintain')).changed, false); assert.equal(f.mutable.diagnoses, before);
  f.mutable.version = 2;
  const refreshed = await f.run('maintain'); assert.equal(refreshed.state, 'refreshed'); assert.notEqual(refreshed.id, first.id);
  const active = await readJson(join(f.home, 'tool-doctor', 'active.json'));
  const catalog = await readJson(active.catalogPath);
  assert.equal(catalog.models[0].context_window, 2000); assert.equal(catalog.models[0].use_responses_lite, false);
  assert.equal(catalog.models[1].use_responses_lite, true);
  await f.run('rollback'); assert.equal(await readFile(join(f.home, 'config.toml'), 'utf8'), f.raw);
});

test('maintenance discovers a saved explicit target even when automatic discovery fails', async t => {
  const f = await fixture(t), explicitPath = f.binary().path, calls = [];
  f.deps.discover = async path => {
    calls.push(path);
    if (path !== explicitPath) throw new Error('automatic discovery has no candidates');
    return [{ ...f.binary(), source: 'explicit' }];
  };
  const first = await f.run('repair', { binary: explicitPath });
  calls.length = 0;
  assert.equal((await f.run('maintain')).state, 'healthy');
  f.mutable.version = 2;
  assert.equal((await f.run('maintain')).state, 'refreshed');
  assert.equal((await f.run('inspect')).target, explicitPath);
  assert.ok(calls.length > 0 && calls.every(path => path === explicitPath));
  const active = await readJson(join(stateDir(f.home), 'active.json'));
  assert.notEqual(active.id, first.id);
  assert.equal(active.binaries[0].source, 'explicit');
  assert.equal(active.binaries[0].sha256, 'hash-2');
});

test('a new explicit selection takes precedence over the saved target', async t => {
  const f = await fixture(t), oldPath = f.binary().path;
  f.deps.discover = async path => [{ ...f.binary(), path, source: 'explicit' }];
  await f.run('repair', { binary: oldPath });
  const newPath = join(f.home, 'new-codex'), calls = [];
  f.deps.discover = async path => { calls.push(path); return [{ ...f.binary(), path, source: 'explicit' }]; };
  assert.equal((await f.run('maintain', { binary: newPath })).state, 'refreshed');
  assert.ok(calls.length > 0 && calls.every(path => path === newPath));
  assert.equal((await readJson(join(stateDir(f.home), 'active.json'))).binaries[0].path, newPath);
});
test('failed upgrade preserves the previously verified patch', async t => {
  const f = await fixture(t), first = await f.run('repair'), before = await readFile(join(f.home, 'config.toml'), 'utf8');
  f.mutable.version = 2; f.mutable.fail = true;
  await assert.rejects(f.run('maintain'), /候选/);
  assert.equal(await readFile(join(f.home, 'config.toml'), 'utf8'), before);
  assert.equal((await readJson(join(f.home, 'tool-doctor', 'active.json'))).id, first.id);
});
test('maintenance reattaches a completely removed override but refuses a foreign override', async t => {
  const f = await fixture(t); await f.run('repair');
  await writeFile(join(f.home, 'config.toml'), f.raw + '\n# rewritten by app\n');
  const result = await f.run('maintain');
  assert.ok(result.reasons.includes('managed-override-removed'));
  await f.run('rollback');
  assert.equal(await readFile(join(f.home, 'config.toml'), 'utf8'), f.raw + '\n# rewritten by app\n');
  await f.run('repair');
  await writeFile(join(f.home, 'config.toml'), 'model_catalog_json="foreign.json"\n' + f.raw);
  await assert.rejects(f.run('maintain'), /区块冲突/);
});
test('missing catalog is rebuilt; edited catalog remains untouched', async t => {
  const f = await fixture(t), first = await f.run('repair');
  await unlink(first.catalogPath);
  assert.equal((await f.run('maintain')).state, 'refreshed');
  const active = await readJson(join(f.home, 'tool-doctor', 'active.json'));
  await appendFile(active.catalogPath, '\n');
  await assert.rejects(f.run('maintain'), /手动编辑/);
});
test('native upstream fix retires the override only after verification', async t => {
  const f = await fixture(t); await f.run('repair'); f.mutable.native = true; f.mutable.version = 2;
  assert.equal((await f.run('maintain')).state, 'native-supported');
  assert.equal((await status(f.home)).patched, false);
  assert.equal(await readFile(join(f.home, 'config.toml'), 'utf8'), f.raw);
});

test('native retirement rediscovers under the rollback lock and keeps the patch after a build or channel update', async t => {
  for (const change of ['sha256', 'path']) await t.test(change, async t => {
    const f = await fixture(t), first = await f.run('repair');
    const before = await readFile(join(f.home, 'config.toml'), 'utf8');
    f.mutable.native = true; f.mutable.version = 2;
    const discover = f.deps.discover, verify = f.deps.verify;
    let verified = false, checkedUnderLock = false;
    f.deps.verify = async (...args) => { const result = await verify(...args); verified = true; return result; };
    f.deps.discover = async path => {
      if (!verified) return discover(path);
      const lock = await readJson(join(stateDir(f.home), 'operation.lock'));
      assert.equal(lock.pid, process.pid); checkedUnderLock = true;
      const changed = { ...f.binary(), [change]: change === 'path' ? join(f.home, 'new-install', 'codex') : 'hash-3' };
      // Automatic selection must recheck the latest installation, not the still-present old file.
      return path ? [f.binary()] : change === 'path' ? [changed, f.binary()] : [changed];
    };
    await assert.rejects(f.run('maintain'), /Codex在原生验证后被更新/);
    assert.equal(checkedUnderLock, true);
    assert.equal(await readFile(join(f.home, 'config.toml'), 'utf8'), before);
    assert.equal((await readJson(join(stateDir(f.home), 'active.json'))).id, first.id);
    assert.equal(await readOptionalJson(join(stateDir(f.home), 'last-maintenance.json')), null);
    assert.equal(await readOptionalJson(join(stateDir(f.home), 'operation.lock')), null);
  });
});

test('native retirement catches base profile context and active changes during locked discovery', async t => {
  for (const change of ['base-config', 'active-id']) await t.test(change, async t => {
    const f = await fixture(t), profile = 'work';
    await writeFile(join(f.home, `${profile}.config.toml`), 'model="m"\n');
    const first = await f.run('repair', { profile }), directory = stateDir(f.home, profile);
    const profilePath = join(f.home, `${profile}.config.toml`), before = await readFile(profilePath, 'utf8');
    f.mutable.native = true; f.mutable.version = 2;
    const discover = f.deps.discover, verify = f.deps.verify;
    let verified = false, changed = false;
    f.deps.verify = async (...args) => { const result = await verify(...args); verified = true; return result; };
    f.deps.discover = async path => {
      if (verified) {
        assert.equal((await readJson(join(directory, 'operation.lock'))).pid, process.pid);
        if (change === 'base-config') await appendFile(join(f.home, 'config.toml'), '\n# concurrent base edit\n');
        else await saveJson(join(directory, 'active.json'), { ...first, id: 'replacement-active-id' });
        changed = true;
      }
      return discover(path);
    };
    await assert.rejects(f.run('maintain', { profile }), change === 'base-config' ? /配置改变/ : /生效补丁.*变化/);
    assert.equal(changed, true);
    assert.equal(await readFile(profilePath, 'utf8'), before);
    assert.equal(await readFile(join(f.home, 'config.toml'), 'utf8'), change === 'base-config' ? f.raw + '\n# concurrent base edit\n' : f.raw);
    assert.equal((await readJson(join(directory, 'active.json'))).id, change === 'active-id' ? 'replacement-active-id' : first.id);
    assert.equal(await readOptionalJson(join(directory, 'last-maintenance.json')), null);
    assert.equal(await readOptionalJson(join(directory, 'operation.lock')), null);
  });
});

test('native retirement rejects stale, mismatched and incomplete verification receipts', async t => {
  const mutations = {
    stale: receipt => { receipt.createdAt = new Date(Date.now() - 31 * 60 * 1000).toISOString(); },
    future: receipt => { receipt.createdAt = new Date(Date.now() + 120000).toISOString(); },
    context: receipt => { receipt.contextHash = 'other-context'; },
    endpoint: receipt => { receipt.endpointHash = 'other-endpoint'; },
    model: receipt => { receipt.model = 'other-model'; },
    catalog: receipt => { receipt.catalogHash = 'other-catalog'; },
    candidate: receipt => { receipt.candidateCatalog += '.other'; },
    binary: receipt => { receipt.results[0].binary += '.other'; },
    build: receipt => { receipt.results[0].sha256 = 'other-build'; },
    rounds: receipt => { receipt.rounds = 1; receipt.results.pop(); },
    duplicateRound: receipt => { receipt.results[1].round = 1; },
    failedRound: receipt => { receipt.results[1].passed = false; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async t => {
    const f = await fixture(t), first = await f.run('repair'), directory = stateDir(f.home);
    const before = await readFile(join(f.home, 'config.toml'), 'utf8');
    f.mutable.native = true; f.mutable.version = 2;
    const verify = f.deps.verify;
    f.deps.verify = async (...args) => {
      const receipt = await verify(...args); mutate(receipt);
      // Returning and saving the same bad receipt must not bypass semantic validation.
      await saveJson(join(directory, 'last-verification.json'), receipt);
      return receipt;
    };
    await assert.rejects(f.run('maintain'), /两轮成功终端验证记录/);
    assert.equal(await readFile(join(f.home, 'config.toml'), 'utf8'), before);
    assert.equal((await readJson(join(directory, 'active.json'))).id, first.id);
    assert.equal(await readOptionalJson(join(directory, 'last-maintenance.json')), null);
  });
});

test('native retirement rejects a replaced receipt or edited candidate under the rollback lock', async t => {
  for (const change of ['receipt', 'missing-receipt', 'candidate']) await t.test(change, async t => {
    const f = await fixture(t), first = await f.run('repair'), directory = stateDir(f.home);
    const before = await readFile(join(f.home, 'config.toml'), 'utf8');
    f.mutable.native = true; f.mutable.version = 2;
    const discover = f.deps.discover, verify = f.deps.verify;
    let receipt;
    f.deps.verify = async (...args) => { receipt = await verify(...args); return receipt; };
    f.deps.discover = async path => {
      if (receipt) {
        assert.equal((await readJson(join(directory, 'operation.lock'))).pid, process.pid);
        if (change === 'candidate') await appendFile(receipt.candidateCatalog, '\n');
        else if (change === 'missing-receipt') await unlink(join(directory, 'last-verification.json'));
        else await saveJson(join(directory, 'last-verification.json'), { ...receipt, createdAt: new Date(Date.parse(receipt.createdAt) - 1000).toISOString() });
      }
      return discover(path);
    };
    await assert.rejects(f.run('maintain'), change === 'candidate' ? /原生候选目录.*变化/ : /两轮成功终端验证记录/);
    assert.equal(await readFile(join(f.home, 'config.toml'), 'utf8'), before);
    assert.equal((await readJson(join(directory, 'active.json'))).id, first.id);
    assert.equal(await readOptionalJson(join(directory, 'last-maintenance.json')), null);
  });
});
test('healthy provider retires obsolete workaround after real verifier checks', async t => {
  const f = await fixture(t); await f.run('repair');
  f.deps.diagnose = async context => { const report = f.report(context); for (const sample of report.samples) sample.result = 'pass'; report.summary = summarize(report.samples); return report; };
  assert.equal((await f.run('maintain', { recheck: true })).state, 'native-supported');
  assert.equal((await status(f.home)).patched, false);
});
test('interrupted transaction restores exact pre-operation bytes', async t => {
  const f = await fixture(t), directory = join(f.home, 'tool-doctor'), configPath = join(f.home, 'config.toml'), restorePath = join(directory, 'restore.toml');
  await saveJson(join(directory, 'active.json'), { id: 'incomplete' });
  await writeFile(restorePath, f.raw);
  const changed = '# partially committed\n' + f.raw; await writeFile(configPath, changed);
  await saveJson(join(directory, 'transaction.json'), { id: 'interrupted', configPath, restorePath, beforeHash: hash(f.raw), afterHash: hash(changed), previous: null });
  assert.equal((await recover(f.home)).recovered, true);
  assert.equal(await readFile(configPath, 'utf8'), f.raw);
  assert.equal((await status(f.home)).patched, false);
});
test('rollback works even after user changes endpoint to an unsupported value', async t => {
  const f = await fixture(t); await f.run('repair');
  const path = join(f.home, 'config.toml'), current = await readFile(path, 'utf8');
  await writeFile(path, current.replace('http://127.0.0.1:8765/v1', 'ftp://example.test'));
  await rollback(f.home);
  const restored = await readFile(path, 'utf8'); assert.ok(restored.includes('ftp://example.test')); assert.ok(!restored.includes('managed protocol patch'));
});
test('concurrent apply operations cannot both commit', async t => {
  const f = await fixture(t), context = await loadConfig(f.home), plan = await createPlan(context, f.report(context), [f.binary()], { load: f.deps.catalog });
  await f.deps.verify(context, plan.binaries, { catalogPath: plan.catalogPath });
  const results = await Promise.allSettled([applyPlan(f.home, plan, { discover: f.deps.discover }), applyPlan(f.home, plan, { discover: f.deps.discover })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await status(f.home)).state, 'verified');
});
