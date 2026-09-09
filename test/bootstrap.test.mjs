import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { dependenciesReady, ensureDependencies, dependencyLock, findNpm, NEED_RUNTIME } from '../scripts/launch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'doctor bootstrap 中文-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('bootstrap verifies dependency import, not merely package.json presence', async t => {
  const directory = await fixture(t);
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module', dependencies: { 'smol-toml': '1.8.0' } }));
  assert.equal(await dependenciesReady(directory), false);
  await mkdir(join(directory, 'node_modules', 'smol-toml'), { recursive: true });
  await writeFile(join(directory, 'node_modules', 'smol-toml', 'package.json'), '{"name":"smol-toml","version":"1.8.0","type":"module","main":"index.js"}');
  assert.equal(await dependenciesReady(directory), false);
  await cp(join(root, 'node_modules', 'smol-toml'), join(directory, 'node_modules', 'smol-toml'), { recursive: true });
  assert.equal(await dependenciesReady(directory), true);
});

test('healthy dependencies start offline without requiring npm', async t => {
  const directory = await fixture(t);
  assert.equal(await ensureDependencies(directory, { ready: async () => true, npm: () => { throw new Error('npm must not be used'); } }), 0);
  await assert.rejects(access(join(directory, '.doctor-setup-lock')));
});

test('missing npm requests a managed runtime without pretending installation succeeded', async t => {
  const directory = await fixture(t);
  assert.equal(await ensureDependencies(directory, { ready: async () => false, npm: async () => null }), NEED_RUNTIME);
  await assert.rejects(access(join(directory, '.doctor-setup-lock')));
});

test('npm retry switches registry and validates installed code before continuing', async t => {
  const directory = await fixture(t), calls = []; let healthy = false;
  const result = await ensureDependencies(directory, {
    ready: async () => healthy, npm: async () => 'npm-cli.js', pause: async () => {},
    run: async (args, options) => { if (args[1] === '--version') return 0; calls.push({ args, options }); healthy = calls.length === 3; return calls.length > 1 ? 0 : 1; },
  });
  assert.equal(result, 0); assert.equal(calls.length, 3);
  assert.ok(!calls[0].args.some(arg => arg.startsWith('--registry=')));
  assert.ok(calls[1].args.includes('--registry=https://registry.npmjs.org/'));
  for (const call of calls) { assert.ok(call.args.includes('--ignore-scripts')); assert.equal(call.options.cwd, directory); assert.equal(call.options.timeout, 600000); }
});

test('persistent install failure has bounded retries and releases lock for next launch', async t => {
  const directory = await fixture(t); let attempts = 0;
  await assert.rejects(ensureDependencies(directory, {
    ready: async () => false, npm: async () => 'npm-cli.js', pause: async () => {}, run: async args => { if (args[1] === '--version') return 0; attempts++; return 1; },
  }), /依赖自动安装仍未成功/);
  assert.equal(attempts, 3);
  await assert.rejects(access(join(directory, '.doctor-setup-lock')));
});

test('concurrent starters install once and the waiter rechecks readiness', async t => {
  const directory = await fixture(t); let count = 0, ready = false;
  const options = { ready: async () => ready, npm: async () => 'npm', run: async args => { if (args[1] === '--version') return 0; count++; await new Promise(r => setTimeout(r, 80)); ready = true; return 0; } };
  assert.deepEqual(await Promise.all([ensureDependencies(directory, options), ensureDependencies(directory, options)]), [0, 0]);
  assert.equal(count, 1);
});

test('a live dependency installer cannot be displaced', async t => {
  const directory = await fixture(t), release = await dependencyLock(directory);
  await assert.rejects(dependencyLock(directory, { waitMs: 25, intervalMs: 5 }), /等待其他启动器/);
  await release();
  await (await dependencyLock(directory))();
});

test('two waiters recover a dead owner without deleting each other\'s new lock', async t => {
  const directory = await fixture(t);
  const exitedPid = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', ''], { windowsHide: true });
    child.once('error', reject); child.once('exit', () => resolve(child.pid));
  });
  await mkdir(join(directory, '.doctor-setup-lock', `owner-${exitedPid}-abc123`), { recursive: true });
  let active = 0, maximum = 0;
  const acquire = async () => {
    const release = await dependencyLock(directory, { waitMs: 5000, intervalMs: 10 });
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 60));
    active--; await release();
  };
  await Promise.all([acquire(), acquire()]);
  assert.equal(maximum, 1);
  await assert.rejects(access(join(directory, '.doctor-setup-lock')));
});

test('broken npm also requests an automatically managed runtime', async t => {
  const directory = await fixture(t);
  assert.equal(await ensureDependencies(directory, { ready: async () => false, npm: async () => 'broken-npm', run: async () => 1 }), NEED_RUNTIME);
});

test('npm lookup follows an installed runtime and reports absence honestly', async t => {
  assert.ok(await findNpm());
  const directory = await fixture(t);
  assert.equal(await findNpm(join(directory, 'node'), { PATH: '' }), null);
  const npm = join(directory, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await mkdir(dirname(npm), { recursive: true }); await writeFile(npm, '//fixture');
  assert.equal(await findNpm(join(directory, 'bin', 'node'), { PATH: '' }), npm);
});

test('WSH parser rejects stale runtimes and foreign or malformed manifest records', async () => {
  const context = vm.createContext({}); vm.runInContext(await readFile(join(root, 'scripts', 'bootstrap-windows.js'), 'utf8'), context);
  assert.equal(context.runtimeSupported('v20.9.0'), false); assert.equal(context.runtimeSupported('v22.0.0'), true);
  assert.equal(context.runtimeSupported('v24.21.0'), true); assert.equal(context.runtimeSupported('broken'), false);
  const records = context.parseManifest(await readFile(join(root, 'scripts', 'node-runtimes.txt'), 'utf8'), 'x64');
  assert.equal(records.length, 2);
  assert.equal(records[0].version, 'v24.21.0');
  assert.equal(context.parseManifest('v24.21.0 ../../payload.zip ' + '0'.repeat(64), 'x64').length, 0);
});
