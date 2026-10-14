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
  const onPath = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  // PATH stays authoritative; the fallback only answers where PATH said nothing.
  return probeDirectories(onPath, value, extensions) ||
    probeDirectories(fallbackDirectories(), value, extensions);
}

// Inside double quotes the command processor stops treating & | < > ^ ( ) as
// syntax, so quoting every token is enough to keep an argument whole. Doubling
// an embedded quote is the escape cmd.exe understands. %NAME% expansion stays
// live inside quotes and has no escape on a command line, so a token spelled
// like an environment variable would still expand; learned prefixes are
// tokenized command words, which is why that is a legibility edge and not a
// hole here.
function quoteForCommandProcessor(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

// Describes how to launch `name` with `args`: the file to spawn, the arguments
// to pass, and any spawn options the form requires. Callers spread `options`
// into their own so execFile and spawnSync can share one decision.
function commandLaunch(name, args = []) {
  const list = (Array.isArray(args) ? args : []).map(String);
  const resolved = resolveExecutable(name);
  // Unresolved on Windows means nothing on PATH matched. Hand the bare name
  // back so the caller's own ENOENT contract still fires rather than inventing
  // a different failure here.
  if (!resolved) return { file: String(name == null ? '' : name), args: list, options: {}, resolved: null };
  if (process.platform !== 'win32' || !BATCH_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    return { file: resolved, args: list, options: {}, resolved };
  }
  const line = [resolved, ...list].map(quoteForCommandProcessor).join(' ');
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
    resolved,
  };
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
function endProcessTree(child) {
  const fallback = () => { try { child.kill(); } catch { /* already gone */ } };
  if (!child) return Promise.resolve();
  // Required here, not at the top: the CLI hook loads this module on every call,
  // and only a caller that is ending children needs a spawner.
  const childProcess = require('child_process');
  if (!(child instanceof childProcess.ChildProcess) || !Number.isInteger(child.pid) || child.exitCode != null) {
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
      childProcess.execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 5000 }, () => { fallback(); resolve(); });
    } catch {
      fallback();
      resolve();
    }
  });
}

// `fallbackDirectories` is not exported: resolveExecutable is its only caller,
// and test/exec-resolve.test.js already drives the whole fallback through
// resolveExecutable with a fake APPDATA — including the case where PATH wins and
// the case where neither holds the name. A test on the directory LIST would pin
// less than the tests that already exist.
module.exports = {
  resolveExecutable, commandLaunch, quoteForCommandProcessor, endProcessTree,
};
