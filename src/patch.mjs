import { readFile, mkdir, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, hash, loadConfig, parseConfig as parse, readJson, readOptionalJson, saveJson, stateDir } from './config.mjs';
import { discoverBinaries, loadCatalog } from './binaries.mjs';
import { summarize } from './probe.mjs';

const START = '# >>> codex-tool-doctor managed protocol patch';
const END = '# <<< codex-tool-doctor managed protocol patch';
const MAX_REPORT_AGE = 24 * 60 * 60 * 1000;
export function settingsHash(context) {
  const config = structuredClone(context.config);
  delete config.model_catalog_json;
  return hash(JSON.stringify(config));
}
export function isDetached(context) {
  return context.config.model_catalog_json === undefined && !context.raw.includes(START) && !context.raw.includes(END);
}
export function makePatchedCatalog(original, modelName) {
  const result = structuredClone(original);
  const matches = result.models?.filter(m => m.slug === modelName) || [];
  if (matches.length !== 1) throw new Error(`此构建需要唯一的${modelName}模型条目，当前找到${matches.length}个。`);
  if (matches[0].use_responses_lite !== true) throw new Error('此模型已使用完整Responses协议，或缺少所需字段；该补丁不适用。');
  matches[0].use_responses_lite = false;
  return result;
}
export function addBlock(raw, catalogPath, id) {
  const config = parse(raw);
  if (config.model_catalog_json !== undefined || raw.includes(START)) throw new Error('已有模型目录覆盖，请先回滚或检查现有配置。');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const block = [START, `# Plan: ${id}`, `model_catalog_json = ${JSON.stringify(catalogPath.replaceAll('\\', '/'))}`, END, ''].join(eol) + eol;
  const text = raw.startsWith('\uFEFF') ? '\uFEFF' + block + raw.slice(1) : block + raw;
  if (parse(text).model_catalog_json !== catalogPath.replaceAll('\\', '/')) throw new Error('补丁配置校验失败。');
  return { text, block };
}
export function removeBlock(current, state, original) {
  if (hash(current) === state.patchedConfigHash) return original;
  if (!current.includes(state.block) || current.indexOf(state.block) !== current.lastIndexOf(state.block)) throw new Error('补丁管理区块已被修改。为保留你的修改，自动回滚已停止。');
  const result = current.replace(state.block, '');
  parse(result);
  return result;
}
export async function withLock(home, options, callback) {
  const directory = stateDir(home, options?.profile);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'operation.lock');
  let lock;
  try { lock = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('另一个操作正在运行，或中断后留下了operation.lock。可运行recover检查并恢复，不能同时执行两个修复。');
  }
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); return await callback(); }
  finally { await lock.close(); await unlink(path); }
}
function optionsFor(plan) { return { profile: plan.profile, allowInsecureHttp: plan.allowInsecureHttp }; }
function ensurePlanScope(home, plan) {
  if (resolve(plan.home) !== resolve(home) || plan.schema !== 2 || !/^[\w.-]+$/.test(plan.id)) throw new Error('此计划属于其他配置目录或旧工具版本，请重新生成。');
  const directory = stateDir(home, plan.profile);
  if (resolve(plan.catalogPath) !== resolve(join(directory, 'plans', plan.id, 'models.json'))) throw new Error('计划中的模型目录路径不合法。');
  const configPath = join(resolve(home), plan.profile ? `${plan.profile}.config.toml` : 'config.toml');
  if (resolve(plan.configPath) !== configPath) throw new Error('计划的配置路径与配置目录不匹配。');
}
export async function status(home, options = {}) {
  const directory = stateDir(home, options.profile);
  const active = await readOptionalJson(join(directory, 'active.json'));
  const pending = await readOptionalJson(join(directory, 'transaction.json'));
  const context = await loadConfig(home, { ...options, allowInsecureHttp: options.allowInsecureHttp || active?.allowInsecureHttp });
  const catalogIntact = active ? hash(await readFile(active.catalogPath).catch(() => '')) === active.catalogHash : null;
  const managedBlockIntact = active ? context.raw.includes(active.block) && context.raw.indexOf(active.block) === context.raw.lastIndexOf(active.block) && resolve(context.config.model_catalog_json || '.') === resolve(active.catalogPath) : null;
  const modelCovered = active ? active.model === context.config.model : false;
  const endpointCovered = active ? active.endpointHash === hash(context.endpoint) : false;
  return { patched: Boolean(active), state: pending ? 'recovery-required' : !active ? 'unpatched' : isDetached(context) ? 'maintenance-required' : (!catalogIntact || !managedBlockIntact) ? 'conflict' : (!modelCovered || !endpointCovered) ? 'maintenance-required' : active.status,
    model: context.config.model, provider: context.providerId, endpoint: context.displayEndpoint, profile: context.profile, catalogPath: context.config.model_catalog_json || null,
    patchId: active?.id || null, catalogIntact, modelCovered, endpointCovered, managedBlockIntact, verifiedAt: active?.verification?.createdAt || null, pendingTransaction: Boolean(pending) };
}
export async function createPlan(context, report, binaries, { load = loadCatalog, refresh = false } = {}) {
  const summary = summarize(report.samples || []);
  if (!summary.patchRecommended) throw new Error(`未生成补丁：${summary.blockers.map(b => `[${b.code}] ${b.message}`).join('；')}`);
  const age = Date.now() - Date.parse(report.createdAt);
  if (!Number.isFinite(age) || age < -60_000 || age > MAX_REPORT_AGE) throw new Error('检测报告已过期或时间无效，请重新运行diagnose。');
  if (report.configHash !== context.configHash || report.contextHash !== context.contextHash || report.model !== context.config.model || report.endpointHash !== hash(context.endpoint)) throw new Error('配置在检测后发生变化，请重新运行diagnose。');
  if (binaries.length !== 1) throw new Error('每个补丁只管理一个目标程序。请用--binary或图形界面选择，避免混用不同版本的模型目录。');
  const previous = await readOptionalJson(join(context.directory, 'active.json'));
  let originalRaw = context.raw;
  if (previous) {
    if (!refresh) throw new Error('已有生效补丁，请运行maintain更新或先回滚。');
    const oldCatalog = await readFile(previous.catalogPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (oldCatalog && hash(oldCatalog) !== previous.catalogHash) throw new Error('生效目录已被手动修改，不能自动更新。');
    const backup = await readFile(previous.backupPath, 'utf8');
    if (hash(backup) !== previous.originalConfigHash && hash(backup) !== previous.configHash) throw new Error('原始备份已被修改，不能自动更新。');
    originalRaw = isDetached(context) ? context.raw : removeBlock(context.raw, previous, backup);
  } else if (context.config.model_catalog_json) throw new Error('已有用户自定义模型目录，不能覆盖。');
  // Validate the selected executable's catalog capabilities before creating a plan.
  const catalog = await load(binaries[0].path, context.home);
  const patched = makePatchedCatalog(catalog, context.config.model);
  const id = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
  const directory = join(context.directory, 'plans', id), catalogPath = join(directory, 'models.json');
  const catalogText = JSON.stringify(patched, null, 2) + '\n';
  await atomicWrite(catalogPath, catalogText);
  const effective = await load(binaries[0].path, context.home, catalogPath);
  if (effective.models.find(m => m.slug === context.config.model)?.use_responses_lite !== false) throw new Error('目标Codex未接受候选目录；不会安装补丁。');
  const { block, text } = addBlock(originalRaw, catalogPath, id);
  const plan = {
    schema: 2, id, createdAt: new Date().toISOString(), home: context.home, profile: context.profile, allowInsecureHttp: context.options.allowInsecureHttp,
    configPath: context.configPath, configHash: context.configHash, contextHash: context.contextHash, settingsHash: settingsHash(context), originalConfigHash: hash(originalRaw), model: context.config.model,
    provider: context.providerId, endpoint: context.displayEndpoint, endpointHash: hash(context.endpoint), catalogPath, bundledCatalogHash: hash(JSON.stringify(catalog)),
    catalogHash: hash(catalogText), patchedConfigHash: hash(text), block, previousId: previous?.id || null,
    binaries, change: { field: 'use_responses_lite', from: true, to: false }, verificationRequired: true,
    report: { createdAt: report.createdAt, summary },
  };
  await atomicWrite(join(directory, 'original.toml'), originalRaw);
  await saveJson(join(directory, 'plan.json'), plan);
  await saveJson(join(directory, 'report.json'), report);
  await saveJson(join(context.directory, 'last-plan.json'), plan);
  return plan;
}
export async function applyPlan(home, plan, { discover = discoverBinaries } = {}) {
  ensurePlanScope(home, plan);
  return withLock(home, optionsFor(plan), async () => {
    const directory = stateDir(home, plan.profile), activePath = join(directory, 'active.json');
    if (await readOptionalJson(join(directory, 'transaction.json'))) throw new Error('发现未完成事务，请先运行recover。');
    const context = await loadConfig(home, optionsFor(plan));
    if (context.configHash !== plan.configHash || context.contextHash !== plan.contextHash) throw new Error('配置在生成计划后发生变化，请重新生成计划。');
    if (hash(await readFile(plan.catalogPath)) !== plan.catalogHash) throw new Error('计划中的模型目录文件已被修改。');
    const binaries = await discover(plan.binaries[0].path);
    if (binaries.length !== 1 || binaries[0].sha256 !== plan.binaries[0].sha256 || binaries[0].path !== plan.binaries[0].path) throw new Error('Codex在生成计划后被更新，请重新检测并生成计划。');
    const verification = await readJson(join(directory, 'last-verification.json'));
    const age = Date.now() - Date.parse(verification.createdAt);
    if (!verification.passed || verification.rounds < 2 || !verification.results?.length || !verification.results.every(r => r.passed && r.sha256 === binaries[0].sha256) || verification.results.length !== verification.rounds || !Number.isFinite(age) || age < -60000 || age > 30 * 60 * 1000 || verification.contextHash !== context.contextHash || verification.catalogHash !== plan.catalogHash || verification.endpointHash !== plan.endpointHash || verification.model !== plan.model || resolve(verification.candidateCatalog || '.') !== resolve(plan.catalogPath)) throw new Error('缺少与当前计划匹配的两轮成功终端验证；请运行apply完成候选验证。');
    const previous = await readOptionalJson(activePath);
    if ((previous?.id || null) !== plan.previousId) throw new Error('生效补丁在计划生成后发生变化。');
    const original = await readFile(join(directory, 'plans', plan.id, 'original.toml'), 'utf8');
    if (hash(original) !== plan.originalConfigHash) throw new Error('计划中的原始配置已被修改。');
    const { text, block } = addBlock(original, plan.catalogPath, plan.id);
    if (hash(text) !== plan.patchedConfigHash || block !== plan.block) throw new Error('补丁计划完整性检查失败。');
    const backupPath = join(directory, 'backups', plan.id, 'config.toml');
    await atomicWrite(backupPath, original);
    const restorePath = join(directory, 'backups', plan.id, 'before-transaction.toml');
    await atomicWrite(restorePath, context.raw);
    const transaction = { schema: 1, id: plan.id, configPath: context.configPath, restorePath, beforeHash: context.configHash, afterHash: hash(text), previous };
    await saveJson(join(directory, 'transaction.json'), transaction);
    try {
      const fresh = await loadConfig(home, optionsFor(plan));
      if (fresh.contextHash !== context.contextHash) throw new Error('准备备份期间配置发生变化，未写入补丁。');
      await atomicWrite(context.configPath, text);
      const active = { ...plan, backupPath, status: 'verified', appliedAt: new Date().toISOString(), verification };
      await saveJson(activePath, active);
      await unlink(join(directory, 'transaction.json'));
      return active;
    } catch (error) {
      try { await recoverTransaction(home, optionsFor(plan)); }
      catch (recoveryError) { throw new Error(`${error.message}；事务恢复停止：${recoveryError.message}。备份：${restorePath}`); }
      throw error;
    }
  });
}
async function recoverTransaction(home, options) {
  const directory = stateDir(home, options.profile), path = join(directory, 'transaction.json');
  const transaction = await readOptionalJson(path);
  if (!transaction) return { recovered: false };
  const expectedConfig = resolve(home, options.profile ? `${options.profile}.config.toml` : 'config.toml');
  if (resolve(transaction.configPath) !== expectedConfig) throw new Error('事务配置路径不匹配。');
  const original = await readFile(transaction.restorePath, 'utf8');
  if (hash(original) !== transaction.beforeHash) throw new Error('事务备份校验失败。');
  const current = await readFile(expectedConfig, 'utf8');
  if (![transaction.beforeHash, transaction.afterHash].includes(hash(current))) throw new Error('中断后配置又被编辑，保留现场，请按文档手动恢复。');
  await atomicWrite(expectedConfig, original);
  if (transaction.previous) await saveJson(join(directory, 'active.json'), transaction.previous);
  else await unlink(join(directory, 'active.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await unlink(path);
  return { recovered: true, id: transaction.id };
}
export async function recover(home, options = {}) {
  const lockPath = join(stateDir(home, options.profile), 'operation.lock');
  const lock = await readOptionalJson(lockPath);
  if (lock) {
    if (!Number.isInteger(lock.pid) || lock.pid < 1) throw new Error('锁文件无效，请手动确认没有运行中的修复进程。');
    try { process.kill(lock.pid, 0); throw new Error('持锁进程仍在运行，请等待其完成。'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await unlink(lockPath);
  }
  return withLock(home, options, () => recoverTransaction(home, options));
}
async function validateRetirement(home, options, expected, discover) {
  // Rediscover the same explicit target or installation channel under the rollback lock.
  const binaries = await discover(expected.discoveryBinary);
  const binary = expected.discoveryBinary || !expected.binary.source ? binaries[0] : binaries.find(b => b.source === expected.binary.source);
  if (!binary || binary.path !== expected.binary.path || binary.sha256 !== expected.binary.sha256) throw new Error('Codex在原生验证后被更新，未移除补丁。');
  const directory = stateDir(home, options.profile);
  // Read these after discovery, which may take long enough for external edits to occur.
  const [active, context, receipt, catalog] = await Promise.all([
    readOptionalJson(join(directory, 'active.json')), loadConfig(home, options),
    readOptionalJson(join(directory, 'last-verification.json')), readFile(expected.catalogPath),
  ]);
  if (active?.id !== expected.activeId) throw new Error('生效补丁在原生验证后发生变化，未移除补丁。');
  if (context.contextHash !== expected.contextHash) throw new Error('原生验证期间配置改变，未移除补丁。');
  if (hash(catalog) !== expected.catalogHash) throw new Error('原生候选目录在验证后发生变化，未移除补丁。');
  const age = Date.now() - Date.parse(receipt?.createdAt);
  if (!receipt || hash(JSON.stringify(receipt)) !== expected.receiptHash || receipt.passed !== true || receipt.rounds !== 2 ||
      !Array.isArray(receipt.results) || receipt.results.length !== 2 ||
      !receipt.results.every((r, index) => r?.passed === true && r.binary === binary.path && r.sha256 === binary.sha256 && r.round === index + 1) ||
      !Number.isFinite(age) || age < -60000 || age > 30 * 60 * 1000 || receipt.contextHash !== context.contextHash ||
      receipt.endpointHash !== hash(context.endpoint) || receipt.model !== context.config.model || receipt.catalogHash !== expected.catalogHash ||
      typeof receipt.candidateCatalog !== 'string' || resolve(receipt.candidateCatalog) !== resolve(expected.catalogPath)) {
    throw new Error('缺少与当前原生候选匹配的两轮成功终端验证记录，未移除补丁。');
  }
}
export async function rollback(home, options = {}, { retirement, discover = discoverBinaries } = {}) {
  return withLock(home, options, async () => {
    const directory = stateDir(home, options.profile), activePath = join(directory, 'active.json');
    if (await readOptionalJson(join(directory, 'transaction.json'))) throw new Error('发现未完成事务，请先运行recover。');
    const active = await readJson(activePath);
    if (retirement && active.id !== retirement.activeId) throw new Error('生效补丁在原生验证后发生变化，未移除补丁。');
    const original = await readFile(active.backupPath, 'utf8');
    if (hash(original) !== (active.originalConfigHash || active.configHash)) throw new Error('原始备份已被修改，自动回滚已停止。');
    const configPath = join(resolve(home), options.profile ? `${options.profile}.config.toml` : 'config.toml');
    const raw = await readFile(configPath, 'utf8');
    const alreadyDetached = parse(raw).model_catalog_json === undefined && !raw.includes(START) && !raw.includes(END);
    const restored = hash(raw) === hash(original) || alreadyDetached ? raw : removeBlock(raw, active, original);
    if (retirement) await validateRetirement(home, options, retirement, discover);
    if (hash(await readFile(configPath)) !== hash(raw)) throw new Error('回滚期间配置发生变化，请重试。');
    await atomicWrite(configPath, restored);
    await saveJson(join(directory, 'backups', active.id, 'rollback.json'), { id: active.id, rolledBackAt: new Date().toISOString(), preservedOtherEdits: restored !== original });
    await unlink(activePath);
    return { id: active.id, restored: true, preservedOtherEdits: restored !== original };
  });
}
