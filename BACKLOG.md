# Backlog

Open items, with the evidence that justifies each one.

**Closed items are removed, not struck through.** Git holds the history. That rule was in
this file's preamble from the start and was not followed for months, which is how it reached
2,509 lines and half the tracked markdown in the repo. Refuted claims, retracted figures,
measurement hazards and standing decisions now live in `docs/engineering-record.md`;
read that before proposing work, or you will re-propose something already disproven there
with evidence.

Anything measured says so and names the date. Anything unverified says that too.

## Open

### Test harnesses can silently assert against a frozen home

`src/*` modules capture `os` at require time and their exported helpers default
to `os.homedir()` at call time, so the SECOND harness in a test file resolves the
FIRST one's mocked home unless the file purges repo `src/` from `require.cache`.
Two files do (`local-drain-extension.test.js`, and now `dashboard-view.test.js`);
the others do not.

This already cost a real assertion. When the rebasing writer moved into
`src/settings-write.js`, the dashboard harness's scripted-read seam stopped
reaching it, and the affected test did not fail loudly — its precondition
silently became unreachable and the assertion after it went vacuous. **Audit the
remaining multi-harness test files for the same shape**; a test that cannot fail
is worse than one that does.

### restoreFromBackup still recomputes the pass twice

It runs its own `processAllowList` and then calls `refresh()`, which recomputes
it. Left alone when the watcher path was fixed, because this one is user-initiated
and rare rather than fired by a file watcher. Now cheap anyway at 6 ms, so this is
tidiness rather than performance.


### Managed-block removal can fuse the user's own lines

Both newline sweeps eat every adjacent newline and only the end-of-file case puts
one back: `let above = range.start` at `src/agent-guidance.js:170-173`, against a
file whose contract (`:22-25`) is that the block is "removable without touching a
byte of the user's own text". Measured:

    CASE 1  off        -> "my own notesmore of my notes\n"     <- two user lines fused
    CASE 2  first off  -> "user preamble<!--GB-->\nGATES\n<!--GE-->\n"

Case 2 is `--guidance off` while gates or a derived block is installed, a
documented supported combination. Harmless on this box *today* only because the
live `~/.claude/CLAUDE.md` has the block at lines 1-31 with user content from 33,
so `start === 0`; any content added above the block, or any second block below
it, arms this.

Related, same file: `blockRange` (`:130-136`) takes `indexOf(begin)` then the
**first** `indexOf(end, start)`, with no guard against a body containing its own
END marker. The gates body is arbitrary user-corpus text and the derived body
embeds managed rule text, so a memory whose `<!-- gate -->` section documents
this feature — entirely plausible for someone whose memories are about their own
tooling — truncates the range; `apply(text, true)` then leaves the old body tail
plus an orphaned END marker in the file, accumulating on every toggle.

And there are **five unsynchronized writers** of that one file: CLI guidance
(`setGuidanceAll` at `bin/wildcard-perms:579`), CLI gates (`:646`), extension
guidance (`setGuidanceAll` at `extension.js:2799,2848`), extension gates
(`:3009,3073`) and `decideDerived` at `auto-learn-manager.js:1221`. Only the
last holds a lock, and it is the *policy*
lock, which none of the others take — so it buys nothing here. The extension also
recompiles gates automatically on a memory-dir change, so an automatic write can
race a manual `--guidance off`. Individually recoverable; combined with the two
findings above, a race can leave the file structurally broken. Note also that the
instruction-file backups are single-slot fixed names
(`agent-guidance.js:233`, `derived-guidance.js:342`), so two toggles in a row
overwrite the good copy with the bad one.

### Smaller measured perf items, none urgent

- `src/policy-guard.js:117` — `missingFromLive`'s cover fallback is quadratic
  when backup entries are not present verbatim in live, which its own comment
  calls "the normal state". 0.13 ms today because the Set fast path hits;
  **15.5 ms** measured with no verbatim hits. Same prefix-index fix.
- `src/local-settings.js:73` — `grantedBy` does `allow.includes(entry)` (linear;
  should be a Set) plus a linear cover scan, per local entry, twice via
  `redundantUnder`. Drain path only.
- The drain path in `bin/wildcard-perms` reads settings.json 4 times and runs
  processAllowList twice per drain.
- `src/policy-exporters.js:537` (also 476, 677) — `new RegExp` inside a nested
  loop; five hoistable constants. Codex-validator path only.
- `src/managed-policy.js:164/184/185` — `[...deny, ...ask]` spread twice per
  assessed permission, and `coversPrefix:69` re-lowercases both sides of every
  token comparison when the rule side could be lowered once at rulePrefix time.
  4.48 to 2.36 ms per 285 candidates against 300 rules. Managed boxes only.

**Checked and NOT worth doing**, recorded so it is not re-derived: the
per-observation `aggregateObservations([observation], { threshold: 1 })` at `auto-learn-manager.js:1771`
looks like a batch-function-in-a-loop but measured 53.29 ms vs 50.21 ms batched
over 1,422 observations (6%); `new RegExp` at `history-adapters.js:445` never
appears in the CPU profile; multiple `readSettings()` per extension event is
0.127 ms each and the freshness is deliberate and documented; the double
JSON.stringify compare is 0.038 ms; `memory/recall.py` has no hot-path issue,
since build_or_update already gates re-embedding on mtime+size.

### The deactivation drain has no deadline

The other three findings from the 2026-09-09 leak audit are now fixed — children
are tracked and killed, the `deactivated` flag exists and is checked in the three
schedulers as well as the async continuations, and the runner and busy latch are
reset. This one is deliberately left, and one new consequence of it is recorded
under the 2026-09-10 audit below.

- **The drain has no deadline** (`autoLearnWorkerRunner.js:79-82`).
  `await Promise.allSettled([...jobs])` runs *before* any terminate() and no
  layer sets a per-job timeout, so a worker wedged on a large transcript makes
  deactivate() never resolve — a stalled window reload — and the thread is never
  terminated because terminate() is only reached after the drain. Also
  `workers.delete()` lives only in the exit handler, so a worker that errors
  without exiting sits in the set for the session. **Deliberately not changed:**
  the drain is documented as existing so JS rollback stays available, and a
  deadline that cuts a policy write is worse than a slow reload. atomicWrite is
  temp+rename, so a terminated write leaves a temp file rather than a corrupt
  settings.json, which makes a generous deadline defensible — but it is a
  semantics change to teardown and wants its own decision.
- **Cancel targets the wrong request** (`extension.js:696-698`).
  `token.onCancellationRequested(() => activeReq?.destroy())` only ever holds the
  outermost httpsGetFollow return, while httpsGetFollow (`:640-654`) builds a
  fresh req per redirect and surfaces none of them. The comment at 635-636 says
  the model's /resolve/ URLs always 302, so **Cancel is a no-op on every real
  download** and the 32 MB transfer runs to completion. No deactivate path either.

### 42 dead export names, and 6 option keys with no supplier

Verified 2026-09-09 by loading every module and diffing declared exports against
all references across `src/`, `bin/`, `vscode-extension/` and `test/`. Every
internal import in this repo is destructured and there is no namespace-style
require of an internal module in production code, so textual absence really does
mean unused.

The functions themselves are live inside their own modules; only the
module.exports entry is dead, so removing the name is safe and free. Largest
concentration is `src/permissions.js` (14 of 33 exports), then `codex-max.js`
(4), `agent-guidance.js` (3), `memoryLint.js` (3), `autoLearnUi.js` (3), with
singles across agent-gates, local-settings, permission-match, recall-index,
derived-guidance, exec-resolve, tool-learn and mirror-pack. A separate set is
**test-only** — real consumers, just not public API — and should be labelled
rather than removed.

Six option keys are read with zero suppliers anywhere including tests, each
leaving an unreachable branch: `managedPolicyPath` (3 reads, 0 writes),
`defaultTool` (makes `history-adapters.js:718` an unreachable early return),
`priorCursors`, `busyMessage` (`policy-lock.js:43-45`), and `homeDir` /
`successThreshold` — the last two unreachable because `extension.js:941-942` sets
both spellings on the same object, so the `||` and `??` legs never fire.

Also unreachable: `extension.js:1058` (`typeof manager?.overview ===
'function'` is always true, the same shape as the three fallbacks already
recorded here), `policy-exporters.js:682-686` (a mergeClaudeAllow overload shim
nobody calls with an object third argument) and `:691-694` (that third parameter
is vestigial in production; only a test passes a function).

Two corrections to this file's own claims:
`list: listCandidates` at `auto-learn-manager.js:2009` has **zero** consumers
anywhere, so it is dead on
both sides rather than merely an unreachable fallback; and "verdicts.unknown can
no longer be non-zero" is **half wrong** — the `!policy.present` path is provably
dead, but `managed-policy.js:162` (`!toolOf(permission)`) is reachable, because
sanitizeState truncates claudePermission to 768 chars, which can cut the closing
paren and fail RULE_SHAPE.

### Duplication worth collapsing

`permissionMatches` exists twice with **byte-identical** bodies —
`src/policy-guard.js:91-93` and `vscode-extension/autoLearnUi.js:111-113`, each
one line delegating to ruleMatches. `test/policy-guard.test.js:192` exists to
catch drift *between the two implementations*, and since neither has independent
logic left, that half of the test can no longer fail: it is now purely a
correctness test of ruleMatches. Collapsing autoLearnUi onto the policy-guard
export removes a wrapper and the pretense of a second implementation.

`policy-lock.js` carries two busy strings for one condition —
`POLICY_LOCK_BUSY_MESSAGE:20` and the default `busy()` at `:45` — and the thrown
`conflict.message` is discarded by every consumer, each substituting
`POLICY_LOCK_BUSY_MESSAGE` instead (`extension.js:2422`, `:2686`,
`bin/wildcard-perms`). With the dead
`options.busyMessage` above, the whole indirection collapses to the constant.

(Not a defect, noted so nobody "fixes" it: the duplicated
AUTO_SUFFIX_CLOSED_ROOTS and the two SAFE_GIT lists are deliberate and
drift-tested, documented in both export comments.)

### Declared-but-unwired UI

Cross-referenced 2026-09-09 and re-run 2026-09-10; the headline diffs come back
clean in both directions (19 of 19 commands registered, 4 of 4 menu entries
resolve, 16 of 16 config keys both read and declared, 8 of 8 CLI verbs
dispatched), so these are the residue.

Both the uninstall gap and the missing config listeners are now closed — verified
empirically 2026-09-10 under both PowerShell editions, including per-hook removal
that spares a co-located third-party hook, and `memory.enabled` taking effect both
ways without a window reload. What remains:

- **Two dead webview switch arms**: `extension.js:3165` (autoLearnApply) and
  `:3167` (autoLearnMode) have no sender. All `type:` literals were enumerated
  (16 senders, 18 arms); the element ids alApply/alMode do not exist. Two
  dashboard buttons were removed and their handlers left behind. Both features
  remain palette-reachable, so this is dead dispatch, not lost functionality.
- **`extension.js:17-34` hard-requires `./src/*`**, which .gitignore excludes and
  scripts/package.mjs creates only at package time. Self-documented as a known
  asymmetry in `autoLearnUi.js:5-16` ("extension.js gets away with ./src/ only
  because its one test installs a Module._load hook"), and the same file handles
  the identical problem correctly for Python via a two-path probe. Low impact —
  no `.vscode/launch.json` exists, so a fresh checkout has no F5 path — but it is
  literally a require of a path absent from a clean clone.

### The memory convention and this project's lint disagree about `scope:`

`recall.py --lint` reports "type: feedback with no scope:" as actionable, since
the gates compiler cannot place such a memory. But the memory-authoring
convention Claude Code itself follows defines frontmatter as
name/description/metadata.type with **no `scope:` key**, so every feedback memory
written the normal way trips this check on arrival — observed immediately on
2026-09-09 with a newly written memory. Either the lint should treat a missing
scope on `feedback` as "not a gate, no action", or the convention needs to carry
scope. As it stands, the lint's one actionable finding class is guaranteed noise.

### Small, off-axis, confirmed

- The `fs.rmSync(sandbox, ...)` at `scripts/auto-mode-audit.js:94` deletes the sandbox
  before the `return {` at `scripts/auto-mode-audit.js:96-102` reports `sandbox`, so
  `report.sandbox` names a deleted directory on every run without `--keep`.
- `src/policy-lock.js:92-96`: if openSync succeeds but writeFileSync/fsyncSync
  throws, removeOwnedLock cannot JSON.parse the empty file and returns false,
  orphaning the lock until the staleness path reclaims it.
- ~~`package.json` declares `engines: node >=18`, but CI now tests 20 and 22 and
  node 18 is past end of life. Either raise the floor or test it.~~
  **RAISED TO `>=20` 2026-09-14, not tested at 18.** Reasoning, because the
  alternative was defensible: node 18 is past end of life and takes no security
  patches, and this project writes the user's permission policy, so advertising
  support for an unpatched runtime is a promise it cannot keep. Nothing exercises
  18 — `test.yml` runs 20 and 22 on ubuntu and windows, `release.yml` builds on
  20 — so `>=18` was an untested claim, which is the same class of unverified doc
  claim as everything else in this cluster. Adding an 18 job would have added two
  jobs to defend an EOL runtime and committed the project to keeping them green.
  **The floor was raised, not the matrix.**
  - **This is a support-policy decision, not a technical necessity, and saying so
    matters.** A search of `src/`, `bin/`, `test/`, `scripts/` and the extension
    found no API that requires node 20: the `node:` builtins in use are assert,
    child_process, crypto, events, fs, module, os, path, test, url and
    worker_threads, with no `mock.timers`, no `structuredClone`, no `fs.glob`, no
    `util.styleText`, and no `--test-reporter` flags. The code would very likely
    still run on 18. The claim being fixed is that the project *promises* a floor
    it never tests, not that 18 is broken.
  - The two `Node >= 18` statements in README.md moved with it. Nothing asserts
    the `engines` value, so there was no test to update.
- A work-domain email address appears as the author of 3 of 48 commits (all
  2026-08-21) in this **public** repo's history. Future commits are already safe:
  the global git identity is a personal address. Rewriting history was declined —
  it breaks the v1.4.1 tag and the published release SHA, and cannot un-publish
  what is already cloned, cached and forked. Recorded as the owner's decision to
  make, deliberately without restating the address here, since this file is
  public.

### Nothing at all protects the transcript or memory corpora

Same event, and this is the expensive half. `~/.claude/projects/**/*.jsonl` went
to **7 files / 6 MB**, oldest 18:57 that day — and the sharpest measure of that
is in this file: the `state.candidates` entry below recorded **710 cursors
against exactly 710 files** on 2026-09-09, hours earlier. So 710 transcripts
became 7. The corpus behind every measurement this project has published (largest
single transcript 70.4 MB, 6,870 observations, 249 runs) is gone. The file-memory
corpus went to one memory with zero standing orders, taking the 6 compiled gates
with it.

Two knock-on effects worth knowing before trusting anything derived from state:
the learner rebuilt from what survives, so `candidates` is 50 where that entry
says 285, and `observationHashes` is 352 where it was capped at 20,000. **Every
numeric trigger in this file is now far from firing for the wrong reason** — not
because the pressure eased, but because the evidence was deleted.

`recall.py` already supports `RECALL_MEMORY_DIR`, so pointing the *reader* off-tree
is supported. It does not solve it alone: Claude Code writes memories to
`~/.claude/projects/<workspace>/memory/` and that path is not configurable, so
durability needs the directory itself to live elsewhere (a junction to a git repo
on `D:` keeps both defaults intact and survives a reset as data plus one junction
to recreate). The corpus is private, so it must not go in this public repo.

## Left from the 2026-09-09 audit

Five parallel read-only audits over the whole repo, measured on a real machine
(712 transcripts, ~920 MB; 317-entry allow list; 3.7 MB state file). Eight items
were closed by the v1.4.0 burn-down and removed from this file; what follows is
what was deliberately left.

### Small, confirmed, no urgency

- Dead: `mineWildcard` (`src/permissions.js:190`),
  `readConfig` (`src/codex-max.js:112`), `readAllow` (`vscode-extension/extension.js:120`),
  the exported alias `DEFAULT_POLICY_LOCK_STALE_MS`, and the option keys
  `claudeHistoryPath` / `codexHistoryPath` / `validateCodexRules` (one occurrence
  repo-wide each).
- `manager.getStatus()` / `getCandidates()` / `list()` fallbacks in
  `extension.js:1019,1026` can never run: they are aliases of the functions
  checked first, and no test injects a partial mock.
- `verdicts.unknown` can no longer be non-zero, and the whole `verdicts` object
  is read by no production code (only `--learn status` JSON and tests).
- `--guidance off` sweeps only the shell-style block, and the install/uninstall
  scripts never touch instruction files, so an accepted derived block is orphaned
  after an uninstall with no command that removes it.
- The Codex validator's temp file is created before the `try` whose `finally` unlinks it:
  `.permission-wildcarding-validate` at `src/auto-learn-manager.js:807-809`, so a failed
  write orphans it.
- `policyCache` has no invalidation path from the managed-policy watcher, so
  `status()` reports a stale verdict between a policy change and the next scan.
- `rebuildManagedHits` is not in `auto-learn-worker.js`'s allowed operations, so
  a UI-triggered rebuild would block the extension host.

## From the 2026-09-10 five-agent audit

Five read-only agents were run over the day's work: regressions, dead code and
wiring, memory leaks and lifecycle, optimization, and correctness. Everything they
confirmed as a REGRESSION was fixed the same day and is not listed here. What
follows is what was confirmed and left. Note two of them independently found the
same two Tier-1 defects (the installers and the coverage index), which is worth
knowing when deciding how much to trust a single agent's report.

### The installers have no behavioural test on CI, only static guards

`test/installers.test.js` (new 2026-09-10) drives `install.sh`'s and
`uninstall.sh`'s real embedded ES modules, so the POSIX half is covered
everywhere. The PowerShell pair cannot be driven on a POSIX runner, so it gets
static guards instead: no `-AsHashtable` outside a `#Requires -Version 6`, and
both scripts must contain a refusal path. The behavioural PowerShell harnesses
exist but live in a session scratchpad and will be lost.

**Worth doing:** move them into `scripts/` and call them from
`verify-release.ps1`, or add a `windows-latest` CI job that runs them under
`powershell.exe` specifically — the defect they catch is invisible under `pwsh`.
The seam they need: `install.ps1` reads
`[System.Environment]::GetFolderPath("UserProfile")`, which ignores
`$env:USERPROFILE`, so the harness copies the script with that one line rewritten.
(An earlier version of that harness, before the seam was understood, ran the real
installer against the live `~/.claude` five times. Nothing was lost — the hook was
already registered, which short-circuits before the write — but it is the reason
the seam is documented here.)

### Four test harnesses can still assert against a frozen home

The general form is already recorded above. The specific audit, 2026-09-10:
`dashboard-view.test.js`, `local-drain-extension.test.js` and
`extension-lifecycle-async.test.js` purge repo `src/` from `require.cache`.
`policy-backup.test.js`, `policy-guard-unreadable.test.js`,
`extension-activation.test.js` and `extension-managed-blocked.test.js` delete only
`extensionPath`.

Exactly five module-level paths leak from the first harness to every later one:

```
MAX_STATE_FILE       src/permissions.js:601
APPROVE_SCRIPT       src/permissions.js:607
BYPASS_STATE_FILE    src/permissions.js:522
POLICY_LOCK_PATH     src/policy-lock.js:19
CODEX_CONFIG         src/codex-max.js:35
```

**No assertion is vacuous today** — only `policy-backup.test.js` touches any of
them, and it survives because each test writes the MAX snapshot and reads it back
within itself while `writeMaxState`'s `mkdirSync(..., {recursive:true})` silently
recreates the deleted temp home. But every one of those tests is one early return
away from becoming vacuous, and the suite leaves stray directories in
`os.tmpdir()`.

### Assertions whose guarantee is narrower than their comment claims

None is vacuous — each has a nameable killing mutation — but the stated guarantee
is wider than the check:

- `test/dashboard-view.test.js:330` counts webview routes with
  `/case '[A-Za-z]+':\s*vscode\.commands\.executeCommand\(/g`. A route written
  as `case 'x': { ... }`, dispatched via a variable, or named with a digit is not
  counted, so "fails if a route is added untested" holds only for the current
  spelling.
- `test/extension-lifecycle-async.test.js:442` uses `/(?<![\w.])execFile\(/g`,
  which excludes `.execFile(` — a fifth spawn written `cp.execFile(` passes
  silently.
- `src/derived-guidance.js:57-63` says truncation is 200 chars, but the escaping
  runs AFTER `.slice(0, RULE_LIMIT)`, so `&lt;!--` expansion can push the output
  past 200. The test only measures `'x'.repeat(400)`, which never escapes.
- `'the hook fires once, after a successful write'` at `test/settings-write.test.js:128`
  asserts `onWrite` fires once on success; nothing asserts it does NOT fire when
  `writeAllow` throws, and nothing asserts the CLI writer has no `onWrite` — that
  "deliberate rather than dropped" question rests entirely on a comment.
- `test/extension-lifecycle-async.test.js`'s `trackChild` check is a source-text
  scan for `trackChild(execFile(`, so a correct `const c = execFile(...);
  trackChild(c);` would fail it and a `spawn()` would slip past.

### Guidance removal still consumes one user newline at end of file

`src/agent-guidance.js:181-183` hardcodes `separator = '\n'` on the
end-of-file branch, while the install branch adds none when the file already ends
`\n\n`. Measured round trip: `"my own notes\n\n"` -> `"my own notes\n"`.
`test/agent-guidance.test.js:214-215` asserts this exact output, so it is a
deliberate-but-undocumented choice — the commit message claims byte-exactness.
Mid-file, start-of-file, adjacent-blocks and the CRLF install path all round-trip
exactly, and accumulation is stopped.

**Separate residual, no migration exists:** a file damaged by the pre-fix
inner-marker bug is not repaired. `blockRange` on a file containing
`...END ... BEGIN ...` returns null, so `has()` is false and `apply(text, true)`
appends a SECOND block, leaving the orphaned END above it and accumulating per
toggle. Only reachable for a user whose corpus quoted a marker before 2026-09-10.

### Dead exports and unreachable options, re-measured

The recorded "42 dead export names" still holds as a count; the composition moved
(`enableMaxAllow` gained a real consumer; `disableMaxAllow` and
`registerApproveHook` are now test-only rather than dead). 51 export names are
referenced only from `test/`. Newly confirmed 2026-09-10, all with zero code
references:

- `defaultSettingsPath` (`src/settings-write.js:24`) — used only internally at
  `:143`. Landed the same day it became dead.
- `createSettingsWriter`'s own fallbacks (`src/settings-write.js:142-143`): all
  three callers pass `settingsPath`, so both the `= {}` default and the
  `|| defaultSettingsPath()` leg are unreachable. `onWrite` IS supplied, by the
  extension only.
- `assessPolicy`'s `claimed` parameter (`src/policy-guard.js:190`, consumed
  `:195-196`) has no supplier anywhere; its branch is dead.
- `isBulkLoss`'s `options.minimum` / `options.fraction`
  (`src/policy-guard.js:173-175`) — every call site passes two arguments.
- `renderCodexRules`'s `options.version` and `options.header`
  (`src/policy-exporters.js:392-397`) — two dead keys and three dead arms across
  7 call sites.
- `options.claudeSettingsPath` (`src/auto-learn-manager.js:875`) — a fourth member
  of the already-recorded alias family; only the alias spelling is supplied.
- `applyClaude` / `applyCodex` (`src/auto-learn-manager.js:1654,1659`) are test-only;
  production uses `apply`, and the worker's allow-list does not include them.
- `createCoverIndex(...).stats()` is test-only — a measurement hook, not API.

Proved clean, worth recording so it is not re-derived: **zero orphaned functions**
across 578 declarations in `src/`, `bin/`, `vscode-extension/` and `scripts/`, and
**zero broken imports** across 99 destructured `require` sites / 317 names.
19/19 commands, 4/4 menus, 16/16 config keys and 8/8 CLI verbs are wired in both
directions. `scripts/package.mjs` enumerates `src/` dynamically, so there is no
VSIX gap.

### Smaller confirmed items

- **`policy-lock` orphans a zero-byte lock for the full 10 minutes.**
  `locked()` creates the file with `openSync(..., 'wx')` and writes its metadata
  after. A process that dies in that window leaves a lock with no valid pid, so
  `recoverLock` falls to the `lockAgeMs(stat) < staleMs` branch and refuses to
  reclaim it for `DEFAULT_STALE_MS`. Low probability, and it fails closed
  (refusal, not corruption), but the fix is small: treat a zero-byte lock as
  reclaimable after a short grace rather than the full stale window.
- **The hook accumulates stdin without a bound.** `input += chunk` at `bin/wildcard-perms:96`
  has no cap, and a PostToolUse payload carries tool output.
  A cap with a graceful "no cwd, no drain" fallback costs nothing.
- **`run()` relies on `finish()` never returning.** `bin/wildcard-perms:282` is
  `if (!settings) finish(input, false);` with no `return`. Correct today because
  `finish` ends in `process.exit(0)` on all three paths; one added early return
  and execution falls through and calls `finish` twice. One word.
- **`wildcardUnderLock` ignores `writeAllow`'s `addedAllow`**
  (`bin/wildcard-perms:296-300`), computing `added`/`removed` from its own
  pre-write snapshot — the exact anti-pattern `src/settings-write.js:212-214`
  documents four lines above it ("A caller that reports its own intent instead ends
  up announcing … '+299 restored' over a file that already had them"). Only a stderr
  diagnostic.
- **The teardown flag can be cleared under a pending teardown.** `deactivate()`
  sets `deactivated = true`, then awaits a drain with no deadline; `activate()`
  sets it false. If VS Code's deactivate timeout expires first and a same-realm
  re-activate runs, the OLD deactivate's continuation then nulls the SUCCESSOR's
  runner without draining it. A second consequence of the recorded "no deadline"
  item. SUSPECTED — depends on VS Code await semantics not verifiable from here.
- **A junction to a large tree is now walked in full.**
  `entry.isSymbolicLink()` children are queued at `src/history-adapters.js:939`, which
  was the point (junctions), but the realpath set stops cycles, not breadth. And a
  transcript reachable by two link paths gets two cursors and two parses;
  `observationHashes` dedupes the observations, so only I/O and state size are
  wasted. SUSPECTED cost, not correctness.
- **`/cygdrive/d/...` is not normalized** by either uninstaller's path matcher.
  Every other spelling converges — I traced `node "D:/..."`, `/d/...`,
  backslashes and case. Cosmetic.

## From the 2026-09-10 optimization and correctness pass

Four phases landed (`1b41205..cd1f50c`): `managed-policy` off the hook path, the
dashboard's doubled memory report, the last three whole-object writers, and the
hook fixed-point cache. What follows is what was found and deliberately left.

### Corpus hygiene, owned by concurrent sessions

Not repo issues, recorded so the acceptance board's state is explained rather
than mysterious. As of 2026-09-10 the board is 27 PASS / 2 FAIL, and both
failures are in the shared memory corpus, edited by another session ~45 minutes
before this run:

- `ollama-api-gotchas.md` has `scope: global` with **no `<!-- gate -->` block**,
  so it is resident-eligible and never compiled — the exact `no_gate` condition.
  Either add a block or drop the scope.
- Three files (`deletion-forensics-enabled.md`, `devtoolbox-shim-recovery.md`,
  `pc-maintenance-deletion-history.md`) still link to
  `[[pc-maintenance-is-report-only]]`, which was renamed to
  `pc-maintenance-deletion-history`. A rename left the references behind.

Deliberately NOT fixed here: those files were being actively edited, and writing
into another session's in-flight work is the same class of defect this whole pass
was about.

## Audit of 2026-09-10, second pass

Five read-only agents over the day's work, plus my own verification of each
claim. Recorded with the measurement method, because several earlier entries in
this file were wrong in ways that only the method explains.

**Two agent findings I DISPROVED rather than actioned** — recorded so nobody
re-opens them:

- *"`test/extension-managed-blocked.test.js` writes into the real `~/.claude` on
  every `npm test`, because a module-scope require resolves `POLICY_LOCK_PATH`
  against the real home."* **False.** `src/auto-learn-manager.js` computes **no**
  paths at module scope, and the test passes `home: tempHome` explicitly. An `fs`
  wrapper over `writeFileSync`/`mkdirSync`/`openSync`/`unlinkSync`/`rmSync`/
  `rmdirSync`/`renameSync`/`appendFileSync`/`copyFileSync`, installed via
  `--require` so it precedes every module, recorded exactly **one** path under the
  real home across all 405 tests: npm's own debug log.
- *"The root/extension version skew defeats the version badge's purpose."*
  **False as stated.** `extensionVersion()` reads `./package.json` relative to
  `extension.js`, i.e. the extension manifest, so the badge was always correct.
  The skew was real but the consequence was the other way round: **`wildcard-perms
  --version` printed 1.4.2 while the badge said 1.4.4**, both shipping in the same
  VSIX. Fixed, and pinned by a parity test in `test/installers.test.js`.

### Open, ranked by frequency x cost

**READ THE MEASUREMENT HAZARD BELOW BEFORE TRUSTING ANY fs FIGURE IN THIS
TABLE.** Four of these ten items were re-measured on 2026-09-10 and three of them
evaporated; the rows are annotated inline. Figures were second-party
measurements, cold for the hook (one fresh process per sample, interleaved arms)
and warm for the extension (a long-lived host is the real regime). `min / p50`.

| # | Item | Cost | Frequency |
|---|---|---|---|
| 1 | **The dashboard refreshes while nobody can see it** — but far less often than this row claims. **CORRECTED 2026-09-10:** `resolveWebviewView` installs `view.onDidDispose(() => { if (this.view === view) this.view = null; })`, and the view IS disposed when hidden (no `retainContextWhenHidden` in the manifest), so `refresh()`'s existing `!this.view` guard already covers a closed sidebar. What remains is the collapsed-but-not-disposed state and the lag before a disposal event is delivered. Still worth the one-line `!this.view.visible` guard as robustness, but NOT 22.7 ms x ~50 sites. Original text: `_push()` guards `deactivated \|\| !this.view` but never `this.view.visible`, so all ~50 `refresh()` sites pay the full main-thread sync fs cost with the sidebar collapsed. The handler that makes skipping safe already exists (`view.onDidChangeVisibility`), so this is a `visible` check plus a dirty flag | 19.6 / 22.7 ms per push, avoidable entirely | ~50 sites, per settings change |
| 2 | ~~**`fullReport` re-reads the whole memory corpus every push.**~~ **REFUTED 2026-09-10 — 0.56 ms, not 7.96.** See the measurement hazard below: the 7.96 was measured in a temp `HOME`, where reads cost 6x what they cost in the real `~/.claude`. Measured properly, 17 files: read 1.46 ms p50 vs stat 0.90 ms, a **1.6x ratio, not 10.3x**. And the growth argument was wrong too — a stat stamp scales with the corpus exactly as the reads do, so it never removed the growth axis; it only shrinks the per-file constant from 0.086 to 0.053 ms. Original text: 16 separate `.md` reads, versus 0.74 ms to `statSync` all 16 or 0.70 ms for one concatenated read. An mtime-keyed cache cuts ~32% of `_push()`. **This is a growth axis with no ceiling** — the corpus gained a file *during* the audit and `_push()` grew by 3 syscalls; at 50 memories it is ~25 ms per refresh | 6.98 / 7.96 ms | every push |
| 3 | **`runWildcarding` takes the policy lock before it knows there is work.** The extension already holds the bytes it just read, so an in-memory last-bytes compare answers the same question for ~0.005 ms. Read outside the lock, compare, lock only when a write is due — worth ~6.5 of its 9.3 ms, plus removing needless Auto Learn contention. A **file** cache is the wrong tool here | 3.39 / 3.72 ms lock (46% of it `fsyncSync`) + 2.38 / 2.76 ms redundant pass | per settings.json write |
| 4 | ~~**44 KB of verb bodies compiled on every hook call.**~~ **REFUTED 2026-09-10 — 0.00 ms.** Cold, one fresh process per sample, arms interleaved, all files in ONE directory on the repo's volume so the location effect below cannot favour either arm, n=61: the real 44.4 KB file (with `process.exit(0)` injected at the top, so only read+parse+compile is measured) is **min 43.87 / p50 48.54 ms**; a 1.8 KB stub is **44.00 / 48.73**; and a **212-byte** floor — nothing but the requires and one exit — is **43.01 / 48.48**. Going all the way to 212 bytes buys 0.86 ms at min and 0.06 ms at p50 against a ~48 ms process floor. V8 pre-parses and lazily compiles function bodies, so unexecuted verb code is free. A ~30 KB refactor of the most safety-critical file in the project, touching the dispatch branch that once silently rewrote the user's policy and exited 0, for nothing. **Do not re-derive this.** Original text: A minimal 0.9 KB hook doing only the hit path beats the real `bin/wildcard-perms` by this much (n=51, both signs agree). Splitting hook mode into a small entry that lazily requires `cli-verbs.js` is the only remaining hit-path win anyone demonstrated | 1.12 / 2.50 ms | **every Bash/PowerShell tool call** |
| 5 | ~~**`gates.generated.md` read 5x per push**~~ **REFUTED 2026-09-10 — ~0.34 ms, not 1.69.** Same temp-`HOME` inflation. Original text: — `gatesStatus` calls `readCompiled` for both `makeGatesBlock().body()` and `compiled:`, times 2 targets. My earlier deferral called this "sub-millisecond"; it is not | 1.55 / 1.69 ms | every push |
| 6 | **`coverLookupKeys` scans per character and is not memoized across the two sweeps.** The two `covers()` sweeps are 73% of `processAllowList`, and inside them the dominant cost is key generation, not matching: stage 3 makes 431 `covers()` calls but only 407 `sameRule` + 3 `ruleMatches`, so almost all of its 3.89 ms is walking 8018 arg chars to build 1479 keys — twice per pass, over the same 431 strings. A prototype using one native global-regex scan plus per-rule memoization was **differentially identical on 83 cases with every axis asserted non-degenerate** (probe fired in 18, fallback non-empty in 31, pruning in 20, generalizing in 28) | 1.62 / 1.84 ms of a 9.1 ms pass | every miss + every hintless push |
| 7 | **`recallIndexStatus` is a second per-corpus-file loop** inside every push: 16 `statSync`, a 122 KB `recall_index.json` read, 3 `existsSync` probes. Should share the pass `memoryReport` already does | ~1.6 ms | every push |
| 8 | ~~**`CLAUDE.md` and `~/.codex/AGENTS.md` read twice each**~~ **REFUTED 2026-09-10 — ~0.17 ms, not 0.89.** Same temp-`HOME` inflation. Original text: — two `installedGuidanceTargets()` walks. Also not sub-millisecond in aggregate | ~0.89 ms | every push |
| 9 | **The hook computes its key twice on a miss** — `isFixedPoint(bytes)` then `fixedPointKey(bytes)` again, so it stats both code files twice and hashes 17 KB twice. The fix was built and verified to write an identical key, and measured at **+0.57 / −0.39 ms, i.e. unmeasurable.** Worth doing as tidiness, not as performance | ~1.2 ms in-process, **0 end-to-end** | per settings change |
| 10 | `settings.json` read and parsed 3x per push | 0.21 / 0.20 ms | every push |

### The launcher hazard, worth a test on its own

`cmd /c node …` adds **17.6 / 13.5 ms** to the hook. `powershell.exe -Command
node …` adds **1059 ms p50** — a factor of 18 on the whole hook. If anything in
the installers ever registers the hook command through PowerShell instead of as
a bare `node "…"`, that is a **1.1-second-per-tool-call** regression hiding in
plain sight, and nothing currently asserts the registered `command` string's
shape. `scripts/verify-installers.ps1` is the right home for it.

This also explains a standing discrepancy: measured directly from node the hook
is 58.8 hit / 71.9 miss p50, well under the ~88/106 recorded earlier. The
launcher is most of the gap.

## Zero test coverage on two load-bearing branches

Both found while scoping items that were then dropped:

- **`bin/wildcard-perms:57-73`** — `--help`, `-h`, `--version`, `-V` and the
  unrecognized-option guard have **no test anywhere**. That guard exists because
  its absence once "silently rewrote the user's permission policy and exited 0".
- **`src/auto-learn-manager.js:1600` (`Policy changed while Auto Learn was preparing it`)
  and `:1609` (`Policy changed before Auto Learn could write it`)** — see the
  whole-object writer section above.

Also unpinned and worth knowing: `fullReport` in `vscode-extension/memoryLint.js`
has **no direct test at all**. Seven test files stub `memoryReport` to a zero-arg
function and only `memory-lint-watchers.test.js` requires the real module, for
its watcher behaviour. A function performing 17+ file reads per dashboard push
is entirely uncovered.


---

## Audit of 2026-09-10, third pass — five agents over the day's commits

Everything below is from agents that reproduced their findings, and every claim
I acted on I re-verified myself. **Fixed in this pass** (see the git log for
detail): `writeAllow` destroying a non-array deny; `readSettingsState` and
`stateOfText` disagreeing; `stateOfText` classifying on `existsSync`;
`SETTINGS_CONTENDED_CODE` having no reader; two slots a wedged Auto Learn scan
stranded across a re-activate; `_push`'s guard treating a missing `visible` as
hidden; `lockedRetries` unreset on one of two early returns; and my own
concurrency test's fixture, which did not pin the property it named.

### Untested-but-correct: mutants that survive today

Each of these is CORRECT at HEAD and has no test that would notice a
reversion. Ranked by what a reversion would cost.

| Site | Surviving mutant | Consequence if reverted |
|---|---|---|
| `extension.js` post-lock `reportAlreadyOptimal` | replace the whole branch with `if (false)` | `backupPolicy` never runs on the "somebody else generalized it while we waited" path, so **a deleted backup is not rebuilt** — the one property that helper's comment promises |
| `extension.js` toast counts | revert to the probe's `after`/`before` | wrong added/removed numbers reported to the user |
| `extension.js` `lastRun` | delete the assignment | the dashboard's "last run" never advances |
| `extension.js` probe read guard | delete `if (!settings) …` | reports "already optimal" over an unreadable settings.json instead of staying silent |
| both `lockedRetries = 0` resets | delete either | retry budget strands or never strands; untested at **both** sites |
| `coverKeyCache` cap value | `LIMIT = 3` | the comment's "5000 is load-bearing, a cap below the list length clears mid-sweep" is asserted nowhere |
| `coverLookupKeys` non-string passthrough | delete it | nothing observes it |

### A test whose message is false for the case it names

`test/dashboard-view.test.js` — *"one push per burst, and the wildcarding pass
is not repeated for it"* asserts `passes.count - before === 1` with the comment
"one pass per settings write, not two". It seeds an already-optimal list, so **no
settings write happens**. On the actual write path `runWildcarding` now runs
`processAllowList` twice by design (probe + in-lock recompute). Confirmed:
removing the hint on the optimal path is killed by this test; removing it on the
**write** path survives. The write-path hint has no coverage at all.

Related, and NOT vacuous as feared: the five `policy-backup.test.js` tests that
call `runNow` on an already-optimal list now exercise the *unlocked probe* path
and a `backupPolicy` mutant kills 8 of them. What moved is which path they
cover — `backupPolicy` under the lock is no longer exercised by any of them.

### A leak my own re-activate fix introduced

Nulling `autoLearnWorkerRunner` in `activate()` (correct, and required) makes a
neighbouring comment in `deactivate()` false: it argues "the successor could not
have created its own while this slot was full, so it would inherit this dead
one." It now can. So when a wedged predecessor's worker finally answers, its
post-drain continuation nulls the **successor's live** runner without
`.deactivate()`ing it — a leaked worker thread per occurrence. The fix is the
same `generation === activationGeneration` guard already used for the busy latch.

Also: **`node --test` has no default per-test timeout**, so a never-settling
promise hangs the whole file instead of failing it. The wedged-worker test
should carry an explicit `{ timeout }`, and arguably every async test in that
file should.

### The memory-gate compiler: four ways to lose a standing gate silently

All reproduced. These matter more than they look, because a gate that vanishes
takes a safety instruction out of every future session with no error anywhere.

1. **A typo in the CLOSING `<!-- /gate -->` deletes the gate and lint still says
   clean.** `recall.py` tests only for the OPENING marker when linting, while the
   compiler requires both. Renaming the closer in one memory compiled **7 gates
   instead of 8** while lint printed "every standing order compiled", exit 0. The
   staleness check cannot save you either, because source and artifact go wrong
   together.
2. **The `clean:` line asserts three things it never checks** — total bytes,
   entry count, and unresolved `[[links]]`. A 33 KB / 416-entry index with a
   broken wiki-link prints both warnings *and* "clean". `memoryLint.js` repeats
   the same defect and reports an issue count of 0.
3. **Two gate blocks are written and never compiled** — `heredoc-eats-backslashes`
   and `xml-comments-reject-double-hyphen` both carry `<!-- gate -->` with no
   `scope:` line, so the compiler skips them and lint's inverse condition is
   blind to it.
4. **`--lint` always exits 0**, so it can never gate CI or a pre-commit hook.
   And `_fm()` reads only `text[:400]`, so a long `description:` pushes `scope:`
   out of range and silently drops a gate.

Plus: `memoryLint.js`'s gate selection is a second implementation that disagrees
with `recall.py` on 2 of 4 inputs, while its comment claims it "mirrors
recall.py … kept deliberately literal so the two are easy to compare". Nothing
compares them. Same shape as `coverIndexKey`/`coverLookupKeys`.

### The launcher guard holds; its harness has gaps

No false reject exists — all 19 path shapes tried are accepted (spaces, `$`,
backtick, `powershell`/`cmd`/`node_modules` in a directory name, CJK + emoji,
UNC, mapped drive, 8.3, `\\?\`, >260 chars, trailing dot/space, relative). But:

- **`verify-installers.ps1` has no zero-case floor.** With an empty results
  array it prints "0 pass, 0 fail" and exits 0. PASS means "nothing that ran
  failed", never "16 cases ran". `verify-release.ps1` already has the fix pattern.
- **The static guard is blind to suffix wrappers and to reassignment.**
  `'node "' + $p + '" & powershell -c evil'`, `'… | cmd /c more'`, and a later
  `$hookCommand = 'cmd /c ' + $hookCommand` all pass it. This matters because it
  is the ONLY launcher check on the POSIX CI leg.
- **The two halves disagree on case.** PowerShell `-match` is case-insensitive so
  `NODE "…"` passes there, while the JS assertion has no `/i` and rejects it —
  even though both uninstallers, cited as the contract, ARE case-insensitive.
- `APPROVE_COMMAND` does no quote escaping, so a POSIX `$HOME` containing `"`
  emits a genuinely broken command that the test rejects with the wrong
  diagnosis.

### Dead code, re-measured — and three earlier entries were WRONG

Method note that changed three verdicts: **comment mentions are not references.**

- **`SETTINGS_CONTENDED_CODE` was NOT resolved** by the vanish refusal, contrary
  to what I wrote here earlier today: that refusal SETS the code, it does not
  read it. Now genuinely wired (see the git log).
- **`enableMaxAllow`, `disableMaxAllow` and `registerApproveHook` are all still
  DEAD**, not "test-only" — their apparent test uses are comments.
- **`readAllow` no longer exists**; that entry is closed.
- Also now fixed and closable: `policyCache` invalidation, `rebuildManagedHits`
  missing from the worker's allowed operations, and `run()` relying on `finish()`
  never returning.
- Headline count holds at **41 dead export names**, 68 test-only, 111
  production. New unlabelled ones include `prunePermissions`, `MAX_ALLOW_CORE`,
  `detectMcpServers`, `ensureApproveScript`, `unregisterApproveHook`,
  `gatesStatus`, `readCodexMaxState`/`writeCodexMaxState`, and
  `fastLint`/`fullReport`/`pickPrimaryDir`.
- **Careful:** removing the *export entries* is free, but every one of those
  `src/permissions.js` functions is live INSIDE `applyMax`/`maxLayers`. A cleanup
  that deletes the function with the export takes MAX mode with it.
- **Four NEW option keys with no supplier:** `options.now` in `policy-lock.js`,
  `auto-learn-manager.js` and `codex-max.js` — three modules with no injectable
  clock, which is why none has a time-dependent test — and
  `options.cacheFile` in `fixed-point-cache.js`. `now` is worth SUPPLYING rather
  than deleting; it is the seam those modules need.
- **Newly proven unreachable** (by enumerating the input space, not asserting):
  the four `managerStatus`/`managerCandidates`/`autoLearnEvidence` fallbacks, the
  `mergeClaudeAllow` object-third-arg shim, `createSettingsWriter`'s `= {}`
  default and `|| defaultSettingsPath()`, `assessPolicy`'s `claimed`, and
  `fixed-point-cache`'s `cacheFile ||`.
- **Write-only locals:** `wrote` in the CLI's `--max`, `lastErr` in
  `writeFileAtomicSync`, and `err.result`/`err.latest` on both CONTENDED throws.
  Four unused imports: `isCoveredBy` in two modules, `SETTINGS_ABSENT`/
  `SETTINGS_PRESENT` in the extension.
- ~~**~60 stale `file:line` refs in this file, and 7 stale cross-file refs in code
  comments.**~~ **PARTLY DONE 2026-09-14, and it is no longer a hand count.**
  `scripts/check-line-refs.js` extracts every `file:line` reference from tracked
  `.md` files and from comments in tracked source, resolves each against the
  current tree, and grades it against an ANCHOR recovered from the surrounding
  prose — a backticked span, a quoted phrase, or a distinctive identifier. Run it
  with `--detail` to see the cited line beside the candidate, or `--json` to
  consume it. It counts **147** references (92 in BACKLOG.md, 41 in code comments,
  the rest in other docs), which is where the "~60" estimate came from and is
  more than twice it. 30 were corrected in this pass: 13 in code comments and 17
  here, each verified by reading the target rather than trusting the report.
  Everything below `runWildcarding` in `extension.js` shifted by ~41 lines in the
  pass that produced the original note, and editing `src/permissions.js`'s header
  by three lines during THIS pass invalidated four more references several hundred
  lines below it. That is the shape of the problem, and it is why the checker
  exists.
  - **Read the checker's STALE verdict as a candidate, not a proof.** Measured
    against hand verification on the code-comment set, a good fraction of STALE
    rows are the checker picking a neighbouring symbol as the anchor while the
    reference itself is fine. `bin/wildcard-perms:11-26` is the clean example:
    correct, and reported STALE because the sentence around it also names
    `createHash`. Verify before rewriting. It has no false NEGATIVES that were
    found by hand, so the honest summary is high recall, moderate precision.
  - **The residue is deliberate.** What is left is mostly UNVERIFIABLE — a
    reference whose surrounding prose makes a descriptive claim ("the refusal
    this documents") with no literal string to match. There is nothing to check
    those against short of reading both ends, and a guess would be worse than the
    stale number.
  - **`test/line-refs.test.js` asserts only the objective half** — every
    reference resolves to a real file and a line inside it — plus a count floor
    so that assertion cannot pass vacuously if the extractor stops matching. The
    STALE verdict is deliberately not asserted, for the precision reason above: a
    gate that cries wolf gets suppressed and takes the real signal with it.
    - It found a defect on its first tracked run: the checker's OWN format
      illustrations (`src/foo` style dangling examples) became references the
      moment the file was committed. Hence a line-scoped `line-refs` + `:ignore`
      marker. Line-scoped on purpose — a file that uses it for one illustration
      is still policed for its real references, and a mutation proves that.
  - **Bare `:NNN` continuation references are NOT covered** (`(`:489`)`,
    `(`:3206`)`). They carry no filename, so the checker cannot resolve them; the
    ones fixed in this pass were fixed by hand alongside their named sibling.
    Anyone extending the checker should start there.

### Optimization: the new DO list, measured in the right place

`processAllowList` warm is now **0.983 min / 1.095 p50** at 431 entries, not the
2.675/3.178 recorded earlier — the `coverLookupKeys` memo retired that figure,
and with it the "two `covers()` sweeps are 73% of the pass" claim. The new
dominant term is `createCoverIndex`: the two index builds are 21.2% + 21.4% of
the pass, now EQUAL to the two sweeps.

| Item | Measured | Regime | Rec |
|---|---|---|---|
| **`coverIndexKey` memo**, same bounded idiom as the one just landed. It is **74%** of an index build | warm 0.983/1.095 -> 0.483/0.540 (**-51%**); 1200 entries -55%; cold 6.98/8.61 -> 6.81/8.04 | A/B vs a built arm, interleaved, warm n=270 / cold n=41 | **DO** |
| **`fastLint`'s 19 `existsSync`** — answer the broken-link check from the filename list `fullReport` already has | **saves 1.07 min / 1.23 p50 ms per push** | real `~/.claude`, warm, n=61 | **DO** |
| **`recall_index.json` cache** on its own `mtime:size` (157 KB re-parsed every push) | saves 0.51/0.64 ms | real `~/.claude`, warm, n=81 | DO, low |
| **Hook stdin -> `fs.readFileSync(0, 'utf8')`** | 1.17-1.27 ms in-process, **not resolvable end-to-end** | cold, n=61, 3 arms | DO, low — it REMOVES 5 lines. Needs an explicit `if (!cwd)` fallback: a partial read silently truncates the JSON and the drain stops promoting approvals forever with no failing log line |
| **Sticky dashboard hint** — retain `{allow, optimized}` and revalidate with `sameList` | saves 1.38-2.19 min / 1.65-2.20 p50 ms per push | warm, n=180, 3 runs | **DEFERRED, not refuted.** It collides with "a stale hint is recomputed, not trusted": with a cache, a stale hint falls back to a cache that IS valid against disk, so no pass runs and that assertion goes 1 -> 0. Weakening a guard test to accommodate an optimization is how tests lose teeth. Revisit by re-expressing that test around the OUTPUT rather than the pass count |

**Measured and DROPPED — do not re-derive:**

- **`activate()`'s two lock acquisitions** — the premise is now stale. Counted
  empirically: a converged list with no project-local file takes **0**
  acquisitions; 1 if either half has work; 2 only on a first run. Taking the lock
  off both unchanged paths already did this. Merging would fuse two independent
  retry budgets for near-zero gain.
- **Inlining `fixed-point-cache` into the CLI** — built the arm, verified it
  removes exactly 2 fs calls; three cold runs give sign-consistent deltas of
  +0.8 to +3.7 ms, entirely inside the noise floor. ~200 lines duplicated for
  nothing.
- **The FNV-1a loop** — 0.513/0.600 cold, but the second call is 0.088/0.101, so
  **84% is V8 warm-up, not the loop**. A 4-byte-unrolled variant is SLOWER cold.
  Replacing the content hash with `mtime:size` would weaken the one property the
  module exists for.
- **The 19 `statSync` in `recallIndexStatus`** (0.765/0.848, the largest single
  fs component) — they ARE the staleness check, and `recall_index.json` is not
  watched. A stale "not stale" badge is worse than 0.8 ms.
- `settings.json` read 3x (0.302/0.506), `gates.generated.md` read 3x
  (0.118/0.450), `CLAUDE.md` read 2x (0.073/0.306), `MEMORY.md` read 2x
  (0.142/0.149) — all at or below the bar, confirming the earlier refutations.
- **Perfect fs dedupe as a package**: 87 -> 62 calls saves only 1.54/1.64 ms
  against the real location, LESS than the sum of its parts because each part
  carries shared per-call overhead. The `fastLint` item alone captures 70% of it.

**Hit path re-baselined: still 13 fs calls, nothing crept in.** `require.cache`
on a hit holds exactly 2 modules. The dominant remaining term is **not fs** — it
is the stdin round-trip at 3.78 min / 5.48 p50 ms, of which only ~1.2 ms is
stream overhead the hook controls.

### Housekeeping

**6,692 stale directories in `%TEMP%`** from pre-fix runs (`pw-gates` 3073,
`pw-local` 1535, `pw-guidance` 942, `permission-wildcarding-backup` 325; oldest
2026-08-19). The leak itself is fixed and measured at 0 per run. Clearing the
residue is a one-time manual sweep, deliberately not automated:

```
Get-ChildItem $env:TEMP -Directory |
  Where-Object { $_.Name -match '^(permission-wildcarding|pw|codex-max)-' } |
  Remove-Item -Recurse -Force
```


---

## From the 2026-09-14 hybrid-recall work

The retrieval change itself landed. These are what it surfaced and deliberately did not do.

## From the 2026-09-14 three-agent audit of c369e58

Eight findings were fixed in the follow-up commit. These are the ones deliberately left, each
measured on the live 119-file corpus rather than estimated.

### Three measured optimizations, none urgent

- `collections.Counter(terms)` for the term-count loop in `_lex_index`: **20.5 ms to 7.3 ms**,
  about 16% of `_lex_index`'s 80 ms. `Counter` is a `dict` subclass so every downstream use is
  unchanged. One line.
- `np.array(vecs) @ q` for the cosine loop: **3.82 ms to 0.070 ms**, 55x. numpy is already
  imported and the vectors are already lists. Immaterial for one CLI query, worth ~180 ms across
  a 48-evaluation bench run.
- `best_line` calls `_display_keys(MEMORY_DIRS)` once per printed result in `--vector-only`,
  where `lex` is None so the fallback fires for every row: 1 + k directory scans, ~5 ms. Hoist
  the map into `_retriever`'s return value if this code is touched anyway.

## From the 2026-09-14 post-install verification of 1.4.5

Found by testing the installed VSIX against the real memory store rather than the checkout.
Everything here is about the gap between what `memory/recall.py` can now do and what the
extension actually reaches for. None of it is a regression; all of it is capability that
shipped in the Python and was never wired into the product.

### `RECALL_MEMORY_DIRS` shipped in `recall.py` and the extension cannot reach it

Phase 5 of the hybrid-recall work added multi-corpus search: `RECALL_MEMORY_DIRS` extends the
primary store, deduped, with non-existent entries skipped, and `test/recall-py.sh` covers it in
five cases. The extension passes `RECALL_MEMORY_DIR` (singular) at all three of its invocation
sites, `extension.js:763` (`--rebuild`), `:806` (`--list` auto-sync) and `:2977`
(`--gates-compile`), and never passes the plural form anywhere.

`--gates-compile` is correct to stay single-dir and should not change. The other two are the
gap.

`memoryLint.discoverDirs` already finds every store: on this box it returns two,
`C--Anthropic/memory` and `d---ai-work/memory`. `pickPrimaryDir` then reduces them to one and
every consumer downstream sees only that. This is the same stranded corpus recorded earlier in
this file, seen from the product side: the extension can enumerate it, and has no way to search
or index it.

Needs a setting (`permissionWildcarding.memory.extraDirs`, or make the existing `memory.dir`
accept a list) plus passing it through at `:763` and `:806`. Note that `memory.dir` today is an
override that REPLACES discovery, so it cannot be widened without deciding which meaning wins.

### Three lint checks exist only in Python and never reach the card

`recall.py --lint` enforces the resident-entry ceiling (15 of 16 right now), flags
`type: feedback` entries with no `scope:` (3 of them, which the gate compiler cannot place), and
lists demotion candidates (2, about 455 bytes). None of these exist in `memoryLint.js`, and the
extension never shells out to `--lint` at all.

That is deliberate as far as it goes: `memoryLint.js`'s header states it is pure Node so it ships
in the VSIX and runs under the managed policy, with no Python and no model. The resident-entry
ceiling and the scope check need neither. They are counting rules over the same text the Node
lint already parses, so they can move without breaking that constraint. The demotion list is
judgement and should stay in the CLI.

## From the 2026-09-14 store-consolidation work

### Audit of 2026-09-14, two agents over the store-consolidation commits

Fixed in the follow-up commit: the silent `mdCount` zero, the pinned-`memory.dir` watcher
deletion, and the false short-circuit justification. These are what was measured and left.

Fixed 2026-09-14 on `bl-extension`, each with a mutation that named one test: the
`updateStatusBar` guard, the `showReport()` null dereference, the swallowing
`autoSyncRecallIfStale` catch, and all four dead export entries. Struck through as they are
closed; the notes stay because they name the reproduction.

`MTIME_TOLERANCE_MS` was the fourth, and it took two rounds. It was first HELD rather than
removed, with the written reason "a branch in flight adds the drift test that imports it". That
branch landed and the drift test it referred to does not import the name: it pins `recall.py`'s
source instead. The reason outlived its truth by one merge, which is the failure mode a HELD list
with written reasons is supposed to prevent and does not, because nothing re-checks the reason.
Export and HELD entry both removed 2026-09-14; the constant and its use in `entryMatchesFile`
are untouched.

**`refresh()` lints the primary `MEMORY.md` twice.** `memoryLint.refresh()` calls `fastLint` for
every discovered dir, primary included, then calls it again for the primary. Counted on the real
store, one `refresh()`: 3 `readdirSync`, 29 `existsSync`, 3 `readFileSync`, 2 `statSync`, of
which `MEMORY.md` is read twice and each of its 9 index links is probed twice. Keeping the
loop's result in a local is one line. `refresh()` runs every 5 minutes, on every `MEMORY.md`
save, on every editor activation of one, and 300 ms after every external write. Syscall counts
are deterministic and were counted, not timed; a timing claim needs the cold interleaved
protocol this file already mandates.

**`memoryReport()` now scans the primary directory twice, and the corpus three times.**
`pickPrimaryDir`'s `mdCount` scans it, then `fullReport` scans it again, then
`recallIndexStatus`'s `indexableMemories` scans it a third time. `readdirSync` per
`memoryReport()` went from 2 to 4 with the selection change. Threading the filename list from
`pickPrimaryDir` into `fullReport` removes one. Measure on `_push()` end to end, not on
`memoryReport()` alone, because `_push` is what a user waits on.

**~~`updateStatusBar`'s guard cannot be false.~~ FIXED.** It read `if (!statusBar) return;`, and
`statusBar` is assigned once at activation and set to `null` nowhere, including in
`deactivate()` where four other retainers are nulled. So after the first activation the
condition is false forever, including after VS Code has disposed the item. Every other
teardown-reachable path in that file checks `deactivated`; this one does not. Reachable only by
a watcher callback already dispatched when teardown lands. One word fixes it:
`if (deactivated || !statusBar) return;`.

**~~`showReport()` dereferences a value its sibling null-checks.~~ FIXED.** It called `fullReport(dir, conf)`
and immediately reads `r.memPath`. `fullReport` returns `null` whenever `fastLint` does, which is
any `readFileSync` failure. `refresh()` guards this correctly; `showReport()` does not. Nameable
input: `MEMORY.md` exists as a *directory*, so `discoverDirs`'s `existsSync` passes and the read
throws `EISDIR`. Also reachable via a permissions error or a Windows sharing violation. Surfaces
as an error notification from a palette command, not a crash.

**`MTIME_TOLERANCE_MS` is a cross-language constant that nothing pins.** `src/recall-index.js`
says "a drift test pins the two shared constants", and that is true of `MEMORY_INDEX_NAME` and
`RECALL_EMBED_ID`. `MTIME_TOLERANCE_MS` is a third, reconciling Python's `st_mtime` float
seconds against Node's `mtimeMs`, and its comment cites a measurement to justify its value.
Nothing imports it and nothing pins it, so if recall.py's mtime precision changes,
`entryMatchesFile` starts reporting false staleness and no test notices. The drift test that
would catch it already exists and already reads recall.py's source.

CLOSED 2026-09-14. `test/recall-index.test.js:184` is the drift pin, and it pins the right side:
it asserts `recall.py` still writes `"mtime": st.st_mtime` as float seconds, that `st_mtime_ns`
appears nowhere, and that the Python-side staleness comparison uses the unit it writes. Switching
`recall.py` to nanoseconds now fails a named test instead of silently making every file read as
changed. Its own comment records why the pre-existing round-trip test did not cover this: that
one asserts `stale === false`, which passes for any tolerance at or above the real drift, so it
pins the behaviour and says nothing about the value or the unit.

**~~Dead exports, re-measured.~~ THREE OF FOUR REMOVED 2026-09-14.** `fullReport` was genuinely
dead: its only two references outside its own file are comments. `pickPrimaryDir` and `fastLint`
are **test-only, not dead** (the earlier "no external consumer" note is partly refuted:
`pickPrimaryDir` gained six real test references and they are the mutation-killing assertions).
In `src/recall-index.js`, `readRecallIndex` and `MTIME_TOLERANCE_MS` had no importer at all.
`src/tool-learn.js` exported `MCP_TOOL`, which nothing imports, though the constant is live
inside the file. Removing export entries is free; removing the functions is not.

Removed: `fullReport`, `readRecallIndex`, `MCP_TOOL` and, on a second pass once its held reason
expired, `MTIME_TOLERANCE_MS` — export entry only, every function and constant kept.
`test/dead-exports.test.js` now enforces the whole distinction: a name is either
destructured from a require of its module somewhere, or listed in `HELD` with the reason in
writing. The test-only names carry that reason too, so they stop reading as oversights. It fires
on a re-added dead export and on a `HELD` entry that gained a real importer, both mutated.

**`discoverDirs` reads only `conf.dir`.** `enabled`, `lineBudget`, `totalBudget` and `maxLines`
are inert in every call. That means `memory.enabled: false` does not stop the two watcher sets
being built, which is a live inconsistency with `memoryCardData`, which does honour it.
Pre-existing, and teaching `discoverDirs` about `enabled` would be a behaviour change.

**~~`autoSyncRecallIfStale`'s outer catch discards everything.~~ FIXED.** Two corrections to the
original claim. `recallIndexStatus` is NOT a reachable thrower: src/recall-index.js is internally
try/caught at :33, :41 and :81. The reachable ones inside the same try are `memoryReport()`,
`recallStatus()` and `cfg()`. And it was not a one-shot: :1981 is a single timer, but `memBounce`
re-enters on every MEMORY.md write, so a deterministic throw recurred silently on every trigger
and a broken run logged identically to a working one. Now `console.error`s, the house style here.

### Four assertions that could not fail, three of them fixed

Proven by mutation, not by reading. Each had a comment naming the mutation it guarded, and each
survived that exact mutation.

**Fixed: `test/gates-stale.sh`, three of four assertions.** The shape
`lint | grep -q STALE && fail "..." || echo "ok: ..."` reports success for any `lint` that dies
or prints nothing: a pipeline masks Python's exit status and an `&&`/`||` list suppresses
`set -e`. Deleting `or not os.path.exists(GATES_OUT)` from `_gates_are_stale` left a
`FileNotFoundError` traceback in the output and the suite still printed ALL PASS. Only the
positive "drift detected" case could ever fire. This is the suite guarding the only drift check
the feature has.

Worth recording how the **first** repair also failed: capturing into a helper and piping the
helper into grep put `fail`'s `exit 1` inside a subshell, so the parent read grep's status and
the mutation survived again. The capture has to happen in the calling shell. Same trap, one level
down.

**Fixed: `test/recall-py.sh`, the bad-path case.** It ran `--lexical-only`, and `_retriever`
skips the dir-walking loop entirely for lexical mode, so the query exercised the one mode the
defect never touched. recall.py's own comment even says "`--lexical-only` kept working". Now
asserts on `MEMORY_DIRS` directly.

**Fixed: `test/recall-py.sh`, the extends-not-replaces case.** It asserted on `dup.md`, which
exists in **both** fixture corpora, so dropping the primary still left a file of that name in the
output. `only-here.md` is unique to the primary and is the only witness that can distinguish the
two behaviours.

**Fixed: `test/recall-py.sh`, the unknown-mode case.** `_retriever` calls `_check_mode` as its own
first statement, and `rank()` falls into `_retriever` whenever `idx is None`, so deleting the call
from `rank()` still raised. The probe now passes the parts so `_retriever` is never reached.

**Left: `test/recall-index.test.js`'s atomic-write pin** asserts `os.replace(tmp, INDEX_PATH)`
merely appears in the source. It still matches if the statement is wrapped in `if False:` or
hoisted above the `json.dump`. The assertion directly above it pins condition and order together
and is the shape to copy. This is the exact pattern the standing gates forbid.

**Left, honestly labelled rather than fixed:** the compile-stability case has one gate file in its
fixture, so removing `sorted()` cannot make it fail, and on NTFS directory entries come back
name-ordered anyway, which makes that `sorted()` effectively unmutatable on this platform. The
`.tmp` residue case also passes if `save_index` reverts to a plain in-place `json.dump`, which
creates no temp file at all; it fires only for "write tmp, forget `os.replace`". And the
400-char frontmatter precondition pins the file's SIZE (654 bytes) rather than the offset of
`scope:` (540), so shortening the padding would silence it while the precondition still passed.

### `bin/wildcard-perms` cannot forward `--gates-allow-empty`

It hardcodes `[recall, '--gates-compile']`. `recall.py --gates-compile --gates-allow-empty` works
directly, so there is a path, but not through the CLI wrapper or the extension. `--lint` now names
the direct command when the corpus compiles zero gates, which closes the loop a user could
otherwise get stuck in. Forwarding the flag properly is still the tidier fix.

### Measured and left, Python side

**`--lint` reads the whole corpus twice.** `lint()` opens every `.md` into `texts`, then
`_gates_are_stale()` calls `_compile_gates_text()`, which walks `os.listdir` and opens every `.md`
again. 123 files, 876,284 bytes, read twice per lint, and `--lint` runs from `verify-release.ps1`
and from the dashboard. Fix without losing the docstring's purity argument: give
`_compile_gates_text` an optional `texts` map and read only when it is `None`. Measure cold, fresh
interleaved processes, against the real `~/.claude` and not a temp HOME, n >= 40.

**`rank()` degrades silently on a partial parts tuple.** It refills only when
`idx is None or names is None`; `lex` is never checked. So `rank(q, mode="hybrid", idx=..., names=...)`
returns pure-vector ordering at half the score, and `mode="lexical"` with `lex=None` returns every
score as 0.0 in alphabetical order, which is the exact failure `_check_mode` was added to prevent,
reached through a different door. `gate_recall.py` passes all four today. One assert closes it.

**`INDEX_PATH` is confirmed vestigial.** Every read is of a function-local rebound inside
`load_index`/`save_index`. Nothing imports `recall.INDEX_PATH`. The shadowing is what makes a
reader believe the module constant is live.

**`rank_vec` and `rank_lex` do not mean the same thing.** One is guarded by a per-query dict
truthiness test, the other by per-document membership, so in hybrid mode a document with no cached
vector still gets a `rank_vec` while a document no query term touched correctly gets
`rank_lex = None`. If the fusion bench that justifies keeping these ever gets written, it will read
them as comparable.

**`_lex_index`'s list branch is live, not dead.** `gate_recall.py` is the sole caller that passes a
list, and it resolves names against the module-global `MEMORY_DIR` rather than the directory the
names came from. Harmless only because that bench is single-corpus by construction.

**Fixed: `verify-release.ps1` could not see `--gates refresh` failing.** It captured stdout only,
and the compile-failure warning goes to stderr, so the check "refresh is silent when nothing
changed" passed in exactly the steady state where refresh is printing an error every time. It now
captures `2>&1 | Out-String` (the idiom already used for the installer suite on line 144) and
asserts `$LASTEXITCODE` alongside the text, so a refresh that fails silently on stdout is caught
too. Measured against a stub that reproduces `bin/wildcard-perms:635` (stderr warning, exit 0):
under both PowerShell 7.6.5 and Windows PowerShell 5.1 the old form captured 0 characters and
would have printed PASS, the new form captures the warning and fails, and a healthy refresh stays
silent. 5.1 wraps it in a `NativeCommandError` record, so the FAIL detail is wordier there; the
verdict is the same. The script itself is still unrun by any test, and cannot be: it writes to the
real `~/.claude`. Its negative `--lint` checks also all pass on empty output; they are covered only
because a positive check runs first, and that ordering is load-bearing and undocumented.

**Two in-tree figures for the same ONNX session construction disagree by 3x.** `recall.py` says
"~620 ms (measured on this box)" and `test/recall-index.test.js` says "~210 ms each". Neither names
its method. One is stale.

## From the 2026-09-14 post-merge audit of `d5d3b85..8cc7fbe`

One agent read the whole seven-branch diff, ran the suite, and built a 37-mutation harness over a
copy of the tree. 32 of 37 fired. Everything below was measured on this box that day.

### Re-filed: four records the BACKLOG split dropped

Two headings were classified closed while carrying bullets that were not. `### Interesting,
off-axis` had seven bullets, four of which were fixed that day. `### Two unvalidated external
inputs reach a policy or instruction file` had two, one of which was fixed. The other four are in
neither new file and their code is unchanged. All four re-verified against current code before
re-filing.

The lesson is about the check, not the split: a heading-level count reconciles whether or not the
bullets inside a heading were all closed, so it cannot detect this class at all. The first pass of
the follow-up check missed it a second way. It counted sub-items with `^\*\*`, which matches this
file's bold-paragraph style but not its `- **bold list item**` style, and so found ZERO of the
seven bullets in the section it was written to examine. A degenerate axis in the detector, exactly
the failure the differential-test gate describes. The corrected pattern is
`^(?:[-*]\s+)?\*\*`, and it flagged both headings immediately.

**Project `settings.local.json` is promoted to user scope with no trust gate on the CLI path.**
`bin/wildcard-perms:348-351` takes `cwd` from the hook's stdin JSON, `:332-333` tests that project
for `.claude/settings.local.json`, and `:340` calls `drainUnderLock(cwd)`, which promotes that
project's local allow entries into USER-scope allow on the next tool call and announces it with one
stderr line at `:399-402`, on a path that is quiet by design. The gate is `PROMOTABLE` at
`src/local-settings.js:56`, which tests PORTABILITY, never provenance: a repo that commits
`.claude/settings.local.json` containing `Bash(curl *)`, `Bash(python *)` or `Bash(node *)` clears
it and lands in the user's global allow list. The extension refuses exactly this for an untrusted
workspace (`vscode-extension/extension.js:2631-2634`, "an untrusted window reads but never
writes", plus `:909` and `:2669`); the CLI has no equivalent, and VS Code trust has no CLI
analogue. May be inherent to a CLI, but it deserves a decision rather than an accident. This is the
highest-consequence item in this section.

The sibling bullet under that heading IS closed and should not be re-raised: managed rule text now
gets `clean()` at the table (`src/auto-learn-manager.js:1129`) and `cleanRule()` at the
interpolation (`src/derived-guidance.js:51`, exported at `:357`).

The three from `Interesting, off-axis`:

**A bare `~` in `backupMirrorPath` resolves to the home directory itself.** `mirrorBackupPath()` at
`vscode-extension/extension.js:204-206` does `path.join(os.homedir(), raw.slice(1).replace(/^[\\/]+/, ''))`.
For `~` alone that is `path.join(home, '')`, so the mirror write targets a directory, fails EISDIR,
and the failure is swallowed. Every other `~`-prefixed value is handled correctly; only the bare
one degenerates.

**`auto-mode-audit.js` claims it runs with no credentials, and does not.** `scripts/auto-mode-audit.js:77`
passes `env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }`. That redirects the config directory,
not credentials, so with `ANTHROPIC_API_KEY` set in the environment the probe authenticates and makes
a real API call. The header at `scripts/auto-mode-audit.js:14` promises the opposite: "with no
credentials the run stops at Not logged in". The BOM half of this bullet was fixed at
`scripts/auto-mode-audit.js:52`; the credentials half, an unguarded `JSON.parse`, and a module-level
`args` read were all dropped with the heading.

**Two stat-keyed caches can still return a stale verdict.** `policyFingerprint` at
`src/auto-learn-manager.js:916` and `autoLearnStateStamp` at `vscode-extension/extension.js:1047`
both key on `${stat.mtimeMs}:${stat.size}`. A same-size in-place rewrite inside timestamp
granularity is invisible to both. Accepted when written; still true.

### Small, confirmed, not worth acting on alone

**`managedClaude` keys are permissions now, but the normaliser caps keys at 512.**
`src/auto-learn-manager.js:1568` re-keyed `nextManagedClaude` by permission. The normaliser at
`:268-276` applies `clean(key, 512)` to keys and `clean(permission, 768)` to values, so a permission
between 513 and 768 characters, legal everywhere else in that file, has its key truncated on the
round trip, and two sharing a 512-character prefix collide onto one key and lose a value. No
realistic input reaches it: a 512-character `WebFetch(domain:...)` is the only shape that gets there,
and both consumers take `Object.values` (`:1918-1919` are the only readers), so nothing else breaks.
Note it if the cap is ever touched.

**`state.codexTargets` has no eviction, and the new prune made it marginally worse.** One 16-hex-keyed
record is added per Codex target at `src/auto-learn-manager.js:968` and `:1622`, and nothing deletes
one. `pruneGrantKeys` at `:788-791` now empties the `applied` and `reviewed` lists inside an obsolete
record but leaves the record, so an abandoned target becomes a permanently retained
`{applied: [], reviewed: []}` of roughly 50 bytes. Every other axis is capped (candidates 1000,
pruned 2000, cursors 5000, observation hashes 20000, managed hits 200). Two lines if anyone is
already in `pruneGrantKeys`: delete a record whose two lists both emptied.

**`src/permissions.js:68`'s `if (lastErr)` cannot be false.** The only ways out of the retry loop
without returning are exhausting `MAX_ATTEMPTS` or breaking on a non-retryable code, and both assign
`lastErr` at `:50`. So the guard is dead and the `process.emitWarning` always fires when the fallback
is reached. Behaviour is right and preserving the cause is a genuine improvement over discarding it,
but mutating the guard to `if (false)` leaves the suite at 517/515/0: nothing anywhere asserts the
warning exists. Either assert it or drop the guard, so the code stops implying a
false branch exists.

**`MIN_SUPPORTED_VERSION` cannot change an outcome.** Mutating the check at
`src/auto-learn-manager.js:62` to `if (false) return null` left the suite green, because any
`from < VERSION` also falls out of the `while` loop at `:66-70` on a missing migration step and
returns null anyway. Two paths, one reachable. The test named for it at
`test/auto-learn-state-hygiene.test.js:76` passes for the other reason. The adjacent
`STATE_MIGRATIONS = new Map()` at `:47` is honestly documented as empty and unreachable today; this
one is not documented at all.

### New behaviour with no coverage

**`candidateFingerprint` records `permissions` and nothing asserts it.**
`src/auto-learn-manager.js:128`, inside `candidateFingerprint` at `:123`, adds
`permissions: item.permissions` with a comment explaining that a family which gained a second
spelling is a different grant from the one a human approved. Deleting the line leaves the suite at
517/515/0, identical to baseline.

**`src/auto-learn.js:909-912`'s `candidate.claudePermission` ternary is belt and braces.** Mutating
it to always-true leaves the suite at 517/515/0: `normalizePermissionSpelling(null)` returns `''`
and the filter below drops everything regardless. Not a bug.
`test/auto-learn-spellings.test.js:82-95` does not discriminate it, so the guard could be deleted
tomorrow with no signal.

All four survived mutations in this section were re-run independently in a detached worktree after
the audit reported them, because the audit's citation for the first one pointed at
`src/auto-learn-manager.js:1553`, which is `const parent = current.find(...)` in an unrelated
function. The FINDINGS were all correct; one line number was not. Deleting that line would have
been a syntax error rather than a green run, so the number was mis-transcribed into the report
rather than mis-measured.

### The same silent-gate-skip exists through a second door

Fixing `--lint`'s gate predicate closed the unpaired-marker case. The sibling case is still open
and was found while fixing it.

`lint()` builds its `no_gate` list from `stems`, which includes `MEMORY`, and it does not apply
`EXCLUDE`. `_compile_gates_text()` skips `MEMORY.md` unconditionally. So a `MEMORY.md` carrying
`scope: global` frontmatter AND a correctly paired gate block would compile nothing, and `--lint`
would once again say nothing about it: exactly the class of silent skip that was just fixed,
reached by a different route. `vscode-extension/memoryLint.js` already excludes the index for this
reason, and records it as its divergence #3, so the three implementations are two-for-three in
agreement rather than three-for-three.

No live corpus hits it today, because no `MEMORY.md` here carries frontmatter at all. That is a
property of the current data, not a property of the code, and the file is user-edited.

### A pre-existing frontmatter hazard, now written down

**`_fm` matches an indented `scope:` under any other frontmatter key.** The regex is `^\s*scope:`, so
`scope: global` nested under `metadata:` compiles a gate nobody declared at the top level. The new
Python fixture that writes `$GATED/g.md`, at `test/recall-py.sh:325-333`, uses exactly that
shape and passes for the right
reason, but it documents an accident rather than a decision. Pre-existing, not from this work, and
that fixture is currently the only place it is recorded.

### What is left of the `file:line` rot, after the 2026-09-14 correction pass

The pass is done and most of this is closed. Measured rates, the checker bug it uncovered and
the rule about what a STALE verdict is worth are in `docs/engineering-record.md`; only the
residue belongs here.

`node scripts/check-line-refs.js` now reports **162 references: OK 107, NEAR 15, STALE 23,
UNVERIFIABLE 17, 0 BROKEN**, against OK 39 / STALE 60 / UNVERIFIABLE 47 before.

**Not all 40 remaining rows are defects, and a future pass should not treat them as a worklist.**
Every one was read against its target during the pass. Three known-good categories:

- References the checker misjudges because its anchor comes from a neighbouring clause.
  The lazy-require NOTE about `require.cache` at `bin/wildcard-perms:11-26` is the standing
  example, cited correctly from two places and reported STALE from both.
- One deliberate STALE in `docs/engineering-record.md`, which cites where a retracted figure was
  WRONGLY said to live and then corrects it. Making it verifiable would destroy the point.
- Three references to code that was DELETED rather than moved, so there is no line to point at:
  the two dead webview switch arms, whose removal the comment naming `autoLearnApply` at
  `test/dashboard-view.test.js:300` records, and `readAllow`, which no longer exists anywhere
  in the extension.

What is genuinely open:

- **The residual UNVERIFIABLE rows are prose that never names anything literal.** Each can be
  made checkable by quoting the identifier that actually sits at the cited line, which is what
  converted 13 rows to OK during the pass. Worth doing opportunistically when a sentence is being
  edited anyway, not as a sweep.
- **Five entries elsewhere in this file look closed by current code** and, under this file's own
  "closed items are removed" rule, want deleting rather than renumbering. `src/agent-guidance.js`
  now computes a mid-file `separator` and `escapeMarker` guards `blockRange` against a body
  carrying its own END marker, which refutes both halves of the managed-block fusion entry;
  `src/local-settings.js` documents the Set plus shared index as landed while the perf bullet
  still calls `grantedBy` linear; and the `list()` fallback named in the `manager.getStatus()`
  bullet is gone.
- **One bullet is refuted, not stale.** It claimed `bin/wildcard-perms` had no `return` on a
  `finish()` call. Line 282 now reads
  `if (!settings || typeof settings !== 'object') return finish(input, false);`.

### CI is running on borrowed time: the pinned actions target a deprecated Node

Every job on the 1.4.10 run (34928599078, all five green) carried the same annotation:

> Node.js 20 is deprecated. The following actions target Node.js 20 but are being forced to run
> on Node.js 24: `actions/checkout@v4`, `actions/setup-node@v4`.

"Forced to run on" is GitHub bridging it for now, not a stable arrangement. When the bridge is
withdrawn both actions stop, and they are the first two steps of all five jobs, so the failure
mode is the whole matrix at once rather than one test. Bump both to `@v5`. Unrelated to the
`engines` floor moving 18 to 20 in `package.json`, which is about the runtime the package
supports and is already satisfied by every matrix leg.

### Optimization proposals, each with the measurement that would settle it

No numbers asserted. This repo's rule is that a figure is real only when measured cold, in fresh
interleaved processes, against a purpose-built variant with the change removed.

**The `numpy` matmul at `memory/recall.py:624-630`** replaced a Python dot product per document. Its
own comment says "Immaterial for one CLI query, real across a bench run", which is the honest
framing. To settle: run `memory/bench/gate_recall.py` cold in fresh interleaved processes against a
variant with the matmul reverted, over the 24-question set, and report the per-query MEDIAN. The
~620 ms ONNX session dominates the total and would swamp the signal.

**`counts = Counter(terms)` at `memory/recall.py:482-484`** is almost certainly unmeasurable end to end on a 123-file
corpus. What would prove otherwise: `_lex_index` alone, timed in fresh processes over a synthetic
corpus ten times the size, with the hand-rolled loop restored in the comparison variant. Low value.

**`src/permissions.js:52`'s "no sleep after the last attempt"** removes up to 200 ms from a 1.1 s
worst case. The saving is real by construction; the open question is whether the path is ever
reached. Fault-injection measurement: stub `fs.renameSync` to throw `EBUSY` unconditionally and time
`writeFileAtomicSync` to completion, both variants, cold. The answer belongs in
`docs/engineering-record.md`.
