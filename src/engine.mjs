import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultHome, loadConfig, readOptionalJson, readJson, stateDir, hash, saveJson } from './config.mjs';
import { discoverBinaries, loadCatalog } from './binaries.mjs';
import { diagnose } from './probe.mjs';
import { createPlan, applyPlan, status, rollback, recover, settingsHash, isDetached } from './patch.mjs';
import { verify, validateActive } from './verify.mjs';

const defaults = { discover: discoverBinaries, catalog: loadCatalog, diagnose, verify };
export async function execute(command, options = {}, progress = () => {}, overrides = {}) {
  const deps = { ...defaults, ...overrides };
  const home = options.home || defaultHome(), directory = stateDir(home, options.profile);
  if (command === 'rollback') return rollback(home, options);
  if (command === 'recover') return recover(home, options);
  if (command === 'status') return status(home, options);
  const context = await loadConfig(home, options);
  const probeOptions = { repeats: Number(options.repeats || 2), timeout: Number(options.timeout || 30) * 1000, progress };
  if (command === 'diagnose') return deps.diagnose(context, probeOptions);
  const active = await readOptionalJson(join(directory, 'active.json'));
  const discoveryBinary = options.binary || (active?.binaries?.[0]?.source === 'explicit' ? active.binaries[0].path : undefined);
  let binaries;
  try { binaries = await deps.discover(discoveryBinary); }
  catch (error) {
    if (command !== 'inspect') throw error;
    return { home: context.home, profile: context.profile, patch: await status(home, options), binaries: [], discoveryError: error.message, bundledModel: null, report: await readOptionalJson(join(directory, 'last-report.json')), plan: await readOptionalJson(join(directory, 'last-plan.json')) };
  }
  let target = binaries[0];
  // Automatic maintenance follows the same installation channel, not an unrelated CLI.
  if (!options.binary && active?.binaries?.[0]?.source && active.binaries[0].source !== 'explicit') {
    target = binaries.find(b => b.source === active.binaries[0].source);
    if (!target) throw new Error('未找到原补丁对应的安装渠道，请用--binary选择目标程序。');
  }
  if (command === 'inspect') {
    let bundledModel = null, capabilityError;
    try { const catalog = await deps.catalog(target.path, home); const model = catalog.models.find(m => m.slug === context.config.model); bundledModel = model ? { slug: model.slug, use_responses_lite: model.use_responses_lite, tool_mode: model.tool_mode } : null; }
    catch (error) { capabilityError = error.message; }
    const patch = await status(home, options);
    const binaryChanged = Boolean(active && !active.binaries.some(b => b.sha256 === target.sha256 && b.path === target.path));
    if (binaryChanged && patch.state === 'verified') patch.state = 'maintenance-required';
    return { home: context.home, profile: context.profile, patch, binaries, target: target.path, binaryChanged, bundledModel, capabilityError, report: await readOptionalJson(join(directory, 'last-report.json')), plan: await readOptionalJson(join(directory, 'last-plan.json')), maintenance: await readOptionalJson(join(directory, 'last-maintenance.json')) };
  }
  if (command === 'verify') {
    if (!options.catalog && active) await validateActive(context, [target]);
    return deps.verify(context, [target], { progress, catalogPath: options.catalog });
  }
  if (command === 'plan') return createPlan(context, await readJson(join(directory, 'last-report.json')), [target], { load: deps.catalog });
  const apply = async plan => {
    if (plan.binaries?.length !== 1 || plan.binaries[0].path !== target.path || plan.binaries[0].sha256 !== target.sha256) throw new Error('当前选择的Codex程序与计划中的路径或构建不匹配，请重新生成计划。');
    const fresh = await loadConfig(home, options);
    if (fresh.contextHash !== plan.contextHash) throw new Error('配置在生成计划后发生变化，请重新生成。');
    progress('先验证候选配置，两轮成功后再安装。');
    const verification = await deps.verify(fresh, plan.binaries, { progress, catalogPath: plan.catalogPath, rounds: 2 });
    if (!verification.passed) throw new Error(`候选终端验证未通过[${verification.results?.find(r => !r.passed)?.failureKind || 'verification-failed'}]；当前配置未修改。请查看last-verification.json。`);
    const applied = await applyPlan(home, plan, { discover: deps.discover });
    return { ...applied, verification };
  };
  if (command === 'apply') return apply(await readJson(join(directory, 'last-plan.json')));
  if (command === 'repair') {
    if (active) return execute('maintain', { ...options, recheck: true }, progress, overrides);
    const report = await deps.diagnose(context, probeOptions);
    const plan = await createPlan(await loadConfig(home, options), report, [target], { load: deps.catalog });
    return apply(plan);
  }
  if (command === 'maintain') {
    if (!active) return { state: 'unpatched', changed: false, message: '尚未安装补丁；维护不会自动修改未管理的配置。' };
    const current = await status(home, options);
    if ((!current.managedBlockIntact && !isDetached(context)) || current.pendingTransaction) throw new Error('管理区块冲突或存在未完成事务，请先处理或recover。');
    const oldCatalog = await readFile(active.catalogPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (oldCatalog && hash(oldCatalog) !== active.catalogHash) throw new Error('模型目录被手动编辑，维护已停止以保留修改。');
    const bundled = await deps.catalog(target.path, home);
    const reasons = [];
    if (isDetached(context)) reasons.push('managed-override-removed');
    if (!active.binaries.some(b => b.sha256 === target.sha256 && b.path === target.path)) reasons.push('binary-changed');
    if (hash(JSON.stringify(bundled)) !== active.bundledCatalogHash) reasons.push('bundled-catalog-changed');
    if (settingsHash(context) !== active.settingsHash) reasons.push('settings-changed');
    if (!oldCatalog) reasons.push('catalog-missing');
    if (!reasons.length && !options.recheck) return { state: 'healthy', changed: false, message: '程序、配置和模型目录均未改变，沿用已验证补丁；未发送API请求。' };
    const model = bundled.models.find(m => m.slug === context.config.model);
    const retire = async () => {
      // Upstream already defaults to full Responses. Test it before retiring the override.
      const nativePath = join(directory, 'native-candidates', `${randomUUID()}.json`);
      const catalogHash = hash(JSON.stringify(bundled, null, 2) + '\n');
      await saveJson(nativePath, bundled);
      const verified = await deps.verify(context, [target], { progress, catalogPath: nativePath, rounds: 2 });
      if (!verified.passed) throw new Error('新版原生配置未通过终端验证，保留当前补丁。');
      await rollback(home, options, { discover: deps.discover, retirement: {
        activeId: active.id, contextHash: context.contextHash, binary: target, discoveryBinary,
        catalogPath: nativePath, catalogHash, receiptHash: hash(JSON.stringify(verified)),
      } });
      const result = { state: 'native-supported', changed: true, reasons, message: '当前原生配置已通过终端验证，已移除不再需要的目录覆盖。' };
      await saveJson(join(directory, 'last-maintenance.json'), { ...result, createdAt: new Date().toISOString() });
      return result;
    };
    if (model?.use_responses_lite === false) return retire();
    progress(`维护触发：${reasons.join(', ') || '主动复检'}。重新检测服务并基于当前构建重建目录。`);
    const report = await deps.diagnose(context, probeOptions);
    if (report.samples.length >= 8 && report.samples.every(sample => sample.result === 'pass')) return retire();
    const plan = await createPlan(await loadConfig(home, options), report, [target], { load: deps.catalog, refresh: true });
    const applied = await apply(plan);
    const result = { state: 'refreshed', changed: true, reasons, id: applied.id, backupPath: applied.backupPath, verification: applied.verification };
    await saveJson(join(directory, 'last-maintenance.json'), { ...result, createdAt: new Date().toISOString() });
    return result;
  }
  throw new Error(`未知命令：${command}。`);
}
