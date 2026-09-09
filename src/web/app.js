const $ = id => document.getElementById(id);
const initialToken = location.hash.slice(1);
if (/^[a-f0-9]{64}$/.test(initialToken)) { sessionStorage.setItem('doctor-token', initialToken); history.replaceState(null, '', location.pathname); }
const token = sessionStorage.getItem('doctor-token') || '';
const names = { 'function-flat': '普通函数 · 平铺', 'custom-flat': '自定义工具 · 平铺', 'custom-namespace': '自定义工具 · 命名空间', 'custom-additional': 'additional_tools' };
const labels = { pass: '通过', 'no-tool': '未识别工具', 'unexpected-output': '结果不匹配', 'http-error': 'HTTP失败', 'network-error': '连接失败', 'parse-error': '解析失败', 'stream-error': '响应流异常' };
const states = { unpatched: '尚未安装', verified: '已验证并安装', applied: '待复验', prepared: '待恢复', conflict: '发现配置冲突', 'maintenance-required': '需要维护', 'recovery-required': '需要恢复事务' };
const selectionFields = ['home', 'profile', 'binary', 'insecure'];
const refreshCommands = new Set(['apply', 'maintain', 'repair', 'rollback', 'recover']);
let busy = false, lastReport = null, lastPlan = null, currentInfo = null, revision = 0, restoreSaved = true;
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
async function api(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'X-Doctor-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
function options() { return { home: $('home').value.trim(), profile: $('profile').value.trim(), binary: $('binary').value.trim(), repeats: Number($('repeats').value), timeout: Number($('timeout').value), allowInsecureHttp: $('insecure').checked }; }
function selectionKey() { const o = options(); return JSON.stringify([o.home, o.profile, o.binary, o.allowInsecureHttp]); }
let selection = selectionKey();
function healthy(report) { return Object.keys(names).every(kind => { const samples = report?.samples?.filter(s => s.kind === kind) || []; return samples.length >= 2 && samples.every(s => s.result === 'pass'); }); }
function reportMatches(report, info) {
  const age = Date.now() - Date.parse(report?.createdAt);
  return Boolean(report && info?.patch && report.model === info.patch.model && report.provider === info.patch.provider && report.endpoint === info.patch.endpoint && Number.isFinite(age) && age >= -60000 && age <= 86400000);
}
function planMatches(plan) {
  const target = currentInfo?.binaries?.find(b => b.path === currentInfo.target);
  return Boolean(plan && target && plan.home === currentInfo.home && (plan.profile || '') === (currentInfo.profile || '') && plan.model === currentInfo.patch.model && plan.binaries?.length === 1 && plan.binaries[0].path === target.path && plan.binaries[0].sha256 === target.sha256 && plan.contextHash === lastReport?.contextHash && plan.report?.createdAt === lastReport?.createdAt);
}
function prerequisite(command) {
  if (command !== 'plan' && command !== 'apply') return '';
  if (!currentInfo) return '请先读取配置或开始诊断。';
  if (currentInfo.patch.patched) return '已有受管补丁，请使用“检查升级并维护”或“一键检测并修复”。';
  if (!reportMatches(lastReport, currentInfo) || !lastReport.summary.patchRecommended) return healthy(lastReport) ? '本次检测全部通过，暂不需要此补丁。' : '请先开始诊断，确认存在可修复的协议差异。';
  if (!currentInfo.target || currentInfo.discoveryError || currentInfo.capabilityError) return '请先选择可用的目标Codex程序，并点击“读取此配置”确认模型目录能力。';
  if (command === 'apply' && !planMatches(lastPlan)) return '请先为当前配置与目标程序生成候选计划，再验证并安装。';
  return '';
}
function updateControls() {
  for (const button of document.querySelectorAll('[data-command]')) {
    const reason = prerequisite(button.dataset.command);
    button.disabled = busy || Boolean(reason);
    button.title = reason || (button.dataset.command === 'guard-install' ? '立即启动维护服务，并在以后登录时自动运行；检查变化时可能消耗API额度。' : '');
  }
  for (const id of [...selectionFields, 'repeats', 'timeout']) $(id).disabled = busy;
  $('download-report').disabled = busy || !lastReport;
  $('job-status').textContent = busy ? '进行中' : '就绪';
}
function lock(value) { busy = value; updateControls(); }
function renderPlan(plan) {
  lastPlan = plan;
  $('plan').textContent = plan
    ? `模型：${plan.model}\n目标：${plan.binaries?.[0]?.path || '—'}\n修改：use_responses_lite true → false\n目录：${plan.catalogPath}\n状态：候选配置需通过两轮终端验证`
    : currentInfo?.patch.patched ? '当前已有受管补丁。需要更新时，请使用“检查升级并维护”或“一键检测并修复”。'
      : healthy(lastReport) ? '本次检测全部通过，暂不需要生成或安装此补丁。'
        : lastReport?.summary.patchRecommended ? '诊断发现可验证的候选修复。请先点击“生成计划”，再“验证并安装”。'
          : '暂无候选计划。请先开始诊断，确认存在可修复的协议差异后再生成计划。';
  updateControls();
}
function renderReport(report) {
  lastReport = report;
  $('probe-rows').replaceChildren();
  for (const [kind, name] of Object.entries(names)) {
    const samples = report?.samples?.filter(s => s.kind === kind) || [], passed = samples.filter(s => s.result === 'pass').length;
    const tr = document.createElement('tr'), title = document.createElement('td'), count = document.createElement('td'), cell = document.createElement('td'), badge = document.createElement('span');
    title.textContent = name; count.textContent = samples.length ? `${passed} / ${samples.length}` : '—';
    const failures = [...new Set(samples.filter(s => s.result !== 'pass').map(s => labels[s.result] || s.result))];
    badge.className = `badge ${!samples.length ? '' : failures.length ? 'fail' : 'pass'}`;
    badge.textContent = !samples.length ? '待检测' : failures.length ? failures.join('、') : '连续通过';
    cell.append(badge); tr.append(title, count, cell); $('probe-rows').append(tr);
  }
  if (report) {
    const summary = report.summary, passed = healthy(report);
    $('endpoint').textContent = report.endpoint; $('provider').textContent = `服务提供方：${report.provider}`; $('model').textContent = report.model;
    $('decision').textContent = [passed ? '本次检测全部通过，未发现需要此补丁的协议差异。' : summary.patchRecommended ? '已找到差异性问题，可以生成候选计划并进行终端验证。' : '暂不能使用此修复方案：', ...(!passed ? (summary.blockers || []).map(b => `• ${b.message}`) : []), ...(summary.warnings || []).map(w => `提示：${w}`)].join('\n');
    $('decision').classList.toggle('fail', !passed && !summary.patchRecommended);
  } else { $('decision').textContent = '尚未检测。开始诊断会发送虚拟工具请求并消耗API额度。'; $('decision').classList.remove('fail'); }
  updateControls();
}
function renderInfo(info, { report = false, plan = false } = {}) {
  currentInfo = info;
  $('endpoint').textContent = info.patch.endpoint; $('provider').textContent = `服务提供方：${info.patch.provider}`;
  $('model').textContent = info.patch.model; $('patch-state').textContent = states[info.patch.state] || info.patch.state;
  $('verified-at').textContent = info.patch.verifiedAt ? `验证于${new Date(info.patch.verifiedAt).toLocaleString()}` : '候选验证通过后才安装';
  $('protocol').textContent = info.bundledModel ? `内置Responses Lite：${info.bundledModel.use_responses_lite ? '开启' : '关闭'}` : '模型目录能力待确认';
  $('binaries').replaceChildren(...info.binaries.map(b => { const option = document.createElement('option'); option.value = b.path; option.label = b.version; return option; }));
  if (report) renderReport(reportMatches(info.report, info) ? info.report : null);
  else if (lastReport && !reportMatches(lastReport, info)) renderReport(null);
  const candidate = plan ? info.plan : lastPlan;
  renderPlan(!info.patch.patched && planMatches(candidate) ? candidate : null);
  return info.discoveryError || info.capabilityError || (info.binaryChanged ? '检测到Codex程序已更新，请运行维护以重建并验证模型目录。' : '');
}
function resetContext() {
  currentInfo = null;
  renderReport(null); renderPlan(null);
  $('endpoint').textContent = '等待读取'; $('provider').textContent = '读取所选配置后显示'; $('model').textContent = '—';
  $('patch-state').textContent = '未检测'; $('verified-at').textContent = '读取配置后确认实际状态'; $('protocol').textContent = '模型目录能力待确认';
  $('binaries').replaceChildren();
}
function selectionChanged() {
  const next = selectionKey();
  if (next === selection) return;
  selection = next; revision++; restoreSaved = false;
  resetContext(); $('result').textContent = '暂无结果。'; $('logs').textContent = '配置或目标已改变，旧报告和候选计划已清除。';
  notice('配置或目标已改变。请读取此配置或开始诊断，再为当前目标生成计划。');
}
function completion(command, result) {
  if (command === 'guard-install') return '维护服务已启用并立即启动，以后登录时自动运行。后台检查结果见last-guard.json；发生变化时可能消耗API额度。';
  if (command === 'guard-uninstall') return '维护服务已停止并移除，不再在登录后自动运行。';
  if (command === 'verify') return result.passed ? '终端验证通过，请查看完整结果。' : '终端验证未通过，请查看完整结果。';
  if (result.message) return result.message;
  if (result.backupPath) return `补丁已验证并安装。请重启Codex并新建会话。\n备份：${result.backupPath}`;
  if (command === 'rollback') return '补丁已回滚。请重启Codex并新建会话。';
  if (command === 'recover') return result.recovered ? '中断事务已恢复，已重新读取当前状态。' : '没有需要恢复的中断事务，已重新读取当前状态。';
  return '操作完成。';
}
async function run(command) {
  if (busy) return;
  selectionChanged();
  const reason = prerequisite(command);
  if (reason) { notice(reason, true); return; }
  const selected = options(), startedRevision = revision, sameSelection = () => revision === startedRevision;
  const logs = [];
  const perform = async action => {
    const accepted = await api('/api/run', { command: action, options: selected });
    let job;
    do {
      await new Promise(resolve => setTimeout(resolve, 400));
      job = await api('/api/job');
      if (job.id !== accepted.id) throw new Error('操作状态已改变，请刷新后重试。');
      if (sameSelection()) { $('logs').textContent = [...logs, ...(job.logs || [])].join('\n') || '正在读取或处理…'; $('logs').scrollTop = $('logs').scrollHeight; }
    } while (job.state === 'running');
    logs.push(...(job.logs || []));
    if (job.state === 'error') throw new Error(job.error);
    return job.result;
  };
  lock(true); $('logs').textContent = '正在准备…'; $('result').textContent = '等待本次操作结果。'; notice('操作进行中，请等待结果。');
  let result, operationError, refreshError, infoWarning = '', attempted = false;
  if (command === 'diagnose') { restoreSaved = false; renderReport(null); renderPlan(null); }
  if (command === 'plan') renderPlan(null);
  try {
    if (command === 'diagnose') {
      logs.push('正在离线读取所选配置…');
      const info = await perform('inspect');
      if (!sameSelection()) return;
      infoWarning = renderInfo(info);
    }
    if (!sameSelection()) return;
    attempted = true;
    result = await perform(command);
    if (!sameSelection()) return;
    $('result').textContent = JSON.stringify(result, null, 2);
    if (command === 'inspect') infoWarning = renderInfo(result, { report: restoreSaved, plan: restoreSaved });
    else if (command === 'diagnose') { renderReport(result); renderPlan(null); }
    else if (command === 'plan') renderPlan(result);
  } catch (error) {
    operationError = error;
    if (sameSelection()) {
      $('result').textContent = JSON.stringify({ error: error.message }, null, 2);
      if (command === 'inspect' || command === 'diagnose' && !attempted) resetContext();
    }
  } finally {
    if (sameSelection() && attempted && refreshCommands.has(command)) {
      renderPlan(null);
      logs.push('正在离线刷新实际补丁状态…');
      try { const info = await perform('inspect'); if (sameSelection()) infoWarning = renderInfo(info, { report: command === 'repair' || command === 'maintain' }); }
      catch (error) { refreshError = error; if (sameSelection()) resetContext(); }
    }
    if (sameSelection()) {
      let message = operationError?.message || (command === 'inspect' ? '配置已读取。可以开始诊断，或检查已有补丁。' : command === 'diagnose' ? healthy(result) ? '诊断完成：本次检测全部通过，暂不需要此补丁。' : result?.summary.patchRecommended ? '诊断完成：已找到可验证的候选修复。' : '诊断完成：请查看检测项及具体阻止原因。' : command === 'plan' ? '候选计划已生成，点击“验证并安装”继续。' : completion(command, result));
      if (refreshError) message += `\n实际状态刷新失败：${refreshError.message} 请点击“读取此配置”重试。`;
      if (infoWarning) message += `\n状态提示：${infoWarning}`;
      notice(message, Boolean(operationError || refreshError || infoWarning || command === 'verify' && !result?.passed || command === 'diagnose' && !healthy(result) && !result?.summary.patchRecommended));
      $('logs').textContent = [...logs, message].join('\n');
    }
    lock(false);
  }
}
for (const button of document.querySelectorAll('[data-command]')) button.addEventListener('click', () => run(button.dataset.command));
for (const id of selectionFields) { $(id).addEventListener('input', selectionChanged); $(id).addEventListener('change', selectionChanged); }
$('download-report').addEventListener('click', () => { if (!lastReport) return; const url = URL.createObjectURL(new Blob([JSON.stringify(lastReport, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'codex-tool-doctor-report.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
resetContext();
api('/api/defaults').then(config => { $('home').value = config.home; $('profile').value = config.profile; $('binary').value = config.binary; $('insecure').checked = config.allowInsecureHttp; selection = selectionKey(); return run('inspect'); }).catch(error => notice(error.message, true));
