'use strict';

// Does Claude Code still strip the environment variables this repo thinks it strips?
//
//   node scripts/check-claude-strip-model.js                    the newest installed VS Code extension's CLI
//   node scripts/check-claude-strip-model.js --binary <path>    any Claude Code CLI: the native claude(.exe),
//                                                               or the npm package's cli.js
//   node scripts/check-claude-strip-model.js --json             machine-readable
//
// Exit 0: the binary's known-safe name list is CLAUDE_SAFE_ENV_VARS (src/permission-match.js)
// exactly. Exit 1: it differs; the names it adds and the names it dropped are printed. Exit 2:
// no decision, because no binary was found or readable, no list was found in it, or more than
// one candidate list was, which means the bundle changed shape and the read has to be redone
// by hand. Read-only: the binary is opened for reading and nothing is written anywhere.
//
// WHY. Claude Code strips a leading `NAME=VALUE` before an allow rule is consulted only for
// "certain known-safe environment variables" (code.claude.com/docs/en/permissions, "Wrappers",
// read 2026-10-13), and the page does not name them. The wildcarding pass, the learner and the
// matcher all depend on the exact set (a9e2adf, 122901f): a name Claude Code adds and this
// repo lacks makes the pass keep an assignment Claude Code would have stripped (a rule that
// still matches, as written); a name Claude Code DROPS and this repo keeps makes the pass write
// `Bash(npm test *)` for `DROPPED=1 npm test`, a rule Claude Code no longer matches against that
// command, so every such run prompts again. The list was read out of 2.1.296's shipped binary on
// 2026-10-13, and nothing re-reads it when Claude Code updates. This is that re-read, for the one
// part of the strip model that is a plain list. It is a maintenance check: it is not wired into
// the extension, the hook or CI, because CI has no Claude Code binary and the answer is about the
// copy installed on the machine it runs on.
//
// HOW. The CLI is a bundled JavaScript program, and in the 2.1.296 native binary the list is one
// string-array literal (`new Set(["GOEXPERIMENT","GOOS",...,"GIT_TERMINAL_PROMPT"])`, at byte
// 223,483,330 of a 260,489,376-byte claude.exe, measured 2026-10-13). The file is scanned in
// chunks for array literals of quoted UPPER_CASE names, and the candidate is the one array that
// holds at least half of this repo's names. No minified identifier is relied on, because those
// change every release; the names themselves are the anchor, which is also why a list that lost
// more than half of them reads as "not found" rather than as drift.
//
// WHAT THIS DOES NOT CHECK, and how to re-read it by hand: the value class (`[A-Za-z0-9_./:-]+`,
// STRIPPED_ENV_VALUE), the wrapper shapes (wrapperLength) and the matcher's order (strip, then
// try the rule against both texts, then the `xargs ` variant). In the binary, go to the offset
// this script reports (`--json`): a few hundred bytes on is the stripping function, which in
// 2.1.296 opens with an array of anchored wrapper regexes (`/^timeout[ \t]+...`, `/^time`,
// `/^nice`, `/^stdbuf`, `/^nohup`, `/^command`, `/^builtin`, `/^noglob`) and then the
// assignment regex `/^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:-]+)[ \t]+/`, applied only when
// the reported Set's `.has` accepts the name. Compare each with the comments in
// src/permission-match.js, which record what 2.1.296 said.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { CLAUDE_SAFE_ENV_VARS } = require('../src/permission-match');

const CHUNK = 16 * 1024 * 1024;
// Larger than any name list could be, so a literal that straddles a chunk boundary is seen
// whole in the next read.
const OVERLAP = 64 * 1024;
// Six or more quoted UPPER_CASE names, one quote style per name, inside one `[...]`.
const NAME_ARRAY = /\[\s*(?:(["'])[A-Z_][A-Z0-9_]*\1\s*,\s*){5,}(["'])[A-Z_][A-Z0-9_]*\2\s*\]/g;
const QUOTED_NAME = /["']([A-Z_][A-Z0-9_]*)["']/g;

function parseArgs(argv) {
  const options = { binary: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--binary' && argv[i + 1]) options.binary = argv[++i];
    else if (argv[i] === '--json') options.json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') options.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return options;
}

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
// the tests, which put a list across a chunk boundary without writing 16 MiB.
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
  return { ...result, status: added.length || dropped.length ? 'drift' : 'same', count: theirs.size, added, dropped };
}

function main(argv) {
  let options;
  try { options = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
  if (options.help) {
    console.log('usage: node scripts/check-claude-strip-model.js [--binary <path>] [--json]');
    return 0;
  }
  const located = options.binary ? { path: options.binary } : defaultBinary();
  if (!located) {
    console.error('no Claude Code CLI found under ~/.vscode*/extensions/anthropic.claude-code-*; pass --binary <path>');
    return 2;
  }
  let result;
  try { result = check(located.path); } catch (error) {
    console.error(`could not read ${located.path}: ${error.message}`);
    return 2;
  }
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else if (result.status === 'undecided') {
    console.log(`${result.binary}: ${result.candidates} candidate lists, expected 1. The bundle changed shape;`
      + ' re-read the strip model by hand (this script\'s header says where).');
  } else {
    console.log(`${result.binary}: ${result.count} known-safe names, CLAUDE_SAFE_ENV_VARS has ${CLAUDE_SAFE_ENV_VARS.size}.`);
    if (result.status === 'same') console.log('Same set.');
    else {
      if (result.added.length) console.log(`Claude Code strips, this repo does not: ${result.added.join(' ')}`);
      if (result.dropped.length) console.log(`This repo strips, Claude Code no longer does: ${result.dropped.join(' ')}`);
      console.log('Update CLAUDE_SAFE_ENV_VARS (src/permission-match.js), the literal in test/permissions-env.test.js,'
        + ' and docs/claude-code-permissions.md section 3, on this evidence.');
    }
  }
  return { same: 0, drift: 1 }[result.status] ?? 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

// nameArrays left this list 2026-10-14 (v1.6.2 audit): nothing imported it, and it is
// check()'s own reader, so test/check-claude-strip-model.test.js reaches it through
// check and main (nameArrays returning nothing fails five of its six tests).
module.exports = { check, defaultBinary, main };
