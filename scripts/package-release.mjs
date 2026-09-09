import { readFile, readdir, mkdir, writeFile, lstat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const project = fileURLToPath(new URL('../', import.meta.url));
const files = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json',
  'doctor.cmd', 'doctor-gui.cmd', 'doctor.sh', 'doctor-gui.sh', 'doctor.command',
  'scripts/bootstrap-windows.js', 'scripts/bootstrap-posix.sh', 'scripts/launch.mjs', 'scripts/node-runtimes.txt', 'scripts/prepare-catalog.mjs'];
const trees = ['src', 'docs', 'node_modules/smol-toml'];
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

// ZIP headers use a fixed date and sorted paths for reproducible release hashes.
export function zipArchive(entries) {
  const chunks = [], central = []; let offset = 0;
  for (const entry of [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const name = Buffer.from(entry.name), data = entry.data, compressed = deflateRawSync(data, { level: 9 }), crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    chunks.push(header, name, compressed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10); record.writeUInt16LE(33, 14);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(((0o100000 | entry.mode) << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42); central.push(record, name); offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

export async function packageRelease(root = project, output = join(root, 'dist')) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const installed = JSON.parse(await readFile(join(root, 'node_modules/smol-toml/package.json'), 'utf8'));
  if (installed.version !== pkg.dependencies['smol-toml']) throw new Error('依赖版本不匹配，请先运行npm ci --ignore-scripts。');
  const selected = [...files];
  async function walk(directory) {
    for (const item of await readdir(join(root, directory), { withFileTypes: true })) {
      if (item.name.startsWith('.')) continue;
      const path = join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error(`发布目录不能包含符号链接：${path}`);
      if (item.isDirectory()) await walk(path);
      else if (item.isFile()) selected.push(path);
    }
  }
  for (const directory of trees) await walk(directory);
  const entries = [];
  for (const path of selected) {
    if (!(await lstat(join(root, path))).isFile()) throw new Error(`发布文件无效：${path}`);
    const normalized = relative(root, resolve(root, path)).replaceAll('\\', '/');
    entries.push({ name: `codex-tool-doctor/${normalized}`, data: await readFile(join(root, path)), mode: /\.(sh|command)$/.test(path) ? 0o755 : 0o644 });
  }
  await mkdir(output, { recursive: true });
  const name = `codex-tool-doctor-v${pkg.version}.zip`, path = join(output, name), archive = zipArchive(entries);
  await writeFile(path, archive);
  const sha256 = createHash('sha256').update(archive).digest('hex');
  await writeFile(join(output, 'SHA256SUMS.txt'), `${sha256}  ${name}\n`);
  return { path, sha256, files: entries.length, bytes: archive.length };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  packageRelease().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
