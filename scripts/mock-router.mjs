import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

function sendResponse(res, item) {
  const response = { id: `resp_${randomUUID().replaceAll('-', '')}`, object: 'response', created_at: Math.floor(Date.now() / 1000), model: 'fixture', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'local-fixture' });
  const event = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
  event({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
  event({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } });
  event({ type: 'response.output_item.done', output_index: 0, item });
  event({ type: 'response.completed', response });
  res.end();
}
const message = text => ({ id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
function terminalOutput(value) {
  if (typeof value === 'string') {
    try { return terminalOutput(JSON.parse(value)); } catch { return value; }
  }
  if (Array.isArray(value)) return value.map(terminalOutput).join('\n');
  return value && typeof value === 'object' ? terminalOutput(value.output ?? value.text ?? value.content) : '';
}
export async function createMockRouter({ port = 0, mode = 'namespace-rejected', onRequest = () => {} } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url.split('?')[0].endsWith('/responses')) { res.writeHead(404); res.end('fixture route not found'); return; }
      let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 4_000_000) throw new Error('fixture request too large'); }
      const body = JSON.parse(text), all = JSON.stringify(body);
      const tools = [...(body.tools || []), ...(body.input || []).filter(i => i.type === 'additional_tools').flatMap(i => i.tools || [])];
      onRequest({ body, path: req.url, toolNames: tools.map(t => ({ type: t.type, name: t.name, nested: t.tools?.map(c => c.name) })) });
      const marker = all.match(/CHECK_[a-zA-Z0-9]+/)?.[0];
      if (marker) {
        const wrapped = tools.some(t => t.type === 'namespace');
        if (wrapped && mode === 'namespace-rejected') { res.writeHead(422, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'namespace/additional_tools is not supported' } })); return; }
        if (wrapped && mode === 'malformed-stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {malformed\n\n'); return; }
        if (wrapped && mode === 'no-tool') { sendResponse(res, message('NO_TOOL')); return; }
        if (mode === 'outage') { res.writeHead(503); res.end('temporary outage'); return; }
        const tool = tools.flatMap(t => t.tools || [t]).find(t => t.name === 'diagnostic_echo');
        const item = { id: 'item_diag', call_id: `call_${randomUUID()}`, name: 'diagnostic_echo', ...(tool.type === 'function' ? { type: 'function_call', arguments: JSON.stringify({ marker }) } : { type: 'custom_tool_call', input: marker }) };
        sendResponse(res, item); return;
      }
      const verificationMarker = all.match(/VERIFIED_[a-f0-9]+/)?.[0];
      const toolOutputs = (body.input || []).filter(i => ['custom_tool_call_output', 'function_call_output'].includes(i.type));
      if (toolOutputs.length) { sendResponse(res, message(`Terminal result received:\n${toolOutputs.map(item => terminalOutput(item.output)).join('\n')}\n${verificationMarker || ''}`)); return; }
      const available = tools.flatMap(t => t.tools || [t]);
      const exec = available.find(t => t.name === 'exec' && t.type === 'custom');
      if (!exec) { sendResponse(res, message('NO_TOOL: fixture requires the native exec tool.')); return; }
      const command = process.platform === 'win32' ? 'Get-Location' : 'pwd';
      sendResponse(res, { id: 'item_terminal', type: 'custom_tool_call', call_id: `call_${randomUUID().replaceAll('-', '')}`, name: 'exec', input: `const result = await tools.exec_command(${JSON.stringify({ cmd: command, ...(process.platform === 'win32' ? { shell: 'pwsh' } : {}), max_output_tokens: 1000 })}); text(result);` });
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(error.message); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] || 8787), mode = process.argv[3] || 'namespace-rejected';
  if (!['namespace-rejected', 'malformed-stream', 'no-tool', 'outage', 'healthy'].includes(mode)) throw new Error('未知故障模式。');
  const router = await createMockRouter({ port, mode });
  console.log(`本地故障模拟：${router.url}/v1\n模式：${mode}\n不会请求真实模型，也不需要API密钥。仅用于隔离的测试配置。`);
}
