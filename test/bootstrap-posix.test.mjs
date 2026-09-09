import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repo = fileURLToPath(new URL('../', import.meta.url));
const shell = process.platform === 'win32'
  ? [join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/sh.exe'),
    join(process.env.LOCALAPPDATA || '', 'Programs/Git/bin/sh.exe')].find(existsSync)
  : '/bin/sh';
const canShell = Boolean(shell && existsSync(shell));
const posix = path => process.platform === 'win32'
  ? path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
  : path;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const tools = ['sh', 'dirname', 'awk', 'tar', 'gzip', 'mkdir', 'rmdir', 'mktemp', 'mv', 'rm', 'sleep', 'cp',
  'sha256sum', 'shasum', 'openssl'];
const realTools = canShell ? Object.fromEntries(spawnSync(shell, ['-c',
  tools.map(name => `printf '${name} '; command -v ${name} || printf '\\n'`).join('\n')],
{ encoding: 'utf8', windowsHide: true }).stdout.trim().split(/\r?\n/)
  .map(line => { const index = line.indexOf(' '); return [line.slice(0, index), line.slice(index + 1)]; })) : {};
const supportedHost = ['linux', 'darwin'].includes(process.platform) && ['x64', 'arm64'].includes(process.arch);

async function executable(path, source) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\n${source}\n`);
  await chmod(path, 0o755);
}

async function fixture(t, { os = 'Linux', arch = 'x86_64', libc = 'glibc', system, ignore = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'doctor posix bootstrap '));
  t.after(async () => {
    // This resolved mkdtemp directory is the only tree removed by these tests.
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const project = join(root, 'project with spaces');
  const bin = join(root, 'isolated bin');
  const cache = join(root, 'runtime cache');
  const downloads = join(root, 'downloads');
  await Promise.all([mkdir(join(project, 'scripts'), { recursive: true }), mkdir(bin), mkdir(downloads)]);
  await Promise.all(['doctor.sh', 'doctor.command', 'scripts/bootstrap-posix.sh'].map(file =>
    copyFile(join(repo, file), join(project, file))));
  await writeFile(join(project, 'scripts/launch.mjs'), `
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const record = { args: args.length ? args : ['menu'], runtime: process.env.FIXTURE_RUNTIME || 'native',
  input: process.env.READ_INPUT ? readFileSync(0, 'utf8') : '', path: process.env.PATH };
appendFileSync(process.env.LAUNCH_LOG, JSON.stringify(record) + '\\n');
if (record.runtime === process.env.REJECT_RUNTIME) process.exit(78);
process.exit(Number(record.runtime === 'system' ? process.env.SYSTEM_LAUNCH_EXIT || 0 : process.env.LAUNCH_EXIT || 0));
`);
  for (const name of tools) {
    if (realTools[name]) await executable(join(bin, name), `exec ${quote(realTools[name])} "$@"`);
  }
  await executable(join(bin, 'uname'), `case "$1" in -s) printf '%s\\n' ${quote(os)};; -m) printf '%s\\n' ${quote(arch)};; esac`);
  await executable(join(bin, 'ldd'), `printf '%s\\n' ${quote(libc)}; exit 1`);
  // Offline curl substitute records the complete request, including TLS and
  // deadline options; all returned bytes still pass the real SHA256 and tar.
  await executable(join(bin, 'curl'), `
printf '%s\\n' "$*" >> "$REQUEST_LOG"
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
case "\${FETCH_MODE:-ok}:$url" in
  offline:*) exit 28 ;;
  alternate:https://nodejs.org/dist/*) exit 22 ;;
  bad-primary:https://nodejs.org/dist/*) printf bad > "$output"; exit 0 ;;
  bad:*) printf bad > "$output"; exit 0 ;;
  fallback:*node-v24.*) exit 22 ;;
esac
[ -z "\${FETCH_DELAY:-}" ] || sleep "$FETCH_DELAY"
cp "$ARCHIVE_DIR/\${url##*/}" "$output"
`);
  const env = { ...process.env, PATH: posix(bin), HOME: posix(join(root, 'home')), XDG_DATA_HOME: '',
    TOOL_DOCTOR_RUNTIME_DIR: posix(cache), TOOL_DOCTOR_IGNORE_SYSTEM_NODE: ignore ? '1' : '0',
    ARCHIVE_DIR: posix(downloads), REQUEST_LOG: posix(join(root, 'requests.log')),
    LAUNCH_LOG: join(root, 'launch.log'), FETCH_MODE: 'ok', FETCH_DELAY: '', READ_INPUT: '',
    SYSTEM_LAUNCH_EXIT: '0', LAUNCH_EXIT: '0', REJECT_RUNTIME: '', BOOTSTRAP_PID_FILE: '', MSYS2_ARG_CONV_EXCL: '' };
  // On Windows, the real Node used by the fixture expects a Windows log path.
  const f = { root, project, bin, cache, downloads, env };
  if (system) await executable(join(bin, 'node'), nodeScript(system, 'system'));
  f.manifest = async entries => writeFile(join(project, 'scripts/node-runtimes.txt'),
    '# fixture manifest\r\n' + entries.map(e => `${e.version} ${e.filename} ${e.sha}`).join('\r\n') + '\r\n');
  f.run = (args = [], overrides = {}, entry = 'doctor.sh', input = '') => runShell(
    ['-c', 'shell=$1; script=$2; PATH=$3; export PATH; shift 3; ' +
      '[ -z "$BOOTSTRAP_PID_FILE" ] || printf "%s\\n" "$$" > "$BOOTSTRAP_PID_FILE"; exec "$shell" "$script" "$@"',
      'fixture', realTools.sh, posix(join(project, entry)), overrides.PATH ?? env.PATH, ...args],
    { ...env, ...overrides }, root, input);
  f.launches = async () => (await readFile(join(root, 'launch.log'), 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  f.requests = async () => (await readFile(join(root, 'requests.log'), 'utf8').catch(() => ''))
    .trim().split('\n').filter(Boolean);
  return f;
}

function runShell(args, env, cwd, input = '') {
  return new Promise((resolveRun, reject) => {
    const child = spawn(shell, args, { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolveRun({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

function nodeScript(version, label, { broken = false, npmBroken = false } = {}) {
  if (broken) return 'exit 127';
  return `
case "$1" in
  -e) exit ${Number(version.split('.')[0]) >= 22 ? 0 : 1} ;;
  -p) printf '%s\\n' ${quote(version)}; exit 0 ;;
  */lib/node_modules/npm/bin/npm-cli.js) ${npmBroken ? 'exit 1' : "printf '10.0.0\\n'; exit 0"} ;;
esac
FIXTURE_RUNTIME=${quote(label)}
export FIXTURE_RUNTIME
exec ${quote(posix(process.execPath))} "$@"
`;
}

async function runtimeTree(root, name, version, options = {}) {
  const directory = join(root, name);
  await executable(join(directory, 'bin/node'), nodeScript(version, name, options));
  if (!options.noNpm) {
    await executable(join(directory, 'bin/npm'), 'exit 0');
    await mkdir(join(directory, 'lib/node_modules/npm/bin'), { recursive: true });
    await writeFile(join(directory, 'lib/node_modules/npm/bin/npm-cli.js'), '// fixture npm');
  }
  return directory;
}

async function archive(f, { version = '24.1.0', platform = 'linux-x64', ...options } = {}) {
  const name = `node-v${version}-${platform}`;
  const filename = `${name}.tar.gz`;
  const source = join(f.root, `source ${name}`);
  await runtimeTree(source, name, options.actualVersion || version, options);
  const result = await runShell(['-c', 'exec "$1" -czf "$2" -C "$3" "$4"',
    'fixture', realTools.tar, posix(join(f.downloads, filename)), posix(source), name], f.env, f.root);
  assert.equal(result.code, 0, result.stderr);
  const sha = createHash('sha256').update(await readFile(join(f.downloads, filename))).digest('hex');
  return { version: `v${version}`, filename, sha, name };
}

async function cleanInstallState(f) {
  const entries = await readdir(f.cache).catch(() => []);
  assert.deepEqual(entries.filter(name => name.includes('.stage.') || name.endsWith('.lock')), []);
}

const shellTest = (name, fn) => test(name, { skip: !canShell && 'POSIX shell/Git sh unavailable', timeout: 120000 }, fn);

shellTest('POSIX files use LF, parse as sh, and forward to the shared bootstrap', async () => {
  for (const name of ['doctor.sh', 'doctor.command', 'scripts/bootstrap-posix.sh']) {
    const source = await readFile(join(repo, name), 'utf8');
    assert.ok(source.startsWith('#!/bin/sh\n'), name);
    assert.equal(source.includes('\r'), false, name);
    const result = spawnSync(shell, ['-n', posix(join(repo, name))], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.match(await readFile(join(repo, 'doctor.sh'), 'utf8'), /exec sh "\$script_dir\/scripts\/bootstrap-posix\.sh" "\$@"/);
});

shellTest('usable system Node forwards arguments/stdin, defaults to menu, and needs no manifest/cache', async t => {
  const f = await fixture(t, { system: '22.1.0', ignore: false });
  const args = ['verify', 'space value', '', '$HOME; echo nope', '中文'];
  let result = await f.run(args, { READ_INPUT: '1' }, 'doctor.sh', 'interactive input\n');
  assert.equal(result.code, 0, result.stderr);
  result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  const launches = await f.launches();
  assert.deepEqual(launches[0].args, args);
  assert.equal(launches[0].input, 'interactive input\n');
  assert.deepEqual(launches[1].args, ['menu']);
  assert.equal(launches[0].runtime, 'system');
  assert.deepEqual(await f.requests(), []);
  assert.equal(existsSync(f.cache), false);
});

shellTest('ordinary launch failures propagate without download or duplicate execution', async t => {
  const f = await fixture(t, { system: '24.0.0', ignore: false });
  const result = await f.run(['diagnose'], { SYSTEM_LAUNCH_EXIT: '43' });
  assert.equal(result.code, 43, result.stderr);
  assert.equal((await f.launches()).length, 1);
  assert.deepEqual(await f.requests(), []);
});

for (const [label, options] of [
  ['absent', { ignore: false }],
  ['old', { system: '20.1.0', ignore: false }],
  ['unrunnable', { system: '24.1.0', ignore: false }],
  ['ignored', { system: '24.1.0', ignore: true }],
  ['missing npm (78)', { system: '24.1.0', ignore: false }],
]) {
  shellTest(`${label} system Node installs a verified portable Node and preserves arguments`, async t => {
    const f = await fixture(t, options);
    if (label === 'unrunnable') await executable(join(f.bin, 'node'), 'exit 127');
    const entry = await archive(f);
    await f.manifest([entry]);
    const result = await f.run(['status', 'two words'], label === 'missing npm (78)' ? { SYSTEM_LAUNCH_EXIT: '78' } : {});
    assert.equal(result.code, 0, result.stderr);
    const launches = await f.launches();
    assert.equal(launches.length, label === 'missing npm (78)' ? 2 : 1);
    assert.equal(launches.at(-1).runtime, entry.name);
    assert.deepEqual(launches.at(-1).args, ['status', 'two words']);
    assert.ok(existsSync(join(f.cache, entry.name, 'bin/node')));
    const requests = await f.requests();
    assert.equal(requests.length, 1);
    assert.match(requests[0], /-q .*--proto =https --proto-redir =https --tlsv1\.2/);
    assert.match(requests[0], /--connect-timeout 10 --max-time 60 --retry 0/);
    await cleanInstallState(f);
  });
}

for (const [os, arch, libc, platform] of [
  ['Darwin', 'x86_64', '', 'darwin-x64'],
  ['Darwin', 'arm64', '', 'darwin-arm64'],
  ['Linux', 'x86_64', 'glibc', 'linux-x64'],
  ['Linux', 'aarch64', 'glibc', 'linux-arm64'],
  ['Linux', 'x86_64', 'musl libc (x86_64)', 'linux-x64-musl'],
]) {
  shellTest(`platform selection and portable cache reuse: ${platform}`, async t => {
    const f = await fixture(t, { os, arch, libc });
    const entry = await archive(f, { platform });
    await f.manifest([entry]);
    let result = await f.run([], { READ_INPUT: '1' }, 'doctor.sh', '0\n');
    assert.equal(result.code, 0, result.stderr);
    result = await f.run(['--help'], { FETCH_MODE: 'offline' });
    assert.equal(result.code, 0, result.stderr);
    const launches = await f.launches();
    assert.equal(launches[0].runtime, entry.name);
    assert.equal(launches[0].input, '0\n');
    assert.deepEqual(launches[0].args, ['menu']);
    assert.equal((await f.requests()).length, 1);
    assert.match((await f.requests())[0], /https:\/\/nodejs\.org\/dist\//);
    await cleanInstallState(f);
  });
}

shellTest('Node 24 is preferred regardless of manifest order; a usable cached 22 avoids downloads', async t => {
  const f = await fixture(t);
  const [older, newer] = await Promise.all([archive(f, { version: '22.1.0' }), archive(f)]);
  await f.manifest([older, newer]);
  let result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await f.launches())[0].runtime, newer.name);
  const otherCache = join(f.root, 'older cache');
  await runtimeTree(otherCache, older.name, '22.1.0');
  result = await f.run([], { TOOL_DOCTOR_RUNTIME_DIR: posix(otherCache), FETCH_MODE: 'offline' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await f.launches())[1].runtime, older.name);
  assert.equal((await f.requests()).length, 1);
});

shellTest('a cached launch returning 78 tries every remaining cache before downloading', async t => {
  const f = await fixture(t);
  const [newer, older] = await Promise.all([archive(f), archive(f, { version: '22.1.0' })]);
  await f.manifest([newer, older]);
  await Promise.all([runtimeTree(f.cache, newer.name, '24.1.0'), runtimeTree(f.cache, older.name, '22.1.0')]);
  const before = await readFile(join(f.cache, newer.name, 'bin/node'));
  const result = await f.run(['cached'], { REJECT_RUNTIME: newer.name, FETCH_MODE: 'offline' });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await f.launches()).map(x => x.runtime), [newer.name, older.name]);
  assert.deepEqual(await f.requests(), []);
  assert.deepEqual(await readFile(join(f.cache, newer.name, 'bin/node')), before);
});

shellTest('portable application errors propagate without trying another runtime', async t => {
  const f = await fixture(t);
  const [newer, older] = await Promise.all([archive(f), archive(f, { version: '22.1.0' })]);
  await f.manifest([newer, older]);
  const result = await f.run(['status'], { LAUNCH_EXIT: '43' });
  assert.equal(result.code, 43, result.stderr);
  assert.deepEqual((await f.launches()).map(x => x.runtime), [newer.name]);
  assert.equal((await f.requests()).length, 1);
});

for (const mode of ['alternate', 'bad-primary']) {
  shellTest(`${mode}: bounded retries use the official alternate URL and enforce SHA256`, async t => {
    const f = await fixture(t);
    const entry = await archive(f);
    await f.manifest([entry]);
    const result = await f.run([], { FETCH_MODE: mode });
    assert.equal(result.code, 0, result.stderr);
    const requests = await f.requests();
    assert.equal(requests.length, 3);
    assert.match(requests[0], /https:\/\/nodejs\.org\/dist\//);
    assert.match(requests[1], /https:\/\/nodejs\.org\/dist\//);
    assert.match(requests[2], /https:\/\/nodejs\.org\/download\/release\//);
    await cleanInstallState(f);
  });
}

shellTest('failed Node 24 downloads fall back to the pinned Node 22', async t => {
  const f = await fixture(t);
  const [newer, older] = await Promise.all([archive(f), archive(f, { version: '22.1.0' })]);
  await f.manifest([newer, older]);
  const result = await f.run([], { FETCH_MODE: 'fallback' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await f.launches())[0].runtime, older.name);
  assert.equal((await f.requests()).length, 5);
  assert.equal(existsSync(join(f.cache, newer.name)), false);
  await cleanInstallState(f);
});

for (const options of [{ broken: true }, { noNpm: true }, { npmBroken: true }, { actualVersion: '20.1.0' }]) {
  shellTest(`staged runtime validation rejects ${JSON.stringify(options)} and falls back to 22`, async t => {
    const f = await fixture(t);
    const [newer, older] = await Promise.all([archive(f, options), archive(f, { version: '22.1.0' })]);
    await f.manifest([newer, older]);
    const result = await f.run();
    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(join(f.cache, newer.name)), false);
    assert.equal((await f.launches())[0].runtime, older.name);
    await cleanInstallState(f);
  });
}

for (const mode of ['offline', 'bad']) {
  shellTest(`${mode}: failure leaves an existing runtime tree intact and removes staging/locks`, async t => {
    const f = await fixture(t);
    const entry = await archive(f);
    await f.manifest([entry]);
    const existing = await runtimeTree(f.cache, entry.name, '24.1.0', { noNpm: true });
    const before = await readFile(join(existing, 'bin/node'));
    const result = await f.run([], { FETCH_MODE: mode });
    assert.equal(result.code, 1, result.stderr);
    assert.deepEqual(await readFile(join(existing, 'bin/node')), before);
    assert.equal((await f.requests()).length, 4);
    assert.deepEqual(await f.launches(), []);
    await cleanInstallState(f);
  });
}

shellTest('a broken cache is replaced only after a complete runtime validates', async t => {
  const f = await fixture(t);
  const entry = await archive(f);
  await f.manifest([entry]);
  await runtimeTree(f.cache, entry.name, '24.1.0', { broken: true });
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await f.launches())[0].runtime, entry.name);
  await cleanInstallState(f);
});

shellTest('failed promotion rolls the original runtime back', async t => {
  const f = await fixture(t);
  const entry = await archive(f);
  await f.manifest([entry]);
  const original = await runtimeTree(f.cache, entry.name, '24.1.0', { noNpm: true });
  const before = await readFile(join(original, 'bin/node'));
  await executable(join(f.bin, 'mv'), `
case "$2" in */extract/*) exit 1 ;; esac
exec ${quote(realTools.mv)} "$@"
`);
  const result = await f.run();
  assert.equal(result.code, 1, result.stderr);
  assert.deepEqual(await readFile(join(original, 'bin/node')), before);
  assert.deepEqual(await f.launches(), []);
  await cleanInstallState(f);
});

shellTest('concurrent bootstrap processes publish once and both launch the complete runtime', async t => {
  const f = await fixture(t);
  const entry = await archive(f);
  await f.manifest([entry]);
  const results = await Promise.all([f.run(['first'], { FETCH_DELAY: '1' }), f.run(['second'], { FETCH_DELAY: '1' })]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal((await f.requests()).length, 1);
  const launches = await f.launches();
  assert.deepEqual(launches.map(x => x.args[0]).sort(), ['first', 'second']);
  assert.ok(launches.every(x => x.runtime === entry.name));
  await cleanInstallState(f);
});

shellTest('a dead owner lock can be recovered by concurrent waiters', async t => {
  const f = await fixture(t);
  const entry = await archive(f);
  await f.manifest([entry]);
  await mkdir(join(f.cache, `.${entry.name}.lock`, 'owner.2147483647'), { recursive: true });
  const results = await Promise.all([f.run(['first']), f.run(['second'])]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal((await f.requests()).length, 1);
  await cleanInstallState(f);
});

shellTest('killing the outer launcher never causes an active installer lock to be stolen', async t => {
  const f = await fixture(t);
  const entry = await archive(f);
  await f.manifest([entry]);
  const pidFile = join(f.root, 'bootstrap.pid');
  const first = f.run(['interrupted'], { FETCH_DELAY: '4', BOOTSTRAP_PID_FILE: posix(pidFile) });
  try {
    const deadline = Date.now() + 20000;
    while ((await f.requests()).length === 0 && Date.now() < deadline) await delay(50);
    assert.equal((await f.requests()).length, 1, 'installer reached the simulated download');
    const pid = (await readFile(pidFile, 'utf8')).trim();
    assert.match(pid, /^[1-9][0-9]*$/);
    const owners = await readdir(join(f.cache, `.${entry.name}.lock`));
    assert.equal(owners.length, 1);
    assert.notEqual(owners[0], `owner.${pid}`, 'lock belongs to the actual installer, not the outer shell');
    const killed = await runShell(['-c', 'kill -KILL "$1"', 'fixture', pid], f.env, f.root);
    assert.equal(killed.code, 0, killed.stderr);
    const second = await f.run(['survivor']);
    assert.equal(second.code, 0, second.stderr);
  } finally { await first; }
  assert.equal((await f.requests()).length, 1, 'the still-running installer must retain its lock');
  assert.deepEqual((await f.launches()).map(x => x.args), [['survivor']]);
  await cleanInstallState(f);
});

shellTest('cache precedence supports XDG_DATA_HOME and HOME defaults', async t => {
  const f = await fixture(t);
  const entry = await archive(f);
  await f.manifest([entry]);
  const xdg = join(f.root, 'xdg data');
  let result = await f.run([], { TOOL_DOCTOR_RUNTIME_DIR: '', XDG_DATA_HOME: posix(xdg) });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(existsSync(join(xdg, 'codex-tool-doctor/runtimes', entry.name, 'bin/node')));
  result = await f.run([], { TOOL_DOCTOR_RUNTIME_DIR: '', XDG_DATA_HOME: '' });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(existsSync(join(f.root, 'home/.local/share/codex-tool-doctor/runtimes', entry.name, 'bin/node')));
  assert.equal(existsSync(f.cache), false);
});

shellTest('invalid checksums and unsafe manifest names fail before network or cache creation', async t => {
  const f = await fixture(t);
  for (const line of [
    'v24.1.0 node-v24.1.0-linux-x64.tar.gz not-a-sha',
    `v24.1.0 ../../node-v24.1.0-linux-x64.tar.gz ${'a'.repeat(64)}`,
    `v24.1.0 node-v24.1.0-linux-x64.tar.gz ${'a'.repeat(64)} extra`,
  ]) {
    await writeFile(join(f.project, 'scripts/node-runtimes.txt'), `${line}\n`);
    const result = await f.run();
    assert.equal(result.code, 1, result.stderr);
  }
  assert.deepEqual(await f.requests(), []);
  assert.equal(existsSync(f.cache), false);
});

shellTest('unexpected archive root is rejected despite a matching pinned digest', async t => {
  const f = await fixture(t);
  const entry = await archive(f);
  const contents = join(f.root, 'unexpected');
  await mkdir(contents);
  await writeFile(join(contents, 'unexpected.txt'), 'do not extract');
  const result = await runShell(['-c', 'exec "$1" -czf "$2" -C "$3" unexpected.txt',
    'fixture', realTools.tar, posix(join(f.downloads, entry.filename)), posix(contents)], f.env, f.root);
  assert.equal(result.code, 0, result.stderr);
  entry.sha = createHash('sha256').update(await readFile(join(f.downloads, entry.filename))).digest('hex');
  await f.manifest([entry]);
  const installed = await f.run();
  assert.equal(installed.code, 1, installed.stderr);
  assert.equal(existsSync(join(f.cache, entry.name)), false);
  assert.equal(existsSync(join(f.cache, 'unexpected.txt')), false);
  await cleanInstallState(f);
});

shellTest('unsupported musl arm64 fails without attempting glibc downloads', async t => {
  const f = await fixture(t, { arch: 'aarch64', libc: 'musl libc' });
  const result = await f.run();
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /musl/);
  assert.deepEqual(await f.requests(), []);
});

test('native POSIX system Node executes the shared launch contract', {
  skip: !supportedHost && 'requires a native macOS/Linux x64/arm64 host', timeout: 120000,
}, async t => {
  const f = await fixture(t, { ignore: false });
  await executable(join(f.bin, 'node'), `exec ${quote(process.execPath)} "$@"`);
  const result = await f.run(['--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await f.launches())[0].runtime, 'native');
  assert.deepEqual(await f.requests(), []);
});

test('native macOS doctor.command keeps the GUI entry and argument forwarding', {
  skip: process.platform !== 'darwin' && 'requires macOS', timeout: 120000,
}, async t => {
  const f = await fixture(t, { ignore: false });
  await executable(join(f.bin, 'node'), `exec ${quote(process.execPath)} "$@"`);
  const result = await f.run(['--port', '12345'], {}, 'doctor.command');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await f.launches())[0].args, ['gui', '--port', '12345']);
});

test('native POSIX official pinned download passes real Node and npm validation', {
  skip: (!supportedHost || process.env.TOOL_DOCTOR_TEST_NETWORK !== '1') &&
    'requires native macOS/Linux and TOOL_DOCTOR_TEST_NETWORK=1', timeout: 600000,
}, async t => {
  const f = await fixture(t);
  await copyFile(join(repo, 'scripts/node-runtimes.txt'), join(f.project, 'scripts/node-runtimes.txt'));
  // Restore real platform detection, downloader and utility search paths only
  // inside this temporary subprocess. The installed system Node is untouched.
  const result = await f.run(['--help'], { PATH: process.env.PATH, TOOL_DOCTOR_IGNORE_SYSTEM_NODE: '1' });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await f.launches())[0].args, ['--help']);
  assert.ok((await readdir(f.cache)).some(name => /^node-v(24|22)\./.test(name)));
  await cleanInstallState(f);
});
