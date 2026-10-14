#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_CMD="$SCRIPT_DIR/bin/wildcard-perms"
SETTINGS="$HOME/.claude/settings.json"

# Windows under Git Bash, MSYS2 or Cygwin: hand node the C:/ long form, the path
# install.sh and install.ps1 both register there (install.sh's uname block has
# the reasons). Git Bash's own conversion of HOOK_CMD keeps any 8.3 component,
# /tmp included, and Cygwin does not convert it at all.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    if command -v cygpath >/dev/null 2>&1; then
      HOOK_CMD="$(cygpath -m -l "$SCRIPT_DIR")/bin/wildcard-perms" || HOOK_CMD="$SCRIPT_DIR/bin/wildcard-perms"
    fi
    ;;
esac

HOOK_CMD="$HOOK_CMD" SETTINGS="$SETTINGS" node --input-type=module <<'EOF'
import { readFileSync, writeFileSync, existsSync, realpathSync, statSync } from 'fs';
import { isAbsolute } from 'path';

const settingsPath = process.env.SETTINGS;
const hookCmd      = process.env.HOOK_CMD;
// The node this runs under Git Bash, MSYS2 or Cygwin is the native Windows
// build, so this is true there too, and only there.
const onWindows    = process.platform === 'win32';

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

// The installers register two different command strings for the same hook, and an
// uninstall that knows only one of them can never undo the other. On Linux and macOS
// install.sh registers the bare path, because the shebang makes the script directly
// executable; install.ps1, and install.sh under Git Bash, register `node "<C:/path>"`,
// because Windows has no shebang support and a bare extensionless path pops a "How do
// you want to open this file?" dialog on every hook fire (older Git Bash installs left
// exactly that bare path). So match on the PATH, not on the spelling that wraps it.
//
// The quotes come off a BARE path too, since 2026-10-14: install.sh now registers a
// path with whitespace in it quoted, `'/Users/Jo Doe/acolyte/bin/wildcard-perms'`,
// because a shell splits it otherwise, and only a `node`-wrapped path was unquoted
// here, so this checkout's own quoted registration would have read as somebody else's.
//
// The PATH is folded ONLY ON WINDOWS, since 2026-10-14 (the v1.6.2 audit; true of
// every version before it). This lowercased, turned `\` into `/` and rewrote /c/x
// as c:/x on every platform, while install.sh's `comparable` folds only on Windows.
// On Linux, and on a case-sensitive macOS volume, /src/Acolyte and /src/acolyte are
// two checkouts, and an uninstall run from one removed the other's LIVE hook as its
// own; `\` is a filename character there, and /c/x is a real path. The installer
// would have called the same registration another checkout and repointed it.
const hookPath = (value) => {
  let text = String(value ?? '').trim();
  const wrapped = /^node\s+(.+)$/i.exec(text);
  if (wrapped) text = wrapped[1].trim();
  text = text.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  if (!onWindows) return canonical(text).replace(/\/+$/, '');
  text = text.replace(/\\/g, '/');
  // Git Bash spells D:\repo as /d/repo and Cygwin as /cygdrive/d/repo where
  // PowerShell writes D:/repo — one path, three spellings — and a Windows path is
  // case-insensitive besides.
  const drive = /^(?:\/cygdrive)?\/([A-Za-z])\//i.exec(text);
  if (drive) text = `${drive[1]}:/${text.slice(drive[0].length)}`;
  return canonical(text).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
};

// One file can have more than one spelling even after that folding, found
// 2026-10-13: an 8.3 short path (C:/Users/SHORTN~1.EXT/...) and its long form
// name the same checkout, and so do a symlinked or junctioned directory and its
// target. Compared as text they differ, so this checkout's own registration
// under the other spelling was left in place and named "another checkout".
// realpath gives a file that exists its one canonical spelling, on Windows the
// long form; a relative path, or one that does not exist, is compared as written.
// install.sh's `canonical` is the same function.
function canonical(p) {
  if (!isAbsolute(p)) return p;
  try { return realpathSync.native(p); } catch { return p; }
}

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
// An UNQUOTED path with whitespace in it is ours only if a file by exactly that
// name exists (install.sh's toolTarget comment has why; this checkout's own is
// decided by isThisCheckout before this is asked). So one of those is never
// "gone": an absent file proves nothing about a command a shell would split, and
// it may be `/usr/bin/env node /x/bin/wildcard-perms`, which is not ours to remove.
// /cygdrive/d/... folds like /d/... (install.sh's nativePath has the cost of not).
const toolTarget = (command) => {
  if (typeof command !== 'string') return null;
  let text = command.trim();
  const wrapped = (onWindows ? /^node\s+(.+)$/i : /^node\s+(.+)$/).exec(text);
  if (wrapped) text = wrapped[1].trim();
  const quoted = /^"([^"]+)"$/.exec(text) || /^'([^']+)'$/.exec(text);
  if (quoted) text = quoted[1];
  const tail = onWindows ? /[\\/]bin[\\/]wildcard-perms$/i : /\/bin\/wildcard-perms$/;
  if (!tail.test(text)) return null;
  if (!quoted && /\s/.test(text) && !isExistingFile(nativePath(text))) return null;
  return text;
};
const isExistingFile = (p) => {
  if (!isAbsolute(p)) return false;
  try { return statSync(p).isFile(); } catch { return false; }
};
const nativePath = (p) => {
  if (!onWindows) return p;
  const text = p.replace(/\\/g, '/');
  const drive = /^(?:\/cygdrive)?\/([A-Za-z])\//i.exec(text);
  return drive ? `${drive[1]}:/${text.slice(drive[0].length)}` : text;
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
