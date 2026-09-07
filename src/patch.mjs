import { readFile, mkdir, open, unlink, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'smol-toml';
import { atomicWrite, hash, loadConfig, readJson, saveJson, stateDir } from './config.mjs';
import { discoverBinaries, loadCatalog } from './binaries.mjs';

const START = '# >>> codex-tool-doctor managed protocol patch';
const END = '# <<< codex-tool-doctor managed protocol patch';
const MAX_REPORT_AGE = 24 * 60 * 60 * 1000;

export function makePatchedCatalog(original, modelName) {
  const result = structuredClone(original);
  const model = result.models.find(m => m.slug === modelName);
  if (!model) throw new Error(`此构建的模型目录中没有 ${modelName}。`);
  if (model.use_responses_lite !== true) throw new Error('此模型已使用完整 Responses 协议，或缺少所需字段；该补丁不适用。');
  model.use_responses_lite = false;
  return result;
}

export function addBlock(raw, catalogPath, id) {
  const config = parse(raw);
  if (config.model_catalog_json !== undefined || raw.includes(START)) throw new Error('已有模型目录覆盖，请先回滚或检查现有配置。');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const block = [START, `# Plan: ${id}`, `model_catalog_json = ${JSON.stringify(catalogPath.replaceAll('\\', '/'))}`, END, ''].join(eol) + eol;
  const text = raw.startsWith('\uFEFF') ? '\uFEFF' + block + raw.slice(1) : block + raw;
  const parsed = parse(text);
  if (parsed.model_catalog_json !== catalogPath.replaceAll('\\', '/')) throw new Error('补丁配置校验失败。');
  return { text, block };
}

export function removeBlock(current, state, original) {
  if (hash(current) === state.patchedConfigHash) return original;
  if (!current.includes(state.block) || current.indexOf(state.block) !== current.lastIndexOf(state.block)) {
    throw new Error('补丁管理区块已被修改。为保留你的修改，自动回滚已停止。');
  }
  const result = current.replace(state.block, '');
  parse(result);
  return result;
}

async function withLock(home, callback) {
  const directory = stateDir(home);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'operation.lock');
  let lock;
  try { lock = await open(path, 'wx'); } catch { throw new Error('另一个补丁操作正在运行，或上次中断后留下了 operation.lock，请先检查。'); }
  try { return await callback(); } finally { await lock.close(); await unlink(path); }
}

export async function status(home) {
  const context = await loadConfig(home);
  const active = await readJson(join(stateDir(home), 'active.json')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  let catalogIntact = null;
  if (active) catalogIntact = hash(await readFile(active.catalogPath).catch(() => '')) === active.catalogHash;
  return {
    patched: Boolean(active), state: active?.status || 'unpatched', model: context.config.model,
    provider: context.providerId, endpoint: context.endpoint, catalogPath: context.config.model_catalog_json || null,
    patchId: active?.id || null, catalogIntact,
    modelCovered: active ? active.model === context.config.model : false,
    managedBlockIntact: active ? context.raw.includes(active.block) : null,
  };
}

export async function createPlan(context, report, binaries) {
  if (!report.summary.patchRecommended) throw new Error('检测结果不符合此修复方案的适用条件，未生成补丁。');
  if (Date.now() - Date.parse(report.createdAt) > MAX_REPORT_AGE || !Number.isFinite(Date.parse(report.createdAt))) throw new Error('检测报告已过期，请重新运行 diagnose。');
  if (report.configHash !== context.configHash || report.model !== context.config.model || report.endpoint !== context.endpoint) throw new Error('配置在检测后发生变化，请重新运行 diagnose。');
  if (binaries.some(b => !b.supported)) throw new Error('存在尚未验证的 Codex 构建，只允许检测，不自动打补丁。Linux 用户请参阅 docs/修改原理与Linux指南.md，先验证临时模型目录。');
  const existing = await status(context.home);
  if (existing.patched || context.config.model_catalog_json) throw new Error('已有生效的模型目录补丁或覆盖，请先查看状态或回滚。');
  const binary = binaries[0];
  const catalog = await loadCatalog(binary.path, context.home);
  const patched = makePatchedCatalog(catalog, context.config.model);
  const id = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
  const directory = join(stateDir(context.home), 'plans', id);
  const catalogPath = join(directory, 'models.json');
  const catalogText = JSON.stringify(patched, null, 2) + '\n';
  await atomicWrite(catalogPath, catalogText);
  // Have the real client parse the generated catalog before offering it as a patch.
  for (const installed of binaries) {
    const effective = await loadCatalog(installed.path, context.home, catalogPath);
    if (effective.models.find(m => m.slug === context.config.model)?.use_responses_lite !== false) throw new Error('Codex 未接受此协议配置覆盖。');
  }
  const { block, text } = addBlock(context.raw, catalogPath, id);
  const plan = {
    schema: 1, id, createdAt: new Date().toISOString(), home: context.home,
    configPath: context.configPath, configHash: context.configHash, model: context.config.model,
    provider: context.providerId, endpoint: context.endpoint, catalogPath,
    catalogHash: hash(catalogText), patchedConfigHash: hash(text), block,
    binaries, change: { field: 'use_responses_lite', from: true, to: false },
    report: { createdAt: report.createdAt, summary: report.summary },
  };
  await saveJson(join(directory, 'plan.json'), plan);
  await saveJson(join(directory, 'report.json'), report);
  await saveJson(join(stateDir(context.home), 'last-plan.json'), plan);
  return plan;
}

export async function applyPlan(home, plan) {
  return withLock(home, async () => {
    if (resolve(plan.home) !== resolve(home) || plan.schema !== 1) throw new Error('此计划属于其他配置目录或工具版本。');
    const context = await loadConfig(home);
    if (context.configHash !== plan.configHash) throw new Error('配置在生成计划后发生变化，请重新生成计划。');
    if (hash(await readFile(plan.catalogPath)) !== plan.catalogHash) throw new Error('计划中的模型目录文件已被修改。');
    const binaries = await discoverBinaries(plan.binaries[0].path);
    if (binaries.length !== plan.binaries.length || binaries.some(b => !plan.binaries.some(p => p.path === b.path && p.sha256 === b.sha256) || !b.supported)) {
      throw new Error('Codex 在生成计划后被安装或更新，请重新检测并生成计划。');
    }
    const { text, block } = addBlock(context.raw, plan.catalogPath, plan.id);
    if (hash(text) !== plan.patchedConfigHash || block !== plan.block) throw new Error('补丁计划完整性检查失败。');
    const backupPath = join(stateDir(home), 'backups', plan.id, 'config.toml');
    await mkdir(join(stateDir(home), 'backups', plan.id), { recursive: true });
    await copyFile(context.configPath, backupPath);
    if (hash(await readFile(backupPath)) !== context.configHash) throw new Error('备份校验失败，配置可能已经变化。');
    const active = { ...plan, backupPath, status: 'prepared', appliedAt: new Date().toISOString() };
    await saveJson(join(stateDir(home), 'active.json'), active);
    // Recheck after backup; never knowingly overwrite concurrent application edits.
    if (hash(await readFile(context.configPath)) !== context.configHash) {
      await unlink(join(stateDir(home), 'active.json'));
      throw new Error('准备备份期间配置发生变化，未写入补丁。');
    }
    await atomicWrite(context.configPath, text);
    active.status = 'applied';
    await saveJson(join(stateDir(home), 'active.json'), active);
    return active;
  });
}

export async function rollback(home) {
  return withLock(home, async () => {
    const activePath = join(stateDir(home), 'active.json');
    const active = await readJson(activePath);
    const original = await readFile(active.backupPath, 'utf8');
    if (hash(original) !== active.configHash) throw new Error('原始备份已被修改，自动回滚已停止。');
    const context = await loadConfig(home);
    const restored = hash(context.raw) === active.configHash ? context.raw : removeBlock(context.raw, active, original);
    if (hash(await readFile(context.configPath)) !== context.configHash) throw new Error('回滚期间配置发生变化，请等待应用保存完成后重试。');
    await atomicWrite(context.configPath, restored);
    await saveJson(join(stateDir(home), 'backups', active.id, 'rollback.json'), { id: active.id, rolledBackAt: new Date().toISOString(), preservedOtherEdits: restored !== original });
    await unlink(activePath);
    return { id: active.id, restored: true, preservedOtherEdits: restored !== original };
  });
}
