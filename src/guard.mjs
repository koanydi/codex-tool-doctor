import { join, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { unlink } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicWrite, defaultHome, hash, readOptionalJson, sanitize, saveJson, stateDir } from './config.mjs';
import { execute } from './engine.mjs';
import { runProcess } from './process.mjs';

const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const winQuote = value => '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
const unitQuote = value => '"' + String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$') + '"';
export function guardSpec(platform, { home, profile, binary, allowInsecureHttp, node = process.execPath, script = fileURLToPath(new URL('./cli.mjs', import.meta.url)), userHome = homedir(), interval = 60, user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${userInfo().username}` : userInfo().username }) {
  const id = `codex-tool-doctor-${hash(resolve(home) + ':' + (profile || '')).slice(0, 12)}`;
  const args = [script, 'guard', '--home', resolve(home), '--interval', String(interval)];
  if (profile) args.push('--profile', profile);
  if (binary) args.push('--binary', binary);
  if (allowInsecureHttp) args.push('--allow-insecure-http');
  if (platform === 'win32') return {
    id, args, path: join(stateDir(home, profile), 'guard-task.xml'),
    content: `<?xml version="1.0" encoding="UTF-8"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Codex工具补丁升级维护。仅在配置或程序变化时重新验证。</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers><Principals><Principal id="DoctorUser"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="DoctorUser"><Exec><Command>${xml(node)}</Command><Arguments>${xml(args.map(winQuote).join(' '))}</Arguments><WorkingDirectory>${xml(resolve(home))}</WorkingDirectory></Exec></Actions></Task>\n`,
  };
  if (platform === 'darwin') return {
    id, args, path: join(userHome, 'Library', 'LaunchAgents', `${id}.plist`),
    content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${id}</string><key>ProgramArguments</key><array>${[node, ...args].map(a => `<string>${xml(a)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>60</integer></dict></plist>\n`,
  };
  if (platform === 'linux') return {
    id, args, path: join(userHome, '.config', 'systemd', 'user', `${id}.service`),
    content: `[Unit]\nDescription=Codex tool doctor upgrade maintenance\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${[node, ...args].map(unitQuote).join(' ')}\nRestart=on-failure\nRestartSec=60\n\n[Install]\nWantedBy=default.target\n`,
  };
  throw new Error('此系统没有内置自启动安装器，可以直接运行guard命令。');
}
async function checked(command, args) {
  const result = await runProcess(command, args);
  if (result.code !== 0 || result.timedOut) throw new Error(`维护服务操作失败：${command}。${sanitize(result.stderr || result.stdout).slice(-1200)}`);
  return result;
}
export async function installGuard(options = {}) {
  const home = options.home || defaultHome();
  const active = await readOptionalJson(join(stateDir(home, options.profile), 'active.json'));
  if (!active) throw new Error('请先成功安装补丁，再启用升级维护。');
  const spec = guardSpec(process.platform, { ...options, home });
  await atomicWrite(spec.path, spec.content);
  if (process.platform === 'win32') {
    await checked('schtasks.exe', ['/Create', '/TN', spec.id, '/XML', spec.path, '/F']);
    await checked('schtasks.exe', ['/Run', '/TN', spec.id]);
  } else if (process.platform === 'darwin') {
    await runProcess('launchctl', ['bootout', `gui/${process.getuid()}/${spec.id}`]);
    await checked('launchctl', ['bootstrap', `gui/${process.getuid()}`, spec.path]);
  } else {
    await checked('systemctl', ['--user', 'daemon-reload']);
    await checked('systemctl', ['--user', 'enable', '--now', `${spec.id}.service`]);
  }
  const result = { installed: true, id: spec.id, path: spec.path, platform: process.platform, installedAt: new Date().toISOString() };
  await saveJson(join(stateDir(home, options.profile), 'guard-installation.json'), result);
  return result;
}
export async function uninstallGuard(options = {}) {
  const home = options.home || defaultHome(), spec = guardSpec(process.platform, { ...options, home });
  if (process.platform === 'win32') {
    await runProcess('schtasks.exe', ['/End', '/TN', spec.id]);
    await checked('schtasks.exe', ['/Delete', '/TN', spec.id, '/F']);
  } else if (process.platform === 'darwin') await checked('launchctl', ['bootout', `gui/${process.getuid()}`, spec.path]);
  else await checked('systemctl', ['--user', 'disable', '--now', `${spec.id}.service`]);
  await unlink(spec.path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (process.platform === 'linux') await checked('systemctl', ['--user', 'daemon-reload']);
  await unlink(join(stateDir(home, options.profile), 'guard-installation.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  return { installed: false, id: spec.id };
}
export async function runGuard(options = {}, progress = () => {}, { signal, run = execute } = {}) {
  const interval = Number(options.interval || 60);
  if (!Number.isFinite(interval) || interval < 15 || interval > 3600) throw new Error('--interval必须是15～3600秒。');
  const home = options.home || defaultHome(), path = join(stateDir(home, options.profile), 'last-guard.json');
  let lastResult = '', retryAt = 0, failures = 0;
  while (!signal?.aborted) {
    if (Date.now() >= retryAt) {
      let result;
      try { result = await run('maintain', { ...options, home }, progress); failures = 0; }
      catch (error) { result = { state: 'attention-required', message: sanitize(error.message) }; failures++; retryAt = Date.now() + Math.min(60 * 60 * 1000, 60_000 * 2 ** Math.min(failures, 6)); }
      const serialized = JSON.stringify(result);
      if (serialized !== lastResult) {
        await saveJson(path, { ...result, checkedAt: new Date().toISOString(), retryAt: failures ? new Date(retryAt).toISOString() : null });
        progress(result.message || result.state);
        lastResult = serialized;
      }
    }
    if (options.once) break;
    try { await sleep(interval * 1000, undefined, { signal }); } catch (error) { if (error.name !== 'AbortError') throw error; }
  }
}
