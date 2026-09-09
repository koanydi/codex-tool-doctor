// Explicit integration check: downloads an official Node release into a disposable
// directory. Never removes system Node, changes PATH globally, or reads Codex config.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'doctor-clean-install-'));
const project = join(directory, '中文 project'), cache = join(directory, '中文 runtimes');
await mkdir(project);
const env = { ...process.env, TOOL_DOCTOR_IGNORE_SYSTEM_NODE: '1', TOOL_DOCTOR_RUNTIME_DIR: cache };
const run = promisify(execFile);
const launch = async () => {
  // Windows batch entry points require the cmd.exe interpreter.
  const file = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', '""' + join(project, 'doctor.cmd') + '" --help"']
    : [join(project, 'doctor.sh'), '--help'];
  const result = await run(file, args, { env, timeout: 2400000, windowsHide: true, windowsVerbatimArguments: process.platform === 'win32', maxBuffer: 2_000_000 });
  assert.match(result.stdout, /Codex工具诊断与修复/);
  return result;
};
try {
  for (const name of ['package.json', 'package-lock.json', 'doctor.cmd', 'doctor.sh', 'src', 'scripts']) {
    await cp(join(root, name), join(project, name), { recursive: true });
  }
  const first = await launch();
  console.log(first.stderr.trim());
  assert.equal(JSON.parse(await readFile(join(project, 'node_modules/smol-toml/package.json'))).version, '1.8.0');
  const versions = (await readdir(cache)).filter(name => /^node-v/.test(name));
  assert.equal(versions.length, 1);
  const runtime = join(cache, versions[0]);
  const before = (await stat(runtime)).mtimeMs;
  const second = await launch();
  assert.equal(second.stderr, '');
  assert.equal((await stat(runtime)).mtimeMs, before);
  console.log('PASS: missing Node + missing dependencies install automatically; cached launch is offline.');
  await rm(join(project, 'node_modules/smol-toml/dist/index.js'));
  const repaired = await launch();
  assert.match(repaired.stderr, /依赖已就绪/);
  console.log('PASS: an installed but broken dependency repairs automatically.');

  const node = process.platform === 'win32' ? join(runtime, 'node.exe') : join(runtime, 'bin/node');
  const gui = spawn(node, [join(project, 'scripts/launch.mjs'), 'gui', '--no-open', '--home', join(directory, 'isolated-home')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  gui.stderr.on('data', data => { errors += data; });
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('GUI startup timeout: ' + errors)), 15000);
      gui.on('error', error => { clearTimeout(timer); reject(error); });
      gui.on('exit', code => { clearTimeout(timer); reject(new Error('GUI exited: ' + code + ' ' + errors)); });
      gui.stdout.on('data', data => { output += data; const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#\w+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    });
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); assert.match(await response.text(), /Codex/);
    console.log('PASS: automatically installed runtime starts the GUI on loopback.');
  } finally {
    if (gui.exitCode === null) { const exited = new Promise(resolve => gui.once('exit', resolve)); gui.kill(); await exited; }
  }
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
