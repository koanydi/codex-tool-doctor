import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { packageRelease } from '../scripts/package-release.mjs';

test('release ZIP is reproducible, contains launchers/dependencies and excludes developer or secret files', async t => {
  const output = await mkdtemp(join(tmpdir(), 'doctor-release-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const first = await packageRelease(root, output), zip = await readFile(first.path), entries = new Map();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18), nameSize = zip.readUInt16LE(offset + 26);
    const name = zip.subarray(offset + 30, offset + 30 + nameSize).toString('utf8');
    const body = inflateRawSync(zip.subarray(offset + 30 + nameSize, offset + 30 + nameSize + size));
    entries.set(name.replace('codex-tool-doctor/', ''), body);
    offset += 30 + nameSize + size;
  }
  for (const file of ['doctor.cmd', 'doctor.command', 'src/cli.mjs', 'src/web/index.html', 'scripts/launch.mjs',
    'scripts/bootstrap-posix.sh', 'scripts/bootstrap-windows.js', 'node_modules/smol-toml/dist/index.js', 'node_modules/smol-toml/LICENSE', 'docs/使用指南.md']) {
    assert.deepEqual(entries.get(file), await readFile(join(root, file)), file);
  }
  assert.ok(![...entries.keys()].some(name => /(^|\/)(test|\.git|\.scratch|output|archive)(\/|$)|mock-router|gui-fixture|check-bootstrap|server-key|auth\.json/.test(name)));
  assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  assert.equal((await packageRelease(root, output)).sha256, first.sha256);
  assert.match(await readFile(join(output, 'SHA256SUMS.txt'), 'utf8'), new RegExp(first.sha256));
});
