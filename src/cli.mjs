#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultHome, loadConfig, readJson, stateDir, sanitize } from './config.mjs';
import { discoverBinaries, loadCatalog } from './binaries.mjs';
import { diagnose } from './probe.mjs';
import { applyPlan, createPlan, rollback, status } from './patch.mjs';
import { validateActive, verify } from './verify.mjs';
import { launcher, probeNames, resultNames, yesNo, friendlyError } from './ui.mjs';

const HELP = `Codex 工具诊断与修复 1.0.0 - 无需本地代理或监听服务

用法：${launcher} <命令> [选项]

  inspect    查看配置、补丁状态和已安装的 Codex 程序（离线）
  diagnose   检测 API：四种工具格式，默认各测试两轮
  plan       根据最近一次检测生成可审阅的补丁计划（离线）
  apply      备份并应用补丁，验证终端，失败自动回滚
  repair     一键执行检测、生成计划、应用补丁和验证
  verify     通过本机 Codex 程序执行只读终端验证
  status     查看补丁状态与完整性（离线）
  rollback   撤销补丁，保留之后的其他配置修改
  menu       打开中文功能菜单

选项：
  --home PATH       配置目录，默认 CODEX_HOME 或 ~/.codex
  --binary PATH     优先使用的 Codex 程序路径，同时检查可发现的安装
  --catalog PATH    仅供 verify 临时测试候选模型目录，不修改全局配置
  --repeats N       检测轮数，2～5，默认 2
  --timeout N       单次 API 请求超时秒数，5～120，默认 30
  --json            输出机器可读 JSON（字段名保持英文）
  --help            查看帮助

检测会发送虚拟工具请求，可能消耗 API 额度，不执行返回的工具调用。
终端验证使用临时只读会话：Windows 执行 Get-Location，Linux 执行 pwd。
自动补丁仅适用于已验证构建；Linux 使用说明见 docs/修改原理与Linux指南.md。
应用后请重启 Codex 桌面端或命令行，并新建会话。
`;

function printResult(command, value) {
  if (command === 'diagnose') {
    console.table(value.samples.map(s => ({ 检测项: probeNames[s.kind] || s.kind, 轮次: s.round, 结果: resultNames[s.result] || s.result, HTTP状态: s.status || '-' })));
    console.log(value.summary.patchRecommended ? '已复现匹配的兼容性问题，可对已验证构建生成协议补丁计划。' : '现有证据不满足此补丁的适用条件。请查看报告；配置未修改。');
  } else if (command === 'plan') {
    console.log(`计划编号：${value.id}\n模型：${value.model}\n修改内容：use_responses_lite 从 true 改为 false\n模型目录：${value.catalogPath}\n下一步：${launcher} apply`);
  } else if (command === 'apply' || command === 'repair') {
    console.log(`补丁已应用，终端验证通过。\n原配置备份：${value.backupPath}\n请重启 Codex 并新建会话。\n回滚命令：${launcher} rollback`);
  } else if (command === 'status') {
    console.log(`本工具管理的补丁：${yesNo(value.patched)}\n模型：${value.model}\n服务提供方：${value.provider}\nAPI 地址：${value.endpoint}\n模型是否在补丁范围内：${yesNo(value.modelCovered)}\n模型目录完整：${yesNo(value.catalogIntact)}\n配置标记完整：${yesNo(value.managedBlockIntact)}\n模型目录路径：${value.catalogPath || '未设置'}`);
  } else if (command === 'inspect') {
    console.log(`配置目录：${value.home}`);
    printResult('status', value.patch);
    console.table(value.binaries.map(b => ({ 程序路径: b.path, 版本: b.version, 允许自动补丁: yesNo(b.supported), SHA256: b.sha256 })));
    console.log(`内置模型的 use_responses_lite：${value.bundledModel?.use_responses_lite ?? '未提供'}`);
  } else if (command === 'verify') {
    console.log(`终端验证：${value.passed ? '通过' : '未通过'}`);
    console.table(value.results.map(r => ({ 程序: r.binary, 结果: r.passed ? '通过' : '失败', 超时: yesNo(r.timedOut), 退出码: r.processExit })));
  } else if (command === 'rollback') {
    console.log(`补丁已撤销。\n计划编号：${value.id}\n已保留之后的其他配置修改：${yesNo(value.preservedOtherEdits)}\n请重启 Codex 并新建会话。`);
  }
}

async function menu(options) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const choices = ['inspect', 'diagnose', 'plan', 'apply', 'verify', 'status', 'rollback', 'repair'];
  try {
    while (true) {
      console.log('\nCodex 工具诊断与修复\n1. 查看本机配置与程序版本\n2. 检测 API 工具兼容性（消耗 API 额度）\n3. 生成补丁计划（不修改配置）\n4. 应用补丁并验证（自动备份，失败回滚）\n5. 验证终端执行能力\n6. 查看当前补丁状态\n7. 回滚补丁\n8. 一键检测并修复（消耗 API 额度）\n0. 退出');
      const answer = (await rl.question('请输入功能编号：')).trim();
      if (answer === '0') break;
      const command = choices[Number(answer) - 1];
      if (!command) { console.log('请输入 0～8 之间的功能编号。'); continue; }
      const args = [fileURLToPath(import.meta.url), command, '--home', options.home];
      if (options.binary) args.push('--binary', options.binary);
      args.push('--repeats', options.repeats, '--timeout', options.timeout);
      await new Promise(resolve => {
        const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true });
        child.on('error', error => { console.error(friendlyError(error)); resolve(); });
        child.on('close', resolve);
      });
    }
  } finally { rl.close(); }
}

async function applyAndVerify(home, plan, progress) {
  const applied = await applyPlan(home, plan);
  try {
    const context = await loadConfig(home);
    const binaries = await discoverBinaries(plan.binaries[0].path);
    await validateActive(context, binaries);
    const verification = await verify(context, binaries, { progress });
    if (!verification.passed) throw new Error('终端验证未通过。');
    return { ...applied, verification };
  } catch (error) {
    progress('验证失败，正在撤销本工具管理的补丁。');
    try { await rollback(home); } catch (restoreError) {
      throw new Error(`${error.message} 自动回滚也已停止：${restoreError.message}。原配置备份：${applied.backupPath}`);
    }
    throw new Error(`${error.message} 补丁已回滚。`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({ options: {
    home: { type: 'string' }, binary: { type: 'string' }, catalog: { type: 'string' }, repeats: { type: 'string', default: '2' }, timeout: { type: 'string', default: '30' }, json: { type: 'boolean' }, help: { type: 'boolean' },
  }, allowPositionals: true });
  const command = positionals[0] || 'help';
  if (values.help || command === 'help') { console.log(HELP); return; }
  if (positionals.length > 1) throw new Error('命令后有多余参数，请用 --help 查看用法。');
  if (values.catalog && command !== 'verify') throw new Error('--catalog 仅用于 verify 的临时验证，不会应用补丁。');
  const home = values.home || defaultHome();
  if (command === 'menu') { await menu({ ...values, home }); return; }
  const repeats = Number(values.repeats), seconds = Number(values.timeout);
  if (!Number.isInteger(repeats) || repeats < 2 || repeats > 5) throw new Error('--repeats 必须是 2～5 之间的整数。');
  if (!Number.isFinite(seconds) || seconds < 5 || seconds > 120) throw new Error('--timeout 必须在 5～120 秒之间。');
  const progress = message => console.error(message);
  let result;
  if (command === 'status') result = await status(home);
  else if (command === 'rollback') result = await rollback(home);
  else if (command === 'apply') {
    const plan = await readJson(join(stateDir(home), 'last-plan.json'));
    result = await applyAndVerify(home, plan, progress);
  } else {
    const context = await loadConfig(home);
    if (command === 'diagnose') result = await diagnose(context, { repeats, timeout: seconds * 1000, progress });
    else {
      const binaries = await discoverBinaries(values.binary);
      if (command === 'inspect') {
        const catalog = await loadCatalog(binaries[0].path, home);
        const model = catalog.models.find(m => m.slug === context.config.model);
        result = { home, patch: await status(home), binaries, bundledModel: model ? { slug: model.slug, tool_mode: model.tool_mode, use_responses_lite: model.use_responses_lite } : null };
      } else if (command === 'plan') {
        result = await createPlan(context, await readJson(join(stateDir(home), 'last-report.json')), binaries);
      } else if (command === 'verify') {
        if (values.catalog) {
          for (const binary of binaries) {
            const catalog = await loadCatalog(binary.path, home, values.catalog);
            if (catalog.models.find(m => m.slug === context.config.model)?.use_responses_lite !== false) throw new Error('候选模型目录未将当前模型的 use_responses_lite 设为 false。');
          }
          progress('本次仅临时测试候选模型目录，不修改全局配置，也不将未知构建加入自动补丁名单。');
        } else if ((await status(home)).patched) await validateActive(context, binaries);
        result = await verify(context, binaries, { progress, catalogPath: values.catalog });
      } else if (command === 'repair') {
        if ((await status(home)).patched) throw new Error('已有生效中的补丁。请查看状态或验证；更换补丁前先回滚。');
        const report = await diagnose(context, { repeats, timeout: seconds * 1000, progress });
        const plan = await createPlan(await loadConfig(home), report, binaries);
        result = await applyAndVerify(home, plan, progress);
      } else throw new Error(`未知命令：${command}。请用 --help 查看用法。`);
    }
  }
  if (values.json) console.log(JSON.stringify(result, null, 2)); else printResult(command, result);
  if (command === 'verify' && !result.passed) process.exitCode = 2;
  if (command === 'diagnose' && result.samples.some(s => s.result !== 'pass')) process.exitCode = 2;
}

main().catch(error => { console.error(`错误：${sanitize(friendlyError(error))}`); process.exitCode = 1; });
