#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_CMD="$SCRIPT_DIR/bin/wildcard-perms"
SETTINGS="$HOME/.claude/settings.json"

HOOK_CMD="$HOOK_CMD" SETTINGS="$SETTINGS" node --input-type=module <<'EOF'
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { isAbsolute } from 'path';

const settingsPath = process.env.SETTINGS;
const hookCmd      = process.env.HOOK_CMD;

let cfg;
try { cfg = JSON.parse(readFileSync(settingsPath, 'utf8')); }
catch (error) {
  // Nothing to undo is not a failure, but it is not a success either: say which
  // of the two happened rather than exiting 0 in silence.
  if (error.code === 'ENOENT') {
    console.log(`- no ${settingsPath}, so there is no hook to remove`);
    process.exit(0);
  }
  console.error(`✗ ${settingsPath} could not be read or parsed (${error.message}) — left untouched`);
  process.exit(1);
}

// The two installers register two different command strings for the same hook, and
// an uninstall that knows only one of them can never undo the other. install.sh
// registers the bare path, because the shebang makes the script directly
// executable; install.ps1 registers `node "<forward-slash path>"`, because Windows
// has no shebang support and a bare extensionless path pops a "How do you want to
// open this file?" dialog on every hook fire. So match on the PATH, not on the
// spelling of the command that wraps it.
const hookPath = (value) => {
  let text = String(value ?? '').trim();
  const wrapped = /^node\s+(.+)$/i.exec(text);
  if (wrapped) text = wrapped[1].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  text = text.replace(/\\/g, '/');
  // Git Bash spells D:\repo as /d/repo where PowerShell writes D:/repo — one path,
  // two spellings — and a Windows path is case-insensitive besides.
  const drive = /^\/([A-Za-z])\//.exec(text);
  if (drive) text = `${drive[1]}:/${text.slice(3)}`;
  return text.replace(/\/+$/, '').toLowerCase();
};

const target = hookPath(hookCmd);
const isThisCheckout = (hook) => hookPath(hook?.command) === target;

// A registration of this tool from ANOTHER checkout. Found live 2026-10-13: the
// development box's hook pointed at an old checkout of this repo while the
// maintained one had been cloned under a new name, and an uninstall run from the
// new checkout matched nothing, said "nothing removed", and left the old hook
// firing. The installers now repoint such a registration; the uninstaller is
// more conservative, because removing a hook is not something the user asked
// for on behalf of a checkout they did not run it from:
//   - this checkout's                       removed (unchanged behaviour);
//   - another checkout's, target file gone  removed too: it can only fail on
//                                           every tool call. False positives: an
//                                           unreachable drive, and on Windows a
//                                           Git Bash mount such as /tmp that
//                                           node cannot resolve (/c/... is
//                                           converted first).
//                                           Both cost only a hook of this tool,
//                                           during an uninstall of this tool;
//   - another checkout's, still on disk     LEFT, and named in the output, so
//                                           "nothing removed" is not the whole
//                                           story. That checkout's own
//                                           uninstaller removes it.
// The grammar is install.sh's toolTarget, strict for the same reason: only a
// command that runs a `bin/wildcard-perms` file and nothing else is ours, so
// `wildcard-perms-audit` or a command that merely mentions the name never is.
// A relative path cannot be checked for existence, so it counts as still there.
const onWindows = process.platform === 'win32';
const toolTarget = (command) => {
  if (typeof command !== 'string') return null;
  let text = command.trim();
  const wrapped = (onWindows ? /^node\s+(.+)$/i : /^node\s+(.+)$/).exec(text);
  if (wrapped) text = wrapped[1].trim();
  const quoted = /^"([^"]+)"$/.exec(text) || /^'([^']+)'$/.exec(text);
  if (quoted) text = quoted[1];
  else if (/\s/.test(text)) return null;
  const tail = onWindows ? /[\\/]bin[\\/]wildcard-perms$/i : /\/bin\/wildcard-perms$/;
  return tail.test(text) ? text : null;
};
const nativePath = (p) => {
  if (!onWindows) return p;
  const text = p.replace(/\\/g, '/');
  const drive = /^\/([A-Za-z])\//.exec(text);
  return drive ? `${drive[1]}:/${text.slice(3)}` : text;
};
const isGone = (hook) => {
  const found = toolTarget(hook?.command);
  if (found === null) return false;
  const p = nativePath(found);
  return isAbsolute(p) && !existsSync(p);
};
const isOurs = (hook) => isThisCheckout(hook) || isGone(hook);

const installed = Array.isArray(cfg.hooks?.PostToolUse) ? cfg.hooks.PostToolUse : [];

// Other checkouts' registrations, for the output: the gone ones are removed with
// ours, the live ones are left and named. See above.
const goneCheckouts = [];
const otherCheckouts = [];
for (const entry of installed) {
  if (!Array.isArray(entry?.hooks)) continue;
  for (const hook of entry.hooks) {
    if (isThisCheckout(hook)) continue;
    const found = toolTarget(hook?.command);
    if (found !== null) (isGone(hook) ? goneCheckouts : otherCheckouts).push(found);
  }
}
const reportOthers = () => {
  for (const other of otherCheckouts) {
    console.log(`- left ${other} registered: it is another checkout of this tool and it still exists.`);
    console.log("  Run that checkout's uninstaller to remove it.");
  }
};

// Removed PER HOOK, not per entry. Dropping the whole entry took any hook that
// happened to share its `hooks` array with ours — somebody else's tool, deleted
// silently by our uninstaller. The rule was copied from a per-hook filter in
// src/permissions.js; that function went with MAX and these two scripts are now
// the only place it lives, so this comment is the whole record of why the loop
// below rebuilds `hooks` instead of dropping the entry.
let removed = 0;
const kept = [];
for (const entry of installed) {
  if (!Array.isArray(entry?.hooks)) { kept.push(entry); continue; }
  const mine = entry.hooks.filter(isOurs).length;
  if (!mine) { kept.push(entry); continue; }
  removed += mine;
  const survivors = entry.hooks.filter((hook) => !isOurs(hook));
  // An entry that held only ours goes; one that held a neighbour keeps it,
  // with its matcher and any other fields intact.
  if (survivors.length) kept.push({ ...entry, hooks: survivors });
}

// The write and the "hook removed" message both used to sit OUTSIDE this check, so
// an uninstall that matched nothing still rewrote settings.json and still reported
// success — which is exactly what every PowerShell install got.
if (!removed) {
  console.log(`- no wildcard-perms hook registered in ${settingsPath}; nothing removed`);
  reportOthers();
  process.exit(0);
}

if (kept.length) cfg.hooks.PostToolUse = kept;
else delete cfg.hooks.PostToolUse;
if (cfg.hooks && !Object.keys(cfg.hooks).length) delete cfg.hooks;

writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + '\n');
console.log(`✓ removed ${removed} wildcard-perms PostToolUse hook${removed === 1 ? '' : 's'} from ${settingsPath}`);
for (const gone of goneCheckouts) console.log(`  including ${gone}, from a checkout that no longer exists`);
reportOthers();
console.log('  Allow-list entries stay as they are — this removes the hook, not your permissions.');
EOF
