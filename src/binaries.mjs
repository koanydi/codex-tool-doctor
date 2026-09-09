import { readdir, readFile, access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, posix, dirname, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { hash } from './config.mjs';
import { runProcess, runJson } from './process.mjs';

export function posixCandidates(env = process.env, userHome = homedir()) {
  return [...new Set([...(env.PATH || '').split(':').filter(Boolean).map(directory => posix.join(directory, 'codex')), posix.join(userHome, '.local', 'bin', 'codex'), posix.join(userHome, '.npm-global', 'bin', 'codex')])];
}
export function macCandidates(userHome = homedir()) {
  return ['/Applications', posix.join(userHome, 'Applications')].flatMap(root => ['codex', 'bin/codex'].map(name => posix.join(root, 'Codex.app', 'Contents', 'Resources', name)));
}
async function nativeNpmCandidates(root) {
  const candidates = [];
  const roots = [root, join(root, 'node_modules', '@openai')];
  for (const parent of roots) {
    for (const entry of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !entry.name.startsWith('codex-')) continue;
      const vendor = join(parent, entry.name, 'vendor');
      for (const arch of await readdir(vendor).catch(() => [])) candidates.push(join(vendor, arch, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'));
    }
  }
  const vendor = join(root, 'vendor');
  for (const arch of await readdir(vendor).catch(() => [])) candidates.push(join(vendor, arch, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'));
  return candidates;
}
export async function discoverBinaries(explicit) {
  let paths = [];
  if (explicit) paths = [{ path: resolve(explicit), source: 'explicit' }];
  else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    const roaming = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    const base = join(local, 'OpenAI', 'Codex', 'bin');
    const installs = await Promise.all((await readdir(base, { withFileTypes: true }).catch(() => [])).filter(e => e.isDirectory()).map(async e => ({ path: join(base, e.name, 'codex.exe'), source: 'desktop', updated: (await stat(join(base, e.name))).mtimeMs })));
    paths.push(...installs.sort((a, b) => b.updated - a.updated));
    for (const root of [join(roaming, 'npm', 'node_modules', '@openai', 'codex'), join(dirname(process.execPath), 'node_modules', '@openai', 'codex')]) paths.push(...(await nativeNpmCandidates(root)).map(path => ({ path, source: 'npm' })));
    paths.push(...(process.env.PATH || '').split(delimiter).filter(Boolean).map(directory => ({ path: join(directory, 'codex.exe'), source: 'path' })));
  } else {
    if (process.platform === 'darwin') paths.push(...macCandidates().map(path => ({ path, source: 'desktop' })));
    paths.push(...posixCandidates().map(path => ({ path, source: 'path' })));
  }
  const found = [], seen = new Set();
  for (const candidate of paths) {
    const path = candidate.path;
    if (!(await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK).then(() => true, () => false))) {
      if (explicit) throw new Error('指定的Codex程序不存在或不可执行。');
      continue;
    }
    let executable = await realpath(path);
    // npm's POSIX symlink resolves to bin/codex.js. Prefer the native backend for a stable fingerprint.
    if (/\.m?js$/.test(executable)) {
      const native = await nativeNpmCandidates(dirname(dirname(executable)));
      executable = (await Promise.all(native.map(async p => await access(p, constants.X_OK).then(() => p, () => null)))).find(Boolean);
      if (!executable) { if (explicit) throw new Error('未找到npm安装对应的原生Codex后端。'); continue; }
    }
    if (seen.has(executable)) continue;
    seen.add(executable);
    try {
      const version = await runProcess(executable, ['--version']);
      if (version.code !== 0 || version.timedOut || !/codex/i.test(version.stdout)) throw new Error('无法读取Codex版本。');
      const sha256 = hash(await readFile(executable));
      found.push({ path: executable, sha256, version: version.stdout.trim(), source: candidate.source });
    } catch (error) { if (explicit) throw error; }
  }
  if (!found.length) throw new Error('未找到Codex程序，请用--binary指定原生可执行文件路径。');
  return found;
}
export async function loadCatalog(binary, home, file) {
  const args = file ? ['-c', `model_catalog_json=${JSON.stringify(file)}`, 'debug', 'models'] : ['debug', 'models', '--bundled'];
  const catalog = await runJson(binary, args, { env: { ...process.env, CODEX_HOME: home } });
  if (!Array.isArray(catalog.models) || !catalog.models.length) throw new Error('此版本未提供可用的debug models目录，不能使用目录补丁。');
  return catalog;
}
