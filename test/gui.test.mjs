import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { startGui } from '../src/gui.mjs';

test('GUI serves local assets and protects actions from cross-origin requests', async t => {
  const gui = await startGui({ home: '/fixture' }, { run: async command => ({ command }) }); t.after(() => gui.close());
  const page = await fetch(gui.origin);
  assert.equal(page.status, 200); assert.match(await page.text(), /诊断工作台/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(gui.origin + '/api/defaults')).status, 401);
  assert.equal((await fetch(gui.origin + '/api/defaults', { headers: { 'x-doctor-token': gui.token, origin: 'https://evil.test' } })).status, 403);
  const spoofedHostStatus = await new Promise((resolve, reject) => { const req = http.get(gui.origin, { headers: { host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(spoofedHostStatus, 403);
  const defaults = await fetch(gui.origin + '/api/defaults', { headers: { 'x-doctor-token': gui.token } });
  assert.equal((await defaults.json()).home, '/fixture');
});
test('GUI rejects arbitrary commands and serializes long operations', async t => {
  let finish;
  const gui = await startGui({}, { run: () => new Promise(resolve => { finish = resolve; }) }); t.after(() => gui.close());
  const post = body => fetch(gui.origin + '/api/run', { method: 'POST', headers: { 'x-doctor-token': gui.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ command: 'shell', options: {} })).status, 400);
  assert.equal((await post({ command: 'diagnose', options: { repeats: 1000 } })).status, 400);
  assert.equal((await post({ command: 'diagnose', options: {} })).status, 202);
  assert.equal((await post({ command: 'rollback', options: {} })).status, 409);
  finish({ ok: true });
  const job = await fetch(gui.origin + '/api/job', { headers: { 'x-doctor-token': gui.token } });
  assert.equal((await job.json()).state, 'done');
});

const browserSource = await readFile(new URL('../src/web/app.js', import.meta.url), 'utf8');
const markup = await readFile(new URL('../src/web/index.html', import.meta.url), 'utf8');
async function until(check) {
  for (let i = 0; i < 400; i++) { if (check()) return; await delay(5); }
  assert.fail('GUI did not settle');
}
function fixtureInfo(home = '/fixture', profile = '', target = '/fixture/codex', passed = false) {
  const model = `model-${home}`, provider = 'local', endpoint = `http://127.0.0.1:8787/${encodeURIComponent(home)}/responses`;
  const report = { createdAt: new Date().toISOString(), model, provider, endpoint, contextHash: home + profile,
    samples: ['function-flat', 'custom-flat', 'custom-namespace', 'custom-additional'].flatMap(kind => [1, 2].map(round => ({ kind, round, result: passed || kind.endsWith('flat') ? 'pass' : 'no-tool' }))),
    summary: { patchRecommended: !passed, blockers: passed ? [{ message: '未发现命名空间特有的格式问题。' }] : [], warnings: [] } };
  const binaries = [{ path: target, sha256: target, version: 'fixture' }];
  const plan = { home, profile, model, binaries, contextHash: report.contextHash, report: { createdAt: report.createdAt }, catalogPath: '/fixture/candidate.json' };
  return { home, profile, target, binaries, bundledModel: { use_responses_lite: true }, patch: { model, provider, endpoint, state: 'unpatched', patched: false }, report, plan };
}
async function browser(t, run) {
  const calls = [], nodes = new Map();
  const gui = await startGui({ home: '/fixture' }, {
    run,
    guardInstall: async () => ({ installed: true }),
    guardUninstall: async () => ({ installed: false }),
  });
  t.after(() => gui.close());
  function element() {
    const listeners = new Map(), classes = new Set();
    return { value: '', textContent: '', checked: false, disabled: false, title: '', children: [], dataset: {},
      classList: { toggle(name, value) { if (value) classes.add(name); else classes.delete(name); }, remove(name) { classes.delete(name); }, contains(name) { return classes.has(name); } },
      addEventListener(type, fn) { listeners.set(type, fn); },
      dispatch(type) { return listeners.get(type)?.(); },
      click() { if (!this.disabled) return this.dispatch('click'); },
      replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); } };
  }
  for (const [, id] of markup.matchAll(/\bid="([^"]+)"/g)) nodes.set(id, element());
  const buttons = [...markup.matchAll(/data-command="([^"]+)"/g)].map(([, command]) => Object.assign(element(), { dataset: { command } }));
  const get = id => { assert.ok(nodes.has(id), `Missing actual page element: ${id}`); return nodes.get(id); };
  get('repeats').value = '2'; get('timeout').value = '30';
  const context = vm.createContext({
    document: { getElementById: get, createElement: element, querySelectorAll: () => buttons },
    location: { hash: `#${gui.token}`, pathname: '/' }, history: { replaceState() {} },
    sessionStorage: { setItem() {}, getItem: () => gui.token }, URL, Blob,
    setTimeout: fn => setTimeout(fn, 0),
    fetch: (path, init) => { if (path === '/api/run') calls.push(JSON.parse(init.body)); return fetch(gui.origin + path, init); },
  });
  vm.runInContext(browserSource, context);
  await until(() => calls.length > 0 && get('job-status').textContent === '就绪');
  return { get, calls, button: command => buttons.find(b => b.dataset.command === command),
    change(id, value) { get(id).value = value; get(id).dispatch('input'); } };
}

test('GUI changes clear old artifacts; diagnosis reads the selected context without extra probes', async t => {
  let info = fixtureInfo();
  const b = await browser(t, async (command, options) => {
    if (command === 'inspect') { info = fixtureInfo(options.home, options.profile || '', options.binary || '/fixture/codex'); return info; }
    if (command === 'diagnose') return info.report;
    if (command === 'plan') return info.plan;
    assert.fail(`Unexpected command: ${command}`);
  });
  assert.equal(b.button('apply').disabled, false);
  for (const [field, value] of [['home', '/other-home'], ['profile', 'work'], ['binary', '/other-codex']]) {
    b.change(field, value);
    assert.equal(b.get('download-report').disabled, true);
    assert.equal(b.button('plan').disabled, true);
    assert.equal(b.button('apply').disabled, true);
    assert.equal(b.get('endpoint').textContent, '等待读取');
    assert.ok(!b.get('plan').textContent.includes('/fixture/candidate.json'));
    await b.button('inspect').click();
    assert.equal(b.button('apply').disabled, true, 'inspect must not resurrect a discarded plan');
    const before = b.calls.length;
    await b.button('diagnose').click();
    assert.deepEqual(b.calls.slice(before).map(c => c.command), ['inspect', 'diagnose']);
    assert.equal(b.get('endpoint').textContent, info.patch.endpoint);
    assert.equal(b.get('model').textContent, info.patch.model);
    assert.equal(b.button('plan').disabled, false);
    assert.equal(b.button('apply').disabled, true);
    await b.button('plan').click();
    assert.equal(b.button('apply').disabled, false);
  }
});

test('healthy diagnosis and guard operations have accurate Chinese completion messages', async t => {
  const info = fixtureInfo('/fixture', '', '/fixture/codex', true);
  const b = await browser(t, async command => command === 'inspect' ? info : info.report);
  await b.button('diagnose').click();
  assert.match(b.get('notice').textContent, /全部通过.*暂不需要/);
  assert.ok(!b.get('notice').classList.contains('error'));
  assert.ok(!b.get('decision').textContent.includes('阻止'));
  assert.ok(!b.get('decision').classList.contains('fail'));
  assert.equal(b.button('plan').disabled, true);
  assert.equal(b.button('apply').disabled, true);
  assert.match(b.button('guard-install').title, /立即启动/);
  const before = b.calls.length;
  await b.button('guard-install').click();
  assert.match(b.get('notice').textContent, /已启用并立即启动.*登录时自动运行/);
  assert.ok(!b.get('notice').textContent.includes('重启Codex'));
  await b.button('guard-uninstall').click();
  assert.match(b.get('notice').textContent, /已停止并移除/);
  assert.deepEqual(b.calls.slice(before).map(c => c.command), ['guard-install', 'guard-uninstall']);
});

for (const command of ['apply', 'maintain', 'repair', 'rollback', 'recover']) {
  test(`GUI ${command} refreshes actual status using inspect only`, async t => {
    const info = fixtureInfo();
    const b = await browser(t, async action => {
      if (action === 'inspect') return info;
      assert.equal(action, command);
      const installed = !['rollback', 'recover'].includes(command);
      info.patch = { ...info.patch, state: installed ? 'verified' : 'unpatched', patched: installed, verifiedAt: installed ? '2026-09-09T06:00:00Z' : null };
      info.plan = null;
      return installed ? { state: 'refreshed', backupPath: '/fixture/backup' } : { recovered: true, restored: true };
    });
    const before = b.calls.length;
    await b.button(command).click();
    assert.deepEqual(b.calls.slice(before).map(c => c.command), [command, 'inspect']);
    assert.equal(b.get('patch-state').textContent, info.patch.patched ? '已验证并安装' : '尚未安装');
    assert.equal(b.button('apply').disabled, true);
    assert.ok(!b.get('plan').textContent.includes('/fixture/candidate.json'));
    assert.ok(!b.get('result').textContent.includes('bundledModel'), 'retain the operation result instead of replacing it with inspect');
  });
}

test('GUI refreshes after failed maintenance and does not report a successful install as failed when refresh fails', async t => {
  const info = fixtureInfo();
  let refreshFails = false;
  const b = await browser(t, async command => {
    if (command === 'inspect') { if (refreshFails) throw new Error('状态暂时不可读'); return info; }
    if (command === 'maintain') { info.patch.state = 'conflict'; throw new Error('目录发生冲突'); }
    if (command === 'repair') { refreshFails = true; return { backupPath: '/fixture/backup' }; }
    assert.fail(command);
  });
  await b.button('maintain').click();
  assert.match(b.get('notice').textContent, /目录发生冲突/);
  assert.equal(b.get('patch-state').textContent, '发现配置冲突');
  await b.button('repair').click();
  assert.match(b.get('notice').textContent, /补丁已验证并安装/);
  assert.match(b.get('notice').textContent, /实际状态刷新失败/);
  assert.equal(b.get('patch-state').textContent, '未检测');
  assert.equal(b.button('apply').disabled, true);
  assert.match(b.get('result').textContent, /fixture\/backup/);
});

test('GUI missing configuration is actionable and can recover after changing home', async t => {
  const b = await browser(t, async (_, options) => {
    if (options.home === '/fixture') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: '/fixture/config.toml' });
    return fixtureInfo(options.home);
  });
  assert.match(b.get('notice').textContent, /未找到Codex配置文件.*请选择已有Codex配置目录/);
  assert.equal(b.button('apply').disabled, true);
  assert.equal(b.get('home').disabled, false);
  b.change('home', '/valid-home');
  await b.button('inspect').click();
  assert.match(b.get('notice').textContent, /配置已读取/);
  assert.equal(b.get('model').textContent, 'model-/valid-home');
});

test('GUI API translates missing reports/plans, profile files and permission errors', async t => {
  const errors = {
    plan: Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: '/fixture/last-report.json' }),
    apply: Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: '/fixture/last-plan.json' }),
    inspect: Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: 'C:\\fixture\\work.config.toml' }),
    verify: Object.assign(new Error('EACCES'), { code: 'EACCES', path: '/fixture/private' }),
  };
  const gui = await startGui({ home: '/fixture' }, { run: async command => { throw errors[command]; } });
  t.after(() => gui.close());
  for (const [command, expected] of [['plan', /未找到诊断报告.*开始诊断/], ['apply', /未找到候选计划.*生成计划/], ['inspect', /未找到Codex配置文件.*<名称>\.config\.toml/], ['verify', /没有访问权限/]]) {
    await fetch(gui.origin + '/api/run', { method: 'POST', headers: { 'x-doctor-token': gui.token, 'content-type': 'application/json' }, body: JSON.stringify({ command }) });
    let job;
    for (let i = 0; i < 100; i++) { job = await (await fetch(gui.origin + '/api/job', { headers: { 'x-doctor-token': gui.token } })).json(); if (job.state !== 'running') break; await delay(5); }
    assert.equal(job.state, 'error');
    assert.match(job.error, expected);
    assert.ok(!job.error.includes('ENOENT'));
  }
});
