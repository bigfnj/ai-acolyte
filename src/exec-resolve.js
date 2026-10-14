'use strict';

// Launching a CLI by bare name is not symmetric on Windows. A PATH lookup that
// honours PATHEXT finds `codex.cmd`, but CreateProcess does not consult
// PATHEXT, so spawn('codex') fails ENOENT; naming the shim outright fails too,
// because Node refuses to run a .cmd or .bat without a command processor. An
// npm-installed CLI is exactly this shape, so the usual "it is on PATH" check
// passes and the call then cannot start.
//
// Resolve the name once here and let the resolved extension decide how to
// launch it: a batch shim goes through the command processor, everything else
// is spawned directly by absolute path. POSIX keeps its own PATH handling.

const fs = require('fs');
const path = require('path');

const BATCH_EXTENSIONS = new Set(['.cmd', '.bat']);

// PATHEXT first, bare name last. npm installs a CLI as three siblings: an
// extensionless shell script, a .cmd and a .ps1. CreateProcess cannot run the
// extensionless one, so preferring it would reproduce the very ENOENT this
// module exists to avoid; cmd.exe does not consider it either. The empty
// extension stays at the end so an explicit path that already carries one
// still matches itself.
function pathExtensions() {
  const raw = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  const listed = raw.split(';').map((value) => value.trim()).filter(Boolean);
  return [...listed, ''];
}

function isFile(target) {
  try { return fs.statSync(target).isFile(); } catch { return false; }
}

// Standard install locations to probe once PATH has failed.
//
// npm on Windows puts a CLI shim in its global prefix, %APPDATA%\npm, and that
// directory is not always persisted into the machine or user PATH. Measured on
// one box: `codex` and `claude` both live there, both resolve from a shell that
// a developer tool launched, and neither directory appears in HKCU\Environment
// or HKLM. A process that inherits the login environment instead, such as a VS
// Code extension host, therefore cannot see a CLI that the same user can run in
// a terminal. That is a confusing failure to debug from the outside, so close it.
//
// The trust expansion is narrow: this resolves only a name the caller asked for
// by hand, and only inside the user's own npm prefix or the Node install
// directory. Anything that can write to either can already act as the user.
// Read from the environment on every call so a test can point them elsewhere.
function fallbackDirectories() {
  if (process.platform !== 'win32') return [];
  const dirs = [];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  if (process.env.ProgramFiles) dirs.push(path.join(process.env.ProgramFiles, 'nodejs'));
  return dirs;
}

function probeDirectories(dirs, value, extensions) {
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, value + extension);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

// Returns an absolute path on Windows, the name unchanged on POSIX (where
// spawn resolves PATH itself), or null when neither PATH nor a standard install
// location holds it.
//
// ABSOLUTE PATH ENTRIES ONLY (2026-10-14). A relative PATH entry is the current
// directory by another name: "." is one, and so is an entry whose variable was never
// expanded ("%TOOLS%\bin", which a REG_SZ PATH value leaves literal). Both are joined
// to whatever directory the process stands in, which for the hook is the Claude Code
// session's project, so a repository could supply either one. cmd.exe and libuv honour
// them; a program this module finds for a caller that never typed a command does not.
function resolveExecutable(name) {
  const value = String(name == null ? '' : name);
  if (!value) return null;
  if (process.platform !== 'win32') return value;
  const extensions = pathExtensions();
  if (value.includes('/') || value.includes('\\')) {
    const direct = path.resolve(value);
    for (const extension of extensions) if (isFile(direct + extension)) return direct + extension;
    return null;
  }
  const onPath = String(process.env.PATH || '').split(path.delimiter).filter((dir) => dir && path.isAbsolute(dir));
  // PATH stays authoritative; the fallback only answers where PATH said nothing.
  return probeDirectories(onPath, value, extensions) ||
    probeDirectories(fallbackDirectories(), value, extensions);
}

// Inside double quotes the command processor stops treating & | < > ^ ( ) as
// syntax, so quoting every token keeps those inside one argument. Doubling an
// embedded quote is the escape cmd.exe understands. Quoting is NOT enough on its
// own, and commandLaunch below refuses what it cannot cover: see
// BATCH_UNSAFE_ARGUMENT.
function quoteForCommandProcessor(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

// WHAT cmd.exe EXPANDS INSIDE QUOTES IS REFUSED, NOT ESCAPED (2026-10-14, the BatBadBut
// class). This comment used to call `%NAME%` expansion "a legibility edge and not a hole",
// on the premise that every argument was a learned command word. It is a hole: "Why did
// this prompt?" passes text the user pasted, and a PowerShell variant passes the whole
// paste as one `-Command` token. `%` expansion runs before quotes are parsed and has no
// escape on a command line, so `%CMDCMDLINE:~-1%`, the last character of cmd.exe's own
// command line, expands to the `"` that closes it, and what follows a `&` then runs as a
// command (reproduced by the final pre-tag audit through an npm-shaped `codex.cmd`).
// `!` is the same with delayed expansion, which `/d` does not turn off: `/d` skips only
// the AutoRun commands, and the registry can turn delayed expansion on. A CR or LF ends
// the command line early, and NUL cannot cross CreateProcess at all.
//
// Escaping these is possible and intricate (Rust's std took that route for the same
// advisory). Every launch here is a probe or a diagnostic, so commandLaunch refuses the
// argument instead, before anything is spawned. Only ARGUMENTS are checked. The program
// path is the file PATH, a machine-scoped setting or the user's own install named, never
// text from a project or a paste, and refusing it would refuse a profile directory with
// a `!` in its name.
const BATCH_UNSAFE_ARGUMENT = /[%!\r\n\0]/;
const BATCH_ARGUMENT_REFUSED_CODE = 'ERR_BATCH_ARGUMENT_REFUSED';
function batchArgumentRefusal(resolved, list) {
  const index = list.findIndex((value) => BATCH_UNSAFE_ARGUMENT.test(value));
  if (index < 0) return null;
  const found = list[index].match(BATCH_UNSAFE_ARGUMENT)[0];
  const named = { '\r': 'a carriage return', '\n': 'a line feed', '\0': 'a NUL character' }[found] || `"${found}"`;
  return Object.assign(new Error(
    `Refused to run ${path.basename(resolved)}: argument ${index + 1} contains ${named}. ` +
    `${path.basename(resolved)} is a batch file, so it runs through cmd.exe, which expands % and ! ` +
    'even inside quotes and ends a command at a line break, so the argument could not arrive as ' +
    'written. Nothing was run.',
  ), { code: BATCH_ARGUMENT_REFUSED_CODE, path: resolved, argumentIndex: index });
}

// Describes how to launch `name` with `args`: the file to spawn, the arguments
// to pass, and any spawn options the form requires. Callers spread `options`
// into their own so execFile and spawnSync can share one decision. THROWS,
// before any spawn, when the launch would go through cmd.exe and an argument
// carries a character it expands (BATCH_UNSAFE_ARGUMENT, above), with code
// BATCH_ARGUMENT_REFUSED_CODE. A caller with text of its own to pass tries
// npmShimLaunch first, which runs an npm shim with no cmd.exe at all.
function commandLaunch(name, args = []) {
  const list = (Array.isArray(args) ? args : []).map(String);
  const resolved = resolveExecutable(name);
  // Unresolved on Windows means nothing on PATH matched. Hand the bare name
  // back so the caller's own ENOENT contract still fires rather than inventing
  // a different failure here. A caller that spawns the result without checking
  // `resolved` first wants resolvedLaunch, below: libuv looks for a bare name in
  // the current directory before PATH.
  if (!resolved) return { file: String(name == null ? '' : name), args: list, options: {}, resolved: null };
  if (process.platform !== 'win32' || !BATCH_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    return { file: resolved, args: list, options: {}, resolved };
  }
  const refused = batchArgumentRefusal(resolved, list);
  if (refused) throw refused;
  const line = [resolved, ...list].map(quoteForCommandProcessor).join(' ');
  // ComSpec when it names a file outright, else System32's: a bare `cmd.exe` is the same
  // current-directory lookup as any other bare name (resolvedLaunch, below).
  const comspec = process.env.ComSpec;
  return {
    file: comspec && path.isAbsolute(comspec) ? comspec : systemProgram('cmd.exe'),
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
    resolved,
  };
}

// A LAUNCH THAT NEVER HANDS spawn A BARE NAME (2026-10-14). commandLaunch returns the
// name unchanged when nothing on PATH matched, so that the caller's own ENOENT fires.
// On Windows that bare name then reaches libuv, which looks in the CURRENT DIRECTORY
// before PATH: the child's `cwd` when one is given, the spawner's otherwise. Only the
// SPAWNING process's own environment can turn that off, with
// NoDefaultCurrentDirectoryInExePath; the child's `env` cannot (measured: libuv 1.52.1,
// Node 24.19.0, see taskkillPath below). So "not on PATH" meant "run the copy in the
// cwd", and the cwd is often a project: the hook runs in the Claude Code session's
// project directory, and the extension host in whatever directory VS Code was started.
// This throws the error spawn raises for a missing program, in its words
// (`<syscall> <name> ENOENT`, code ENOENT), without the spawn. POSIX is unchanged:
// execvp walks PATH alone, so the name goes to spawn as before.
function resolvedLaunch(name, args = [], syscall = 'spawn') {
  const launch = commandLaunch(name, args);
  if (process.platform !== 'win32' || launch.resolved) return launch;
  throw Object.assign(new Error(`${syscall} ${launch.file} ENOENT`), {
    code: 'ENOENT', syscall: `${syscall} ${launch.file}`, path: launch.file, spawnargs: launch.args,
  });
}

// AN npm SHIM, RUN AS THE NODE SCRIPT IT NAMES (2026-10-14). Launched through the
// command processor, an npm `codex.cmd` is cmd.exe -> node, and that node is in no
// job object: libuv puts every child a Node process spawns in a kill-on-close job
// that allows silent breakaway, so cmd.exe is in the spawner's job and its own
// child is not. A Codex config worker that dies with its host (the host's job ends
// it) therefore ends cmd.exe, and the node under it keeps running (measured in
// test/codex-mcp-config.test.js, "a worker whose host dies outright"). Spawned
// directly, that node is the worker's own child, in the worker's job, and dies
// with it; the native codex the npm launcher starts is in that node's job in turn.
//
// Only cmd-shim's own output is read, byte for byte apart from line endings and
// the target: the form npm 7 and later write (cmd-shim 4+), which is the form any
// npm that can install @openai/codex writes. The target must be a relative path
// with no quote or `%` in it and must exist, and the node must be the shim's own
// `node.exe` or, as the shim would choose, `node` from PATH, and an .exe. Anything
// else (another shim generator, an older template, a hand-edited file, a shim that
// passes node flags) returns null, and the caller launches the .cmd as before.
// Windows only; POSIX has no .cmd. The cwd lookup cmd.exe would make for `node`
// is not reproduced, on purpose (see taskkillPath below).
const CMD_SHIM_HEAD = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\',
].join('\n');
const CMD_SHIM_TAIL = '" %*';
function npmShimLaunch(name, args = []) {
  if (process.platform !== 'win32') return null;
  const shim = resolveExecutable(name);
  if (!shim || path.extname(shim).toLowerCase() !== '.cmd') return null;
  let text;
  try {
    if (fs.statSync(shim).size > 4096) return null;
    text = fs.readFileSync(shim, 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  } catch { return null; }
  if (!text.startsWith(CMD_SHIM_HEAD) || !text.endsWith(CMD_SHIM_TAIL)) return null;
  const target = text.slice(CMD_SHIM_HEAD.length, text.length - CMD_SHIM_TAIL.length);
  if (!target || /["%\n]/.test(target) || path.isAbsolute(target) || /^[\\/]/.test(target)) return null;
  const dir = path.dirname(shim);
  const script = path.resolve(dir, target);
  if (!isFile(script)) return null;
  const local = path.join(dir, 'node.exe');
  const node = isFile(local) ? local : resolveExecutable('node');
  if (!node || path.extname(node).toLowerCase() !== '.exe') return null;
  return { file: node, args: [script, ...(Array.isArray(args) ? args : []).map(String)], options: {}, resolved: shim };
}

// taskkill BY ABSOLUTE PATH, never by bare name (2026-10-14). libuv resolves a
// bare name itself and looks in the CURRENT DIRECTORY before PATH, unless the
// environment carries NoDefaultCurrentDirectoryInExePath. Measured on the
// development box (libuv 1.52.1, Node 24.19.0): with that variable unset, a
// taskkill.exe planted in the cwd ran in place of System32's; with it set, it did
// not. The extension host's cwd is wherever VS Code was started (`code .` inside
// a clone makes it that clone), and the Codex config worker inherits it, so a
// repository could have supplied the program every deactivate runs. An agent
// shell often sets the variable, which is how this hid: a test has to unset it.
// SystemRoot is read first so a Windows installed off C: is honoured; the drive
// is a last resort for an environment that carries neither variable.
function systemProgram(file) {
  return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', file);
}
function taskkillPath() {
  return systemProgram('taskkill.exe');
}

// End a child AND everything it started, which on Windows child.kill() does not.
//
// The launch above is why it matters. A batch shim runs through the command
// processor, so the ChildProcess a caller holds is cmd.exe and the CLI is its
// child; an npm `codex.cmd` adds node under that. child.kill() is
// TerminateProcess on the one PID, and Windows does not end a process's children
// with it. Measured 2026-10-14 against the extension's own tracked children: a
// Codex config worker (node) whose codex was a `.cmd` stand-in that never
// answers, killed by deactivate's child.kill(), left the stand-in's node running
// with its parent gone, holding nothing anyone would ever kill. `taskkill /T /F`
// ends the tree from the PID down, while the parent still exists to anchor it.
//
// Resolves once the tree is gone (or the attempt is over), and calls child.kill()
// after, so the handle records the kill the way callers and tests expect. A child
// that already exited, or anything that is not a real ChildProcess (one that
// never started, or a test double carrying a made-up PID that must never reach
// taskkill or kill(2)), goes straight to child.kill(). Never throws or rejects.
//
// POSIX has no taskkill, and a plain kill leaves grandchildren the same way. A
// caller that wants its tree ended there starts the child `detached`, which makes
// it a process-group leader, and this signals the group (`-pid`). For a child that
// is not a leader there is no group with its PID (a PID is never reused while a
// group still carries it), so that signal fails with ESRCH and the plain kill
// below is all that happens: the same as before for every other caller.
//
// `detached` HAS TO GO TO spawn ITSELF (2026-10-14). execFile copies a fixed list
// of options to spawn and drops `detached` silently, so a child started through
// execFile is never a leader and takes the ESRCH branch: the trust worker did,
// and every Ubuntu CI leg left its hung codex running (src/codex-mcp-config.js,
// "SPAWN, NOT execFile").
//
// EXITED BY A SIGNAL IS EXITED (2026-10-14). A child ended by a signal (execFile's
// own timeout, or any kill from outside) has `exitCode` null and `signalCode`
// set, and by its 'exit' event Node has reaped it and closed its handle, so its
// PID is free for the system to reuse. The extension forgets a child on 'close',
// which follows 'exit' once its stdio drains (0.04-0.16 ms on the development
// box after an execFile timeout, about 16 ms in the v1.6.3 confirmation audit),
// so deactivate could reach one inside that gap. The old guard read `exitCode`
// alone and sent taskkill /T, or a group signal, to a PID that might already be
// someone else's. Suspected and not verified: taskkill /T finds the tree by
// ParentProcessId, which Windows does not clear when a parent dies, so a reused
// PID would also take every process that still names it as a parent.
//
// A CHILD STARTED ON A WORKER THREAD (src/spawn-thread.js) is ended BY that thread,
// against the ChildProcess it holds, so every rule above (the tree kill, the group
// signal, the freed-PID guard) is applied to the real handle, by this function.
// What the host holds is a ThreadChild, which answers END_TREE.
const END_TREE = Symbol.for('ai-acolyte.endProcessTree');
function endProcessTree(child) {
  const fallback = () => { try { child.kill(); } catch { /* already gone */ } };
  if (!child) return Promise.resolve();
  if (typeof child[END_TREE] === 'function') {
    try { return Promise.resolve(child[END_TREE]()).then(() => {}, () => {}); } catch { return Promise.resolve(); }
  }
  // Required here, not at the top: the CLI hook loads this module on every call,
  // and only a caller that is ending children needs a spawner.
  const childProcess = require('child_process');
  if (!(child instanceof childProcess.ChildProcess) || !Number.isInteger(child.pid)
    || child.exitCode != null || child.signalCode != null) {
    fallback();
    return Promise.resolve();
  }
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* not a group leader, or already gone */ }
    fallback();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    try {
      childProcess.execFile(taskkillPath(), ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 5000 }, () => { fallback(); resolve(); });
    } catch {
      fallback();
      resolve();
    }
  });
}

// A DEADLINE THAT ENDS THE WHOLE TREE, in place of execFile's `timeout` (2026-10-14).
// execFile's own timeout kills the one child it holds, and on Windows that child is
// routinely a launcher: an npm `codex.cmd` is cmd.exe -> node, and a venv's
// Scripts\python.exe is a redirector whose interpreter is its child (measured on
// the development box: the interpreter's parent pid was the pid execFile returned).
// Ended that way the program that matters keeps running, and nothing can reach it
// afterwards, because endProcessTree finds a tree by its root and the root is gone.
// This is the version probe's pattern (src/codex-version.js, "ITS OWN TIMER"): a
// timer that tree-kills the root while it is still alive. Returns the child, so a
// call site reads `endTreeAfter(trackChild(execFile(...)), ms)`. Cleared on 'exit',
// 'close' and a spawn's 'error'; endProcessTree's own guard refuses an exited child as
// well. Unref'd, because the child is what keeps a process alive while it runs,
// exactly as before.
//
// NOT ON 'exit' ALONE (2026-10-14, S3 of the final pre-tag audit). A program that
// cannot be started emits 'error' and then 'close', and never 'exit' (measured with
// Node 24.19.0: a missing absolute path, a missing bare name and spawn() alike). The
// timer was then held, with the ChildProcess it closes over, for the full deadline
// (30-180 s at the extension's sites). 'close' always follows that 'error', so it is
// the clear that matters. 'error' alone clears only a child that never started or has
// ended: Node also emits 'error' when a kill fails, and a child still running then
// must keep its deadline. Every caller hands an execFile child, which listens for
// 'error' itself, so the listener here gives no error a handling it lacked.
//
// The callback sees the kill as the child's exit: on Windows taskkill /F leaves exit
// code 1, on POSIX the SIGTERM. Either way execFile's error reads "Command failed:
// <command>" plus its stderr, which is all any caller here reports.
//
// POSIX IS UNCHANGED, AND THAT IS RECORDED, NOT FIXED. endProcessTree reaches a
// whole tree there only through a process group, and execFile cannot start a group
// leader (it drops `detached`; see src/codex-mcp-config.js "SPAWN, NOT execFile"),
// so this ends the child alone, as execFile's option did. The sites that use it have
// no grandchild on POSIX: a venv's python is the interpreter itself, recall.py's own
// re-run is suppressed by RECALL_REEXEC=1, and a native codex is one process.
function endTreeAfter(child, ms) {
  const deadline = Number(ms);
  if (!child || !(deadline > 0)) return child;
  const timer = setTimeout(() => { endProcessTree(child); }, deadline);
  if (typeof timer.unref === 'function') timer.unref();
  const listen = typeof child.once === 'function' ? 'once' : typeof child.on === 'function' ? 'on' : null;
  if (listen) {
    const clear = () => clearTimeout(timer);
    child[listen]('exit', clear);
    child[listen]('close', clear);
    child[listen]('error', () => {
      if (!Number.isInteger(child.pid) || child.exitCode != null || child.signalCode != null) clear();
    });
  }
  return child;
}

// `fallbackDirectories` is not exported: resolveExecutable is its only caller,
// and test/exec-resolve.test.js already drives the whole fallback through
// resolveExecutable with a fake APPDATA — including the case where PATH wins and
// the case where neither holds the name. A test on the directory LIST would pin
// less than the tests that already exist.
module.exports = {
  resolveExecutable, commandLaunch, resolvedLaunch, quoteForCommandProcessor, endProcessTree, taskkillPath, endTreeAfter,
  END_TREE, npmShimLaunch, BATCH_ARGUMENT_REFUSED_CODE,
};
