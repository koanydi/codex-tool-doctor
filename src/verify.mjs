import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify } from 'smol-toml';
import { runProcess } from './process.mjs';
import { atomicWrite, hash, readJson, saveJson, stateDir, sanitize, requestAuth } from './config.mjs';
import { loadCatalog } from './binaries.mjs';

function mentionsDirectory(text, directory, windows) {
  const normalize = value => windows ? value.replaceAll('\\', '/').toLowerCase() : value;
  const escaped = normalize(directory).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('(^|[\\s"\'`(\\[{])' + escaped + '(?=$|[\\s"\'`)\\]},;])', 'u');
  return pattern.test(normalize(text));
}

export function checkExecution(events, cwd, platform = process.platform, marker) {
  const completed = events.flatMap((e, index) => e.type === 'item.completed' ? [{ item: e.item, index }] : []);
  const commands = completed.filter(({ item }) => item?.type === 'command_execution');
  const windows = platform === 'win32';
  const commandPattern = windows
    ? /^(?:Get-Location|(?:"[^"\r\n]*[\\/]pwsh(?:\.exe)?"|'[^'\r\n]*[\\/]pwsh(?:\.exe)?'|(?:[^\s"']*[\\/])?pwsh(?:\.exe)?)\s+(?:-NoProfile\s+)?-Command\s+(?:Get-Location|'Get-Location'|"Get-Location"))\s*$/i
    : /^(?:pwd|(?:\S+\/)?(?:bash|sh|zsh)\s+-l?c\s+(?:pwd|'pwd'|"pwd"))\s*$/;
  const outputDirectory = i => {
    const lines = (i.aggregated_output || '').split(/\r?\n/).map(s => s.trim());
    return lines.find(line => windows ? line.replaceAll('\\', '/').toLowerCase() === cwd.replaceAll('\\', '/').toLowerCase() : line === cwd);
  };
  const valid = commands.filter(({ item: i }) => i.exit_code === 0 && (!i.status || i.status === 'completed') && commandPattern.test(i.command || '') && outputDirectory(i));
  const forbidden = events.some(e => e.item && ['mcp_tool_call', 'web_search', 'file_change'].includes(e.item.type));
  const turnIndex = events.findIndex(e => e.type === 'turn.completed');
  // Markerless callers only check terminal execution; verify always supplies a fresh marker.
  const acknowledged = !marker || valid.length === 1 && completed.some(({ item: i, index }) => index > valid[0].index && index < turnIndex && i?.type === 'agent_message' && (i.text || '').includes(marker) && mentionsDirectory(i.text, outputDirectory(valid[0].item), windows));
  return { passed: commands.length === 1 && valid.length === 1 && valid[0].index < turnIndex && !forbidden && acknowledged && !events.some(e => ['turn.failed', 'error'].includes(e.type)), commands: commands.map(({ item: i }) => ({ command: i.command, exitCode: i.exit_code, status: i.status })), acknowledged };
}
export async function verify(context, binaries, { timeout = 90000, rounds = 2, progress = () => {}, catalogPath, run = runProcess } = {}) {
  if (!binaries.length || !Number.isInteger(rounds) || rounds < 1) throw new Error('验证需要目标程序和有效轮数。');
  if (context.providerId === 'openai' && Object.keys(context.config.model_providers?.openai || {}).length) throw new Error('本工具无法确认model_providers.openai覆盖与Codex实际配置一致，已拒绝继续。请改用自定义model_provider名称；仅更改内置服务地址请使用openai_base_url。');
  const { key, secrets } = await requestAuth(context);
  const accountAuth = !context.provider.env_key && !context.provider.experimental_bearer_token && (context.provider.requires_openai_auth === true || context.providerId === 'openai' && context.provider.requires_openai_auth !== false);
  const directory = stateDir(context.home, context.profile);
  await mkdir(directory, { recursive: true });
  const isolated = await mkdtemp(join(directory, 'verification-'));
  const cwd = resolve(join(isolated, 'workspace'));
  const results = [];
  const effectiveCatalog = catalogPath || context.config.model_catalog_json;
  try {
    const config = {
      model: context.config.model, model_provider: context.providerId,
      ...(context.providerId === 'openai' ? { openai_base_url: context.provider.base_url } : { model_providers: { [context.providerId]: { ...context.provider, name: context.provider.name || context.providerId } } }),
      approval_policy: 'never', sandbox_mode: 'read-only', model_reasoning_effort: 'low',
      cli_auth_credentials_store: 'file',
      ...(effectiveCatalog ? { model_catalog_json: resolve(effectiveCatalog) } : {}),
    };
    await atomicWrite(join(isolated, 'config.toml'), stringify(config));
    if (accountAuth && key) await saveJson(join(isolated, 'auth.json'), { OPENAI_API_KEY: key });
    await atomicWrite(join(cwd, 'AGENTS.md'), 'This is an isolated terminal verification. Only execute the requested read-only directory command once. Do not call other tools, edit files, delegate, or browse.\n');
    for (const binary of binaries) {
      for (let round = 1; round <= rounds; round++) {
        progress(`验证终端第${round}/${rounds}轮：${binary.path}`);
        const events = [], marker = `VERIFIED_${randomUUID().replaceAll('-', '')}`;
        const args = [
          'exec', '--ephemeral', '--skip-git-repo-check', '--json', '-s', 'read-only', '-C', cwd,
          '-c', 'features.plugins=false', '-c', 'features.remote_plugin=false', '-c', 'service_tier="default"',
          `Run ${process.platform === 'win32' ? 'Get-Location exactly once in PowerShell 7 (use shell pwsh; do not nest another shell)' : 'pwd exactly once'} using the terminal tool. After the command completes successfully, report the actual working directory from its tool output and ${marker} together in the same reply. Do not guess the directory or acknowledge before receiving the result. Do not edit files, invoke other tools, or delegate.`,
        ];
        const result = await run(binary.path, args, { cwd, timeout, env: { ...process.env, CODEX_HOME: isolated }, onEvent: event => events.push(event) });
        const checked = checkExecution(events, cwd, process.platform, marker);
        const passed = result.code === 0 && !result.timedOut && !result.overflow && checked.passed;
        const failureKind = passed ? null : result.timedOut ? 'timeout' : /blocked by policy|sandbox.*(?:fail|error)|permission denied|access.*denied/i.test(result.stderr || '') ? 'permission-blocked' : !checked.commands.length ? 'no-terminal-event' : !checked.acknowledged ? 'tool-result-not-acknowledged' : 'terminal-verification-failed';
        results.push({ binary: binary.path, sha256: binary.sha256, round, passed, failureKind, timedOut: result.timedOut, processExit: result.code, commands: checked.commands, acknowledged: checked.acknowledged, ...(!passed ? { detail: sanitize((result.stderr || '').slice(-2000), secrets), failure: sanitize(JSON.stringify(events.filter(e => ['error', 'turn.failed'].includes(e.type))).slice(0, 2000), secrets) } : {}) });
        progress(`  ${passed ? '通过' : '失败'}`);
        if (!passed) break;
      }
      if (results.at(-1)?.passed === false) break;
    }
    const report = { createdAt: new Date().toISOString(), model: context.config.model, endpointHash: hash(context.endpoint), contextHash: context.contextHash, candidateCatalog: effectiveCatalog ? resolve(effectiveCatalog) : null, catalogHash: effectiveCatalog ? hash(await readFile(effectiveCatalog)) : null, rounds, passed: results.length === binaries.length * rounds && results.every(r => r.passed), results };
    await saveJson(join(stateDir(context.home, context.profile), 'last-verification.json'), report);
    return report;
  } finally { await rm(isolated, { recursive: true, force: true }); }
}
export async function validateActive(context, binaries) {
  const active = await readJson(join(stateDir(context.home, context.profile), 'active.json'));
  if (!context.raw.includes(active.block) || resolve(context.config.model_catalog_json || '.') !== resolve(active.catalogPath)) throw new Error('config.toml中已不再选用本工具管理的补丁。');
  if (hash(await readFile(active.catalogPath)) !== active.catalogHash) throw new Error('生效中的模型目录文件已被修改。');
  if (context.config.model !== active.model || hash(context.endpoint) !== active.endpointHash) throw new Error('模型或服务地址已改变，请运行maintain重新验证。');
  for (const binary of binaries) {
    if (!active.binaries.some(b => b.path === binary.path && b.sha256 === binary.sha256)) throw new Error('Codex程序发生变化，请运行maintain重新生成目录。');
    const catalog = await loadCatalog(binary.path, context.home, active.catalogPath);
    if (catalog.models.find(m => m.slug === active.model)?.use_responses_lite !== false) throw new Error('后端未加载协议配置覆盖。');
  }
  return active;
}
