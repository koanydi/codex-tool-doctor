import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { posixCandidates } from '../src/binaries.mjs';
import { checkExecution } from '../src/verify.mjs';
import { runProcess } from '../src/process.mjs';
import { friendlyError, probeNames, resultNames } from '../src/ui.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const execution = (command, output='/home/alice/check\n') => [
  {type:'item.completed',item:{type:'command_execution',command,exit_code:0,aggregated_output:output}},
  {type:'turn.completed'},
];

test('Linux candidates use PATH and preserve spaces without Windows suffixes', () => {
  const paths = posixCandidates({PATH:'/opt/my tools:/usr/bin:/usr/bin:'},'/home/alice');
  assert.deepEqual(paths,['/opt/my tools/codex','/usr/bin/codex','/home/alice/.local/bin/codex','/home/alice/.npm-global/bin/codex']);
});
test('Linux verification accepts only pwd and supported shell wrappers', () => {
  for (const command of ['pwd', '/bin/bash -lc pwd', "/bin/bash -lc 'pwd'", 'sh -c "pwd"', '/usr/bin/zsh -lc "pwd"']) {
    assert.equal(checkExecution(execution(command),'/home/alice/check','linux').passed,true,command);
  }
  for (const command of ['pwd; id','bash -lc "pwd; id"','Get-Location','echo pwd']) {
    assert.equal(checkExecution(execution(command),'/home/alice/check','linux').passed,false,command);
  }
  assert.equal(checkExecution(execution('pwd','/home/Alice/check\n'),'/home/alice/check','linux').passed,false);
  assert.equal(checkExecution(execution('pwd','prefix /home/alice/check suffix\n'),'/home/alice/check','linux').passed,false);
});
test('CLI help and errors are in Chinese', async () => {
  const result=await runProcess(process.execPath,[cli,'--help']);
  assert.equal(result.code,0);
  assert.match(result.stdout,/打开中文功能菜单/);
  assert.match(result.stdout,/Linux/);
  const invalid=await runProcess(process.execPath,[cli,'status','--catalog','candidate.json']);
  assert.notEqual(invalid.code,0);
  assert.match(invalid.stderr,/仅用于 verify/);
});
test('menu displays Chinese choices and exits without touching configuration', async () => {
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[cli,'menu'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='',error='',sent=false;
    const timer=setTimeout(()=>{child.kill();reject(new Error('Menu timed out'));},5000);
    child.stdout.on('data',chunk=>{output+=chunk;if(!sent&&output.includes('请输入功能编号')){sent=true;child.stdin.write('0\n');}});
    child.stderr.on('data',chunk=>error+=chunk);
    child.on('error',reject);
    child.on('close',code=>{clearTimeout(timer);try{assert.equal(code,0,error);assert.match(output,/查看本机配置与程序版本/);assert.match(output,/一键检测并修复/);resolve();}catch(e){reject(e)}});
  });
});
test('known diagnostic result labels and missing-file errors are Chinese', () => {
  assert.equal(resultNames.pass,'通过');
  assert.match(probeNames['custom-additional'],/自定义/);
  assert.match(friendlyError({code:'ENOENT',path:'/missing'}),/找不到文件/);
});
test('POSIX launcher is UTF-8 with LF, preserving argument forwarding', async () => {
  const text=await readFile(new URL('../doctor.sh',import.meta.url),'utf8');
  assert.ok(text.startsWith('#!/bin/sh\n'));
  assert.equal(text.includes('\r'),false);
  assert.ok(text.includes('exec node "$script_dir/src/cli.mjs" "$@"'));
});
test('Windows launcher preserves CRLF for UTF-8 batch parsing', async () => {
  const text=await readFile(new URL('../doctor.cmd',import.meta.url),'utf8');
  assert.ok(text.includes('chcp 65001'));
  assert.equal(/(?<!\r)\n/.test(text),false);
});
