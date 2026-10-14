'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolveExecutable, commandLaunch, quoteForCommandProcessor } = require('../src/exec-resolve');

const windows = process.platform === 'win32';

function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `exec-resolve-${name}-`));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

function withPath(dir, run) {
  const before = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${before}`;
  try { return run(); } finally { process.env.PATH = before; }
}

test('a bare name resolves through PATHEXT, which spawn itself will not do', { skip: !windows }, () => {
  const dir = scratch('pathext');
  fs.writeFileSync(path.join(dir, 'wcprobe.cmd'), '@echo probe-ok\r\n', 'utf8');

  // PATHEXT supplies the extension, so its casing is whatever the box uses.
  const resolved = withPath(dir, () => resolveExecutable('wcprobe'));
  assert.equal(path.dirname(resolved), dir);
  assert.equal(path.basename(resolved).toLowerCase(), 'wcprobe.cmd');

  // The regression itself: the bare name cannot be launched, and naming the
  // shim outright is refused, so only the resolved launch form can work.
  const bare = spawnSync('wcprobe', [], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` } });
  assert.ok(bare.error, 'a bare .cmd name is expected to be unlaunchable');
});

test('a batch shim is launched through the command processor and reports its output', { skip: !windows }, () => {
  const dir = scratch('launch');
  // %~1 strips the quoting we add, so the shim sees the argument as one token.
  fs.writeFileSync(path.join(dir, 'wcprobe.cmd'), '@echo probe-ok %~1\r\n', 'utf8');

  const launch = withPath(dir, () => commandLaunch('wcprobe', ['first arg']));
  assert.equal(launch.file, process.env.ComSpec || 'cmd.exe');
  assert.equal(launch.options.windowsVerbatimArguments, true);

  const result = spawnSync(launch.file, launch.args, {
    encoding: 'utf8', windowsHide: true, ...launch.options,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /probe-ok first arg/);
});

test('a real executable is spawned directly rather than through a shell', { skip: !windows }, () => {
  const launch = commandLaunch(process.execPath, ['--version']);
  assert.equal(launch.file, process.execPath);
  assert.deepEqual(launch.options, {});
  const result = spawnSync(launch.file, launch.args, { encoding: 'utf8' });
  assert.equal(result.status, 0);
});

test('an unresolvable name keeps the caller ENOENT contract', { skip: !windows }, () => {
  const launch = commandLaunch('wc-definitely-not-installed-xyz', ['--version']);
  assert.equal(launch.resolved, null);
  assert.equal(launch.file, 'wc-definitely-not-installed-xyz');
});

test('POSIX keeps its own PATH handling untouched', { skip: windows }, () => {
  const launch = commandLaunch('echo', ['hello']);
  assert.equal(launch.file, 'echo');
  assert.deepEqual(launch.args, ['hello']);
  assert.deepEqual(launch.options, {});
});

test('quoting keeps a command-processor metacharacter inside one argument', () => {
  assert.equal(quoteForCommandProcessor('a & b'), '"a & b"');
  assert.equal(quoteForCommandProcessor('say "hi"'), '"say ""hi"""');
});

test('an argument carrying shell syntax survives the round trip verbatim', { skip: !windows }, () => {
  const dir = scratch('metachars');
  // %* forwards every argument, so whatever cmd.exe parsed is echoed back.
  fs.writeFileSync(path.join(dir, 'wcecho.cmd'), '@echo %*\r\n', 'utf8');
  const launch = withPath(dir, () => commandLaunch('wcecho', ['a&b|c', 'two words']));
  const result = spawnSync(launch.file, launch.args, {
    encoding: 'utf8', windowsHide: true, ...launch.options,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"a&b\|c" "two words"/);
});

// Order matters, not just presence. An npm-installed CLI puts an extensionless
// shell script next to the .cmd, and CreateProcess cannot launch the former, so
// resolving to it reproduces the ENOENT this module exists to prevent.
test('a PATHEXT match wins over an extensionless sibling of the same name', { skip: !windows }, () => {
  const dir = scratch('order');
  fs.writeFileSync(path.join(dir, 'wcprobe'), '#!/bin/sh\necho posix-shim\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'wcprobe.cmd'), '@echo probe-ok\r\n', 'utf8');

  const resolved = withPath(dir, () => resolveExecutable('wcprobe'));
  assert.equal(path.basename(resolved).toLowerCase(), 'wcprobe.cmd');

  const launch = withPath(dir, () => commandLaunch('wcprobe', []));
  const result = spawnSync(launch.file, launch.args, {
    encoding: 'utf8', windowsHide: true, ...launch.options,
  });
  assert.equal(result.error, undefined);
  assert.match(result.stdout, /probe-ok/);
});

test('an explicit path that already carries its extension still matches itself', { skip: !windows }, () => {
  const dir = scratch('explicit');
  const shim = path.join(dir, 'wcprobe.cmd');
  fs.writeFileSync(shim, '@echo probe-ok\r\n', 'utf8');
  assert.equal(resolveExecutable(shim), shim);
});

// npm's global prefix on Windows is %APPDATA%\npm, and it is not always
// persisted into the machine or user PATH. A process that inherits the login
// environment (a VS Code extension host) then cannot see a CLI the same user
// runs fine in a terminal, which is how "codex executable not found on PATH"
// reached a dashboard while `codex --version` worked in a shell.
test('a CLI in the npm global prefix resolves when PATH does not have it', { skip: !windows }, () => {
  const fake = scratch('npmprefix');
  const npmDir = path.join(fake, 'npm');
  fs.mkdirSync(npmDir, { recursive: true });
  fs.writeFileSync(path.join(npmDir, 'wcfallback.cmd'), '@echo fallback-ok\r\n', 'utf8');

  const beforeAppData = process.env.APPDATA;
  const beforePath = process.env.PATH;
  // A PATH that deliberately cannot see it, and an APPDATA that can.
  process.env.APPDATA = fake;
  process.env.PATH = path.join(fake, 'nothing-here');
  try {
    const resolved = resolveExecutable('wcfallback');
    assert.equal(path.dirname(resolved), npmDir);

    // And it is launchable, which is the whole point of resolving it.
    const launch = commandLaunch('wcfallback', []);
    const result = spawnSync(launch.file, launch.args, {
      encoding: 'utf8', windowsHide: true, ...launch.options,
    });
    assert.equal(result.error, undefined);
    assert.match(result.stdout, /fallback-ok/);

    // Absent from both, still null: the fallback is two named directories, not
    // a search of the disk.
    assert.equal(resolveExecutable('wc-not-anywhere-xyz'), null);
  } finally {
    if (beforeAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = beforeAppData;
    process.env.PATH = beforePath;
  }
});

test('PATH stays authoritative over the fallback directories', { skip: !windows }, () => {
  const fake = scratch('precedence');
  const npmDir = path.join(fake, 'npm');
  const pathDir = path.join(fake, 'onpath');
  fs.mkdirSync(npmDir, { recursive: true });
  fs.mkdirSync(pathDir, { recursive: true });
  fs.writeFileSync(path.join(npmDir, 'wcboth.cmd'), '@echo from-fallback\r\n', 'utf8');
  fs.writeFileSync(path.join(pathDir, 'wcboth.cmd'), '@echo from-path\r\n', 'utf8');

  const beforeAppData = process.env.APPDATA;
  process.env.APPDATA = fake;
  try {
    const resolved = withPath(pathDir, () => resolveExecutable('wcboth'));
    assert.equal(path.dirname(resolved), pathDir, 'PATH must win');
  } finally {
    if (beforeAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = beforeAppData;
  }
});

// THE TREE KILL IS NEVER AIMED AT A FREED PID (2026-10-14). A child ended by a
// signal has `exitCode` null and `signalCode` set, and by 'exit' Node has reaped
// it, so its PID may already be reused; the extension forgets a child only on
// 'close', which comes after. endProcessTree is called here INSIDE 'exit', the
// gap deactivate can land in, on a child that execFile's own timeout killed.
// taskkill and the group signal are stubbed, so this test never sends either.
test('a child its own execFile timeout ended gets no tree kill, and a live child does', async (t) => {
  const childProcess = require('node:child_process');
  const { endProcessTree } = require('../src/exec-resolve');
  const realExecFile = childProcess.execFile;
  const realKill = process.kill;
  const treeKills = [];
  const stub = () => {
    childProcess.execFile = function execFile(file, args, options, callback) {
      if (!/^taskkill(\.exe)?$/i.test(path.basename(String(file)))) return realExecFile.apply(this, arguments);
      treeKills.push(['taskkill', ...args]);
      process.nextTick(callback);
      return null;
    };
    process.kill = function kill(pid, signal) {
      if (pid >= 0) return realKill.apply(process, arguments);
      treeKills.push(['group', pid, signal]);
      return true;
    };
  };
  const restore = () => { childProcess.execFile = realExecFile; process.kill = realKill; };
  t.after(restore);

  const forever = ['-e', 'setInterval(() => {}, 1000)'];
  const timedOut = realExecFile(process.execPath, forever, { timeout: 200, windowsHide: true }, () => {});
  const atExit = await new Promise((resolve) => timedOut.once('exit', () => {
    const state = { exitCode: timedOut.exitCode, signalCode: timedOut.signalCode };
    stub();
    try { endProcessTree(timedOut); } finally { restore(); }
    resolve(state);
  }));
  assert.equal(atExit.exitCode, null, 'precondition: a child ended by a signal has no exit code');
  assert.ok(atExit.signalCode, 'precondition: it has a signal code instead');
  // MUTATION: test `child.exitCode != null` alone again, as before 2026-10-14.
  // taskkill /T (Windows) or the group signal (POSIX) is aimed at the freed PID
  // and this lists it. Confirmed 2026-10-14.
  assert.deepEqual(treeKills, [], 'a tree kill was aimed at a PID the system may already have reused');

  // The control: a live child does get the tree kill, so the stub sees one when
  // one is sent. Its fallback child.kill() is real and ends the child.
  const live = childProcess.spawn(process.execPath, forever, { stdio: 'ignore', windowsHide: true });
  t.after(() => { try { live.kill('SIGKILL'); } catch {} });
  await new Promise((resolve) => live.once('spawn', resolve));
  const exited = new Promise((resolve) => live.once('exit', resolve));
  stub();
  let ending;
  try { ending = endProcessTree(live); } finally { restore(); }
  await ending;
  await exited;
  assert.deepEqual(treeKills, windows ? [['taskkill', '/PID', String(live.pid), '/T', '/F']] : [['group', -live.pid, 'SIGTERM']]);
});

// A PLANTED taskkill.exe IS NEVER THE ONE THAT RUNS (2026-10-14). libuv resolves a
// bare name itself and looks in the current directory before PATH, unless the
// environment carries NoDefaultCurrentDirectoryInExePath; the extension host's cwd
// is wherever VS Code was started, so a repository opened with `code .` could
// supply it. The stand-in is a copy of node named taskkill.exe, and a --require
// preload writes a flag only when it runs as that copy. The variable is removed for
// the call, because an agent shell that sets it makes the unfixed code pass too.
//
// The flag alone is not the witness. Endpoint scanning can hold the first run of a
// freshly copied executable for longer than the 5 s the tree kill waits, and then
// the copy is ended before its preload runs. What only System32's taskkill can do
// is the witness: the tree is cmd.exe -> node, and the node grandchild dies only by
// `/T`, because the fallback child.kill() ends cmd.exe alone.
function plantedTaskkill(dir) {
  const flag = path.join(dir, 'planted-taskkill-ran');
  const marker = path.join(dir, 'planted-marker.js');
  fs.writeFileSync(marker, `if (/taskkill\\.exe$/i.test(process.execPath)) require('fs').writeFileSync(${JSON.stringify(flag)}, process.argv.slice(1).join(' '));\n`);
  fs.copyFileSync(process.execPath, path.join(dir, 'taskkill.exe'));
  // NODE_OPTIONS reads a backslash inside quotes as an escape: forward slashes.
  return { flag, nodeOptions: `--require "${marker.split(path.sep).join('/')}"` };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitUntil(predicate, ms) {
  const start = Date.now();
  while (!predicate() && Date.now() - start < ms) await new Promise((resolve) => setTimeout(resolve, 50));
  return predicate();
}

test('the tree kill runs System32\'s taskkill, not one planted in the current directory', { skip: !windows }, async (t) => {
  const { endProcessTree, taskkillPath } = require('../src/exec-resolve');
  const childProcess = require('node:child_process');
  const dir = scratch('planted');
  const planted = plantedTaskkill(dir);
  assert.equal(taskkillPath(), path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'));
  // cmd.exe -> node, the npm shim's shape. The node writes its pid and waits.
  const pidFile = path.join(dir, 'grandchild.pid');
  const script = path.join(dir, 'hang.js');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`);
  const shim = path.join(dir, 'wchang.cmd');
  fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}"\r\n`);
  const launch = commandLaunch(shim, []);
  const root = childProcess.spawn(launch.file, launch.args, { ...launch.options, stdio: 'ignore', windowsHide: true });
  t.after(() => { try { root.kill('SIGKILL'); } catch {} });
  assert.ok(await waitUntil(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim(), 10000),
    'precondition: the node under cmd.exe started');
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => { try { process.kill(grandchild, 'SIGKILL'); } catch {} });
  const saved = { cwd: process.cwd(), noCwd: process.env.NoDefaultCurrentDirectoryInExePath, nodeOptions: process.env.NODE_OPTIONS };
  delete process.env.NoDefaultCurrentDirectoryInExePath;
  process.env.NODE_OPTIONS = planted.nodeOptions;
  process.chdir(dir);
  try {
    await endProcessTree(root);
  } finally {
    process.chdir(saved.cwd);
    for (const [key, value] of [['NoDefaultCurrentDirectoryInExePath', saved.noCwd], ['NODE_OPTIONS', saved.nodeOptions]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  // MUTATION: name 'taskkill' bare in endProcessTree again. The copy in the cwd runs
  // instead of System32's (and writes the flag once it gets past the scan), the
  // fallback ends cmd.exe alone, and the node under it is still running here.
  // Confirmed 2026-10-14.
  assert.equal(fs.existsSync(planted.flag), false,
    `the taskkill in the current directory ran: ${fs.existsSync(planted.flag) ? fs.readFileSync(planted.flag, 'utf8') : ''}`);
  assert.equal(await waitUntil(() => !alive(grandchild), 3000), true, 'the node under cmd.exe outlived the tree kill');

  // SystemRoot decides the directory, so a Windows installed off C: is honoured.
  const before = process.env.SystemRoot;
  process.env.SystemRoot = 'D:\\WinRoot';
  try { assert.equal(taskkillPath(), path.join('D:\\WinRoot', 'System32', 'taskkill.exe')); }
  finally { process.env.SystemRoot = before; }
});

// A launcher and the program under it: cmd.exe -> node on Windows (an npm shim's
// shape, and a venv python.exe's, whose interpreter is its child), sh -> node on
// POSIX. The node writes its pid and waits for ever.
function launcherChain(dir, name) {
  const pidFile = path.join(dir, `${name}.pid`);
  const script = path.join(dir, `${name}.js`);
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`);
  if (windows) {
    const shim = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}"\r\n`);
    return { launch: commandLaunch(shim, []), pidFile };
  }
  const shim = path.join(dir, name);
  fs.writeFileSync(shim, `#!/bin/sh\n"${process.execPath}" "${script}"\n`, { mode: 0o755 });
  return { launch: { file: shim, args: [], options: {} }, pidFile };
}

// EXECFILE'S OWN TIMEOUT ENDED THE LAUNCHER AND LEFT THE PROGRAM (2026-10-14). Its
// kill is child.kill() on the one PID it holds. The extension's four execFile sites
// (the 30 s execpolicy check through an npm codex.cmd, and three venv-python runs of
// 60 s and 180 s) now take their deadline from endTreeAfter, which tree-kills the
// root while it is still alive. The deadline is fired by hand once the program is
// up, so the test neither waits 30 s nor races the launcher's own start.
test('a deadline from endTreeAfter ends the program under a launcher, which killing the launcher alone leaves running', async (t) => {
  const { endTreeAfter } = require('../src/exec-resolve');
  const { execFile } = require('node:child_process');
  const dir = scratch('deadline');
  const pids = [];
  t.after(() => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  // Every wait is bounded. A program that outlives its launcher still holds the
  // stdio pipes it inherited, so execFile's callback does not come until it dies.
  const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('pending'), ms))]);
  const start = async (name, bound) => {
    const chain = launcherChain(dir, name);
    let answered;
    const answer = new Promise((resolve) => { answered = resolve; });
    const child = execFile(chain.launch.file, chain.launch.args, { ...chain.launch.options, windowsHide: true },
      (error) => answered(error));
    pids.push(child.pid);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const armed = bound(child);
    assert.ok(await waitUntil(() => fs.existsSync(chain.pidFile) && fs.readFileSync(chain.pidFile, 'utf8').trim(), 10000),
      `precondition: the program under the ${name} launcher started`);
    const program = Number(fs.readFileSync(chain.pidFile, 'utf8'));
    pids.push(program);
    return { child, armed, answer, exited, program };
  };

  // The control is what execFile's timeout does when it fires: child.kill().
  const control = await start('control', () => null);
  control.child.kill();
  await within(control.exited, 5000);
  if (windows) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(alive(control.program), true,
      'precondition: ending the launcher alone leaves the program under it running');
  }
  try { process.kill(control.program, 'SIGKILL'); } catch {}

  const realSetTimeout = global.setTimeout;
  const fixed = await start('fixed', (child) => {
    let armed = null;
    global.setTimeout = (fn, ms) => {
      const handle = realSetTimeout(() => {}, 2 ** 31 - 1);
      armed = { fn, ms, handle };
      return handle;
    };
    try { endTreeAfter(child, 30000); } finally { global.setTimeout = realSetTimeout; }
    return armed;
  });
  assert.equal(fixed.armed?.ms, 30000, 'endTreeAfter arms a deadline of the length it was given');
  fixed.armed.fn();
  if (!windows) {
    await within(fixed.exited, 5000);
    try { process.kill(fixed.program, 'SIGKILL'); } catch {}
    const error = await within(fixed.answer, 5000);
    assert.match(String(error?.message), /^Command failed:/, 'the callback reads the kill as execFile reports any failed command');
    // POSIX: endProcessTree reaches a whole tree only through a process group, and
    // execFile cannot start a leader, so the sh alone is ended. Recorded in
    // src/exec-resolve.js; the extension's sites have no grandchild there.
    t.diagnostic('POSIX: the deadline ends the launcher only; a grandchild is out of reach without a process group');
    return;
  }
  // MUTATION: make endTreeAfter's timer call child.kill() instead of
  // endProcessTree(child), which is execFile's own timeout. The node under cmd.exe
  // is still running here. Confirmed 2026-10-14.
  assert.equal(await waitUntil(() => !alive(fixed.program), 5000), true,
    'the program under the launcher outlived the deadline');
  const error = await within(fixed.answer, 5000);
  assert.match(String(error?.message), /^Command failed:/, 'the callback reads the kill as execFile reports any failed command');
});

// npm's own cmd-shim, as bundled with the node running this suite. Generating the
// shim with it, rather than copying its template here, is what makes the test
// mean "the shim npm writes", and not "the shim this file thinks npm writes".
function bundledCmdShim() {
  try { return require(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'node_modules', 'cmd-shim')); }
  catch { return null; }
}

// AN npm SHIM IS RUN AS THE NODE SCRIPT IT NAMES, AND NOTHING ELSE IS (2026-10-14).
// Through cmd.exe the script's node is in no job object, so a config worker that
// dies with its host leaves it running (test/codex-mcp-config.test.js has that
// case). npmShimLaunch reads only cmd-shim's own form and returns null for
// anything else, which the worker then launches through the command processor.
test('the shim npm writes is run as the node script it names; every other shape is left alone', { skip: !windows }, async (t) => {
  const { npmShimLaunch } = require('../src/exec-resolve');
  const cmdShim = bundledCmdShim();
  if (!cmdShim) { t.skip('npm\'s bundled cmd-shim is not next to this node'); return; }
  const dir = scratch('npmshim');
  const bin = path.join(dir, 'node_modules', '@openai', 'codex', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const script = path.join(bin, 'codex.js');
  fs.writeFileSync(script, '#!/usr/bin/env node\nprocess.stdout.write("ran " + process.argv.slice(2).join(" "));\n');
  await cmdShim(script, path.join(dir, 'codex'));
  const shim = path.join(dir, 'codex.cmd');

  const launch = npmShimLaunch(shim, ['app-server', '--stdio']);
  // MUTATION: make npmShimLaunch return null outright. This and the host-death test
  // in test/codex-mcp-config.test.js fail. Confirmed 2026-10-14.
  assert.ok(launch, 'the shim npm writes was not recognised');
  assert.equal(launch.resolved, shim);
  assert.equal(path.basename(launch.file).toLowerCase(), 'node.exe', 'node, from PATH, as the shim itself would pick');
  assert.deepEqual(launch.args, [script, 'app-server', '--stdio']);
  const run = spawnSync(launch.file, launch.args, { encoding: 'utf8', windowsHide: true });
  assert.equal(run.stdout, 'ran app-server --stdio');
  // A node.exe beside the shim wins, as the shim's own IF EXIST does.
  fs.writeFileSync(path.join(dir, 'node.exe'), '');
  assert.equal(npmShimLaunch(shim, []).file, path.join(dir, 'node.exe'));
  fs.rmSync(path.join(dir, 'node.exe'));

  // Every other shape is null, so the caller launches the .cmd as it always did.
  const flagged = path.join(bin, 'flagged.js');
  fs.writeFileSync(flagged, '#!/usr/bin/env node --no-warnings\n');
  await cmdShim(flagged, path.join(dir, 'flagged'));
  assert.equal(npmShimLaunch(path.join(dir, 'flagged.cmd'), []), null, 'a shim that passes node flags');
  fs.writeFileSync(path.join(dir, 'plain.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  assert.equal(npmShimLaunch(path.join(dir, 'plain.cmd'), []), null, 'a hand-written two-line shim');
  const text = fs.readFileSync(shim, 'utf8');
  fs.writeFileSync(path.join(dir, 'expanded.cmd'), text.replace('node_modules\\@openai', 'node_modules\\%SCOPE%'));
  assert.equal(npmShimLaunch(path.join(dir, 'expanded.cmd'), []), null, 'a target that would expand a variable');
  fs.writeFileSync(path.join(dir, 'edited.cmd'), text.replace('SETLOCAL', 'SETLOCAL\r\nSET X=1'));
  assert.equal(npmShimLaunch(path.join(dir, 'edited.cmd'), []), null, 'a shim with a line added');
  fs.writeFileSync(path.join(dir, 'moved.cmd'), text.replace('codex.js', 'missing.js'));
  assert.equal(npmShimLaunch(path.join(dir, 'moved.cmd'), []), null, 'a shim whose script is not there');
  fs.writeFileSync(path.join(dir, 'batch.bat'), text);
  assert.equal(npmShimLaunch(path.join(dir, 'batch.bat'), []), null, 'a .bat, which npm never writes');
  assert.equal(npmShimLaunch(process.execPath, []), null, 'a real executable');
});
