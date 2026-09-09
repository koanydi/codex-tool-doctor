import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import vm from 'node:vm';

const bootstrap = new vm.Script(await readFile(new URL('../scripts/bootstrap-windows.js', import.meta.url), 'utf8'), {
  filename: 'bootstrap-windows.js',
});
const root = String.raw`C:\fixture project 中文`;
const cache = String.raw`C:\fixture cache 中文`;
const system = String.raw`C:\Windows\System32`;
const systemNode = String.raw`C:\Program Files\fixture node\node.exe`;
const archiveBody = 'deterministic fixture archive; not a real executable';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const archiveName = version => `node-${version}-win-x64.zip`;
const cachedNode = version => `${cache}\\node-${version}-win-x64\\node.exe`;
const downloadUrls = version => ['https://nodejs.org/dist/', 'https://nodejs.org/download/release/']
  .map(base => `${base}${version}/${archiveName(version)}`);

// Only read the real script. Every WSH filesystem, process, download and clock
// interaction below is a synchronous in-memory substitute; no COM is invoked.
function fixture({ transport = 'curl', download = 'ok', extractionFails = false, versions = ['v24.1.0'] } = {}) {
  const files = new Map(), folders = new Set();
  const pathKey = path => win32.normalize(path).toLowerCase();
  let trace, serial = 0;
  function seedFile(path, value) {
    files.set(pathKey(path), value);
    let parent = win32.dirname(path);
    while (!folders.has(pathKey(parent))) {
      folders.add(pathKey(parent));
      parent = win32.dirname(parent);
    }
  }
  function addRuntime(path, version, npm = true) {
    seedFile(path, { version });
    if (npm) seedFile(`${win32.dirname(path)}\\node_modules\\npm\\bin\\npm-cli.js`, '10.0.0');
  }
  function unexpected(message) {
    // Bootstrap catches operational errors, so also assert this list after VM
    // execution to prevent an incomplete mock from passing a failure test.
    trace.unexpected.push(message);
    throw new Error(message);
  }
  const fs = {
    GetParentFolderName: win32.dirname,
    FileExists: path => files.has(pathKey(path)),
    FolderExists: path => folders.has(pathKey(path)),
    GetFolder(path) {
      const base = pathKey(path);
      if (!folders.has(base)) throw new Error('Folder not found.');
      const childCount = entries => [...entries]
        .filter(name => name !== base && win32.dirname(name) === base).length;
      return {
        Files: { get Count() { return childCount(files.keys()); } },
        SubFolders: { get Count() { return childCount(folders); } },
      };
    },
    OpenTextFile(path) {
      if (!files.has(pathKey(path))) return unexpected(`Unexpected file read: ${path}`);
      return { ReadAll: () => files.get(pathKey(path)), Close() {} };
    },
    CreateTextFile(path, overwrite = true) {
      const name = pathKey(path);
      if (!folders.has(pathKey(win32.dirname(path)))) return unexpected(`Missing parent: ${path}`);
      if (files.has(name) && !overwrite) throw new Error('File already exists.');
      files.set(name, '');
      trace.events.push({ type: 'create-file', path });
      let closed = false;
      const write = value => {
        if (closed) return unexpected(`Writing a closed stream: ${path}`);
        files.set(name, files.get(name) + String(value));
      };
      return {
        Write: write,
        WriteLine: (value = '') => write(String(value) + '\r\n'),
        Close() { closed = true; trace.events.push({ type: 'close-file', path }); },
      };
    },
    GetTempName: () => `fixture-${++serial}.tmp`,
    CreateFolder(path) {
      if (folders.has(pathKey(path))) throw new Error('Folder already exists.');
      if (!folders.has(pathKey(win32.dirname(path)))) return unexpected(`Missing parent: ${path}`);
      trace.events.push({ type: 'mkdir', path });
      folders.add(pathKey(path));
    },
    DeleteFile(path) {
      // Releasing an owner file must fail if another owner has replaced it.
      if (!files.has(pathKey(path))) throw new Error('File not found.');
      trace.events.push({ type: 'delete-file', path });
      files.delete(pathKey(path));
    },
    DeleteFolder(path) {
      trace.events.push({ type: 'delete-folder', path });
      const base = pathKey(path);
      for (const name of [...files.keys()]) if (name.startsWith(base + '\\')) files.delete(name);
      for (const name of [...folders]) if (name === base || name.startsWith(base + '\\')) folders.delete(name);
    },
    MoveFolder(source, destination) {
      if (!folders.has(pathKey(source)) || folders.has(pathKey(destination))) return unexpected('Invalid folder move.');
      trace.events.push({ type: 'move', source, destination });
      const from = pathKey(source), to = pathKey(destination);
      for (const [name, value] of [...files]) {
        if (name.startsWith(from + '\\')) { files.delete(name); files.set(to + name.slice(from.length), value); }
      }
      for (const name of [...folders]) {
        if (name === from || name.startsWith(from + '\\')) { folders.delete(name); folders.add(to + name.slice(from.length)); }
      }
    },
  };
  seedFile(`${root}\\scripts\\node-runtimes.txt`, versions
    .map(version => `${version} ${archiveName(version)} ${sha256(archiveBody)}`).join('\r\n'));
  for (const tool of ['tar.exe', 'certutil.exe', ...(transport === 'curl' ? ['curl.exe'] : [])]) seedFile(`${system}\\${tool}`, '');
  const env = {
    SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\fixture user',
    TOOL_DOCTOR_RUNTIME_DIR: cache, PROCESSOR_ARCHITECTURE: 'AMD64',
    PATH: win32.dirname(systemNode),
  };
  const completed = (output, code = 0) => ({
    Status: 1, ExitCode: code, StdOut: { ReadAll: () => output }, StdErr: { ReadAll: () => '' },
  });
  // Fixture arguments have no embedded quotes; preserve spaces and Unicode.
  const tokens = command => [...command.matchAll(/"([^"]*)"|(\S+)/g)].map(match => match[1] ?? match[2]);
  function fetchArchive(url) {
    trace.events.push({ type: 'download', url });
    if (!versions.some(version => downloadUrls(version).includes(url))) return unexpected(`Unexpected URL: ${url}`);
    return {
      status: download === 'alternate' && url.startsWith('https://nodejs.org/dist/') ? 503 : 200,
      body: download === 'bad-hash' ? 'corrupt archive bytes' : archiveBody,
    };
  }
  const shell = {
    CurrentDirectory: root,
    Environment: () => name => env[name] || '',
    Exec(command) {
      const args = tokens(command), executable = args[0];
      if (pathKey(executable) === pathKey(`${system}\\certutil.exe`)) {
        const value = files.get(pathKey(args[2]));
        if (typeof value !== 'string' || args[1] !== '-hashfile' || args[3] !== 'SHA256') return unexpected(`Invalid checksum command: ${command}`);
        trace.events.push({ type: 'hash', path: args[2] });
        return completed(`SHA256 hash:\r\n${sha256(value)}\r\nCertUtil: completed.\r\n`);
      }
      if (win32.basename(executable) === 'node.exe' && files.has(pathKey(executable))) {
        trace.events.push({ type: 'node', args });
        if (args.length === 2 && args[1] === '--version') return completed(files.get(pathKey(executable)).version + '\r\n');
        if (args.length === 3 && args[1] === `${win32.dirname(executable)}\\node_modules\\npm\\bin\\npm-cli.js` && args[2] === '--version') {
          return completed('10.0.0\r\n', files.has(pathKey(args[1])) ? 0 : 1);
        }
      }
      return unexpected(`Unexpected process (application launch forbidden): ${command}`);
    },
    Run(command, windowStyle, wait) {
      const args = tokens(command);
      if (windowStyle !== 0 || wait !== true) return unexpected(`Unexpected process mode: ${command}`);
      if (pathKey(args[0]) === pathKey(`${system}\\curl.exe`) && transport === 'curl') {
        const result = fetchArchive(args.at(-1)), destination = args[args.indexOf('--output') + 1];
        files.set(pathKey(destination), result.status === 200 ? result.body : 'partial download');
        return result.status === 200 ? 0 : 22;
      }
      if (pathKey(args[0]) === pathKey(`${system}\\tar.exe`) && args[1] === '-xf') {
        if (args.length !== 3 || !/^[\x20-\x7e]+$/.test(args[2]) || win32.isAbsolute(args[2])) return unexpected('Tar must receive only an ASCII relative archive name.');
        const stage = shell.CurrentDirectory, archive = win32.join(stage, args[2]);
        trace.events.push({ type: 'extract', archive, stage });
        if (!files.has(pathKey(archive))) return unexpected('Extracting a missing archive.');
        if (extractionFails) return 1;
        const name = win32.basename(archive, '.zip'), version = name.slice(5, -8);
        addRuntime(`${stage}\\${name}\\node.exe`, version);
        return 0;
      }
      return unexpected(`Unexpected process (application launch forbidden): ${command}`);
    },
  };
  function ActiveXObject(name) {
    if (name === 'WScript.Shell') return shell;
    if (name === 'Scripting.FileSystemObject') return fs;
    if (name === 'MSXML2.ServerXMLHTTP.6.0' && transport === 'msxml') return {
      setTimeouts() {},
      open(method, url, async) {
        if (method !== 'GET' || async !== false) return unexpected('Unexpected HTTP mode.');
        this.url = url;
      },
      send() { const result = fetchArchive(this.url); this.status = result.status; this.responseBody = result.body; },
    };
    if (name === 'ADODB.Stream' && transport === 'msxml') return {
      Open() {}, Close() {}, Write(body) { this.body = body; },
      SaveToFile(path) { files.set(pathKey(path), this.body); },
    };
    return unexpected(`Unexpected ActiveX object: ${name}`);
  }
  return {
    addRuntime,
    temporaryPaths: () => [...folders, ...files.keys()].filter(path => /\\setup-|\.lock(?:[.\\-]|$)/.test(path)),
    run(args = []) {
      trace = { stdout: [], stderr: [], exits: [], events: [], unexpected: [] };
      const Arguments = Object.defineProperty(index => args[index], 'length', { value: args.length });
      // GetObject/WMI is intentionally absent: the real bootstrap must use its
      // unknown-owner fallback. These scenarios never contend for an existing lock.
      bootstrap.runInNewContext({ ActiveXObject, WScript: {
        ScriptFullName: `${root}\\scripts\\bootstrap-windows.js`, Arguments,
        Echo: value => trace.stdout.push(String(value)),
        StdErr: { WriteLine: value => trace.stderr.push(String(value)) },
        // Quit is the final statement of either WSH entry-point branch.
        Quit: code => trace.exits.push(code), Sleep: () => unexpected('Unexpected wait in synchronous fixture.'),
      } }, { timeout: 1000 });
      assert.deepEqual(trace.unexpected, []);
      assert.equal(shell.CurrentDirectory, root, 'working directory must be restored on success and failure');
      return trace;
    },
  };
}

const eventsOf = (result, type) => result.events.filter(event => event.type === type);

test('WSH extraction failure restores the working directory, cleans staging and never publishes Node', () => {
  const f = fixture({ extractionFails: true });
  const result = f.run();
  assert.deepEqual(result.exits, [1]);
  assert.deepEqual(result.stdout, []);
  assert.match(result.stderr.join('\n'), /archive extraction failed \(tar exit 1\)/);
  assert.equal(eventsOf(result, 'extract').length, 1);
  assert.equal(eventsOf(result, 'move').filter(event => !event.destination.endsWith('.lock')).length, 0);
  assert.deepEqual(f.temporaryPaths(), []);
});

for (const transport of ['curl', 'msxml']) {
  test(`WSH ${transport}: failed primary download uses official alternate, then reuses the installed cache`, () => {
    const f = fixture({ transport, download: 'alternate' });
    const result = f.run();
    assert.deepEqual(result.exits, [0], result.stderr.join('\n'));
    assert.deepEqual(result.stdout, [cachedNode('v24.1.0')]);
    assert.deepEqual(eventsOf(result, 'download').map(event => event.url), downloadUrls('v24.1.0'));
    assert.equal(eventsOf(result, 'hash').length, 1);
    assert.equal(eventsOf(result, 'extract').length, 1);
    assert.ok(result.events.findIndex(event => event.type === 'hash') < result.events.findIndex(event => event.type === 'extract'));
    assert.match(result.stderr.join('\n'), /download.*(?:22|503)/);
    assert.ok(result.stderr.every(line => line.startsWith('[Codex Tool Doctor] ')));
    assert.deepEqual(f.temporaryPaths(), []);

    const reused = f.run();
    assert.deepEqual(reused.exits, [0]);
    assert.deepEqual(reused.stdout, [cachedNode('v24.1.0')]);
    assert.deepEqual(reused.stderr, []);
    assert.ok(reused.events.length > 0 && reused.events.every(event => event.type === 'node'));
  });

  test(`WSH ${transport}: SHA256 mismatch on both routes never extracts, executes or selects the downloaded Node`, () => {
    const f = fixture({ transport, download: 'bad-hash' });
    const result = f.run();
    assert.deepEqual(result.exits, [1]);
    assert.deepEqual(result.stdout, []);
    assert.deepEqual(eventsOf(result, 'download').map(event => event.url), downloadUrls('v24.1.0'));
    assert.equal(eventsOf(result, 'hash').length, 2);
    for (const type of ['extract', 'node']) assert.deepEqual(eventsOf(result, type), []);
    // Publishing the prepared lock is allowed; publishing a runtime is not.
    assert.deepEqual(eventsOf(result, 'move').filter(event => !event.destination.endsWith('.lock')), []);
    assert.equal(eventsOf(result, 'delete-file').filter(event => event.path.endsWith('.zip')).length, 2);
    assert.match(result.stderr.join('\n'), /SHA256 mismatch; downloaded runtime was rejected/);
    assert.deepEqual(f.temporaryPaths(), []);
  });
}

test('WSH rejects old PATH and cached Node versions and reuses a supported cached release before downloading', () => {
  const f = fixture({ versions: ['v24.1.0', 'v22.1.0'] });
  f.addRuntime(systemNode, 'v20.19.0');
  f.addRuntime(cachedNode('v24.1.0'), 'v20.19.0');
  f.addRuntime(cachedNode('v22.1.0'), 'v22.1.0');
  const result = f.run();
  assert.deepEqual(result.exits, [0]);
  assert.deepEqual(result.stdout, [cachedNode('v22.1.0')]);
  assert.deepEqual(eventsOf(result, 'node').map(event => event.args), [
    [systemNode, '--version'], [cachedNode('v24.1.0'), '--version'], [cachedNode('v22.1.0'), '--version'],
    [cachedNode('v22.1.0'), `${win32.dirname(cachedNode('v22.1.0'))}\\node_modules\\npm\\bin\\npm-cli.js`, '--version'],
  ]);
  assert.ok(result.events.every(event => event.type === 'node'));
  assert.deepEqual(result.stderr, []);
  assert.deepEqual(f.temporaryPaths(), []);
});

test('WSH --with-npm rejects a usable system Node without npm and selects the complete cache', () => {
  const f = fixture();
  f.addRuntime(systemNode, 'v22.1.0', false);
  f.addRuntime(cachedNode('v24.1.0'), 'v24.1.0');
  const ordinary = f.run();
  assert.deepEqual(ordinary.exits, [0]);
  assert.deepEqual(ordinary.stdout, [systemNode]);
  assert.deepEqual(eventsOf(ordinary, 'node').map(event => event.args), [[systemNode, '--version']]);

  const withNpm = f.run(['--with-npm']);
  assert.deepEqual(withNpm.exits, [0]);
  assert.deepEqual(withNpm.stdout, [cachedNode('v24.1.0')]);
  assert.ok(eventsOf(withNpm, 'node').some(event => event.args[0] === systemNode && event.args.length === 3));
  for (const result of [ordinary, withNpm]) {
    assert.ok(result.events.every(event => event.type === 'node'));
    assert.deepEqual(result.stderr, []);
  }
});
