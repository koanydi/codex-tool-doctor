import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runProcess } from './process.mjs';
import { hash, readJson, saveJson, stateDir } from './config.mjs';
import { loadCatalog } from './binaries.mjs';

export function checkExecution(events, cwd, platform = process.platform) {
  const completed = events.filter(e => e.type === 'item.completed').map(e => e.item);
  const commands = completed.filter(i => i?.type === 'command_execution');
  const windows = platform === 'win32';
  const commandPattern = windows ? /(?:^|\s-Command\s+)["']?Get-Location["']?\s*$/i : /^(?:pwd|(?:\S+\/)?(?:bash|sh|zsh)\s+-l?c\s+(?:pwd|'pwd'|"pwd"))\s*$/;
  const valid = commands.filter(i => {
    const output = i.aggregated_output || '';
    const hasDirectory = windows ? output.toLowerCase().includes(cwd.toLowerCase()) : output.split(/\r?\n/).includes(cwd);
    return i.exit_code === 0 && commandPattern.test(i.command || '') && hasDirectory;
  });
  return { passed: commands.length === 1 && valid.length === 1 && events.some(e => e.type === 'turn.completed'), commands: commands.map(i => ({ command: i.command, exitCode: i.exit_code, status: i.status })) };
}

export async function verify(context, binaries, { timeout = 90000, progress = () => {}, catalogPath } = {}) {
  const cwd = resolve(join(stateDir(context.home), 'verification-workspace'));
  await mkdir(cwd, { recursive: true });
  const results = [];
  for (const binary of binaries) {
    progress(`验证终端：${binary.path}`);
    const events = [];
    const args = [
      'exec', '--ephemeral', '--skip-git-repo-check', '--json', '-s', 'read-only', '-C', cwd,
      ...(catalogPath ? ['-c', `model_catalog_json=${JSON.stringify(resolve(catalogPath))}`] : []),
      '-c', 'features.plugins=false', '-c', 'features.remote_plugin=false',
      '-c', 'model_reasoning_effort="low"', '-c', 'service_tier="default"',
      '-c', `model_providers.${context.providerId}.request_max_retries=0`,
      `Run ${process.platform === 'win32' ? 'Get-Location' : 'pwd'} exactly once using the terminal tool, then report its output. Do not edit files, invoke other tools, or delegate.`,
    ];
    const result = await runProcess(binary.path, args, { cwd, timeout, env: { ...process.env, CODEX_HOME: context.home }, onEvent: event => events.push(event) });
    const checked = checkExecution(events, cwd);
    results.push({ binary: binary.path, sha256: binary.sha256, passed: result.code === 0 && !result.timedOut && checked.passed, timedOut: result.timedOut, processExit: result.code, commands: checked.commands });
    progress(`  ${results.at(-1).passed ? '通过' : '失败'}`);
    if (!results.at(-1).passed) break;
  }
  const report = { createdAt: new Date().toISOString(), model: context.config.model, candidateCatalog: catalogPath ? resolve(catalogPath) : null, passed: results.length === binaries.length && results.every(r => r.passed), results };
  await saveJson(join(stateDir(context.home), 'last-verification.json'), report);
  return report;
}

export async function validateActive(context, binaries) {
  const active = await readJson(join(stateDir(context.home), 'active.json'));
  if (!context.raw.includes(active.block) || context.config.model_catalog_json !== active.catalogPath.replaceAll('\\', '/')) throw new Error('config.toml 中已不再选用本工具管理的补丁。');
  if (hash(await readFile(active.catalogPath)) !== active.catalogHash) throw new Error('生效中的模型目录文件已被修改。');
  if (context.config.model !== active.model) throw new Error('当前模型已更换。请先回滚，再为新模型准备补丁。');
  for (const binary of binaries) {
    if (!binary.supported || !active.binaries.some(b => b.path === binary.path && b.sha256 === binary.sha256)) throw new Error('Codex 程序在应用补丁后发生变化，需要重新评估兼容性。');
    const catalog = await loadCatalog(binary.path, context.home, active.catalogPath);
    if (catalog.models.find(m => m.slug === active.model)?.use_responses_lite !== false) throw new Error('后端未加载协议配置覆盖。');
  }
  return active;
}
