// ES3 JScript: runs with built-in cscript, without Node.js or PowerShell.
// ASCII source keeps Windows Script Host independent of the system code page.
function quote(value) {
    return '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}
function runtimeSupported(version) { return /^v(\d+)\./.test(version) && Number(RegExp.$1) >= 22; }
function parseManifest(source, arch) {
    var result = [], lines = source.split(/\r?\n/), i, parts;
    for (i = 0; i < lines.length; i++) {
        parts = lines[i].replace(/^\s+|\s+$/g, '').split(/\s+/);
        if (parts.length === 3 && /^v\d+\.\d+\.\d+$/.test(parts[0]) && /^[a-f0-9]{64}$/.test(parts[2]) &&
            parts[1] === 'node-' + parts[0] + '-win-' + arch + '.zip') result.push({ version: parts[0], file: parts[1], hash: parts[2] });
    }
    return result;
}
function main() {
    var shell = new ActiveXObject('WScript.Shell'), fs = new ActiveXObject('Scripting.FileSystemObject');
    var env = shell.Environment('PROCESS'), root = fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName));
    var system = env('SystemRoot') + '\\System32', cache = env('TOOL_DOCTOR_RUNTIME_DIR') || env('LOCALAPPDATA') + '\\CodexToolDoctor\\runtimes';
    var archValue = (env('PROCESSOR_ARCHITEW6432') || env('PROCESSOR_ARCHITECTURE')).toLowerCase();
    var arch = archValue === 'arm64' ? 'arm64' : archValue === 'amd64' ? 'x64' : '';
    var requireNpm = false, selectionFile = '';
    var i, pathParts, candidate, entries, lastError = '';
    for (i = 0; i < WScript.Arguments.length; i++) {
        if (WScript.Arguments(i) === '--with-npm') requireNpm = true;
        if (WScript.Arguments(i) === '--selection-file' && i + 1 < WScript.Arguments.length) selectionFile = WScript.Arguments(++i);
    }
    function log(message) { WScript.StdErr.WriteLine('[Codex Tool Doctor] ' + message); }
    function mkdir(path) { if (!fs.FolderExists(path)) { mkdir(fs.GetParentFolderName(path)); try { fs.CreateFolder(path); } catch (error) { if (!fs.FolderExists(path)) throw error; } } }
    function read(path) { var stream = fs.OpenTextFile(path, 1), value = stream.ReadAll(); stream.Close(); return value; }
    function remove(path) { if (fs.FolderExists(path)) fs.DeleteFolder(path, true); else if (fs.FileExists(path)) fs.DeleteFile(path, true); }
    function cleanup(path) {
        if (!path) return;
        try { remove(path); } catch (error) { log('Cleanup failed for ' + path + ': ' + error.message); }
    }
    function commandLine(value) {
        if (value.indexOf('%') < 0) return value;
        // WSH expands environment variables even inside quoted arguments. Its
        // expansion is single-pass: this private variable restores literal %.
        env('TOOL_DOCTOR_LITERAL_PERCENT') = '%';
        return value.replace(/%/g, '%TOOL_DOCTOR_LITERAL_PERCENT%');
    }
    var wmi = null, wmiChecked = false;
    function processService() {
        if (!wmiChecked) {
            wmiChecked = true;
            try { wmi = GetObject('winmgmts:{impersonationLevel=impersonate}!\\\\.\\root\\cimv2'); }
            catch (error) { /* WMI may be unavailable, including in VM tests. */ }
        }
        return wmi;
    }
    function installerIdentity() {
        if (!selectionFile) return null;
        try {
            var service = processService();
            if (!service) return null;
            var processes = new Enumerator(service.ExecQuery("SELECT ProcessId, CreationDate, CommandLine FROM Win32_Process WHERE Name = 'cscript.exe'"));
            var result = null, selection = selectionFile.toLowerCase(), script = WScript.ScriptFullName.toLowerCase();
            for (; !processes.atEnd(); processes.moveNext()) {
                var item = processes.item(), line = String(item.CommandLine || '').toLowerCase();
                var selectionArg = line.indexOf('"' + selection + '"') >= 0 || (' ' + line + ' ').indexOf(' ' + selection + ' ') >= 0;
                if (line.indexOf(script) < 0 || line.indexOf('--selection-file') < 0 || !selectionArg) continue;
                if (result) return null; // Never guess when identification is ambiguous.
                var pid = String(item.ProcessId), created = String(item.CreationDate);
                if (!/^[1-9][0-9]*$/.test(pid) || !/^[0-9]{14}\.[0-9]{6}[+-][0-9]{3}$/.test(created)) return null;
                result = { pid: pid, created: created };
            }
            return result;
        } catch (error) { return null; }
    }
    function releaseLock(lock, marker) {
        // DeleteFile must succeed for this exact generation before touching the
        // parent. An empty lock is never reclaimed by another waiter, so no new
        // owner can publish between these two operations (FSO will not replace it).
        fs.DeleteFile(lock + '\\' + marker, true);
        var folder = fs.GetFolder(lock);
        if (folder.Files.Count !== 0 || folder.SubFolders.Count !== 0) throw new Error('Runtime lock is not empty: ' + lock);
        fs.DeleteFolder(lock, true);
    }
    function reclaimLock(lock) {
        try {
            var service = processService();
            if (!service) return false;
            var folder = fs.GetFolder(lock);
            if (folder.Files.Count !== 1 || folder.SubFolders.Count !== 0) return false;
            var files = new Enumerator(folder.Files), marker = String(files.item().Name);
            if (!/^owner-[a-z0-9.-]+\.txt$/i.test(marker)) return false;
            var owner = /^([1-9][0-9]*)\r?\n([0-9]{14}\.[0-9]{6}[+-][0-9]{3})\s*$/.exec(read(lock + '\\' + marker));
            if (!owner) return false;
            var processes = new Enumerator(service.ExecQuery('SELECT CreationDate FROM Win32_Process WHERE ProcessId = ' + owner[1]));
            for (; !processes.atEnd(); processes.moveNext()) {
                var created = String(processes.item().CreationDate || '');
                if (!/^[0-9]{14}\.[0-9]{6}[+-][0-9]{3}$/.test(created) || created === owner[2]) return false;
            }
            releaseLock(lock, marker);
            return true;
        } catch (error) { return false; }
    }
    function captured(command, timeout) {
        var process = shell.Exec(commandLine(command)), start = new Date().getTime();
        while (process.Status === 0) {
            if (new Date().getTime() - start > timeout) { process.Terminate(); throw new Error('Command timed out.'); }
            WScript.Sleep(50);
        }
        return { code: process.ExitCode, output: process.StdOut.ReadAll() + process.StdErr.ReadAll() };
    }
    function validNode(path, requireNpm) {
        try {
            if (!fs.FileExists(path)) return false;
            var result = captured(quote(path) + ' --version', 15000);
            if (result.code !== 0 || !runtimeSupported(result.output.replace(/\s+$/, ''))) return false;
            if (requireNpm) {
                result = captured(quote(path) + ' ' + quote(fs.GetParentFolderName(path) + '\\node_modules\\npm\\bin\\npm-cli.js') + ' --version', 30000);
                if (result.code !== 0) return false;
            }
            return true;
        } catch (error) { return false; }
    }
    function selected(node) {
        if (!selectionFile) { WScript.Echo(node); return 0; }
        // FOR /F decodes redirected WSH output in the OEM code page, corrupting
        // Unicode paths. A UTF-8 batch file is read with doctor.cmd's code page.
        var stream = new ActiveXObject('ADODB.Stream'); stream.Type = 2; stream.Charset = 'utf-8'; stream.Open();
        stream.WriteText('@set "DOCTOR_NODE=' + node.replace(/%/g, '%%') + '"\r\n');
        stream.Position = 0; stream.Type = 1; stream.Position = 3;
        var binary = new ActiveXObject('ADODB.Stream'); binary.Type = 1; binary.Open();
        stream.CopyTo(binary); binary.SaveToFile(selectionFile, 2); binary.Close(); stream.Close();
        return 0;
    }
    function download(url, destination) {
        var curl = system + '\\curl.exe';
        if (fs.FileExists(curl)) {
            var exit = shell.Run(commandLine(quote(curl) + ' -q --fail --silent --show-error --location --proto =https --proto-redir =https --connect-timeout 20 --max-time 240 --retry 1 --retry-delay 2 --output ' + quote(destination) + ' ' + quote(url)), 0, true);
            if (exit !== 0) throw new Error('HTTPS download failed (curl exit ' + exit + ').');
        } else {
            var request = new ActiveXObject('MSXML2.ServerXMLHTTP.6.0');
            request.setTimeouts(15000, 20000, 30000, 240000); request.open('GET', url, false); request.send();
            if (request.status !== 200) throw new Error('HTTPS download returned ' + request.status + '.');
            var stream = new ActiveXObject('ADODB.Stream'); stream.Type = 1; stream.Open(); stream.Write(request.responseBody); stream.SaveToFile(destination, 2); stream.Close();
        }
    }
    function install(entry) {
        var directory = cache + '\\' + entry.file.replace(/\.zip$/, ''), node = directory + '\\node.exe';
        if (validNode(node, true)) return node;
        mkdir(cache);
        var lock = directory + '.lock', started = new Date().getTime(), owned = false, stage;
        var token = fs.GetTempName() + '-' + started + '-' + Math.floor(Math.random() * 2147483647).toString(16);
        var pending = lock + '.pending-' + token, marker = 'owner-' + token + '.txt', identity = installerIdentity();
        try {
            fs.CreateFolder(pending);
            var ownerFile = fs.CreateTextFile(pending + '\\' + marker, false, false);
            try { ownerFile.WriteLine(identity ? identity.pid + '\r\n' + identity.created : 'unknown'); }
            finally { ownerFile.Close(); }
            var missingLock = 0;
            while (!owned) {
                try { fs.MoveFolder(pending, lock); owned = true; }
                catch (error) {
                    if (!fs.FolderExists(lock)) {
                        // The previous owner may have released after MoveFolder
                        // failed. Retry briefly, but do not hide permission errors.
                        if (++missingLock > 3) throw error;
                        WScript.Sleep(50); continue;
                    }
                    missingLock = 0;
                    if (validNode(node, true)) return node;
                    if (reclaimLock(lock)) continue;
                    if (new Date().getTime() - started > 1200000) throw new Error('Runtime install lock timed out: ' + lock + '. If no installer is running, remove this lock and retry.');
                    WScript.Sleep(500);
                }
            }
            if (validNode(node, true)) return node;
            stage = cache + '\\setup-' + fs.GetTempName(); mkdir(stage);
            var archive = stage + '\\' + entry.file, routes = ['https://nodejs.org/dist/', 'https://nodejs.org/download/release/'], route, verified = false;
            if (!fs.FileExists(system + '\\tar.exe') || !fs.FileExists(system + '\\certutil.exe')) throw new Error('Windows tar.exe and certutil.exe are required. Use a supported Windows 10/11 installation.');
            for (route = 0; route < routes.length; route++) {
                try {
                    log('Installing Node.js ' + entry.version + ' (' + (route + 1) + '/' + routes.length + ')...');
                    download(routes[route] + entry.version + '/' + entry.file, archive);
                    var sum = captured(quote(system + '\\certutil.exe') + ' -hashfile ' + quote(archive) + ' SHA256', 30000);
                    var hashes = sum.output.toLowerCase().match(/[a-f0-9]{64}/g) || [];
                    if (sum.code !== 0 || hashes.join(',') !== entry.hash) throw new Error('SHA256 mismatch; downloaded runtime was rejected.');
                    verified = true; break;
                } catch (error) { lastError = error.message; log(lastError); cleanup(archive); }
            }
            if (!verified) throw new Error(lastError);
            if (shell.Run(commandLine(quote(system + '\\tar.exe') + ' -xf ' + quote(archive) + ' -C ' + quote(stage)), 0, true) !== 0) throw new Error('Node.js archive extraction failed.');
            var extracted = stage + '\\' + entry.file.replace(/\.zip$/, '');
            if (!validNode(extracted + '\\node.exe', true)) throw new Error('Downloaded Node.js/npm cannot run on this system.');
            // Never overwrite an installed runtime used by another process or the maintenance service.
            if (fs.FolderExists(directory)) fs.MoveFolder(directory, directory + '.broken-' + fs.GetTempName());
            fs.MoveFolder(extracted, directory);
            log('Node.js and npm are ready. Continuing automatically.');
            return node;
        } finally {
            cleanup(stage);
            if (owned) {
                try { releaseLock(lock, marker); }
                catch (error) { log('Runtime lock cleanup failed: ' + error.message); }
            }
            cleanup(pending);
        }
    }
    if (env('TOOL_DOCTOR_IGNORE_SYSTEM_NODE') !== '1') {
        pathParts = env('PATH').split(';');
        for (i = 0; i < pathParts.length; i++) {
            if (!pathParts[i]) continue;
            candidate = pathParts[i].replace(/^"|"$/g, '') + '\\node.exe';
            if (validNode(candidate, requireNpm)) return selected(candidate);
        }
    }
    if (!arch) throw new Error('Automatic Node.js installation supports Windows x64 and ARM64.');
    entries = parseManifest(read(root + '\\scripts\\node-runtimes.txt'), arch);
    if (!entries.length) throw new Error('No matching runtime in node-runtimes.txt.');
    // Reuse every compatible cached release before trying any network download.
    for (i = 0; i < entries.length; i++) {
        candidate = cache + '\\' + entries[i].file.replace(/\.zip$/, '') + '\\node.exe';
        if (validNode(candidate, true)) return selected(candidate);
    }
    log('A working Node.js 22+ environment is missing. Preparing a user-local installation.');
    for (i = 0; i < entries.length; i++) {
        try { candidate = install(entries[i]); }
        catch (error) { lastError = error.message; log(lastError); continue; }
        return selected(candidate);
    }
    throw new Error('Automatic setup could not finish. Check network/proxy, disk space and write access, then run again. ' + lastError);
}
if (typeof WScript !== 'undefined') {
    try { WScript.Quit(main()); }
    catch (error) { WScript.StdErr.WriteLine('[Codex Tool Doctor] ' + error.message); WScript.Quit(1); }
}
