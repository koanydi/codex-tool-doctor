import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { loadCredential, sanitize, saveJson, stateDir } from './config.mjs';
import { probeNames, resultNames } from './ui.mjs';

export const PROBES = ['function-flat', 'custom-flat', 'custom-namespace', 'custom-additional'];

export function probeBody(model, kind, marker) {
  const isFunction = kind === 'function-flat';
  const tool = isFunction ? {
    type: 'function', name: 'diagnostic_echo', description: 'Return the diagnostic marker.', strict: true,
    parameters: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false },
  } : {
    type: 'custom', name: 'diagnostic_echo', description: 'Diagnostic only. Call with the exact marker. No command is executed.',
    format: { type: 'grammar', syntax: 'lark', definition: `start: ${JSON.stringify(marker)}` },
  };
  const wrapped = [{ type: 'namespace', name: 'functions', description: 'Diagnostic tools', tools: [tool] }];
  const input = [{ role: 'user', content: `Call diagnostic_echo once with exactly ${marker}${isFunction ? ' as the marker argument' : ''}. If no tool is available, say NO_TOOL.` }];
  const body = { model, input, stream: true, store: false, reasoning: { effort: 'low' } };
  if (kind === 'custom-additional') input.unshift({ type: 'additional_tools', id: `tools_${randomUUID().replaceAll('-', '')}`, role: 'developer', tools: wrapped });
  else body.tools = kind === 'custom-namespace' ? wrapped : [tool];
  return body;
}

export function parseResponse(raw, streaming) {
  if (!streaming) {
    const result = JSON.parse(raw);
    return { output: result.output || [], complete: result.status === 'completed', orphanDeltas: 0, events: {} };
  }
  const events = {}, items = new Map(), active = new Set();
  let complete = false, orphanDeltas = 0, failure;
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    let event;
    try { event = JSON.parse(data); } catch { throw new Error('响应流事件中的 JSON 无效。'); }
    events[event.type] = (events[event.type] || 0) + 1;
    if (event.type === 'response.output_item.added') active.add(event.item?.id);
    if (event.type === 'response.output_text.delta' && !active.has(event.item_id)) orphanDeltas++;
    // Some gateways rewrite item IDs in response.completed; call_id is the stable tool identity.
    if (event.type === 'response.output_item.done') items.set(event.item?.call_id || event.item?.id || `item-${items.size}`, event.item);
    if (event.type === 'response.completed') {
      complete = true;
      for (const item of event.response?.output || []) items.set(item.call_id || item.id || `item-${items.size}`, item);
    }
    if (event.type === 'response.failed' || event.type === 'error' || event.type === 'response.incomplete') failure = event.type;
  }
  return { output: [...items.values()], complete: complete && !failure, orphanDeltas, events, failure };
}

export function classify(parsed, kind, marker) {
  if (!parsed.complete || parsed.orphanDeltas) return 'stream-error';
  const expectedType = kind === 'function-flat' ? 'function_call' : 'custom_tool_call';
  const matches = parsed.output.filter(item => {
    if (item?.type !== expectedType || item.name !== 'diagnostic_echo') return false;
    if (expectedType === 'custom_tool_call') return item.input === marker;
    try { return JSON.parse(item.arguments).marker === marker; } catch { return false; }
  });
  if (matches.length === 1) return 'pass';
  const text = parsed.output.flatMap(i => i.content || []).map(c => c.text || '').join(' ');
  return text.includes('NO_TOOL') ? 'no-tool' : 'unexpected-output';
}

export function request(endpoint, key, body, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const encoded = JSON.stringify(body);
    let timer;
    const req = https.request(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'content-length': Buffer.byteLength(encoded) },
    }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 2_000_000) req.destroy(new Error('诊断响应超过大小限制。')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, requestId: res.headers['x-request-id'], contentType: res.headers['content-type'], raw: Buffer.concat(chunks).toString('utf8') });
      });
    });
    timer = setTimeout(() => req.destroy(new Error('诊断请求超时。')), timeout);
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.end(encoded);
  });
}

export function summarize(samples) {
  const of = kind => samples.filter(s => s.kind === kind);
  const healthy = kind => of(kind).length >= 2 && of(kind).every(s => s.result === 'pass');
  const affected = samples.some(s => ['custom-namespace', 'custom-additional'].includes(s.kind) && s.result === 'no-tool');
  const transportError = samples.some(s => ['http-error', 'network-error', 'stream-error'].includes(s.result));
  return {
    flatToolsHealthy: healthy('custom-flat') && healthy('function-flat'),
    namespaceFailureObserved: affected,
    transportError,
    patchRecommended: healthy('custom-flat') && healthy('function-flat') && affected && !transportError,
  };
}

export async function diagnose(context, { repeats = 2, timeout = 30000, progress = () => {}, send = request } = {}) {
  const key = await loadCredential(context);
  const report = { schema: 1, createdAt: new Date().toISOString(), provider: context.providerId, endpoint: context.endpoint, model: context.config.model, configHash: context.configHash, samples: [] };
  for (let round = 1; round <= repeats; round++) {
    for (const kind of PROBES) {
      progress(`检测第 ${round}/${repeats} 轮：${probeNames[kind]}`);
      const marker = `CHECK_${randomUUID().replaceAll('-', '')}`;
      const sample = { kind, round };
      try {
        const response = await send(context.endpoint, key, probeBody(report.model, kind, marker), timeout);
        sample.status = response.status;
        sample.requestId = sanitize(response.requestId || '', key);
        if (response.status !== 200) sample.result = 'http-error';
        else {
          const parsed = parseResponse(response.raw, true);
          sample.result = classify(parsed, kind, marker);
          sample.events = parsed.events;
          sample.orphanDeltas = parsed.orphanDeltas;
          sample.outputTypes = parsed.output.map(i => i.type);
        }
      } catch (error) {
        sample.result = 'network-error';
        sample.error = sanitize(error.message, key);
      }
      report.samples.push(sample);
      progress(`  ${resultNames[sample.result]}${sample.status ? `（HTTP ${sample.status}）` : ''}`);
    }
  }
  report.summary = summarize(report.samples);
  await saveJson(join(stateDir(context.home), 'last-report.json'), report);
  return report;
}
