#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_CMD="$SCRIPT_DIR/bin/wildcard-perms"
SETTINGS="$HOME/.claude/settings.json"

chmod +x "$HOOK_CMD"

# install.ps1 creates this; install.sh did not, so a fresh POSIX machine failed
# with ENOENT on the write below and `set -e` aborted before the starter-pack
# prompt. The Windows half has carried the mkdir since it was fixed there.
mkdir -p "$(dirname "$SETTINGS")"

# ── 1. Register PostToolUse hook ──────────────────────────────────────────────
HOOK_CMD="$HOOK_CMD" SETTINGS="$SETTINGS" node --input-type=module <<'EOF'
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { isAbsolute } from 'path';

const settingsPath = process.env.SETTINGS;
const hookCmd      = process.env.HOOK_CMD;

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
const onWindows = process.platform === 'win32';

// The path a hook command runs, if and only if it runs THIS tool: `node <path>`
// or a bare `<path>`, the path optionally quoted whole, ending in a `bin`
// directory holding a file named exactly `wildcard-perms`. Strict, because a
// false match REWRITES somebody else's hook: extra arguments, a wrapper, an
// unquoted path containing a space, `wildcard-perms.js`, `wildcard-perms-audit`
// or a command that merely mentions the name all return null. Case and `\` are
// folded only on Windows; on POSIX a backslash is a filename character and
// `BIN/` is a different directory.
const toolTarget = (command) => {
  if (typeof command !== 'string') return null;
  // The old exact match stays THIS checkout, whatever the grammar makes of it.
  if (command === hookCmd) return hookCmd;
  let text = command.trim();
  const wrapped = (onWindows ? /^node\s+(.+)$/i : /^node\s+(.+)$/).exec(text);
  if (wrapped) text = wrapped[1].trim();
  const quoted = /^"([^"]+)"$/.exec(text) || /^'([^']+)'$/.exec(text);
  if (quoted) text = quoted[1];
  else if (/\s/.test(text)) return null;
  const tail = onWindows ? /[\\/]bin[\\/]wildcard-perms$/i : /\/bin\/wildcard-perms$/;
  return tail.test(text) ? text : null;
};

// On Windows one path has several spellings: `\` or `/`, /d/repo (Git Bash,
// which is what this script writes there) or D:/repo (install.ps1), any casing.
const nativePath = (p) => {
  if (!onWindows) return p;
  const text = p.replace(/\\/g, '/');
  const drive = /^\/([A-Za-z])\//.exec(text);
  return drive ? `${drive[1]}:/${text.slice(3)}` : text;
};
const comparable = (p) => {
  const text = nativePath(p).replace(/\/+$/, '');
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
    f.hook.command = hookCmd;
    const old = nativePath(f.target);
    const gone = isAbsolute(old) && !existsSync(old) ? ' (the old path no longer exists)' : '';
    notices.push(`✓ wildcard-perms hook repointed from another checkout: ${f.target} -> ${hookCmd}${gone}`);
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
      hooks: [{ type: 'command', command: hookCmd }],
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
echo "Merges $(node -e "console.log(require('$SCRIPT_DIR/patterns/starter-pack.json').length)") curated permissions into your allow list."
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
