import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardSpec, runGuard } from '../src/guard.mjs';
import { macCandidates } from '../src/binaries.mjs';

test('service definitions preserve spaces and escape platform syntax', () => {
  const options = { home: '/Users/test account/.codex', node: '/Program Files/Node/node', script: '/apps/A&B/tool/cli.mjs', profile: 'work', binary: '/apps/Codex App/codex' };
  const win = guardSpec('win32', options); assert.match(win.content, /A&amp;B/); assert.match(win.content, /IgnoreNew/); assert.ok(win.content.includes('&quot;'));
  const mac = guardSpec('darwin', options); assert.match(mac.content, /ProgramArguments/); assert.match(mac.content, /A&amp;B/); assert.match(mac.content, /RunAtLoad/);
  const linux = guardSpec('linux', { ...options, script: '/apps/$HOME/100%/cli.mjs' }); assert.match(linux.content, /\$\$HOME/); assert.match(linux.content, /100%%/); assert.match(linux.content, /Restart=on-failure/);
  assert.ok(macCandidates('/Users/test').includes('/Applications/Codex.app/Contents/Resources/codex'));
});
test('guard does not touch unmanaged configurations and records errors', async t => {
  const home = await mkdtemp(join(tmpdir(), 'doctor-guard-')); t.after(() => rm(home, { recursive: true, force: true }));
  await runGuard({ home, once: true }, () => {}, { run: async command => { assert.equal(command, 'maintain'); throw new Error('fixture failure'); } });
  const result = JSON.parse(await readFile(join(home, 'tool-doctor', 'last-guard.json'), 'utf8'));
  assert.equal(result.state, 'attention-required'); assert.ok(result.retryAt);
});
