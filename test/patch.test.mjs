import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { addBlock, removeBlock, makePatchedCatalog } from '../src/patch.mjs';
import { hash, loadConfig, sanitize, atomicWrite } from '../src/config.mjs';
import { checkExecution } from '../src/verify.mjs';

const original = '# User settings\r\nmodel = "gpt-6-astra"\r\n[model_providers.custom]\r\nbase_url = "https://example.test"\r\n';

test('model patch changes only one field on the selected model', () => {
  const catalog = { models: [{slug:'one',use_responses_lite:true,tool_mode:'code_mode_only',context_window:272000},{slug:'two',use_responses_lite:true}], metadata:'kept' };
  const changed = makePatchedCatalog(catalog, 'one');
  assert.equal(catalog.models[0].use_responses_lite, true);
  assert.equal(changed.models[0].use_responses_lite, false);
  changed.models[0].use_responses_lite = true;
  assert.deepEqual(changed, catalog);
  assert.throws(() => makePatchedCatalog(catalog, 'missing'));
});
test('managed block preserves the original TOML and CRLF', () => {
  const patched = addBlock(original, 'C:\\Users\\test\\models.json', 'id');
  assert.ok(patched.text.endsWith(original));
  assert.equal(parse(patched.text).model_catalog_json, 'C:/Users/test/models.json');
  assert.ok(patched.block.includes('\r\n'));
});
test('existing model overrides are never overwritten', () => {
  assert.throws(() => addBlock('model_catalog_json = "existing.json"\n', 'new.json', 'id'), /已有/);
});
test('rollback restores exact original bytes when no other edits exist', () => {
  const patched = addBlock(original, 'C:/models.json', 'id');
  const restored = removeBlock(patched.text, {...patched,patchedConfigHash:hash(patched.text)}, original);
  assert.equal(restored, original);
});
test('rollback preserves unrelated edits made after patching', () => {
  const patched = addBlock(original, 'C:/models.json', 'id');
  const current = patched.text.replace('gpt-6-astra', 'other-model') + '\r\n# A new user comment\r\n';
  const restored = removeBlock(current, {...patched,patchedConfigHash:hash(patched.text)}, original);
  assert.equal(restored, original.replace('gpt-6-astra', 'other-model') + '\r\n# A new user comment\r\n');
});
test('rollback refuses a modified or duplicated managed block', () => {
  const patched = addBlock(original, 'C:/models.json', 'id');
  const state = {...patched,patchedConfigHash:hash(patched.text)};
  assert.throws(() => removeBlock(patched.text.replace('C:/models.json', 'C:/edited.json'),state,original));
  assert.throws(() => removeBlock(patched.block + patched.text,state,original));
});
test('full Responses models do not receive this patch', () => {
  assert.throws(() => makePatchedCatalog({models:[{slug:'model',use_responses_lite:false}]},'model'), /已使用/);
});
test('configuration rejects endpoints that could expose credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tool-doctor-config-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  for (const url of ['http://example.test','https://user:pass@example.test','https://example.test?token=secret']) {
    await writeFile(join(directory,'config.toml'), `model="m"\nmodel_provider="custom"\n[model_providers.custom]\nwire_api="responses"\nbase_url="${url}"\n`);
    await assert.rejects(loadConfig(directory), /HTTPS/);
  }
});
test('atomic file replacement leaves a valid complete artifact', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tool-doctor-atomic-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const path = join(directory,'artifact.json');
  await atomicWrite(path,'{"version":1}');
  await atomicWrite(path,'{"version":2}');
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),{version:2});
});
test('secret redaction removes both exact keys and bearer strings', () => {
  assert.equal(sanitize('bad secret123 and Bearer ABC and sk-test-key', 'secret123'), 'bad [REDACTED] and Bearer [REDACTED] and [REDACTED]');
});
test('verification requires a real successful terminal event, not model prose', () => {
  const prose = [{type:'item.completed',item:{type:'agent_message',text:'Get-Location succeeded C:/check'}},{type:'turn.completed'}];
  assert.equal(checkExecution(prose, 'C:/check', 'win32').passed, false);
  const events = [...prose,{type:'item.completed',item:{type:'command_execution',command:'powershell -Command Get-Location',exit_code:0,aggregated_output:'C:/check'}}];
  assert.equal(checkExecution(events, 'C:/check', 'win32').passed, true);
  assert.equal(checkExecution(events, 'C:/different', 'win32').passed, false);
  const extraCommand = structuredClone(events);
  extraCommand.at(-1).item.command = 'powershell -Command Get-Location; Get-Date';
  assert.equal(checkExecution(extraCommand, 'C:/check', 'win32').passed, false);
});
