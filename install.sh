#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_CMD="$SCRIPT_DIR/bin/wildcard-perms"
SETTINGS="$HOME/.claude/settings.json"

chmod +x "$HOOK_CMD"

# ── Windows under Git Bash, MSYS2 or Cygwin ───────────────────────────────────
#
# The node this script runs there is the native Windows build, and it cannot
# open a POSIX spelling such as /c/repo, or /tmp/x (Git Bash mounts %TEMP% at
# /tmp). Git Bash quietly converts a path passed as a WHOLE argument or
# environment variable, which is why HOOK_CMD below reached node intact, but
# not one embedded inside code. Found 2026-10-13: the starter-pack count ran
# `require('/c/.../starter-pack.json')`, threw "Cannot find module" with a full
# stack, and printed "Merges  curated permissions" with no number. The install
# went on, because a failing $(...) inside an echo does not trip `set -e`.
# Cygwin leaves arguments alone even when they are whole paths.
#
# So the spelling node is given is computed once, here, with cygpath, which
# Git for Windows, MSYS2 and Cygwin all ship: -m for C:/forward/slashes, -l for
# the long form of any 8.3 component. Without cygpath, or anywhere else, it
# stays the POSIX path, which is what Linux and macOS need.
#
# The hook command changes there too. On Linux and macOS it is the bare path:
# the shebang plus the chmod above make the file executable. Windows has no
# shebang support, and an extensionless file has no association, so a bare
# path makes Windows ask "How do you want to open this file?" on every hook
# fire. That is why install.ps1 registers `node "<C:/forward/slash path>"`.
# Found 2026-10-13: this script, run from Git Bash, registered the bare
# C:/.../bin/wildcard-perms instead, because Git Bash had converted HOOK_CMD on
# its way into node. HOOK_VIA_NODE=1 makes the module register `node "$HOOK_CMD"`,
# built from the same C:/ path it compares with, so on Windows both installers
# write the same command. A bare registration of THIS checkout is rewritten
# into that form, not left as "already registered".
NODE_DIR="$SCRIPT_DIR"
HOOK_VIA_NODE=0
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    if command -v cygpath >/dev/null 2>&1; then
      NODE_DIR="$(cygpath -m -l "$SCRIPT_DIR")" || NODE_DIR="$SCRIPT_DIR"
    fi
    HOOK_CMD="$NODE_DIR/bin/wildcard-perms"
    HOOK_VIA_NODE=1
    ;;
esac

# install.ps1 creates this; install.sh did not, so a fresh POSIX machine failed
# with ENOENT on the write below and `set -e` aborted before the starter-pack
# prompt. The Windows half has carried the mkdir since it was fixed there.
mkdir -p "$(dirname "$SETTINGS")"

# ── 1. Register PostToolUse hook ──────────────────────────────────────────────
HOOK_CMD="$HOOK_CMD" HOOK_VIA_NODE="$HOOK_VIA_NODE" SETTINGS="$SETTINGS" node --input-type=module <<'EOF'
import { readFileSync, writeFileSync, existsSync, realpathSync, statSync } from 'fs';
import { isAbsolute } from 'path';

const settingsPath = process.env.SETTINGS;
const hookCmd      = process.env.HOOK_CMD;
// The command written into settings.json: the bare path, or on Windows (see the
// uname block at the top) `node "<path>"`, exactly install.ps1's spelling.
//
// A bare path with whitespace in it is QUOTED, found 2026-10-14. Claude Code hands
// `command` to a shell, `sh -c` on Linux and macOS and Git Bash on Windows
// (code.claude.com/docs/en/hooks, "Exec form and shell form", read 2026-10-14), and
// a shell splits an unquoted path at its space: `/Users/Jo Doe/acolyte/bin/wildcard-perms`
// runs `/Users/Jo` and fails on every tool call. This script registered exactly that
// from v1.0.0 on, from any checkout under such a path. Single quotes, because nothing
// inside them is special to sh; a path that itself holds a `'` gets double quotes.
// A path without whitespace keeps the bare spelling byte for byte.
const viaNode      = process.env.HOOK_VIA_NODE === '1';
const shellQuoted  = (p) => (!/\s/.test(p) ? p : p.includes("'") ? `"${p}"` : `'${p}'`);
const hookCommand  = viaNode ? `node "${hookCmd}"` : shellQuoted(hookCmd);

// "async": true, since 2026-10-14. A synchronous PostToolUse hook is waited for on
// every Bash and PowerShell call, and this one does nothing that call needs: it
// rewrites the allow list for the NEXT prompt, prints nothing on stdout, and writes
// one stderr line only on the rare call that changes something. On the development
// box a bare `node -e 0` costs ~330 ms (endpoint security), so every tool call
// waited 0.35-0.57 s on it against ~4 ms of the product's own work (v1.6.2
// performance audit).
//
// The key is documented for command hooks, "If true, runs in the background
// without blocking", and an async hook "can't block or control Claude's behavior",
// which this one never tries to (code.claude.com/docs/en/hooks, "Run hooks in the
// background", read 2026-10-14). It entered the CLI's schema in 2.1.15
// (2026-01-21): absent from 2.1.14's published cli.js, present in 2.1.15's. An
// OLDER client ignores it rather than rejecting it, and that had to be shown,
// because before 2.1.122 a malformed hooks entry invalidated the WHOLE
// settings.json, allow list and all (CHANGELOG 2.1.122). Every published cli.js
// from 1.0.82 to 2.1.14 declares the command hook as a plain zod object() with
// no .strict(), which strips an unknown key instead of failing the parse, so
// there the hook simply stays synchronous, as before.
//
// Overlapping runs are safe: they contend for the policy lock, the loser exits
// silently and the next tool call retries, and the pass is idempotent (the
// finish() comment in bin/wildcard-perms). Known costs: `claude -p` kills a run
// still going at teardown and the next session redoes it, and 2.1.15-2.1.118
// wrote an empty transcript entry per async PostToolUse hook with no output
// (fixed in 2.1.119).
//
// Written on a new registration, on a repoint, and on this checkout's own
// registration when the key is ABSENT. A hook that already carries `async`, of
// any value, is the user's choice and is left alone; recognising a registration
// never looks at the key.
const ASYNC_HOOK   = true;

// `catch {}` here meant that ANY read failure fell through to `cfg = {}` and
// the write below replaced the user's whole settings.json with just this hook.
// ENOENT is the legitimate case; a SyntaxError is not — it is the zero-byte or
// half-written window of somebody else's atomic write, which src/settings-write.js
// calls routine "because Claude Code rewrites this file in place on every
// /model, /effort and approval". uninstall.sh, in this same directory, already
// draws exactly this distinction and refuses; the installer never did.
let cfg = {};
let originalRaw = null;   // the bytes as found, for the backup below
try {
  originalRaw = readFileSync(settingsPath, 'utf8');
  if (originalRaw.trim() === '') {
    console.error(`✗ ${settingsPath} is present but empty — refusing to write over it.`);
    console.error('  That is usually a file being written right now. Re-run in a moment.');
    process.exit(1);
  }
  cfg = JSON.parse(originalRaw);
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    console.error(`✗ ${settingsPath} does not contain a JSON object — left untouched.`);
    process.exit(1);
  }
} catch (error) {
  if (error.code !== 'ENOENT') {
    // Fail closed. Nothing is written, so the damaged file stays recoverable.
    console.error(`✗ ${settingsPath} could not be parsed — left untouched.`);
    console.error(`  ${error.message}`);
    console.error('  Nothing was changed. Fix or move the file, then re-run.');
    process.exit(1);
  }
  originalRaw = null;     // genuinely absent, so there is nothing to back up
}

cfg.hooks ??= {};
cfg.hooks.PostToolUse ??= [];

// ── Registrations of this tool from ANY checkout, not only this one ──────────
//
// This used to be `h.command === hookCmd`, an exact match on THIS checkout's
// path, and install.ps1 had the same shape. Found live 2026-10-13: the
// development box's PostToolUse hook still pointed at an old checkout of this
// repo (the directory name from before the rename, v1.4.13, 142 commits behind)
// while the maintained checkout had been cloned under the new name. An install
// from a moved, renamed or re-cloned checkout matched nothing, so it APPENDED a
// second entry beside the stale one; both fired on every tool call and the stale
// one kept running old code. Every fix since 1.4.13, the MAX retirement among
// them, never reached a real tool call, and nothing said so.
//
// The rules, identical to install.ps1's (its comment carries the reasoning for
// each): no registration -> append; this checkout's -> leave the file alone;
// another checkout's -> rewrite that hook's command in place, keeping matcher,
// position and other fields, and say old -> new; several under ONE matcher ->
// keep one (this checkout's if present, else the first, repointed) and remove
// the others per hook, reporting each. Grouped by matcher because a
// "Bash" + "PowerShell" split is a real shape and collapsing it would blind the
// hook to one tool. Whether the old path still exists does not block anything:
// running this installer is the statement of which checkout is the hook.
//
// One more, on Windows only (viaNode): this checkout registered as a BARE path
// is rewritten in place to `node "<path>"`, with its own notice. That bare
// spelling is exactly what this script used to write from Git Bash, and it
// makes Windows ask how to open the file on every hook fire, so "already
// registered" would leave the defect standing. A `node ...` spelling of this
// checkout, in any casing or slash direction, is left exactly as it is. And
// on every platform, this checkout registered UNQUOTED with whitespace in its
// path is rewritten to the quoted form (see hookCommand above): it is the
// spelling this script wrote there before 2026-10-14, and a shell splits it.
const onWindows = process.platform === 'win32';

// The path a hook command runs, if and only if it runs THIS tool: `node <path>`
// or a bare `<path>`, the path optionally quoted whole, ending in a `bin`
// directory holding a file named exactly `wildcard-perms`. Strict, because a
// false match REWRITES somebody else's hook: extra arguments, a wrapper,
// `wildcard-perms.js`, `wildcard-perms-audit` or a command that merely mentions
// the name all return null. Case and `\` are folded only on Windows; on POSIX a
// backslash is a filename character and `BIN/` is a different directory.
//
// An UNQUOTED path with whitespace in it is ambiguous on its face, and was
// refused outright until 2026-10-14. To a person `/opt/my tools/acolyte/bin/wildcard-perms`
// is one path; to a shell it is two words, and `/usr/bin/env node /x/bin/wildcard-perms`
// has exactly that shape and is a wrapper. Refusing all of them meant the
// registration this script itself wrote from a checkout under such a path (see
// hookCommand) was never recognised again: a reinstall from a moved or re-cloned
// checkout APPENDED a second entry beside it, the defect this scan exists to stop,
// and both uninstallers could neither remove nor name it. So it counts only when it
// provably names ONE file (namesOneFile): this checkout, or a file by exactly that
// name. A wrapper's whole command line is never the name of a file.
const toolTarget = (command) => {
  if (typeof command !== 'string') return null;
  // The old exact match stays THIS checkout, whatever the grammar makes of it.
  if (command === hookCmd) return hookCmd;
  let text = command.trim();
  const wrapped = (onWindows ? /^node\s+(.+)$/i : /^node\s+(.+)$/).exec(text);
  if (wrapped) text = wrapped[1].trim();
  const quoted = /^"([^"]+)"$/.exec(text) || /^'([^']+)'$/.exec(text);
  if (quoted) text = quoted[1];
  const tail = onWindows ? /[\\/]bin[\\/]wildcard-perms$/i : /\/bin\/wildcard-perms$/;
  if (!tail.test(text)) return null;
  if (!quoted && /\s/.test(text) && !namesOneFile(text)) return null;
  return text;
};

// Called only from toolTarget, so only from the scan below, after every const it
// reads has been initialised.
const namesOneFile = (text) => {
  const p = nativePath(text);
  if (!isAbsolute(p)) return false;
  if (comparable(text) === comparable(hookCmd)) return true;
  try { return statSync(p).isFile(); } catch { return false; }
};

// On Windows one path has several spellings: `\` or `/`, /d/repo (Git Bash's
// own), /cygdrive/d/repo (Cygwin's) or D:/repo (install.ps1, and this script,
// whose HOOK_CMD reaches node in that form there), any casing. The /cygdrive/
// form was not folded until 2026-10-14, and the cost was in the WORDS: node
// resolves /cygdrive/c/x to C:\cygdrive\c\x, which never exists, so this
// checkout spelled that way was "repointed from another checkout ... (the old
// path no longer exists)", and a live other checkout was "gone" to the
// uninstallers and removed as one.
const nativePath = (p) => {
  if (!onWindows) return p;
  const text = p.replace(/\\/g, '/');
  const drive = /^(?:\/cygdrive)?\/([A-Za-z])\//i.exec(text);
  return drive ? `${drive[1]}:/${text.slice(drive[0].length)}` : text;
};
// One file can have more than one spelling even after that folding, found
// 2026-10-13: an 8.3 short path (C:/Users/SHORTN~1.EXT/...) and its long form
// name the same checkout, and so do a symlinked or junctioned directory and its
// target. Compared as text they differ, so this checkout registered under the
// other spelling was "repointed from another checkout", which it is not. (Git
// Bash produces the short form by itself whenever a checkout sits under /tmp.)
// realpath gives a file that exists its one canonical spelling, on Windows the
// long form; a relative path, or one that does not exist, is compared as written,
// so a stale checkout still reads as stale.
const canonical = (p) => {
  if (!isAbsolute(p)) return p;
  try { return realpathSync.native(p); } catch { return p; }
};
const comparable = (p) => {
  const text = nativePath(canonical(nativePath(p))).replace(/\/+$/, '');
  return onWindows ? text.toLowerCase() : text;
};

const current = comparable(hookCmd);
const found = [];
for (const entry of cfg.hooks.PostToolUse) {
  if (!Array.isArray(entry?.hooks)) continue;
  for (const hook of entry.hooks) {
    const target = toolTarget(hook?.command);
    if (target === null) continue;
    found.push({
      hook,
      target,
      current: comparable(target) === current,
      bare: !/^node\s/i.test(hook.command.trim()),
      // Unquoted, with whitespace in the path: what a shell splits. The grammar
      // admits a quoted path only when the quotes close the command.
      split: /\s/.test(target) && !/["']$/.test(hook.command.trim()),
      matcher: typeof entry.matcher === 'string' ? entry.matcher : '',
    });
  }
}

// Which registration survives under each matcher: this checkout's first, else
// the first found.
const keepers = new Map();
for (const f of found) if (f.current && !keepers.has(f.matcher)) keepers.set(f.matcher, f);
for (const f of found) if (!keepers.has(f.matcher)) keepers.set(f.matcher, f);

const notices = [];
const drop = new Set();
for (const f of found) {
  if (keepers.get(f.matcher) !== f) {
    drop.add(f.hook);
    notices.push(`✓ removed a duplicate wildcard-perms hook (matcher ${JSON.stringify(f.matcher)}): ${f.target}`);
  } else if (!f.current) {
    // In place: the hook keeps its key order and any field beside `command`.
    f.hook.command = hookCommand;
    const old = nativePath(f.target);
    const gone = isAbsolute(old) && !existsSync(old) ? ' (the old path no longer exists)' : '';
    notices.push(`✓ wildcard-perms hook repointed from another checkout: ${f.target} -> ${hookCmd}${gone}`);
  } else if (viaNode && f.bare) {
    // This checkout, but bare on Windows: in place too, and not called another
    // checkout, because it is not one.
    const old = f.hook.command;
    f.hook.command = hookCommand;
    notices.push(`✓ wildcard-perms hook now runs through node, because Windows cannot run the bare path: ${old} -> ${hookCommand}`);
  } else if (f.split) {
    // This checkout, unquoted with a space in its path: what this script wrote
    // there before 2026-10-14, and what a shell runs as two words. In place.
    const old = f.hook.command;
    f.hook.command = hookCommand;
    notices.push(`✓ wildcard-perms hook path quoted, because a shell splits an unquoted path at its space: ${old} -> ${hookCommand}`);
  }
  // The registration that stays, in any of the branches above, runs in the
  // background unless it already says otherwise (ASYNC_HOOK has why).
  if (keepers.get(f.matcher) === f && !Object.hasOwn(f.hook, 'async')) {
    f.hook.async = ASYNC_HOOK;
    notices.push(`✓ wildcard-perms hook now runs in the background ("async": true), so a tool call no longer waits for it: ${f.hook.command}`);
  }
}

if (drop.size) {
  // Removed PER HOOK, the uninstallers' rule: an entry left empty goes, one that
  // also holds a neighbour's hook keeps it, with its matcher.
  cfg.hooks.PostToolUse = cfg.hooks.PostToolUse.flatMap((entry) => {
    if (!Array.isArray(entry?.hooks) || !entry.hooks.some((h) => drop.has(h))) return [entry];
    const survivors = entry.hooks.filter((h) => !drop.has(h));
    return survivors.length ? [{ ...entry, hooks: survivors }] : [];
  });
}

if (!found.length || notices.length) {
  if (!found.length) {
    cfg.hooks.PostToolUse.push({
      matcher: 'Bash|PowerShell',
      hooks: [{ type: 'command', command: hookCommand, async: ASYNC_HOOK }],
    });
  }
  // The bytes as FOUND, not the object we are about to write — by now `cfg`
  // has the new hook pushed into it, or a stale one repointed or removed.
  //
  // This is one of FOUR unlocked, non-atomic writes to settings.json in the
  // project — the others are install.ps1, uninstall.sh and uninstall.ps1, each
  // of which writes the file the same way. Everything in-process goes through
  // writeFileAtomicSync and the policy lock, neither of which a standalone
  // install script can reach. A copy is the next-best thing; both .ps1 scripts
  // take one too, and uninstall.sh is the one of the four that does not.
  if (originalRaw !== null) {
    try { writeFileSync(settingsPath + '.pre-install-backup', originalRaw); }
    catch { /* best effort: never block the install on the backup */ }
  }
  writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + '\n');
  if (!found.length) console.log('✓ wildcard-perms registered as PostToolUse hook in ~/.claude/settings.json');
  for (const notice of notices) console.log(notice);
} else {
  console.log('✓ wildcard-perms already registered');
}
EOF

# ── 2. Optional: seed allow list from starter pack ────────────────────────────
echo ""
echo "Starter pack: $SCRIPT_DIR/patterns/starter-pack.md"
# The path goes to node as an ARGUMENT, never spliced into the code, so no
# quoting or path spelling can change what the code says. NODE_DIR: see above.
echo "Merges $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).length)' "$NODE_DIR/patterns/starter-pack.json") curated permissions into your allow list."
echo ""
read -r -p "Seed your allow list from the starter pack? [y/N] " answer

case "$answer" in
  [Yy]|[Yy][Ee][Ss])
    node "$HOOK_CMD" --seed
    ;;
  *)
    echo "Skipped — run 'node $HOOK_CMD --seed' at any time to import."
    ;;
esac

echo ""
echo "Done. Reload your Claude Code window to activate the hook."
