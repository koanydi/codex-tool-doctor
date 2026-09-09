import test from 'node:test';
import assert from 'node:assert/strict';
import { probeBody, parseResponse, classify, summarize } from '../src/probe.mjs';

const item = { id: 'ctc_1', type: 'custom_tool_call', name: 'diagnostic_echo', input: 'CHECK_TEST' };
const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const stream = event({ type: 'response.output_item.added', item }) + event({ type: 'response.output_item.done', item }) + event({ type: 'response.completed', response: { output: [item] } });

test('additional_tools is an input item, with custom grammar preserved', () => {
  const body = probeBody('gpt-6-astra', 'custom-additional', 'CHECK_TEST');
  assert.equal(body.tools, undefined);
  assert.equal(body.input[0].type, 'additional_tools');
  assert.equal(body.input[0].tools[0].tools[0].format.definition, 'start: "CHECK_TEST"');
  assert.equal(body.store, false);
});
test('flat and namespaced variants preserve the same tool definition', () => {
  assert.deepEqual(probeBody('model', 'custom-flat', 'X').tools[0], probeBody('model', 'custom-namespace', 'X').tools[0].tools[0]);
});
test('SSE parsing deduplicates completed tool calls and accepts CRLF', () => {
  const parsed = parseResponse(stream, true);
  assert.equal(parsed.output.length, 1);
  assert.equal(classify(parsed, 'custom-flat', 'CHECK_TEST'), 'pass');
});
test('gateway item ID changes do not duplicate one call_id', () => {
  const first = {...item,call_id:'call_stable'};
  const final = {...first,id:'rewritten_id'};
  const raw = event({type:'response.output_item.done',item:first}) + event({type:'response.completed',response:{output:[final]}});
  const parsed = parseResponse(raw,true);
  assert.equal(parsed.output.length,1);
  assert.equal(classify(parsed,'custom-flat','CHECK_TEST'),'pass');
});
test('HTTP success with a text NO_TOOL is a compatibility failure', () => {
  const parsed = { complete: true, orphanDeltas: 0, output: [{ type: 'message', content: [{ type: 'output_text', text: 'NO_TOOL' }] }] };
  assert.equal(classify(parsed, 'custom-flat', 'X'), 'no-tool');
});
test('truncated streams cannot be classified as a successful tool call', () => {
  assert.equal(classify(parseResponse(event({ type: 'response.output_item.done', item }), true), 'custom-flat', 'CHECK_TEST'), 'stream-error');
});
test('out-of-order text deltas are a stream protocol error', () => {
  const raw = event({ type: 'response.output_text.delta', item_id: 'missing', delta: 'hello' }) + stream;
  assert.equal(classify(parseResponse(raw, true), 'custom-flat', 'CHECK_TEST'), 'stream-error');
});
test('invalid arguments or wrong marker do not count as success', () => {
  assert.equal(classify(parseResponse(stream, true), 'custom-flat', 'WRONG'), 'unexpected-output');
  assert.equal(classify({ complete: true, orphanDeltas: 0, output: [{type:'function_call',name:'diagnostic_echo',arguments:'invalid'}] }, 'function-flat', 'X'), 'unexpected-output');
});
test('failed stream after a call remains a failure', () => {
  const parsed = parseResponse(stream + event({ type: 'response.failed' }), true);
  assert.equal(classify(parsed, 'custom-flat', 'CHECK_TEST'), 'stream-error');
});
test('patch recommendation requires repeated working flat controls', () => {
  const samples = ['function-flat', 'custom-flat'].flatMap(kind => [1, 2].map(round => ({ kind, round, result: 'pass' })));
  samples.push({kind:'custom-namespace',round:1,result:'no-tool'});
  assert.equal(summarize(samples).patchRecommended, true);
  assert.equal(summarize(samples.slice(1)).patchRecommended, false);
  const differential = summarize([...samples,{kind:'custom-additional',round:1,result:'network-error'}]);
  assert.equal(differential.patchRecommended, true);
  assert.ok(differential.warnings.length);
});
