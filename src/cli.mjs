#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { defaultHome, sanitize } from './config.mjs';
import { execute } from './engine.mjs';
import { installGuard, uninstallGuard, runGuard } from './guard.mjs';
import { launcher, probeNames, resultNames, friendlyError } from './ui.mjs';

const HELP = `Codex工具诊断与修复2.2.0
修复第三方API不兼容导致Codex无法调用工具的问题。
用法：${launcher} <命令> [选项]

  gui          打开图形界面（Windows / macOS / Linux，本机浏览器）
  inspect      离线查看配置、程序版本、诊断报告和补丁状态
  diagnose     检测API工具兼容性，四种格式各2～5轮
  plan         生成候选补丁计划，显示具体阻止原因
  apply        两轮候选终端验证通过后，备份并安装补丁
  repair       一键检测、计划、验证和安装；已有补丁则复检维护
  verify       验证实际终端调用及工具结果回传
  status       查看当前补丁状态
  rollback     移除受管补丁，保留其他配置修改
  recover      恢复中断事务，检查并移除已退出进程的锁
  maintain     程序或配置改变时重新检测并更新补丁
  launch       先维护再启动Codex；Codex参数放在--后
  guard        持续检查升级；未改变时不发送API请求
  guard-install    安装当前用户登录后的升级维护服务
  guard-uninstall  停止并移除升级维护服务
  menu         打开中文功能菜单

  --home PATH      配置目录，默认CODEX_HOME或~/.codex
  --profile NAME   使用<NAME>.config.toml配置层
  --binary PATH    只检查和修复此目标程序；默认选择发现的首个安装
  --catalog PATH   仅用于verify的临时验证
  --repeats N      检测轮数2～5，默认2
  --timeout N      API请求超时5～120秒，默认30
  --recheck        maintain主动复检，即使本机文件未变
  --allow-insecure-http  显式允许公网明文HTTP；本地HTTP不需要此参数
  --interval N    guard检查间隔15～3600秒，默认60
  --once          guard只运行一次
  --port N        GUI端口，默认自动分配
  --no-open       GUI不自动打开浏览器
  --json          机器可读JSON（错误也以JSON输出）

检测和终端验证会消耗API额度；修复不会执行模型返回的虚拟诊断工具。
Windows终端验证使用pwsh的Get-Location，macOS/Linux使用pwd。
应用后重启Codex并新建会话；升级维护不保证未知服务端变化永远兼容。
`;

function printResult(command, result) {
  if (command === 'diagnose') {
    console.table(result.samples.map(s => ({ 检测项: probeNames[s.kind], 轮次: s.round, 结果: resultNames[s.result], HTTP: s.status || '-' })));
    console.log(result.summary.patchRecommended ? '存在可验证的候选修复，请生成计划并验证。' : '当前不能生成此补丁：');
    for (const reason of result.summary.blockers) console.log(`- [${reason.code}] ${reason.message}`);
    for (const warning of result.summary.warnings) console.log(`提示：${warning}`);
  } else if (['apply', 'repair'].includes(command) && result.backupPath) console.log(`补丁安装或维护成功。\n备份：${result.backupPath}\n请重启Codex并新建会话。可启用guard-install，在登录后自动检查升级。`);
  else if (command === 'plan') console.log(`候选计划：${result.id}\n目标：${result.binaries[0].path}\n模型：${result.model}\n变化：use_responses_lite true → false\n下一步运行apply，候选验证通过后才写入配置。`);
  else console.log(JSON.stringify(result, null, 2));
}
async function run(command, options, progress) {
  if (command === 'gui') {
    const { startGui, openBrowser } = await import('./gui.mjs');
    const gui = await startGui(options);
    console.log(`图形界面：${gui.url}\n关闭此进程可停止界面服务；它不会代理Codex请求。`);
    if (!options.noOpen) await openBrowser(gui.url).catch(error => console.error(`无法自动打开浏览器，请使用上方地址。${error.message}`));
    return;
  }
  if (command === 'guard-install') return installGuard(options);
  if (command === 'guard-uninstall') return uninstallGuard(options);
  if (command === 'guard') {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { await runGuard(options, progress, { signal: controller.signal }); }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    return;
  }
  if (command === 'launch') {
    const result = await execute('maintain', options, progress);
    progress(result.message || result.state);
    const info = await execute('inspect', options);
    const args = [...(options.profile ? ['--profile', options.profile] : []), ...(options.forward || [])];
    const code = await new Promise((resolve, reject) => {
      const child = spawn(info.target, args, { env: { ...process.env, CODEX_HOME: options.home }, stdio: 'inherit', windowsHide: true });
      child.on('error', reject); child.on('close', resolve);
    });
    process.exitCode = code ?? 1;
    return;
  }
  return execute(command, options, progress);
}
async function menu(options) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const choices = ['inspect', 'diagnose', 'plan', 'apply', 'verify', 'status', 'rollback', 'repair', 'gui', 'maintain', 'recover'];
  try {
    while (true) {
      console.log('\nCodex工具诊断与修复\n1. 查看本机配置与程序版本\n2. 检测API工具兼容性（消耗API额度）\n3. 生成补丁计划\n4. 验证候选并应用补丁\n5. 验证终端执行能力\n6. 查看补丁状态\n7. 回滚补丁\n8. 一键检测并修复\n9. 打开图形界面\n10. 检查升级并维护\n11. 恢复中断事务\n0. 退出');
      const answer = (await rl.question('请输入功能编号：')).trim();
      if (answer === '0') break;
      const command = choices[Number(answer) - 1];
      if (!command) { console.log('请输入有效编号。'); continue; }
      try { const result = await run(command, options, console.error); if (result) printResult(command, result); if (command === 'gui') break; }
      catch (error) { console.error(`错误：${sanitize(friendlyError(error))}`); }
    }
  } finally { rl.close(); }
}
async function main() {
  const argv = process.argv.slice(2), separator = argv.indexOf('--');
  const { values, positionals } = parseArgs({ args: separator < 0 ? argv : argv.slice(0, separator), options: {
    home: { type: 'string' }, binary: { type: 'string' }, profile: { type: 'string' }, catalog: { type: 'string' },
    repeats: { type: 'string', default: '2' }, timeout: { type: 'string', default: '30' }, interval: { type: 'string', default: '60' }, port: { type: 'string', default: '0' },
    json: { type: 'boolean' }, help: { type: 'boolean' }, recheck: { type: 'boolean' }, once: { type: 'boolean' }, 'no-open': { type: 'boolean' }, 'allow-insecure-http': { type: 'boolean' },
  }, allowPositionals: true });
  const command = positionals[0] || 'help';
  if (values.help || command === 'help') { console.log(HELP); return; }
  if (positionals.length > 1 || (separator >= 0 && command !== 'launch')) throw new Error('多余参数；Codex参数仅可放在launch的--后。');
  if (values.catalog && command !== 'verify') throw new Error('--catalog仅用于verify的临时验证。');
  if (!Number.isInteger(Number(values.repeats)) || Number(values.repeats) < 2 || Number(values.repeats) > 5) throw new Error('--repeats必须是2～5之间的整数。');
  if (!Number.isFinite(Number(values.timeout)) || Number(values.timeout) < 5 || Number(values.timeout) > 120) throw new Error('--timeout必须在5～120秒之间。');
  const options = { ...values, home: values.home || defaultHome(), allowInsecureHttp: Boolean(values['allow-insecure-http']), noOpen: values['no-open'], forward: separator < 0 ? [] : argv.slice(separator + 1) };
  if (command === 'menu') return menu(options);
  const result = await run(command, options, message => console.error(message));
  if (result) {
    if (values.json) console.log(JSON.stringify(result, null, 2)); else printResult(command, result);
    if (command === 'verify' && !result.passed || command === 'diagnose' && result.samples.some(s => s.result !== 'pass')) process.exitCode = 2;
  }
}
main().catch(error => {
  const message = sanitize(friendlyError(error));
  if (process.argv.includes('--json')) console.log(JSON.stringify({ error: { message, code: error.code || 'DOCTOR_ERROR' } }));
  else console.error(`错误：${message}`);
  process.exitCode = 1;
});
