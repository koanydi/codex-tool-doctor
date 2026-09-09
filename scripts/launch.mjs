// Built-ins only: this module must run before npm dependencies exist.
import { spawn } from 'node:child_process';
import { readFile, mkdir, rm, realpath, rename, readdir, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const NEED_RUNTIME = 78;
const root = fileURLToPath(new URL('../', import.meta.url));
const log = message => console.error(`[环境准备] ${message}`);

export function runNode(args, { cwd = root, env = process.env, timeout = 0, stdio = 'inherit' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio, windowsHide: true });
    const timer = timeout ? setTimeout(() => child.kill(), timeout) : null;
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve(signal ? 1 : (code ?? 1)); });
  });
}

export async function dependenciesReady(directory = root, run = runNode) {
  try {
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    for (const [name, version] of Object.entries(pkg.dependencies || {})) {
      const installed = JSON.parse(await readFile(join(directory, 'node_modules', name, 'package.json'), 'utf8'));
      if (installed.version !== version) return false;
    }
    // Check in a fresh process: a failed ESM import remains cached in its process.
    const source = `import {parse} from 'smol-toml'; if(parse('ok=true').ok!==true) process.exit(1)`;
    return await run(['--input-type=module', '--eval', source], { cwd: directory, timeout: 15000, stdio: 'ignore' }) === 0;
  } catch { return false; }
}

export async function findNpm(executable = process.execPath, env = process.env) {
  const resolved = await realpath(executable).catch(() => executable);
  const bases = [...new Set([dirname(executable), dirname(resolved), ...(env.PATH || env.Path || '').split(delimiter)])];
  for (const base of bases.filter(Boolean)) {
    for (const relative of ['node_modules/npm/bin/npm-cli.js', '../lib/node_modules/npm/bin/npm-cli.js', '../share/nodejs/npm/bin/npm-cli.js']) {
      const candidate = join(base, relative);
      try { await readFile(candidate); return candidate; } catch {}
    }
  }
  return null;
}

export async function dependencyLock(directory, { waitMs = 2400000, intervalMs = 250 } = {}) {
  const lock = join(directory, '.doctor-setup-lock');
  const token = randomUUID(), start = Date.now();
  const owner = `owner-${process.pid}-${token}`;
  for (;;) {
    const staging = lock + '.' + randomUUID();
    await mkdir(staging);
    try {
      await mkdir(join(staging, owner));
      // Publish a nonempty lock atomically: there is no ownerless creation window.
      await rename(staging, lock);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      const owners = await readdir(lock).catch(readError => { if (readError.code === 'ENOENT') return []; throw readError; });
      if (!owners.length) { if (Date.now() - start > 1000) throw error; await delay(intervalMs); continue; }
      for (const oldOwner of owners) {
        const match = /^owner-(\d+)-[0-9a-f-]+$/.exec(oldOwner);
        if (!match) throw new Error('发现旧版或损坏的安装锁。确认没有安装进程后，请删除.doctor-setup-lock再启动。');
        let dead = false;
        try { process.kill(Number(match[1]), 0); } catch (probeError) { dead = probeError.code === 'ESRCH'; }
        if (dead) {
          // Only the waiter that removes this unique marker may remove the parent.
          // Another waiter can never recursively delete a newly acquired lock.
          try { await rmdir(join(lock, oldOwner)); await rmdir(lock); } catch {}
        }
      }
      if (Date.now() - start >= waitMs) throw new Error('等待其他启动器安装依赖超时。确认其他安装已退出后，删除项目中的.doctor-setup-lock再启动。');
      await delay(intervalMs);
      continue;
    }
    return async () => { try { await rmdir(join(lock, owner)); await rmdir(lock); } catch {} };
  }
}

export async function ensureDependencies(directory = root, { ready = dependenciesReady, npm = findNpm, run = runNode, pause = delay } = {}) {
  // A bundled, healthy installation also works from a read-only directory.
  if (await ready(directory)) return 0;
  const unlock = await dependencyLock(directory);
  try {
    if (await ready(directory)) return 0;
    const npmPath = await npm();
    if (!npmPath) { log('当前Node.js缺少npm，将自动安装包含npm的运行环境。'); return NEED_RUNTIME; }
    if (await run([npmPath, '--version'], { cwd: directory, timeout: 30000, stdio: 'ignore' }) !== 0) {
      log('当前npm无法运行，将自动安装包含npm的运行环境。'); return NEED_RUNTIME;
    }
    log('正在自动补齐或修复项目依赖……');
    const common = [npmPath, 'ci', '--ignore-scripts', '--no-fund', '--no-audit', '--fetch-retries=1', '--fetch-timeout=30000'];
    const childEnv = { ...process.env, PATH: dirname(process.execPath) + delimiter + (process.env.PATH || '') };
    for (let attempt = 0; attempt < 3; attempt++) {
      log(`安装依赖，第${attempt + 1}/3次尝试。`);
      const args = [...common, ...(attempt ? ['--registry=https://registry.npmjs.org/'] : [])];
      const code = await run(args, { cwd: directory, env: childEnv, timeout: 600000 });
      if (code === 0 && await ready(directory)) { log('依赖已就绪，继续启动。'); return 0; }
      if (attempt < 2) await pause(1000 * (attempt + 1));
    }
    throw new Error('依赖自动安装仍未成功。请查看上方npm错误，恢复网络/代理或项目目录写入权限后重新启动；启动器会自动重试。');
  } finally { await unlock(); }
}

async function main() {
  const args = process.argv.slice(2);
  const code = await ensureDependencies();
  if (code !== 0) return code;
  // Keep the application in the selected runtime: background maintenance records this stable path.
  process.argv = [process.execPath, join(root, 'src', 'cli.mjs'), ...(args.length ? args : ['menu'])];
  await import('../src/cli.mjs');
  return process.exitCode || 0;
}
const entryPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => process.argv[1]) : null;
if (entryPath && pathToFileURL(entryPath).href === import.meta.url) {
  main().then(code => { process.exitCode = code; }).catch(error => { log(error.message); process.exitCode = 1; });
}
