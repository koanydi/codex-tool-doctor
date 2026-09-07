import { readdir, readFile, access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, posix } from 'node:path';
import { homedir } from 'node:os';
import { hash } from './config.mjs';
import { runProcess, runJson } from './process.mjs';

const VERIFIED_BUILDS = new Set([
  'e5aa76d19c7c94e2e9ef9b707d590206a73ac0e97c8ddc8382181242494bef75',
  '444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b',
]);

export function posixCandidates(env = process.env, userHome = homedir()) {
  return [...new Set([
    ...(env.PATH || '').split(':').filter(Boolean).map(directory => posix.join(directory, 'codex')),
    posix.join(userHome, '.local', 'bin', 'codex'),
    posix.join(userHome, '.npm-global', 'bin', 'codex'),
  ])];
}

export async function discoverBinaries(explicit) {
  const paths = [];
  if (explicit) paths.push(resolve(explicit));
  if (process.platform === 'win32') {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const roaming = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  const base = join(local, 'OpenAI', 'Codex', 'bin');
  for (const entry of await readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) paths.push(join(base, entry.name, 'codex.exe'));
  }
  paths.push(join(roaming, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'));
  } else paths.push(...posixCandidates());
  const found = [];
  for (const path of [...new Set(paths)]) {
    if (!(await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK).then(() => true, () => false))) {
      if (explicit && path === resolve(explicit)) throw new Error('指定的 Codex 程序不存在或不可执行。');
      continue;
    }
    const executable = process.platform === 'win32' ? path : await realpath(path);
    if (found.some(item => item.path === executable)) continue;
    const sha256 = hash(await readFile(executable));
    const version = await runProcess(executable, ['--version']);
    if (version.code !== 0 || version.timedOut) throw new Error(`无法读取 Codex 版本：${executable}`);
    found.push({ path: executable, sha256, version: version.stdout.trim(), supported: VERIFIED_BUILDS.has(sha256) });
  }
  if (!found.length) throw new Error('未找到 Codex 程序，请用 --binary 指定可执行文件路径。');
  return found;
}

export async function loadCatalog(binary, home, file) {
  const args = file ? ['-c', `model_catalog_json=${JSON.stringify(file)}`, 'debug', 'models'] : ['debug', 'models', '--bundled'];
  const catalog = await runJson(binary, args, { env: { ...process.env, CODEX_HOME: home } });
  if (!Array.isArray(catalog.models)) throw new Error('此版本的模型目录格式不受支持。');
  return catalog;
}
