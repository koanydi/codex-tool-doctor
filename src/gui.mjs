import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { execute } from './engine.mjs';
import { installGuard, uninstallGuard } from './guard.mjs';
import { defaultHome, sanitize } from './config.mjs';
import { friendlyError } from './ui.mjs';

const allowed = new Set(['inspect', 'diagnose', 'plan', 'apply', 'repair', 'verify', 'status', 'rollback', 'recover', 'maintain', 'guard-install', 'guard-uninstall']);
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
function guiError(error) {
  const file = String(error.path || '').split(/[\\/]/).at(-1);
  if (error.code === 'ENOENT') {
    if (file === 'config.toml' || file?.endsWith('.config.toml')) return sanitize(`未找到Codex配置文件：${error.path}。请选择已有Codex配置目录；使用配置名称时，该目录还需包含对应的<名称>.config.toml。`);
    if (file === 'last-plan.json') return '未找到候选计划。请先开始诊断，再点击“生成计划”，最后“验证并安装”。';
    if (file === 'last-report.json') return '未找到诊断报告。请先点击“开始诊断”，确认存在可修复的协议差异后再生成计划。';
  }
  return sanitize(friendlyError(error));
}
export async function startGui(defaults = {}, { run = execute, guardInstall = installGuard, guardUninstall = uninstallGuard } = {}) {
  const port = Number(defaults.port || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('GUI端口必须是0～65535之间的整数。');
  const token = randomBytes(32).toString('hex');
  let origin, job = null;
  const send = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) { send(res, 403, { error: '仅允许本机同源访问。' }); return; }
    try {
      const path = new URL(req.url, origin).pathname;
      if (req.method === 'GET' && path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (req.method === 'GET' && assets[path]) {
        const [name, type] = assets[path];
        const content = await readFile(new URL(`./web/${name}`, import.meta.url));
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8` }); res.end(content); return;
      }
      if (req.headers['x-doctor-token'] !== token) { send(res, 401, { error: '本机界面凭据无效，请使用启动时的完整地址重新打开。' }); return; }
      if (req.method === 'GET' && path === '/api/defaults') { send(res, 200, { home: defaults.home || defaultHome(), binary: defaults.binary || '', profile: defaults.profile || '', allowInsecureHttp: defaults.allowInsecureHttp || false }); return; }
      if (req.method === 'GET' && path === '/api/job') { send(res, 200, job || { state: 'idle' }); return; }
      if (req.method !== 'POST' || path !== '/api/run') { send(res, 404, { error: '未找到此接口。' }); return; }
      if (job?.state === 'running') { send(res, 409, { error: '已有操作正在进行，请等待完成。' }); return; }
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 32768) { send(res, 413, { error: '请求过大。' }); return; } }
      const input = JSON.parse(body);
      if (!allowed.has(input.command)) { send(res, 400, { error: '不支持此操作。' }); return; }
      const source = input.options || {}, options = {};
      for (const key of ['home', 'binary', 'profile', 'catalog']) { if (source[key] != null && (typeof source[key] !== 'string' || source[key].length > 4096)) throw new Error('路径参数格式无效。'); if (source[key]) options[key] = source[key]; }
      options.home ||= defaults.home || defaultHome();
      options.allowInsecureHttp = source.allowInsecureHttp === true;
      options.recheck = source.recheck === true;
      options.repeats = Number(source.repeats || 2); options.timeout = Number(source.timeout || 30);
      if (!Number.isInteger(options.repeats) || options.repeats < 2 || options.repeats > 5 || !Number.isFinite(options.timeout) || options.timeout < 5 || options.timeout > 120) throw new Error('检测参数超出范围。');
      const current = { id: randomBytes(8).toString('hex'), command: input.command, state: 'running', logs: [], startedAt: new Date().toISOString() };
      job = current;
      const progress = message => { current.logs.push(sanitize(message)); current.logs = current.logs.slice(-160); };
      send(res, 202, { id: current.id });
      Promise.resolve().then(() => input.command === 'guard-install' ? guardInstall(options) : input.command === 'guard-uninstall' ? guardUninstall(options) : run(input.command, options, progress))
        .then(result => { current.result = result; current.state = 'done'; })
        .catch(error => { current.error = guiError(error); current.state = 'error'; })
        .finally(() => { current.finishedAt = new Date().toISOString(); });
    } catch (error) { if (!res.headersSent) send(res, 400, { error: guiError(error) }); else res.end(); }
  });
  server.requestTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, token, url: `${origin}/#${token}`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
export async function openBrowser(url) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, detached: true }); child.on('error', reject); child.on('spawn', () => { child.unref(); resolve(); }); });
}
