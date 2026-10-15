'use strict';

// Does Claude Code still strip the environment variables this repo thinks it strips?
//
// The reader behind two front ends: scripts/check-claude-strip-model.js, the maintenance
// command (exit codes, `--json`), and the extension, which runs it once per new Claude Code
// binary, on a worker thread, about 30 s after activation (vscode-extension/extension.js
// scheduleStripModelCheck). Moved here from the script on 2026-10-15 so it ships in the VSIX;
// scripts/ is not packaged. Read-only: the binary is opened for reading and nothing is written.
//
// WHY. Claude Code strips a leading `NAME=VALUE` before an allow rule is consulted only for
// "certain known-safe environment variables" (code.claude.com/docs/en/permissions, "Wrappers",
// read 2026-10-13), and the page does not name them. The wildcarding pass, the learner and the
// matcher all depend on the exact set (a9e2adf, 122901f): a name Claude Code adds and this
// repo lacks makes the pass keep an assignment Claude Code would have stripped (a rule that
// still matches, as written); a name Claude Code DROPS and this repo keeps makes the pass write
// `Bash(npm test *)` for `DROPPED=1 npm test`, a rule Claude Code no longer matches against that
// command, so every such run prompts again. The list was read out of 2.1.296's shipped binary on
// 2026-10-13 (MODELLED_VERSION). This is the re-read, for the one part of the strip model that
// is a plain list. CI never runs it: CI has no Claude Code binary, and the answer is about the
// copy installed on the machine it runs on.
//
// HOW. The CLI is a bundled JavaScript program, and in the 2.1.296 native binary the list is one
// string-array literal (`new Set(["GOEXPERIMENT","GOOS",...,"GIT_TERMINAL_PROMPT"])`, at byte
// 223,483,330 of a 260,489,376-byte claude.exe, measured 2026-10-13). The file is scanned in
// chunks for array literals of quoted UPPER_CASE names, and the candidate is the one array that
// holds at least half of this repo's names. No minified identifier is relied on, because those
// change every release; the names themselves are the anchor, which is also why a list that lost
// more than half of them reads as "not found" rather than as drift. A run on 2026-10-15 took
// 492 ms wall for a 257 MB binary (2.1.299, list unchanged), which is why the extension never
// runs it on the host thread.
//
// WHAT THIS DOES NOT CHECK, and how to re-read it by hand: the value class (`[A-Za-z0-9_./:-]+`,
// STRIPPED_ENV_VALUE), the wrapper shapes (wrapperLength) and the matcher's order (strip, then
// try the rule against both texts, then the `xargs ` variant). In the binary, go to the offset
// `node scripts/check-claude-strip-model.js --json` reports: a few hundred bytes on is the
// stripping function, which in 2.1.296 opens with an array of anchored wrapper regexes
// (`/^timeout[ \t]+...`, `/^time`, `/^nice`, `/^stdbuf`, `/^nohup`, `/^command`, `/^builtin`,
// `/^noglob`) and then the assignment regex `/^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:-]+)[ \t]+/`,
// applied only when the reported Set's `.has` accepts the name. Compare each with the comments
// in src/permission-match.js, which record what 2.1.296 said.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isMainThread, workerData } = require('node:worker_threads');

const { CLAUDE_SAFE_ENV_VARS } = require('./permission-match');

// The Claude Code release CLAUDE_SAFE_ENV_VARS and the case-exact lookup were read from.
const MODELLED_VERSION = '2.1.296';
const TASK = 'ai-acolyte.claude-strip-model';

const CHUNK = 16 * 1024 * 1024;
// Larger than any name list could be, so a literal that straddles a chunk boundary is seen
// whole in the next read.
const OVERLAP = 64 * 1024;
// Six or more quoted UPPER_CASE names, one quote style per name, inside one `[...]`.
const NAME_ARRAY = /\[\s*(?:(["'])[A-Z_][A-Z0-9_]*\1\s*,\s*){5,}(["'])[A-Z_][A-Z0-9_]*\2\s*\]/g;
const QUOTED_NAME = /["']([A-Z_][A-Z0-9_]*)["']/g;

// The installed VS Code extension's CLI with the highest version, from the directory name
// (`anthropic.claude-code-2.1.296-win32-x64`). Stable and Insiders both, either platform.
function defaultBinary(home = os.homedir()) {
  const found = [];
  for (const root of ['.vscode', '.vscode-insiders']) {
    const dir = path.join(home, root, 'extensions');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const version = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(name);
      if (!version) continue;
      for (const file of ['claude.exe', 'claude']) {
        const candidate = path.join(dir, name, 'resources', 'native-binary', file);
        if (fs.existsSync(candidate)) found.push({ path: candidate, version: version.slice(1).map(Number) });
      }
    }
  }
  found.sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2]);
  return found[0] || null;
}

// Every distinct quoted-name array in the file, with its first byte offset. `chunk` is for
// the tests, which put a list across a chunk boundary without writing 16 MiB. Not exported
// (the v1.6.2 audit): it is check()'s own reader, and test/check-claude-strip-model.test.js
// reaches it through check (nameArrays returning nothing fails five of its six tests).
function nameArrays(file, chunk = CHUNK) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(chunk + OVERLAP, Math.max(size, 1)));
    const arrays = new Map();
    for (let position = 0; position < size; position += chunk) {
      const length = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      const text = buffer.toString('latin1', 0, length);
      NAME_ARRAY.lastIndex = 0;
      for (let match = NAME_ARRAY.exec(text); match; match = NAME_ARRAY.exec(text)) {
        const names = [...match[0].matchAll(QUOTED_NAME)].map((item) => item[1]);
        const key = names.join(',');
        if (!arrays.has(key)) arrays.set(key, { names, offset: position + match.index });
      }
    }
    return { size, arrays: [...arrays.values()] };
  } finally {
    fs.closeSync(fd);
  }
}

// Advisory read of whether the allow-path's membership test CONVERTS the name's case before the
// lookup (M5, 2026-10-14). src/permission-match.js models the strip as case-exact (`IG.has(V)`, no
// conversion; 2.1.296 re-read at the L2/J1 offset), which is what makes `LANG=C` strip and `lang=C`
// keep its assignment. This confirms that read from the binary when it can, and says so when it
// can't, rather than guess. Best-effort and NOT wired into the script's exit code: the Set-name and
// lookup-call shapes are minified and may change, so it reports 'exact' | 'folded' | null. Finds the
// Set's variable name just before the array, then reads the `<var>.has(...)` calls near it; a bare
// identifier argument is case-exact, one wrapped in `.toUpperCase()`/`.toLowerCase()` (locale forms
// too) is case-folded. The window reaches past the array to the strip function a few hundred bytes on.
const CASEFOLD_WINDOW = 16 * 1024;
function detectLookupCaseConversion(file, offset) {
  const fd = fs.openSync(file, 'r');
  try {
    const start = Math.max(0, offset - 256);
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(CASEFOLD_WINDOW, Math.max(size - start, 1)));
    const length = fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('latin1', 0, length);
    const head = text.slice(0, offset - start);
    const name = /([A-Za-z_$][\w$]*)\s*=\s*new Set\s*\(\s*\[?$/.exec(head);
    if (!name) return null;
    const escaped = name[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const calls = new RegExp(`${escaped}\\.has\\(([^)]*)\\)`, 'g');
    let folded = false;
    let exact = false;
    for (let m = calls.exec(text); m; m = calls.exec(text)) {
      if (/\.to(?:Locale)?(?:Upper|Lower)Case\s*\(/.test(m[1])) folded = true;
      else if (/^[A-Za-z_$][\w$]*$/.test(m[1].trim())) exact = true;
    }
    return folded ? 'folded' : exact ? 'exact' : null;
  } finally {
    fs.closeSync(fd);
  }
}

// { binary, size, candidates, offsets, status: 'same' | 'drift' | 'undecided' } and, once one list
// is found, { count, added, dropped, lookupCase }. Throws when the file cannot be read.
function check(file, known = CLAUDE_SAFE_ENV_VARS, chunk = CHUNK) {
  const { size, arrays } = nameArrays(file, chunk);
  const floor = Math.max(10, Math.ceil(known.size / 2));
  const candidates = arrays.filter((array) => array.names.filter((name) => known.has(name)).length >= floor);
  // The same list twice (a bundle that carries it in two places) is one answer, not two.
  const distinct = new Map(candidates.map((array) => [[...new Set(array.names)].sort().join(','), array]));
  const result = { binary: file, size, candidates: distinct.size, offsets: candidates.map((array) => array.offset) };
  if (distinct.size !== 1) return { ...result, status: 'undecided' };
  const [found] = distinct.values();
  const theirs = new Set(found.names);
  const added = [...theirs].filter((name) => !known.has(name)).sort();
  const dropped = [...known].filter((name) => !theirs.has(name)).sort();
  const lookupCase = detectLookupCaseConversion(file, found.offset);
  return { ...result, status: added.length || dropped.length ? 'drift' : 'same', count: theirs.size, added, dropped, lookupCase };
}

// check(file) on a thread of its own, for the extension: the scan reads the whole binary
// (257 MB, 492 ms on 2026-10-15), and the extension host must not hold every other extension
// behind it. Returns { promise, terminate } at once. The promise resolves with check()'s
// result, or with { binary, status: 'unreadable', error } when the thread could not read the
// file (both are answers about this binary, which the extension keys and does not re-scan). It
// REJECTS only when the thread itself was lost (it could not start, or stopped without an
// answer, as terminate() makes it), which says nothing about the binary. One thread per call;
// it exits by itself once it has answered.
function checkOffThread(file) {
  const { Worker } = require('node:worker_threads');
  let worker = null;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    worker = new Worker(__filename, { workerData: { [TASK]: { file } } });
    worker.once('message', (message) => settle(resolve, message?.result
      ?? { binary: file, status: 'unreadable', error: String(message?.error ?? 'no answer') }));
    worker.once('error', (error) => settle(reject, error));
    worker.once('exit', (code) => settle(reject, new Error(`the strip-model thread exited ${code} without an answer`)));
  });
  return { promise, terminate: () => { try { worker?.terminate(); } catch { /* already gone */ } } };
}

// The thread's half.
if (!isMainThread && workerData && workerData[TASK]) {
  const { parentPort } = require('node:worker_threads');
  let message;
  try { message = { result: check(workerData[TASK].file) }; }
  catch (error) { message = { error: String((error && error.message) || error) }; }
  parentPort.postMessage(message);
}

module.exports = { MODELLED_VERSION, check, checkOffThread, defaultBinary };
