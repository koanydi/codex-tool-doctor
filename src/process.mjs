import { spawn } from 'node:child_process';

export function runProcess(binary, args, { timeout = 30000, cwd, env, onEvent } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '', timedOut = false, overflow = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const stop = () => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 25_000_000) { overflow = true; stop(); }
      if (onEvent) {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) { try { onEvent(JSON.parse(line)); } catch {} }
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-100000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (onEvent && pending.trim()) { try { onEvent(JSON.parse(pending)); } catch {} }
      resolve({ code, stdout, stderr, timedOut, overflow });
    });
  });
}

export async function runJson(binary, args, options) {
  const result = await runProcess(binary, args, options);
  if (result.code !== 0 || result.timedOut || result.overflow) {
    throw new Error(result.timedOut ? 'Codex命令执行超时。' : 'Codex无法加载指定配置或不支持该诊断命令。');
  }
  try { return JSON.parse(result.stdout); } catch { throw new Error('Codex返回的诊断JSON无效。'); }
}
