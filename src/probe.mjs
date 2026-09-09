import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { hash, requestAuth, sanitize, saveJson, stateDir } from './config.mjs';
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
export function parseResponse(raw, streaming = true) {
  raw = raw.replace(/^\uFEFF/, '');
  if (!streaming || /^[\s]*[\[{]/.test(raw)) {
    const result = JSON.parse(raw);
    if (!Array.isArray(result.output)) throw new Error('响应不是有效的Responses对象，缺少output数组。');
    return { output: result.output, complete: result.status === 'completed' && !result.error, orphanDeltas: 0, events: {}, failure: result.error?.code || (result.status !== 'completed' ? result.status : undefined) };
  }
  const events = {}, items = new Map(), active = new Set();
  let complete = false, orphanDeltas = 0, failure;
  for (const block of raw.replace(/\r\n?/g, '\n').split('\n\n')) {
    const lines = block.split('\n');
    const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') continue;
    let event;
    try { event = JSON.parse(data); } catch { throw new Error('响应流事件中的JSON无效。'); }
    if (!event || typeof event !== 'object') throw new Error('响应流事件不是对象。');
    const eventType = event.type || lines.find(l => l.startsWith('event:'))?.slice(6).trim();
    if (!eventType) throw new Error('响应流事件缺少type。');
    events[eventType] = (events[eventType] || 0) + 1;
    if (eventType === 'response.output_item.added') active.add(event.item?.id);
    if (/^response\.(output_text|function_call_arguments|custom_tool_call_input)\.delta$/.test(eventType) && !active.has(event.item_id)) orphanDeltas++;
    if (eventType === 'response.output_item.done' && event.item) items.set(event.item.call_id || event.item.id || `item-${items.size}`, event.item);
    if (eventType === 'response.completed') {
      complete = event.response?.status !== 'failed' && event.response?.status !== 'incomplete';
      for (const item of event.response?.output || []) items.set(item.call_id || item.id || `item-${items.size}`, item);
    }
    if (['response.failed', 'error', 'response.incomplete'].includes(eventType)) failure = eventType;
  }
  if (!Object.keys(events).length) throw new Error('未收到Responses事件；可能返回了HTML路由页或其他协议。');
  return { output: [...items.values()], complete: complete && !failure, orphanDeltas, events, failure };
}
export function classify(parsed, kind, marker) {
  if (!parsed.complete || parsed.orphanDeltas) return 'stream-error';
  const expectedType = kind === 'function-flat' ? 'function_call' : 'custom_tool_call';
  const calls = parsed.output.filter(item => ['function_call', 'custom_tool_call'].includes(item?.type));
  const matches = calls.filter(item => {
    if (item.type !== expectedType || item.name !== 'diagnostic_echo') return false;
    if (expectedType === 'custom_tool_call') return item.input === marker;
    try { return JSON.parse(item.arguments).marker === marker; } catch { return false; }
  });
  if (matches.length === 1 && calls.length === 1) return 'pass';
  const text = parsed.output.flatMap(i => i.content || []).map(c => c.text || '').join(' ');
  return text.includes('NO_TOOL') ? 'no-tool' : 'unexpected-output';
}
export function request(endpoint, key, body, timeout = 30000, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const encoded = JSON.stringify(body), url = new URL(endpoint);
    const transport = url.protocol === 'http:' ? http : url.protocol === 'https:' ? https : null;
    if (!transport) { reject(new Error('仅支持HTTP/HTTPS请求。')); return; }
    const req = transport.request(url, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream, application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...extraHeaders, 'content-length': Buffer.byteLength(encoded) },
    });
    const timer = setTimeout(() => req.destroy(new Error('诊断请求超时。')), timeout);
    const fail = error => { clearTimeout(timer); reject(error); };
    req.on('error', fail);
    req.on('response', res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 2_000_000) req.destroy(new Error('诊断响应超过大小限制。')); else chunks.push(chunk); });
      res.on('error', fail);
      res.on('aborted', () => fail(new Error('服务端中断了响应连接。')));
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, requestId: res.headers['x-request-id'], contentType: res.headers['content-type'], raw: Buffer.concat(chunks).toString('utf8') }); });
    });
    req.end(encoded); // Redirects are deliberately not followed.
  });
}
export function summarize(samples) {
  const of = kind => samples.filter(s => s.kind === kind);
  const healthy = kind => of(kind).length >= 2 && of(kind).every(s => s.result === 'pass');
  const flatToolsHealthy = healthy('function-flat') && healthy('custom-flat');
  const wrapped = samples.filter(s => ['custom-namespace', 'custom-additional'].includes(s.kind));
  const compatibilityFailure = s => ['no-tool', 'unexpected-output', 'parse-error', 'stream-error'].includes(s.result) || (s.result === 'http-error' && [400, 404, 405, 415, 422, 501].includes(s.status));
  const namespaceFailureObserved = wrapped.some(compatibilityFailure);
  const blockers = [], warnings = [];
  for (const kind of ['function-flat', 'custom-flat']) {
    if (of(kind).length < 2) blockers.push({ code: 'insufficient-controls', kind, message: `${probeNames[kind]}不足两轮，无法建立可靠对照。` });
    else if (!healthy(kind)) blockers.push({ code: 'flat-control-failed', kind, message: `${probeNames[kind]}也存在失败；当前补丁不能解决平铺工具、认证或连接本身的问题。` });
  }
  if (!namespaceFailureObserved) blockers.push({ code: 'no-format-evidence', message: '未发现命名空间特有的格式问题。单独的超时、认证失败、限流或5xx不足以证明此补丁适用。' });
  if (samples.some(s => s.result === 'network-error' || (s.result === 'http-error' && !compatibilityFailure(s)))) warnings.push('存在连接、认证、限流或服务端异常；候选配置必须通过真实终端验证才能安装。');
  if (wrapped.some(s => ['parse-error', 'stream-error'].includes(s.result))) warnings.push('命名空间响应存在解析或流错误；仅在平铺对照连续正常时进入候选验证。');
  return {
    flatToolsHealthy, namespaceFailureObserved,
    transportError: samples.some(s => ['http-error', 'network-error', 'parse-error', 'stream-error'].includes(s.result)),
    patchRecommended: flatToolsHealthy && namespaceFailureObserved,
    decision: flatToolsHealthy && namespaceFailureObserved ? 'candidate-verification-required' : 'blocked', blockers, warnings,
    byKind: Object.fromEntries(PROBES.map(kind => [kind, { total: of(kind).length, passed: of(kind).filter(s => s.result === 'pass').length, failures: of(kind).filter(s => s.result !== 'pass').map(s => ({ round: s.round, result: s.result, status: s.status })) }])),
  };
}
export async function diagnose(context, { repeats = 2, timeout = 30000, progress = () => {}, send = request } = {}) {
  if (!Number.isInteger(repeats) || repeats < 2 || repeats > 5) throw new Error('检测轮数必须是2～5。');
  const { key, headers, secrets } = await requestAuth(context);
  const report = { schema: 2, createdAt: new Date().toISOString(), provider: context.providerId, endpoint: context.displayEndpoint, endpointHash: hash(context.endpoint), model: context.config.model, configHash: context.configHash, contextHash: context.contextHash, samples: [] };
  for (let round = 1; round <= repeats; round++) {
    for (const kind of PROBES) {
      progress(`检测第${round}/${repeats}轮：${probeNames[kind]}`);
      const marker = `CHECK_${randomUUID().replaceAll('-', '')}`, sample = { kind, round };
      let response;
      try { response = await send(context.endpoint, key, probeBody(report.model, kind, marker), timeout, headers); }
      catch (error) { sample.result = 'network-error'; sample.error = sanitize(error.message, secrets); }
      if (response) {
        sample.status = response.status;
        sample.requestId = sanitize(response.requestId || '', secrets);
        if (response.status !== 200) { sample.result = 'http-error'; sample.error = sanitize(response.raw.slice(0, 1200), secrets); }
        else {
          try {
            const parsed = parseResponse(response.raw, !/application\/json/i.test(response.contentType || ''));
            sample.result = classify(parsed, kind, marker);
            sample.events = parsed.events;
            sample.orphanDeltas = parsed.orphanDeltas;
            sample.outputTypes = parsed.output.map(i => i.type);
            sample.failure = parsed.failure;
          } catch (error) { sample.result = 'parse-error'; sample.error = sanitize(error.message, secrets); }
        }
      }
      report.samples.push(sample);
      progress(`  ${resultNames[sample.result]}${sample.status ? `（HTTP ${sample.status}）` : ''}`);
    }
  }
  report.summary = summarize(report.samples);
  await saveJson(join(stateDir(context.home, context.profile), 'last-report.json'), report);
  return report;
}
