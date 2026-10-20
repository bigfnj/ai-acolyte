'use strict';

// Pure planning for the MEMORY.md guard's entry in Claude Code's settings.json. No file is
// read or written here: src/memory-guard-install.js owns the IO, and hands planMemoryGuard to
// the settings writer's compare-and-swap writeTransform, which runs it against a fresh read.
// Modelled on src/codex-hook-config.js.
//
// OWNERSHIP IS THE PATH. A handler is ours when its command names the guard's stable copy,
// `<home>/.claude/wildcarding/memory-index-guard.js`, exactly. Ours with any other field
// changed (another node, another timeout, another matcher) is `outdated`, and turning the
// guard on repairs it. A handler that runs a `memory-index-guard.js` from somewhere else is a
// near match and `foreign`: turning the guard on refuses rather than run two guards, and
// turning it off leaves that handler alone, because a near match is not proof of authorship.
//
// NO `if` FIELD (2026-10-19). Claude Code's hook `if` would let the process skip spawning for
// every Write that is not to a MEMORY.md, but its semantics for Write could not be checked on
// the development box, whose managed policy stops every user hook from running. The guard
// filters the path in-process instead, first thing, and costs one node start per Write or Edit.
// Correctness over latency until `if` is verified on a box where hooks run.

const path = require('path');
const { isDeepStrictEqual } = require('util');

const MEMORY_GUARD_EVENT = 'PreToolUse';
const MEMORY_GUARD_MATCHER = 'Write|Edit|MultiEdit';
// Seconds. The guard reads one small file; a hung run is ended at this and Claude Code goes on
// with the edit, so the ceiling bounds the cost and never blocks a write by itself.
const MEMORY_GUARD_TIMEOUT = 10;
const MEMORY_GUARD_FILE = 'memory-index-guard.js';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// Inside double quotes a POSIX shell still expands `$` and backticks, and a quote ends the
// argument. Claude Code runs a hook command through a shell (sh, or Git Bash on Windows), so a
// path carrying any of them could not arrive as written; refused rather than escaped.
const UNSAFE = /[\u0000-\u001f\u007f"`$]/;

function memoryGuardScriptPath(home) {
  if (typeof home !== 'string' || !home) throw new Error('the MEMORY.md guard needs a home directory');
  return path.join(path.resolve(home), '.claude', 'wildcarding', MEMORY_GUARD_FILE);
}

// Forward slashes on Windows, the spelling install.ps1 registers for the PostToolUse hook:
// Git Bash, PowerShell and cmd.exe all read them, and a backslash is an escape to two of them.
function spelled(file, platform) {
  return platform === 'win32' ? file.replace(/\\/g, '/') : file;
}

function checked(value, label, platform) {
  if (UNSAFE.test(value) || (platform !== 'win32' && value.includes('\\'))) {
    throw new Error(`the MEMORY.md guard's ${label} path contains a character a shell would rewrite: ${value}`);
  }
  return value;
}

// The group this module writes. Never `async`: an async hook cannot block a tool call.
function memoryGuardDefinition({ home, nodeExecutable, platform = process.platform } = {}) {
  if (typeof nodeExecutable !== 'string' || !nodeExecutable || !path.isAbsolute(nodeExecutable)) {
    throw new Error('the MEMORY.md guard needs an absolute path to node');
  }
  const script = checked(spelled(memoryGuardScriptPath(home), platform), 'script', platform);
  const node = checked(spelled(nodeExecutable, platform), 'node', platform);
  return { matcher: MEMORY_GUARD_MATCHER,
    hooks: [{ type: 'command', command: `"${node}" "${script}"`, timeout: MEMORY_GUARD_TIMEOUT }] };
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Does this command name our stable copy, as a whole path? Case and separators fold on
// Windows, so a hand-written backslash spelling of the same file is still recognised.
function namesOurScript(command, home, platform) {
  if (typeof command !== 'string') return false;
  const fold = (text) => (platform === 'win32' ? text.replace(/\\/g, '/').toLowerCase() : text);
  const script = fold(spelled(memoryGuardScriptPath(home), platform));
  return new RegExp(`(?:^|["'\\s])${escapeRe(script)}(?=["'\\s]|$)`).test(fold(command));
}

function namesAGuard(command) {
  return typeof command === 'string' && /memory-index-guard\.js(?=["'\s]|$)/i.test(command);
}

// The node a registered command names, from the `"<node>" "<script>"` spelling we write.
function nodeFromCommand(command) {
  const match = typeof command === 'string' ? /^\s*"([^"]+)"\s/.exec(command) : null;
  return match ? match[1] : null;
}

// What settings.json holds for the guard:
//   missing      no handler of ours
//   configured   exactly one, byte for byte what memoryGuardDefinition writes, in a group
//                matching Write|Edit|MultiEdit
//   outdated     ours (it names our stable path) but some field differs, or there are several
//   foreign      another hook runs a memory-index-guard.js from a different path
//   unsupported  the hooks shape cannot be read safely
// `options.nodeExecutable` says which node the expected definition uses; without it, the node
// our own registered command names, which is how status reads an install it did not make.
function inspectMemoryGuard(settings, options = {}) {
  const platform = options.platform || process.platform;
  const home = options.home;
  const base = { status: 'missing', ours: [], foreign: [], node: null, reason: null };
  if (!object(settings)) return { ...base, status: 'unsupported', reason: 'settings.json does not hold an object' };
  const hooks = settings.hooks;
  if (hooks === undefined) return base;
  if (!object(hooks)) return { ...base, status: 'unsupported', reason: '`hooks` is not an object' };
  const groups = hooks[MEMORY_GUARD_EVENT];
  if (groups === undefined) return base;
  if (!Array.isArray(groups)) return { ...base, status: 'unsupported', reason: `hooks.${MEMORY_GUARD_EVENT} is not an array` };
  const ours = [];
  const foreign = [];
  for (const group of groups) {
    if (!object(group) || !Array.isArray(group.hooks) || group.hooks.some((handler) => !object(handler))) {
      return { ...base, status: 'unsupported', reason: `a hooks.${MEMORY_GUARD_EVENT} group is malformed` };
    }
    for (const handler of group.hooks) {
      if (namesOurScript(handler.command, home, platform)) ours.push({ group, handler });
      else if (namesAGuard(handler.command)) foreign.push(handler.command);
    }
  }
  const node = options.nodeExecutable || (ours.length ? nodeFromCommand(ours[0].handler.command) : null);
  const found = { ...base, ours, foreign, node };
  if (foreign.length) {
    return { ...found, status: 'foreign',
      reason: `another hook already runs a MEMORY.md guard from a different path: ${foreign[0]}` };
  }
  if (!ours.length) return found;
  let expected = null;
  try { expected = node ? memoryGuardDefinition({ home, nodeExecutable: node, platform }) : null; } catch { expected = null; }
  const exact = ours.length === 1 && expected !== null && ours[0].group.matcher === MEMORY_GUARD_MATCHER
    && isDeepStrictEqual(ours[0].handler, expected.hooks[0]);
  return exact ? { ...found, status: 'configured' }
    : { ...found, status: 'outdated', reason: ours.length > 1
      ? 'more than one hook runs the guard'
      : 'the guard hook differs from the definition this version writes' };
}

// Every group with our handlers taken out. A group left empty is dropped only when it carried
// nothing but `matcher` and `hooks`, which is the shape this module writes; a group with any
// other key, or with someone else's handler beside ours, survives with the rest of its contents.
function withoutOurs(groups, home, platform) {
  return groups.flatMap((group) => {
    const hooks = group.hooks.filter((handler) => !namesOurScript(handler.command, home, platform));
    if (hooks.length === group.hooks.length) return [group];
    const plain = Object.keys(group).every((key) => key === 'matcher' || key === 'hooks');
    return hooks.length || !plain ? [{ ...group, hooks }] : [];
  });
}

// Pure: the transform handed to writeTransform, which writes `settings` only when `changed` is
// true and the file did not move underneath it. Adds, repairs or removes our handler and nothing
// else: other events, other PreToolUse groups and every other key ride through untouched.
function planMemoryGuard(settings, enabled, options = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  const platform = options.platform || process.platform;
  const before = inspectMemoryGuard(settings, options);
  if (before.status === 'unsupported') {
    throw new Error(`refusing to change the MEMORY.md guard: ${before.reason}; nothing was changed`);
  }
  if (enabled && before.status === 'foreign') {
    throw new Error(`refusing to add the MEMORY.md guard: ${before.reason}. Remove that hook by hand first; nothing was changed`);
  }
  if (enabled && before.status === 'configured') return { changed: false, settings, status: 'configured' };
  if (!enabled && !before.ours.length) return { changed: false, settings, status: before.status };
  const hooks = { ...(settings.hooks || {}) };
  const remaining = withoutOurs(hooks[MEMORY_GUARD_EVENT] || [], options.home, platform);
  if (enabled) {
    hooks[MEMORY_GUARD_EVENT] = [...remaining, memoryGuardDefinition({ ...options, platform })];
    return { changed: true, settings: { ...settings, hooks }, status: 'configured' };
  }
  if (remaining.length) hooks[MEMORY_GUARD_EVENT] = remaining;
  else delete hooks[MEMORY_GUARD_EVENT];
  const next = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  return { changed: true, settings: next, status: before.foreign.length ? 'foreign' : 'missing' };
}

module.exports = { memoryGuardScriptPath, memoryGuardDefinition, inspectMemoryGuard, planMemoryGuard };
