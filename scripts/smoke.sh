#!/usr/bin/env bash
# Smoke gate: does the real thing work on this box?
#
# Exercises the CLI surface (state load, policy read, guidance/gates read) and the
# hook entry point the way Claude Code invokes it. Regression (`npm test`) is a
# separate gate; this one is about the live machine, so it reads the REAL
# ~/.claude/settings.json rather than a fixture.
#
# Paths are resolved, not hardcoded. This script previously lived in a session
# scratchpad with an absolute repo path, an absolute settings path and an absolute
# mirror path baked in — which made it unrunnable by anyone else and meant the gate
# every phase of the work depended on was itself untracked.
#
# Overridable for a non-default layout, same contract as scripts/verify-release.ps1:
# an unset value is discovered, never required.
#   PW_SETTINGS   path to settings.json      (default: $HOME/.claude/settings.json)
#   PW_MIRROR     off-tree backup mirror     (default: $HOME/.permission-wildcarding/allow-list.latest.json)
#   PW_FPCACHE    hook fixed-point cache key (default: $HOME/.claude/wildcarding/fixed-point.json)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO/bin/wildcard-perms"
SETTINGS="${PW_SETTINGS:-$HOME/.claude/settings.json}"
MIRROR="${PW_MIRROR:-$HOME/.permission-wildcarding/allow-list.latest.json}"
FPCACHE="${PW_FPCACHE:-$HOME/.claude/wildcarding/fixed-point.json}"

fail=0
pass=0

# Captured BEFORE the first CLI invocation, because the very first hook call is what
# damages it. The fixed-point key is stamped with a hash of the CLI's own code files,
# so running this script from a git worktree mints a key for the WORKTREE's src/ and
# writes it into the real ~/.claude/wildcarding/fixed-point.json. The installed hook
# then misses on every tool call until something rewrites it. Observed twice on
# 2026-09-24 during a worktree-based change.
#
# An earlier version read this just before the cold-cache section, which is AFTER the
# warm hook run — so it faithfully restored an already-replaced key and its own
# restore assertion passed while the live cache stayed wrong.
FP_ORIGINAL=""
[ -f "$FPCACHE" ] && FP_ORIGINAL="$(cat "$FPCACHE")"

check() { # name, expected-ERE, output
  if printf '%s' "$3" | grep -Eq "$2"; then
    pass=$((pass+1)); echo "  PASS  $1"
  else
    fail=$((fail+1)); echo "  FAIL  $1"; echo "        expected /$2/ in: $(printf '%s' "$3" | head -c 200)"
  fi
}

ok() { # name, detail — an unconditional pass, for checks that assert by construction
  pass=$((pass+1)); echo "  PASS  $1"; [ -n "${2:-}" ] && echo "        $2"
}

no() { # name, detail
  fail=$((fail+1)); echo "  FAIL  $1"; [ -n "${2:-}" ] && echo "        $2"
}

if [ ! -f "$CLI" ]; then
  echo "  FAIL  cli present"; echo "        no $CLI — wrong repo?"; echo ""; echo "smoke: 0 pass, 1 fail"; exit 1
fi

echo "== CLI status verbs"
# Each pattern asserts a real invariant of the output. Two of these used to be
# the pattern `.` — which matches any non-empty output, so `--bypass` and `--learn`
# were passing on literally anything the process printed, including an
# error message. Same vacuous-check family as the hook-quiet one below.
check "--gates status"    'gates \[claude\]'                          "$(node "$CLI" --gates status 2>&1)"
check "--guidance status" 'guidance \[claude\]'                       "$(node "$CLI" --guidance status 2>&1)"
check "--bypass status"   'bypass: (ON|OFF)'                          "$(node "$CLI" --bypass status 2>&1)"
# --learn status emits the state file as JSON, not prose. Pin the one field whose
# value set is closed, so a malformed or empty state cannot pass.
check "--learn status"    '"mode": *"(observe|recommend|auto-safe)"'  "$(node "$CLI" --learn status 2>&1)"

echo "== hook entry point (PostToolUse payload on stdin)"
# The real invocation shape: Claude Code pipes a JSON event on stdin. A hook that
# throws here is paid on EVERY tool call, so this is the highest-value check.
#
# stdout and stderr are captured SEPARATELY from the exit code. The previous
# version merged them and then ran the blob through
# `tr -d '[:space:]' | grep -o 'rc=0' | head -1 | sed …`, which manufactures the
# string "rc=0" whenever the exit code was 0 no matter what else was printed.
# Verified with fabricated input: it passed on "rc=0", on
# "wildcard-perms: read error: boom\nrc=0", and on arbitrary multi-line noise.
# It could not fail. So the hook's "quiet by design" contract — the single
# property paid on every tool call — reported green while testing nothing.
HOOK_EVENT='{"tool_name":"Bash","tool_input":{"command":"git status"},"tool_response":{"stdout":"ok"}}'
HOOK_ERR_FILE="$(mktemp)"
HOOK_STDOUT="$(printf '%s' "$HOOK_EVENT" | node "$CLI" 2>"$HOOK_ERR_FILE")"
HOOK_RC=$?
HOOK_STDERR="$(cat "$HOOK_ERR_FILE")"
rm -f "$HOOK_ERR_FILE"

if [ "$HOOK_RC" -eq 0 ]; then ok "hook exits 0"; else no "hook exits 0" "exit was $HOOK_RC"; fi

# Emptiness asserted directly on the captured bytes, so noise cannot pass.
HOOK_NOISE="${HOOK_STDOUT}${HOOK_STDERR}"
if [ -z "$HOOK_NOISE" ]; then
  ok "hook is quiet"
else
  no "hook is quiet" "printed $(printf '%s' "$HOOK_NOISE" | wc -c) bytes: $(printf '%s' "$HOOK_NOISE" | head -c 160)"
fi

# The check above now exercises the CACHE HIT path, which returns before parsing
# settings.json, before requiring the generalizer, and before the writer or the
# lock — about twenty lines. That is worth gating, but on its own it means the
# gate's headline check gets shallower the moment the cache warms, and its depth
# depends on hidden state: delete the key file and the same script suddenly tests
# the full path instead. So run it BOTH ways, deterministically.
#
# The cache is pure: deleting the key costs one slow hook call and nothing else,
# which is why it is safe for a gate to remove it.
echo "== hook entry point again, with the fixed-point cache forced to miss"
# FP_ORIGINAL was captured at the top, before the FIRST hook call. Capturing it here
# would be too late: that first call has already replaced the key if this checkout is
# not the one the installed hook runs.
if [ -f "$FPCACHE" ]; then
  rm -f "$FPCACHE"
fi

MISS_ERR_FILE="$(mktemp)"
MISS_STDOUT="$(printf '%s' "$HOOK_EVENT" | node "$CLI" 2>"$MISS_ERR_FILE")"
MISS_RC=$?
MISS_STDERR="$(cat "$MISS_ERR_FILE")"
rm -f "$MISS_ERR_FILE"

if [ "$MISS_RC" -eq 0 ]; then ok "hook exits 0 on a cold cache"; else no "hook exits 0 on a cold cache" "exit was $MISS_RC"; fi

# The live list is a fixed point, so even a full pass writes nothing and says
# nothing. A miss that had to WRITE would legitimately print one diagnostic —
# which is why this asserts silence only for the no-op case the live file gives.
MISS_NOISE="${MISS_STDOUT}${MISS_STDERR}"
if [ -z "$MISS_NOISE" ]; then
  ok "hook is quiet on a cold cache"
else
  no "hook is quiet on a cold cache" "printed $(printf '%s' "$MISS_NOISE" | wc -c) bytes: $(printf '%s' "$MISS_NOISE" | head -c 160)"
fi

# And the miss must have re-earned the key, or the cache is write-broken and
# every future call pays the full pass with nothing to show for it.
if [ -s "$FPCACHE" ]; then
  ok "the cold run re-earned its cache key" "$(cat "$FPCACHE")"
else
  no "the cold run re-earned its cache key" "no key at $FPCACHE"
fi

echo "== settings.json is still parseable and populated"
ALLOW=$(PW_SETTINGS="$SETTINGS" node -e '
  const fs = require("fs");
  const s = JSON.parse(fs.readFileSync(process.env.PW_SETTINGS, "utf8"));
  console.log(((s.permissions || {}).allow || []).length);
' 2>&1)
check "allow list non-trivial" '^[0-9]{2,}$' "$ALLOW"
echo "        allow entries: $ALLOW"

echo "== off-tree backup mirror present"
# INFO rather than PASS/FAIL when absent, because the mirror is written by the
# extension on its first pass after a reload and a fresh install legitimately has
# none. But when it IS there, assert something about it: `ok` with no condition
# was an unconditional pass, i.e. the same could-not-fail shape this script was
# committed to remove. A mirror that exists but is empty or unparseable is worse
# than one that is missing, because it reads as protection that is not there.
if [ ! -f "$MIRROR" ]; then
  echo "  INFO  mirror not written yet (needs the extension to run a pass post-reload)"
elif [ ! -s "$MIRROR" ]; then
  no "mirror is non-empty" "0 bytes at $MIRROR"
else
  MIRROR_N=$(node -e '
    const fs = require("fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      console.log(Array.isArray(j.allow) ? j.allow.length : -1);
    } catch { console.log(-1); }
  ' "$MIRROR" 2>/dev/null)
  if [ "${MIRROR_N:--1}" -gt 0 ]; then
    ok "mirror holds a populated allow list" "$MIRROR_N entries, $(wc -c < "$MIRROR") bytes"
  else
    no "mirror holds a populated allow list" "unparseable or empty allow at $MIRROR"
  fi
fi

echo "== retired MAX surfaces stay retired"
# The enable paths were deleted in the post-1.5.1 work. These verbs survive only as
# one-way cleanup. A status verb that still reports, plus an `on` that still refuses,
# is the pair worth gating: the packaging gate proves the code is absent from the
# VSIX, and this proves the CLI a user actually types behaves the same way.
check "--max status is cleanup-only"       'legacy Claude MAX configuration:' "$(node "$CLI" --max status 2>&1)"
check "--codex-max status is cleanup-only" 'legacy Codex MAX configuration:'  "$(node "$CLI" --codex-max status 2>&1)"
MAX_ON="$(node "$CLI" --max on 2>&1)"
if [ $? -ne 0 ]; then
  ok "--max on is refused" "$(printf '%s' "$MAX_ON" | head -c 80)"
else
  no "--max on is refused" "exited 0 — a retired enable path answered"
fi

echo "== the CLI reads the Auto Learn state the extension writes"
# The manager keys its state file on a hash of workspaceRoot, and bin/wildcard-perms
# defaults that to process.cwd(). So `--learn status` run anywhere but the exact
# VS Code workspace root reads a DIFFERENT, usually absent, state file and prints
# zeros — which reads as "Auto Learn is doing nothing" rather than "you are looking
# at the wrong file". The `--learn status` check above passes on that empty state,
# because `mode` defaults to "recommend" whether or not anything was ever scanned.
STATE_DIR="$(dirname "$FPCACHE")"
CLI_STATE=$(node "$CLI" --learn status 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", (d) => { s += d; })
    .on("end", () => { try { process.stdout.write(JSON.parse(s).paths.state); } catch {} });
')
# Skipping an unparseable state file is right — a half-written one is not the newest —
# but swallowing the fact is not. If every candidate fails to parse, "no scanned state"
# and "every state on this box is corrupt" are the same output, and only one of them is
# benign. The count is emitted alongside so the caller can tell them apart.
NEWEST_SCAN=$(node -e '
  const fs = require("fs"), path = require("path");
  const dir = process.argv[1];
  let best = null; let unreadable = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { process.stdout.write("0\n"); process.exit(0); }
  for (const name of names) {
    if (!/^auto-learn-state.*\.json$/.test(name)) continue;
    try {
      const at = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")).lastScanAt;
      if (at && (!best || at > best.at)) best = { at, file: path.join(dir, name) };
    } catch { unreadable += 1; }
  }
  process.stdout.write(`${unreadable}\n${best ? best.file : ""}`);
' "$STATE_DIR" 2>/dev/null)
UNREADABLE_STATES=$(printf '%s' "$NEWEST_SCAN" | head -1)
NEWEST_STATE=$(printf '%s' "$NEWEST_SCAN" | tail -n +2)

if [ -z "$NEWEST_STATE" ] && [ "${UNREADABLE_STATES:-0}" != "0" ]; then
  no "the Auto Learn state files parse" \
     "$UNREADABLE_STATES state file(s) in $STATE_DIR are unparseable and none is readable"
elif [ -z "$NEWEST_STATE" ]; then
  echo "  INFO  no scanned Auto Learn state on this box yet, so there is nothing to diverge from"
elif [ -f "$REPO/.git" ]; then
  # A git worktree has `.git` as a FILE pointing at the real gitdir, not a directory.
  # The workspace default walks UP from cwd to the nearest ancestor owning a state
  # file, so from a worktree parked outside the tree the installed extension's state
  # is legitimately unreachable and a mismatch says nothing about the product. This
  # is INFO rather than a pass: it reports that the check did not run, instead of
  # claiming a green it did not earn. Every agent working in a worktree hits this.
  echo "  INFO  running from a git worktree, so the state-file agreement check is not meaningful here"
  echo "        CLI reads $(basename "${CLI_STATE:-<none>}"), newest scanned is $(basename "$NEWEST_STATE")"
elif [ "$CLI_STATE" = "$NEWEST_STATE" ]; then
  ok "the CLI and the extension agree on the state file" "$(basename "$CLI_STATE")"
else
  no "the CLI and the extension agree on the state file" \
     "CLI reads $(basename "${CLI_STATE:-<none>}"), newest scanned is $(basename "$NEWEST_STATE")"
fi

# And that state must not be carrying scan errors. This is the check that would have
# caught the 2.27 GB rollout defect, which sat unreadable for eight days while every
# other gate stayed green.
#
# ⚠ THIS CHECK COULD NOT FAIL, and an audit caught it three lines below two INFO arms
# that decline to claim exactly this. When $NEWEST_STATE was empty — no scanned state,
# which the block above has JUST detected and deliberately reported as INFO rather than
# "claiming a green it did not earn" — readFileSync(undefined) threw, the catch wrote
# "0", and this printed PASS over evidence that does not exist. The same catch also
# swallowed a corrupt or unreadable state file and reported zero errors.
#
# It reports three outcomes now: a real count, "no state to read" as INFO, and an
# unreadable state as a FAILURE, because a state file that will not parse is a worse
# result than one carrying errors, not a better one.
SCAN_ERRORS=$(node -e '
  const fs = require("fs");
  const file = process.argv[1];
  if (!file) { process.stdout.write("absent"); process.exit(0); }
  try {
    const stats = JSON.parse(fs.readFileSync(file, "utf8")).lastScanStats;
    process.stdout.write(String(stats && stats.errors ? stats.errors : 0));
  } catch (error) { process.stdout.write("unreadable:" + error.code); }
' "$NEWEST_STATE" 2>/dev/null)
case "${SCAN_ERRORS:-unreadable:empty}" in
  absent)
    echo "  INFO  no scanned state to check for scan errors" ;;
  0)
    ok "the last Auto Learn scan recorded no errors" ;;
  unreadable:*)
    no "the Auto Learn state is readable" "$NEWEST_STATE -> ${SCAN_ERRORS#unreadable:}" ;;
  *)
    no "the last Auto Learn scan recorded no errors" "$SCAN_ERRORS file(s) failed to read" ;;
esac

# The LIVE Codex history store, compared the way every scan compares it. The state
# file above only says what the last scan saw; this asks the store now, against the
# real ~/.codex (or CODEX_HOME), so a divergence the panel shows as "scan degraded"
# fails the gate here too, with its reasons, instead of passing every other check.
#
# The case that motivated it, reproduced 2026-10-13: four archived Codex threads
# read as orphans because only sessions/ was walked, and the dashboard said "Codex
# history store has moved" on every scan, over a store that had moved nothing.
#
# The module paths go in as ARGUMENTS, not inside the script text: under Git Bash
# $REPO is a POSIX path that Windows node cannot resolve, and MSYS rewrites argv
# but not the body of -e. resolveCodexHome() asks node for the home, so HOME's
# POSIX spelling never matters either.
CODEX_HISTORY=$(node -e '
  const fs = require("fs");
  const adapters = require(process.argv[1]);
  const { resolveCodexHome } = require(process.argv[2]);
  const codexHome = resolveCodexHome();
  if (!fs.existsSync(codexHome)) { process.stdout.write("absent"); process.exit(0); }
  try {
    const state = adapters.codexHistoryStoreState({ codexHome });
    const summary = state.inspected + "; " + state.rolloutFiles + " rollout file(s), "
      + state.archivedFiles + " archived, " + state.storeThreads + " known thread(s)";
    if (state.stale) process.stdout.write("stale:" + summary + " | " + state.reasons.join(" | "));
    else if (state.inspected === "partial") process.stdout.write("partial:" + summary + " | " + state.notes.join(" | "));
    else process.stdout.write("ok:" + summary);
  } catch (error) { process.stdout.write("error:" + ((error && error.message) || error)); }
' "$REPO/src/history-adapters.js" "$REPO/src/codex-paths.js" 2>/dev/null)
case "${CODEX_HISTORY:-error:no output}" in
  absent)
    echo "  INFO  no Codex home on this box, so there is no Codex history store to compare" ;;
  ok:*)
    ok "the live Codex history store agrees with the rollout folders" "${CODEX_HISTORY#ok:}" ;;
  stale:*)
    no "the live Codex history store agrees with the rollout folders" "${CODEX_HISTORY#stale:}" ;;
  partial:*)
    no "the live Codex history-store comparison ran without degrading" "${CODEX_HISTORY#partial:}" ;;
  *)
    no "the live Codex history-store comparison ran" "${CODEX_HISTORY#error:}" ;;
esac

# Leave the machine as we found it — UNCONDITIONALLY.
#
# This used to restore only when the cold run had failed to write a key, on the
# reasoning that a successful run re-earns its own. That reasoning is wrong the
# moment this script is run from anywhere but the checkout the live hook points at.
# The key is stamped with a hash of the CLI's own code files, so a run from a git
# worktree mints a key for the WORKTREE's src/ and leaves it in the real
# ~/.claude/wildcarding/fixed-point.json. The installed hook then misses on every
# tool call until something rewrites it. Observed twice on 2026-09-24, a
# worktree-stamped key replacing the installed checkout's.
#
# Restoring the saved bytes always costs nothing when they are already correct and
# fixes the case where they are not. The cold-run assertions above have already read
# what they needed by this point.
#
# WHAT IS CHECKED AFTER THE RESTORE, AND WHY IT IS NOT A READ-BACK. Until 2026-10-13
# this printf'd $FP_ORIGINAL into the file, read it straight back with $(cat), and
# passed when the two matched. That could fail only on a write or read error, so it
# proved almost nothing; what it argued for is delivered by the restore being
# unconditional. The property worth a PASS is that the restored key is one the hook
# ACCEPTS. So the hook runs once more on the same payload and the file must not move:
# a hit returns before any write (bin/wildcard-perms `run`, the `isFixedPoint`
# branch), and a miss rewrites the file with the key this checkout mints.
#
# "Did not move" is judged on the file's mtime as well as its text, because equal text
# is not proof of a hit: a hook whose read side broke would miss on its own key and
# rewrite the same bytes. And settings.json is hashed around the call, because a miss
# on bytes that are not a fixed point writes settings.json and leaves the cache alone,
# which would also look unmoved.
#
# A miss is INFO, not FAIL, when the key this run found came from other code (the
# installed checkout while this runs from a worktree, or this checkout before an edit
# to src/permissions.js or src/permission-match.js, whose mtime:size is the stamp) or
# was minted for other settings.json bytes. The found key is then put back again:
# this block's contract is the state the run found, and a worktree-stamped key left
# in the live file is the damage it exists to undo.
#
# This extra call cannot write settings.json, or anything the earlier hook runs could
# not. The cold run above processed the same bytes with the cache forced to miss, so
# they are a fixed point, or were made one. A second miss therefore finds nothing
# pending and writes only the cache key: `run` records a key "ONLY for a verified fixed
# point" and calls the locked writer only when the pass changed the list. HOOK_EVENT
# carries no cwd, so `hookCwd` returns null and the project-local drain never runs.
#
# The check is vacuous if PW_FPCACHE names a file the hook does not read, because then
# nothing the hook does can move it. The CLI resolves its cache and its settings from
# os.homedir() and ignores PW_FPCACHE and PW_SETTINGS, so the probe asks the cache
# module for the hook's own path and compares, and hashes the settings file the hook
# itself reads. Output: `same|<cache mtimeMs>|<settings sha256 prefix>`, or the
# hook's cache path in place of `same`.
FP_SUBJECT="the restored fixed-point key is a hit for this checkout's hook"
FP_KEY_SHAPE='^[0-9]+:[0-9a-f]{8}:[0-9]+:[0-9a-f]{8}$'
FP_PROBE='
  const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
  const hookFile = require(process.argv[1]).cachePath();
  const key = (p) => { const r = path.resolve(p); return process.platform === "win32" ? r.toLowerCase() : r; };
  let mtime = "absent";
  try { mtime = String(fs.statSync(hookFile).mtimeMs); } catch {}
  let settings = "absent";
  try {
    settings = crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"))).digest("hex").slice(0, 16);
  } catch {}
  process.stdout.write([key(hookFile) === key(process.argv[2]) ? "same" : hookFile, mtime, settings].join("|"));
'
if [ -n "$FP_ORIGINAL" ]; then
  mkdir -p "$(dirname "$FPCACHE")"
  printf '%s\n' "$FP_ORIGINAL" > "$FPCACHE"
  IFS='|' read -r FP_HOOK_FILE FP_MTIME_WAS FP_SETTINGS_WAS \
    <<< "$(node -e "$FP_PROBE" "$REPO/src/fixed-point-cache.js" "$FPCACHE" 2>/dev/null)"
  if [ "$FP_HOOK_FILE" != "same" ]; then
    echo "  INFO  the hook reads ${FP_HOOK_FILE:-an unknown cache file}, not $FPCACHE, so whether the restored key is a hit cannot be observed here"
  else
    printf '%s' "$HOOK_EVENT" | node "$CLI" >/dev/null 2>&1
    RECHECK_RC=$?
    FP_AFTER="$(cat "$FPCACHE" 2>/dev/null)"
    IFS='|' read -r _ FP_MTIME_NOW FP_SETTINGS_NOW \
      <<< "$(node -e "$FP_PROBE" "$REPO/src/fixed-point-cache.js" "$FPCACHE" 2>/dev/null)"
    if [ "$RECHECK_RC" -ne 0 ]; then
      no "$FP_SUBJECT" "the hook exited $RECHECK_RC on the re-run"
      printf '%s\n' "$FP_ORIGINAL" > "$FPCACHE"
    elif [ "$FP_SETTINGS_NOW" != "$FP_SETTINGS_WAS" ]; then
      # Not judged either way. Something wrote settings.json after the cold run (a
      # permission approved in a live session is the usual writer), or the pass is not
      # idempotent at a fixed point; a second smoke run tells the two apart.
      printf '%s\n' "$FP_ORIGINAL" > "$FPCACHE"
      echo "  INFO  settings.json changed during the re-run, so it was not a fixed point and the restored key could not be judged"
      echo "        either something wrote it after the cold run, or the pass is not idempotent; run smoke again to tell them apart"
    elif [ "$FP_AFTER" = "$FP_ORIGINAL" ] && [ "$FP_MTIME_NOW" = "$FP_MTIME_WAS" ]; then
      ok "$FP_SUBJECT" "$FP_ORIGINAL"
    elif [ "$FP_AFTER" = "$FP_ORIGINAL" ]; then
      no "$FP_SUBJECT" "the hook rewrote the key it was given, so it missed on a key it mints itself"
    elif printf '%s' "$FP_AFTER" | grep -Eq "$FP_KEY_SHAPE"; then
      IFS=: read -r _ FP_STAMP_WAS _ _ <<< "$FP_ORIGINAL"
      IFS=: read -r _ FP_STAMP_NOW _ _ <<< "$FP_AFTER"
      if [ "$FP_STAMP_WAS" != "$FP_STAMP_NOW" ]; then
        FP_WHY="it was minted by other code (stamp $FP_STAMP_WAS; this checkout mints $FP_STAMP_NOW)"
      else
        FP_WHY="it was minted for different settings.json bytes than the ones on disk now"
      fi
      printf '%s\n' "$FP_ORIGINAL" > "$FPCACHE"
      echo "  INFO  the key this run found is not a hit for this checkout's hook: $FP_WHY"
      echo "        the hook re-earned $FP_AFTER; the found key was put back, as this block promises"
    else
      printf '%s\n' "$FP_ORIGINAL" > "$FPCACHE"
      no "$FP_SUBJECT" "the hook missed and left no valid key (on disk: ${FP_AFTER:-<empty>})"
    fi
  fi
else
  echo "  INFO  no fixed-point key existed when this run started, so none was restored; the hook re-earned the key on disk in the cold run above"
fi

echo ""
echo "smoke: $pass pass, $fail fail"
exit $((fail > 0 ? 1 : 0))
