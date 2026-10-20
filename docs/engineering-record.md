# Engineering record

What this project already decided, measured, or disproved. **Not a queue.** Open work lives
in `BACKLOG.md`; this file exists so a later session does not re-derive an answer,
or re-propose something already refuted with evidence.

MAX modes were removed from the product in the post-1.5.1 work. References below
are retained as historical incident evidence, not as descriptions of current
commands or supported behavior.

Split out of `BACKLOG.md` on 2026-09-14, when that file had reached 2,509 lines.
Its own preamble said closed items are removed since git holds the history, and that had
never once been practised: measured across twelve commits the file only ever grew. That pass
deleted 34 closed entries, moved 27 here, and left 36 genuinely open ones behind.

Four kinds of thing are here, and the distinction matters:

- **Refuted.** Built, measured, and found not to work. The `Refuted optimizations`
  section is explicitly a do-not-retry list.
- **Retracted.** Figures published in this repo and later found wrong, sometimes with the
  sign reversed. Read the correction, not the original.
- **Constraints.** Facts that decide how a future change must be shaped, such as what
  `runWildcarding`'s lock actually guarantees, or where an fs measurement is valid.
- **Standing decisions.** Calls the maintainer made deliberately. Not debt, and not to be
  reopened without asking.

The measurement protocol this project holds itself to, stated here because it is the rule
most often broken: **a performance figure is only real measured cold, in fresh interleaved
processes, against a purpose-built variant with the change removed.** Every figure here that
was not taken that way turned out to be wrong. The end-to-end noise floor for a ~60 ms spawn
on this machine is roughly +/-2 ms min and +/-5 ms p50, so any in-process saving under ~2 ms
is unmeasurable at the process level.

---

## The two memory cards: one layout, two rows (2026-10-19)

**SHIPPED** in 1.8.0, at the user's request: "they should both read the same". The user chose the
layout.

**Two rows, not one, and why.** The memories really are different, and the code keeps them
apart on purpose.
- **Ownership.** Claude memory is a folder the user and Claude curate, and AI Acolyte compiles
  gates from it. Codex memory is written by Codex itself, and this extension only reads it.
- **Separate indexes.** `src/codex-recall.js` keeps Codex's passages independent of Claude's
  directory index, so a search of one agent's memory never returns the other's.
- **The user's choice.** The user picked two matching rows over one combined row, keeping each
  collapsed badge per agent.

**What each card gained.** Both now run top to bottom: the CPU model line, the folder, four
figures, an issues line, Search / Rebuild / Inspect, a gates line with Review, and the agent's
version.
- **Claude memory:**
  - **Search** runs `recall.py --json` (new), opening a result at the line of its best excerpt.
    It covers the store the card shows, with the model when it is installed. Without one it falls
    back to keywords and says so, as the Codex search does.
  - **Inspect memory sources** lists every store found. Claude keeps one per project.
  - **A gates line** opens the existing gates panel.
  - **The Claude Code version** comes from `defaultBinary`, in 0.8 ms.
- **Codex memory:**
  - **The CPU model line** is the same status, on purpose. Codex search is handed the same Python
    and model (`codexRecallOptions`).
  - **The figures** are its summary's tokens and lines, the file count, and its index's passage
    count. The passage count is memoised on the cache file's identity, and is "–" until an index
    exists.
  - **An issues line** opens the Codex report.

**The Codex per-session figure is measured, not assumed.** It is `memory_summary.md`, which a fresh
Codex session loads when memory use is on (`scripts/check-codex-memory-runtime.js`, "enabled summary
use"). Whether memory use is on is still not inferred, and the hover says so.

**Measured live.** Claude memory search took 1.6 s in hybrid mode over 58 memories, and the right
memory came first, at its line.

**Evidence.**
- **Tests:** `test/claude-memory-ui.test.js`, a `recall-py.sh` case for `--json`, and dashboard
  tests. The dashboard tests hold both cards' parts in one shared order and the model line's
  wording identical.
- **Census tests:** a sixth `execFile` site is counted, tree-killed, with a 120 s deadline.

## Rule use and agent sessions, from AgentFlow (2026-10-16)

**SHIPPED** in 1.7.0. These are the two of AgentFlow's features (desktop-ai-companion) that the
maintainer chose to bring in. The others were assessed and declined; see the last paragraph.

### Rule use (`src/rule-usage.js`)

The Saved permissions card counts how often each Claude allow rule covered a call, and offers
the rules with no use found for review through the shared picker (filter `no-use`). Each removal
is still confirmed one at a time.

**A full pass over all history, against the current rules; not a counter in the Auto Learn scan.**
Auto Learn's state is partitioned per workspace, and it filters observations to the open folder
(`autoLearnConfig`'s `workspaceRoot`), while the allow list is global. A counter kept there would
have seen one project's calls, and a rule used daily elsewhere would have read as unused. That is
the one wrong answer this feature must not give, because its answer is "consider deleting this".
A pass also judges each rule as it is now, so a freshly folded rule is credited with the calls
it covers, and no first-seen date is needed.

**Measured on the development box (2026-10-16):**
- **History:** 893 transcripts, 1,880,002,028 bytes, 81,838 finished calls since 2026-08-07.
- **Cost:** the pass takes 10.6 s.
- **Matching:** naive matching was 29.9 s for 239,100 segments against about 254 rules each.
  The index (tool and first word) removes almost all of that.
- **Index exactness:** across 37,833 probes sampled from the real corpus, the index disagreed with
  a full `coversPermission` scan 0 times. `test/rule-usage.test.js` holds it to a full scan on a
  corpus that includes `timeout 5 rg` (Claude's strip) and `xargs`.
- **Result for the user's 526-rule list:** 261 used, 257 with no use found, 8 not tracked. The
  most used was `Bash(cd *)`, at 34,624 calls.

**Crediting rules:**
- Only finished calls count.
- Each call credits every allow rule that covers one of its probes, at most once per call.
- **Any segment counts.** A rule that covered one segment of a compound command is credited even
  when another segment prompted. This is the conservative direction for a list of deletion
  candidates.
- **A deny or ask rule takes the credit** for any probe it covers, whether the user's or the
  managed policy's (`remote-settings.json`).
- **Codex is not counted:** it obeys its own rules files.
- **Not tracked:** Skill rules, and file rules with a path specifier. A file observation carries no
  path by design, so only a bare `Edit` or `Write` can be credited.

**Wording.** The card says "no use FOUND", never "unused". Sessions that keep no transcript
(`claude -p --no-session-persistence`, which ai-platform uses, and the SDK) are invisible, and so
is history Claude has already cleaned up. The hover says both.

**Privacy.** Results are stored in `~/.claude/wildcarding/rule-usage.json`, keyed by a hash of the
normalized rule. No rule text, command or path is stored.

**Its own thread, not the Auto Learn queue.**
- The pass runs as `countOffThread`, the pattern of `src/claude-strip-model.js`. On the Auto Learn
  queue its ~10 s would have held every scan, apply and undo.
- That runner also drains each job at teardown, because a manager job may sit between two policy
  writes. This pass writes nothing on its thread, so `deactivate()` terminates it.

**A timer starts it, not the push.**
- It first looks two minutes after activation, then every fifteen minutes.
- It counts when no result exists, when the result is over a day old, or when the list has
  changed. Counts are never closer than ten minutes apart.
- A push that started passes would have put a thread behind every dashboard test, with a late
  second push landing under whatever that test asserted next.

### Agent sessions (`src/agent-sessions.js`)

**What the card shows.** It lists the Claude and Codex sessions that wrote a transcript in the last
fifteen minutes: the agent, the app, the folder name, the mode when recorded, the last activity
and the active subagents.

**How it reads them.**
- **From transcripts only,** so it sees every app and needs nothing switched on.
- **The app** comes from an allowlist of `entrypoint` / `originator` values; an unlisted value
  reads "other".
- **The project is the folder name only.** Nothing is persisted.
- **One look costs 68-88 ms** on the box, as async stats plus a short read of each active file.

**No "waiting" column (DECLINED, measured).** A transcript cannot say whether a panel waits on a
prompt. Inferring it from a stalled call is about 0.4% precise outside Claude's default mode
(AgentFlow's BlockedDetector measurement), and the box runs auto mode.

**The mode is opportunistic.** Measured on this session: its last `permissionMode` record was
13 MB from the end, and the VS Code panel's prompts since carry none. So the card reads back up to
4 MB and keeps a mode an earlier read found.

**Redraw rules.**
- A look pushes on a change, and on the minute tick while any session is listed.
- The ages are drawn by those pushes, not by a timer in the webview. The tests run that script
  in-process, where an interval would keep the runner alive.

### Evidence

- **Tests:** `test/rule-usage.test.js` and `test/agent-sessions.test.js`, plus dashboard and picker
  tests.
- **Mutants:** twelve were run and all twelve were killed. They covered the stripped-form index,
  deny/ask, any-segment crediting, the capped multi-pass read, per-file dedupe, Skill tracking, the
  subagent rollup, mode carry-forward, folder-name privacy, both payload fields and the filter.

### AgentFlow features not brought in (DECLINED, 2026-10-16, the maintainer's choice)

**Pressing the approve button.** It needs VS Code's unauthenticated debug port, which lets any
local process drive the editor. It presses any recognised card whatever the ask rules or the
managed policy say, which conflicts with this extension never bypassing policy. And it depends on
the panel's markup (AgentFlow's BUG-006/007/008).

**Session-limit reading and pause & resume.** The usage percentage exists only inside the panel. No
hook carries it, and the status line does not run in the panel. Claude Code's own
`quota_auto_resume_*` notifications suggest a native resume.

**On-screen prompt and panel states.** These need the debug port too. Claude Code 2.1.301
publishes no command to read them.

**The `PermissionRequest` hook.** A hook that answers from the rules approved 0 of 1,076 dialogs
(branch `feature/permission-request-hook`). The work login's managed policy also sets
`allowManagedHooksOnly`, under which user hooks do not run.

## Codex compresses idle rollouts to `.jsonl.zst` (2026-10-16)

**FIXED** in 1.6.8. The dashboard read "scan degraded" again three days after the archived-thread fix.
The probe named five Codex threads "with no rollout file", and its notes called four archived threads
"deleted archives".

**What changed on disk.** Measured on the development box with 17 threads:
- **Which files.** Nine rollouts had become `rollout-<ts>-<uuid>.jsonl.zst`: five in
  `sessions/YYYY/MM/DD/` and all four in `archived_sessions/`. The four had still been `.jsonl` when
  they were measured on 10-13.
- **When.** Every compressed rollout was last written eight or more days earlier, and every plain one
  within three. A plain rollout created on 10-02 was still being written on 10-14, so the trigger
  looks like idle time, not creation date. That is inferred, not documented by Codex.
- **Format.** Each file is a single zstd frame whose header declares its decompressed size.
- **Codex's records.**
  - `state_5.sqlite` `threads.rollout_path` still names the `.jsonl`.
  - The history store's `next_rollout_byte_offset` equals the decompressed size for all nine.
  - Against the on-disk size, all nine would read as "store ahead of its transcript".
- **Cost.** The largest decompresses to 170,042,613 bytes in 0.5 s.

**The fix.** It has three parts.
- **Walks.** Both walks (`findJsonlFiles`, `rolloutIndex`) take `.jsonl.zst`.
- **Reader.** It decompresses the whole file and serves the bytes through `readRange`, so cursor,
  ingest cap, append, reconcile and head seed run unchanged in decompressed space.
  - **Identity.** The parse is given the `.jsonl` name, so a call with no call id keeps its synthetic
    id across compression.
  - **Unchanged files.** A file whose declared size and mtime match its cursor reads as unchanged
    without decompressing.
  - **Twins.** A `.zst` beside its plain twin is left alone.
- **Probe.**
  - A `.zst` beside a state row's `.jsonl` counts as the recorded file.
  - The projection check compares against the decompressed length (`transcriptLength`).

**Two decoder facts the design rests on**, measured on Node 24.19.0. `zstdDecompressSync`:
- returns only the first frame of a multi-frame file, as if it were the whole file;
- given a file cut in half, returns a short buffer (0 of 300,000 bytes) without an error.

Either case would have been read as a complete transcript, and its cursor would then skip the rest for
good. So `zstdFrames` walks the frame and block headers (RFC 8878) first. A file that is not a whole
number of complete frames is an unreadable file (trouble). The frames are decoded one at a time, and
the probe double-checks a declared size that falls short of the cursor by decompressing.

**Standing decisions in this change:**
- **Not read is a note, never trouble.** This covers a runtime without zstd (before Node 22.15.0;
  CI's Node 20 leg) and a file over 256 MB decompressed. It is the user's call of 2026-10-16 for the
  first case, extended to the second for the same reason: the same answer comes back on every scan,
  and it is not a fault in the data.
  - The cursor is carried forward, so a runtime that can read the file resumes it.
  - Neither case holds a Codex evidence rebuild open; holding it would block auto-safe for good.
  - A file over the ceiling is not trouble partly because Codex compresses only an idle rollout, which
    a running reader has already consumed while it was plain. A fresh install over old compressed
    history is the case that loses evidence, and it is said on the card.
- **The ceiling is the widened read's 256 MiB** (`COMPRESSED_MAX_BYTES`), so no compressed transcript
  costs more memory than the worst plain read.
- **Each catch-up scan decompresses again.** A compressed file over the 64 MiB ingest cap catches up
  over several scans, as a plain one does. The 170 MB file is three scans of about 0.5 s each, measured
  on the real corpus: 1,582, 1,424 and 459 ms, then 12 ms once unchanged.
- **The first scan after compression re-reads the file.** It has a new path and so no cursor. The
  re-read is deduped by `observationHashes`, as an archive move is, and an end-to-end test pins
  `counts.success` unchanged.

**Evidence.**
- **Tests.** `test/codex-compressed-rollouts.test.js` has 17 tests; the frames they need are built by
  hand from raw and RLE blocks, so they run without a compressor. The decoder tests skip, with a
  stated reason, where Node has no zstd.
- **Mutants.** Eight were run, one for each piece of the fix: the walk, the identity name, the frame
  walk, the projection length, the unchanged fast path, the twin dedupe, the recorded twin and the
  carried cursor. All eight were killed.
- **Live probe.** Against the real `~/.codex`, it went from `stale: true` (5 orphans) to
  `stale: false`, with 17 of 17 threads accounted for, no projection ahead, in 34 ms.

**A side fix: `--fix-anchored` now uses the diff when an anchor is ambiguous.** This change inserted
blocks above much-cited identifiers (`autoLearnBusy` occurs on seven lines of `extension.js`). The
fixer then repointed 12 citations and refused 60 as ambiguous, because it acts only when an anchor
occurs on exactly one line.
- **The new rule.** A citation that was right at HEAD is now carried through `git diff HEAD` to where
  its line is now, with both ends of a range mapped. That is the same exactness by another route: the
  author's citation was correct, and the hunk headers say where that line went.
- **Still left for a person:** a citation already wrong at HEAD, one whose cited line was itself
  edited, and any file with no HEAD.
- **Result.** All 60 were placed, and 289 of 289 anchored references are OK.
- **Tests.** Two in `test/line-refs.test.js`, which include both controls. Two mutants were run, the
  tie-break disabled and an edited line mapped instead of refused, and both were killed.

## Decided 2026-10-15: the live hook runs a pinned release copy, asynchronously

The v1.6.2 audit left two decisions to the maintainer. Both were taken on 2026-10-15, and both are **DONE**.

| Decision | Disposition | Evidence |
|---|---|---|
| The live hook ran the development checkout, so every edit, branch switch or mutation run changed the code the next real tool call ran | **DONE**: the hook runs a detached worktree pinned to a release tag | The worktree was created at `v1.6.6` and moved to `v1.6.7` once that release was published; this was the release step's first use, and the README's "Build, test, release" section has the step. The hook was repointed through the compare-and-swap settings writer by a maintainer one-off script, outside the repo. Before and after the change, every field of `settings.json` except `hooks` compared identical, the 831 allow entries included. |
| The live registration lacked `"async": true` | **DONE**, applied in the same write | Claude Code no longer waits about 0.35–0.57 s for the hook on each Bash or PowerShell call. A pass killed at a `claude -p` teardown cannot empty `settings.json`, because the hook never writes in place (wave-f8); it is redone on the next call. |

## Workspace settings may only tighten (2026-10-15)

**FIXED**, `ea1fabe`. This is the maintainer's decision of 2026-10-15 (wave-d1, on `29a2cc1`). It
closes the four CANDIDATE rows of "The settings census behind S2", below.

**The hole.** `autoLearn.mode`, `autoLearn.successThreshold`, `autoLearn.codexScope` and
`localDrain.enabled` were window-scoped and read with `get()`, so a workspace value won. A
repository's `.vscode/settings.json` could do four things:
- set `auto-safe`, so every scan applied grants to `~/.claude/settings.json` and `~/.codex/rules`
  with no modal;
- lower the threshold to 1;
- turn Codex export back on for a user who chose `off`;
- turn the drain back on for a user who turned it off.

The grants still came only from the user's own history, through the auto-safe classifier, so a
repository could not inject a rule. But it could opt the user into unattended writes to global
files.

**The rule.** A workspace or folder value may make each key stricter than the user's own setting,
never looser.
- **Where.** `vscode-extension/extension.js:1375#tightenOnlySetting` applies it, over the table at
  `vscode-extension/extension.js:1335#TIGHTEN_ONLY`. `autoLearnConfig` reads the mode, threshold
  and scope through it, and `vscode-extension/extension.js:3946#localDrainEnabled` reads the drain.
- **The user tier** is `inspect().globalValue`. When it is unset or invalid, the manifest default
  is the bar.
- **The effective value** is the strictest of three things: the user tier, every workspace and
  folder value no looser than it, and the merged `get()`.
- **Strictness:**
  - mode: `observe` is stricter than `recommend`, which is stricter than `auto-safe`;
  - threshold: higher is stricter, floored at 1 as before;
  - scope: `off` and the withdrawn `workspace` rank together above `user`, because neither writes
    a rule;
  - drain: off is stricter than on.
- **Every tier is a cap**, not VS Code's precedence order. With a user `recommend`, a workspace
  `observe` and a folder `recommend`, the result is `observe`, where VS Code's own merge would give
  the folder's `recommend`.
- **Why `get()` is in the set.** In VS Code it is already one of those tiers, and it can only
  tighten the result. So a configuration without `inspect()` (several test harnesses) is held to
  the user tier as well. A harness that sets `codexScope: off` or `localDrain.enabled: false`
  through `get()` alone keeps working, and one that sets `auto-safe` that way now gets `recommend`.
- **Why not machine scope**, as S2 used. A stricter per-project choice (`observe` in one
  repository, a higher bar, export off) is worth keeping, and machine scope would discard it.

**Visibility.** A value that would loosen a key is ignored. It gets one line in the Acolyte output
channel, never a notification:

`[<time>] Settings: workspace setting autoLearn.mode=auto-safe ignored: a workspace may only lower the mode (user setting: recommend).`

When the user set nothing, the line ends "(user setting: recommend, the default)". It is written
once per distinct line per activation: `looserSettingsNoted` is cleared in activate, as
`warnedOnce` is (`vscode-extension/extension.js:3112#looserSettingsNoted`). That Set is not
decoration. With it removed, two scans in one window printed the line 10 times, because
`autoLearnConfig` runs on every scan and every refresh.

**The mode toggle** (`vscode-extension/extension.js:2103#cycleAutoLearnMode`, the Cycle mode
command).
- **A step above the user's own mode** writes user settings, so raising is always the user's own
  setting. Its auto-safe confirm says "in your user settings, for every workspace that does not
  lower it".
- **The removal.** A raise also removes a folder or workspace value below the new mode
  (`vscode-extension/extension.js:2127#removed`). Such a value can only equal the old user
  setting, or the step would not have been a raise. Left in place, it would still cap the mode in
  this window, and the toast would report a mode the window did not get.
- **Any other step** writes as before: the folder tier, else the workspace tier when one holds a
  value, else user settings.
- **The toast names the tier**, as in "Auto Learn mode: observe, saved in this workspace's
  settings."

**Residuals.**
- A workspace can no longer raise the mode for one repository. A user who wants auto-safe in one
  repository alone must set it at the user tier and lower it everywhere else. That is the decision,
  not a gap.
- A raise through the toggle changes the user tier, so it reaches every workspace that does not
  lower it. Its confirm and its toast both say so.
- A raise's removal edits the repository's `.vscode/settings.json`, which the old toggle also
  wrote.
- The learner persists the mode each scan is handed. That is now the effective mode.
- A release before this one still honours a workspace raise from the same settings file.

**Tests.** `test/workspace-tighten-only.test.js` drives the real extension over a temp home. Its
configuration answers tier by tier and writes back the tier `update()` names, and its scripted
worker records what each scan is handed. Every mutation below was applied alone, the file was run
once, and extension.js was restored and checked by hash.
- **The whole fix reverted** (`29a2cc1`'s extension.js): 6 of 7 tests fail.
- **"with nothing set, … keep their defaults"** is the control, so it passes with the fix reverted
  by design. It fails with the mode fallback changed to `observe` or the threshold fallback changed
  to 1.
- **"a workspace auto-safe over a user recommend is ignored, with one output line"** fails with
  `get()` for the mode, the dedupe dropped, or the mode fallback changed.
- **"a workspace observe under a user recommend takes effect, and a folder cannot raise it back"**
  fails with `get()` for the mode (its folder case), or with the user tier alone returned (the
  machine-scope reading).
- **"a workspace threshold below the user's is ignored, and one above it takes effect"** fails with
  `get()` for the threshold, the user tier alone, or the threshold fallback changed.
- **"the mode toggle writes user settings to raise the mode, and the workspace tier to lower it"**
  fails with:
  - the old `cycleAutoLearnMode` restored whole;
  - only the old target choice restored;
  - the removal skipped;
  - user settings always written;
  - `get()` for the mode.
- **"a workspace may turn Codex rule export off, never back on…"** fails with `get()` for the
  scope, or the user tier alone.
- **"a workspace may turn the automatic drain off, never back on…"** fails with `get()` for the
  drain, or the user tier alone.

**One existing test changed, and none pinned the old behaviour.** No test set a workspace-tier
value for any of the four keys, and none drove `autoLearnCycleMode`. The runtime test in
`test/codex-workspace-scope.test.js` set `autoLearn.mode: auto-safe` and the withdrawn
`codexScope: workspace` through `get()` alone, with an empty `inspect()`. It still passed, but its
auto-safe was held to the default `recommend`, so its scan no longer took the unattended apply
path; Apply safe still granted. Its `inspect()` now reports both at the user tier. The other
harnesses that set `codexScope: off` or `localDrain.enabled: false` through `get()` alone are
unchanged and pass: dashboard-view, extension-lifecycle-async, codex-inventory-ui,
extension-managed-blocked and local-drain-extension.

---

## Claude Code's strip model, checked on each update (2026-10-15)

The maintainer's go of 2026-10-15 (wave-s1, on `83d7c89`). `scripts/check-claude-strip-model.js`
compared the installed Claude Code's known-safe environment-variable list with
`CLAUDE_SAFE_ENV_VARS`, but only when someone ran it, and nothing ran it when Claude Code updated.
The extension now does, once per new binary.

**What moved.** The reader (`defaultBinary`, `nameArrays`, `detectLookupCaseConversion`, `check`)
moved to `src/claude-strip-model.js`, so it ships in the VSIX. Both packagers already copy every
`src/*.js`, so neither changed. The script is a thin command line over it, with the same output and
exit codes; it exports only `main` now, and its tests take `check` and `defaultBinary` from src.
`src/claude-strip-model.js:170#checkOffThread` runs `check` on a `new Worker` of the module itself,
the minimal form of the src/spawn-thread.js pattern.

**When it runs.** `vscode-extension/extension.js:2980#scheduleStripModelCheck` arms an unref'd 30 s
timer on activation; deactivate clears it and terminates a scan in flight.
`vscode-extension/extension.js:2993#checkClaudeStripModel` finds the newest binary with
`defaultBinary`, stats it, and compares a key of path, size and mtimeMs with the one in
`context.globalState`. An unchanged key does nothing. A new key runs the scan on the worker, then
stores the key with a summary: `same`, `drift`, `undecided` (the list could not be located) or
`unreadable`. A failed result is stored like a good one, so a binary the scan cannot parse is not
re-read on every start. A lost thread (deactivate, or a worker that could not start) stores
nothing, so the next start tries again. It never edits `CLAUDE_SAFE_ENV_VARS` or any setting.

**What it says.** `vscode-extension/extension.js:3025#reportStripModel`. The same list is one
output line ("Claude Code 2.1.299: strip model unchanged (39 names, case-exact)"). Drift (names
added or dropped, or `lookupCase` `folded`) is one warning per binary that names the version and the
names, plus output lines. Its Show details button opens the output channel. A list that cannot be
located, or a binary that cannot be read, is one output line. No binary at all is silent.

**Setting.** `permissionWildcarding.claudeStripModelCheck`: boolean, default `true`, machine-scoped,
and read through `userSetting`, so a workspace value cannot switch it off.

**Cost.** A normal start costs `defaultBinary`'s readdir of the two extension roots and one stat, on
the host thread. The scan took 492 ms wall for the 257 MB 2.1.299 binary (2026-10-15), off the
host thread.

**Tests.** `test/claude-strip-model-check.test.js` drives the real extension over a temporary home
holding synthetic binaries, with the 30 s timer captured and fired by hand. Ten revert spot-checks
were run, and each one failed its target test: the scan on the host thread, no key comparison, every
list treated as changed, no list treated as changed, a folded lookup ignored, a not-found branch
that reports, a failed result left unstored, the timer left armed by deactivate, the setting
ignored, and the setting read with `get()`. Dropping the not-found early return outright turned
out to be equivalent, not a regression: the stat's `catch` returns silently on a null path.

**Not covered.** The value class, the wrapper regexes and the matcher's order are still a manual
re-read (`src/claude-strip-model.js`'s header says where). A list change still needs a release. It
reads only the CLI bundled in the Claude Code VS Code extension
(`~/.vscode*/extensions/anthropic.claude-code-*`), not an npm-installed or standalone CLI.

---

## Retire and restore memory gates (2026-10-14)

Ported from the spin-off rampage, `e5c0ee7` (2026-10-09, rampage 0.2.0, "retire and restore memory
gates one at a time"), on the maintainer's go of 2026-10-14 (wave-h3, on `d6ccb0d`). Before it, the
one way to drop a standing order was to remove every gate at once. A gate is now RETIRED in place:
its memory's `scope: global` value becomes `retired` and nothing else in the file changes, so the
memory stays in the store, recall still finds it, and the compile, which selects on `scope:
global`, leaves it out. Restoring is the reverse. Four commits: `f5f4e91` (recall.py), `107987b`
(the planner and the CLI), `b3872e4` (the panel and the card), and this record.

**What was ported.** `recall.py --gates-list` (JSON), `--gates-retire` and `--gates-restore`
(`memory/recall.py:2228#change_gate_scopes`): every name validated before anything is written, one
byte snapshot of the memory folder per change (the newest 30 per store kept, and only directories
this code minted for this store pruned, `memory/recall.py:2181#_prune_snapshots`), each file re-read
just before its own write and put back when a later write fails, the scope value rewritten as a
span (`memory/recall.py:2066#_rescope`) and refused unless the rewrite turns back into exactly the
original bytes, symlinks, junctions, hard links and hand-set ACLs refused, and the whole edit under
an O_EXCL gate-edit lock reclaimed by age alone (`memory/recall.py:2507#_take_gate_lock`). `--lint`
names retired gates after its verdict (`memory/recall.py:2046#_lint_retired`). `src/gates-manage.js`
is the planner both front ends run (`src/gates-manage.js:107#planGateChanges`). The CLI and a
dashboard panel with Apply, Revert and a filter are the two front ends, and the card shows a
retired count. A change a reload cut short is recorded and reported on the next activation
(`vscode-extension/extension.js:7482#reportInterruptedGateChanges`).

**Adaptations.**

| Rampage | AI Acolyte, and why |
|---|---|
| Data under `~/.claude/rampage/`, override `RAMPAGE_SNAPSHOT_DIR` | `~/.claude/wildcarding/`: `gate-snapshots/`, `gates-edit.lock`, `pending-gates.<pid>.json` (`memory/recall.py:1977#_snapshot_root`, `memory/recall.py:2503#_gate_lock_path`). It is the extension's Claude-side state directory: the policy lock, the learner's state and backups, and the recall model already live there, and the store being edited is Claude Code's. `~/.ai-acolyte/` holds Codex-profile state and the Codex backup catalog. The override is `AI_ACOLYTE_GATE_SNAPSHOT_DIR`. |
| Settings read with `get()` | `gates.enabled` through `userSetting` (`vscode-extension/extension.js:7336#gatesSwitch`); `memory.dir` through memoryReport's `cfg()`, `inspect().globalValue` (wave-f15); `memory.recallScript` through `recallScriptPath`. A workspace value of any of them is ignored. |
| No pin: recall.py picks the store | Every step pins the compile store, the one compileGates already pinned (`vscode-extension/extension.js:7172#gateCompileEnv`), and the list's own `store` is named outright for the edit and the compile, so a store that changes under an open panel can only be refused. compileGates now takes its environment from the same helper. |
| `--gates-list` entries: `scope`, `active` | `scope`, `state` (`active`, `retired`, or `excluded`: scope global with an `agents:` line that cannot be read, so neither active nor retired), `agents`, `problem` (`memory/recall.py:1985#_gate_entry`). gates-manage.sh holds the list's active gates to the compiler's own per-agent output. |
| One instruction file | Per agent. A retire is per memory and rewrites the scope value only, so `agents:` survives a retire and a restore byte for byte (fixtures: a flow list, a CRLF block list before the scope, `agents:` after a lone CR, an unknown agent). The plan carries each agent's gates before and after, and the modal says what CLAUDE.md and AGENTS.md each load (`src/gates-manage.js:222#describePlan`): a Codex-only retire reads "CLAUDE.md: not changed by this", and CLAUDE.md is not rewritten. An excluded gate may be retired (it changes no file) and is not restorable (it is scope: global already). |
| The card's own `frontmatterScope` | memoryLint.js `gateEntryOf` (`vscode-extension/memoryLint.js:56#gateEntryOf`), built on wave-h2's `frontmatter` and `gateAgents`; `gateOf` now reads through it, so there is no third parser. fullReport lists `gateRetired`, in compile order, for the card. test/gate-agents.test.js holds it to `_gate_entry` over the 480 generated memories (243 active, 81 retired, 20 retired with an unreadable `agents:`, 75 excluded, 61 none, measured 2026-10-14). |
| `rampage gates list\|retire\|restore` | `wildcard-perms --gates list [--json]` and `--gates retire\|restore [--] <memory>...` (`bin/wildcard-perms:1008#gatesChange`), beside `on\|off\|status\|refresh`, in `--help` and its census. Every word after `retire` or `restore` is a name, never a verb (`bin/wildcard-perms:94#takesNames`): the dispatch finds verbs anywhere in argv, so `--gates retire --seed` ran `--seed`. A dashed name goes after `--`. |
| Legacy ai-acolyte block branches | Dropped. The UI and the CLI name CLAUDE.md and AGENTS.md. |
| Failure advice: `rampage gates refresh`, `gates off`, `rampage recall --gates-compile` | The CLI names `wildcard-perms --gates refresh` / `--gates off` and the recall.py it runs, in backticks (the commands carry quoted paths). The panel names its own **Compile and install** (`vscode-extension/extension.js:7759#runGateFinish`), which finishes every case, because the extension ships no CLI on PATH. |
| A second compile 2 s later by the corpus watcher, "harmless by construction" | One change, one compile. The memories the edit rewrites are marked before it starts and stamped (mtimeMs, size) when it ends, and `gatesCorpusBump` skips an event for one while it still has that stamp (`vscode-extension/extension.js:7193#isOwnGateEdit`). A later edit moves the stamp and compiles as before. The compile is recall.py's atomic replace (G1) and the install `setGatesAll`'s single read (G2); the compiled-file watcher's ensureGates then finds the install current. |
| The edit untracked, so a reload cannot kill it | It is tracked and bounded like every child (the execFile censuses in test/extension-lifecycle-async.test.js now count five sites), and it is the one child deactivate lets finish (`vscode-extension/extension.js:7281#finishingChildren`): rampage measured a kill 30 ms after the snapshot line leaving 18 memories retired and nothing put back. |
| `--lint` note "not compiled" | "kept in the store and left out of the compile by choice": scripts/verify-release.ps1 fails its standing-order check on "not compiled". |
| CI runs recall-py.sh and gates-stale.sh | Neither is in this repo's CI (the brief assumed they were). gates-manage.sh got its own job, `gates-manage` in .github/workflows/test.yml, on rampage's pins (Python 3.11, numpy 2.4.6, onnxruntime 1.30.0) with `CI=true` turning a missing interpreter into a failure. It has not run on GitHub: nothing was pushed. **Superseded 2026-10-19:** the job ("recall.py gate edits on Python 3.11") has run on every push since v1.6.5 (Tests run 38663225986, green) and was green in run 39302888761 for v1.8.1. |

**Decision recorded: gates switched off stay off** (rampage's GATES_FOLLOW_THE_SETTING). A retire
or restore never switches gates on or off. In the extension gates are on exactly when
`gates.enabled` is: with it off, the edit and the compile run and nothing is installed, and the
setting is read again after the modal and before the install, so switching gates off while a
change runs keeps them off. The CLI has no setting and counts gates as on when a gates block is
installed in some agent's instruction file; with none, it edits and compiles and installs nothing.
Turning gates on later installs the fresh compile. Kept from rampage on the maintainer's approval.

**Tests, each failing with its fix reverted** (every mutation run one at a time by a runner that
restores the file and checks it by sha256):
- test/gates-manage.sh, rampage's adapted plus the per-agent sections: ALL PASS. Seven mutations,
  each killed: recall.py as at `d6ccb0d` (fails at `--gates-list exited 2`), an excluded gate listed
  active, a retire that widens `agents: [codex]`, the restore refusal worded "active", the default
  snapshot root named for rampage, the lock elsewhere, the lint note worded "not compiled".
- test/gates-manage.test.js (31): thirteen planner mutations, each killed (per-agent loads, a
  restore always active, names deduplicated, trimmed, gates-off installing, no allow-empty at zero,
  describePlan from the total, an unreadable count as zero, refresh at zero, an excluded gate marked
  active, the state/scope cross-check, terminal text unfiltered, the advice override ignored).
- test/cli-gates.test.js (16 new) and the --help census: thirteen CLI mutations, each killed,
  including bin/wildcard-perms as at `f5f4e91`, the takesNames branch, `--help` after `--`, a dashed
  name before `--`, gates always on, and the unreadable-file refusal.
- test/gates-panel.test.js (34), test/dashboard-view.test.js, test/memory-lint-watchers.test.js,
  test/gate-agents.test.js: 20 mutations of extension.js and memoryLint.js, each killed (the
  own-edit skip, marking before the edit, the store pin, gates always on, an unfiltered title, the
  store and unlisted refusals, a compile failure as a refusal, the install always on, the install
  decided before the modal, no pending record, a live host's record reported, a listed path opened,
  the card's list and line, the dashboard arm, gateEntryOf's scope test and its JavaScript reading,
  gateRetired's push and its order), and two more against the final shape of the one child
  deactivate lets finish (the edit not added to finishingChildren; killLiveChildren not skipping
  it). Whole-file reverts of extension.js and memoryLint.js fail 34, 1 and 3 tests.
- scripts/drive-installed.js: a Codex-only gate retired and restored through the packaged panel,
  the packaged recall.py and the toolbox Python in the sandbox. AGENTS.md changes, CLAUDE.md stays
  byte for byte, and the memory comes back byte for byte. 15/15 on the staged build, in the default
  and the custom-override Codex layouts.

**Not ported:** the legacy-block migration and its CLI notes, the `rampage recall` passthrough, the
`rampage.*` settings and model home, rampage's drive-vscode and vscode-acceptance renderer changes
(this wave runs neither), and its CI floor arithmetic (this repo's suite has no `--min-pass`).

**Residuals, not changed here:**
- Not run: drive-vscode on real VS Code, and the new CI job on GitHub. (Superseded 2026-10-19: the CI
  job has run green on every push since v1.6.5, and drive-vscode passed 6 of 6 for v1.6.8, v1.7.0,
  v1.8.0 and v1.8.1, per BACKLOG.md's release paragraphs.)
- `isOwnGateEdit` keys on the path the store is listed under, case-folded on Windows. A store the
  watcher reports under another spelling (through a junction, say) would not match, and the
  watcher's compile would run once more, harmlessly, as in rampage.
- The panel does not re-list when a memory changes outside it; it re-lists on open, on show and
  after every change it runs (rampage the same).
- The corpus watcher still compiles only while a block is installed (unchanged). A hand edit with
  no block installed waits for Compile and install, the toggle, or the next change.
- The CLI counts gates as on when any agent's file holds a block, for every agent's install.
- The snapshot root is shared by every store; the prune keeps 30 per store, so the root can hold
  30 per store.
- The other-store census still compares gate text only (wave-h2's residual).

## Per-agent memory gates (2026-10-14)

Backlog gap 2, **FIXED** in `c6a1878`, built on the maintainer's go of 2026-10-14 (wave-h2, on
`d624539`). A gate memory could already say which agents it is for (`agents: [codex]` under
`metadata:`), and nothing read it, so every `scope: global` gate was installed into both `~/.claude/CLAUDE.md` and Codex's
`AGENTS.md` (or `AGENTS.override.md`). The live case on this box is a Codex-only performance gate
whose text must not reach Claude. An older checkout had built per-agent output as uncommitted
changes and was not cherry-picked: it wrote each per-agent file through a fixed `.tmp` name with a
bare `os.replace` and no retry, kept the late read G2 fixed, and called `setGuidance` per target,
which skipped `setGuidanceAll`'s `AGENTS.override.md` selection.

**The shape: one file, a section per agent (option b, not per-agent files).** While no gate names a
subset of agents the compile is exactly what it was, one gate set every agent installs. Once one
does, `gates.generated.md` becomes a first line, `<!-- generated by recall.py --gates-compile; per
agent: claude N, codex M -->`, giving each section's size in UTF-8 bytes, then each agent's own
compile back to back, header and sha included, an agent with no gates contributing nothing
(`memory/recall.py:1434#_compile_gates_text`). `compiledForAgents` cuts it at those sizes from one
read and refuses the whole file, for every agent, unless the sizes add up to the file and every
section matches its own sha (`src/agent-gates.js:117#compiledForAgents`). The reasons against a
file per agent: both agents' gates then cross the disk in two replaces and leave it in two reads,
which needs a compile id in every header and a refusal when they disagree, and still leaves
per-agent files for a later compile to orphan. That orphan is not hypothetical: the older
checkout's `gates.generated.claude.md` (empty) and `gates.generated.codex.md` (one old gate) sat
in this box's `~/.claude` until they were archived. One file keeps G1's single temp-and-replace
with its retry and G2's single read unchanged, needs no compile id, and has no per-agent file
anyone could leave behind. Each installed block is exactly that agent's section trimmed, the same
shape a compile of that agent's gates alone installs.

**Syntax** (`memory/recall.py:848#_gate_agents`). `agents:` anywhere in the frontmatter, at any
indent, like `scope:`; `codex`, `claude`, a flow list or a block list of `- name` lines,
case-insensitive, an optional trailing `# comment`. Absent or empty means every agent. What cannot
be read is never guessed at, because "every agent" is the leak the key exists to prevent: an
unknown name, two `agents:` lines, and an empty `agents:` followed by a deeper line that is not a
list item (a plain scalar continued on the next line) each leave the gate out for every agent.
Three readings were found while writing it that would have fallen back to every agent, and each
is pinned: a comment line inside a block list, that continuation line, and `agents :` with a
space before the colon, which is still the key in YAML. `_gate` is the one selection rule
(`memory/recall.py:1349#_gate`), and `_gate_body` stays the census's entry to it, so a gate left out
is not counted in another store either.

**The JavaScript mirror** (`vscode-extension/memoryLint.js:147#gateAgents`) reads with Python's
whitespace (`vscode-extension/memoryLint.js:87#PY_SPACE`, the 29 code points `str.isspace()` and
`re`'s `\s` share, re-measured under the toolbox Python 3.11.15) and Python's universal newlines.
`frontmatter`, which reads `scope:`, was rewritten the same way (`vscode-extension/memoryLint.js:127#frontmatter`),
the reading rampage `e5c0ee7` gave its card's `frontmatterScope`, because the agreement test below
compares the whole selection and the old JavaScript `\s` reading disagreed with Python on `scope:`.
test/gate-agents.test.js holds `gateOf` to `recall.py`'s `_gate` file by file over 480 generated
memories in one Python spawn. Measured 2026-10-14: 162 are not gates, 180 are for every agent, 45
for Codex, 18 for Claude and 75 left out, and 284 of the 480 read differently under JavaScript's
own rules, so a pass is not a pass over easy inputs. The generator picks with its LCG's high bits:
the low bits cycle with a short period, and the first draft's `state % 4` gave every file the same
scope.

**Install.** `setGatesAll` reads once, splits, and passes `forAgent` to `setGuidanceAll`
(`src/agent-gates.js:217#setGatesAll`, `src/agent-guidance.js:618#forAgent`), so each agent's own
block goes through the same per-target path, Codex's override selection and its re-check under the
lock included. An agent the compile gives no gates is turned off, which removes a block a gate left
when it moved; that is not the "empty" refusal, which stays for a compile with no gate for any
agent. Status rows carry `applicable`, `gates` and `perAgent`, and an agent with no gates is
`current` once none of its files holds a block (`src/agent-gates.js:177#gatesStatusAll`).

**Migration proof.** test/recall-py.sh "a 13-gate corpus with no agents: key compiles and installs
byte for byte as d624539 did" extracts `src/` and `memory/recall.py` from `d624539` with `git archive`
and runs both trees over the same invented corpus: 13 gates written to catch what the selection
could change (nested and flat scope, a BOM, CRLF, a quoted scope, non-ASCII text, a description
that mentions agents, a body that documents `agents: [codex]` in a fenced example) and four
non-gates. It compares, byte for byte, the compiled file, `CLAUDE.md`, `AGENTS.md` and every
backup, once with the base `AGENTS.md` active and once with `AGENTS.override.md`, then runs this
tree's compile and install over the baseline's own install and requires both to change nothing
(rows `changed: false`, every byte the same). It passes on `d624539` by construction, since it is
the control; run alone, it kills three mutations (the per-agent header for every compile, a compile
id in the header line, and Codex turned off whatever its gates). On this box a read-only grep
found the key in one memory, in the 41-file store that does not compile; the compile store's 13
gates carry none.

**Hazards and their handling.**
- *Stale per-agent files:* never read. A blank `gates.generated.claude.md` and a one-gate
  `gates.generated.codex.md` beside a single-set and a per-agent compile change nothing; the
  mutation that prefers them, as the older checkout did, strips Claude's block.
- *A read torn anywhere:* inside the per-agent line, inside either section, at the boundary, a
  hand edit that keeps the size, and an editor's extra newline are each one refusal row, with both
  instruction files untouched.
- *A gate moving between agents:* `--lint` reports STALE on the move; the next compile and install
  take it out of the agent it left, and the last gate leaving an agent takes the block with it,
  leaving the user's own text byte for byte.
- *An installer older than this change:* a sectioned file begins as every compile does, so an
  installer with `compiledIsWhole` (wave-h1 onwards, which includes the live checkout at `d624539`)
  refuses it as torn. One from 1.6.3 or earlier checks nothing and would install it whole into both
  files. Only a mixed install can meet that (a newer `recall.py` named by `memory.recallScript`
  under an older extension), and only once a gate names its agents. Run one version.

**Surfaces.** `--gates status` gives each agent's count (`bin/wildcard-perms:922#count`), "ON, 13
gates", and "(none compiled for claude)" for an agent with none; `on` and `refresh` print "OFF,
none compiled for claude" for the removal. `--lint` prints "N gate memories compile: claude X,
codex Y" and reports a gate left out, with the reason, as a finding that keeps `clean:` from
printing; the compile names it on stderr, which `--gates refresh` passes through. The dashboard
card reads "Claude 13 · Codex 14" in its text and badge once the agents differ, judges ON and
PARTIAL over the agents that have gates (`vscode-extension/extension.js:4992#wanted`), and names a
left-out gate memory. Its count now comes from the status rows, which removed `compiledGateCount`
and one read of the compiled file per push; `readCompiled` became test-only. `ensureGates` treats
a gateless agent with no block as settled (`vscode-extension/extension.js:4369#wants`), and the toggle
counts that install as complete (`vscode-extension/extension.js:4412#installed`).
`scripts/verify-release.ps1` compares `CLAUDE.md` with Claude's section
(`scripts/verify-release.ps1:221#GetBytes`); its extraction was run alone under PowerShell 5.1 and 7
against a per-agent compile with non-ASCII text, never through the release script.

**Native Codex gates are left alone.** `src/codex-memory-gates.js` reads `~/.codex/memories` with
its own strict parser (`scopeScalar`, `scope:` at the top level or under `metadata:` only) and
installs into Codex's file alone. It does not read `agents:`, and it does not share this parse:
its corpus is Codex's own memory and its only target is Codex, so there is no Claude file to keep
a gate out of.

**Tests, each failing with its fix reverted.** With the six production files put back to `HEAD`,
all 11 new node tests fail and the new test/recall-py.sh section fails at its first per-agent
assertion; restored and checked by sha256. Mutations, each killed and restored the same way:
test/agent-gates.test.js, 9 (every agent given Claude's text, sections swapped, the size check
dropped, the per-section sha dropped, an orphan preferred, an agent with no gates left on, the
gateless `current` override dropped, and `setGuidanceAll` ignoring `forAgent`'s `on` or its block);
test/gate-agents.test.js, 11 (JavaScript's trim for the value and for the names, no universal
newlines, a block-list comment ending the list, a continuation read as empty, `scope:` read with
JavaScript's `\s`, the key found with `trimStart`, and in Python `agents :` not a key, the item test
without Python's whitespace, and both block-list fail-closed rules); test/memory-lint-watchers.test.js,
2; test/recall-py.sh, 11 (every gate for every agent, the per-agent header always, a compile id, an
unknown name read as every agent, `clean:` ignoring a left-out gate, the compile's stderr, the
counts in the compile and in `--lint`, the left-out report, `_gate_body` keeping a left-out gate,
Codex turned off whatever its gates); test/cli-gates.test.js, 2; test/dashboard-view.test.js, 4;
test/extension-activation.test.js, 2 (`ensureGates` wanting every agent, the toggle's `installed`).

**Residuals, not changed here:**
- The other-store census compares gate text only. A gate the compile store installs for Codex alone
  counts as installed when another store holds the same text for both agents.
- A native Codex memory that says `agents: [claude]` is still installed into Codex.
- The compile's "compiled N gate(s), X bytes" counts characters, as before this change.

**For the next wave, retire and restore (rampage `e5c0ee7`).** Retire rewrites `scope: global` to
`scope: retired` and nothing else, and its backstop refuses any other byte change. Keep it so:
`agents:` must survive a retire and a restore byte for byte, so a restored gate returns to the
agents it had. Retire per memory, not per agent; moving a gate between agents is an edit of
`agents:`, and the compile already removes it from the agent it left. `--gates-list` should carry
each gate's agents and any `problem`, a gate left out for its `agents:` listed as neither active
nor retired. The panel's "what loads next session" must be computed per agent: retiring a
Codex-only gate changes `AGENTS.md` and nothing in `CLAUDE.md`, and retiring the last targeted
gate returns the compile to a single gate set, which `compiledForAgents` reads either way. The
card's retired count should use memoryLint.js's `frontmatter` and `gateAgents` rather than a third
reading.

## Rampage's memory-gates hardening, ported (2026-10-14)

The private spin-off rampage is a `git filter-repo` copy of this repo at v1.6.1, kept to the
memory paths. Its base `7ec8a8a` equals `c09daab` here, and the gate files were byte-identical
there. Its memory-gates hardening landed in one commit, `7139659` (2026-10-08). The maintainer
approved this scope on 2026-10-14 (wave-h1, on `35c3358`).

Each item was re-verified against this tree before it was ported, and adapted to what this repo
still has and rampage dropped: the Codex target with its `AGENTS.override.md` selection, the
shell-style and derived blocks that share `createManagedBlock`, and the other callers of the
policy lock. Every new or ported test was run against a revert of its fix, with the file
restored afterwards and the restore checked byte for byte. A few tests pass on the pre-port code
by design, because they guard the NEW code's edges. Their rows say so, and name the mutation
that kills them.

| Item | Disposition | Evidence |
|---|---|---|
| G1: `compile_gates` wrote `gates.generated.md` in place, so a reader racing it could see it empty or partial | **PORTED**, `452a752` (rampage `7139659`) | The write goes through a pid-named temp and `os.replace` (`memory/recall.py:1622#tmp`), retried 10 times on `PermissionError` at 20 to 180 ms. Windows refuses to replace a file another process holds open. There is **no in-place fallback**: a holder that never lets go makes the compile exit non-zero with the previous file whole, and the temp is removed. Rampage's measurement, quoted in the comment: written in place, 2,275 and 2,136 empty reads in two 5 s runs against a reader loop; replaced, none. **Adaptations:** `time` is imported at module top, where rampage imported it in the loop. The schedule is cited against `src/permissions.js` writeFileAtomicSync, because rampage's `src/fs-atomic.js` is not ported. **Test**, in test/recall-py.sh: "the gates write replaces the file rather than truncating it, and leaves no .tmp residue". The file id (`st_ino`) must change across a recompile. Reverting to an in-place write fails it on the file-id assertion. |
| G3: an unreadable store made discovery compile the next-largest store's gates, exit 0 | **PORTED**, `452a752` (rampage `7139659`) | `_discover_memory_dir` records each store it cannot read, and a projects root it cannot list for any reason but absence (`memory/recall.py:167#_DISCOVERY_ERRORS`). `compile_gates` refuses on any of them before reading or writing (`memory/recall.py:1521#_DISCOVERY_ERRORS`), and names the store. Search and `--lint` still run on such a pick and warn. An explicit `RECALL_MEMORY_DIR` skips discovery. The extension passes one whenever memoryReport has a store, so this is mostly the CLI's and a bare run's path. **Tests**, in test/recall-py.sh: "a store discovery cannot read stops --gates-compile, which names it and writes nothing" (os.listdir raises for the largest store inside the harness; the control is the same home compiling with nothing denied), and "a home with no ~/.claude/projects is a fresh machine, and its gates compile stays a no-op". Three mutations, each failing one assertion: delete the refusal; drop the per-store append; record the root's `FileNotFoundError`. |
| G2: the gates install read the compiled file once for its check and then re-read it in the block body | **PORTED**, `659be23` (rampage `7139659`) | **Counted** with a readFileSync wrapper, for one `setGatesAll(true)` over Claude and Codex: 5 reads of `gates.generated.md` before, 1 after. A read that failed (EBUSY while a writer held it) or came back truncated after the check had passed installed an empty or partial block and reported success. Rampage measured it: 23 of 38 first-time migrations replaced the user's gates with an empty block. **What changed:** `setGatesAll` reads once and builds the block from that string (`src/agent-gates.js:217#setGatesAll`), and `gatesStatusAll` reads once too. A null read is refused (`src/agent-gates.js:194#refusalFor`). A compile whose gates do not hash to the sha in its own header is refused (`src/agent-gates.js:88#compiledIsWhole`), and so is a read torn inside the header line, which used to pass as headerless. A headerless file is still taken as it is. **Adaptations:** kept the Codex target and `setGuidanceAll`'s override selection, the existing markers and the `pre-gates` backup name. Dropped rampage's legacy block, `escape` and `targets.js` arguments. The refusals name `wildcard-perms`. **Tests**, test/agent-gates.test.js: rampage's four ("read once per write", "cannot be read is refused", "do not match its own header sha", "torn inside its own header line", at six cuts). Each fails with its fix reverted, and all four fail with the whole file reverted. "a compile shaped exactly as recall.py writes it installs" is a control and passes on the old code. |
| G6: `src/agent-gates.js` said gates need `type: feedback` + `scope: global` (backlog gap 3) | **FIXED**, `659be23` | The header now says selection is on `scope: global` alone, that `type:` plays no part, and that only one store compiles. Comment only, so no test. |
| G4: the managed-block writer matched markers as substrings, rewrote non-UTF-8 files, swept bare `\n` only, kept one backup slot and replaced symlinks | **PORTED**, `edec1fa` (rampage `7139659`), patched into `src/agent-guidance.js` in place | Not imported, because `derived-guidance.js` and `codex-memory-gates.js` build their blocks with this module's `createManagedBlock`. They inherit the new marker, fence and CRLF rules, and the lock at the real path, through `withInstructionLock`. **What changed:** (a) Markers count only as whole lines, after a byte-order mark on line 1 (`src/agent-guidance.js:153#markerLineAt`). A pair wholly inside a closed code fence is an example (`src/agent-guidance.js:178#fencedSpans`). The range starts at the last begin line before the first end line. (b) Removal counts `\r\n` and `\n` as one terminator each and keeps the user's own bytes. Only the install's own blank line goes, and a file holding only a BOM takes the block straight after it. (c) The file is read as bytes. A file that does not round-trip through UTF-8, or holds a NUL, is refused with nothing written or backed up (`src/agent-guidance.js:395#readInstructionFile`). (d) Two backups from the raw bytes: `<name>` is written once and never overwritten, and `<name>-prev` holds the file before the latest change. (e) A symlinked file is written through to its target and locked there (`src/agent-guidance.js:419#writablePath`), and a link to a missing file is refused. **Adaptations:** the rolling slot is per block and per file, `CLAUDE.md.pre-gates-prev`, where rampage's is per file (`*.rampage-prev`). An INACTIVE Codex file that is not UTF-8 and holds no block blocks nothing (`src/agent-guidance.js:448#blocksCleanup`). Without that, a UTF-16 `AGENTS.md` shadowed by a nonempty override stopped guidance and gates being installed in the override at all. **inPlaceFallback, decided:** this repo's `writeFileAtomicSync` stays. The unattended writers pass `inPlaceFallback: false`: `ensureGates` and `ensureGuidance` (activation, the compiled-file watcher, the corpus recompile) and `--gates refresh` (`bin/wildcard-perms:1188#inPlaceFallback`). Their update is redone by the next activation, recompile or session. An in-place write truncates and refills CLAUDE.md or AGENTS.md while any new session may be loading it, and the 2026-10-14 audit measured it running on every write once a holder kept the file open 0.9 s or more. The interactive toggles and the CLI's on/off keep the fallback, because a person sees the result. **Tests**, test/agent-guidance.test.js, ported: "a lock that cannot be created for a sharing reason is a busy row", "not UTF-8 text is refused byte for byte", the two stand-in symlink tests, "the first-ever backup is kept for good", "removal between CRLF lines", "an editor saves as CRLF", "only the install's own blank line goes", "a byte-order mark is not user text", "a marker quoted in the user's prose", "a begin line left on its own", "inside a closed code fence", "a fence can hide only a pair it encloses". New: the BOM-and-CRLF `AGENTS.md` round trip through `setGuidanceAll` (on, status, off, an editor-saved copy, a block at the very top); "an inactive Codex file that is not UTF-8 and holds no block blocks nothing"; "inPlaceFallback: false leaves a held instruction file untouched". Also new: an activation test with a held CLAUDE.md (test/extension-activation.test.js), and a CLI refresh test against a held CLAUDE.md (test/cli-gates.test.js). Twenty mutations of the two modules, two of the extension's calls and one of the CLI's call, each killed. With `src/agent-guidance.js` reverted whole, 12 of these tests fail. Four pass on the old file by design: "removal between CRLF lines" (the old arithmetic agrees on that input), the fence-encloses control, and the inactive UTF-16 case all guard the new code's edges; the sharing-lock row rides on G5's policy-lock change and fails when isContended answers EEXIST alone. **Skipped:** "a real symbolic link survives the write". It needs the symlink privilege, which Windows reserves for an elevated or Developer Mode session, and the stand-ins cover the path. Also skipped: the legacy, `escape` and `requireBlock` cases. "a string target backs up beside the file" is not ported either, see the residual below. |
| G5: a sharing error creating a lock crashed the writer; a `null` lock was never reclaimable; a live pid was honoured forever | **PORTED, SCOPED**, `5c9c4e0` (rampage `7139659`) | (a) EPERM, EACCES and EBUSY creating the lock are a busy lock (`src/policy-lock.js:34#isContended`), as EEXIST was. The codes are src/permissions.js RETRYABLE_RENAME_CODES, the one shared set, looked up lazily on the failure path, because test/rename-retry-policy.test.js forbids a second spelling of it (a literal Set failed that census on the first full run). A code other than EEXIST is named in the message and kept as `cause`. A sharing code from the metadata write, after this process created the lock, is still its own failure. (b) The lock is read through `Object(JSON.parse(...))`. (c) Reclaiming a lock whose pid answers, or cannot be probed, once it passes the stale window is an **opt-in**, `reclaimLiveWhenStale` (`src/policy-lock.js:65#reclaimLiveWhenStale`). Only `withInstructionLock` (30 s) passes it. The drain hook, `withPolicyLock` and Auto Learn share `POLICY_LOCK_PATH` with a ten-minute window. A scan that outlasts that window is still a live writer of settings.json, so they never reclaim a live holder. (d) `POLICY_LOCK_PATH` and `POLICY_LOCK_BUSY_MESSAGE` stay exported; rampage deleted both. The CLI's `withPolicyLock` prints the busy error's own message, so a permanent EACCES no longer reads as "Auto Learn is mid-scan". **Tests**, test/policy-lock.test.js: rampage's four (the live pid and the EPERM probe under the opt-in; non-object JSON; sharing codes busy and named; a metadata-write EACCES stays EACCES). Added: "without the opt-in, a live-pid holder is never reclaimed, however old its lock is". It also pins that only `src/agent-guidance.js` passes the opt-in. Added in test/agent-guidance.test.js: "an instruction lock older than its window is reclaimed even when its pid answers". Each fails under its mutation, and three fail with the whole file reverted. The metadata-write and no-opt-in tests are controls and pass on the old code. |
| G7: `--gates refresh` printed advice to run itself, and swallowed a successful compile's stderr; `ensureGates` dropped every error | **PORTED**, `59d4655` (rampage `7139659`) | **What changed in refresh:** when the install is refused, refresh says what happened (`bin/wildcard-perms:1193#refused`). It prints "compile failed, and nothing was installed (...)", with the reason when the compile was not empty, or "the compile found no scope:global gate blocks, so there is nothing to install". It no longer prints the refusal's "run `recall.py --gates-compile`" / "`--gates refresh`" advice. "Installing whatever was last compiled" is printed only when something was. A successful compile's stderr is passed through (`bin/wildcard-perms:1169#compile.stderr`). The comment that said `--gates status` reports the staleness a failed compile leaves now says it cannot, and that `recall.py --lint` does. Refusal rows carry `refusal` and a bare `reason` beside `error` for this. AI Acolyte's `resolvedLaunch` spawn is kept. **Extension:** `ensureGates` writes each failed target's error to the output channel (`vscode-extension/extension.js:4380#failed`). That is the shared channel, named "Acolyte"; no channel is named "AI Acolyte". **Tests:** test/cli-gates.test.js "CLI --gates refresh says what happened, never advises refresh, and passes compile warnings through" (a compile that cannot run, and a stand-in python that warns and compiles nothing); test/extension-activation.test.js requires one log line for the held gates target. Each fails with its fix reverted. |
| New: a `scope: global` gate in any store but the compile store was ignored in silence (backlog gap 1) | **FIXED by reporting**, `a9a2dbf` | The maintainer's decision: such gates are still never compiled; they are now reported. `recall.py --lint` names each other `~/.claude/projects/*/memory` store by folder name, with its count of gate memories that are not installed, and any store it could not read (`memory/recall.py:1383#_other_store_gates`). "Not installed" means the block's text is not one the compile store compiles, so a copied store is not reported for gates it shares. The section counts toward `clean:`. It avoids the phrase "not compiled", which verify-release.ps1's standing-order check fails on. One selection rule, `_gate_body` (`memory/recall.py:1364#_gate_body`), serves the compiler and the census, and the compiler's output is unchanged. The dashboard's gates card shows "N gates in other memory stores are not installed: <folder> (n)" from `otherStoreGates` (`vscode-extension/memoryLint.js:699#otherStoreGates`). It is called by `gatesCardData` with memoryReport's `dir` (the store compileGates pins) and that store's `gateBodies` (`vscode-extension/extension.js:5038#otherStores`). It is not part of memoryReport, whose syscall budget is pinned by test. **Measured** in one process, which is indicative only and not this file's fresh-process protocol: 4 other stores of 50 files cost 207 ms cold and 12.5 ms min / 15.7 ms p50 warm, one stat per file. So the answer is held for a minute per compile store and gate set (`vscode-extension/memoryLint.js:687#CENSUS_MAX_AGE_MS`), and a census reads a file only when its mtime or size changed. **Which store compiles is unchanged:** memory.dir when set, else the largest. **Tests:** test/recall-py.sh covers an other-store gate reported by folder and count and not compiled; compile bytes identical with and without that store; no section once no other store holds a gate; `RECALL_MEMORY_DIR` deciding the compile store; an unreadable store named. test/memory-lint-watchers.test.js has the same census in JS, the memory.dir pin, an unreadable store, the per-file memo, the one-store budget (one listing of `~/.claude/projects`) and the minute's cache. test/dashboard-view.test.js covers the card line, singular, hidden and unknown, and checks the census is asked about the compile store. Fifteen mutations, each killed. The `== primary` skip in the Python census is not separately falsifiable: the dedup already zeroes the compile store. The JS one is caught by the one-store budget. |
| G8: rampage stops pinning `RECALL_MEMORY_DIR` for the compile | **NOT PORTED** | It conflicts with wave-f15 (S2 of the final pre-tag audit): `memory.dir` is machine-scoped, and the extension pins the compile store from it, so a repository cannot choose the corpus that becomes the user's standing orders. Kept as it is. Also not ported: rampage's legacy migration, `src/targets.js`, `src/fs-atomic.js`, the `rampage.*` settings and the model home. Seen in the same recall.py diff and out of this scope: the 200-line `MEMORY.md` cap in `--lint`, the `--selftest` reference tolerance, `_load_session` and the two-file model dir check. |

**Residuals, not changed here:**
- `src/derived-guidance.js` writes the same instruction files through its own read and write. It does not get the UTF-8 refusal, the two backups or the symlink write-through, which live in `setGuidance`; it still keeps one `.pre-derived` slot.
- `setGuidance`'s default `backupDir` is still `os.homedir()/.claude/backups`, whatever file it is given. Rampage's "a string target backs up beside the file" case covers that. Every production caller passes a `backupDir`.
- The extension's drain prints the `POLICY_LOCK_BUSY_MESSAGE` constant (its manual status-bar message), so a sharing-code busy there still reads as "Auto Learn is mid-scan". The CLI prints the code.
- A `codex-memory-gates.js` instruction file whose only native marker pair sits inside a code fence now reads as absent to `has()`, so `blockState` throws "ambiguous" rather than rewriting the example. Fail-safe, and found by reading, not by test.
- `--gates refresh` still exits 1 on a machine with no gates. That is unchanged, and only the wording moved.

## The silent Review button (2026-10-14)

Reported: Review on the dashboard's Auto Learn card did nothing visible, where it used to open a
checkbox list. The card read "2 safe to apply", with tiles SAFE 2, REVIEW 0 and OBSERVING 43, "23
already covered", and "last scan read 831 files cleanly". Two defects, both fixed in `1c09538`. Each
was reproduced before it was changed, and every test named here was run against a revert of its fix,
with the files restored afterwards.

| Finding | Disposition | Evidence |
|---|---|---|
| The card counted what Review hides | **FIXED**, `1c09538` | **Reproduced** read-only against a copy of the reported state, through the extension's own functions: `countAutoLearnCandidates` gave safe 2 and review 0, and `reviewableCandidates` gave 0 candidates and 23 covered. The two safe families were `Bash(git status *)` and `PowerShell(git status *)`. Each was auto-safe, over the threshold, and owed only `claude`, and `claudePermissionDecision` answered `allow` for both, because an allow rule already in settings.json covers them. `safe` was counted from every pending auto-safe family, while `review` came from `reviewableCandidates`, whose own comment (`vscode-extension/autoLearnUi.js:309#reviewableCandidates`) calls it the single definition of what Review shows. **What applying one does**, measured with the real manager on a temp home (allow list `Bash(git *)`, three `git status` runs): a non-reviewed `apply` leaves settings.json byte-identical, writes one claims record `{ managed: false, coveredBy: "Bash(git *)" }`, marks the key applied, and reports `changedTargets: ['claude']`. It changes no prompt, so the card must not offer it as work. **What changed:** `safe` is counted from `reviewable.candidates` (`vscode-extension/extension.js:1597#safe`), so a covered auto-safe family is counted in `covered` alone. The row's "N safe to apply" rank is removed. `safe` is now a subset of `review`, so the rank could not fire, and when it could, it promised work no button on the card performs. The SAFE tile, the manual scan toast ("N safe, M review") and the Review button label read the corrected counts. Nothing in the extension auto-applies from `counts.safe`; auto-safe mode applies inside the manager's scan. **Pinned by** "a covered auto-safe family is not counted safe to apply, and an uncovered one still is" (test/dashboard-view.test.js), through the real payload. With the old count it reads `{ safe: 2, review: 0, covered: 4, observe: 1 }`, the reported shape. Reverting the row's rank alone is not falsifiable with real data, which is why it was removed. **Updated:** the `safe` leg of "a degraded scan qualifies the review count instead of replacing it" pinned "2 safe to apply" for a `review: 0, safe: 2` payload that can no longer occur. It now pins `review: 2, safe: 2` as "2 to review · scan degraded". **Residual, not changed:** Apply safe (palette only) still applies covered auto-safe families, and because the claims file changes, its toast reads "applied N command families in Claude" although no prompt changes. The manager folds `claude-claims` into the `claude` target, so the extension cannot tell the two apart without a manager change. |
| Review gave no visible feedback | **FIXED**, `1c09538` | Review's prerequisite was `runAutoLearnScan(false, true)`, and it returned on a null. That null is silent in three cases: another scan holds the latch (no message at all), the background failure backoff is armed, and the worker throws (console.error only). Nothing showed while the scan ran. When nothing was reviewable, the answer was a non-modal toast, which is easy to miss and is not shown at all under Do Not Disturb. `applyAutoLearnSafe` had the same `null` then `return`. **What changed** (vscode-extension/extension.js): `runAutoLearnScan` publishes its outcome as `autoLearnScanInFlight` (`vscode-extension/extension.js:149#autoLearnScanInFlight`), a promise of `{ result }` or `{ error }` that is set with the busy latch, cleared beside it by identity, and emptied with it by `activate()`. Its new `userInitiated` leg skips the backoff, shows a failure with `showErrorMessage`, and leaves the application report to its caller. `scanBeforeUserAction` (`vscode-extension/extension.js:1862#scanBeforeUserAction`) is the prerequisite for both buttons. It holds a status-bar message from the click until the scan settles. A scan already in flight is awaited and never duplicated, and its failure is shown. The empty Review is a modal, `{ modal: true, detail }`: the existing wording, the covered and observing counts in the detail, and the review scan's own application folded in. "Show covered" opens a read-only QuickPick, with no checkboxes and nothing applied, listing each hidden family with the allow rules `claudePermissionDecision` matched (`vscode-extension/autoLearnUi.js:341#coveredFamilyItems`). "Show blocked" stays, as the second button where it applies. Background scans are unchanged: silent, logged, and backed off. **Pinned by** these tests in test/extension-lifecycle-async.test.js. Each fails with its fix reverted, and each in-test MUTATION note names the assertion that fails: "Review clicked while a scan is running waits for it, then answers, on one worker"; "Review during the background failure backoff still scans and answers"; "a Review whose own scan fails says so"; "a Review waiting on a scan that then fails says so"; "an empty Review is a modal with the covered count, and Show covered lists them read-only"; "Apply safe clicked while a scan is running waits for it, then applies". The control, "a background scan that fails stays silent and keeps its backoff", passes on the old code and fails when the debounced rescan is made user-initiated. **Updated:** test/extension-managed-blocked.test.js pinned the old toast's argument list; it now asserts the modal, and that Show blocked is still the action. Two stubs, there and in test/codex-workspace-scope.test.js, returned nothing from `setStatusBarMessage`; the real API returns a Disposable, and Review now disposes it. |

## The final pre-tag audit (2026-10-14)

**Released as v1.6.3 on 2026-10-14.** The tag is at `1fb294a`.
- CI run 38588139138 passed all 7 jobs, and release.yml run 38588481782 succeeded.
- The published `ai-acolyte-v163.vsix` matches the local build in all 57 entries, apart from line
  endings: CI packages from an LF checkout, the development tree is CRLF.
- The installed build passed `drive-installed.js` 14 of 14.
- The release list keeps 3 releases.
- The real-editor drive, `drive-vscode.js`, is still unrun, because VS Code's pending update holds
  its mutex (BACKLOG). (Superseded: it passed 6 of 6 from v1.6.8 on; the flagged groups are recorded
  under the 1.9.0 backlog clearance.)

The last audit before the v1.6.3 tag found two MEDIUM security defects and two NOTEs. Each was
re-verified before it was changed, and every test named here was run against a revert of its fix.
Releasing then surfaced one harness gap, and it is fixed:
- `drive-installed.js`'s settings stub had no `inspect()`, so the newly machine-scoped toggles read
  their defaults and the round trip failed 1 of 14.
- Fixed in `1fb294a`.

| Finding | Disposition | Evidence |
|---|---|---|
| S1 (MEDIUM): "Why did this prompt?" passed pasted text through cmd.exe, so `%CMDCMDLINE:~-1%` broke out of the quoting (the BatBadBut class) | **FIXED**, `e3c5fd1` | **Reproduced** first: `x%CMDCMDLINE:~-1%&echo injected>F&rem`, through `resolvedLaunch` and `codexExecpolicyArgs` with a two-line stand-in `codex.cmd`, created F, and the controls `x&echo injected>F&rem` and `x%CMDCMDLINE%&…` did not. `%CMDCMDLINE:~-1%` is the last character of cmd.exe's own command line, the `"` that closes it. The comment that called `%NAME%` expansion "a legibility edge and not a hole" assumed learned command words; this path passes a paste, and the PowerShell variant passes the whole paste as one `-Command` token. **What changed:** (a) `execFileCaptured` tries `npmShimLaunch` first, as the trust worker does, so an npm `codex.cmd` runs as `node <script>` with no cmd.exe at all. The Auto Learn validator does the same, because its `--rules` paths and learned tokens are text too, and through cmd.exe a `%NAME%` token was validated as its expansion. (b) `commandLaunch`, and so `resolvedLaunch`, refuses before any spawn an argument holding `%`, `!`, CR, LF or NUL on the cmd.exe route (`src/exec-resolve.js:120#BATCH_UNSAFE_ARGUMENT`), with code `ERR_BATCH_ARGUMENT_REFUSED` and a message that names the argument and the character and says nothing was run. `!` is refused because `/d` skips only AutoRun, and the registry can turn delayed expansion on. Refusing rather than escaping, because every launch here is a probe or a diagnostic. The program path is not checked: PATH, a machine-scoped setting or the user's install names it, and a profile folder may hold a `!`. "Why did this prompt?" adds the remedy, a `codex.exe` or the shim npm writes. **Callers checked:** the version probe (`--version`) and the trust worker (`app-server --stdio`) pass fixed words and are unaffected, and so is the config RPC worker (node plus this module's own path). `--gates refresh` reports a refusal as the compile failure it already prints. **Residual:** a batch-file codex that is not npm's shape now refuses a `%` or `!` anywhere in its arguments, and that includes a home folder whose name holds one. The validator then fails closed. **Cost:** "Why did this prompt?" through an npm shim now creates node (207 ms on the host thread, the residuals table's figure) where it created cmd.exe (74 ms), once per variant, while the user waits for a modal. **Pinned by**, each failing with its fix reverted (checked by mutation, files restored by hash): in test/exec-resolve.test.js, "a batch launch refuses an argument cmd.exe would expand, so the audit's %CMDCMDLINE:~-1% injection never runs" (its precondition runs the injection for real), "a batch launch still passes ordinary arguments verbatim, and refuses ! and line breaks as well", and "through the shim npm writes, the audit's %CMDCMDLINE:~-1% argument reaches the script verbatim and runs nothing"; in test/dashboard-project-trust.test.js, end to end through `autoLearnWhy`, "…refuses a pasted %CMDCMDLINE:~-1% token for a batch-file codex…" and "…runs the codex.cmd npm writes as its node script…"; in test/codex-validator-launch.test.js, "the validator runs the codex.cmd npm writes without cmd.exe…". With both (a) and (b) reverted, both end-to-end tests fail on F being created. |
| S2 (MEDIUM): a workspace `memory.dir` chose the corpus whose gate blocks became the user's standing orders in every project | **FIXED**, `84c14c7` | **Verified end to end** in a sandbox before the change: a temp HOME, a throwaway venv of the system python (with empty `onnxruntime` and `numpy` packages, because `recall.py` asks only `find_spec`), the repository's own `recall.py`, the real memoryLint and a stub vscode. The user had compiled and installed their own gate. With `memory.dir` set at the workspace tier only, to a folder inside the repository, one edit of the user's own memory file fired the `*.md` watcher. `gatesCorpusBump` then ran `--gates-compile` with that folder as `RECALL_MEMORY_DIR`, and 2.5 s later `ensureGates` had REPLACED the user's gate in the temp HOME's `~/.claude/CLAUDE.md` with the repository's. The chain: `memory.dir` had no scope; memoryLint's `cfg()` read it with `get()`, so a workspace won; `memoryReport()` returned it, and the gate compile, the recall rebuild and the recall sync all pass it on. **What changed:** `memory.dir`, `gates.enabled` and `guidance.enabled` are `"scope": "machine"`. `memory.dir` is read from `inspect().globalValue` in memoryLint's `cfg()`, and the two switches through a new `userSetting(key, fallback)` beside `codexExecutableSetting` in vscode-extension/extension.js, which takes the user tier's value only when it has the fallback's type. The two switches are in scope because each decides on activation whether the global `CLAUDE.md` and `AGENTS.md` carry a block. Read with `get()`, a workspace could install a compiled gates block the user had turned off, or strip a gates or guidance block the user keeps. The dashboard toggles already write the user tier, so they now agree with what is read. After the fix, the same sandbox recompiled from the user's own store, and a user-tier `memory.dir` was still honoured. **Residual:** a deliberate workspace-level pin of any of the three now has no effect. VS Code also leaves machine-scoped keys out of Settings Sync by default, so turning gates or guidance off on one machine no longer follows the user to another. The README rows say "Machine-scoped". **Not changed:** the `autoLearn.*` keys and `localDrain.enabled`. The census below gives each a verdict, and four are candidates. **Pinned by**, in test/machine-scoped-settings.test.js and each checked by mutation: "the manifest declares memory.dir, gates.enabled and guidance.enabled machine-scoped" (dropping any one scope fails it); "a workspace-level memory.dir is never the corpus compiled into the global gates, and a user-level one is", which drives the unattended recompile and records the corpus handed to python (reverting `cfg()` to `get()` fails both its workspace and its folder assertion); "a workspace can neither install the gates block a user turned off, nor strip one the user keeps" and its guidance twin (reverting either switch to `get()` fails both directions, each checked alone). Three harnesses that set these keys through `get()` alone (extension-activation, local-drain-extension, memory-lint-watchers) now report them as the user tier as well. |
| S3 (NOTE): `endTreeAfter` kept its timer armed when a spawn failed | **FIXED**, `4762a97` | **Verified**, measured with Node 24.19.0: a missing absolute path, a missing bare name and `spawn()` each emit `error` and then `close`, and never `exit` (`exitCode` -4058, no pid). A run that starts emits `spawn`, `exit`, `close`. The timer was cleared on `exit` alone, so the unref'd timer, and the ChildProcess it closes over, stayed for the whole deadline: 30 s, 60 s or 180 s at the extension's four sites. `endProcessTree`'s guard already made the late firing harmless. **What changed** (`src/exec-resolve.js`, `endTreeAfter`): the timer is also cleared on `close`, and on `error` only for a child that never started or has ended, because Node also emits `error` when a kill fails, and a child still running must keep its deadline. `trackChild`'s comment in vscode-extension/extension.js said a spawn failure "emits 'error' and never 'close'". It emits both, and the comment now says so. Its listeners were already right. **Pinned by** "a spawn that fails clears its endTreeAfter deadline, and a running child keeps its own until it exits" (test/exec-resolve.test.js), which records the handles `clearTimeout` receives. Each mutation fails it on its own assertion: `exit` alone (the old code) on the failed spawn; no `close` listener on a child armed after its exit (a real failed spawn is cleared by its `error` first); no `error` listener on a child that never started; clearing on any `error` on the control, a running child. |
| S4 (NOTE): the orphan sweep's cost was never recorded, and a residual claimed more than had been verified | **RECORDED**, `20d91dd` | Docs only, and nothing was re-measured here. The audit measured the sweep at about 0.7 ms cold and 0.3 ms warm per write, against a variant with only the sweep call removed (n=25 interleaved, 38 siblings in the directory; a bare readdir is 0.25 ms cold and 0.10 ms warm). That is now in "A held settings.json was rewritten in place by a hook that can be killed", in the v1.6.2 post-release audit section. The audit's push loop also left a suspended stand-in `app-server` (one suspended thread, 0 CPU) after a deactivate, and did not tell a tree kill apart from the host's exit. That is a NOTE row in "Process-spawn residuals", and the orphan row there no longer claims that deactivate's taskkill /T is unaffected; it says this is unverified. Not investigated further. |

### The settings census behind S2

Every configuration read in `vscode-extension/` and `src/` (the packed `vscode-extension/src/`
copy excluded; `src/` reads none), with what it feeds. "Machine" means `"scope": "machine"` and
a read from `inspect().globalValue`.

| Key | Feeds | Verdict |
|---|---|---|
| `autoLearn.codexExecutable` | every codex spawn | machine since `b7c9a8d`; cleared by the audit |
| `autoLearn.workerTimeoutSeconds` | the worker deadline that bounds teardown | machine; cleared by the audit |
| `memory.recallScript` | the python script the extension runs | machine since `177c901`; cleared by the audit |
| `backupMirrorPath` | where the allow and deny lists are copied | machine since `177c901`; cleared by the audit |
| `memory.dir` | the gate compile's corpus, then the global `CLAUDE.md` and `AGENTS.md`; the recall rebuild and sync | **machine, S2** |
| `gates.enabled` | installing or removing the gates block in those files, and arming the unattended recompile | **machine, S2** |
| `guidance.enabled` | installing or removing the guidance block in the same files | **machine, S2** |
| `autoLearn.mode` | in `auto-safe` each scan applies grants unattended to `~/.claude/settings.json` and `~/.codex/rules` (`applyUnlocked` in the manager's scan) | **CANDIDATE**, the strongest left. A workspace value skips the confirmation `cycleAutoLearnMode` shows before auto-safe. Bounded: auto-safe takes only deterministic read-only families proved by the user's own transcripts for this workspace, the same class as the drain's accepted risk below. Not changed here, because `cycleAutoLearnMode` deliberately writes the workspace tier when one exists, so whether a mode may be per-workspace is a product decision. **Since 2026-10-15, tighten-only**: see "Workspace settings may only tighten (2026-10-15)" |
| `autoLearn.successThreshold` | how many successes an auto-safe grant needs (floor 1) | CANDIDATE with `mode`: it lowers the bar only once auto-safe is on. **Since 2026-10-15, tighten-only**: see "Workspace settings may only tighten (2026-10-15)" |
| `autoLearn.codexScope` | `user` lets an apply write `~/.codex/rules`; `off` stops it | CANDIDATE with `mode`: a workspace can turn Codex export back on for a user who chose `off`. **Since 2026-10-15, tighten-only**: see "Workspace settings may only tighten (2026-10-15)" |
| `localDrain.enabled` | promoting a workspace's `.claude/settings.local.json` into `~/.claude/settings.json` | CANDIDATE, low: a workspace can turn the extension's drain back on for a user who turned it off. What moves is the workspace's own file, which is the accepted risk in "The CLI drain has no trust gate" (2026-09-24), and the hook drains that file with no setting at all. **Since 2026-10-15, tighten-only**: see "Workspace settings may only tighten (2026-10-15)" |
| `autoLearn.enabled` | the scan, which reads history and writes only the learner's own state | safe: nothing is granted outside auto-safe. **Superseded 2026-10-19, tighten-only**: a workspace `true` re-enabled scans, and so unattended auto-safe grants, for a user who had turned Auto Learn off with mode auto-safe; see "Toggle Auto Learn, and `autoLearn.enabled` made tighten-only (2026-10-19)" |
| `autoLearn.intervalMinutes`, `autoLearn.debounceSeconds` | scan cadence, floored at 1 min and 1 s | safe: cost only |
| `autoLearn.mode` through `inspect()` in `cycleAutoLearnMode` | which settings tier the mode toggle writes | safe: it writes VS Code settings only. Since 2026-10-15 a step above the user's mode writes user settings (same section) |
| `memory.enabled` | the Claude and Codex memory lints, which read | safe |
| `memory.lineBudget`, `memory.maxLines`, `memory.totalBudget` | what the lint reports | safe |

## Process-spawn follow-ups (2026-10-14)

Three follow-ups to "Process spawns: the v1.6.3 lifecycle and performance confirmation", below,
each re-verified in the code before it was changed.

### Bare-name spawns: the census — FIXED

1e11efa fixed this for taskkill. The premise, re-measured with libuv 1.52.1 and Node 24.19.0:
handed a bare name, libuv looks in the CURRENT DIRECTORY before PATH, and the directory is the
child's `cwd` option when one is given, the spawner's otherwise. A copy of node named
`python.exe` in that directory answered a bare `spawnSync('python')` in place of Python 3.14.
Only the SPAWNING process's own environment can turn it off, with
`NoDefaultCurrentDirectoryInExePath` (libuv asks `NeedCurrentDirectoryForExePathW`, which reads
the caller's environment). Setting it in the child's `env` did nothing, and with it set in the
spawner the copy did not run. The agent shell this was measured from sets it, so every test
below deletes it from the process that spawns.

The census covers every `spawn`, `spawnSync`, `execFile` and `fork` in `src/`, `bin/` and
`vscode-extension/` (the packed `vscode-extension/src/` copy excluded). The registered
PostToolUse hook spawns nothing; `bin/wildcard-perms` has one spawn, behind `--gates`.

| Site | Program | Runs in | Bare name before | Planted copy could run | Disposition |
|---|---|---|---|---|---|
| `--gates refresh` (`bin/wildcard-perms:1150#resolvedLaunch`) | `TOOLBOX_PYTHON`, else `python` | a SessionStart hook's cwd, the session's project (no installer registers one; a user can), or the shell's | yes, whenever `TOOLBOX_PYTHON` is unset | **yes**, reproduced | **FIXED**: found on PATH; nothing found still reads "spawnSync python ENOENT" |
| `execFileCaptured` in vscode-extension/extension.js, "Why did this prompt?" | `autoLearn.codexExecutable`, default `codex` | the extension host's: wherever VS Code was started, per 1e11efa (not re-measured; listing a live host's directory handle needs elevation) | yes: commandLaunch handed an unresolved name back bare | **yes**, reproduced | **FIXED**: rejects with "spawn codex ENOENT", the words execFile used |
| The version probe, both doors (`src/codex-version.js:254#commandLaunch`, `src/codex-version.js:311#commandLaunch`) | the located codex | `--learn status`: the shell's; the dashboard probe: the host's | only when the second PATH walk, made after the location was cached, found nothing | in that window only | **FIXED**: launches the identity's own file, so the launch and the cache key are one file |
| Every `.cmd`/`.bat` launch (`src/exec-resolve.js:161#systemProgram`) | `ComSpec`, else `cmd.exe` | every caller's | yes, with ComSpec unset or relative | then | **FIXED**: ComSpec only when absolute, else System32's |
| The PATH walk itself (`src/exec-resolve.js:87#isAbsolute`) | any | — | — | yes, through a relative entry: `.`, or an unexpanded `%VAR%\bin` that a REG_SZ PATH leaves literal | **FIXED**: absolute entries only |
| `defaultCodexValidator` in src/auto-learn-manager.js (the Auto Learn `execpolicy check`) | `codexExecutable`, default `codex` | the Auto Learn worker thread's (the host's); `--learn`: the shell's | no: unresolved on Windows throws its "codex executable not found" | no | none |
| `nativeRpc` and `nativeRpcAsync` in src/codex-mcp-config.js | `nodeExecutable`, default `node` | the caller's | no: unresolved throws | no | none |
| The config worker's app-server | `npmShimLaunch`'s node, else commandLaunch | `request.home` | no: unresolved is "Codex executable is not reachable" | no | none |
| `endProcessTree`, the worker's grace kill | `taskkillPath()` | — | no, since 1e11efa | no | none; the grace kill is the next entry |
| `npmShimLaunch`'s node | the shim's own `node.exe`, else PATH's | — | no: none found returns null and the `.cmd` route is used | no | none |
| `run` in src/codex-recall.js | an absolute `pythonExecutable`, an absolute existing `TOOLBOX_PYTHON`, or the toolbox manifest's absolute path | the worker's | no: anything else is the lexical fallback | no | none |
| The recall rebuild, sync and gate compile (three `execFile(st.py, …)` in extension.js) | `toolboxPython()`: `CODEX_TOOLBOX` or `%LOCALAPPDATA%\DevToolbox`, then `python\.venv\Scripts\python.exe` | the host's | no: a path, checked to exist first | no; a relative `CODEX_TOOLBOX` would be the user's own environment | none |
| src/spawn-thread.js's `execFile` | the caller's file: only the version probe | the host's | as the probe | — | covered by the probe row |
| `new Worker()` (spawn-thread, autoLearnWorkerRunner) | a module path, not a program | — | — | — | not a spawn |

**ACCEPTED-RECORDED, POSIX.** execvp walks PATH alone, so no site above searches the cwd
there. An empty or relative PATH entry is a cwd lookup that the user's own PATH asked for,
and execvp honours it; nothing here changes POSIX. **Not in the census:** the `scripts/`
harnesses spawn bare `taskkill`, `git` and `powershell.exe`, and some spawn
`commandLaunch('codex')` without checking it resolved. They are maintainer tools run from the
checkout and are not shipped.

**What changed.** `resolvedLaunch(name, args, syscall)` (`src/exec-resolve.js:180#resolvedLaunch`)
is commandLaunch that never returns a bare name. On Windows an unresolved name throws the error
spawn raises when there is nothing to find, in its words: `<syscall> <name> ENOENT`, code ENOENT,
with spawn's `syscall`. The hook's compile and `execFileCaptured` use it, the second inside the
promise, so it is a rejection there as before. extension.js is line-neutral. The version probe
launches `id.resolved`. On POSIX that is the file `walkFor` found, which is the one execvp would
run. A python found through PATHEXT can now be a `.cmd` or `.bat`, such as a pyenv-win shim, and
it runs through cmd.exe. A bare spawn skipped those, because libuv tries `.com` and `.exe` only.

**Pinned by**, each confirmed to fail with its own fix reverted:
- "CLI --gates refresh never runs a python planted in the project directory it runs in"
  (test/cli-gates.test.js). Reverted, the planted copy ran `recall.py --gates-compile`.
- "\"Why did this prompt?\" refuses a codex name PATH does not hold, and never runs the copy in
  the host's cwd" (test/dashboard-project-trust.test.js). Reverted, the planted copy ran the
  `execpolicy check` arguments.
- "the version probe launches the file its identity resolved, not whatever a second PATH walk
  finds" (test/codex-version.test.js). It covers both doors, each reverted separately.
- In test/exec-resolve.test.js:
  - "a name nothing on PATH holds is refused before spawn, so a copy planted in the current
    directory never runs". Its precondition runs the hazard for real.
  - "a relative PATH entry is never searched, so \".\" and an unexpanded %VAR% entry cannot
    supply a program".
  - "a batch shim runs System32's cmd.exe when ComSpec is missing or not a full path".
- Neutering `resolvedLaunch` alone fails both call-site tests as well.

### The config worker's grace kill read `exitCode` alone — UNREACHABLE as shipped; FIXED anyway

**Verified in form.** The kill in the worker's `finally` (src/codex-mcp-config.js) skipped a
child only when `exitCode` was set. A child that exited by a signal has `exitCode` null and
`signalCode` set, so this is the shape 6dfe60b fixed in `endProcessTree`. **Refuted as a live
defect**, measured on this box with Node 24.19.0:
- On Windows, `signalCode` is set only when THIS process ends the child with `child.kill()`
  (`SIGTERM`, exit code null). An outside `taskkill /F` gives exit code 1 with no signal, and
  an exit by itself gives its own code. libuv sets the exit signal only in `uv_process_kill`,
  and the worker never calls `child.kill()` on Windows.
- On POSIX the old branch was `child.kill('SIGTERM')`. After 'exit', Node's `kill` finds
  `_handle` null and returns false without signalling (read from Node 24's own source; the
  probe returned false on all three exit kinds).

**What changed.** The grace kill is now `endProcessTree(child)`. Its guard reads both codes,
and on Windows it runs System32's taskkill /T. On POSIX it tries the group signal, which fails
with ESRCH because the app-server leads no group, and then calls `child.kill()`, exactly what
the old branch did. One guard for every tree kill means a later `child.kill()` in the worker
cannot make the old shape reachable. Its Windows taskkill is now asynchronous; the worker was
only awaiting 'close' anyway. Pinned by "the config worker's grace kill skips an app-server
that exited by a signal, and still ends a live one" (test/codex-mcp-config.test.js,
Windows-only, because on POSIX the two versions behave the same). It drives the state in the
real worker. The stand-in's node refuses `initialize`, so the worker reaches its `finally` only
once that node is running, and as the `finally` begins a preload kills the `.cmd` stand-in's
cmd.exe, so the exit is by a real signal. The node under it holds stdout, so 'close' comes 3 s
after the 1 s grace. The preload records every taskkill and runs none, and each run is bounded
at 30 s. Under the old kill it recorded
`taskkill /PID <the signalled PID> /T /F`, 1.0 s after that PID's exit. Its control, a live
app-server, records the tree kill with the fix in place. 1e11efa's planted-taskkill worker test
still fails with taskkill named bare, now in `endProcessTree`.

### The push bench is in the repo — DONE

`scripts/measure-push-host-thread.js` is the measurement behind the push figures in "Process
spawns", below. Until now it lived outside the repo as four files (the bench, a PowerShell
loop and two summarisers); it is now one script. Usage is in its header. What it guarantees:
- Every sample is a fresh process, the trees alternate sample by sample, and it reports n and
  p50 [min-max].
- A tree is this checkout, or any revision extracted with `git -c core.autocrlf=false archive`
  into its own temp dir.
- It writes only under one temp dir it creates, and checks every write against that dir. A
  sample's HOME, USERPROFILE, CODEX_HOME, TMP, TEMP, APPDATA and LOCALAPPDATA all point there,
  and the sample asserts this itself before it runs anything.
- The provider credentials are removed using the one shared list,
  `PROVIDER_CREDENTIAL_ENV`, plus the rest of the `OPENAI_` and `AZURE_OPENAI_` families.
- The codex it is given is executed only, never written. A Codex install location (winget
  Links and Packages, npm's global folder, the folder and link target of the given codex and of
  PATH's) is never written, and `--tmp` inside one is refused before anything is created. A
  temp dir inside the checkout is refused as well. Tested against fake roots: all three
  refusals fire, and nothing is created.
- `--stand-in` writes a node stand-in into the temp dir, for a box with no codex.

**Re-run 2026-10-14** with the real winget codex.exe 0.161.0, n=11, `--before 2d8d223^ --after
2d8d223`, on a box shared with another worktree's suite runs:

| p50 [min-max], ms | a140dc5 | 2d8d223 | recorded |
|---|---|---|---|
| Cold push, push → next setImmediate | 704.7 [662.4-724.6] | 21.2 [19.3-55.0] | 673 → 20 |
| After a config.toml edit | 225.9 [218.6-232.4] | 8.8 [8.0-9.9] | 218 → 8.1 |
| Warm push | 7.6 [6.8-8.2] | 7.4 [7.0-10.5] | 7.2 → 7.0 |
| Loop-delay max: cold, after an edit | 707.8, 226.1 | 21.6, 16.1 | 674 → 20.6, 218 → 16.1 |
| Both answers on screen after a cold push | 1,762 | 1,318 | 1,586 → 1,229 (n=7) |

The order of magnitude reproduces, and the "before" column is about 5 % above the recorded
figures, inside this box's process-level swing (see the MEASUREMENT HAZARD in the v1.6.2
section). This branch against its base fb5f44f (n=7, same codex) measured: cold 22.7 against
22.3, after an edit 9.0 against 9.1, warm 7.5 against 8.0. The bare-name and grace-kill changes
cost the push nothing measurable.

### Process-spawn residuals — ACCEPTED-RECORDED

Recorded as facts in "Process spawns", below. Each is given its disposition and reason here, and
the rows there point back to this table. The spawn costs are how long `execFile()` holds its
caller inside CreateProcess, p50, n=15, measured 2026-10-14: the DevToolbox venv `python.exe`
138 ms, taskkill 60 ms; the same row below has node 207 ms, cmd.exe 74 ms and the real winget
codex.exe 465 ms.

| Residual | Reason |
|---|---|
| The extension's four `execFile` sites still spawn on the extension host thread | None of them is on the dashboard push. Two run only when the user acts: the recall rebuild button (venv python) and "Why did this prompt?", whose `execFileCaptured` costs one CreateProcess per variant (74 ms through an npm `.cmd`, 465 ms for the winget exe) while the user waits for its modal anyway. Two run in the background, and rarely: the recall sync, at most once per 15-minute cooldown and only when the index is behind its corpus, and the gate compile, which runs after a 2 s debounce on a memory-file change while gates are on (or when the user picks "Compile now"). Each costs one 138 ms venv-python spawn. Moving them is mechanical if that is ever wanted: src/spawn-thread.js's `execFileOffThread` already carries the version probe's execFile. |
| Deactivate's own taskkill runs on the host thread | It is one taskkill (60 ms) per child still tracked on the host, and only the four sites above put children there, because a ThreadChild is ended by its own thread. Deactivate runs once per window lifetime, and the host is being torn down. A thread would have to start during that teardown, and the kill would then depend on it starting at all, when the kill matters most. |
| A parent killed during CreateProcess can leave an orphan | First observed when a whole running suite was killed from outside (see the npm-shim row below). **Reproduced 2026-10-14**, by accident, in the first version of this branch's grace-kill test, under two suites at once. Its preload killed the stand-in's cmd.exe 1.25 s after the spawn, while cmd.exe was still inside CreateProcess for node. Ten minutes later that node had one thread and 0.00 s of CPU: created and never resumed. It held the stdout pipe it inherited, so the worker's 'close' never came. Ending the node released the worker at once. So the orphan is a SUSPENDED process that never runs. Its only harm is the handles it inherited: here, a pipe whose reader then waits for ever. The mechanism is inferred, not measured inside Windows: CreateProcess resumes a child's first thread at its very end, so a parent killed before then leaves the thread suspended, and the child is outside libuv's job as well. Nothing in JS can close that window. It needs the host or a worker to die outright inside a CreateProcess, and it costs one suspended orphan per such death. Deactivate's taskkill /T runs while the host is alive, which was taken to mean it is unaffected. That is UNVERIFIED: see the NOTE row below. The test now kills only a stand-in that is already running. |
| The planted-taskkill worker test failed once under four concurrent test files (5.4 s) | It passed alone, in every later batch (ffa334f), and in every full run of both suites on wave-f10. Its budget is the worker's 1 s deadline plus a 1 s grace inside a 4 s backstop, and endpoint scanning held a freshly copied executable's first run for about 3 s here (the planted copies above took 3.0–3.4 s). That is the harness hazard 1e11efa recorded, and the reason the test has two witnesses. Since ffa334f every message carries the host's answer and the elapsed time, so a recurrence says which path won. The behaviour it pins has a second, single-process witness in test/exec-resolve.test.js. |
| NOTE (the final pre-tag audit, 2026-10-14): a suspended stand-in app-server outlived a deactivate | The audit's own push loop left a stand-in `app-server` node with one suspended thread and 0 CPU after a deactivate. The audit did not tell a tree kill apart from the host's own exit, so it is not known whether deactivate's taskkill /T missed this node, or whether the host's exit ended its parent while that parent was still inside CreateProcess, which is the orphan row above. Until that is told apart, "deactivate's taskkill /T is unaffected" is unverified for this case. Recorded only; not investigated. |

---

## The v1.6.3 release commit's CI failures (2026-10-14)

CI run 38525363435 on `7cbba2b` failed 5 of 7 jobs; Windows Node 24 and the PowerShell 5.1
installer job passed. Two failures were test defects and one was a real POSIX defect. Reproducing
it found a second real defect. The confirmation audit added two LOW findings in the same files.

| Finding | Disposition | Evidence |
|---|---|---|
| `codex-version.test.js` cancelled on Node 20/22 | **FIXED (test)**, `09ced02` | The timeout case awaited the probe's deliberately unref'd timer, and the stand-in child is not a process, so nothing held the loop. Node 24's runner happened to keep its own loop alive. The test now fires the timer by hand and pins that it is unref'd. No product path awaits that timer alone: a real child is a ref'd handle, and `--learn status` probes synchronously (verified on Node 22). |
| Deactivate left a hung codex running on Linux | **FIXED**, `f8a3b92` | `execFile` copies a fixed option list to `spawn` and drops `detached`, so the trust worker never led a process group. The `-pid` signal therefore hit ESRCH. The worker is now `spawn`ed, and the app-server stays in the worker's group, so one signal ends the whole tree. Windows was never affected. |
| A worker whose host dies orphaned its codex | **FIXED on POSIX**, `c108d04`; Windows residual below | With the host SIGKILLed, the worker ran to its 25 s deadline and then died of an unhandled EPIPE before its armed kill fired; the codex was alive 30 s later. The worker now ignores stdout/stderr errors and watches its parent (ppid change or parent gone), which ends both within about 2 s. |
| The version-probe dashboard test raced on Linux | **FIXED (test)**, `5ab4cc5` | It assumed `--version` is slower than the 150 ms settle. That holds for cmd.exe → node, not for sh → node. The stand-in's `--version` is now gated. |
| `endProcessTree` could aim a tree kill at a freed PID | **FIXED**, `6dfe60b` | A signal-killed child has `exitCode` null and `signalCode` set; both are read now. Measured: at 'exit' the gap before 'close' is under a millisecond here. Unverified: taskkill /T walks ParentProcessId, which Windows does not clear when a parent dies. |
| A trust-ask timeout was cached for the life of the window | **FIXED**, `e79e2a9` | A timeout now stands for 60 s, and the next push then asks again. A codex that never answers costs one ask per minute of pushes, not one per push. Other outcomes are cached as before. |

**HARNESS HAZARD, 2026-10-14.**
- Linux in podman:
  - Stream `git -c core.autocrlf=false archive <rev>` into the container, not a folder subset.
  - Run with `--init`, because a zombie still answers `kill(pid, 0)`.
  - The node images have no git and run as root, so 13 tests fail there on any commit. Compare against a control run on the base commit.
- Windows: a `.cmd` stand-in's hidden console host keeps its cwd for about 1 s after the last client dies, and Node 24's `rmSync` does not retry that EPERM.

## The v1.6.3 confirmation audit (2026-10-14)

Two read-only audits re-checked `7cbba2b` against v1.6.2 before tagging. The first covered
regressions and dead code: suites green, and 281 common commands showed no new refusals; the
census catches planted defects. The second covered lifecycle and performance: no new leak, and
every figure at or better than v1.6.2. Their findings, beyond the two in the CI table above:

| Finding | Disposition | Evidence |
|---|---|---|
| A stored null-rule family that had not run since the upgrade could be written despite a user deny or managed ask (MEDIUM) | **FIXED**, `819e4ab` | Reproduced with no scan: a deny on `Bash(cargo --version *)` and a managed ask on `Bash(df -h:*)` listed as policy `unknown`, and a reviewed apply wrote both. `takeExporterRule` now runs first in `refresh` and sets the stored rule to what the write itself renders (`candidateClaudePermission`, now exported). Every reader judges the rule that lands. `revivesNullRule` (b4643ed) was a second, untested source of the same rule and is removed. Pinned by `test/auto-learn-null-revival.test.js`, which uses a scanner that throws if called. |
| A missing configured history root pinned the Codex evidence rebuild in silence | **FIXED**, `3ce06e0` | It blocks auto-safe and makes a reviewed apply throw, so it is a reason, not a note. `rebuildHeldOpenReason` names folders only and never a path, and fires only when a pending transcript was not found by the walk. The scan-health line's ✓ is a follow-up (BACKLOG). |
| A pending project-trust verdict rendered "No saved permissions yet" | **FIXED**, `8f2af8f` | The empty message also requires `codexCounted`. While the verdict is pending, the list ends with a "not listed yet" line. Controls cover the settled verdict and the truly empty case. |
| make's other program variables still rendered in Codex export | **FIXED**, `b9854f6` | Reproduced: 44 broad rows, for example `make AR=./x lib`. Refused now: every program in GNU make's built-in table outside VMS (`src/default.c`), the GNU Coding Standards program variables, and the built-in rules' full command lines (`COMPILE.*`, `LINK.*` and so on). Matching is case-exact. 18 data rows still render (VERBOSE, PREFIX, DESTDIR, CFLAGS, …). just is unchanged: measured with just 1.58.0, it has no built-in variables, and overriding an undeclared one is an error. **Revised 2026-10-14 by the lead's decision, L1:** matching is folded now, because a command-line variable also reaches every recipe line's environment, and a Windows child reads an environment name case-insensitively. So `make cc=x`, which this change pinned as rendering, is refused. The data rows still render. |
| `memory.recallScript` and `backupMirrorPath` were window-scoped | **FIXED**, `177c901` | Both are `"scope": "machine"`, read through `inspect().globalValue` like `autoLearn.codexExecutable`. A workspace value is never used. |
| The push figures left out CreateProcess time on the host thread | **FIXED**, `2d8d223` | MEASURED: `execFile` blocks its caller inside CreateProcess, at p50 428 ms for the real winget `codex.exe` and 203 ms for node. The recorded "106 ms cold" held only with a `.cmd` stand-in. Both of the push's spawns now start from worker threads: see "Process spawns: the v1.6.3 lifecycle and performance confirmation (2026-10-14)", which has the corrected figures. |
| The hook's in-place fallback could empty settings.json under a teardown kill | **FIXED**, `3c2724d` | See "A held settings.json was rewritten in place by a hook that can be killed" in the v1.6.2 post-release audit section. |

## The v1.6.2 post-release audit (2026-10-14)

Four read-only audits ran over the released v1.6.2: regressions, dead code and dead ends,
lifecycle and leaks, and performance. The live hook path and every standing decision were
intact; a differential over the new matcher axes (wrappers, safe and kept environment variables,
xargs, star-free rules) found 0 disagreements between the coverage index and a full scan in
18,000 cases, and every generalizer difference against v1.6.1 over 140,000 entries was a stated
narrowing or the documented wrapper re-key. Everything below was found by those audits and fixed
or recorded the same day.

| Finding | Disposition | Evidence |
|---|---|---|
| The dashboard push blocked the extension host on a synchronous Codex `config/read` | **FIXED**, `c85c10d` | Introduced by the trusted-project discovery. The push now reads the trust verdict from cache, a miss refreshes in the background (tracked, 10 s bound (25 s since efeb0c1), tree-killed on deactivate), and only `.codex` folders with `rules/` are asked about. Cold push 1,106 → 106 ms, push after a `config.toml` edit 980 → 9 ms, a Codex that never answers 31,331 ms → under 120 ms. **CORRECTED 2026-10-14:** the "after" figures hold only for the `.cmd` stand-in they were taken with. With the real winget codex.exe the same push held the host 673 ms cold and 218 ms after an edit (p50, n=11; scripts/measure-push-host-thread.js), because the spawns it started block the calling thread; both now run on worker threads, see "Process spawns: the v1.6.3 lifecycle and performance confirmation". |
| `autoLearn.codexExecutable` was window-scoped | **FIXED**, `b7c9a8d` | A workspace setting chose the executable the push now runs. Machine scope, read from the user tier only. (VS Code already disables the extension in Restricted Mode, because it declares no `untrustedWorkspaces`.) |
| A rebuild could finish while a Codex root was missing | **FIXED**, `7ce6217` | A vanished root read as a clean walk, so pending ids were dropped and auto-safe could grant against a failure in that root (reproduced: granted on scan 2, revoked on scan 3). A missing configured root now holds the rebuild open; an `archived_sessions/` that never existed is benign, a dangling link there is not. |
| Reviewed Claude rules for informational forms disappeared, and an upgrade revoked them | **FIXED**, `3417398`, `bee0f82` | The exporter honoured an explicit null rule on the false premise that every withholding reason was also a complexity reason. The learner now writes the informational word, and only an env-kept assignment withholds a rule. Families stored with a null rule were revived on their next run (`b4643ed`); until that run the managed-inert and user-deny checks still judged the null while the write rendered the derived rule (F1 of the v1.6.3 confirmation audit, reproduced: a reviewed apply of stored state wrote a user-denied and a managed-ask rule). The rule is now derived on load by the exporter function the write calls (`takeExporterRule`), which replaces the next-run revival. |
| Codex export bypasses and gaps | **FIXED**, `4a02252`, `09df009`, `bee0f82`, `e6d227c`, `f23e978`, `08978d9`, `c16728e`, `1d66310`, `b11038d`, `453c980` | Versioned and aliased interpreter names and `.cmd`/`.bat` spellings normalize to their base for every refusal table. hyperfine and wsl render only measured informational forms; duckdb runs an init file's `.shell` even under `--version` (measured) and is broad at any depth. iex, Invoke-Expression, Invoke-Command and icm are broad. bunx, pnpx, `deno x` and `dx` are judged as their long forms. A runner `-e` value that loads or names a program, any `--env-file`/dotenv option, a make or just override that chooses the recipe shell, and node's `--openssl-config` / `--experimental-config-file` make a prefix broad. The exporter header now states the governing principle (narrow only when the program is pinned and every option is modelled inert) so a later residual is judged by it rather than by a new audit. **ACCEPTED-RECORDED:** tokens after a fixed subcommand or task target stay unread (make excepted), so `npm test --node-options=…` is admitted; refusing it would refuse `npm test`, which already runs whatever the package script says (measured with npm 11.17.0). |
| `bash -C <script>` widened unrecorded | **CORRECTION** | `668a685`'s "none went the other way" held for its 132-prefix probe, not the whole space: `["bash","-C","x.sh"]` was refused before only because the old check lowercased `-C` (noclobber) to `-c`. Benign — noclobber runs nothing and the prefix pins the script. |
| The starter pack tripped its own diagnostic | **FIXED**, `0b063ed` | `Bash(export *)` (in the pack since v1.0.0, not one of the 13 maintainer-kept grants) is removed; the 13 are exempt from the over-broad count by one shared list with a drift test. |
| The Codex memory lint missed dangling references in common Markdown spellings | **FIXED**, `9d5f622` | The token boundary aimed at a `skills/` false positive also silenced `**rollout_summaries/x.md**`, `./…`, `|…|`, `label:…`. |
| A dead branch with a false mutation claim | **FIXED**, `ddbb329` | Reachable after all (a stripped wrapper followed only by assignments); now pinned by a test. |
| Lifecycle and cost | **FIXED**, `c85c10d`, `d27ac77`, `dde59b0`, `1828046`, `e8c74e6`, `a16e586`, and the atomicWrite commit after them | The version probe's resolved path is cached (597 → 5 stats per push); one cache slot per executable; a deactivate kill is never cached as a timeout; tracked children are ended as process trees (an npm `.cmd` shim left its grandchildren running); the project-trust cache holds parsed trust only, never `config.toml` text; download retries carry the activation generation; the scan-trouble log keys on kinds of trouble. The history-store probe reads thread ids from the projection table alone and reuses the scan's own listing: 247.9 → 23.3 ms on a 1M-item synthetic home, verdicts identical. One rename-retry policy (codes, ten attempts, 0.9 s) is shared by every writer. |
| Dead code and duplication | **FIXED**, `1e70869`, `3579e52`, `5e51476`, `9166322`, `d9c6103`, `309e00d`, `7a8d968`, `63bc23c`, `2e727e0`, `10398ba`, `cd839bc` | A full `processAllowList` pass per push fed a field nothing rendered; it and other unread payload fields, a dead message route, unsupplied option keys and dead `scripts/` exports are gone. The census counts an import only when its name is used, audits `scripts/` and reads git's tree; new tests assert every payload field has a reader and every message route a sender. `RISK_RANK`, the rename-retry set and the harness credential list each have one copy; the Codex version record and `permissions.js`'s require closure are pinned by tests. |
| Installers | **FIXED**, `d7e936e`, `592bf06` | Spaced and `/cygdrive/` spellings are recognised and spaced registrations quoted; `uninstall.sh` folds case only on Windows. |
| CI exposure | **FIXED**, `0c0f549` | `vsce` pinned to 4.0.0 and packaged on Node 22 (it declares Node ≥ 22; Node 20 is end-of-life); a Node 24 leg matches the extension host's runtime. |
| The hook blocked every Bash/PowerShell call | **FIXED in the installers**, `c56ebdb`; live registration a maintainer decision | The installers write `"async": true`: documented on code.claude.com/docs/en/hooks (read 2026-10-14), first in Claude Code 2.1.15, and every client from 1.0.82 to 2.1.14 parses hooks with a non-strict schema that strips the key, so the hook simply stays synchronous there. Concurrent runs are covered by the policy lock and the idempotent pass. Recorded cost: under `claude -p` a still-running async hook is killed at teardown, so a rare in-place settings write could be cut short — the reason applying it to an existing registration is the maintainer's call. |
| A lost failure across a session switch | **ACCEPTED-RECORDED**, `4eb4177` | No real rollout writes a `session_meta` mid-file (13 rollouts, 704 calls surveyed); the verdict is pinned by a test. |

**MEASUREMENT HAZARD, 2026-10-14.** This box no longer matches the protocol's baseline: a bare
`node -e 0` costs about 330 ms (Git Bash plus node about 550 ms) under endpoint security, against
the ~50 ms the noise floor at the top of this file assumes, and process-level deltas swung by up
to 15 ms between runs. A process-level A/B here needs in-process timing or a much larger n. The
same day, under four concurrent worktrees driving Codex, one `codex execpolicy check` contract
run took 547 s of repeated 60 s timeouts and passed in 20 s alone — the timeouts held, and the
product's validator (30 s, in the Auto Learn worker) is off the extension-host thread.

### A held settings.json was rewritten in place by a hook that can be killed — FIXED, `3c2724d`

Found by an audit on 2026-10-14, after the installers began registering the hook `"async": true`
(the table's "hook blocked every Bash/PowerShell call" row, whose recorded cost this closes for
every write the hook makes). `writeFileAtomicSync` (`src/permissions.js:29#writeFileAtomicSync`) writes a
unique `<target>.<pid>.<base36>.wc.tmp`, retries the rename ten times (0.9 s), and then used to
write the target IN PLACE: truncate, then fill.

| Measured by the audit | |
|---|---|
| Fallback rate, uncontended | 0 of 380 writes |
| Fallback rate, another process holding settings.json for 0.9 s or more | every write, even when the holder shares delete |
| The truncating open | waits about 90–120 ms in the endpoint scanner first |
| The window that follows | settings.json reads 0 bytes for p50 0.36 ms, max 1.2 ms |
| Loss rate | ESTIMATED, not measured: about 3×10⁻⁴ per fallback write that overlaps a `claude -p` teardown |

Why it mattered: `claude -p` kills a still-running async hook at teardown, and a kill inside the
window leaves settings.json EMPTY, with deny rules, hooks and env gone. Rare, and the worst outcome
this tool can produce. Re-verified before anything changed: a second Node process holding the file
through Node's own open (which shares read, write and delete) made `writeFileAtomicSync` spend
986 ms on refused renames and then write in place, with the fallback warning.

**What changed.**
- `writeFileAtomicSync(target, content, { inPlaceFallback })`, default `true`, which is the old
  behaviour. Under `false` (`src/permissions.js:94#inPlaceFallback`), once the retries run out the
  temp is unlinked, the target is left byte-identical, and it throws `SETTINGS_CONTENDED_CODE` with
  the refused rename as its cause. A rename failure no retry fixes (EXDEV, ENOENT) is thrown as
  itself, so the hook never waits in silence for a holder that does not exist. Against the same
  holder: 963 ms, then the coded throw, the file unchanged, no temp, no warning.
- `SETTINGS_CONTENDED_CODE` is now defined at `src/permissions.js:928#SETTINGS_CONTENDED_CODE`,
  because that module may require only `./permission-match`. `src/settings-write.js:20#SETTINGS_CONTENDED_CODE`
  imports and re-exports it, so there is one definition and every existing reader is unchanged.
- The option is plumbed through `createSettingsWriter` (`src/settings-write.js:148#inPlaceFallback`)
  to both of its writes, and through `drainLocalSettings` (`src/local-settings.js:219#inPlaceFallback`)
  to the drain's snapshot and its prune.
- The hook passes `false` for every write it makes: the wildcarding write
  (`bin/wildcard-perms:609#inPlaceFallback`) and the drain (`bin/wildcard-perms:645#inPlaceFallback`),
  which carries it to the promotion into settings.json and to the snapshot and prune of
  settings.local.json. CONTENDED is handled like a busy policy lock
  (`bin/wildcard-perms:638#SETTINGS_CONTENDED_CODE`): exit 0, nothing on stderr, nothing written,
  and the next tool call redoes the pass, which is idempotent. The fixed-point cache needed no
  change. It writes with a plain `writeFileSync`, where a torn key is a miss, and the hook records
  a key only for bytes it verified as a fixed point, never after a write attempt. So a contended
  pass leaves no key, and the next call is a miss that redoes it.
- A held drain SNAPSHOT now stops the prune instead of being skipped
  (`src/local-settings.js:182#SETTINGS_CONTENDED_CODE`). Writing it in place could empty the whole
  history. Skipping it and pruning anyway would leave that round out of the only record of what
  the project had approved. Stopping costs nothing, because the next call does both.
- The orphan sweep (`src/permissions.js:954#sweepOrphanedTemps`). Nothing ever removed the temp of
  a writer killed inside its retry window, which is a full copy of settings.json. Each write now
  removes sibling files that meet all three tests: the name is exactly
  `<basename>.<digits>.<base36>.wc.tmp`, matched as a literal prefix and suffix so no basename
  character is read as regex syntax; lstat says regular file; and the mtime is more than ten
  minutes old (`ORPHAN_TEMP_MIN_AGE_MS`). A live writer's temp lives about a second. The cost is
  one readdir, paid only when a write happens. Every error is swallowed, and the sweep runs on both
  paths.
  - **Measured cost** (the final pre-tag audit, 2026-10-14): about 0.7 ms cold and 0.3 ms warm
    per write. That is against a variant with only the sweep call removed, n=25 interleaved, with
    38 siblings in the directory. A bare readdir there is 0.25 ms cold and 0.10 ms warm. Both
    are below the ~2 ms process floor, and both are paid only when the hook writes.

**Who still writes in place, and why.** Everything except the hook:
- the extension: its settings writer, its drain, its backup copies and its Codex config write;
- the user-invoked CLI verbs: `--bypass`, `--max off`, `--seed`, `--drain`,
  `--codex-workspace-rules remove` and `--codex-max off`;
- the guidance, derived-guidance, Codex hook, MCP config, legacy-backup and bypass-sidecar writers.

No teardown kills them mid-pass, and an update they drop would not be redone by itself, so the old
trade still holds for them. An extension host can also be killed at shutdown. If that is ever
measured, the extension can opt in with the same one option; `vscode-extension/extension.js` was
not changed in this pass. `atomicWrite` in src/auto-learn-manager.js and `strictWrite` in
src/codex-memory-gates.js never had a fallback: both fail closed.

**Pinned by** seven tests at the end of `test/settings-write.test.js`, and four at the end of
`test/cli-hook.test.js`. One of the four is Windows-only and holds the file with a real process.
Every test was run against a revert of its fix:
- Reverting all four source files at once fails every one of them except the control. The control
  passes at baseline and fails only when the default flips.
- Each of sixteen single-point mutations is killed by the test written for it. They cover the
  option branch, the sweep call, each plumbing site, the snapshot rethrow, an unescaped basename
  pattern, the age test, the isFile test, a hook that reports contention, a flipped default,
  contention reported for EXDEV, and a second definition of the constant.

**Residual, recorded.**
- A holder that NEVER lets go now means the hook never writes, in silence, where it used to write
  in place. Nothing measured on this box holds settings.json for longer than a scan. The extension
  and the verbs still write in place, and against a permanent holder the in-place write is exactly
  the risky one.
- When the wildcarding write is contended and a drain is also due, the drain's promotion can wait
  its own 0.9 s. A contended hook run is therefore bounded by about 1.8 s of retries, which the
  async registration keeps off the tool call.

## Process spawns: the v1.6.3 lifecycle and performance confirmation (2026-10-14)

The second confirmation audit of the 1.6.3 commit (lifecycle and performance, measured) found
four process-spawn defects, and CI run 38535034218 a fifth in the same worker. Each was
re-verified in the code before it was changed; the measurements below were taken again for this
record, on the development box, with the method named in each row.

| Finding | Disposition | Evidence |
|---|---|---|
| The dashboard push held the extension host for every spawn it started | **FIXED**, `2d8d223` | Verified: on Windows `spawn()` and `execFile()` return only once CreateProcess has. Measured here, how long spawn() held the calling thread (n=15, p50): node 207 ms, cmd.exe 74 ms, taskkill 61 ms, the real winget codex.exe 465 ms; the audit had 203 and 428 ms. The push ran the version probe's execFile inline and the trust worker's spawn in the microtask after it. **Design: one worker thread per spawn** (src/spawn-thread.js), running the existing code unchanged (the probe's execFile, and `nativeRpcAsync`) and holding the ChildProcess there. The host holds a ThreadChild, which `track` hands to trackChild, and `endProcessTree` ends it by asking the thread to run `endProcessTree` on the real child. So the tree kill, the POSIX group signal, the freed-PID guard, the 10 s backstop (25 s since efeb0c1), the worker deadline (counted from the host's call), the 16 MiB bound, the wordings, the one-refresh latch and the 60 s timeout TTL are the same code, not copies of it. The process tree is unchanged, so host death is too: measured, a host SIGKILLed with the thread in between still took its worker on Windows, because libuv's kill-on-close job belongs to the process. `new Worker()` costs the host 0.44 ms (p50, n=15), and a 700 ms spin on the main thread saw a longest gap of 4.1 ms while a thread spawned the real codex (5.1 ms with no spawn at all). **Declined, design (b): the trust ask itself on a thread**, which would also drop the node spawn. It makes the app-server a direct child of the host, which loses c108d04's host watch on POSIX (nothing would end a hung codex after a host death), it leaves the npm-shim residual on Windows as it is, and the node spawn is off the host thread anyway. **Measured** with the real codex.exe 0.161.0 (HOME, USERPROFILE and CODEX_HOME in a fresh temp dir, OpenAI variables removed) through the real `_push()` under the stub-vscode harness of test/dashboard-project-trust.test.js, a fresh process per sample, the tree before this change and after it interleaved, n=11, host-thread time from the push to the next setImmediate, p50: cold push with a project `.codex/rules` 673 → 20 ms, push after a config.toml edit 218 → 8.1 ms, warm push 7.2 → 7.0 ms. Reproduce with `node scripts/measure-push-host-thread.js --codex <codex> --before 2d8d223^ --after 2d8d223` (re-run under "The push bench is in the repo", above). The event-loop-delay histogram's maximum agrees: 674 → 20.6 and 218 → 16.1 ms, where about 16 ms is this box's timer floor. Both answers were on screen 1,586 → 1,229 ms after a cold push (p50, n=7), because the two spawns no longer queue on one thread. Pinned by "a cold push starts no process on the host thread, and both Codex answers still arrive" (test/dashboard-project-trust.test.js; fails with `offThread` dropped from either call) and by test/spawn-thread.test.js, whose tree-kill test fails with the thread ignoring the end request or with `endProcessTree`'s END_TREE branch removed. Still on the host thread: the extension's four execFile sites (user-initiated or background, not the push) and deactivate's own taskkill. Both are **ACCEPTED-RECORDED**, with reasons, under "Process-spawn residuals", above. |
| execFile's own `timeout` orphaned the program under a launcher | **FIXED** on Windows, `f1f2de1`; POSIX **ACCEPTED-RECORDED** | execFile's timeout is `child.kill()` on the one PID it holds, and on Windows each of the extension's four execFile children is a launcher: an npm `codex.cmd` (cmd.exe → node) for the 30 s `codex execpolicy check` in `execFileCaptured`, and the DevToolbox venv `python.exe` for the recall rebuild and sync (180 s) and the gate compile (60 s). That `python.exe` is a redirector whose interpreter is its child (measured: the interpreter's parent PID was the PID spawn returned). Ended that way the program kept running, and because it held the pipes it inherited, execFile's callback never came either; endProcessTree could not reach it afterwards, because it finds a tree by its root. Each site now takes its deadline from `endTreeAfter` (src/exec-resolve.js), the version probe's pattern: a timer of its own that tree-kills the still-live root. The four lengths and the reported wording ("Command failed: …" plus stderr) are unchanged. Pinned by "a deadline from endTreeAfter ends the program under a launcher, which killing the launcher alone leaves running" (test/exec-resolve.test.js; fails with the timer calling `child.kill()`) and "every execFile site takes its deadline from endTreeAfter, never from execFile's own timeout" (test/extension-lifecycle-async.test.js; fails with one site reverted). **POSIX:** endProcessTree reaches a whole tree only through a process group, and execFile cannot start a group leader (it drops `detached`, f8a3b92), so the deadline ends the child alone there, exactly as before. These sites have no grandchild on POSIX: a venv's python is the interpreter, `RECALL_REEXEC=1` suppresses recall.py's own re-run, and a native codex is one process. An npm-installed codex on POSIX is node → native codex; whether that launcher forwards SIGTERM was not re-verified here. |
| The trust worker's graceful timeout could lose to the host's backstop | **FIXED**, `a140dc5` | CI run 38535034218 failed "the asynchronous layers read does not block…" on Node 20 / windows-latest only ("unavailable: the worker timed out", 6,478 ms). Confirmed in the code, not reproduced on the runner: the worker armed `deadlineMs` (timeoutMs − 3 s) as a length, after its own start, its module load and its codex spawn, then spent a 1 s grace and a synchronous taskkill before it exited, so the graceful path needed startup plus taskkill under 2 s, in the 4 s test and the 10 s product budget alike. The deadline is now a time, `deadlineAt`, fixed when `nativeRpcAsync` is called (src/codex-mcp-config.js, "THE DEADLINE IS A TIME, NOT A LENGTH"), so the worker's start comes out of the codex's 7 s and the whole 3 s margin is left for the grace, the kill and the exit. Budget, grace, backstop and wordings are unchanged; a worker that starts after its deadline fails the call at once. Pinned by "a worker that starts after its deadline answers before the host's backstop" (a preload holds the worker 5.5 s, past the 5 s deadline of an 8 s budget; fails with the deadline made a length again). The original test still fails with `deadlineAt` dropped. |
| On Windows an npm `codex.cmd` outlived an extension host that died outright | **FIXED** for the shim npm writes; any other `.cmd` **ACCEPTED-RECORDED** | Verified in "a worker whose host dies outright" (test/codex-mcp-config.test.js): libuv puts every child in a kill-on-close job that allows silent breakaway, so the worker's job held cmd.exe and not the shim's node, which survived the host. The worker now launches its app-server through `npmShimLaunch` (src/exec-resolve.js). A `.cmd` whose text is exactly cmd-shim's (npm 7 and later; @openai/codex needs one of those), with a relative target that exists, runs as `node <target>`, using the shim's own node.exe or else node from PATH, as the shim itself would choose. That node is then the worker's own child, in the worker's job, and the native codex the npm launcher starts is in that node's job. Anything else returns null and launches through cmd.exe as before. Small and in one place: the worker's launch only; the version probe and the execpolicy check exit by themselves and keep the `.cmd`. Pinned by "the shim npm writes is run as the node script it names; every other shape is left alone" (test/exec-resolve.test.js). Its shim is generated by the cmd-shim (8.0.0 here) bundled with the running node's npm, so it is npm's own output, and six other shapes return null. Also pinned by "on Windows, an npm-shim codex dies with a host that dies outright" (test/codex-mcp-config.test.js), which fails with the worker back on `commandLaunch` alone. A winget or standalone codex.exe was never affected: it is the worker's direct child. **Residual:** a hand-written or other-generator `.cmd` still breaks away. Deactivate's taskkill /T still ends it; only an outright host death does not. S1's design leaves this as it was, because the node worker still exists (design (b) was declined). Observed once and not reproduced: when a whole running suite was killed from outside, an npm stand-in that a worker started at that same instant survived. That fits libuv adding a child to its job only after CreateProcess returns (200–470 ms here), so a worker killed inside that call leaves the child in no job. Unverified. **ACCEPTED-RECORDED** under "Process-spawn residuals", above. |
| Bare `taskkill` is resolved from the current directory | **FIXED**, `1e11efa` | libuv resolves a bare name itself and looks in the cwd before PATH unless the environment carries `NoDefaultCurrentDirectoryInExePath`. Measured (libuv 1.52.1, Node 24.19.0): with the variable unset, a copy of node named `taskkill.exe` in the cwd ran in place of System32's; with it set, it did not. The extension host's cwd is wherever VS Code was started, and the Codex config worker inherits it. The variable was set in the agent shell the audit ran from, and in neither the user nor the machine environment, so a test run from such a shell passes against the unfixed code: both new tests remove it. `endProcessTree` and the config worker's grace kill now run `taskkillPath()`, `%SystemRoot%\System32\taskkill.exe`. Pinned by "the tree kill runs System32's taskkill, not one planted in the current directory" (test/exec-resolve.test.js) and "the config worker's own kill runs System32's taskkill, not one planted in its cwd" (test/codex-mcp-config.test.js); each fails with its own site reverted. The planted copy's flag is not the only witness, because endpoint scanning can hold a freshly copied executable's first run past the kill's own timeout: the first test also requires that the node under a cmd.exe dies, which only `/T` does, and the second that the worker's own deadline is the answer. Same class, not changed here: `bin/wildcard-perms` spawns `TOOLBOX_PYTHON \|\| 'python'` by bare name, and `commandLaunch` hands an unresolved name back bare, which `execFileCaptured` then spawns. Both are fixed since, with the rest of the census, under "Bare-name spawns: the census". |
| The trust ask's 10 s budget ran out on a slow CI runner | **FIXED**, budget raised to 25 s (`PROJECT_TRUST_ASYNC_TIMEOUT_MS`, src/codex-policy.js) | CI run 38555104195 failed "a cold push starts no process on the host thread, and both Codex answers still arrive" on Node 20 / windows-latest only. The verdict settled after about 11 s, and the stand-in codex never wrote its `app-server` start mark. That reads as the 7 s worker deadline passing before the stand-in started; it is inferred, not measured on the runner. The same test passes in about 2.8 s under Node 20.20.2 here (3 of 3 runs), so this is not a Node 20 defect. The 10 s budget dated from when the ask held the extension host. Since 2d8d223 the ask runs on a worker thread behind a pending card, so a longer budget blocks nothing, and too short a budget turns a slow machine into a minute of the narrow fallback. The budget is 25 s, so the worker deadline is 22 s, inside the worker's own 25 s clamp, with the same 3 s margin. The cost: a codex that truly hangs shows the pending card for 25 s, not 10, before the fallback. The test now waits 30 s. Every other trust test passes an explicit `timeoutMs`, and the four affected files pass under Node 24.19.0 and Node 20.20.2. |
| A worker already past its deadline still spawned its app-server, only to kill it | **FIXED** (with this row) | The masked suite failed "a worker that starts after its deadline answers before the host's backstop" once on 2026-10-14, under the load of a second agent's full suite: 8,893 ms of an 8 s budget, "unavailable: the worker timed out". The worker read `deadlineAt` only after spawning the app-server. A worker whose own start had run past it therefore still paid for the spawn, the app-server's start, the 1 s grace and the kill, all inside the 3 s the host leaves for the grace and the kill alone. It now fails the call before it spawns anything (src/codex-mcp-config.js, "PAST ITS DEADLINE BEFORE IT STARTS ANYTHING"). Same wording, so the 60 s timeout retry still applies. The test now asserts that no codex starts. With the check reverted it fails on that assertion, because the stand-in writes its pid within the grace. It passes under Node 24.19.0 and Node 20.20.2. |
| The host read the trust worker's answer only when the worker exited | **FIXED** (with this row) | CI run 38600144147 failed "the asynchronous layers read does not block…" on Node 20 / windows-latest only. It ran 9.8 s against an 8 s budget and read "unavailable: the worker timed out". The worker answered at its deadline (5 s), but `nativeRpcAsync` parsed stdout only on 'close'. So the worker's 1 s grace, its tree kill of the hung codex and its exit all came out of the 3 s margin, and on that runner the backstop got there first. Now the worker ends its answer with a newline (JSON.stringify never emits a raw one), and the host settles the call the moment that line arrives (src/codex-mcp-config.js, "THE ANSWER IS THE LINE, NOT THE EXIT"). The backstop stays armed until the worker closes, so a worker that never exits is still tree-killed; it just no longer decides the answer. That also helps the product: on a slow machine the dashboard gets the timeout verdict on time, not after the cleanup. The test now reads the worker's state the moment the answer lands and requires it alive. With the early `answer(...)` call removed it fails on that assertion (confirmed 2026-10-14). Its codex-death wait is 10 s, not 2, because the kill now runs after the answer. The test's budget was also raised from 4 s to 8 s (`051f883`): a worker started past a 1 s deadline spawns nothing, so the pid file was absent under load. |

## Follow-ups to the v1.6.3 confirmation audit (2026-10-14)

Found while closing that audit's F1, F3 and F7 (G1 to G3), and two residuals recorded rather than closed (G4). Then the lead's answer to G4(b)'s question (J1), and a listing disagreement wave-f9 reported (J2). Then the lead's decisions on what J1 and J2 left for the lead (K1 to K3), and on what K1 and K3 left (L1 to L4). Then the last refusal items, the lead's decisions of 2026-10-14, closed as M1 to M6 (the convergence wave). Each was verified in the code before anything changed.

| Finding | Disposition | Evidence |
|---|---|---|
| A workspace folder could supply the recall script | **FIXED**, `8491e2c` (G1) | Past the user-tier setting (F7, `177c901`), the bundled copy and the dev layout, `recallScriptPath` probed each open workspace folder as the repo root, as a projects/ dir and as a .claude/ root, then `~/.claude/projects/permission-wildcarding`, the project's pre-rename name. Reachable only with the bundled copy missing, and then a repository's own `memory/recall.py` was the script the Codex memory worker, the recall rebuild and the gate compiler ran. The legs are gone and the callers' "not found" paths take over. The VSIX does ship the copy: `scripts/package.mjs` copies it into `vscode-extension/memory/` before vsce packages that directory, nothing in `.vscodeignore` or the manifest excludes it, and the installed 1.6.3 extension holds it. Nothing pinned that; `test/recall-script-path.test.js` now does, beside the four layouts. |
| A refused alternate spelling was written dead | **FIXED**, `f2c438a` (G2) | `applyUnlocked` judged a family's rule against the managed-inert and user-deny checks and then wrote every spelling the exporter renders, so a deny or managed ask covering only `Bash(git.exe status *)` left that entry in `allow` and the family reported applied with nothing withheld (reproduced on `b1cf72c`, fresh scan and stored state alike). The class F1 closed for a null rule, and older than F1. Each spelling is now judged by the same `refusal()` as the rule; a refused one is not added and is reported in `withheldByPolicy`, so that report is per spelling. **Decision:** the family's other spellings still apply. That mirrors the exporter, which emits an alternate only after the rule passes its safety gate and drops a failing alternate alone; a deny naming only `git.exe status` covers nothing `Bash(git status *)` grants. A refused rule still withholds the whole family, and a retained family with a refused rule gains no spelling (reported with `withRule`). Only additions are withheld: a spelling already in the file stays and stays claimed, by the gate's standing "new grants only" limit. The listing's `clone` keeps judging the rule alone, which is consistent with that decision. |
| A rebuild held open by a missing folder read "✓ cleanly", and a folder gone for good held it for ever | **FIXED**, `b541314` (G3); decision below | F3 (`3ce06e0`) put the reason on the hover and in the output channel, but the scan-health line still read "✓ last scan read N files cleanly" while the rebuild blocked auto-safe and made a reviewed apply throw for every family with Codex evidence. It blocks something, so it is trouble: a scan stat `codexRebuildWaitingFor` (folder names and a link marker, re-derived from the stored value on every load so no path survives) and the phrase "Codex rebuild waiting for a missing history folder (sessions) — reconnect or recreate it"; the collapsed row reads "scan degraded". The budget deferral stays catch-up, not trouble. |
| `make CFLAGS=-fplugin=./x.so` and `LDFLAGS=-Wl,-plugin=...` load code into the compiler, and render | **ACCEPTED-RECORDED** (G4) | Measured 2026-10-14 against `b541314`. A reviewed `["make", "CFLAGS=-fplugin=./x.so", "all"]` and `["make", "LDFLAGS=-Wl,-plugin=./x.so", "all"]` render as exactly those tokens, and `["make", "CC=./x", "all"]` is refused. They stay data by the standing decision that make's flags variables are data (the MAKE grammar's comment in `src/policy-exporters.js`, F6). The rule carries the literal the user reviewed, so it matches no other value in that position. What `./x.so` does is the project's own code, in the same sense a target's recipe is. The learner never proposes such a prefix: three Codex runs of `make CFLAGS=-fplugin=./x.so all` key as bare `make`, which is refused, so one reaches the exporter only as a reviewed rule. The one way past the literal is the continuation every prefix admits, the first limit the exporter's header records. make reads a later `CFLAGS=` as well, so the rule also admits `... all CFLAGS=<other>`, exactly as a reviewed `["make", "all"]` already does, and refusing the flag value would not close that. Revisit if flags variables stop being data, or if the continuation is ever closed for make. |
| A Claude env-led rule such as `Bash(AR=x cargo build *)` does not refuse `AR` or `LD` | **ACCEPTED-RECORDED** (G4) on the Claude half; the maintainer question is **ANSWERED** by J1, `0924a26` (below) | Measured 2026-10-14 against `b541314`, and the literal value is kept everywhere. The generalizer turns `Bash(AR=x cargo build --release)` into `Bash(AR=x cargo build *)`. Three runs of `AR=x cargo build --release` give the learner the family `bash:AR=x cargo build` with that rule, review-only, because `environment-prefix` keeps it off the automatic path, and the exporter renders it at review; `LD=./ld` behaves the same. The rule does not match `AR=./evil cargo build` or a bare `cargo build` (`ruleMatches`), and Claude Code strips a leading assignment only for its 39 known-safe names, which `AR` and `LD` are not. A value that is not plain (quoted, expanding, or holding `=` or `,`, such as `RUSTFLAGS=-Clinker=./x`) is keyed `NAME=<redacted>` and gets no rule. So the rule grants only the command the user ran, with the value they ran it with. Its continuation is open, as for every rule; `cargo build --config ...` is cargo's own option, the `npm test` class. **For the maintainer:** `PROGRAM_NAMING_ENV` refuses `CC`, `CXX` and `MAKE` on the premise that the value is the program, which holds as much for `AR`, `LD` and `RANLIB`. This acceptance rests on the kept literal, and that argument would cover `CC` too. Either those three are deliberate extra caution, or the build-program names join them (refusing more is the safe failure). **Answered 2026-10-14 by the lead's decision, carried out as J1 (`0924a26`):** the build-program names join the env-led refusal, refusing more being the safe failure and matching F6, and **for the Codex export only**. The Claude half is unchanged, and this row's acceptance stands there: `Bash(AR=x cargo build *)`, `Bash(LD=./ld cargo build *)` and `Bash(RUSTC=x cargo build *)` still render at review, because each keeps the literal value the user ran. `PROGRAM_NAMING_ENV` itself is unchanged, so CC, CXX and MAKE stay refused on both halves; the new names live in the Codex-only `codexEnvNameIsUnsafe`, because adding them to `PROGRAM_NAMING_ENV` would have refused this row's rule too. |
| The build-program names were refused only as make overrides, and a Codex prefix that opens with an assignment was judged by nothing | **FIXED**, `0924a26` (J1) | The lead's answer to the question above. Measured against `7d08ced`: of the 124 rows the new test refuses, 114 rendered, for example `["env", "AR=./x", "make", "all"]`, `["docker", "exec", "-e", "AR=./x", "ctr", "make", "all"]`, `["make", "RUSTC=./x", "all"]` and `["just", "AR=x", "build"]`. **`codexEnvNameIsUnsafe`** (`src/policy-exporters.js`) is `envNameIsUnsafe` plus F6's three make sets, reused whole, and cargo's program names. F6's sets fit as they are: GNU make turns every environment variable into a make variable, below the makefile's own assignments and above its built-in defaults (the GNU make manual's "Variables from the Environment" and "Variables Used by Implicit Rules"), and it reads MAKEFLAGS and MAKEFILES from the environment by name. The one difference from an override is that a makefile's own definition beats an environment value, which changes which rules a value reaches and not the verdict. cargo's names come from the Cargo Book's environment-variables and configuration pages, read the same day: RUSTC, RUSTC_WRAPPER, RUSTC_WORKSPACE_WRAPPER, RUSTDOC, RUSTFMT, their `CARGO_BUILD_*` spellings, `CARGO_TARGET_<triple>_LINKER` and `_RUNNER`, the four credential-provider variables, and CARGO_DOC_BROWSER (by the page's general key-to-variable rule). Every place the Codex export reads an assignment now uses that predicate: env's assignments, a container's `-e`, and make and just overrides. env's assignments include any `NAME=VALUE` env takes, so `COMPILE.c=` counts as well. Matching is case-exact, as F6's is. **The premise was half true.** `PROGRAM_NAMING_ENV` refused `env CC=...`, `-e CC=...` and a make or just override of CC, but never a prefix led by `CC=`. The learner never builds one, because its prefix is the command's. A reviewed or stored candidate can carry one, though, and every table read the assignment as the root: `["CC=./x", "make"]`, `["LD_PRELOAD=./x.so", "cat"]`, `["FOO=1", "bash"]` and `["FOO=1"]` all rendered. Such a prefix is now judged the way the Claude half judges an env-led rule: under review only, each assignment by the predicate, and the command after the assignments by everything. The validator judges such a pattern by its command too; before this, `["FOO=1", "curl"]` validated while `["curl"]` did not. Whether Codex ever matches a rule like that is not known: its checker matches raw argv and does not strip an assignment, and the runtime's handling of `VAR=value cmd` is unmeasured (docs/codex-compatibility.md). **A changed decision:** F6 left `["just", "AR=x", "build"]` rendering, and it is now broad. Under `set export` a just override is an environment assignment for every recipe, and F6 already judged just overrides that way for CC. `["just", "PYTHON=python3", "test"]` still renders. **Still rendering, as data:** CFLAGS, LDFLAGS, ARFLAGS, PREFIX, DESTDIR, VERBOSE, RUSTFLAGS, CARGO_TARGET_DIR and `CARGO_TARGET_<triple>_RUSTFLAGS`, by G4(a)'s flags-are-data decision, even though `RUSTFLAGS=-Clinker=./x` names a program. **Left out, for the maintainer:** CARGO_HOME, which names the directory whose `config.toml` can set `build.rustc`. That is the config-file class in the exporter's governing principle, not a program name. **Refused since K3 (below).** **Also left out:** `CARGO_ALIAS_<name>` (cargo's own arguments), the cc crate's `CC_<target>` and `TARGET_CC` (a build-script library's, not cargo's), and the other build tools (CMake, Go, autoconf), which were not surveyed. **Residual, recorded:** a native Windows program reads its environment case-insensitively (measured: under Git Bash, `env rustc_probe=./x node` saw `process.env.RUSTC_PROBE`). So `env rustc=./x cargo build` still renders, and on Windows it may reach cargo.exe. Whether cargo's own lookups fold case was not measured. **Closed for the environment readers by K1 (below),** and for make and just overrides by L1 (below). **Pinned by** three tests at the J1 block of `test/policy-exporters.test.js`. Against the base source the Codex test and the validator test fail. The Claude test is a control that passes either way, and it fails once the Claude half is given the Codex predicate. Each of fifteen single-point mutations was killed: each set and pattern dropped from the predicate, each call site reverted, the leading-assignment block deleted, an upper-cased lookup, CFLAGS added, and the validator lines removed. |
| The listing offered a family the user had denied, and the write then withheld it | **FIXED**, `2c77f98` (J2) | wave-f9 reported that `clone` consults managed policy for a family's rule but never the user's deny list. Verified on `7d08ced`: with `Bash(git status:*)` in the user's deny list and three runs of `git status`, the listing gave `eligibleTargets: ['claude']`, `pendingTargets: ['claude']` and `policy: 'unknown'`. An automatic apply and a reviewed apply both withheld it as `user-deny`, and the listing still said pending afterwards, so it stayed pending for good. **User-visible, and the picker did not cover it.** The dashboard and the Review picker read the listing's targets (`reviewableCandidates` and `isCandidateComplete` in `vscode-extension/autoLearnUi.js`). The dashboard read "1 to review" (or "1 safe to apply") in its warning state, the manual scan's toast counted it, and Review offered the row as `[pending: Claude]`. The picker's only cover is a detail line, "policy deny overrides this grant", taken from its own read of settings.json. The row stayed selectable, and selecting it alone ended in "the selected candidates were already covered or structurally ineligible". **What changed:** `refusalFor(policy, userDeny)` builds the verdict that `applyUnlocked` used to build inline, and the listing builds it too, from one read of each policy per listing. The listing, the write's gate on the rule and the write's per-spelling check (G2) now use one verdict, so they cannot disagree. `clone` withholds the Claude target when the family's rule is refused. The Codex target is untouched, because a Claude deny says nothing about a Codex rule, and `policy` is still the managed verdict alone. **Cost:** one more read of settings.json per listing. **Consequence:** a Claude-only family the user denied now leaves Review and the counts with no note. That is the user's own rule, unlike a managed ask, whose blocked-family note stays. **Not changed, for the lead:** a user `ask` that covers the rule makes a written allow just as dead (Claude Code evaluates ask before allow), and neither the write nor the listing nor `planPromotions` consults it; the picker's detail line names it. **Answered by K2 (below).** **Pinned by** three tests in `test/auto-learn-write-gates.test.js`: the withheld listing, read through autoLearnUi; a control with a deny that does not cover the rule; and the Codex-target case. Against the base source the first and third fail. The control passes either way, and it fails when every family is treated as refused. Four single-point mutations were each killed. |
| An environment assignment was judged case-exact, and a Windows program reads its environment case-insensitively | **FIXED** for the environment readers, `f7b7cd8` (K1); the make and just half of the decision **NOT VERIFIED**, for the lead, and then **REVISED** by the lead: folded too, L1 (below) | The lead's decision on J1's residual. **Verified**, measured 2026-10-14 under Git Bash with node 24.19.0 in a private temp directory: `env node_options=--require=./y.js node -e ...` and the bash spelling `node_options=--require=./y.js node -e ...` each ran y.js and saw `NODE_OPTIONS` set, and a run with neither saw it undefined. Against `55ceafb` all 188 rows of the new test rendered, for example `["env", "ld_preload=./x.so", "cat"]`, `["env", "node_options=--require=./y.js", "node", "x.js"]`, `["docker", "exec", "-e", "ld_preload", "ctr", "cat"]`, `["rustc=./x", "cargo", "build"]` and `["env", "checkout,v=./x", "make", "all"]`. So `envNameIsUnsafe`'s own sets (CODE_LOADING_ENV, PROGRAM_NAMING_ENV, `LD_*` and `DYLD_*`) had the gap as well as J1's. **What changed:** `codexFoldedEnvNameIsUnsafe` (`src/policy-exporters.js`) judges the exact name, its upper-case spelling and the built-in command lines case-insensitively, so it refuses everything `codexEnvNameIsUnsafe` does and more. `codexAssignmentIsUnsafe` calls it, which covers env's assignments (`wrapperIsBroad`) and a prefix that opens with assignments (`candidateEligibleForCodex`). So does `envAssignmentIsUnsafe`, which covers a container's `-e`/`--env`, fused or not, and a bare `-e NAME`. It applies on every platform. No other reader in the export judges an environment name: the validator judges a pattern's command, not its assignments. Data still renders in any case (`cflags=-O2`, `rustflags=-g`, `lang=C`, `-e foo=bar`). **Unchanged, as decided:** make and just overrides stay exact (`["make", "cc=x", "all"]`, F6's pin, still renders), and the Claude half (both folded since, by L1 and L2 below). **The make and just half is not verified, for the lead.** It rests on make's variable names being case-sensitive, which holds for what make itself runs: `$(cc)` is not `$(CC)`. But a make override is also an environment assignment. The GNU make manual ("Communicating Variables to a Sub-make", read 2026-10-14) says "make exports a variable only if it is either defined in the environment initially or if set on the command line and its name consists only of letters, numbers, and underscores", and "make adds the variable and its value to the environment for running each line of the recipe". The exporter's MAKE comment gives the same reason for judging make overrides by `envNameIsUnsafe` at all. So on Windows `make node_options=--require=./y.js test` hands every recipe a variable a native node reads as NODE_OPTIONS (not run: no make on the box), and `make cc=x all` hands one that a native child reading CC sees. For just, MEASURED with just 1.58.0: a justfile with `set export` and `node_options := ""`, whose recipe runs node, ran y.js under `just node_options=--require=./y.js r`. Both prefixes render. Folding make would refuse `["make", "cc=x", "all"]`, because CC is in PROGRAM_NAMING_ENV, so the two halves of the decision conflict. This pass keeps them exact as decided rather than choose between them. The options are to fold make and just too (F6's pin flips), to fold just alone (J1 already judges a just override as an environment carrier), or to accept and record. **Decided 2026-10-14: fold both, the safe failure, carried out as L1 (below).** **Candidates, not changed:** the Claude half judges a leading assignment exactly, so a reviewed `Bash(ld_preload=./x.so cat *)` and `Bash(git_pager=x git log *)` render. `Bash(node_options=... node *)` is refused only because node is a wrapper root. **Folded since L2 (below).** Separately, strace's `-E`/`--env` sets the traced command's environment and is read as a plain value option, judged in no case: `["strace", "-E", "LD_PRELOAD=./x.so", "cat"]` renders. **Judged since L3 (below).** **Pinned by** two K1 tests in `test/policy-exporters.test.js`, and J1's case-exact block is reduced to its just row. Against the base source the first test fails. The control (make and just stay exact) passes either way. Seven single-point mutations were each killed: each call site reverted, the upper-case lookup dropped, the folded command-line pattern dropped, a predicate that refuses everything, and make or just folded. |
| A user `ask` on a family's rule made the written allow dead, and Auto Learn reported it applied | **FIXED**, `fcbe535` (K2) | The lead's decision on J2's open question. **Reproduced** on `f7b7cd8`, with `Bash(git status:*)` in the user's `permissions.ask` and three runs of `git status`. The listing gave `eligibleTargets: ['claude']`, `pendingTargets: ['claude']` and `policy: 'unknown'`. An automatic apply wrote `Bash(git status *)`, reported it in `appliedKeys` and withheld nothing. `planPromotions` promoted a local `Bash(git status)` as `Bash(git status *)`. Claude Code evaluates deny, then ask, then allow, across merged layers (docs/claude-code-permissions.md, "Precedence"), so each of those entries prompts anyway. **What changed:** `readUserRules` (`src/auto-learn-manager.js`, formerly `readUserDeny`) reads `deny` and `ask` from one read of settings.json, through the same filter. `refusalFor(policy, { deny, ask })` adds `{ decision: 'ask', rule, source: 'user-ask' }` after the managed verdict and the user deny, matched by the same `coversPermission`. That one verdict serves `applyUnlocked`'s gate on a family's rule, its per-spelling write (G2) and the listing's `clone` (J2). So a user ask on the rule withholds the family in the listing and in the write, and one on an alternate spelling withholds that spelling alone. The "new grants only" limit holds: a spelling already in `allow` stays and stays claimed. `policy` is still the managed verdict alone. **planPromotions applies too.** Verified: it promoted the entry, and the drain then pruned the local copy as covered and reported the promotion verified. It now takes `userAsk`, which `drainLocalSettings` reads from the user's `permissions.ask` beside `userDeny`, matched by the same `permissionMatches`. The check runs after the deny check, so a deny still outranks it. A withheld entry is reported in a new `asked` list, and not in `denied`, because `bin/wildcard-perms` prints every `denied` entry as "your deny rule … outranks it". **The extension needed no change.** `reviewableCandidates`, `isCandidateComplete` and the dashboard's `countAutoLearnCandidates` read the listing's targets, so an ask-refused family is neither ready nor counted (the first test reads it through `autoLearnUi`). The picker's detail line, "policy ask overrides this grant", remains for a row still offered for Codex. **Consequence:** as for a user deny (J2), a Claude-only family the user asks about leaves Review and the counts with no note. **Follow-up, done in `fb8aac3`:** the drain's CLI output. `bin/wildcard-perms` printed `denied` but not `asked`. It now names both, on the nothing-to-do path too, which had named neither. Pinned by "--drain names an entry a user ask or deny withheld, even when nothing else changed" in `test/cli-hook.test.js`, which kills both mutations. **Pinned by** five K2 tests in `test/auto-learn-write-gates.test.js`: the rule withheld in the listing (read through autoLearnUi) and in both writes; the alternate spelling alone; stored state with no scan, in both shapes; a control with an ask that does not cover the rule; and new grants only. Three more are in `test/local-settings.test.js`: the plan, its control, and the drain with its dry run. Against the base source the rule, alternate, stored-state, plan and drain tests fail. The two controls and the new-grants test pass either way, and each fails under its own mutation. Ten single-point mutations were each killed: the ask dropped from `refusalFor`, `deny` read as `ask`, every permission refused, the `fileAllow` keep dropped, the listing or the write given no ask, the plan's ask check dropped, the drain passing no `userAsk`, every candidate withheld, and ask judged before deny. |
| `CARGO_HOME` chooses the cargo config file that can name the compiler, and rendered in every Codex environment context; so did `RUSTUP_TOOLCHAIN` and `RUSTUP_HOME` | **FIXED**, `bab510f` (K3) | The lead's decision on the variable J1 left for the maintainer: refuse it, as the release refuses node's config-file options. **Verified from the sources, read 2026-10-14.** The Cargo Book: `CARGO_HOME` "overrides the location of this directory" (reference/environment-variables.html), the home whose `config.toml` is "Cargo's global configuration file" (guide/cargo-home.html), probed as "`$CARGO_HOME/config.toml`" (reference/config.html, "Hierarchical structure"), where `build.rustc`, `build.rustc-wrapper` and `target.<triple>.linker` are each "Type: string (program path)". **RUSTUP_TOOLCHAIN accepts a path, so it is refused.** rustup's environment-variables page says it "can specify custom toolchains, installable toolchains, or the absolute path to a toolchain", so it names the program's directory outright, not only an installed name. The overrides page says the same of a toolchain file's `path` key ("directly names a local toolchain"). **RUSTUP_HOME is refused too.** It "Sets the root rustup folder, used for storing installed toolchains and configuration options" (the same page), so the toolchain a rustup proxy such as cargo or rustc runs, and the settings that choose it, come from the directory it names. That is a path to the program's directory again, and the config-file class besides. Measured against `fcbe535`: every row of the new test rendered, among them `["env", "CARGO_HOME=./h", "cargo", "build"]`, `["docker", "exec", "-e", "RUSTUP_HOME", "ctr", "cargo", "build"]`, `["make", "CARGO_HOME=./h", "all"]` and `["env", "RUSTUP_TOOLCHAIN=stable", "cargo", "build"]`. The last is refused by the name, since the export does not read the value. **What changed:** `CARGO_CONFIG_ENV` (`src/policy-exporters.js`), part of `codexEnvNameIsUnsafe`. So it reaches every place J1's names do, including make and just overrides, and K1 folds it in the environment readers (`env cargo_home=./h cargo build`). The Claude half is unchanged, as for J1's names: `Bash(CARGO_HOME=x cargo build *)` still renders at review by G4(b). Data still renders: CARGO_TARGET_DIR, CARGO_INCREMENTAL, CARGO_TERM_COLOR, RUSTUP_LOG, RUSTUP_TERM_COLOR, RUSTUP_TOOLCHAIN_SOURCE, and a name that only starts with CARGO_HOME. **Left out, for the lead:** rustup's download sources, `RUSTUP_DIST_SERVER` and `RUSTUP_UPDATE_ROOT` ("Sets the root URL for downloading ..."). With `RUSTUP_AUTO_INSTALL` ("installs the active toolchain when it is absent"), they could fetch the toolchain that then runs. Not measured; no cargo or rustup is installed on the box. **Refused since L4 (below).** **Pinned by** one K3 test in `test/policy-exporters.test.js`, which fails against the base source. Five single-point mutations were each killed: the set dropped from the predicate, each of its three names dropped, and a prefix match in place of the exact one, which the data rows catch. |
| A make or just override was judged case-exact, though it also reaches a recipe's environment, where a Windows program reads the name folded | **FIXED**, `c5694b2` (L1) | The lead's decision on the half of K1 left unverified: fold make and just too, the safe failure, so F6's pin flips. **Verified.** The GNU make manual ("Communicating Variables to a Sub-make", re-read 2026-10-14): "make exports a variable only if it is either defined in the environment initially or if set on the command line and its name consists only of letters, numbers, and underscores", and "make adds the variable and its value to the environment for running each line of the recipe". No make is on the box, so that half rests on the manual. just MEASURED again with 1.58.0 in a private temp directory: a justfile with `set export` and `node_options := ""`, whose recipe runs `node -e "console.log(process.env.NODE_OPTIONS)"`, ran y.js and printed `--require=./y.js` under `just node_options=--require=./y.js r`, and printed an empty line without the override. Against `2092793` all 23 rows of the new test rendered, for example `["make", "cc=x", "all"]`, `["make", "node_options=--require=./y.js", "test"]`, `["just", "ld_preload=./x.so", "build"]` and `["just", "--set", "node_options", "x", "build"]`. **What changed:** MAKE's and JUST's `unsafeVariable` (`src/policy-exporters.js`) call K1's `codexFoldedEnvNameIsUnsafe`, so an override, and just's `--set NAME VALUE`, is judged as the environment readers judge a name. **F6's pin flips:** `["make", "cc=x", "all"]` is refused, and its test says why. K1's control test, which pinned these overrides exact, is replaced by the L1 test, and J1's `["just", "ar=x", "build"]` row is refused too. **Data still renders in any case:** `prefix=`, `PREFIX=`, `Prefix=`, `DESTDIR=`, `destdir=`, `CFLAGS=`, `cflags=`, `VERBOSE=`, `verbose=`, `V=`, `v=`, `ldflags=`, `rustflags=`, `bindir=`, just's `PYTHON=` and `python=`, and all 17 of F6's MAKE_DATA_NARROW rows, unchanged. **Over-refusal, accepted:** the fold also refuses a dotted spelling such as `compile.c=` or `.shellflags=`, which make neither reads as the built-in variable (`COMPILE.c`) nor exports, since the name is not letters, digits and underscores. That is the cost of one predicate, in the safe direction. **The wider cost, measured by the final audit on 2026-10-14:** a lower-case data override that folds onto a refused name is refused too, and some are common. Examples: `["make", "env=prod", "deploy"]` (folds onto ENV), `["just", "env=staging", "deploy"]`, `["docker", "run", "-e", "env=prod", ...]`, `make path=x` (PATH), `make install=no` (INSTALL), `make lint=1`, `co=1`, `as=1` and `get=1`. Each rendered at `7cbba2b`. Kept, in the safe direction: `path=` really does reach a recipe child on Windows as PATH. A reviewer can still approve such a command in Codex directly; only Auto Learn's export stays silent. **Pinned by** "L1: a make or just override is judged case-insensitively, as the environment assignment it also is" in `test/policy-exporters.test.js`, with the flipped F6 and J1 rows. Against the base source the L1, F6 and J1 tests fail. Four single-point mutations were each killed: MAKE's call reverted to `codexEnvNameIsUnsafe` (the F6 and L1 tests fail), JUST's likewise (J1 and L1), and each made to refuse every name (the data rows fail). |
| The Claude half judged a leading assignment case-exactly, so a reviewed `Bash(ld_preload=./x.so cat *)` rendered | **FIXED**, `0f29d7f` (L2) | The lead's decision on K1's first candidate: fold the Claude half's check as K1 folded the Codex export's. **Verified:** against `c5694b2` all 24 rows of the new test rendered, for example `Bash(ld_preload=./x.so cat *)`, `Bash(git_pager=x git log *)`, `Bash(Path=. cat *)` and `Bash(node_options=x cat *)`, while their upper-case spellings were refused. K1 measured the bash spelling `node_options=--require=./y.js node -e ...` running y.js under Git Bash. **The one check:** `claudePermissionIsSafe` judges a leading assignment by `assignmentIsUnsafe` (`src/policy-exporters.js`). Nothing in `src/auto-learn.js` or `src/permissions.js` refuses by name (the learner keys and proposes the rule, and the exporter is the gate), so `src/permissions.js` is untouched. **What changed:** `assignmentIsUnsafe` judges the name as written and upper-cased, by `envNameIsUnsafe`. **Folded, and only these:** the sets the Claude half already refused, `CODE_LOADING_ENV` (16 names), `PROGRAM_NAMING_ENV` (20) and the loader prefixes `LD_` and `DYLD_`. Nothing is added to the Claude half: J1's build programs, F6's make sets, cargo's program names and K3's `CARGO_CONFIG_ENV` stay Codex export only, so G4(b) stands in any case (`Bash(AR=x cargo build *)`, `Bash(ar=x cargo build *)`, `Bash(ld=./ld cargo build *)` and `Bash(cargo_home=x cargo build *)` render). **Claude Code's strip model is unchanged, and the evidence supports that.** The record already said the allow path strips a leading assignment only when its 39-name Set accepts the name. A re-read of the installed 2.1.296 binary, at the offset `scripts/check-claude-strip-model.js` reports (223,483,330, "same set", 39 names), shows the routine as `let V=G[1] ... if(IG.has(V))S=S.replace(h,"")`, with `G` the match of `/^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:-]+)[ \t]+/` and no case conversion. So Claude Code strips case-exactly: `lang=C git log` keeps its assignment and only a rule that carries it matches, as the exact `.has` on `CLAUDE_SAFE_ENV_VARS` models. None of the 39 is in a folded set. Checked: no safe name, in either case, is refused as a lead, except `ANTHROPIC_API_KEY`, which the secret filter refuses before and after. So the fold cannot refuse a rule for an assignment Claude Code strips. **Pinned by** "L2: the Claude half judges a leading assignment case-insensitively, for the sets it already refused" in `test/policy-exporters.test.js`. Lower and mixed-case rows are refused, upper case is still refused, and G4(b)'s rows and the data rows (`lang=C`, `LANG=C`, `ci=1`, `rust_log=`, `cflags=`, `ldflags=`, `Pathname=`, `editors=`) still render. It fails against the base source. Three single-point mutations were each killed: the upper-case lookup dropped; the Codex export's wider folded set used instead (the L2, J1-control and K3 tests fail); and every name refused. |
| strace's `-E VAR=VAL` and `--env` set the traced command's environment, and were read as a plain value option | **FIXED**, `784d424` (L3) | K1's second candidate, by the lead's decision. **Verified.** strace(1) (man7.org, read 2026-10-14): `-E var=val`, `--env=var=val` "Runs the command with the environment variable var=val set for execution", and `-E var`, `--env=var` "Removes var from the inherited environment variables before executing the command". strace's source agrees (`src/strace.c`, `update_env`: a value holding `=` is added, any other removed), and it parses with `getopt_long`, whose `longopts` has `env` as the only long option starting with `e`, so `--e=` and `--en=` are `--env=` too. Against `0f29d7f` all 16 rows of the new test rendered, for example `["strace", "-E", "LD_PRELOAD=./x.so", "cat"]`, `["strace", "--env=LD_PRELOAD=./x.so", "cat"]`, `["strace", "--en=LD_PRELOAD=./x.so", "cat"]` and `["timeout", "5", "strace", "-E", "LD_PRELOAD=x", "cat"]`. Not run: Git for Windows' `strace` is Cygwin's, another program. **What changed:** strace's `EXEC_WRAPPER_GRAMMAR` entry (`src/policy-exporters.js`) gains `env: ['-E', '--env']` and `envFused` (`-EVAR=VAL`, `--env=`, `--en=`, `--e=`), read by `execWrapperInner` through a new `envOptionIsUnsafe`, which is `envAssignmentIsUnsafe`, the container `-e`'s check, so K1's fold and J1's and K3's names apply. A grammar flagged `envUnsetsBare` judges only an assignment, so a bare `-E VAR` is narrow; docker's and compose's bare `-e NAME`, which copies the caller's value, stays judged. **The other wrappers, checked against each tool's docs:** none that the exporter models with a grammar takes an option that sets the command's environment. GNU coreutils `nice` (`-n`), `timeout` (`-k`, `-s`, `--foreground`, `--preserve-status`, `-v`), `stdbuf` (`-i`/`-o`/`-e` modes), `nohup` and `chroot` (`--userspec`, `--groups`, `--skip-chdir`) have none (each one's `--help`, coreutils 8.32 on the box). `ltrace -e` is a filter expression ("A qualifying expression which modifies which library calls", ltrace(1)), and ltrace has no environment option. `flock -E` is `--conflict-exit-code`. valgrind's core options have none: the manual's only environment reads are `$VALGRIND_OPTS`, `%q{FOO}` in `--log-file` and `$DEBUGINFOD_URLS`. nsenter's `-e`/`--env` "Pass environment variables from the target process to the new process" (nsenter(1)), and is absent from its table, so broad already. `systemd-run -E/--setenv` ("Runs the service process with the specified environment variable set", systemd-run(1)), `sudo VAR=value` ("Environment variables to be set for the command may also be passed as options to sudo, in the form VAR=value", sudo(8)), `firejail --env=name=value` ("Set environment variable in the new sandbox", firejail(1)) and gdb's `set environment` are on `ALWAYS_BROAD_WRAPPERS`, broad at any depth, so their environment options change nothing; the test pins them. bwrap's `--setenv` is not modelled because bwrap is on no wrapper table (a candidate, below). **Claude half:** strace is a wrapper root there, refused at any depth. **Pinned by** "L3: strace -E/--env VAR=VAL is judged as an environment assignment, and a bare -E VAR, which unsets, is not" in `test/policy-exporters.test.js`, with bare-name, data, ltrace and flock controls. It fails against the base source. Six single-point mutations were each killed: `env` dropped from the entry, `envFused` dropped, `envFused` narrowed to `--env=`, `envUnsetsBare` dropped, the separated branch judged by `envAssignmentIsUnsafe` directly, and `envUnsetsBare` made to accept every value. **Candidates, not changed:** strace's `-o |cmd` or `-o !cmd` ("the rest of the argument is treated as a command and all output is piped to it", strace(1)) and `-u`/`--user` (which runs the command as another user) are read as plain value options, so `["strace", "-o", "\|./x", "cat"]` and `["strace", "-u", "root", "cat"]` render; the generic `--[a-z-]+=` fused form also takes any getopt prefix, such as `--out=\|./x`. bwrap is on no wrapper table, so `["bwrap", "--setenv", "LD_PRELOAD", "./x.so", "cat"]` renders by the generic rule. |
| rustup's download servers choose the toolchain, and the rustup, that then run, and rendered in every Codex environment context | **FIXED**, `ba061ab` (L4) | The lead's decision on what K3 left for the lead: refuse the variables that choose the code that runs. **Verified from rustup's own sources, read 2026-10-14** (`doc/user-guide/src/environment-variables.md`, `src/config.rs`, `doc/user-guide/src/basics.md` and `CHANGELOG.md` in rust-lang/rustup; the page is the one rust-lang.github.io/rustup serves). `RUSTUP_DIST_SERVER` "Sets the root URL for downloading static resources related to Rust", the toolchains (default `https://static.rust-lang.org`). `RUSTUP_DIST_ROOT` is its deprecated spelling ("Use `RUSTUP_DIST_SERVER` instead"), and rustup still reads it "For backwards compatibility" when `RUSTUP_DIST_SERVER` is unset (`config.rs`, `dist_root_server`), so it is refused too. `RUSTUP_UPDATE_ROOT` "Sets the root URL for downloading self-update", the rustup binary that every later rustup, cargo or rustc proxy runs as; with `auto-self-update` at `enable`, "`rustup update` and similar commands will also check for, and install, any update to Rustup" (basics.md, whose own `rustup update` example downloads a self-update). **Auto-install is on by default in current rustup:** `RUSTUP_AUTO_INSTALL` "(default: 1) When set to `1`, installs the active toolchain when it is absent. Set this value to `0` to disable automatic installation". 1.28.0 (2025-03-04) had turned it off, and 1.28.1 the next day restored it ("Automatic install is enabled by default but can be opted out by setting `RUSTUP_AUTO_INSTALL` environment variable to `0`"). `config.rs` agrees: `should_auto_install` is true unless the variable is `0` or the settings file disables it. The newest release in the CHANGELOG is 1.29.0 (2026-03-05). So a plain `cargo build` with the active toolchain absent downloads one from the dist server and runs it. Against `784d424` all 32 rows of the new test rendered, for example `["env", "RUSTUP_DIST_SERVER=https://mirror.invalid", "cargo", "build"]`, `["docker", "exec", "-e", "RUSTUP_UPDATE_ROOT", "ctr", "cargo", "build"]` and `["env", "RUSTUP_UPDATE_ROOT=./m", "rustup", "self", "update"]`. Not run: no rustup or cargo on the box. **What changed:** a sibling set, `RUSTUP_SOURCE_ENV` (`src/policy-exporters.js`), part of `codexEnvNameIsUnsafe`, because these are download servers, not the directories `CARGO_CONFIG_ENV` names. So they reach every place K3's names do: env's assignments, a leading assignment, a container's `-e`, strace's `-E` (L3), and make and just overrides, folded by K1 and L1. **Left as data:** `RUSTUP_AUTO_INSTALL` (a switch on that default, choosing no source), `RUSTUP_LOG`, `RUSTUP_TOOLCHAIN_SOURCE` ("Set by rustup to tell proxied tools how `RUSTUP_TOOLCHAIN` was determined"), the terminal, I/O and download tuning, and `RUSTUP_VERSION`, which "Overrides the rustup version (e.g. `1.27.1`) to be downloaded": a version from the server above, not a source. **The Claude half is unchanged**, as for K3: `Bash(RUSTUP_DIST_SERVER=x cargo build *)` renders at review by G4(b), and L2 folds only the Claude half's own sets. **Pinned by** "L4: RUSTUP_DIST_SERVER, RUSTUP_DIST_ROOT and RUSTUP_UPDATE_ROOT make a Codex prefix broad wherever the export reads an assignment" in `test/policy-exporters.test.js`, which fails against the base source. Six single-point mutations were each killed: the set dropped from the predicate, each of its three names dropped, a `RUSTUP_` prefix match in place of the exact names (which the data rows and K3's catch), and `RUSTUP_AUTO_INSTALL` added. |
| A program whose whole job is to run another, but that no table named, was judged as an ordinary program; `["bwrap", "--bind", "/", "/", "sh", "-c", "x"]` and a reviewed `["bwrap", "--bind", "/", "/"]` would grant any command under it | **FIXED**, `6deaa8d` (M1); the standing limit is **ACCEPTED-RECORDED** | A bounded census (2026-10-14), each checked against its man page or official docs. Identity changers and ungoverned sandboxes join `ALWAYS_BROAD_WRAPPERS`, broad at any depth like sudo: `setpriv` (`--reuid`/`--regid`, util-linux setpriv(1)), `sg` (runs its command "with the /bin/sh shell" under another group, sg(1)), `bwrap` (`--setenv VAR VALUE`, `--uid`/`--gid`, `--cap-add`; bwrap(1)), `systemd-nspawn` (`--bind`/`--setenv`/`-u`/`--capability`; systemd-nspawn(1)) and `proot` (`-0`/`--root-id` fakes root, `-q`/`--qemu` names an emulator, `-b`/`--bind`; proot(1)). This closes the bwrap case L3 recorded. Pure exec wrappers that exec their trailing argv directly get an `EXEC_WRAPPER_GRAMMAR` entry each, so a reviewed prefix is as narrow as the command it names: `numactl` (numactl(8)), `prlimit` (prlimit(1)), `cgexec` (cgexec(1)), `unbuffer` (expect(1)), `xvfb-run` (xvfb-run(1)), `caffeinate` (caffeinate(8)) and `sandbox-exec` (sandbox-exec(1)). `flatpak` is a `RUNNER_GRAMMAR` dispatcher whose `run` is broad (docs.flatpak.org); `flatpak list` and a `--version` stay narrow. The header now records a **third limit, ACCEPTED-RECORDED:** the tables enumerate runners, so a runner no table names is judged by the generic rule as an ordinary program, which leaves a new exec-style tool narrow until a table names it; the remedy is adding it here, as this census did. **Further census candidates, ACCEPTED-RECORDED under that limit (narrow until a table names them):** `fakeroot` and `fakechroot` (their `-l`/`--lib` LD_PRELOADs a wrapper library, code-loading), `dbus-run-session` and `dbus-launch` (`--dbus-daemon` names a binary), `entr` (`-s` runs a shell command), `catchsegv` (removed in glibc 2.35, 2022), `arch` (Linux prints the architecture and runs nothing, macOS execs — OS-ambiguous), cmd's `start` builtin (reached only via `cmd /c`, already broad) and `flatpak-spawn`. **Revised by the lead, `81f87ce`:** `psexec` and `psexec64` are always broad, like runas. `-s` runs the command as SYSTEM and `-u` as another user, and on the Windows boxes this tool runs on that is not niche. **Pinned by** five M1 tests in `test/policy-exporters.test.js` that name every newly covered root as a literal; each fails when its table entry is reverted. |
| strace `-o '\|cmd'` / `-o '!cmd'` pipes strace's output to a command, and rendered | **FIXED**, `6acd67d` (M2) | strace(1): "If the argument begins with '\|' or '!', the rest of the argument is treated as a command and all output is piped to it" (man7.org, read 2026-10-14; `src/strace.c` handles a leading `\|` or `!`). So an `-o`/`--output` value starting with `\|` or `!` is a program strace runs, judged broad by `outputPipesToCommand`, separated or fused; getopt_long's ambiguous prefixes `--o`/`--ou`/`--out`/`--outp`/`--outpu` are covered, so `--out=\|./x`, which the generic `--[a-z-]+=` fused form accepted as inert, is refused. A plain file path stays narrow. **ltrace checked, and differs:** its `-o` fopen()s the name (ltrace options.c, `case 'o'`), no pipe rule, so ltrace keeps a plain value option and its control rows render. **Pinned by** the M2 test, with three mutations (drop `outSep`, drop `outFused`, make `outputPipesToCommand` always true) each killed. |
| Identity-changing options inside modelled wrappers rendered, though a change of who the program runs as makes a prefix broad | **FIXED**, `6524b2b` (M3) | Each verified against its man page and made broad, fused, separated and abbreviated: strace `-u`/`--user` "Runs command with the user ID, group ID, and supplementary groups of username" (strace(1); `--u`/`--us`/`--use` prefixes covered), ltrace `-u` (ltrace(1); options.c `case 'u'`), chroot `--userspec`/`--groups` (chroot(1), coreutils), nsenter `-S`/`--setuid`, `-G`/`--setgid` (nsenter(1)), unshare `-r`/`--map-root-user`, `-c`/`--map-current-user`, `--map-user`/`--map-group`/`--map-users`/`--map-groups`/`--map-auto`/`--map-subids`, `-S`/`--setuid`, `-G`/`--setgid` (unshare(1)). `execWrapperInner` gains one identity check, run before flags and values; unshare's `-r`/`-c` leave the flag cluster and the map/setuid/setgid long forms leave its long alternation. A pre-existing narrow control, `["unshare", "-r", "ls"]`, moved to the broad set. **Pinned by** the M3 test (inner commands kept narrow so only the identity option makes the prefix broad); reverting the whole M3 source fails it. |
| valgrind accepted any long option with any value, so `["valgrind", "--tool=../../x", "prog"]` rendered | **FIXED** for `--tool`, `90431a1` (M4); the open form is **ACCEPTED-RECORDED** | valgrind's launcher splices the `--tool` value, unsanitized, into the tool path it execs: `sprintf(toolfile, "%s/%s-%s", valgrind_lib, toolname, platform); execve(toolfile, ...)` (coregrind/launcher-linux.c, read 2026-10-14; no check on `/` or `..`), so `--tool=../../x` runs an arbitrary binary. `--tool=` is now required to be a plain tool name `[a-z][a-z0-9-]*` or the prefix is broad. The entry still accepts any OTHER long option with any value, the one place this module departs from the header's "an option no table lists is broad": valgrind's large core option set is, bar `--tool`, files/numbers/enums (the manual's core-options page), and the sole program-naming option `--db-command=` was removed in valgrind 3.9.0 (2013). Open form **KEPT, ACCEPTED-RECORDED;** revisit if a core option that runs a program returns. (The one-line `--tool` guard shipped in the M1 edit block; this commit added its rationale, decision and test.) **Pinned by** the M4 test, which fails when the open form is restored. |
| Nothing pinned that Claude Code's strip model is case-exact | **FIXED**, `c33f031` (M5) | wave-f13 read Claude Code 2.1.296 and found the membership test case-exact (`IG.has(V)`, no conversion), which is what makes `LANG=C` strip and `lang=C` keep its assignment. A test now asserts `claudeStripsAssignment('LANG','C')` is true and `('lang','C')` (and `('Lang','C')`) false. `scripts/check-claude-strip-model.js` gains an advisory read, `lookupCase`: it finds the Set's variable name, reads the nearby `<var>.has(...)` calls, and reports `exact` for a bare-identifier argument, `folded` for one wrapped in `.toUpperCase()`/`.toLowerCase()`, or `null` when the minified shapes don't allow a read, never changing the exit code or the existing output fields. Against the installed 2.1.296 binary it reports `exact`. **Pinned by** two M5 tests (the case assertion, killed by folding the name; the detector on synthetic binaries, killed by dropping its fold branch). |
| strace's grammar listed `--expr`, which is not a real long option; and `RUSTUP_VERSION` was unrecorded | **FIXED**, `c11b565` (M6); `RUSTUP_VERSION` is **ACCEPTED-RECORDED** | strace has no `--expr` long option: getopt_long's longopts name the filter `-e`/`--trace` (src/strace.c, read 2026-10-14; `expr` appears only as the `-e` argument's metavar). It left `values`, so the separated `["strace", "--expr", "trace=open", "ls"]`, which read `trace=open` as the option's value and rendered, is now broad (the fused `--expr=...` stays inert via the generic `--[a-z-]+=`, as every strace `--x=y` does). `--trace`, the real filter option, still renders. `RUSTUP_VERSION` stays data, **ACCEPTED-RECORDED:** it "Overrides the rustup version ... to be downloaded" from the configured dist server, so it picks a version, not a source (already noted in L4's comment). **Pinned by** the M6 test, which fails when `--expr` is restored to `values`. |

**The liveness decision (G3, 2026-10-14).** What a folder gone for good did, measured with the real
walk:
- **The product has no way to un-configure a root.** Its Codex roots are fixed, `sessions/` and
  `archived_sessions/` under the Codex home: the extension passes no `codexHistory` on purpose and
  the CLI passes only `codexHome`. So F3's "until it returns or is no longer a configured history
  root" offered an exit the user does not have, short of changing `CODEX_HOME`.
- **A `sessions/` deleted for good held the rebuild until Codex recreated it.** Recreating it by
  hand did not help when no Codex rollout was left anywhere. The walk then found zero Codex files,
  and the rebuild stayed open as `history-unavailable`, with nothing on the hover, until a new
  rollout appeared. So a user who had deleted their Codex history and stopped running Codex had no
  exit at all.
- **`archived_sessions/` absent is benign already.** As a link to a missing target it holds the
  rebuild until the link is reconnected or removed.

Decided:
- **Nothing guesses that a folder is gone.** Gone and unplugged look alike, which is 7ce6217's
  reason, and guessing "gone" is how the audit's grant-then-revoke happened.
- **The user's act is the exit**, and the reason now names it before the consequence: reconnect the
  folder if it is offline; if it is gone for good, an empty folder in its place clears it.
- **That exit is made to work.** A walk with zero Codex files ends the rebuild only when the
  scanner proves the listing: every configured Codex root is in its `walkedRoots`, or is the benign
  absent archive. A scanner that reports no `walkedRoots` keeps the old answer.
- **It does not reopen 7ce6217's hole.** A folder that is there and was listed completely cannot
  come back with transcripts the walk did not see. What the empty folder releases is a deleted
  transcript's evidence, the loss 9abc330 already accepts. The grant-then-revoke needed a folder
  that was away and then returned.
- **A root that leaves the configuration releases its pending ids.** This already held, because
  `missingRoots` lists only configured roots; it is now pinned by a test. A root nobody configures
  is not a source, so in a rebuild its transcripts are not re-read, as with a transcript deleted
  mid-rebuild. Outside a rebuild its counted evidence stays counted. In the product this is
  reachable only by changing `CODEX_HOME`.

Pinned in `test/codex-evidence-migration.test.js`:
- the permanently-missing case, held for three scans and then cleared by an empty folder;
- the controls: a scanner that proves nothing, a walk that cannot list `sessions/`, and a link;
- the comes-back case, with the default roots;
- the un-configured case;
- the names-only reload.

The line and the row are pinned in `test/dashboard-view.test.js`. Every mutation of the new code was
killed.

## The 1.6.2 backlog clearance (2026-10-13)

Prompted by two dashboard rows that were both false: Auto Learn read **"scan degraded —
Codex history store has moved"** and Codex memory read **"1 issues"**. The maintainer then
asked for `BACKLOG.md` to be cleared outright. Every open entry was re-verified against the
tree first, because the file's own preamble says entries rot, and two of them had: five of the
"seven surviving mutants" had been killed by `590df24` on 2026-09-24, three days before the
tracker was restored claiming no test would notice, and `managedPolicyPath` had gained three
script suppliers. What follows is each disposition and its evidence. Nothing here was closed
by re-reading its own prose.

### The archived-thread false alarm — FIXED, `9abc330`

**Cause.** Archiving a thread in the Codex app MOVES its rollout from
`sessions/YYYY/MM/DD/` to a flat `archived_sessions/`. The store check walked `sessions/`
only, so every archived thread still named by `thread_history_1.sqlite` or
`session_index.jsonl` read as an orphan, and `stale: true` persisted until the thread was
unarchived. On the development box: four archived threads, the oldest 170 MB, all four
marked `archived = 1` with an `archived_sessions\` `rollout_path` in Codex's own
`state_5.sqlite` `threads` table. It was a detector that fired on an ordinary user action,
which is the failure this check's own test file names: "a detector that fires on everything
is not a detector."

**The real migration signal was looking in the wrong place too.** The check treated any
entry in a `rollout-migrations/` directory as a reason. No such directory has ever existed
here. Codex records migrations in `state_5.sqlite` `rollout_migration_state`, which held one
row, `legacy_to_paginated_v1`, and that migration is benign: the projection cursor
(`thread_history_projection_state.next_rollout_byte_offset`) equalled the rollout's size for
13 of 13 threads, so the store is still a projection of the files. A migration having run is
now a note; only proven divergence makes `stale`.

**What the check does now.** It accounts for `sessions/` and `archived_sessions/` in ONE
comparison per Codex home (a naive second root would have made each root report the other's
threads as orphans), re-walks once before calling anything an orphan, and uses the state
database to *classify* a missing thread — relocated (a reason: Codex writes where we do not
read), archived then deleted (a note), or orphaned (a reason) — never to add ids. A projection
cursor strictly past its file's end is a new reason. Reasons and notes name directories, never
paths. The dashboard says what diverged ("4 Codex threads with no transcript") instead of the
fixed sentence, and logs reasons to the output channel when they change.

**Two defects found inside the fix and shipped with it.**

- **A fork head-seed double count.** Three of the archived rollouts are forks with two head
  `session_meta` lines (the fork's id, then the parent's). The full parse applies both;
  `codexHeadSeed` applied only the first, so a call first read in an append slice was filed
  under the fork and counted again under the parent on the next full read — which archiving
  forces, because cursor keys are path hashes. The seed now applies every consecutive head
  record. Identity was deliberately NOT re-keyed to the thread id: that would recount every
  observation already stored. **ACCEPTED-RECORDED:** calls in those three forks that were
  first counted from an append slice before this fix are counted once more on the first full
  read of `archived_sessions/`. Bounded and one-time.
- **A pending-file leak.** `codexEvidencePendingFiles` ids are path hashes; a transcript
  archived during a Codex evidence rebuild left an id nothing could read again, held
  `codexEvidenceRebuildPending` true forever and blocked auto-safe apply. A clean walk now
  drops pending ids it no longer enumerates; a walk that failed on a root keeps them (the
  half of the old witness that still holds). A moved file that is still being caught up is
  re-added under its new id, so the rebuild stays open until it is read.

**`partial` was never an error.** It is set in one place and means "deferred by the per-file
per-scan ingest budget; the cursor advanced to a newline and the next scan continues". It was
rendered as trouble, which would have shown "scan degraded" for the three scans the 170 MB
archive needs. It now reads "catching up on N large transcript(s) (X MB left)". The genuinely
partial read, `mode: 'unreadable'` (a skipped stretch), was counted nowhere; it is now
`unreadable` and is trouble.

**Acceptance on a copy of the real Codex home.** Exact, not stale, 13 rollouts (4 archived),
zero findings, one migration note. Catch-up took three scans (partial 2 → 1 → 0) with no
degraded trigger on any of them. Archiving the largest live rollout (100 MB) afterwards added
**zero** observations, success counts 77 → 77, cursors 13 → 13. 34 mutants, all killed.

**Measured facts, Codex 0.161.0 on Windows, 2026-10-13.** `threads.has_user_event` is 0 for
all 13 rows, including threads with transcripts, so it cannot classify anything.
`rollout_path` mixes `\\?\`-prefixed and plain spellings. Every observation Codex writes has
a `call_id`; an observation without one would put its file path into its identity and would
recount on a move, which is theoretical today. `node:sqlite` DOES load in the VS Code 1.141.1
extension host (Electron 43.7.7, Node 24.21.0): the comments that said no shipping VS Code
carries it were out of date, and the `unavailable` tier stays only because the engine floor is
`^1.80`.

### The Codex memory false positive — FIXED, `b158f3d` and `f9f0e24`

`lintFile` matched any forward-slash path merely ENDING in `skills/<x>/SKILL.md` and checked
it against `memories/skills/`. Rollout summaries are session narrative and cite the session
project's own `skills/` paths; the flagged one existed in its project. Backslash spellings of
the same reference never matched, so the verdict depended on slash direction. Codex
regenerated the store mid-fix and `MEMORY.md` gained two bare project-skill citations of its
own, so the rule had to be sharper than "registry files only". Evidence for the final rule, from
the installed Codex 0.161.0 consolidation template: "If you reference skills, do it in body
bullets only (for example: `- Related skill: skills/<skill-name>/SKILL.md`)", and its read
path opens `skills/` only "if MEMORY.md directly points to" them. So a `skills/` reference is
linted only on a `Related skill(s):` line of `MEMORY.md` or `memory_summary.md`;
`rollout_summaries/` references are linted everywhere, as whole tokens. Diagnostics carry a
0-based line. The live store went from 3 diagnostics to 0, and the row says "1 issue", not
"1 issues".

### The live hook ran a checkout 142 commits old — FIXED

Found while diagnosing the above: the box's PostToolUse hook pointed at the pre-rename
checkout directory at v1.4.13 — before the MAX retirement — while the maintained checkout
lived under the new name. No fix since 1.4.13 had reached a real tool call, and nothing could
have noticed: smoke drives `$REPO/bin/wildcard-perms` directly and `verify-release.ps1` only
checks that SOME PostToolUse hook exists. The hook was repointed by hand through
`writeTransform` with a backup. The trap itself was in the installers: both deduplicated by
exact command string, so installing from a moved, renamed or re-cloned checkout ADDED a second
hook beside the stale one and both fired. `1aa811a` makes both installers recognise this tool
from any checkout and repoint it in place (matcher, position and fields kept, deduplicated per
matcher, old → new printed); the uninstallers also remove a registration whose target file is
gone and name, but leave, a live other checkout's. Four pre-existing installer defects found
alongside, all FIXED: `verify-installers.ps1` leaked 22 sandboxes per run under an 8.3 `%TEMP%`
because `Remove-Item` fails on short names (`97de88f`); `install.sh`'s starter-pack count threw
`MODULE_NOT_FOUND` under Git Bash (`263ae96`); `install.sh` under Git Bash registered a bare
Windows path, which pops "How do you want to open this file?" on every hook fire (`6f8925c`,
now byte-identical to `install.ps1`'s `node "<path>"`); and an 8.3 spelling of the same
checkout read as another checkout (`4908466`). ACCEPTED-RECORDED from that last one: the
`.ps1` pair expands 8.3 names but not junctions or symlinks, so a linked spelling is still
repointed — harmlessly, with a wrongly worded notice.

### Shell grammar minted into broad grants — FIXED, `a910daf`; exporter gap — FIXED, `64b4eaa`

`generalizePermission` keyed on any first token, so `Bash(for f in a b)` became
`Bash(for *)`, `Bash(if …)` became `Bash(if *)` and `Bash($EDITOR x)` became
`Bash($EDITOR *)`, contradicting the module's own comment. Measured with
`src/permission-match.js`: `Bash(for *)` covers `Bash(for f in *; do rm -rf "$f"; done)`, and
`processAllowList` then pruned every other exact loop as covered. Bash entries that open with a
reserved word, an expansion, a subshell or group, a glob in the command name, an
assignment-only line, or an expansion inside an env prefix now stay verbatim
(`FOO=$(rm -rf ~) git status` used to become `Bash(-rf *)`). The keyword sets are copies of the
classifier's, not imports, because `src/fixed-point-cache.js` stamps only `permissions.js` and
`permission-match.js`; an import would let a classifier edit change the pass's output while
the cache kept answering "already a fixed point". A drift test holds the copies in step.
Live-list impact on this box: none — old and new output byte-identical.

The Codex export refusal table missed 27 of the learner's 43 wrapper roots, so a reviewed bare
`["node"]` or `["xargs"]` rendered (99 spellings with `.exe`/`.cmd`). It is now the union of
its own list and the learner's. A union is right for refusal specifically: refusing more is the
safe direction, and the import can never shrink the exporter's own extras. Side effect,
intended: reviewed multi-token runner rules on the Claude side (`Bash(node --version *)`) are
now refused at any depth, as `Bash(just --version *)` already was.

### Every other open entry

| Entry | Disposition | Evidence |
|---|---|---|
| Tracker 1, seven surviving mutants | **REFUTED for five, FIXED for two, plus an eighth found and FIXED** | Five were killed by `590df24` (2026-09-24). `COVER_KEY_CACHE_LIMIT` and the non-string passthrough are now pinned (`cb8dc6d`; the passthrough comment's "stale memo" rationale was also wrong — `ruleMatches` refuses every non-string). The third `lockedRetries` reset, after the lock, was a survivor nobody listed (`b9c5a40`). |
| Tracker 2, option keys with zero suppliers | **`managedPolicyPath` CLOSED-VERIFIED; the other four FIXED**, `42e5a15` | `managedPolicyPath` has three runtime-script suppliers since `63cb99e` and now a test supplier that kills the stat-path and read-path mutants. `defaultTool`, `priorCursors` and the duplicate `homeDir`/`successThreshold` spellings were removed with their unreachable branches after a tree-wide zero-supplier grep; a test on the extension's option object guards the supplier side, since re-adding a dead fallback leg is unobservable. |
| The Auto Learn worker deadline is environment-variable only | **FIXED**, `a22209f` | `permissionWildcarding.autoLearn.workerTimeoutSeconds` (default 300, 0 disables, `machine` scope so a repository cannot switch the deadline off). The runner re-reads it per operation, and it is supplied only when the user set it, so the environment variable still governs otherwise. |
| Trusted project rule directories never enumerated | **FIXED**, `d5200f9` | Measured on codex-cli 0.161.0 in isolated sessions: a project's `.codex/rules` is obeyed only when Codex trusts the project; `config/read` with `includeLayers` lists exactly the obeyed layers. Discovery asks Codex, cached on `config.toml`; with no reachable codex only an exact trusted `[projects]` entry counts and the rest is named in `blindSpots`. The user-scope write validator deliberately excludes project rules, so one broken project file cannot block user-scope maintenance everywhere. `scripts/check-codex-project-rules-runtime.js` re-runs the measurement. |
| The Codex Stop hook failed on budget deferral | **FIXED**, `0d266fd` | `partial` is progress. A deferral alone exits 0; a deferral of this turn's own rollout is reported as a `systemMessage`. Errors, unreadable stretches and blind scans still fail. |
| A reported `DatabaseSync` deprecation | **CLOSED-VERIFIED and hardened**, `71b685f` | DEP0210 is real and documentation-only (Node 26.11.0): 26.11.1 exports `Database === DatabaseSync`, synchronous, with no warning even under `--pending-deprecation`; 22.23.3, 24.19.0 and 24.21.0 export `DatabaseSync` only. The readers prefer `Database` only when it is provably that class. The real noise was Node 22's ExperimentalWarning printed over a clean `--learn scan`; it is filtered for that one require. |
| `scripts/smoke.sh`'s tautological cache assertion | **FIXED**, `18fad85` | After the restore the hook runs again; PASS only if the cache text, its mtime and `settings.json` are unchanged. Under a temp-home harness the old block passed a stale-stamp key, a stale-bytes key and a hook that exits 3. |
| Declare and exercise a Codex version window | **FIXED**, `afbe9d5` | Window 0.145.0-0.161.0 in `src/codex-version.js` and `docs/codex-compatibility.md`, reported as information only (dashboard line, `--learn status`), enforced only as the CI pin. |
| Provision Codex in CI | **FIXED**, `71b1961` | Contract and guidance-matrix tests run on the Node 22 legs against `@openai/codex@0.161.0`; `ACOLYTE_REQUIRE_CODEX` makes a skip a failure. **ACCEPTED-RECORDED:** the runtime harnesses stay out of CI — they drive Codex's real sandbox and approval path, unobserved on a hosted runner, and most are Windows-only. |
| Runtime harnesses against 0.161.0 | **CLOSED-VERIFIED**, `e5360c2` | Every CLI-only loopback harness passes after harness-side drift fixes: the shell tool is `exec_command` now (the responder reads the offered tool names), Windows clamps a yield to at least 10 s, an 8.3 short path, and the MCP rollout shape. The MCP harness surfaced a product defect, open in `BACKLOG.md`. |
| Direct-shell evidence beyond the observed shape | **ACCEPTED-RECORDED as of `9a10261`** | With `code_mode`, 0.161.0's custom `exec`/`wait` cells are captured as a sanitized fixture: completed cells classify correctly, continued cells are withheld as unknown. The join is open in `BACKLOG.md`. |
| A representative matrix of shell wrappers | **CLOSED-VERIFIED on Windows**, `e4d3985` | `codex execpolicy check` never unwraps a shell (20/20 rows agree with the guidance); at runtime, chains of allowed commands run unprompted and a new command, a redirection, `$()` or a wrapper prompts (13/13). Nothing contradicted the guidance text. The POSIX list is open. |
| The runtime provenance hash missed the exporter's dependencies | **FIXED**, `92db159` | The hash covers the transitive local `require()` closure of its roots, derived from the source, and the harness fails if a loaded subject module falls outside it. |
| Large, partially missing real history | **CLOSED-VERIFIED**, `9abc330` | The archived-thread acceptance ran over a copy of a real Codex home: 13 rollouts, 4 archived, one of 170 MB. |
| Hosted-web outcomes; prompt causes outside visible policy | **ACCEPTED-RECORDED** | Neither can be exercised through the loopback provider: hosted tools run server-side, and a prompt with no visible rule has no local policy to read. |
| Codex 0.161.0 MCP results invisible to the parser | **FIXED**, `6eb35c1` | Outcomes are `item_completed` `McpToolCall` items; their `id` equals the call's `call_id` on all 5 real rollouts, so both shapes land on one observation, and a pinned pre-change id proves the old shape's identity did not move. The VS Code MCP suite asserts through the same shared check (`a777d59`). |
| Continued code-mode cells earned no evidence | **FIXED**, `d934419`, `53b7212` | A `wait` binds to the single open yielded cell with its id in its session; ambiguity withholds, a re-yield stays pending, `terminate` credits nothing. Measured on 0.161.0: a resume appends to the same rollout and restarts cell ids, a fork is a new file from 1, and a wait for a cell killed at the restart gets "not found" — a close, never a failure. **DECLINED-MEASURED:** `thread_settings_applied` as a resume epoch, because a same-process override turn writes it while its running cell survives. **ACCEPTED-RECORDED:** after a reload, a new cell reusing a still-open old cell's id is withheld with it. |
| Call groups keyed by call id alone | **FIXED**, `a672b3a` | Worse than recorded: a failure in one session turned another session's direct `exec_command` success into `failed`. Groups are keyed by session and call id; ten pre-change observation ids are pinned unmoved. |
| Runtime harnesses read the user's home `AGENTS.md` | **FIXED**, `128172f` | Codex's `AGENTS.md` walk stops at any directory holding a `.git` entry, even a non-repository one, while project layers and trust count only a real repository. Each workspace gets an empty `.git`, and a canary one level up fails the run if foreign instructions reach a request. |
| The wrapper matrix's POSIX case list | **CLOSED-VERIFIED for prompting; ACCEPTED-RECORDED for execution** | Run 2026-10-13 in a `node:20-slim` container on codex-cli 0.161.0: all 12 POSIX cases prompt exactly as the guidance says (0 approvals for the four allowed chains, 1 for each of the eight that must prompt; the empty-rules control prompts). The allowed commands did not execute inside the unprivileged container, most likely because Codex's Linux sandbox cannot start there, so the harness's execution witness reads DIFFER for those four. |
| The Codex Stop hook's reasons never reached the user | **FIXED**, `5611d4d` | Codex 0.161.0 reads a Stop hook's stderr only on exit 2, which blocks the run. Lost evidence, blind scans and a held lock are now a path-free `systemMessage` with exit 0; malformed input and an unanticipated crash still exit 1, so "cannot run" stays distinct from "found a problem". |
| Tests that failed under parallel load | **FIXED**, `597b4f7`, `1d6b776` | Windows refuses a rename while anything holds a handle: a directory rename while a file inside is open (EPERM), a file replace while the target is open, a junction while the new directory is open (EBUSY). CPU load alone never reproduced it; a stand-in scanner holding each new file 10 ms did, in up to 60 of 60 runs, and 0 after. `strictWrite` was the one product writer with no retry and now retries the same rename, re-reading the target first. The recall model download's rename retries on timers (`b4271f3`). Lesson: a stress harness that models a scanner must use a private TEMP; the first one here held other worktrees' fixtures. |
| A missing Codex executable read differently on Linux | **FIXED**, `78b7d34` | `commandLaunch` resolves only on Windows, so on POSIX the config worker's "not reachable" pre-check never fired and spawn's own ENOENT text broke the trusted-project fallback note; red on both Ubuntu CI legs, green on Windows. |
| `timeout`/`command`/`builtin` collapsed to root-wide grants | **FIXED**, `d946f01`, refined `9a5324e` | Per Claude Code's permissions page and its 2.1.296 binary, a fixed set of wrappers is stripped before matching, so a wrapped approval keys on the command it runs. The binary's allow-path stripper is narrower than the docs (`stdbuf` only with fused modes; `xargs` only innermost). The learner and the generalizer now share one routine. |
| Env-var prefixes | **FIXED**, `a9e2adf` | Claude Code 2.1.296 strips a leading assignment only for 39 known-safe names with plain values, and tries a rule against both the raw and the stripped text. Any other assignment is now kept verbatim in a generated rule. Live list: 37 env-prefixed entries, all unchanged. |
| The matcher did not model stripping | **FIXED**, `122901f` | `ruleMatches` tries raw and stripped text (Bash only); coverage can only move toward "covered". Live list: 0 more entries pruned. Cost per `processAllowList` pass on 581 entries: about +0.3 ms warm, +1.7 ms cold. |
| Codex prefixes ending in inline code, exec wrappers, interpreters | **FIXED**, `30f92a4`, `a309f54`, `668a685` | Inline-code flags anywhere after a runner, 31 exec wrappers with their own option grammars, privilege changers at any depth, and interpreters that must pin a script or module. Probes: 41, 80 and 70 previously rendering prefixes refused; none opened. |
| Digit-leading roots, path-rooted executables | **FIXED**, `2b8e6b2`, `82dbe01`, `675ce3a` | `7z`-style names generalize and promote; numeric and range literals stay verbatim; any first token with a separator, a leading `~` or a drive letter stays exact. |
| Over-broad grants minted by the old generalizer | **FIXED**, `f218881` | A read-only count of wildcard grants keyed on shell grammar, with a filtered picker. This box: 2 of 425 (`Bash(export *)`, `PowerShell(& *)`). |
| Gate and memory diagnostics numbered lines differently | **FIXED**, `9ff0414` | 0-based everywhere internally. |
| Starter-pack wrapper entries | **FIXED**, `c31aa30` | `Bash(timeout *)` and `Bash(nohup *)` removed, `Bash(command *)` narrowed to `Bash(command -v *)`, `Bash(xargs *)` kept. The 13 maintainer-decided blanket grants are untouched. |
| A refused code-mode cell read `failed` | **FIXED**, `3521c46` | Measured with marker files on 0.161.0: a refused nested `exec_command` never runs, and the cell reports "Script failed" plus "Script error:" and the same refusal text a direct call returns (the approval-never escalation refusal, or the user decline). Direct calls already read that as unknown; cells now match, including through a wait. Only the exact shape and the two measured messages count. **ACCEPTED-RECORDED:** other refusal sources (an execpolicy `forbidden`, a Guardian or auto-review denial, an aborted approval, a nested `tools.shell_command`) are unmeasured and still read failed — the conservative direction. |
| A declined MCP call counted as `failed` | **FIXED**, `3f9a224` | A decline never reaches the server and is recorded as `status: failed`, `error: {message: "user rejected MCP tool call"}`, no `result`; a server error has the same structure with a different message, so only the measured decline (and 0.145.0's `{Err: "user rejected MCP tool call"}`) reads unknown. A decline vetoes a success for the same call. MCP families are review-only, so review counts move and no grant changes. **ACCEPTED-RECORDED:** an MCP `cancel`, a Guardian denial and a server that dies mid-call are unmeasured and still read failed. |
| Dev-environment runner prefixes | **FIXED**, `b0685b2` | Exec forms (`uv run`, `poetry`/`pipx run`, `npm`/`pnpm`/`yarn exec`, `docker`/`podman` `exec` and `run`, `kubectl exec`, `direnv exec`, `mise exec`) stay broad until they name a narrow command; `ssh` and `devbox` are broad at any depth — devbox's own source runs an ad-hoc command through `eval`; make/just/npm value options are modelled. Probe: 154 of 268 refused, none opened; live list 0 changes. **ACCEPTED-RECORDED:** benign docker/pnpm/yarn top-level options beyond the modelled few are refused as unknown (the safe direction), and `go run`/`cargo run`/`dotnet run` run project code, the same class as `npm test`. |
| Env-led learner families | **FIXED**, `794d7ae` | A run led by an assignment Claude Code keeps forms its own family with the generalizer's rule, and a quoted, expanding or credential-shaped value is keyed `NAME=<redacted>` with no rule, so no secret reaches the state file. **ACCEPTED-RECORDED:** families stored before the split keep mixed counts and stay review-only; there is no way to split them. |
| Recall download temp name | **FIXED**, `7e43af2` | `<dest>.<pid>.<random>.tmp`; a failing download unlinks only its own file. |
| Docs bullet merge; the strip model's re-read | **FIXED**, `7a42d4b` | `scripts/check-claude-strip-model.js` compares the installed Claude Code's known-safe environment names with `CLAUDE_SAFE_ENV_VARS` (2.1.296: the same 39). **ACCEPTED-RECORDED:** it checks the names only; the value class and the wrapper regexes remain a documented manual re-read on each Claude Code release. |
| The Windows file-holder stress harness | **FIXED**, `4b41fb7` | `scripts/stress-windows-holders.js`, private TEMP enforced, with a self-check. |
| "A value is a command" Codex prefixes | **FIXED**, `894e86d` | Measured in a private temp dir: `git -c core.fsmonitor=CMD status`, `tar --to-command` / `--checkpoint-action=exec`, `scp -S`, `sftp -D` and `fd -x` each ran CMD. A GIT dispatcher refuses `-c`, `--config-env` and `--exec-path` before the subcommand while `-C dir` stays a path; rsync, scp, sftp, tar, find and fd run any command; compose and nerdctl take docker's grammar. Probe: 72 of 76 refused, none opened. **ACCEPTED-RECORDED:** a git subcommand's own command-valued options (`git grep -O<cmd>`, `rebase -x`, `bisect run`, `submodule foreach`, `difftool -x`, `fetch --upload-pack`) still pass a reviewed rule naming that subcommand. None of those subcommands is ever applied automatically (`SAFE_GIT` holds only read subcommands without such options), so the exposure is limited to a rule a human approved. |
| Program-naming environment variables | **FIXED**, `520103d` | `PAGER`, `EDITOR`, `GIT_SSH_COMMAND` and 17 more are refused in env-led reviewed rules, `CC`/`CXX`/`MAKE` deliberately (refusing more is the safe failure); data-valued variables still render. |
| Env-led `.exe` spellings | **FIXED**, `1be8dc2` | `FOO=1 cat` and `FOO=1 cat.exe` are one family granting both spellings, through the plain-key migration machinery. |
| Stale recall download temp files | **FIXED**, `ff0559b` | At download start, `<dest>.*.tmp` older than 24 h (and the legacy fixed name) is swept; a younger one may be another window's live transfer and is kept. |
| Already-scanned Codex history kept old verdicts | **FIXED**, `9a7ca3f` | `CODEX_EVIDENCE_REVISION` 3 → 4 re-reads Codex history once through revision 3's mechanism; Claude evidence, grants, reviewed sets and Undo are untouched and auto-apply pauses until the re-read completes. The bump alone would have counted a preserved grant's replayed failures twice and absorbed a genuinely new failure; a still-preserving record now restarts from its Claude failures and an outgrown one is dropped. Measured on a copy of real history: 3 scans, 40 Codex calls re-read, 0 of 13 families differ from a same-parser catch-up, no Claude count or grant moved. **ACCEPTED-RECORDED:** the 20,000-hash cap evicts Claude dedupe hashes to make room for re-read Codex ones (26 here), as any new evidence would. |
| Shebang'd scripts checked out CRLF | **FIXED**, `d426a81`, `f66931c` | Ten scripts gained `text eol=lf`; a renormalize changed no index blob. |
| The `file:line` gate catches less than it looks like | **FIXED**: mechanism `92199d6`, migration `ff1eb33`, `dbd3c57`, `fd803b2`, ratchet in the commit that closed this row | Every collected citation (193) is `file:line#anchor`, chosen by hand from its target and from the commit that introduced it; that morning 61 of 160 were STALE and none could fail. The suite now fails on a missing anchor as well as a moved one, so a new citation cannot slip back into the heuristic. Within hours of landing, a merge moved 14 anchored lines: `--fix-anchored` repaired the unique ones and named the rest for a hand repoint, instead of citing the wrong code. Mid-merge, `git ls-files` lists a conflicted path once per stage; the file list is de-duplicated. | `file:line#identifier` is checked exactly and `--fix-anchored` repoints a uniquely moved anchor. Its first live catch came hours later: a merge moved the anchored line and the suite failed instead of citing the wrong code. |
| `precedence` returned, never read | **FIXED**, `da9b08a` | A keys test pins the verdict shape. |
| `CODEX_BUNDLE_CACHE` export and its stale citation | **FIXED**, `acc9f79` | Export removed with its `PENDING_REMOVAL` entry; the constant and its default-argument use stay. |
| Case-mismatched rule target on Windows | **FIXED**, `dfc04a2` | Wider than recorded: reachable from shipped code, because `readdir` returns the on-disk name and the target basename is hard-coded lowercase. One win32 `key()` now drives the target check, dedupe and substitution. |
| Packaging gate reports but does not quarantine | **FIXED**, `c22ff68` | `gateOrQuarantine` removes the rejected VSIX and its stamp and rethrows the gate's own error. |
| `warnedOnce` survives a same-realm re-activate | **FIXED**, `4eb25fe` | Cleared in `activate()`; the module-state inventory below was re-counted the same day. |
| Cosmetic: `swapped` in the contract test | **FIXED**, `5d67373` | |
| `explicit: true` legacy cleanup has no UI entry | **ACCEPTED-RECORDED** | By design: `test/dashboard-view.test.js` pins that the retired ids regain no dashboard route, and an existing user keybinding still reaches them. |
| Project-local card reports on a path it did not watch | **FIXED**, `770c62c` | One shared `localRoots()`; an untrusted window lists its files but shows no dry run; the payload names every path. |
| …recursive discovery of nested `settings.local.json` | **DECLINED** | It would promote approvals granted inside nested clones into user scope from a parent window — the trust concern the drain gate exists for — and the CLI hook already drains each session's own cwd. |
| `liveChildren` and `liveTransfers` are parallel sets | **ACCEPTED-RECORDED** | Kept separate because the kill verbs differ. Revisit trigger: a third kind of in-flight job. |
| Three roots that fit neither table | **FIXED**, `edb59ed` | `just`, `make`, `hyperfine` and `duckdb` are shell wrappers in the learner, each with a dated citation of the tool's own docs, and refused as bare Codex prefixes. |
| `1..6` emits a live `PowerShell(1..6 *)` | **FIXED**, `3ebbf04` | A leading `<int>..` in PowerShell is `missing-command-root` + `script-syntax`; `7z` and Bash are unaffected. |
| 14% of stored approvals can never be wildcarded | **FIXED**, `0ecd9b0` | Read-only `deadShellApprovals` plus a Saved-permissions line and a filtered picker; nothing is removed automatically. `shell-structure` alone is excluded: it fires for path executables, which do match again (69 false positives measured). This box: 68 of 137 exact shell approvals (12.1% of 562). |
| The returned-object dead-code rule | **DECLINED-MEASURED** | Re-measured 2026-09-27 at one finding, with five false-positive classes and a real-AST requirement that would cost the repo its first dependency. |
| Cancelling the model download mid-redirect | **REFUTED** (2026-09-27, unchanged) | |
| npm CLI publishing | **Owner decision 2026-10-13**, see "Deferred by the maintainer" | |
| Stale screenshots | **Owner decision re-affirmed 2026-10-13**, see "Deferred by the maintainer" | |

---

## Further Codex outcome closures (2026-09-28, unreleased)

The final combined Stage C has 52 verified files, aggregate
`3074c8ae9a60623d40c93f32ba6ff6329890a18b3d902917a40731866d41ae73`.
Its full source suite reports 1,080 passes, two skips and zero failures among 1,082
tests, with no source/test drift (`acolyte-features-suite-gZjx2V/report.json`).
Seven actual editor groups pass against this stage, and both fresh native wait outcomes
pass. The compatibility record links final provenance and transfer of the unchanged
negative-control modules. Earlier native batches retain their exact staged subjects.
No release, installation, commit or tag was performed. A final comparison with the old
backlog found no dropped Codex outcome; broader validation and policy-discovery limits
remain recorded as open.

CLOSED-VERIFIED: editor-open background learning. Actual completed Codex history was
ingested by the watcher and by the unchanged one-minute reconciliation timer after a
deliberately missed notification. Disabling either route failed its native ingestion
group. This closes an unverified existing outcome, not a previously missing feature.

FIXED in development: after-turn editorless learning; native memory discovery, ambient
diagnostics and source passage search; reviewed widening of authored stored approvals;
and reviewed portable project imports. The compatibility record names immutable stages,
full evidence directories, exact native groups and deliberately failing controls for
each. No release, tag, package or replacement of the user's working extension was needed.

Native memory testing found a real BOM offset defect: the adapter retained a UTF-8 BOM,
while VS Code's TextDocument removed it. Stage A found the passage but could not select
it. Explicit BOM provenance now translates only that known difference; Stage B selects
both the first and a later passage exactly. Reintroducing the offset error fails only
that native group after the five earlier groups pass.

The reviewed-rule tests also corrected two fixture assumptions. Codex already allows
the read-only `git status` command, so zero approval prompts before widening was expected
runtime behavior, not a product failure. Its proof now checks explicit policy coverage.
A custom executable supplies the real import prompt transition and restrictive-argument
control. The planner does not classify `git diff` as auto-safe; stale/recovery fixtures
now use supported prefixes. All failed preliminary runs remain preserved.

FIXED in development: authoritative MCP outcome ingestion and exact reviewed native
per-tool approvals. Six actual VS Code groups and seven fresh Codex calls pass; no-op
approval, Undo and recovery writers each fail their intended group. The immutable subject,
loaded hashes and witnesses are recorded in
`D:/.ai-work/scratch/acolyte-validation-mcp-dev-20260928/results.json`. MCP candidates
remain separate from Claude permissions and shell rules. Semantic retrieval and its
editor acceptance retain their separate evidence. CPU semantic tests use only synthetic
sources and the installed CPUExecutionProvider, with no local GPU, model download or
private-corpus evaluation. Keyword fallback is always identified.

FIXED in development: native semantic recall. Seven CPU groups and four actual editor
groups cover paraphrase retrieval across registry, rollout and skill sources, exact source
selection, actual index rebuild and explicit keyword fallback. Semantic bypass, rebuild
no-op and silent fallback controls each fail the intended native group. The canonical
record is `acolyte-validation-mcp-recall-dev-20260928/native-recall-results.json` under
scratch. No general search-quality score or performance improvement is claimed.

The native gate compiler's final review reproduced an actual deletion bug: malformed
`scope` metadata was treated as a complete zero-section compilation, so automatic refresh
emptied the installed body. The final helper rejects malformed/unsupported scalars visibly,
accepts ordinary metadata comments, and preserves valid project/task scope as a distinct
zero result. Eighteen tests pass, and all five new scalar/metadata controls fail exactly
their named tests (`acolyte-native-gate-scope-mutations-zGZvpM/evidence.json`). Earlier
helper checks killed 21 transaction/annotation mutations; UI checks killed 16 more.
Stage B replaces only that helper in the immutable 52-file Stage A. Six fresh Codex
processes load full installed/refreshed bodies and verify absence after removal; the
missing-block control fails at the actual request. Evidence is
`acolyte-validation-native-gates-dev-20260928/final-runtime-provenance.json`.
FIXED in development: the same stage passes seven editor groups covering gates and
read-only MCP receipts, with 16 UI actions/status observations. Install, refresh and
receipt-visibility controls each fail exactly the intended group. The unchanged Stage A
also fails its malformed-source group after the first four pass. Full profiles and
screenshots are retained in that directory's `native-results.json`.

FIXED in development: direct exec_command/write_stdin completion learning. Actual Codex
runs initially left both success and failure unknown. Exact process attribution and
header-only terminal metadata now classify both correctly; interactive or ambiguous
completions remain unknown. Twelve parser mutations fail their intended assertions,
and disabling the process bridge fails a fresh runtime outcome after the command and
wait execute. The records are `acolyte-wait-history-mutations-41lYsS/report.json` and
`acolyte-wait-runtime-validation-61hUMH/report.json`. Revision 3 replays old completed
cursors once without replacing Claude evidence, policy or Undo; reverting the revision
fails its named migration test (`acolyte-wait-revision-mutation-JmpPFV/report.json`).
Custom cell continuation remains outside this measured shape.

One full-suite attempt was stopped after independent native-gate activation jobs consumed
the lifecycle fixture's synthetic Auto Learn wedge. The fixture now distinguishes those
jobs, and all 36 lifecycle tests pass. The incomplete run is retained as
`acolyte-features-suite-4Z06NR/aborted.json`, not counted as a passing suite. New gate
teardown and deferred-refresh behavior also have their own directly exercised regressions.

### Built-in tools do not inherit the MCP approval proof (2026-09-28)

DECLINED-MEASURED for adding an approval exporter solely to mirror the measured
`view_image` calls: three fresh Codex 0.145.0 processes requested zero approvals.
The valid PNG returned structured `input_image` content; invalid bytes still emitted an
`imageView` completion event, without a success status. Completion therefore cannot be
treated as successful image processing. Runtime evidence is
`D:/.ai-work/scratch/acolyte-view-image-probe-hbRWef/evidence.json`; substituting invalid
bytes for the valid fixture fails the image-output witness, recorded in
`D:/.ai-work/scratch/acolyte-view-image-mutation-6jSmpc/report.json`.

The hosted-web boundary stays open. A metadata-only read of 64 current-profile rollouts
found 70 `WebSearch` completion items with result fields but no authoritative outcome
status, and no direct `web_search_call` or web end records. The report at
`D:/.ai-work/scratch/acolyte-builtin-metadata-CvcHSs/metadata.json` contains only types,
field names, status metadata and counts. No prompts, arguments, URLs or result bodies
were retained. A scripted hosted-search result would not prove actual retrieval or
approval behavior. No built-in counters, guessed successes or speculative permission
exports were added. This scoped decision does not establish platform impossibility.

## Codex recovery and derived guidance: FIXED in development (2026-09-28)

The user asked for extension behavior to work with Codex and then asked us to close
the gaps. This is feature validation, not a separate approval or naming program.
The seven comparison areas were not seven failures of the existing learning path.
Reusable learned prefixes and cross-workspace user rules already had real-runtime
evidence; rewriting stored literal approvals and importing authored project rules
were distinct work, closed by the later reviewed-rule batch recorded above.

This batch gave two comparison areas FIXED dispositions. Retained literal policy supports
explicit missing-rule restore, deliberate-removal suppression, preservation of
surviving claims and a resumable write intent. Codex derived guidance uses current
managed policy plus successful Codex-only observations, with full-body review and
separate routing into the active Codex instruction file. The scoped limitations and
source entry points are recorded in `docs/codex-compatibility.md`.

Recovery Stage B, 38 files, aggregate
`0bfd4d881ab7aac06545dca9642f06a2fd4aa3e73e530f8b313ebd20da669e2e`, passed nine real
VS Code groups. The new groups cover four recovery flows and derived Accept/Decline,
with two fresh Codex instruction checks. A no-op Restore fails exactly group eight;
a no-op derived Accept fails exactly group nine. Both record the real control click,
changed source hash and executed mutation witness. The complete pre-modal suite was
885 tests, 883 passed and two platform skips. The final modal has 51 passing focused
checks and two mutation failures for truncated content and writing after teardown.
Standalone recovery checks add ten fresh processes and six execpolicy probes per
default/custom layout. Central proof is
`D:/.ai-work/scratch/acolyte-validation-recovery-dev-20260928`.

The first native negative attempt failed on a prior removal flow because the harness
polled a locking inventory method. It is retained as incomplete evidence, not a
successful mutation test. Passive byte/journal polling removed that interference.
The first full-body modal run failed because its observer counted an unlabeled close
icon as a decision. The corrected observer requires all four labeled actions and the
full instruction; the product dialog fit visibly throughout.

There was no packaging, installation, version bump, tag or release. Immutable stages
allow continued development of the hook and memory work without rewriting the test
subject. Installed 1.5.10 and its existing VSIX remain unchanged.

## Which of desktop-ai-companion's optimisation learnings transfer here (2026-09-22)

Moved out of BACKLOG.md on 2026-09-22. The question was asked by the owner; this is the
measured answer, and it belongs here rather than in a queue where an unticked box invites
somebody to re-derive it.

**The technique does NOT transfer, exactly as the item predicted, and now it is measured.**
AgentFlow's 1.7x came from `DirectoryInfo.EnumerateFiles` returning `FileInfo` with the write
time already filled in by the directory scan. **Node's `Dirent` exposes `name` and `parentPath`
and nothing else** (checked directly on Node 24.16.0: no `mtime`, no `size`). `findJsonlFiles`
already uses `withFileTypes` and never stats a discovered file; the one stat per file exists
because the cursor needs `size`, which `Dirent` cannot supply. That stat costs **47 ms across
955 files** and there is nothing to win.

**Two more of their findings are already solved here**, worth recording so nobody re-proposes
them: scans run off the extension host in a worker thread, via
`runAutoLearnWorker('scan', { mode: cfg.mode, threshold: cfg.threshold })` at
`vscode-extension/extension.js:1786#runAutoLearnWorker`, which is the fix their pane still needs. And the
watcher-plus-reconciliation-sweep architecture their backlog defers to is what this repo
already runs.

**Measured and not worth doing**, so the numbers exist before someone guesses: the locale-aware
sort of 955 paths is **12 ms**; the two path hashes per file are **22 ms**. The only remaining
lever of any size is the head/tail re-hash over every unchanged file, **140 to 160 ms**, and it
needs a correctness argument rather than a performance one, because it is what proves a file was
not rewritten in place between scans.

**What DID transfer was a question, not a technique:** what does the five-hundredth tick cost?
Asking it of the scan is what surfaced the entry above.

---

## What a transcript cursor means, and why catch-up beats skipping

Settled 2026-09-22 while fixing the oversized-transcript defect. Read this before changing
anything about `scanHistoryFiles`' read path.

**A cursor asserts exactly one thing: bytes `[0, size)` of this file are accounted for.**
Nothing requires `size` to equal the file's CURRENT size, and that gap is the whole fix. A scan
that consumes a bounded slice records what it consumed; the next scan resumes there. Nothing is
skipped, so no failure can be silently lost, and the cursor never has to express a hole.

**Three designs were considered and two rejected.**

- A `partial: true` marker on the cursor. **Impossible without a schema change.** `cursor()` at
  `src/auto-learn-manager.js:508-520#cursor` is a strict whitelist with no boolean leg, applied both on
  read and on scan-replace, and it drops unknown fields SILENTLY — the marker would vanish in
  the same tick it was created. Bumping `VERSION` to carry it reset every existing state file
  then, because `STATE_MIGRATIONS` was empty and `migrateState` returns null for an unregistered
  step. (It has since gained the 1→2 and 2→3 steps, so a bump now needs a registered step, not
  a reset.)
- A size ceiling that skips the remainder. **Rejected on safety.** `isAutoSafeCandidate`
  requires `counts.failed === 0` (`src/auto-learn.js:1052#counts.failed`), so a skipped byte range containing
  the one failure for a family would let that family become auto-safe. Skipping is not a
  performance trade here, it is a permissions trade.
- Progressive catch-up. **Taken.** Bounded work per tick, honest cursor, nothing lost.

**The budget is measured from the CURSOR, not from the slice start, and the difference is not
cosmetic.** The append path reaches back up to `overlapBytes` (256 KB) to find a record
boundary. Budgeting from the slice start meant that on any cap smaller than the overlap the
entire budget went on re-reading bytes already accounted for: the cursor never advanced and
catch-up looped forever. Caught by the differential test, not by inspection.

**MEASURED 2026-09-22, live corpus, one call per fresh process.** 955 transcripts before, 962
after (this session's own files landed in between), 819 MB Claude plus 5.98 GB Codex.

| | steady-state tick | bytes read | errors |
|---|---|---|---|
| before | 755 / 783 / 790 / 803 / 849 ms | 118 MB every tick, forever | 1, permanent |
| after, catching up | 1088 then 942 ms | 190 MB then 176 MB, twice only | 0 |
| after, steady | **303 / 316 / 341 ms** | **0** | **0** |

The 2,266,973,030-byte transcript that caused it had never been ingested at all; it is now.

**Do not "simplify" the chunk cap away.** `READ_CHUNK_BYTES` exists because `fs.readSync`'s
length argument is an int32: one call asking for 2,266,973,030 bytes wraps to -2,027,994,266 and
throws before reading anything. It is a parameter of `readRange` rather than a bare constant
specifically so a test can drive it with a small file; a 2 GiB fixture is not writable in a test
suite, and a cap only its own default can reach is a guard nothing can prove.

---

## Verified working, nothing to do

Auto Learn applies. Both symptoms that opened the 2026-09-02/03 work are gone,
confirmed on a real machine 2026-09-03: `~/.codex/rules/permission-wildcarding.rules`
written with 43 `prefix_rule` entries, state `applied.claude` 23 and
`applied.codex` 50, `lastApplication` set across `claude`, `claude-claims` and
`codex`, Review count back to 0.

The allow/deny backup is mirrored off-tree. Added 2026-09-09 after the event
below: the primary copy at `~/.claude/backups/allow-list.latest.json` sits inside
the directory it exists to survive the reset of, which is why the 423 live entries
came back that day on the extension's in-memory copy rather than off disk. It now
dual-writes to `~/.permission-wildcarding/allow-list.latest.json`, overridable via
`permissionWildcarding.backupMirrorPath` for another volume; restore reads the
primary and falls back to the mirror.

Mutation-tested rather than merely green, since three of the four assertions are
about a second file that a naive implementation writes anyway: dropping the mirror
write kills 3 tests, dropping the read fallback kills exactly the recovery test,
and replacing the fallback with a **union** kills exactly the stale-mirror test —
that last one added because the fallback-not-union decision was initially
untested, and a union would resurrect a deliberately pruned entry. Suite 290
tests, 289 pass, 1 POSIX-only skip, 0 fail.

Tiers 1-3 of the 2026-09-09 audit are burned down, 2026-09-10. Thirteen entries
above were removed as closed; the commits carry the mutation results that justify
each. Headlines, all measured on this machine:

- **The hook locks and rebases.** It was the highest-frequency writer of
  settings.json and the only one that neither locked nor re-read. Two phases now:
  the unlocked read is a negative test only, and the changed path takes one lock
  covering both the write and the drain, discards the snapshot and recomputes
  inside it. Replaying the delta instead would have lost a permission outright —
  `Bash(npm test)` granted while MAX was on, marked removed by the stale pass and
  deleted after `--max off` deliberately preserved it. Interleaved measurement,
  n=14 each: min 157 / median 175 ms before AND after, so the common path is
  unchanged.
- **processAllowList: 57 -> 6 ms warm, 85.8 -> 11.6 ms cold** at 423 entries, and
  the same index now serves the other two coverage pools (policy-guard's worst
  case 15.5 -> 6.47 ms). `isCoveredBy` is untouched and still decides every
  answer; the index only narrows, so only a false negative could change a result.
  The differential test found one on its first run — `Bash(rm -rf /*)` has its
  star inside the last token — which is why token-misaligned rules go to the
  linear fallback.
- **Codex evidence is observable again.** `extractNestedShellCommands` accepted
  only `tools.shell_command` while `auto-learn.js` already knew `exec_command`, so
  current Codex transcripts yielded ZERO observations in every mode. Fixing the
  extractor alone was not enough: `customExecCanAttributeSuccess` matched the same
  narrow set, which would have left every call permanently `unknown` and
  `counts.success` at 0. Append-mode `cwd`/`session` are now re-seeded by reading
  forward to the first newline — a fixed-size read cannot work, because the real
  `session_meta` line is 22,095 bytes of Codex system prompt.
- **The extension no longer outlives its own async work.** One `deactivated` flag,
  released on re-activate; all four `execFile` children tracked and killed; the
  worker runner nulled and the busy latch cleared, so a same-realm re-activate is
  not permanently stuck rejecting "Auto Learn is deactivating".
- **The dashboard is under test at all** — 8 tests including a permanent backtick
  guard over the `_html` template literal, after three syntax breaks came from
  one. No production export was needed: capturing argument 2 of
  `registerWebviewViewProvider` was the whole unlock.
- **The release harness is committable**, parameterized by four environment
  variables with auto-discovery, and verified both configured (16 PASS) and
  entirely bare (14 PASS, 6 INFO) so a fresh clone gets skips rather than red.

Suite: **297 -> 337 passing**, 2 platform skips, 0 fail, CI green on ubuntu and
windows x node 20 and 22.

### The coverage index's residual cost, and the trigger that replaced the old one

Live split is now 401 indexed / **3** fallback (2026-09-10), after star-free rules
were dropped from the pool entirely — they cannot cover anything, and 20 of the
previous 23 fallback entries were star-free. Cold `processAllowList` measured
~12.5 -> ~9.3 ms in matched processes.

The residual cost is O(n x fallback), because a rule with a glob INSIDE a token
(`Bash(g* *)`, `Bash(mkfs* *)`) cannot be found by a literal-prefix lookup. That
class is still quadratic — measured n=1600 at 238.5 ms — but it **cannot grow from
this tool's own operation**: `generalizePermission` only emits `Tool(root *)` with
root matching `/^[A-Za-z][\w.-]*$/`, so no `*` can land inside a token. This
sentence also named `mineWildcard`, which was deleted on 2026-09-24 as dead code
with no consumer anywhere including its own file; the substance is unchanged,
because `generalizePermission` and `promotionFor` carry the same constraint.
Re-measured 2026-09-24: live count 5 against a trigger of ~25, so the trigger below
still has not fired.

So the old "revisit if the fallback share passes ~20%" trigger is retired: the
number that could actually grow was the star-free count, and it is gone.
**New trigger: revisit only if `stats().fallback` exceeds ~25 entries**, which
would mean a starter-pack change or hand-written glob-in-token rules. Indexing
that class is possible (bucket on the mandatory literal prefix before the first
`*`, which the compiled regex is anchored on) but is not warranted at 3 entries.

Worth remembering how the one bug here got out: the index's whole safety argument
is that only a false NEGATIVE can change an answer, and a false negative shipped.
`coverIndexKey` treated `:` as a token boundary and `coverLookupKeys` did not, so
colon-form wildcards on non-command tools — including three `Skill(...)` entries in
`patterns/starter-pack.json` — were indexed under a key no lookup could generate,
and being indexed were not in the fallback either. The differential test's
generator only emitted `Bash`/`PowerShell`, where matching rewrites `:*` to ` *`,
so 300 random cases per run could not reach it. Fixed and covered three ways
2026-09-10. The lesson is about the CORPUS, not the code: a differential test is
only as good as the axes its generator actually varies.

### Killing a child can orphan its grandchild

`deactivate()` now kills the four tracked `execFile` children, but `recall.py`
re-execs itself into the toolbox venv (`RECALL_REEXEC=1`), so killing the
immediate child can leave the process that actually does the embedding running. A
process-group kill (`taskkill /T` on Windows) is what would make this certain.

### Module state that still survives deactivate

**Re-counted 2026-10-13. The 2026-09-10 count below it is kept for the record and
is superseded.** Method, so the next count can be compared like for like: every
column-0 `let` in `vscode-extension/extension.js`, plus every module-scope `const`
holding a `Set` or `Map`; then, for each name, every assignment, increment,
`.clear()`, `clearTimeout`/`clearInterval`, or call to a helper that clears it,
inside the bodies of `activate()` and `deactivate()`. A module-scope `const`
holding a stateless object (`settingsWriter`) is not counted.

**38 module-level mutables**: 33 `let` bindings (`let debounceTimer` through
`let activationGeneration`, plus `let extensionVersionMemo` further down) and 5
containers (`liveChildren`, `warnedOnce`, `liveTransfers`, and the two watcher
Maps `memoryCardWatchers` and `gatesCorpusWatchers`). Against `deactivate()`:

- **13 `let` bindings assigned**: `outputChannel` (disposed first), `dashboard`,
  `memoryLint`, `autoLearnManager`, `autoLearnManagerKey`, `autoLearnCardCache`,
  `codexFeatureUi`, `codexMemoryLint`, `codexMemoryGatesUi`, `codexMemoryReport`,
  `deactivated` (set to `true`), and, only when no re-activate happened during the
  awaited drain, `autoLearnWorkerRunner` and `autoLearnBusy`.
- **2 containers emptied** by helpers it calls, after killing or destroying what
  they held: `liveChildren` by `killLiveChildren()`, `liveTransfers` by
  `abortLiveTransfers()`.
- **9 timer handles cleared, not nulled**: `debounceTimer`, `recallSyncTimer`,
  `memBounce`, `gatesBounce`, `autoLearnBounce`, `autoLearnTimer` (an interval),
  `policyBounce`, `localDrainBounce`, `dashboardBounce`. Holding a dead handle costs
  nothing. The 2026-09-10 text said "eleven timer handles" and listed these nine;
  nine is the count.
- **2 watcher Maps emptied by the host, not by `deactivate()`**: `activate()`
  registers `disposeMemoryWatchers()` as a context subscription, so they empty when
  VS Code disposes the subscriptions after `deactivate()` resolves.
- **12 untouched**: `policyLock`, `lockedRetries`, `lastRun`, `recallRebuildAt`,
  `autoLearnLastError`, `autoLearnFailureCount`, `autoLearnNextRetryAt`,
  `localDrainRetries`, `localDrainAt`, `activationGeneration`,
  `extensionVersionMemo`, `warnedOnce`.

`activate()` resets five: `deactivated = false`, `activationGeneration += 1`,
`autoLearnBusy = false`, `autoLearnWorkerRunner = null` and, since 2026-10-13,
`warnedOnce.clear()`. It also repopulates `dashboard`, `memoryLint`,
`codexFeatureUi`, `codexMemoryGatesUi`, `codexMemoryLint` and `codexMemoryReport`,
and re-arms `recallSyncTimer`.

(`activationGeneration` is bumped, never reset, by design: it is the counter
`deactivate()` compares against after its drain.) That leaves **10 names that cross
a same-realm re-activate with neither function touching them**, each inert or
minor. `extensionVersionMemo` memoizes this module's own `package.json`, which
cannot change under it. `policyLock` holds a lock path and closures and no OS
handle between calls; the 2026-09-10 text called it a "disposed object", but
nothing disposes it and nothing needs to. `statusBar`, the other "disposed object"
named then, is no longer a module binding. The other eight are scalars: the retry
budgets `lockedRetries` and `localDrainRetries`, the timestamps `lastRun`,
`localDrainAt` and `recallRebuildAt`, and the Auto Learn failure fields
`autoLearnLastError`, `autoLearnFailureCount` and `autoLearnNextRetryAt`.

`warnedOnce` is the one with a visible effect, and it is not in the 2026-09-10 list
because it did not exist until 2026-09-24. warnOnce's comment promises "once per
distinct message, per activation", and nothing cleared the Set, so after a
re-activate (an extension disable/enable, or an upgrade) a warning the previous
activation had given was never repeated. Cleared with the other resets at the top
of `activate()` 2026-10-13, and pinned by "a same-realm re-activate repeats a
once-per-activation warning" in test/extension-lifecycle-async.test.js, which fails
with the clear removed (1 warning across two activations, not 2).

Still true 2026-10-13: two of the scalars have a real if minor effect across a
same-realm re-activate. `autoLearnNextRetryAt` carries a backoff over, and
`autoLearnFailureCount` carries the count that computes it. Not worth a change on
its own; worth doing next time this file is open.

Superseded 2026-09-10 count, as written then: 28 module-level mutables, **9 reset**
by `deactivate()`, 19 surviving. The five that held real memory were dropped then
and still are: `dashboard` and `memoryLint` each retained the whole
`ExtensionContext`, and `autoLearnManager`/`autoLearnManagerKey`/
`autoLearnCardCache` held parsed history state, the largest thing this extension
builds.

### Non-interactive runs refuse every output redirection

Measured 2026-09-03, Claude Code 2.1.258. Four `-p` probes were refused with
"Output redirection to '<path>' was blocked … may only write to files in the
allowed working directories", including a target inside the session's own working
directory that the refusal itself listed as allowed. The identical redirect
succeeded in an interactive session. Reads as `-p` failing closed because it
cannot prompt, with a message naming the wrong reason. Not this project's bug;
recorded because it invalidates any redirect experiment run through `-p`.

### Claude Code's built-in read-only command set — the inference was wrong, the probe is still owed

**Investigated read-only 2026-09-14. The conclusion below is withdrawn; the doc
now carries an honest marker instead of a confident claim either way.**

Original: `hostname` ran with no matching allow entry and no prompt, so the
built-in set is wider than the 14 commands `docs/claude-code-permissions.md`
lists from the docs. The list is used to argue which pack entries are redundant,
so it is worth pinning down before acting on that argument again.
`scripts/auto-mode-audit.js` is the wrong tool (it reads load-time warnings);
this needs a per-command probe.

**What checking actually found:**

- The official permissions page states the set outright, names the same 14 plus
  read-only `git`, and adds that it **is not configurable** — to require a prompt
  for one of them you add an `ask` or `deny` rule. It reads as a closed list, not
  as examples. `hostname` is not in it, and neither are `date`, `whoami`, `uname`
  or `df`.
- So "the set is wider" does not follow from the sighting. **The sighting has a
  simpler explanation that was never ruled out:** the machine it was taken on
  runs `permissions.defaultMode: auto`, and in auto mode the classifier decides
  everything. This file already documents that mode, in the section table and in
  "Auto mode discards part of your allow list". An unprompted command under auto
  says nothing about the read-only set, because the classifier would have allowed
  it regardless. The starter pack does not contain a `hostname` entry either, so
  the pack was not the explanation.
- **The probe is still owed, and it now has a precondition it did not have
  before: pin the mode to `default`.** Run each candidate with no matching allow
  entry, no `ask`/`deny` rule and the classifier out of the picture, then record
  whether it prompts. A probe run in `auto` measures the classifier and cannot
  answer this question at all — which is exactly how the `hostname` reading went
  wrong the first time.
- Running that probe needs a live Claude Code and is a behavioural experiment;
  no amount of reading settles it, so it was not attempted here.
  `docs/claude-code-permissions.md` now carries the withdrawal, the closed-set
  citation, and the one-directional rule: "it is on the list, so the grant was
  redundant" holds; "it is not on the list, so the grant did something" does not.

### Two things the burn-down proved about this file's own claims

Worth keeping because both were wrong here for a while:

- The drift-test entry said `test/policy-guard.test.js` compared against a third
  hand-copy in `autoLearnUi.js`. That was true once; commit `103b7e8` replaced
  it with a delegation, so the test did reach the canonical matcher and STILL
  could not fail, because all eight of its cases happened to agree. A test can
  be vacuous without being wired wrong.
- The Codex entry said ~40% of resolvable evidence was discarded, from a probe
  that counted output payloads. Re-measured with the real parser: 30 of 6,870
  observations, 28 of them failures, and no candidate changed disposition. Count
  the thing the code counts, not the thing that looks like it.

### RETIRED 2026-09-24: "a single transcript will eventually exceed the 512 MB string limit"

**This entry guarded a door that no longer exists, and its trigger could never fire.**
Kept as a correction rather than deleted, because the mechanism it described is the
kind a later session would re-derive.

It said `parseHistorySlice` does `buffer.toString('utf8')` on a whole file and throws
`ERR_STRING_TOO_LONG` past `MAX_STRING_LENGTH`, with "revisit when any single
transcript passes 200 MB". Both halves are now wrong. `parseJsonlRecords` decodes PER
LINE, so there is no whole-file decode left on that path; the only whole-buffer decode
remaining is inside the 1 MiB-capped `codexHeadSeed`. And the 64 MiB per-file ingest
cap added on 2026-09-22 means no single read reaches 200 MB in the first place, so the
trigger was unreachable as well as unnecessary.

**What replaced the risk, and it is on a different axis.** The pressure is not bytes in
one transcript, it is total observations per scan across the whole corpus: 764 files on
this box today, against 660 two and a half months earlier. Nothing is written against
that axis. The honest trigger is a per-scan observation count, not a per-file size, and
it does not exist yet.

### Inert bookkeeping candidates

Around a quarter of candidates are complex with no permission, so they can never
render a rule, never appear in Review, and cost no prompts: shell keywords
(`for`, `done`) and quoted-executable basenames. Masking is not at fault, checked
against bash heredocs and both PowerShell here-string forms. Cosmetic only.

### Optimization, measured and ranked

All from the 2026-09-10 pass. The hook's own sync I/O is clean — one
`readFileSync` (0.16 ms) and one `existsSync` (0.18 ms) on the common path, no
per-candidate I/O, no lock. Of a 66 ms process wall, ~50 ms is spawn + node boot
and not ours.

| Item | Measured | Frequency |
|---|---|---|
| ~~`require('./managed-policy')` is eager~~ **DONE 2026-09-10.** The figure was wrong three times: 0.61 ms recorded, 2.3 ms predicted by a stub harness that also pre-cached `permission-match`, then 1.27 ms claimed here. Two independent second-party measurements — 30 interleaved repo-resident pairs (**0.889 ms**, min 0.858) and 40 pairs across materialized `33612fe` vs `cd1f50c` trees (**1.01 ms** p50/min) — put it at **0.86–1.04 ms**. The 1.27 was 20–35% high. ~~**The retracted 2.3 ms figure still shipped in a code comment**~~ — **FIXED 2026-09-14.** It shipped in the former managed-policy header near the top of `permissions.js`; that header was later removed with the retired MAX implementation, so Git now holds the historical location rather than a current file:line anchor. | ~0.9 ms | per hook call |
| A fixed-point cache keyed on a CONTENT HASH of settings.json lets the hook skip the read, the module load and the pass | our-code p50 11.80 -> 2.46 ms; wall 62.3 -> 53.6 ms; 30/30 hits | per hook call |
| ~~`memoryReport()` runs TWICE per dashboard refresh~~ **DONE 2026-09-10.** "11.22 ms" was the COMBINED cost of both calls, not the saving — the second is much cheaper because the file cache and the JIT are warm. Measured directly, 11 interleaved fresh processes: one call 6.99 ms, two 9.92 ms, so hoisting saves **2.93 ms** and 25 fs syscalls | 2.93 ms | per refresh |
| `runWildcarding` takes the policy lock even on the unchanged path; the CLI hook was deliberately changed not to | lock cycle 3.72 ms of 9.60 ms, plus contention with Auto Learn | per settings.json write |

Two notes worth keeping. The fixed-point cache **needs a decision, not just
work**: it adds a new cache file on the hook path. Use a pure-JS hash, not
`crypto` — `require('crypto')` alone is 3.5 ms and ate 40% of the win
(re-measured 2026-09-10 by a second party at 4.65 p50 / 3.40 min cold, so this
is conservative). Every failure mode is "miss -> full pass".

**CORRECTED 2026-09-10.** The sentence that used to end this paragraph — "a
forced-miss run measured 15.72 vs 18.28 ms, so there is no cold-path regression"
— is **wrong, with the sign backwards**, and those two numbers are not the same
quantity. Against a purpose-built no-cache variant, two independent runs agree
that the **miss path costs 2.4–3.9 ms MORE** than having no cache at all
(n=41: +3.90 p50 / +2.44 min; n=21: +4.81 / +2.54). In-process accounting
agrees: module load 1.97 + stamp 0.53 + hash 0.72 + failed key read 0.23 + key
write 1.07.

It is still clearly the right trade — saving 9.2 against a cost of 3.9 puts
break-even at a **30% hit rate** and the real rate is near 100% — but the claim
must be *restated*, not deleted. Every settings.json change now costs a few ms
more than it did before the cache existed.

And the opposite conclusion for the extension, recorded so nobody applies the
hook's lesson by analogy: its eager requires are **not** worth making lazy.
Activation is 31.4 ms of requires plus 53.5 ms of `activate()`, paid once per
window at `onStartupFinished`.

### The dashboard's remaining duplicate reads

Deferred with a reason, not forgotten. The file is read 3-4x per `_push`
(`extension.js` at the push itself, then `readSettings()` in `autoLearnCardData`,
in `frictionState`, and via `localCardData`'s `readUserSettings`) with the value
already in hand at the top. Hoisting it needs signature changes in three more
functions and would save ~0.3 ms — and `frictionState()` may legitimately want a
fresh read, so threading a stale one trades a sub-millisecond gain for a possible
correctness regression. Not worth it.

One of them was not in that class and is gone. The three-state pill added a
`readSettingsState()` beside the push's own `readSettings()`, so `_push` opened
and parsed the file **twice before the first card was built** — for two values
that come out of one call, since `readSettingsState()` returns the parsed object
beside the state. Deleting the duplicate needed no signature change anywhere and
carries no stale-read risk, because the two reads it collapses were taken
microseconds apart and could already disagree: Claude Code rewrites
settings.json on every approval, `/model` and `/effort`. Filed here so the
deferral above is not read as covering it. No timing figure is claimed for the
removal; it is a deletion, not an optimisation.

Likewise `CLAUDE.md` and `~/.codex/AGENTS.md` are read 2x each because
`guidanceCardData` and `gatesCardData` both walk `installedGuidanceTargets()`,
and `gates.generated.md` is read 3-5x because `gatesStatus` (`src/agent-gates.js`)
reads it twice in one expression when gates are installed.

**The hazard that makes these riskier than they look:** `compiledGateCount()`
calls `readCompiled()` with **no home argument** deliberately, per the
no-singleton discipline documented in `agent-gates.js` and `agent-guidance.js` —
paths are resolved at CALL time so a test with a mocked home reads the mocked
file. A hoisted compiled-text value must be home-bound or a mocked-home test
silently reads the real file and passes for the wrong reason.

### The fixed-point cache's known limits

Both accepted, both worth knowing before extending it.

**A code change that preserves BOTH mtime and size is invisible.** The version
segment stats `src/permissions.js` and `src/permission-match.js`. `git checkout`
sets a fresh mtime so the motivating case (bisecting the generalizer) is covered;
hashing the ~43 KB of source instead would close it for ~0.1 ms plus I/O.

**The key covers `processAllowList` and nothing else.** Verified that the allow
array plus the code in those two files is the complete input set —
`patterns/starter-pack.json` is read at exactly one place, inside `--seed`, and
no policy read feeds the pass. If the hit path is ever widened to skip anything
else (the local-settings drain, managed policy, the MAX markers), those inputs are
NOT in the key and a third stat is required. A hit currently skips only the
generalization pass; `finish()` is still reached on all five of `run()`'s tails,
so the drain gate is unaffected.

**If the extension ever adopts it**, the cache belongs in memory, not in the
shared file: the extension host is long-lived, and its copy of the generalizer is
the generated mirror `vscode-extension/src/`, not the root path the version
segment stats.

## Deferred by the maintainer

### The CLI ships inside the extension only — decided 2026-10-13

The npm name is reserved (`ai-acolyte@0.0.1`, a placeholder, 2026-09-25) and the backlog
held the packaging work behind one unmade decision: does `wildcard-perms` ship standalone? **No,
for now: the CLI ships only inside the extension and the repository checkout.** The root
manifest stays `private: true` (pinned by `test/installers.test.js`) and keeps the name
`permission-wildcarding`, no `bin`, no `files` list and no publish workflow. What a reversal
would need is recorded where it was worked out and stays true: `docs/acolyte-rename-migration.md`
"Phase 3, the CLI name" (an `acolyte` name with `wildcard-perms` kept as a forwarding shim,
because every installed hook records the old command string), the decision that a published
build disables the CLI drain entirely (strangers clone untrusted code), Trusted Publishing over
OIDC rather than a token (the account's 2FA is a security key, so CI has no OTP), and a separate
publish job on Node ≥ 22.14 because the test and release jobs pin Node 20 on purpose. Publishing
itself cannot run from an agent tool call (`EOTP`, no TTY for the browser approval).

### The README screenshots stay as they are until a re-capture — re-affirmed 2026-10-13

Unchanged from 2026-09-27: `img/01-wildcarding.png` shows a `v1.4.13` badge, every count dates
from 2026-09-16, and three images carry legible local paths. Re-capture is mechanically possible
now — `scripts/vscode-acceptance/renderer.js` already calls `Page.captureScreenshot`, and its
`inspectDashboardDocument` computes the element rectangles a per-card `clip` would need — but
it needs a showcase fixture (the acceptance fixtures are test states, e.g. an empty allow list),
a neutral `TEMP`/`TMP` (this box's temp path carries the username), and a capture after the
version bump. The privacy gate is text-only and will never check a PNG.

### The 13 blanket wrapper grants in the starter pack

`Bash(bash|sh|python|python3|node|npx|pwsh|powershell *)`, `PowerShell(& *)`,
`PowerShell(python|python3|powershell|node *)`. Each is an arbitrary-execution
grant, the learner refuses to propose these exact shapes, and the Codex exporter
rejects one of them as "too broad" while the Claude seed installs it. Left in
place on the maintainer's call 2026-09-03. Note that auto mode discards most of
this class at load, so they are inert there and live only in manual. That sentence
used to end "which is the mode MAX switches to"; MAX was retired on 2026-09-24 and
nothing switches the mode any more.

### An audit of a live allow list

Turning the same measurement on a real ~300-entry list to report which entries
are broader than the evidence supports. Offered and deferred.

### Codex's policy cache is checked for EXPIRY only, never for account identity

The cap Codex MAX obeys is read from `~/.codex/cloud-config-bundle-cache.json`, and that
object carries three fields beside the payload the parser reads: `cached_at`, `expires_at`
and `account_id`. Measured 2026-09-21, none of the three appeared anywhere in `src/`,
`bin/` or `vscode-extension/`; the cache on this box had a **one-hour TTL that lapsed
2026-09-03T17:20:47Z**, declared `allowed_approval_policies = ["on-request", "untrusted"]`,
and had kept the toggle disabled for eighteen days while Codex itself accepted
`approval_policy = "never"` on threads dated 2026-09-14 and later. The account the bundle
was signed for was also not the signed-in one.

**Expiry shipped 2026-09-22. Account identity will not.** Two of the three fields are read;
`account_id` is deliberately left alone, and this is a decision rather than an omission.
Learning which account is signed in means reading `~/.codex/auth.json`, which holds live
OAuth tokens and an API key, and no feature in this repo is worth teaching it to open that
file. Expiry alone already unblocks the case that was reported — a bundle from a previous
login is also, always, a bundle that has aged out.

Two shapes settled at the same time, both load-bearing for anything that touches this later:

- **The cap stands.** An expired bundle is not silently promoted to "no restriction": a
  machine offline past the TTL would then drop a control that is genuinely in force. What
  changed is that the refusal stopped being final — `blockedBy: 'enterprise-policy-stale'`
  carries the dates, the dashboard button stays clickable behind a modal naming them, and
  the CLI needs `--override-stale-policy`.
- **Absence of an expiry is not expiry.** Every bundle fixture in the suite omits the field,
  and a truncated cache would read as expired under the opposite rule — the same
  fail-open the `allowedApprovalPolicies` comment warns about, arriving through another
  door. Only an `expires_at` that parses and sits strictly in the past counts.

Not re-derivable from the code: whether the cache path is still the one Codex writes. It
was re-confirmed against the shipping Codex binary on 2026-09-22, which is what made the
expiry work worth doing at all.


---

### Fixed in this pass

- **`writeTransform` could destroy the whole settings.json and report success.**
  `absent -> {}` was treated as the legitimate first run on *every* attempt,
  including retries. Reproduced end to end: `--max on` with one external delete
  inside the transform replaced 432 allow entries plus `model`, `effortLevel` and
  `agentPushNotifEnabled` with 7 blanket entries, recorded an **empty** allow
  snapshot, and exited 0. Now refuses on the read, ahead of a second transform
  call, so `applyMax` never snapshots `{}`.
- **`deniesLost` gated on `Array.isArray`,** so `deny: "Bash(rm -rf *)"` was
  written away with `wrote: true`. Now compared by value for non-array shapes.
- **`deactivate()` nulled its retainers after the awaited drain,** so a same-realm
  re-activate had its `dashboard` and `memoryLint` nulled by the old teardown's
  continuation — 0 pushes reached the successor's live webview and all ~35
  `dashboard?.refresh()` call sites were permanent no-ops.
- **Three post-teardown writers** (`ensureGuidance`, `scheduleAutoLearn`,
  `resetAutoLearnTimer`) now carry the `deactivated` guard.
- **Test isolation:** `delete require.cache[extensionPath]` left every `src/`
  module holding the first harness's `os` stub, so later tests resolved
  `home = os.homedir()` defaults to an earlier test's deleted temp home. Suite-wide
  temp-dir leak 3/run -> 0.
- **`SETTINGS_CONTENDED_CODE` now has a production consumer** — the vanish
  refusal above. The earlier entry calling it unconsumed is resolved.

### Refuted optimizations — do not retry

Each was built and measured, not reasoned about:

- **`NODE_COMPILE_CACHE`**: 1.88 p50 / 2.73 min **worse** on a hit, 2.86 / 2.06
  worse on a miss.
- **Doing the fs work before installing the stdin listeners**, so the 5.68 ms
  pipe wait overlaps our sync work: **1.27 p50 worse**. The stdin wait is not
  overlappable.
- **Inlining the cache module** to remove a whole module load: −0.14 p50 /
  −0.02 min. Zero.
- **`utf8` instead of a Buffer read** for settings.json: −0.56 / −0.41 ms, below
  the noise floor.

And the governing measurement fact: **the end-to-end noise floor for a ~60 ms
spawn on this machine is roughly ±2 ms in min and ±5 ms in p50**, so any
in-process saving under ~2 ms is unmeasurable at the process level. Three
candidates whose in-process cost measured 1–2 ms each came out at exactly zero
end-to-end. In-process stage timings do **not** add up to end-to-end deltas.

### The scope probe is a safety mechanism, not dead weight

Recorded because it reads as removable and is not. Stages 1–3 of
`processAllowList` are 54% of the pass and `coveredByScope` returns 0 on the
live list — but dropping the probe diverges on 1 of 83 differential cases, and
the divergence is a permission **widening**: on
`['Bash(rm -rf /*)', 'Bash(rm -rf /home)', 'Bash(rm -rf /home/x)']` the shipped
pass yields `['Bash(rm -rf /*)']` and the probe-free version yields
**`['Bash(rm *)']`**, because `Bash(rm -rf /home)` generalizes to `Bash(rm *)`
and only the probe keeps it specific long enough for prune to drop it.

It reads as dead weight on the live list *precisely because* that list is
already a fixed point, which is the only state in which it must fire zero times.

### Claims from today's commits that do not hold

- **`f041031`'s `preMax`/`wroteOnto` change is behaviour-neutral and completely
  untested.** Its message calls it a correctness fix — "both halves now come from
  ONE read" — but the old code was `applyMax(settings, turningOn)`, whose
  `res.settings` was computed **in memory from `settings`**. There was one read
  then and one now. Two mutants on the former `wroteOntoAllow` variable in the
  pre-removal extension implementation — it was named `preMax` when this was
  written — the post-MAX list, and `[]`, both
  **SURVIVED** the full 400-test suite. The four purge assertions in
  `test/policy-backup.test.js` guard the filter and the `MAX_ALLOW_CORE`
  constant; the only thing that varies with the argument is `detectMcpServers`,
  and at the time no test asserted an `mcp__*` blanket entry leaves the backup.
  One does now: "legacy cleanup preserves MCP blankets for servers introduced
  after MAX" at `test/policy-backup.test.js:653#blankets`, added in answer to this entry
  and since renamed from "MAX off purges a blanket that arrived WHILE MAX was
  on". Control:
  restoring the top-level `require('../src/permissions')` **is** caught, so that
  guard is real and this one is not.
- **`if (!res.changed)` in `toggleMax` is unreachable,** and the commit has it
  backwards: deriving `turningOn = !isMaxOn(latest)` from the same `latest` is
  exactly what makes it un-reachable. 65 shapes of `latest` enumerated (5 allow
  sets x 3 hook states x 4 modes, plus `{}`, `null`, non-array allow, bare
  `hooks`): **0 yielded `changed: false`**. The same function's wording also read
  backwards: "MAX is already ${turningOn ? 'OFF' : 'ON'}" answered a click asking
  for ON with "already OFF". Both are historical: the whole `toggleMax`
  implementation was DELETED on 2026-09-24, so there is no line to cite and Git
  holds the code this paragraph describes.
- **The version badge's degradation claim is false for the case it names.** For a
  **malformed** manifest the catch never runs: Node refuses to load
  `extension.js` at all (`ERR_INVALID_PACKAGE_CONFIG` at
  `getNearestParentPackageJSON`), so there is no dashboard to degrade. The guard
  does work for a manifest that is absent or valid-but-versionless.
- **`compiledGateCount`'s bullet fallback is unreachable** on any corpus
  `recall.py` can emit (0 of 8 gate sections has more than one top-level bullet).
  Kept as defensive, but it is not a tested path.

### Structural notes carried forward

- **The `writeTransform` shape and deny guards judge the transform's OUTPUT,** so
  unlike the `SETTINGS_UNREADABLE` refusal they cannot run before it. By the time
  either throws, `applyMax`'s snapshot and approve script have landed. Tolerable
  only because both transforms are idempotent overwrites, so the leftovers are
  inert. **A future transform whose side effects are not idempotent must not use
  this writer** — now stated in the code as well.
- **The fixed-point code stamp covers `permissions.js` and `permission-match.js`
  but not `settings?.permissions?.allow` at `bin/wildcard-perms:496#allow`,** where the
  allow array the pass runs on is extracted. Changing *which* field feeds the
  pass would not invalidate existing keys.
- **12 module-level frozen-home constants**, not the 8 recorded earlier: 6 in
  `extension.js` (`SETTINGS`, `BACKUP_DIR`, `MIRROR_BACKUP_DEFAULT`,
  `PROJECTS_DIR`, `CODEX_SESSIONS_DIR`, `RECALL_MODEL_HOME`) and 6 in `src/`
  (`codex-max.js` x3, `permissions.js` x3 — `BYPASS_STATE_FILE`,
  `MAX_STATE_FILE`, `APPROVE_DIR` — plus `policy-lock.js`'s `POLICY_LOCK_PATH`).
  The `require.cache` purge is now consistent across the four extension-harness
  test files, which is what made the frozen homes harmless; the constants remain
  a trap for the next harness.
- **~6650 leftover temp directories** had accumulated in `%TEMP%` on the dev
  machine from the leak fixed above. The leak is closed; clearing the historical
  residue is a one-time manual step, deliberately not automated.

### The CLI drain has no trust gate, and that is now an accepted risk (2026-09-24)

The extension refuses to drain an untrusted workspace: `drainableRoots()` returns `[]`
unless `vscode.workspace.isTrusted`. The CLI hook has no equivalent and no analogue
available to it. It takes `cwd` from the PostToolUse payload on stdin, tests that project
for `.claude/settings.local.json`, and drains it into USER scope on a path that is quiet
by design.

The gate that runs is `PROMOTABLE`, and it tests PORTABILITY, never provenance. So a
cloned repository that commits a `.claude/settings.local.json` containing a clean command
family clears it and that family lands in the user's global allow list. Nothing in the
flow shows a prompt, and the only trace is one stderr line on a hook that prints nothing
in the normal case.

**Decision 2026-09-24: keep the behaviour, record the risk.** The two alternatives were an
explicit trusted-roots allowlist, which puts a first-run step in front of every new
project for a threat the owner does not face on a single-user box, and removing CLI drain
entirely, which would stop promoting approvals for every folder VS Code never opens. The
exposure is bounded by what `PROMOTABLE` already refuses: script blobs, absolute-path
executables, MCP tools and file/web families all stay local, so the reachable damage is a
command-family grant the user would very likely have approved anyway.

Revisit if this repository is ever used on a machine that clones untrusted code, which is
the condition that changes the answer. Do not re-file it as a defect without that change.

### The two stat-keyed caches can still return a stale verdict

`policyFingerprint` and `autoLearnStateStamp` both key on `${stat.mtimeMs}:${stat.size}`,
so a same-size in-place rewrite inside timestamp granularity is invisible to both.
Accepted when written and re-affirmed 2026-09-24. The alternative is a content hash, and
the record already declines that trade for the fixed-point cache on the opposite grounds:
replacing a content hash with `mtime:size` weakens the one property that module exists
for. These two are not in that position. Both recompute on the next real change.

### The transcript corpus is mirrored to D: on a schedule, not junctioned (2026-09-24)

`~/.claude/projects` holds every session transcript and the memory store, measured at
**1.0 GB across 1,596 files on 2026-09-24**, up from 732.7 MB on 2026-09-14. It is a plain
directory, Claude Code's path for it is not configurable, and the 2026-09-10 profile wipe
took the lot once already. Nothing in this repository protects it and nothing in it can.

The originally proposed fix, junctioning the directory to a git repo on `D:`, was refused:
C: is the only SSD on this box, so a junction would move every transcript append onto a
spinning disk and trade a durability problem for a latency one on the hot path of every
session. That trade was never stated when the fix was proposed.

**Decision 2026-09-24: a scheduled mirror.** ROBOCOPY `/MIR` every six hours to
`D:\.backups\claude-corpus`, driven by a Scheduled Task. Writes stay on the SSD, loss is
bounded to one interval instead of everything, and deletions propagate so the mirror does
not become a second unbounded corpus. First run: 1,608 files, 1.05 GB.

The script lives outside every checkout on this box, deliberately. **The corpus is private
and must never enter this public repository under any option.** Two things it got wrong
first and now guards against: `[TimeSpan]::MaxValue` is the obvious spelling for an
indefinite repetition and the Task Scheduler rejects it as out of range, and the first
version logged "registered" after a `Register-ScheduledTask` that had just failed, because
the error was non-terminating and the log line could not fail. It reads the task back now.


---

## HARNESS HAZARD: when a mutation run reports that nothing died

Recorded 2026-09-22 after six false results in one session, across two
independent harnesses written by two different authors. Every time, the
harness was broken and the tests were fine.

**The symptom is the tell, and it is the only reason any of these were
caught.** A clean sweep of SURVIVED is not a result. Mutants die at a high
rate in this repo because assertions are written to name the mutation that
must break them, so when nothing dies, suspect the harness first.

**Output decoding, twice.** A Python harness ran `node --test`, captured with
`text=True`, and anchored `^. tests (d+)$` with `re.M`. Windows supplied CRLF,
so `$` never matched; and the console codepage decoded node's summary glyph as
three characters, so the single-character wildcard never matched either. The
harness read "I could not find a test count" as "no assertion fired" and
reported six survivors for six clean suites. Decode explicitly, normalise
CRLF, and never anchor on a glyph you did not choose.

**Exit codes through a pipe.** Checking a PowerShell harness with
`... | tail -3; echo $?` reports the exit status of `tail`, which is always 0.
A mutated run that had correctly exited 1 looked like a pass. Capture the exit
code of the process under test, not of the last stage of the pipeline.

**`pathlib.write_text` rewrites line endings.** On Windows it translates `\n`
to `os.linesep`, so a harness that read a file, patched it and wrote it back
converted `memory/recall.py` from LF to CRLF -- a file `.gitattributes`
declares `text eol=lf`. The harness's own "restored byte-identical" assertion
compared DECODED text, where universal newlines hide the difference, so it
passed. Only `git status` noticed. Use `write_bytes`, and if you assert a
restore, assert it on bytes.

**`String.prototype.replace` interprets the replacement.** A `$` followed by a
backtick in a REPLACEMENT string means "insert everything before the match".
A JS patch harness whose replacement text contained that pair spliced the head
of the file into a regex literal; the file stopped parsing and the harness
reported 121 assertion failures while measuring nothing. Use split/join for
literal replacement, and run `node --check` on every file a harness patches
before trusting a single number from the run.

**The rule that catches all of them.** Assert that the run HAPPENED before
reading its verdict: a nonzero test count, a witness assertion label in the
output, or a control mutation that must die. A harness that cannot distinguish
"the suite ran and nothing fired" from "the suite never ran" is not reporting
a result.

## MEASUREMENT HAZARD (mechanism CORRECTED below — read to the end)

**Read this before benchmarking anything in this project, and before trusting any
fs figure recorded in this file.**

Byte-identical files, same count, same volume, both arms interleaved in one
process with a rotating order, warm, n=31:

| location | 17-file read | per file | 17-file stat | per file |
|---|---|---|---|---|
| `~/.claude/projects/.../memory` | **1.46 ms** p50 | 0.086 ms | 0.90 ms | 0.053 ms |
| a `%TEMP%` copy of the same bytes | **8.54 ms** p50 | 0.502 ms | 0.83 ms | 0.049 ms |

**Reads: 5.9x. Stats: unaffected.** So the ratio between "read every file" and
"stat every file" is **1.6x in the real location and 10.3x in a temp dir** — which
inverts the conclusion of any stat-stamp-versus-read optimization.

I ruled out the obvious alternative explanation. A **fixed-path** `%TEMP%` corpus
measured twice — once with the files freshly created, once with them established
from the previous run — gave **7.69 ms and 7.72 ms**. Identical. It is not
first-touch cost and not a Defender scan-on-create; it is the location,
persistently. (Defender exclusions could not be read to confirm the mechanism —
`Get-MpPreference` requires elevation — and the mechanism does not change the
measurement.)

**Why this mattered.** The 2026-09-10 optimization audit measured the extension
"against a temp `HOME` mirroring the live corpus", so every fs figure it produced
for the extension is inflated ~6x on its read component. That is the single cause
of three refuted rows in the table above. The audit even observed the anomaly —
"only `~/.claude/settings.json`, which every process on this box hammers, gets
down to 0.159 ms" — and attributed it to that file being *frequently accessed*
rather than to *where it lives*.

### MECHANISM CORRECTED — it is the file EXTENSION, plus a path exclusion

The "6x in `%TEMP%`" framing above reproduces reliably and is still the wrong
explanation. Cross-testing content x location x size x **extension** — 19 files
of 2,700 identical bytes in ONE directory, warm, n=41, ms per file:

```
.js 0.095   .cjs 0.093   |   .md 0.505  .json 0.514  .txt 0.512
                             .mjs 0.517  .ts 0.508   .ps1 0.509  (no ext) 0.513
```

The dominant variable is the **extension**, not the directory. A separate path
effect sits on top: byte-identical `.md` reads at **0.084 ms** inside
`~/.claude` versus **0.491-0.532 ms** in `%TEMP%`, `C:\Users\<user>` and
another volume. `statSync` is barely affected either way. That is the signature
of Defender exclusions — by extension for `.js`/`.cjs`, by path for `~/.claude`.
Unconfirmed: `Get-MpPreference` needs elevation, so this is inferred from
behaviour.

**The corrected rule, which is narrower than my first version:**

- **`require()` of a `.js` module is location-independent.** Cold module-load
  and require-chain figures measured in a sandbox are **valid**. The blanket
  "sandbox fs numbers are wrong" was too broad and would have discarded good
  measurements — including the 212-byte-floor result above, which used `.js`
  files outside the repo and therefore still stands.
- **`.json` and `.md` reads are 4-6x inflated outside the excluded path.** The
  dashboard's own 87-call fs plan measures **4.87 min / 5.61 p50 ms** against
  the real `~/.claude` and **18.99 / 20.82** against a byte-identical sandbox
  mirror: 15.3 ms p50 of pure artifact. So the three refuted rows above are
  still correctly refuted; only the reason changes.
- So "read every file" versus "stat every file" is **1.6x where the data lives
  and 10.3x in a sandbox**, which inverts the conclusion of any
  stat-stamp-versus-read optimization.
- CPU-bound measurements (`processAllowList`, `coverLookupKeys`) are unaffected
  by either effect and are the most trustworthy figures in this file.

Worth confirming elevated, because it changes where every future fs measurement
in this project should be sited.

## Whole-object settings.json writers: FIVE sites, not one

The earlier entry called the apply path — built at `const updated = {`, written by
`atomicWrite(change.path, change.content)`, `src/auto-learn-manager.js:2363-2420#updated` —
"a third unrebased whole-object writer". Right, but incomplete, and the migration
is harder than it looked.

Sanctioned writers: `function writeAllow` at `src/settings-write.js:152#writeAllow` (rebasing
merge, written at `src/settings-write.js:217#writeFileAtomicSync`) and `function writeTransform`
at `src/settings-write.js:263#writeTransform` (CAS + verbatim, written at
`src/settings-write.js:371#writeFileAtomicSync`).

Unrebased whole-object writers still outstanding:

| Site | Nature |
|---|---|
| `const updated = {` at `src/auto-learn-manager.js:2374-2377#updated`, written `src/auto-learn-manager.js:2431#change.content` | The apply path. Has an `unchanged()` recheck at `src/auto-learn-manager.js:2428-2430#unchanged`, so it is **check-then-act, not CAS** — a write landing between the check and the `renameSync` inside `atomicWrite` is undetected. When it *is* detected it **throws**, so a routine Claude Code `/model` write turns a legitimate apply into a user-visible error plus rollback churn. |
| `{ ...permissions, allow: next }` at `src/auto-learn-manager.js:2975#next`, written `src/auto-learn-manager.js:3056#item.content` | **A fourth site, previously unrecorded.** `releaseClaudeGrants`, for `undo()`. Same shape, and **weaker** — no `unchanged()` recheck before the write at all. |
| `change.before.content` at `src/auto-learn-manager.js:2111#change.before.content` | `rollback()` restores it — a full-file write of stale bytes, guarded only by an `afterHash` check at `src/auto-learn-manager.js:2107#change.afterHash`. |
| `atomicWrite(item.target.path, item.current.content)` at `src/auto-learn-manager.js:3075#item.current.content` | `undo()`'s inner rollback, same shape, `src/auto-learn-manager.js:3071#item.restored.hash` hash guard. |
| `{ ...local, permissions }` at `src/local-settings.js:287#local` | Different file (`.claude/settings.local.json`) but the same class — and **the widest read-to-write window in the repo**: `src/local-settings.js:225#readFileSync` read → `src/local-settings.js:287#writeFileAtomicSync` write, spanning two `readUserSettings()` calls AND a full `writeAllow` to user settings. Claude Code writes this file too; it is where project-scoped "always approve" lands. `createSettingsWriter({ settingsPath: <local> })` would work here. |

**Why the migration is blocked, and it is not a small thing.** `applyUnlocked`
needs a **two-file atomic window**: `updateClaudeClaims` mutates `claims` in
place, and both `nextManagedClaude` (persisted into `state.managedClaude`) and
the claims *file* content are derived from that same read. Neither existing
writer supports two files. `writeTransform`'s retry loop would re-run only the
settings.json transform and leave attempt N-1's claims content — **a silently
corrupt claims registry, which is worse than today's throw.**

Three further blockers for whoever attempts it:
- Neither writer takes a backup, and `undo()` depends on `beforeHash` and
  `existed`. `change.afterHash` must be recorded from what the writer *actually
  wrote*, not from `change.content`, or `undo()`'s `untouched` test misclassifies.
- `rollback()` at `src/auto-learn-manager.js:2111#change.before.content` blindly restores `change.before.content`. If the writer
  rebased onto fresher bytes, rollback reverts the concurrent change — the exact
  bug, at the failure site.
- The new vanish guard in `writeTransform` would make `rollback()` **re-create a
  settings.json an external actor deliberately deleted.** That is a new defect
  the migration would introduce, and no existing test would catch it.

**Prerequisite, since met:** `grep "Policy changed" test/` returned nothing, so
the entire "detect and throw" behaviour that justifies this writer's safety was
unpinned, and swapping it for a retrying writer would have passed the full suite
silently. The "Policy changed" guard is pinned now: `test/auto-learn-manager.test.js:595-614#Policy`
records why, and the two tests are at `test/auto-learn-manager.test.js:616#survive` and
`test/auto-learn-manager.test.js:696#targets`.

## `runWildcarding`'s lock: the constraint that decides any refactor

Recorded because it is easy to get wrong and the failure is a data loss, not a
slowdown. `writeAllow` replays a **delta computed against the caller's
snapshot**, and its own note at `src/settings-write.js:173-179#NOTE` names this
caller: *"WRONG for one whose whole output is a function of the list it read …
Such a caller must re-read and recompute first."*

Today `runWildcarding` satisfies that **by accident of structure** — its
`readSettings()` happens to sit inside the lock, so the snapshot is nearly
`latest`. **Moving the read out of the lock without an authoritative in-lock
re-read and recompute reintroduces the MAX / `Bash(npm test)` deletion bug**
that the note above `wildcardUnderLock` (`bin/wildcard-perms:585-590#DISCARDED`) guards
against. Its worked `Bash(npm test)` example left that note with MAX in `d947565`, so Git
holds the full text.

Two further traps for that refactor, both real:
- **Key on file BYTES, not the parsed allow list.** The unchanged path is where
  "a deny rule added by hand first reaches the backup" (`vscode-extension/extension.js:3786-3788#rides`);
  a key on the allow list makes a deny-only edit a hit, and that rule never gets
  backed up. Two byte sequences can also parse equal.
- **Keep `backupPolicy` on the unchanged path.** It is the only thing that
  rebuilds a *deleted* backup — not hypothetical: on 2026-09-09 every directory
  under `~/.claude` was recreated and this path is what restored the mirror. It
  self-short-circuits when the union is unchanged, so it costs a read, not a
  write. Skipping it would also make five `test/policy-backup.test.js` tests go
  **vacuous rather than fail**, which is the "one early return away from becoming
  vacuous" hazard already recorded for that file.
- `lockedRetries` is reset only on the lock-completed path, so an early return
  that never reaches the lock strands the retry budget.

An in-memory memo (skip the pass entirely, not just the lock) carries five
further hazards and is deliberately NOT being done: a deleted backup never
rebuilt, deny-only edits lost, poisoning the memo on a busy-lock-deferred pass
(the one way to genuinely *miss* a generalization — only ever record a
"no work due" verdict from the same read, never after a write, a busy lock, or a
`SETTINGS_UNREADABLE`), the `lockedRetries` reset, and array aliasing
(`processAllowList` returns its input array for an empty/non-array input).

Also worth folding in eventually: activation takes **two** lock acquisitions
back to back — `runWildcarding()` then `drainLocal()` — which is the shape
`bin/wildcard-perms:517-530#ONE` ("ONE lock acquisition covering both jobs") was
deliberately fixed away from for the hook.

## `preMax` is misnamed, and the audit's read of it was wrong too

The removed purge argument was
`const wroteOntoAllow = wroteOnto?.permissions?.allow ?? []`, named `preMax`
when this record was written.
Two corrections:

- **It cannot be reverted.** `f041031` deleted the `readSettings()` call
  entirely, so there is no in-scope expression to revert to. The mutation that
  would actually test the change — `preMax = <the earlier read's allow>` —
  **cannot be written against the current code.** The audit's two surviving
  mutants therefore do not test the change; they test whether `detectMcpServers`
  matters.
- **The name and its comment are both wrong.** When turning MAX *off*,
  `wroteOnto?.permissions?.allow` is the **MAX-ON on-disk list**, not the pre-MAX
  list — the pre-MAX list lives only in the sidecar snapshot and is re-unioned by
  `disableMaxAllow`. The comment repeated the error too. Both have since been
  fixed in place before the feature was retired: the variable became
  `wroteOntoAllow`, and its comment stated the correction rather than the error.

Why both mutants survive, verified by running the real functions on both existing
fixtures (byte-identical purge sets for all three variants):
`buildMaxAllowSet`'s first seven elements are the `MAX_ALLOW_CORE` **constant**,
so only the `mcp__*` tail varies — and `detectMcpServers` matches the *prefix*
`mcp__S__`, so any specific `mcp__S__tool` surviving into the restored list still
yields server `S`. The only discriminating input is an `mcp__<S>__*` blanket that
lands **while MAX is on**, for a server with no other `mcp__S__`-prefixed entry.

### The per-project memory split is deferred, and the reason is not technical

`RECALL_MEMORY_DIRS` now makes a split *possible*: search spans corpora while `--lint` and
`--gates-compile` stay on the primary. What is not done is physically relocating memories
into per-project directories.

It only pays off if sessions are launched inside each project, which is not current
practice. Doing it would mean writing `.claude/settings.json` into 13 other repos, several
public, while a concurrent session was demonstrably active in at least one of them (two
agent worktrees appeared during this work). And it buys little that the index diet did
not already buy: deleting the slug vocabulary took `MEMORY.md` from 163 lines to 84, which
was the whole point.

Revisit only if launching per-project becomes the habit. Until then this is speculative
restructuring of a live memory store.

### The retrieval gate cannot run in CI, and its question set cannot be published

`memory/bench/gate_recall.py` is committed; `memory/bench/queries.json` is gitignored,
because it maps a private corpus (the same reason `bench_embed.py`'s query set is). So the
gate is reproducible only on a machine with both the corpus and the model.

`test/recall-py.sh` covers the *mechanics* against synthetic fixtures and is the thing that
would catch a regression. The quality numbers are a local measurement, not a CI gate, and the
commit message is where they live. Naming this so a later reader does not mistake the absence
of a CI job for an oversight.

### min-max versus RRF is unresolved, and 24 queries cannot resolve it

Measured on the 24-question set: min-max MRR 0.830, RRF 0.832, identical R@1 (0.79), R@3
(0.83) and median (1.0). RRF was marginally better on worst rank (39 vs 48).

Min-max ships as the default on a structural argument rather than a measured one: RRF fuses
ranks, so a document *no* query term touches scores as merely "last" rather than abstaining,
and its floor sits only 3x below its ceiling. Min-max lets the lexical leg contribute exactly
0.0 when it separates nothing, degrading to pure cosine. `mode="rrf"` is reachable from
`rank()` with no CLI flag so the question stays open.

`FUSE_W` swept 0.3-0.8: R@1 flat at 0.79 across 0.4-0.7, MRR flat, only worst-case monotonic
(22 at w=0.3, 48 at 0.5, 76 at 0.7). Left at 0.5 deliberately. **Do not tune it on this query
set**, `memory/bench/README.md` already says R@1 swings of one or two queries are noise at
twice this sample size.

### A gate that the unchanged code also passes is not a gate

Worth recording as a method note, because it nearly shipped. The plan specified the retrieval
gate as "median rank <= 2". Every mode scores a median of 1.0 on this corpus, vector-only
included, so that criterion would have passed against completely unchanged code. R@1 is what
moves (0.58 → 0.79) and is what the resident slug vocabulary was actually buying.

`gate_recall.py` now gates on R@1 with an MRR-lift proof, and `--fuse-w 1.0` is the built-in
mutation: it disables the lexical leg, collapses hybrid onto vector exactly, and must exit 1.

### `EMBED_CHAR_CAP` is decorative and the real cap is four times smaller

`EMBED_CHAR_CAP = 8000` looks like the limit on what gets embedded. It is not: `_encode`
truncates to 256 tokens, which on this corpus means a median of ~832 characters, 26% of the
already-capped text, worst case 9%.

bge-small's real context window is 512, so doubling the token cap is one line and doubles the
visible prefix of every file. It is not free: it needs an `EMBED_ID` bump and a full re-embed,
and `EMBED_ID` is pinned in `recall.py`, `src/recall-index.js` and asserted equal in
`test/recall-index.test.js`, so three files move together. Unmeasured in isolation:
`bench_report.md`'s "bge-small +qprefix" row conflates the window with the query prefix, so
that row is not evidence either way. Complement to BM25, not a substitute: an 8,000-char file
would still be ~75% invisible.

### This repo now ships two products under one name

`memory/` plus `src/agent-gates.js`, `src/recall-index.js`, `vscode-extension/memoryLint.js`
and the Memory card are a memory-management tool. The permission-wildcarding half is a
different tool. They share the VS Code extension for a real reason, under a managed policy
that defines only `PostToolUse`, the extension is the only durable automation surface, which
is what `## Design principle: watch the cause, don't hook the event` is about.

The cost is discoverability: nobody searching for an agent-memory tool finds
"permission-wildcarding", and the README (68 KB) and this file (54 KB) both carry two
products' worth of material. Not proposing a split, the coupling is genuine and two release
trains sharing a 34 MB model asset would be worse. Recording it so the naming question is
asked deliberately rather than discovered.

---

### Repo state and product state diverge until a release is cut

`vscode-extension/memory/recall.py` is a gitignored build artifact regenerated by
`scripts/package.mjs`, and `recallScriptPath()` prefers that bundled copy over the checkout. So
after any merge touching `memory/recall.py`, the installed extension keeps running the previous
version until `npm run package` and a reinstall. For c369e58 that meant the extension's own
`autoSyncRecallIfStale` loop kept hitting the unconverging deletion bug the merge had just
fixed, for as long as the VSIX was stale.

Not a contract break, and the interface is identical across versions. Worth stating as a release
rule: a merge that changes `memory/recall.py` is not in the product until the VSIX is rebuilt.

### The version bump is half of that release rule

Rebuilding is not enough on its own. `4471fe5` set the manifest pair to 1.4.4 and a VSIX was built
from it. Commits `8ce8c3a` and `312f86c` then changed `extension.js` and `memory/recall.py` on top
of that without touching the version, so a freshly built `permission-wildcarding-1.4.4.vsix` and
the earlier 1.4.4 named two different builds. VS Code keys upgrades on the version string, so
installing an equal version over an existing one is a silent no-op, which presents to a user as
"in-place upgrades do not work". Bumped to 1.4.5 on 2026-09-14.

Bump `vscode-extension/package.json` and the root `package.json` together.
`test/installers.test.js:511#manifests` — "the two package manifests report the same version" —
asserts they agree, and the extension manifest is authoritative because `release.yml`
defaults its version input to it.

## `file:line` rot: measured rates, and what a STALE verdict is worth

From the correction pass of 2026-09-14, which took the tree from OK 39 / STALE 60 /
UNVERIFIABLE 47 to OK 107 / STALE 23 / UNVERIFIABLE 17 across 162 references. Read this
before running another pass, and before trusting a raw count from
`node scripts/check-line-refs.js`.

**A STALE verdict is a candidate, not a proof, and the real rate was measured twice.**
A 16-reference hand sample put the share of STALE verdicts that are genuinely wrong at
about 80%. A full pass over all 73 non-OK rows in `BACKLOG.md` measured it at **34
changed against 39 left alone**, and **27 of 42 STALE**. So roughly two STALE in three
are real and one in three is a correct reference the checker misjudged, and most
UNVERIFIABLE rows were simply fine. **The 80% figure is retracted**; it came from too
small a sample. Never bulk-apply the checker's `suggest` field: in the cases examined it
named a neighbouring symbol often enough to be wrong on its own.

**Neither cheap automated bound decides anything.** Zero of the 115 non-OK references
pointed past the end of their target file, so "past EOF" clears all of them. And "the
cited line exists" is satisfied by a reference that is 1,425 lines off inside the right
file, which was the one confirmed transcription error of the pass. Only reading both
ends settles it.

**The rot is churn-driven, so it recurs.** 71% of the unresolved references pointed into
files that this single effort touched, and 99% into files touched in the last 120
commits. A concrete measure of the speed: a citation of `counts = Counter(terms)` in
`memory/recall.py` was verified by hand at line 470 and was wrong about an hour later,
in the same session, because merging a branch added 14 lines above it and moved that
statement to 484. A correction pass is therefore maintenance, not a fix. (Written
without the `file:line` form on purpose, so an example of a WRONG reference does not
enter the checker's own count as a real one.)

**Writing the anchor next to the citation is what makes a reference survivable.** Prose
that quotes the identifier actually sitting at the cited line can be checked by machine
forever; prose that only describes the code can never be checked by anything and rots
silently. Quoting the symbol converted 13 rows straight to OK in `BACKLOG.md` alone and
took `docs/engineering-record.md` from 2 verifiable citations to 19.

**Anchor placement before or after the citation is NOT a rule** — that belief was a
workaround for a defect, now fixed. `judge()` stripped a reference from the prose but
left the backticks around it, so a backticked reference collapsed to an orphan pair that
paired with the next real anchor's opening backtick and shifted every code span after
it. Two agents hit it independently on different files and both concluded the anchor had
to come first. It does not. See the note on `REF_STRIP_RE` in
`scripts/check-line-refs.js`, and the regression test
`an anchor written AFTER a backticked reference is still extracted`.

**Some references cannot be fixed and should not be chased.** Code that was deleted
rather than moved has no line to point at. A citation whose whole purpose is to record
where a retracted figure was wrongly said to live must stay wrong to make its point.
Both are in the tree on purpose.

**Declared anchors, added 2026-10-13: a citation can now be checked exactly.** Write
`file:line#identifier` or `file:start-end#identifier`. The anchor is one identifier,
optionally dotted (`fooBar`, `$scope`, `fs.realpathSync`), with trailing `.` or `:` read
as sentence punctuation. The reference is OK when the anchor occurs on the cited line, or
on any line of a cited range, as a whole token: not preceded or followed by `[\w$]`, the
boundary class the heuristic already uses for identifiers. So `scan` does not match
`scanTrouble` or `_scan`, does match `this.scan(`, and a dotted anchor is literal, a
prefix of a member chain. Citations are masked out before the search, so a citation is
never counted as an occurrence of its own anchor. Anything else is BROKEN, with every
line the anchor occurs on now. That includes a malformed anchor (`#foo-bar` is captured
whole and reported, not parsed as `foo`) and an ambiguous basename, which the bounds
check skips for an un-anchored reference: an anchor promises an exact check, and one
that cannot name its file cannot keep that promise. An anchored reference never reaches
the heuristic: no prose is read and no `suggest` is produced. **Because it reads no prose
it cannot cry wolf, so unlike STALE it is asserted**: `checkBounds`, and with it
`test/line-refs.test.js`, fails on a BROKEN anchored reference. A count floor,
`ANCHORED_FLOOR`, stops an edit quietly dropping one. The 159 un-anchored references the
tree held came out with identical verdicts, details and `suggest` lists, row for row.

**`node scripts/check-line-refs.js --fix-anchored` repoints a moved anchor, and this does
not contradict "never bulk-apply `suggest`".** That rule stands because `suggest` comes
from an anchor RECOVERED out of prose, which is wrong about one time in three. The fixer
acts only on an anchor the author DECLARED, and only when it occurs on exactly one line
of the target as a whole token. That leaves one possible answer and nothing to rank; the
judgement was the author's, made when they chose the anchor. It rewrites the cited line
number to that line and touches nothing else. Zero occurrences (renamed or deleted), two
or more, descending ranges, unresolvable targets and malformed anchors are reported and
left alone, and the run exits 1 while any anchored reference stays BROKEN. A range keeps
its length and is RE-HEADED on the anchor, so the fix is exact when the anchor names the
range's first line. Anchor ranges that way: the signature, the heading, the opening
statement. A mid-range anchor still lands inside the fixed range, but its old offset was
never recorded, and the FIXED line says "re-headed" so it gets looked at. A shift that
would run past the end of the file is refused rather than clipped. Each edit splices one
run of digits at a computed offset, verified against the parsed digits before anything
is written, so CRLF files stay CRLF. A second run writes nothing.

Two limits to know before migrating. A **bare continuation** such as `(:489)` after a
citation is not extracted at all, because `REF_RE` needs a file token, so it can be
anchored only by spelling the file out. And **an anchor is only as relocatable as it is
rare**: the first one in the tree, in `memory/recall.py`, anchors `slice` on the
gate-compile stderr slice in `vscode-extension/extension.js`, where that token is on 7
lines. It checks exactly, but if it moves, the fixer lists the 7 lines and leaves it to a
person. Same day, `.py`, `.yml` and `.yaml` comments started being scanned. That added
exactly one reference, and it was this one: it had cited a line 327 away from the slice
it described, and nothing could see it.

## Optimizations measured and DECLINED — do not re-derive these

Moved out of `BACKLOG.md` on 2026-09-14. Each was built or profiled, not guessed, and
each was rejected on the number rather than on taste. They were sitting in the queue
under headings like "none urgent", which is how a decision gets re-litigated: a reader
sees an unticked box, not a conclusion.

The measurement bar these were held to: cold, in fresh interleaved processes, against a
purpose-built variant with the change REMOVED. A warm loop or a sandboxed temp HOME has
been wrong every time, twice with the conclusion inverted.

### The JSONL byte-level prefilter: identical, and slower on every workload

Measured 2026-09-22. The idea was to skip `toString` and `JSON.parse` for lines
that cannot contain a tool call, testing the raw bytes for a marker first.

**Correctness was the gate and it passed completely.** Full-corpus differential
in 32 MiB boundary-aligned windows: 6,817.2 MiB of 6,817.2 MiB, 969 files,
1,141 windows, 97,469 observations per side, comparing every field plus the
non-enumerable parser offsets. **Zero mismatches.** Repeated at a 7 MiB window
so the slice boundaries fall elsewhere: zero again. The differential harness
was mutation-proven: dropping the Codex `function_call` marker produced 45
mismatches and lost 3,764 observations.

**It is slower everywhere.** Cold, interleaved, fresh processes, min / p50, the
delta being baseline minus prefilter so negative is worse:

| workload | delta |
|---|---|
| claude-append 0.53 MiB | -1.10 / -1.93 |
| claude-ingest 58.1 MiB | -27.48 / -30.68 |
| codex-ingest 59.1 MiB | -15.62 / -10.91 |
| whole corpus 2,185.9 MiB | -1035.2 / -1210.5 |

The skip test costs O(line bytes x markers) and the saving only lands on
skipped bytes. Measured skip rates: Claude 0.8% of lines and 1.4% of bytes;
Codex 73.5% of lines but only 34.5% of bytes corpus-wide, and 6.0% in an
ingest-sized slice. Codex lines are huge, p50 866 bytes and max 10.8 MB, so the
lines that do NOT skip get scanned an extra time for nothing.

**The prefix-bounded repair is unsafe and was not timed.** First-marker byte
offset over the corpus reaches 592,928 for Claude and 1,316,527 for Codex, so
even a 4 KB prefix window would silently drop 7,430 Claude and 1,192 Codex
lines. Silently losing evidence to save time is the trade this project does not
make.

**A figure of mine that does not reproduce, corrected here rather than left to
be cited.** A CPU profile taken earlier that day attributed 243 ms to
`parseJsonlRecords` over a 550 KB appended slice, and that number appears in
this session's reasoning about where scan time goes. A real 550 KiB-capped tail
parses cold in **9.9 to 13.5 ms**, and the whole 969-file, 356 MiB sweep of
550 KiB tails is 2,087 ms in one process. The 243 ms is roughly 20x anything
reproducible. Most likely it was the profiler's own attribution over a slice
that also carried GC and first-call compilation, read as steady-state cost.
Do not cite it.

### The four refuted rows from the 2026-09-10 ranked table

Moved out of `BACKLOG.md` on 2026-09-22, where they had sat struck through inside a
priority table for twelve days. A struck-through row in a worklist is still a row: it
reads as something someone decided not to do yet, rather than something that was measured
and is false.

**All four shared one cause: they were measured in a sandboxed temp `HOME`, where reads
cost roughly 6x what the same bytes cost in the real `~/.claude`.** That inflation is the
single most productive error in this project's measurement history, and it is why the bar
above says what it says.

| claim | measured figure | truth |
|---|---|---|
| `fullReport` re-reads the whole memory corpus every push | 6.98 / 7.96 ms | **0.56 ms.** Read 1.46 ms p50 against stat 0.90 ms over 17 files is a 1.6x ratio, not 10.3x. The growth argument was wrong too: a stat stamp scales with the corpus exactly as the reads do. *Dated note below, 2026-10-20: the 0.56 ms is a 17-file figure* |
| 44 KB of verb bodies compiled on every hook call | 1.12 / 2.50 ms | **0.00 ms.** The real 44.4 KB file is 43.87 / 48.54 ms; a 1.8 KB stub is 44.00 / 48.73; a 212-byte floor is 43.01 / 48.48. V8 pre-parses and lazily compiles, so unexecuted verb code is free. **Do not re-derive this**: it proposed a 30 KB refactor of the most safety-critical file in the project for nothing |
| `gates.generated.md` read 5x per push | 1.55 / 1.69 ms | **~0.34 ms** |
| `CLAUDE.md` and `~/.codex/AGENTS.md` read twice each | ~0.89 ms | **~0.17 ms** |

**Dated note on the first row, 2026-10-20.** The 0.56 ms was measured over a 17-file store and
is out of date. A 1.9.0 audit measured `memoryReport` over a 171-file store at **23.9 ms min /
29.4 ms p50**: read 13.6 / 17.0, stat 6.7 / 8.4, `threadOf` 1.4 / 1.7, `gateEntryOf` 1.6 / 1.8.
Method: warm, n=40, in ONE process, which is NOT this section's cold protocol, so treat it as a
size estimate rather than a decision figure. The row's conclusion stands on these numbers:
read against stat is 2.0x (17.0 / 8.4 p50), not 10.3x, and a stat-stamped cache would still pay
the stat, so at most about the 8.6 ms p50 difference is available to save. What has changed is
the size of the whole: about 29 ms per dashboard push at 171 files, and it grows with the store.
Re-measure cold, in fresh interleaved processes, against a variant with the reads removed,
before anyone decides on it in either direction.

### From the hook and extension profiling pass

**`activate()`'s two lock acquisitions.** Premise stale, counted empirically: a converged
list with no project-local file takes **0** acquisitions, 1 if either half has work, and
2 only on a first run. Taking the lock off both unchanged paths already did this. Merging
would fuse two independent retry budgets for near-zero gain.

**Inlining `fixed-point-cache` into the CLI.** Built the arm and verified it removes
exactly 2 fs calls. Three cold runs give sign-consistent deltas of +0.8 to +3.7 ms,
entirely inside the noise floor. About 200 lines duplicated for nothing.

**The FNV-1a loop.** 0.513 min / 0.600 p50 cold, but the second call is 0.088/0.101, so
**84% of it is V8 warm-up rather than the loop**. A 4-byte-unrolled variant is SLOWER
cold. Replacing the content hash with `mtime:size` would weaken the one property the
module exists for.

**The 19 `statSync` in `recallIndexStatus`** (0.765/0.848, the largest single fs
component). They ARE the staleness check, and `recall_index.json` is not watched. A stale
"not stale" badge is worse than 0.8 ms.

**Repeated small reads**, all at or below the bar and confirming earlier refutations:
`settings.json` 3x (0.302/0.506), `gates.generated.md` 3x (0.118/0.450), `CLAUDE.md` 2x
(0.073/0.306), `MEMORY.md` 2x (0.142/0.149).

**Perfect fs dedupe as a package.** 87 calls to 62 saves only 1.54/1.64 ms against the
real location, LESS than the sum of its parts, because each part carries shared per-call
overhead. The `fastLint` item alone captures 70% of it, so the package is worth strictly
less than its best member.

**Hit-path baseline, for anyone who thinks something crept in:** still 13 fs calls, and
`require.cache` on a hit holds exactly 2 modules. The dominant remaining term is NOT fs.
It is the stdin round-trip at 3.78 min / 5.48 p50 ms, of which only about 1.2 ms is
stream overhead the hook controls.

### From the allow-list and learner profiling pass

**Per-observation `aggregateObservations`.** Looks like a batch function called in a
loop, which is usually a finding. Measured 53.29 ms against 50.21 ms batched over 1,422
observations, a 6% difference. Not worth the restructure.

**`new RegExp` in `history-adapters.js`.** Never appears in the CPU profile at all.

**Multiple `readSettings()` per extension event.** 0.127 ms each, and the freshness is
deliberate and documented. See also the note above on the same call being re-read inside
one dashboard push, which WAS worth removing, because that one was a duplicate rather
than a refresh.

**The double `JSON.stringify` compare.** 0.038 ms.

**`memory/recall.py` has no hot-path issue.** `build_or_update` already gates
re-embedding on `mtime` plus size, so the expensive work does not run on an unchanged
corpus.

**`fastLint`'s `existsSync` probes, answered from the listing. DECLINED AS A TIMING
CLAIM, kept on the syscall count. 2026-09-24.** The backlog row read "saves 1.07 min /
1.23 p50 ms per push, real `~/.claude`, warm, n=61". **It did not reproduce.** Measured
three ways against a purpose-built arm with the change removed: on `_push()` end to end,
p50 +0.64 / +1.25 / +0.62 ms with min −1.17 / +0.51 / −0.79 ms, so the sign flips at the
minimum; on `memoryReport()` alone, the regime the original figure used, min −0.134 /
+0.412 / +0.223 and p50 1.064 / 0.618 / 1.075 across n=61, n=81, n=41. The p50 is in the
right neighbourhood and the minimum is not stable. The change shipped anyway, on the
DETERMINISTIC count (`memoryReport()` goes 10 `existsSync` to 1), which is the same basis
the `refresh()` item used. **Do not restore the timing figure.**

**Threading the selection listing into `fullReport`. ZERO saving on this box.** There is
currently one store with a `MEMORY.md`, so selection short-circuits before listing
anything and `readdirSync` per report is back at 2, not the 4 the backlog recorded. It
removes one `readdirSync` per report only with two or more stores, which is what its test
asserts. Kept for that case; claimed for nothing today.

**Stale figures corrected 2026-09-24, all of them by large factors.** The memory corpus is
**137 files, not 17**. `recall_index.json` is **1.20 MB, not 157 KB or 122 KB**.
`recallIndexStatus` does **~136 `statSync`, not 19** — the refutation above still holds,
only the number moved. `fullReport` at "0.56 ms" is from the 17-file era. Re-measure
anything keyed to those numbers before citing it.

**What DID clear the bar, for contrast: memoising the `recall_index.json` parse.** Read
plus parse is 4.62 min / 6.14 p50 ms against 0.035 / 0.045 ms for a `statSync` of the same
file, so it is the largest single fs term in a push. Cold, fresh process per sample, arms
interleaved and rotated: **4.11 / 7.07, 6.62 / 6.90, 5.23 / 5.88 ms saved** off a 43-46 ms
steady push across three runs, roughly 13-15%. The first push in a fresh process is inside
the noise, necessarily, because nothing is memoised yet. NTFS mtime granularity here is
~0.5 ms (191 distinct stamps over 200 back-to-back same-size rewrites), so `mtimeNs` buys
no extra resolution and `{ bigint: true }` was not added. What is cached is a projection,
not the parse: the full parse retains 486 KB, the projection 16 KB, because `vec` is 384
floats per memory and no caller reads it.

**`summarizeRuleUsage` hashing the allow list twice per push. DECLINED, 2026-10-20.**
`src/rule-usage.js` `summarizeRuleUsage` runs on every dashboard push. It hashes each tracked
rule with `ruleKey` to find its record, then `allowFingerprint` hashes every rule again, plus
the sorted keys, to tell whether the saved count belongs to this list. A 1.9.0 audit measured
**1.89 ms min / 3.16 ms p50 for 470 rules**. Method: warm, n=30, in ONE process, which is NOT
this section's cold protocol, and it was not re-measured cold. Declined on that number: the
most a fix could save is the second pass, which by construction is about half the total (one
SHA-256 per rule in each pass), so 1 to 2 ms per push, the same size as the 1.54 ms fs-dedupe
package declined above. The fix (reuse the per-rule keys for the fingerprint, or cache it per
list) would give the fingerprint's definition a second home that `test/rule-usage.test.js` then
has to hold to the first. What reopens it: a cold measurement, fresh interleaved processes,
against a variant with the second pass removed, showing more than that.

---

## The 2026-09-25 measurement pass: fourteen claims, one survivor

Every open performance item in `BACKLOG.md` was measured to the standing protocol in one
serial pass, with nothing else running. **One was implemented, seven declined with
numbers, five were already at HEAD, one was a breakdown.** The declines are the product.

### The one that survived, and the refutation that was aimed at a different change

**Hook stdin no longer goes through `process.stdin`. IMPLEMENTED.** The Socket
construction plus the event-loop round trip for `data`/`end` was the largest remaining
term in a hook call. Cold, fresh interleaved processes, real hook spawn with a real
PostToolUse payload, both arms on the cache-hit path: against a purpose-built reverted
arm, n=41 x3, **min -5.359 / -6.382 / -5.567, p50 -3.815 / -5.852 / -5.677** off a
59-65 ms call. Re-measured against shipped code rather than an approximation: min
-3.657 / -5.330 / -3.953, p50 -3.868 / -6.018 / -5.218. **8-9% off every PostToolUse
call.**

It is not the wait for data: with the payload written 20 ms after spawn, -4.810 / -6.205.
**The recorded refutation "doing the fs work before installing the stdin listeners was
1.27 p50 WORSE" is true and measured a DIFFERENT change** — it kept the stream. That
entry should not be read as covering this one.

Deliberately NOT `fs.readFileSync(0, 'utf8')`: that buffers the whole payload before
anything can cap it, reinstating the unbounded accumulation the 1 MiB cap exists to
prevent. A bounded `fs.readSync` loop measures the same.

### Declined, with the number. Do not retry any of these.

**The hook keys twice on a miss.** 0.487 min / 0.699 p50 ms, cold n=41, real 45,891-byte
settings.json. **Smaller than the recorded ~1.2 ms**, a quarter of the bar, and paid only
on a miss whose real rate is near zero.

**Path probes poison the rule-match cache. THE PREMISE IS FALSE.** `normalizedRules` and
`compiledRules` are separate Maps with separate size checks and only rule strings reach
the compiled one. Measured after 1,000 / 5,000 / 10,000 / 20,000 synthesized
`Tool(<path>)` probes against the real 149-rule managed set: compiled = **78, 78, 78, 78.
Never once evicted.** Only `normalizedRules` thrashes. Cost of that thrash at 20,000
probes, cold n=15: with the cap raised out of reach, min -46.178 / **p50 +23.017**, sign
flips, claim nothing. With the probe never cached, -22.026 / -2.977 of 2,290 ms, i.e.
0.00015 ms per probe. The cap is meanwhile earning its keep as a leak bound: without it
`normalized` reaches 20,271.

**The drain reads settings.json four times.** It reads it **five** times on the one call
that promotes, then 1 read / 0 passes on every call after. One extra read is 0.263 / 0.317
ms, so removing all of them is ~1.3 ms on a once-per-project event. **Zero
`.claude/settings.local.json` files exist anywhere under the working root**, so the path
does not run here at all. The five reads are the unlocked probe, the in-lock plan read,
the writer's state read, the writer's rebase re-read, and the verify-after-write read that
"the truth is the file, not the intent" rests on.

**`new RegExp` in a nested loop, policy-exporters.** At the realistic 60-block export: min
-0.166, **p50 +0.009**, sign flips. At 200 blocks: -0.772 / -0.809, still well under the
bar, on a validator that only runs when Codex rules are exported. The
`history-adapters.js` refutation now has a sibling.

**`[...deny, ...ask]` spread and `coversPrefix` lowercasing.** The CPU cost is real and
reproduces: isolated over 525 real allow entries, cold n=41, **saving 3.757 min / 3.803
p50**. It does not survive into the only call that contains it. A real `status()` over the
live 618-candidate state, cold n=31 x3: p50 **-1.409 / -1.247 / -2.404** of a 146-167 ms
call. Under the bar, and it would buy that with a `tokens`/`lower` sync invariant on the
exported `rulePrefix` shape. **Declined on the containing call, not on the microbenchmark**
— that distinction is the whole point.

**`best_line` calls `_display_keys` per printed result.** In-process the recorded ~5 ms is
right (0.459/0.513 per call, k=10). It does not survive to the process: run 1 min **+3.379**
/ p50 -8.967; run 2 min **+6.979** / p50 **+1.702**. Sign flips within a run and between
runs. The cause is visible below: this box drifted 25% across the session, 20x the effect.

**The sticky dashboard hint. Declined because the `coverIndexKey` memo already spent it.**
The hint's entire ceiling is one warm `processAllowList` per push, now 0.996 min / 1.197
p50 (n=200, A/B interleaved). A hint that never missed saves less than that. The recorded
1.38-2.19 / 1.65-2.20 is stale, and **the guard-test problem never has to be solved.** For
the record it IS solvable, so the blocker is the number and not the test: the pass-count
assertion re-expresses on OUTPUT as `pendingWildcard === 0` after a stale hint, because
trusting a stale hint against a 15-entry disk list renders 16, not 0.

### Figures corrected

**The `coverIndexKey` memo's own source comment does not reproduce.** It records warm n=270
`0.983/1.095 -> 0.483/0.540`. A no-memo arm measures **0.483/0.774** — their stated AFTER is
the measured BEFORE, and the memo arm is 0.065/0.107. Either the arms were labelled
backwards or the workload differed. The DO verdict is unaffected; the magnitudes are wrong.

**`recall.py`'s "1.0 s fixed cost with ~0.7 s unaccounted" is stale and now resolved.**
Total is **660.1 min / 688.9 p50**, not 1.0 s. The breakdown, n=11 fresh processes:
`import numpy` 110.7/116.8 (17%), `import onnxruntime` 81.9/88.8 (13%), **the ONNX session
190.6/205.1 (30%)**, **the BM25 corpus build 83.0/90.8 (13%)**, index load plus 136 stats
26.1/28.0, module body 9.6/10.3, query embed 6.5/6.9, matmul 0.067/0.102. So the
"unaccounted 0.7 s" is the session plus the corpus build. **First run after a boot pays
552 ms for the session, not 194**, because the 34 MB model comes off disk.

**Measurement drift on this box is 25%.** The same arms re-run forty minutes later moved
every one of them by that much. `recall.py` whole-process timing **cannot resolve anything
under ~30 ms here**; only in-process phase timing can. Three items were settled in-process
for that reason.

### Adjacent finding — DONE 2026-09-27, this entry was stale

`onnxruntime` is used at exactly one line and `numpy` only inside the embedder, the matmul
and `--selftest`, yet both are imported at module scope. `--lint`, `--lexical-only`,
`--gates-compile` and `--list` therefore pay **237 min / 244 p50 ms** of imports they never
touch, and `--gates-compile` is on the extension's corpus-watcher path.

**That was fixed and this entry did not say so.** `memory/recall.py:114-115#_LazyModule` now binds both
through a `_LazyModule` proxy (`np = _LazyModule("numpy")`, `ort = _LazyModule("onnxruntime")`),
and the comment at line 51 records the change from the old `import onnxruntime, numpy`.
Verified 2026-09-27 rather than read off the source: `python -X importtime recall.py --lint`
loads **neither** module.

⚠ **The lesson is about this file, not about the imports.** The entry sat under a heading
whose section is titled "do not re-derive these", so it was actively steering work away from
something already complete. A record of open findings needs the same disposition discipline
the backlog has — an entry is FIXED, DECLINED or OPEN, and "not acted on" is a claim with a
shelf life. It was caught only because a recommendation was checked against the code before
being made.

## MEASUREMENT HAZARD: `npm publish --dry-run` exits 0 on a private package

Checked against **npm 11.13.0**, 2026-09-27, while adding `"private": true` to the root
manifest. The obvious way to confirm the flag works is the obvious wrong one:

```
$ npm publish --dry-run
npm notice Publishing to https://registry.npmjs.org/ with tag latest and default access (dry-run)
+ permission-wildcarding@1.5.5
$ echo $?
0
```

That reads exactly like the flag is inert. It is not. The refusal lives at **line 15 of
libnpmpublish's `lib/publish.js`** — `if (manifest.private) throw EPRIVATE` — and npm calls
libnpmpublish **only when `!dryRun`**, at line 181 of its own `lib/commands/publish.js`. So the
one guard that stops a real publish is the one a dry run never reaches.

(Those two are deliberately not written in `file:line` form. They name npm's tree, not this
one, and `scripts/check-line-refs.js` correctly refuses a citation it cannot resolve against a
tracked file — which it did, on the first draft of this entry.)

A second trap sits beside it. `npm`'s *own* `lib/commands/publish.js` also tests `private`, at
line 142, but that test is `if (workspace && manifest.private)` and exists so
`npm publish --workspaces` skips private members. Reading only that file, in a repo that is not
a workspace, supports the opposite and equally wrong conclusion: that npm no longer honours
`private` at all.

**So `private: true` does block a real publish here, and neither reading npm's publish command
nor running a dry run demonstrates it.** Both were tried in that order and both pointed the
wrong way.

## A control that names a cause it does not require

`drainLocalSettings` blocks on **migration evidence** — the retired approve-all hook, or allow
entries the retired implementation generated that are still in user scope. It deliberately does
**not** block on `legacy.allow`, both blanket grants being live, because `Bash(*)` and
`PowerShell(*)` can be the user's own choice and blocking a legitimate drain is the worse error.
That trade-off is pinned by *"user-owned broad grants without migration evidence do not block the
drain"* in `test/local-settings.test.js`.

Both user-facing messages nevertheless told the reader the opposite: *"Legacy Bash(\*) and
PowerShell(\*) grants cover every local entry"*, and the dashboard label read *"legacy blanket
detected"*. Reachable counter-example, now a test: a user whose snapshot-derived `Read(*)` and
`Write` are still in user scope, with **neither** blanket grant anywhere, is blocked and told
that blanket grants cover every local entry.

`BACKLOG.md` had framed this as "either the condition or the wording is wrong". **It is the
wording.** The condition is correct and was already pinned by a named test; the first reading of
this entry proposed changing the predicate, which would have broken that test and penalised
exactly the legitimate user it protects. Fixed 2026-09-27 in `extension.js`, `bin/wildcard-perms`
and the guard's own comment.

The `legacy-blanket` report key is left alone: five call sites agree on it, and renaming a
contract to fix a sentence is the wrong trade. It carries a comment saying the name is
historical.

**Nothing asserted either string**, which is why the wording outlived the condition. There is now
a source-text tripwire beside the behavioural test. It is honest about being a tripwire: both
strings live inside a webview template and an inline CLI branch, so neither is reachable from a
unit test, and the guard asserts the CONDITION (the block does not imply blanket grants) rather
than that the strings exist.

⚠ **There were THREE sites, not two, and the first fix missed one.** The status row —
`setState('stLocal', ...)` at `vscode-extension/extension.js:6174#stLocal` — said the same thing in two
words, `legacy blanket detected`, and the tripwire, written against the long sentence, did not
know that spelling.
It was caught by grepping the **installed VSIX** after packaging 1.5.6, not by the suite, which
was green, and not by re-reading the patch, which looked complete. The tripwire now carries a
list of spellings rather than one regex.

This is the same lesson as the release-note claim about validating the deployed artefact, and it
keeps arriving from a different direction: **a patch script that asserts `count === 1` proves
its pattern was unique, not that the pattern was the only place the thing was said.** Uniqueness
of a string is not coverage of a concept. Grep the artefact for the CONCEPT afterwards.

---

## Toggle Auto Learn, and `autoLearn.enabled` made tighten-only (2026-10-19)

**DONE** on `feat/auto-learn-toggle`, `f00f59e`. The owner asked why the Auto Learn row said
"disabled" with no way to turn it on or off from the extension. `autoLearn.enabled` could only be
changed in Settings, and Cycle mode, the one Auto Learn switch, never touches it.

**The command.** AI Acolyte: Toggle Auto Learn
(`vscode-extension/extension.js:2174#toggleAutoLearn`) flips the effective value.
- Off writes `false` to user settings, so it holds in every window.
- On writes `true` to user settings. A workspace or folder `false` would still hold this window
  off, so it is removed, as Cycle mode's raise removes a capping mode. The difference is a modal
  first, naming the file (`vscode-extension/extension.js:2152#workspaceSettingsFile`), because it
  may be a `.vscode/settings.json` the repository commits. A dismissal writes nothing.
- User settings are written before any removal, so a failed write changes nothing.
- `deactivated` is checked on entry, after the modal and after the writes.
- It arms or disarms the periodic scan itself, and schedules a scan when turning on, instead of
  waiting for the configuration event, as `cycleAutoLearnMode` does.
- The toast says the extension's scans stop or start, and that Codex's after-turn Stop hook and
  the CLI's `--learn` are separate. Neither reads a VS Code setting.

**The card.** A Turn on / Turn off button in the Auto Learn card's row posts `toggleAutoLearn`.
While off, the collapsed row reads "disabled · Turn on" with no tint
(`vscode-extension/extension.js:6105#stAutoLearn`), since off is a choice. Review and Apply safe,
refused while off, now name the command where they said "Enable it" in settings.

**Tighten-only.** `autoLearn.enabled` is the fifth key in
`vscode-extension/extension.js:1335#TIGHTEN_ONLY`, shaped like `localDrain.enabled`, and
`autoLearnConfig` reads it through `vscode-extension/extension.js:1435#tightenOnlySetting`. The
census above ("The settings census behind S2") called the key safe, because a scan writes only the
learner's own state. That holds in `recommend`. In `auto-safe` every scan applies grants
(`src/auto-learn-manager.js:2925#application`), so a repository's `true` could restart unattended
applies for a user who turned Auto Learn off and left the mode at auto-safe. That census row is
superseded by this section. A workspace `false` still turns it off. A looser value is ignored, with
the same single output line as the other four keys:

`[<time>] Settings: workspace setting autoLearn.enabled=true ignored: a workspace may only turn Auto Learn off (user setting: false).`

**Residuals.**
- Turning on edits the repository's settings file when one holds `false`. The modal says so and
  names it.
- The configuration is read without a resource, and VS Code then reports no folder tier, so the
  folder branch is reached only in harnesses today. In a multi-root window it names "the folder's
  .vscode/settings.json", because it cannot say which folder.
- Off does not stop the Codex Stop hook or `wildcard-perms --learn`. The hook scans in the mode the
  learner last persisted, auto-safe included. The off toast points at Configure Codex after-turn
  learning.
- Scan now still scans while off, and in auto-safe its scan still applies. That is a click, not
  unattended.
- A release before this one still honours a workspace `true`.

**Tests.** `test/auto-learn-toggle.test.js` (8 tests) drives the real extension over a temp home
with a tier-by-tier configuration, as `test/workspace-tighten-only.test.js` does, and finds the
periodic scan by its period (7 minutes, which no other interval here uses). One test in
`test/dashboard-view.test.js` runs the panel script: the label, the row's text and tone, the click,
and the route. The routes census gained `toggleAutoLearn`; the manifest loop in
`test/workspace-tighten-only.test.js` gained the key; two refusal strings in
`test/extension-activation.test.js` changed with the wording. 25 mutations, each applied alone,
its blast radius run, and the file restored and checked by hash; all 25 failed a test in the
expected file. They are listed in `f00f59e`'s message.

**Not verified in a real VS Code.** The suite and the scripted harnesses drove this, not an
installed VSIX. The acceptance badge assertion (`scripts/vscode-acceptance/renderer.js`) was
updated to the new row text, but it was not run. (Superseded 2026-10-20: it ran. `drive-vscode.js
--review-runtime yes --dashboard-ui yes` passed 6 of 6 against the installed 1.9.0 on VS Code
1.142.0, per "The 1.9.0 backlog clearance (2026-10-20)" below. That group cannot pass without the
Scan case (`scripts/vscode-acceptance/renderer.js:1962#completedAutoLearn`), and
`scripts/vscode-acceptance/renderer.js:662#driveAutoLearn` checks in that case, before its click,
that the badge reads "disabled · Turn on".)

## Spawn timing under load: what a timing capture found (2026-10-20)

The two BACKLOG items "Two process-timing tests fail on the development box under full-suite
load (2026-10-16)" and "A worker-runner timing test was cancelled once under heavy load", on
branch `fix/spawn-timing` (from `d4e977d`). Every run below was a full `node --test` on the
development box (Ryzen 9 3900X, 24 logical CPUs, Node 24.16.0), inside the shared suite lock, so
no other full suite ran beside it. Other sessions' single-file runs could.

**The load.** A generator beside the suite: 6 loops spawning `node -e 0` and `cmd /c exit` back
to back, N spinning worker threads, and 1 loop copying `node.exe` to a fresh file and running it
once (a first run of a new executable, which endpoint scanning holds). N was 8 until the box
locked up at 23:59 on 2026-10-19, during the second run of a pass at that load (Kernel-Power 41
with no BugCheck event, so a hang or power loss, not a crash with a dump). Whether the load caused
it is not known. Every run after it used N=4, the "before" pass included, so the comparison
below is like for like.

**The capture.** A `NODE_OPTIONS` preload, kept out of the repo, wrote one JSONL file per process
and thread: when the process started and its JS began, every `spawn`, `execFile` and `spawnSync`
with how long the call held its thread, and when each child's 'exit' and 'close' arrived.
(Superseded 2026-10-20 for "kept out of the repo": the preload is now `scripts/measure/spawn-capture.js`,
its logic unchanged, and `scripts/measure/spawn-capture-summary.js` is the script that printed the
figures below; run on the three captured runs' directories it prints them exactly. The load
generator is still not committed; the preload's header describes it, with the lockup warning.
`test/measure-spawn-capture.test.js` checks both against one unloaded spawn.) Over
three captured loaded runs of `d4e977d` (N=8), `spawn()` of a node child held its caller
107-1,080 ms (p50 291, n=81), of a cmd.exe 118-1,228 ms (p50 290, n=112), and a node child's JS
began 197-1,701 ms after its `spawn()` returned (p50 570, n=63). Those three runs failed 2, 1 and
0 tests.

| Test | Failed | Cause | Disposition |
|---|---|---|---|
| dashboard-project-trust "a cold push starts no process on the host thread, and both Codex answers still arrive" | 1 of 3 captured runs (the 30 s wait) | **A product race.** The push's two threads spawned at once: the version probe's cmd.exe from 25,622 to 25,979 ms, the config worker's node from about 25,661 to 26,111 ms. On Windows libuv makes a child's pipe ends inheritable for the length of `spawn()`, and CreateProcess inherits every inheritable handle in the process, so the worker inherited the probe's stdout. `--version` exited at 27,903 ms, but its 'close' came at 30,752 ms, 1 ms after the worker exited, and the probe's 5 s timer had fired at 30,559 ms: "timed out", cached for 60 s. Isolated (two threads released by one barrier, a 4 s child and an instant one; `scripts/measure/spawn-pipe-inheritance.js`, committed 2026-10-20): the instant child's 'close' came about 4 s after its exit in 8 of 8 rounds, and 0-1 ms after it in 8 of 8 with one lock held across each `spawn()` | **FIXED**, `5f065fc`. src/spawn-thread.js gives every thread it starts one process-wide SharedArrayBuffer gate, held for the `spawn()` call alone: the probe's execFile, and the config worker's spawn through nativeRpcAsync's new `spawnGate` option. A hold older than 5 s is taken over, so the gate can delay a spawn but never stop one. Tests: "the version a cold push asks for lands while the trust ask it started is still open" (the stand-in holds its config/read answer until the test opens a gate file, which it does only once the version is on screen; no clock), and "a thread spawns only while no other holds the gate, and takes over a hold left stale" |
| codex-mcp-config "a tree kill of the asynchronous worker ends the codex it started, on every platform" | 1 of 3 | taskkill /T ends the leaves first and the root last (root last in 10 of 10 trees, unloaded; `scripts/measure/taskkill-tree-order.js`, committed 2026-10-20). The codex was ended. The test's taskkill started at 25,513 ms; the worker saw its cmd.exe die at 26,839 ms, answered "Codex config server exited early" and exited on its own at 26,842 ms, so taskkill exited 255 and the host took the worker's line as the answer: "refused: ... exited early" instead of "unavailable" | **FIXED**, `1db8ab8`. endProcessTree marks a live child `TREE_ENDING` before it signals anything, and nativeRpcAsync reports an ask so marked as ended by its caller, whatever its worker printed meanwhile. Nothing kept such an answer (deactivate abandons it in the same tick), so what changed is a contract two tests assert, now true by construction. Test: "an ask its caller ends reads as unavailable even when its worker answers inside the kill" (Windows) forces the order |
| codex-mcp-config "the config worker's own kill runs System32's taskkill, not one planted in its cwd" | 1 of 3; and CI run 38970150410 on `67ff813` | A 4 s budget put the worker's deadline 1 s after the call, and a worker that starts past its deadline spawns nothing (`1cf20d0`): "precondition: the stand-in codex started", the host answering after 2,759 ms here and 1,091 ms on CI | **FIXED (test)**, `16c5427`. The stand-in refuses `initialize` and stays up, so the worker's grace kill is reached by an event; the budget is 30 s. New witness: the host itself started no taskkill, so its backstop never had to end the tree. The old "worker's deadline, not the host's backstop" check could no longer fail on its mutation, because the answer is the worker's line, written before the kill |
| codex-mcp-config "the config worker's grace kill skips an app-server that exited by a signal, and still ends a live one" | 0 of 3 here; 3 of 3 on 2026-10-16 | **NOT REPRODUCED, cause NOT KNOWN.** On 2026-10-16 the cmd.exe's 'exit' came 2 s after the 1 s grace kill had fired. Captured here: 29, 81 and 81 ms after the kill, and 54, 63 and 195 ms in the controls. The test needed that exit inside the 1 s grace, and the node's 3 s linger to outlast the grace | **FIXED (test), cause ACCEPTED-RECORDED**, `c3591fb`. Each step now waits for the one before it: the signal run's finally is reached through the exit itself ("exited early"), and the stand-in's node exits only once the grace kill has decided, so 'close' always follows. A late exit now makes the run slower, and one that never comes fails at the 30 s bound with its log |
| codex-mcp-config "the asynchronous layers read does not block, is bounded, hands its child over, and leaves no codex running" | 0 of 3 captured; once on the 1.8.0 full run (line not recorded); and once in the first "after" pass, in its after hook | Body, inferred and not observed: `Date.now() - started < 1000` right after the call includes the worker's CreateProcess, 162-569 ms for this file's workers (n=9) and up to 1,080 ms for a node child. Hook, observed: EPERM removing the directory the app-server stood in, the HARNESS HAZARD of 2026-10-14 (a `.cmd` stand-in's console host keeps its cwd after it dies, and Node 24's rmSync does not retry) | **FIXED (test)**, `f211943` and `648edbe`. The claim is an order: when the call returns, the codex it asks has not started (no pid file). Two cleanup hooks that removed an app-server's cwd with a bare rmSync now retry, as the file's other process tests already did |

**Mutations**, each run against its blast radius and restored:
- `gated` runs its spawn at once: the new dashboard test failed 5 of 5 runs, and the gate test
  failed with "a thread spawned while another held the gate".
- The gate's stale takeover dropped: the gate test failed with "a stale hold stopped every later
  spawn".
- `endedByCaller` always false, and separately the `TREE_ENDING` mark dropped: the forced-order
  test failed both times, reading "refused: Codex config server exited early".
- `taskkill` named bare in endProcessTree: the planted-taskkill test failed on the flag, the host
  having run its backstop's taskkill itself.
- The old `exitCode`-only grace kill: the grace test failed, its log showing taskkill /PID (the
  signalled PID) /T /F 1.0 s after the finally.
- readCodexConfigLayersAsync routed through the synchronous nativeRpc: the asynchronous-read test
  failed with "it returned after 31308 ms".

**HARNESS HAZARD: a mutation that does nothing.** For "does not block", the first candidate
witness was a `setImmediate` that must run before the answer, and the first mutation blocked the
thread for 7 s after `spawn()`. Both passed together. The block starved the worker of its request,
which is written only once the loop runs, so the worker answered past its deadline without
spawning anything, and no witness had anything to see. Only the synchronous-route mutation was a
real one. Also: a gate-test mutation that leaves a spawn thread waiting for ever held the test
file open after the test had failed; the test now frees the gate in a `finally`.

**ACCEPTED-RECORDED, not gated:** spawns on the extension host thread (its four `execFile` sites
and deactivate's taskkill), the Auto Learn worker thread's `execpolicy` checks, and the taskkill
a spawn thread runs to end its tree. A pipe one of them leaks makes one answer wait for one other
process to exit, and none of them is on the dashboard push.

**Not verified here:** the Linux and macOS legs. The gate and the mark are platform-neutral, and
the new order and grace tests are Windows-only, but nothing was run on POSIX (the podman machine
was not running). CI is the first POSIX run.

**The box got faster across the lockup.** Before it, the load generator managed about 3.3
spawns a second and a loaded full run took 98-124 s (95 s for one unloaded run); after it,
about 18 spawns a second and 35-43 s. So every figure in the capture paragraph above is from the
slower state, and the runs after the reboot are a milder load than the ones before it.

**Results** (tests / pass / fail / skip per run; only the first row ran with the capture preload):

| Pass | Tree | Load (spawners, spinners, copiers) | Runs | Tests / pass / fail / skip | Family failures |
|---|---|---|---|---|---|
| Captured, 2026-10-19 | `d4e977d` | 6, 8, 1, with the capture preload | 3 | 1844 / 1836, 1837, 1838 / 2, 1, 0 / 6 | tree kill and planted taskkill; cold push; none |
| First after pass, 2026-10-19 | `b88f4c5`, two test files edited during runs 4 and 5 | 6, 8, 1 | 5 | 1847 / 1841 / 0 / 6, except run 3: 1840 / 1 | run 3: the asynchronous-read test's after hook, EPERM (fixed in `648edbe`) |
| Clean after pass, 2026-10-19 | `48392b6` | 6, 8, 1 | 1, then the box locked up in run 2 | 1847 / 1841 / 0 / 6 | none |
| **Before**, 2026-10-20 | `d4e977d` (an extracted copy under the temp root) | 6, 4, 1 | 5 | 1844 / 1835, 1836, 1835, 1835, 1835 / 3, 2, 3, 3, 3 / 6 | **4 of 5 runs**: the asynchronous-read hook EPERM (runs 1 and 3), spawn-thread "ending a thread child ends the worker and the codex it started", reading "refused ... exited early" (runs 4 and 5). Two more failures in every run are the copy's location, not the family: runtime-instruction-isolation and vscode-acceptance-mcp refuse a checkout under the temp root |
| **After**, 2026-10-20 | `48392b6` | 6, 4, 1 | 5 consecutive | 1847 / 1841 / 0 / 6, every run (35-37 s) | **none** |
| **Unloaded**, 2026-10-20 | `48392b6` | none | 1 | 1847 / 1841 / 0 / 6 (32 s) | none |

**The worker-runner item.** **DECLINED-MEASURED: nothing to fix.** Not reproduced: 240 runs of
`test/auto-learn-worker-runner.test.js`, 24 at a time for 10 rounds beside the 6, 4, 1 load, gave
3,840 results with 0 failed or cancelled; its slowest test took 571 ms (p50 559, n=240) against
the 15 s per-test timeout. It also passed in every full run above (19 loaded, 2 unloaded). Read for a
mechanism: every wait in the file is bounded by a ref'd timer of at most 3 s (`outcomeWithin`,
`until`, the 200 and 500 ms waits), so nothing in it can be cancelled by an empty event loop,
and a cancellation needs the file's process stalled past 15 s. The 2026-10-13 condition, four
full suites at once, was deliberately not re-created after the lockup.

## The MEMORY.md guard, and `allowManagedHooksOnly` read as "no user hooks" (2026-10-19)

**Built in 1.9.0, default off.** A real Claude Code memory index grew to 157 lines one reasonable
hook at a time, past the point where the lint's after-the-fact report helped, and a header
comment carrying a second `<!--` leaked its tail into every session. `src/memory-index-guard.js`
is a `PreToolUse` hook on `Write|Edit|MultiEdit` that replays the edit against
`<config>/projects/<slug>/memory/MEMORY.md` and exits 2 only when a measure ends past its budget
and is worse than before: 140 lines, 12,000 bytes, 300 code points on any line, 16 `- ` entries,
0 broken HTML comments. `wildcard-perms --memory-guard on|off|status|probe` and the extension's
**Toggle MEMORY.md guard** install it; `memoryLint.js` and `recall.py --lint` apply the same line,
width and comment rules, and `test/memory-guard-parity.test.js` measures one set of fixtures with
all three.

**The per-event reading of `allowManagedHooksOnly` is out of date, and was corrected in the README
and `docs/claude-code-permissions.md`.** Both said a user hook still runs on an event the managed
policy itself defines, from a `PostToolUse` canary that fired 4 of 4 under such a policy on
2026-08-24 and left no artefact. Measured on the development box on 2026-10-19 with Claude Code
2.1.293 and 2.1.301, under a managed policy that sets `allowManagedHooksOnly`: `claude -p "/goal x"`
printed "/goal can't run while hooks are restricted (disableAllHooks or allowManagedHooksOnly is
set in settings or by policy)", and no user, project or `--settings` hook ran on `PreToolUse`,
`PostToolUse` or `UserPromptSubmit`. A headless run alone cannot tell "policy blocks hooks" from
anything else that keeps a hook from firing; the `/goal` refusal names the policy, and that is
what carries the conclusion. Left for whoever owns them: `hookEventAllowed` in
`src/managed-policy.js` still answers per event (no production caller), and a comment in
`scripts/verify-release.ps1` restates the per-event claim. (Superseded 2026-10-20 for the
comment: `377d705` replaced the per-event claim with this measurement, and `771aa9e` narrowed it
to the three events tried. The runs above were made by hand; `771aa9e` also adds
`scripts/probe-user-hooks.js`, which repeats the `/goal` question and the `--settings` and
project-local cases on those three events when run with `--run-claude`.)

So on that box the guard is installed and inert, and it has to say so. Every status, the card and
the enable modal carry a policy line read from what is local: a `managed-settings.json`, the cached
`~/.claude/remote-settings.json`, the user's own `disableAllHooks`. Nothing found reads as "cannot
tell", never as "runs", because a server-delivered policy can leave no local trace. `--memory-guard
probe` asks the client: it runs `claude -p "/goal probe"` once in an empty temporary directory and
reads the refusal text. A reworded message reads as unknown; where hooks are allowed the probe
is one short real turn.

**Decisions, with the reason each one is not the obvious choice:**

- *No `if` field on the hook.* `if` would spare a node start on every Write that is not to a
  `MEMORY.md`, but its semantics for `Write` could not be checked on a box that runs no user hook.
  The path filter runs first in-process instead, before any read. Correctness over latency.
- *A stable copy, refreshed by revision.* The hook runs `<home>/.claude/wildcarding/
  memory-index-guard.js`, never a checkout or the versioned extension directory (a VSIX has no
  `bin/`, and `.../ai-acolyte-1.9.0/src` stops being ours on the next upgrade). Bytes would
  flip-flop between a CRLF tree and an LF build, so the copy is replaced only when the packaged
  `GUARD_REVISION` is higher, and a test pins the CRLF-normalised sha to the revision. The guard
  may require `fs` and `path` only; a test parses its require calls.
- *Block only when worse.* Deleting lines can only lower lines, bytes, the longest line and the
  entry count, so compaction always passes and the guard is safe to turn on over an index already
  past every budget. The one deletion refused is half of a comment, which would leak its body. An
  orphan `-->` counts as a defect, an arrow written that way in prose included.
- *Fail open.* Exit 2 only for a confirmed violation; an 8 MiB stdin cap, an unreadable file, or
  an edit it cannot replay (an `old_string` not found, even after LF to CRLF; an ambiguous single
  replace) let the write through. Claude Code's own quote normalisation is not replayed, so an edit
  that matches only after it reads as not found and passes.
- *The hook command* is `"<node>" "<copy>"` with forward slashes, for the `sh` / Git Bash that
  Claude Code runs hook commands through. A shell that is PowerShell would not start it, which
  Claude Code treats as a non-blocking error, so that too fails open. `node` is resolved on PATH
  at install time, `node.exe` only on Windows, absolute entries only; never `process.execPath`,
  which in the extension host is Electron.
- *Off leaves the copy.* Claude Code reads hooks at session start, so a running session keeps
  invoking the command; a deleted script would turn every one of its writes into an error.
- *settings.json.* Written through `writeTransform` under the policy lock derived from the home in
  use, then re-read, and a write that did not stick throws. `writeTransform` writes LF, so a CRLF
  `settings.json` keeps every value and comes back LF; `settings.json.pre-memory-guard` keeps the
  bytes from before the first change, CRLF and all, and is written once.

**Mutation record.** 60 mutants over the guard, planner, installer, CLI, extension, `memoryLint.js`,
`recall.py` and the shared constants, each restored and sha-checked. Four survived the first pass
and each became a stronger test: a copy refresh by bytes (masked by the refresh's own revision
check, now also exercised through `on`), a backup rewritten on every change (masked because `off`
restored the same bytes), and a `recall.py` fence skip (the fixture's fenced text was a well-formed
comment, so skipping it or not gave one answer). The fourth was a mutation pattern matching twice,
fixed in the harness. A workstation crash at 23:59 killed the run of the last `recall-py.sh`
mutant with that mutant still applied to `recall.py`; it was found by diff and reverted before the
first commit. Re-run afterwards, it fired, and so did a second `recall-py.sh` mutant (dropping
`over_budget` from the `clean:` condition), which shows the bytes fixture still moves one axis.

**Follow-ups.** Add the `if` filter once its `Write` semantics are verified on a box where hooks
run, and measure the node start it saves there. Verify the hook end to end on such a box: the
exit-2 message reaching the model, and the per-call cost. Decide what `hookEventAllowed` should
answer now. The editor gauge has no entry-count rule; the guard and `recall.py --lint` do.

## Open threads: status leaves the index (2026-10-19)

Built for 1.9.0 on branch `feat/open-threads` (on `d4e977d`, v1.8.1), from the maintainer's brief.
The owner's `MEMORY.md` bloated mainly because agents wrote status on its index lines: 10 of the 15
lines demoted from it carried DONE, SHIPPED or AWAITING. Claude Code loads only the first 200 lines
of that file. Status now has a sanctioned home: a memory declares `status:` in its frontmatter and
says what is open in a `<!-- status -->` ... `<!-- /status -->` block, `recall.py --threads-compile`
lists the open ones in `~/.claude/open-threads.generated.md`, and `src/agent-open-threads.js`
installs that file into `CLAUDE.md` and Codex's `AGENTS.md` (or a nonempty `AGENTS.override.md`) as a
third managed block. The owner's box runs a managed policy that keeps user hooks from running, so the
MEMORY.md guard hook built on another branch cannot fire there; the block therefore also carries an
INDEX line whenever `MEMORY.md` is past a budget, and every new session reads it.

**Selection** (`memory/recall.py` `_thread`). `status:` is read like `agents:`: anywhere in the
frontmatter, at any indent, `status :` still the key, a trailing `# comment` dropped through
`_uncomment`. Two `status:` lines are refused, never guessed at. Listed, case-insensitive: open,
awaiting, blocked, deferred, which is also the block's sort order, then the file stem. Closed,
silently not listed: done, closed, live, shelved, deleted, dropped, shipped. Any other value, an
empty one included, is a `--lint` finding and is not listed. A listed status needs its block, whose
marker lines must each stand alone (up to three spaces of indent, then only spaces or tabs after the
marker) outside fenced code. An unclosed fence runs to the end of the file, as in CommonMark, which
is deliberately unlike the managed-block reader in `src/agent-guidance.js`: there a stray fence must
not hide a real block, and here a marker that might be an example must not compile. The last opening
marker before the first closing one starts the block, as `blockRange` does. A listed status with no
such block is a finding and is not listed. The index is excluded, as it is from the gates.

**The file.** A header line carrying the first 16 hex digits of the SHA-256 of every byte below it,
then `## Open threads (N, managed)` with N counting threads only, then the INDEX line when there is
one, then at most ten lines `- **AWAITING** <text> (<stem>)` and one more counting the rest
(`- +N more open threads (recall "status")`). The text is the block's, collapsed on Python's
whitespace, with `<!--` and `-->` neutralised as `&lt;!--` and `--&gt;` (Claude Code strips HTML
comments, so a stray one would swallow what follows), a leading `#` escaped with a backslash, and cut
to 240 code points with an ellipsis. The stem gets the same collapse and neutralisation, uncapped.
Zero threads and a healthy index write the header and the heading alone, never an empty file, so an
empty read can only be a torn one.

**INDEX line.** Three budgets: 140 lines (`LINT_LINES_WARN`, added here; another branch adds the
identical line), 12000 bytes on disk (`LINT_TOTAL_WARN`) and a 300 code point physical line
(`LINT_LINE_WARN`, its line ending excluded). Lines are counted as `memoryLint.js` `fastLint` and
`wc -l` count them. Not the 16-entry ceiling, which is a soft attention target and would nag forever.

**Refusals.** Exit 1 with nothing written when discovery could not read a store (`compile_gates`'
reason), when the memory dir is missing, and, beyond the brief, when one memory cannot be read,
because dropping it would drop its thread in silence. There is no empty-compile refusal: zero is a
real answer, and it is how a closed thread leaves the block. The write is `_replace_file_text`,
`compile_gates`' temp-and-replace with its retry, lifted out unchanged (temp name, schedule and
message), so the gates' own atomic-write test in `test/recall-py.sh` still holds it.

**Install** (`src/agent-open-threads.js`, separate from `agent-gates.js` on purpose). One read of the
compiled file per call. Missing is nothing to do: a row with `refusal: 'missing'` and no `error`, so
an unattended caller logs nothing. A missing or torn header (nothing older wrote this file, so there
is no headerless form to accept), a sha that does not match, or a missing heading is refused with
every instruction file left as it was. A whole compile that lists nothing and has no INDEX line
removes the block from every agent, and its status rows read `current` once no block is left.
Backups are `*.pre-open-threads` and `*.pre-open-threads-prev`.

**CLI.** `wildcard-perms --open-threads on|off|status|refresh`, dispatched just before `--gates`.
`refresh` compiles through `runRecallCaptured(['--threads-compile'])`, installs with
`inPlaceFallback: false`, stays quiet when nothing changed, passes the compile's stderr on, and never
advises itself. `status` gives each agent ON or OFF, the thread count, whether an INDEX line is in
the compile, and the INDEX sentence itself.

**Extension.** `permissionWildcarding.openThreads.enabled`, machine-scoped and read from the user
tier like `gates.enabled`. Unlike the gates, the compile runs unattended from the start, because the
INDEX line exists for boxes where nothing else can say it. Triggers: a memory edit that can move the
block, a few seconds after activation when a compile could say something (a memory declares
`status:`, a compile exists, or the index is past a budget), and the setting turning on. Switched
off stays off: `ensureOpenThreads` removes the block, the corpus bump and activation compile nothing,
and the compiled-file watcher installs nothing. The `*.md` watcher's handler became a dispatcher,
`memoryCorpusChanged`, calling the unchanged `gatesCorpusBump` and a new `threadsCorpusBump`, which
inherits none of the gates' skips (`gatesEnabled`, `isOwnGateEdit`, the MEMORY.md skip), reacts to
`MEMORY.md`, recompiles on any edit while the compiled file lists a thread (a closure or a deletion),
otherwise only for a file that mentions `status:` or a status marker, and skips a store that does not
compile. Its timers are 2500 ms and 4000 ms, not the gates' 2000, which `test/gates-panel.test.js`
holds as the gates recompile; `threadsBounce` is cleared in deactivate. The activation check runs
inside its deferred timer rather than at activation: an activation-time `memoryReport()` read the
whole store on the activation path and broke `test/dashboard-view.test.js`'s one-report-per-push
census (2 calls against 1). The toggle (**AI Acolyte: Toggle open threads**) writes the user tier;
a settled install is turned off after a modal, anything else compiles (dropping the recompile the
setting's own listener just armed) and installs. The Claude memory card gained an open-threads line,
the INDEX warning and the toggle button, after the gates line, so both cards' shared order still holds.

**JavaScript and Python agree.** `memoryLint.js` `threadOf` (counts for the card and activation's
check, in `fullReport` as `threadDeclared` and `threadListed`) and `indexHealth` read every one of 700
generated memories and 24 generated indexes exactly as `_thread` and `_index_health` do
(`test/threads-compile.sh`). The corpus reached every outcome: none 278, no-block 151, unknown 133,
closed 60, duplicate 45, listed 33; 12 of the 24 indexes were past a budget. Two recorded
divergences, neither on the compile's path: for a `MEMORY.md` that is not valid UTF-8, Node's decoder
and Python's `errors="replace"` can disagree about how many replacement characters a bad sequence
becomes, which only moves activation's longest-line check; and `memoryReport` sees only stores that
hold a `MEMORY.md` (`discoverDirs`), so a store without one never triggers activation's compile,
though `recall.py` compiles it.

**Tests.** `test/threads-compile.sh` (new, a step in the existing `gates-manage` CI job, where
`CI=true` turns a missing Python or node into a failure), `test/agent-open-threads.test.js` (12),
`test/cli-open-threads.test.js` (9), `test/extension-open-threads.test.js` (11),
`test/open-threads-reading.test.js` (3), a card test in `test/dashboard-view.test.js`, and the
censuses moved: seven `execFile` sites with the new 60 s deadline, the dashboard route table, the
machine-scoped manifest census, deactivate's timeout count (16, where the old bound of 7 could not
fail for any timer dropped since), and `fastLint` from HELD to TEST_ONLY in
`test/dead-exports.test.js`, because the new reading test calls it directly.

**Mutations, each run one at a time by a runner that restored the file and checked it by
sha256.** 47 of `recall.py` against `test/threads-compile.sh` (selection, every status class,
duplicate refusal, fence and marker anchoring, the text's collapse, neutralising, escaping and cap,
the line cap, the header-only file, each INDEX budget and its join, each refusal, the atomic write,
the run-alone check, every `--lint` section, its count line, its reserved phrases and `clean:`):
all killed, three only after the test gaps they exposed were closed (an index fixture whose
frontmatter sat below its index lines and so declared nothing, no text under 240 characters but
over 240 bytes, no shorter fence closer before a block). 13 of `memoryLint.js`'s reading against
the agreement half: all killed, one (JavaScript's `.` in `FENCE_OPEN`) only after the generator
learned to put U+2028 in a fence's info string. 7 more of the reading against
`test/open-threads-reading.test.js`, which CI's node matrix runs: all killed. 12 of
`src/agent-open-threads.js` and 11 of `bin/wildcard-perms`: all killed. 32 of `extension.js`, one
of `memoryLint.js`'s counts and one of the manifest, against the extension, dashboard, lifecycle,
activation and machine-scope tests: all killed, one (the content check in `threadsMayChange`) only
after its test stopped letting a listed thread arm the recompile first. Not separately
falsifiable: `ensureOpenThreads`' early return for a missing compile, since `setOpenThreadsAll`
then writes nothing either; it saves a second read. The runner itself was killed once by a
workstation crash, mid-mutation; the one file it left mutated was restored and every mutation's
original text checked present before anything was committed.

**Not done here, and why.** `scripts/drive-installed.js`, `scripts/verify-release.ps1` and
`scripts/smoke.sh` are the integrator's to wire. Nothing was pushed, so the new CI step has not run
on GitHub. No real VS Code was driven. (Superseded 2026-10-20: all four were done for 1.9.0.
`7520395` drives open threads end to end through the packaged command and `recall.py` in
`drive-installed.js` (and `094e575` the MEMORY.md guard, in the same pass); `3dd98af` adds an Open
threads section to `verify-release.ps1`; `b013d95` has smoke check `--open-threads status`; and
`38483a7` reads the Claude memory card's open-threads line from a real VS Code webview. The CI step
ran on GitHub: BACKLOG.md's 1.9.0 release paragraph records `test/threads-compile.sh` passing there,
in the `gates-manage` job ("recall.py gate edits on Python 3.11").)

**Residuals, not changed here:**
- The CLI has no setting: `--open-threads refresh` installs whatever the extension's setting says,
  and the extension's next ensure removes it again while the setting is off. The gates behave the
  same way.
- A `status:` line inside a multi-line YAML scalar in the frontmatter is read as the key, as an
  `agents:` line there is.
- The thread text is the memory's own words, installed into every session, neutralised for comments
  and markers and otherwise verbatim: the same trust the gates give the store that compiles.
- Every `MEMORY.md` save in the compile store recompiles, one Python spawn per 2.5 s burst.
- The block carries no line telling an agent where status belongs; the brief fixed the format, and
  a footer would cost tokens in every session. A gate memory can say it instead.

## The 1.9.0 backlog clearance (2026-10-20)

The maintainer asked for `BACKLOG.md` to be cleared outright alongside 1.9.0. Every entry open
on 2026-10-19 was re-verified against the tree before its disposition was written; none was
closed by re-reading its own prose.

| Entry (BACKLOG.md, as of `d4e977d`) | Disposition | Evidence |
|---|---|---|
| Two process-timing tests fail on the development box under full-suite load (2026-10-16) | **FIXED** (`5f065fc`, `1db8ab8`, `16c5427`, `c3591fb`, `f211943`, `648edbe`, merged in `dedb978`) | One product race (`5f065fc`: the version probe inherited the config worker's pipes and read "timed out"), one contract made true by construction (`1db8ab8`: an ask its caller ends reads as ended), and four test orderings (corrected 2026-10-20: this said "Two product races", but the section above records that nothing kept the `TREE_ENDING` answer); the section "Spawn timing under load: what a timing capture found (2026-10-20)" above has the capture. Under the same synthetic load, `d4e977d` failed a family test in 4 of 5 full runs and the fixed tree passed 5 of 5, then one unloaded run. The grace-kill test's late exit of 2026-10-16 was not reproduced and its cause is not known (ACCEPTED-RECORDED); the test no longer depends on it. |
| A worker-runner timing test was cancelled once under heavy load | **DECLINED-MEASURED** | 240 runs of `test/auto-learn-worker-runner.test.js`, 24 at a time beside the load: 3,840 results, 0 failed or cancelled, the slowest test 571 ms against its 15 s timeout. Every wait in the file is bounded by a ref'd timer of at most 3 s. Same section. |
| Memory gates: `agents:` targeting (all three gaps closed), and the owner's note that rampage's Project-local drain work "is not mapped yet" | **CLOSED-VERIFIED** | The three gaps were already FIXED (`a9a2dbf`, `c6a1878`, `659be23`). For the note: rampage's source diff since its base `7ec8a8a` (`git diff 7ec8a8a main -- src bin`, 9 files, +1881/-501) contains no drain, `local-settings` or `localDrain` change at all; the only drain commits in its history, `4bc54ed` and `0dc2148` (2026-09-27), predate the extraction and are this repo's own `c640340` and `5d1720e`. There is no drain work to port. |
| Decided 2026-10-15, CLOSED: a workspace may lower Auto Learn's mode, never raise it | **CLOSED-VERIFIED** (shipped in 1.6.7, `f1407bf`) | Its two ACCEPTED-RECORDED residuals move here verbatim, below. Since 1.9.0 `autoLearn.enabled` is the fifth tighten-only key ("Toggle Auto Learn, and `autoLearn.enabled` made tighten-only (2026-10-19)"). |
| VS Code acceptance has not run against the 1.6.2 tree | **CLOSED-VERIFIED** | Run against the installed 1.9.0 on 2026-10-20, VS Code 1.142.0: the default groups 4 of 4; `--review-runtime yes --dashboard-ui yes` 6 of 6 (the "6 of 6" in the 1.6.8 to 1.8.1 release paragraphs is this run); `--mcp-only yes --review-runtime yes` 6 of 6, which includes the MCP suite's 0.161.0 shape check. |

**Moved from the 2026-10-15 entry, ACCEPTED-RECORDED rather than queued (wave-f15):**
- **Argument splitting on the cmd route.** A token ending in `\` before the closing quote merges
  with the next argument. That is argument splitting, not injection, and it affects only a
  non-npm batch-file codex.
- **The version probe still runs an npm `codex.cmd` through cmd.exe.** It is safe with fixed
  arguments.

**The 1.7.1 and 1.7.2 release paragraphs carried no evidence.** Recorded now: both merge commits
(`4fe6a32`, `3e8ba86`) have a green Tests push run and a green Release VSIX run. 1.7.2's published
`ai-acolyte-v172.vsix` matches a local build of the tag in all 61 entries once line endings are
normalised (checked 2026-10-19, CLOSED-VERIFIED). 1.7.1's release was pruned by release.yml's
keep-three rule, so its asset can no longer be compared (ACCEPTED-RECORDED on the CI evidence).

**The live hook worktree is on the other development box.** Every release paragraph since 1.6.7
says "the live worktree has moved to the tag", and this box has neither the worktree nor a user
hook: it records the box those releases were cut on, whose record entry counts 831 allow
entries where this box has 470. 1.9.0 was cut on this box; moving that worktree to `v1.9.0` is a
step for the other machine.

**A workstation lockup during a load experiment.** On 2026-10-19 at 23:59 the development box
locked up and rebooted (Kernel-Power 41, no BugCheck) while the spawn-timing capture ran 8
spinning threads plus spawn loops beside a full suite. Whether the load caused it is not known.
The capture was rerun at half the load. Keep synthetic load experiments on this box at that
level or below.

## Open threads after 1.9.0: the audit's seventeen findings (2026-10-20)

Four read-only audits of the 1.9.0 tree (`e9994db`) found seventeen open-threads issues; branch
`fix/threads-audit` takes each to a disposition. Every FIXED entry has a test that failed with
the fix reverted, run one mutation at a time by a runner that restored the file and checked it by
sha256; the commit messages carry each mutation and the test it failed.

| # | Finding | Disposition |
|---|---|---|
| 1 | "Turn off open threads" turned it off only from a settled install, and otherwise ran the ON path (a compile and an install) | **FIXED**: while on, the toggle is always the off path behind its modal; when `threadsNeedRefresh` says the install is not current the modal also offers Refresh, and the card shows **Refresh open threads** from the same predicate |
| 2 | A recompile armed before the switch went off still compiled | **FIXED**: the timer asks the switch again; the setting's off branch drops it (`cancelThreadsCompile`) |
| 3 | Turning it on ignored the compile's result and said "ON" over the previous compile | **FIXED**: the result is kept, the last compile is still installed (the CLI's behaviour), and the message says so |
| 4 | The INDEX line said "MEMORY.md is ..." in every project's sessions without naming which index | **FIXED**: recall.py names it, home-relative (`_home_relative`), or whole outside the home |
| 5 | C0/C1 controls and bidi controls survived in thread text and the stem | **FIXED**: `_THREAD_STRIP` before the collapse, in the text, the stem and the INDEX path; `memoryLint.js` `threadText` removes the same set, and the agreement corpus now writes them |
| 6 | `memoryReport()` (the whole store) was read for `.dir` alone on unattended paths | **FIXED**: `memoryLint.js` `memoryStoreDir()` at all five sites; the threads ask it once per burst, inside the debounce |
| 7 | The compile spawned on the extension host thread, outside the spawn gate | **FIXED** for the threads compile (`execFileOffThread`); **compileGates left on the host thread**: its harnesses record the host's `execFile`, so the move is not the same mechanical change |
| 8 | A MEMORY.md save always compiled, though the index moves only the INDEX line | **FIXED**: `indexEventMayChange` (not whole, an INDEX line present, or `indexHealth(fastLint(...))` past a budget); `fastLint` now has a production importer, so it is off the TEST_ONLY list in `test/dead-exports.test.js` |
| 9 | A slow compile could overlap the next, and the older could win | **FIXED**: one running compile and one queued, quiet only if every ask it stands for was |
| 10 | recall.py rewrote the compiled file when its bytes were unchanged | **FIXED** for the threads output; `compile_gates` unchanged |
| 11 | Every open window compiles on every burst | **DECLINED**, reasoned below |
| 12 | Memory watchers lost across a re-activate overlapping a pending deactivate | **FIXED**: `activate()` disposes the maps before its build, and a predecessor's disposer is a no-op after a successor activated |
| 13 | A stale comment on `gatesCorpusWatchers` | **FIXED** |
| 14 | `compiledListsThreads` parsed the compiled file a third way | **FIXED**: it asks `src/agent-open-threads.js` `readCompiled`; a compile that reader refuses also recompiles on any edit |
| 15 | A refused compile told VSIX users to run `wildcard-perms` | **FIXED**: `setOpenThreadsAll` takes `refreshHint`; the extension names its card's Refresh and the toggle's |
| 16 | `memory.enabled: false` hides the card, open threads included, while they keep compiling | **ACCEPTED-RECORDED**, documented: both READMEs say the card is hidden and the palette command and the setting still reach the feature. A minimal card would be a second render path through a card two other work packages draw into |
| 17 | Docs | **FIXED**: README section 6 and the extension README |

**11, declined.** The proposed skip (compile only when the compiled file's mtime is older than the
newest trigger) cannot be made safe here. A window's compile reads the corpus, then writes; an edit
that lands between the two leaves a compiled file newer than the edit and blind to it, and a second
window would then skip the compile that would have caught it, until the next trigger. With finding
10 an identical compile no longer moves the mtime at all, so the skip would fire only after a
compile that changed something, which is when a second compile matters least and costs the same.
After 9 and 10 the cost is one compile per window per burst, each off the host thread, and at most
one write of the file, so the compiled-file watcher fires once per real change rather than once
per window. Not measured: the number of windows open at once on the development box varies, and
the saving would be at most N-1 python spawns per burst.

**Behaviour that moved with these.** The threads' store check runs when the burst's timer fires,
so an event from a store that does not compile arms the timer and then compiles nothing (the
watcher test asserts the compile count, not the timer). Activation's deferred check shares the
burst, so a corpus event from another store in its first seconds no longer cancels it. A fresh
machine with nothing compiled shows **Refresh open threads** on the card until a compile exists;
one click writes the header-only file and the button goes. The lifecycle census follows
`execFileOffThread` with `execFile`: still seven sites, the threads compile the one off-thread
site, each tracked and bounded by `endTreeAfter`.

**Tests added.** `test/extension-open-threads.test.js` (11 new; one runs a real worker thread and
a hard-linked copy of node named `python.exe` against a stand-in recall script),
`test/extension-lifecycle-async.test.js` (1), `test/dashboard-view.test.js` (the Refresh route,
its arguments and the button's visibility), `test/threads-compile.sh` (the INDEX path inside and
outside the home, the control and bidi strip, the identical-compile no-write, and the generator's
strip axis with its witness).

**Not done here.** No real VS Code was driven. Nothing was pushed, so CI has not run the branch.

## The MEMORY.md guard audit, fixed on fix/guard-audit (2026-10-20)

Four read-only audits of 1.9.0's guard found seventeen items. Each one's disposition, with the
test that fails without it (every one mutation-tested; the mutation is in its commit message):

| # | Finding | Disposition |
|---|---|---|
| 1 | The block message, modal and READMEs said "already past its budget" and "shrinking edits always pass" | **FIXED.** The wording is "ends past a budget and worse than before"; a first crossing, a half-comment or fence-line deletion and a line join are named as refused. Advice follows the reasons ("close or remove the whole comment" for a defect, located by line). The modal's numbers come from `BUDGETS`. GUARD_REVISION 2. |
| 2 | With the hook's node gone, the card said "turn it on again" and its button turned the guard off | **FIXED.** Such a hook reads `on (needs repair)`; the toggle repairs it with no modal. |
| 3 | smoke.sh's status pattern was lowercase, the CLI prints uppercase | **FIXED.** A test reads the ERE out of smoke.sh and runs it on the real CLI output for every label `labelFor` returns. |
| 4 | `status` exited 0 on an unsupported hooks shape it labels UNREADABLE | **FIXED.** Exit 1. |
| 5 | The probe's fixed directory sat in the shared temp dir and an existing one was accepted | **FIXED.** `<config>/wildcarding/ai-acolyte-memory-guard-probe`, created without `recursive`; an existing one is used only when it is a plain, empty directory the current user owns, else the probe refuses and Claude Code is not run. |
| 6 | The probe was an unbounded agent run, and a timeout left the process under cmd.exe running | **FIXED.** An inert goal, `--tools ""` and `--no-session-persistence` (both in `claude --help`, 2.1.293, both measured not to change the answer; no turn-limit flag is listed, so none is passed), `npmShimLaunch` before `resolvedLaunch`, and an async run whose deadline calls `endProcessTree`. The first bounded version also passed `--strict-mcp-config`, which gave a false "not restricted" (below); it was removed, and a test fails if it comes back. |
| 7 | Any exit 0 read as "not restricted" | **FIXED.** The answer must carry the goal's word; "Unknown skill: goal" and the trust-gate text read as unknown. |
| 8 | The VSIX's UI named CLI verbs it does not ship | **FIXED.** Palette command "Check whether Claude Code runs user hooks"; `hookPolicy` takes a `surface`; the withdrawn workspace scope's note (extension.js and the setting's description) says which lines to delete. A census test drives what the extension shows about the guard. |
| 9 | No backup when settings.json was absent at the first `on`, so `off` snapshotted the installed bytes | **FIXED.** A `.absent` marker is written at the first change and stops every later snapshot. |
| 10 | CLAUDE_CONFIG_DIR honoured by the guard, ignored by install and status | **FIXED.** `configDirFor`; settings.json, the copy, the backup and remote-settings.json follow it. The policy lock stays under the home. |
| 11 | On Windows `memory.md` bypassed the exact basename check | **FIXED** for case and trailing dots and spaces, file and memory directory. GUARD_REVISION 3. **ACCEPTED-RECORDED:** 8.3 short names (`MEMORY~1.MD`), `::$DATA` streams, `\\?\` and UNC spellings and junction targets fail open. Resolving them costs a file-system call per Write on every file in a session, and Claude Code writes the index by its plain path. macOS's default case-insensitive volume has the same case gap; not folded, because `comparable` does not fold directories there either and a case-sensitive volume would then guard a different file. |
| 12 | A MultiEdit test could not fail (its old_string was ambiguous) | **FIXED.** Unique old_strings, a reproduction precondition, and a growing MultiEdit that must exit 2. |
| 13 | `restricted`, `sources` and status's `foreign` were never read | **FIXED.** `--memory-guard status` prints a `source:` line per restricting file; status no longer returns `foreign` (the reason names it, and the planner reads its own list). |
| 14 | The packaged revision was re-read on every status call | **FIXED.** Read once per process; a failed read is not kept. |
| 15 | An Edit that Claude Code matches only after normalising reads as not found and passes | **ACCEPTED-RECORDED (fail open).** The rule cannot be stated: Claude Code 2.1.293's Edit is compiled bytecode, and its error text shows at least one more normalisation ("Edit also tried swapping \uXXXX escapes and their characters"). A guessed rule could refuse an edit Claude Code applies differently; letting an unreproducible edit through is the guard's stated design. |
| 16 | A user's wrapper around our copy read as ours, so `on` replaced it and `off` deleted it | **FIXED.** Ours is a node and our copy and nothing else; anything else is foreign. |
| 17 | Docs | **FIXED.** README and extension README. |

**The probe, measured (2026-10-20, Claude Code 2.1.293). The box's policy has not changed.** It
still restricts user hooks. With the real home and environment, launched through
src/exec-resolve.js as the product launches it, `claude -p "/goal x"`, the inert goal alone, and
the goal with `--no-session-persistence` or with `--tools ""` each answered "/goal can't run while
hooks are restricted" (also on 2.1.301). The CLI probe as it now ships, run once from the fix
branch with no `HOME` or `USERPROFILE` override, printed "restricted" in 4.3 s.

**Two hazards give a false "not restricted", for anyone running the probe:**

- *`--strict-mcp-config`.* Added to the same command, it made `/goal` RUN, so the first bounded
  probe (which passed it) printed "not restricted". A `PreToolUse` canary passed through
  `--settings` did not fire with or without the flag (its Write landed both times): user hooks
  stay blocked, and only `/goal`'s restriction check misreports. The flag is gone from
  `PROBE_ARGS`, with the evidence in a comment beside it.
- *Any environment but the user's real one.* The answer is only true of the config directory
  Claude Code reads, with its settings and cached managed settings, so the probe must inherit
  the real environment; it does (spawn is given no `env`, and a test checks the child sees the
  parent's variables). A run with `HOME`, `USERPROFILE` or `CLAUDE_CONFIG_DIR` pointed at a
  throwaway directory answers for that directory. A "not restricted" this branch reported earlier
  the same day came from a run that passed `--strict-mcp-config` and put the probe's directory
  under a throwaway home; it was false, and nothing it suggested about the box's policy holds.

Where the policy comes from is not visible locally: the box has no `managed-settings.json` in
either Windows location, no registry policy, and a `remote-settings.json` holding only
`companyAnnouncements`, so `--memory-guard status` correctly says it cannot tell and the probe is
the only local way to learn it. With `--no-session-persistence` Claude Code saves no transcript,
refusal included, but still creates one project folder for the probe's directory holding an empty
`memory/`. This box's `~/.claude/settings.json` registers the guard (copy at revision 1); under
this policy it is inert. Left for the owner: the project folder the false run created,
`~/.claude/projects/C--Users-Admin-AppData-Local-Temp-wp2-real-probe-8DyQf1--claude-wildcarding-ai-acolyte-memory-guard-probe`.

**Not fixed here, recorded.** A 1.9.0 backup taken by `off` after an `on` with no settings.json
holds the guard-installed bytes; nothing here detects or rewrites it. On POSIX the deadline ends
the child alone (endProcessTree has no group to signal without `detached`); an npm `claude` there
is one process. The open-threads module's `wildcard-perms --open-threads refresh` error string
(src/agent-open-threads.js) is another owner's and is not in the census.

## The 1.9.1 audit clearance (2026-10-20)

After 1.9.0 shipped, the maintainer asked for a full audit of main (regressions, dead code, leaks,
functions that cannot run, calls that go nowhere, optimisation, findings worth surfacing) and for
`BACKLOG.md` to be cleared to empty. Four read-only audits of `8324b6d` and `e9994db` filed 70
rows, five of them duplicates (D3, I5, F4, F5 and B1), so 65 distinct findings; B1 to B6 are the six
entries BACKLOG.md held open at 1.9.0. Four fix packages took them to dispositions on their own
branches, merged `--no-ff` into `release/1.9.1` in this order: WP4 `docs/audit-1.9.1`, WP1
`fix/threads-audit`, WP3 `fix/parity-dead-code`, WP2 `fix/guard-audit`. WP1's and WP2's tables,
with their reasoning, are the two sections above; WP3's and WP4's dispositions are recorded only
here and in their commit messages. Each FIXED row names a commit whose message carries the
mutation that made its test fail.

| id | Finding | Disposition |
|---|---|---|
| R1 [MED] | Turn off open threads cannot turn it off unless settled; can install instead | **FIXED** WP1 1fa38b7 (off always, Refresh separate; 2 mutations) |
| R2 [LOW] | scheduled threads compile runs after switch-off | **FIXED** WP1 1a8137e (timer re-checks setting; off cancels; 2 mutations) |
| R3 [LOW] | toggleOpenThreads ignores the compile result | **FIXED** WP1 de4d94c (result kept, message says last compile installed) |
| R4 [LOW] | guard message/modal/README: "already past", "always pass" false; comment advice wrong | **FIXED** WP2 b27dce8 (ends past budget and worse; comment advice; BUDGETS in modal; GUARD_REVISION 2) |
| R5 [LOW] | node gone: card says turn on again, button turns off | **FIXED** WP2 fba86d8 (node gone -> needs repair, Repair button) |
| R6 [LOW] | smoke regex lowercase vs uppercased CLI label | **FIXED** WP2 f64b98b (uppercase labels; test reads smoke.sh pattern) |
| R7 [LOW] | JS/Python parity drift (entries split, interior CR) | **FIXED** WP3 c4fd8b9 (entries over \r?\n; CR stripped; parity bodies; 4 mutations) |
| R8 [NOTE] | stale comments: memoryLint _FENCE refs, gatesCorpusWatchers comment | **FIXED** WP3 41d1c35 + WP1 dcb7be4 (comments) |
| R9 [NOTE] | memory lint off hides guard/threads controls | **ACCEPTED-RECORDED** WP1 b90437b (documented: palette command and setting still reach it) |
| R10 [NOTE] | --memory-guard status exit 0 on unsupported | **FIXED** WP2 88b19ed (exit 1 for unsupported) |
| L1 [MED] | memoryReport() for .dir on hot paths | **FIXED** WP1 1056d40 (memoryStoreDir at 5 sites; 0 reports over 20 events; 3 mutations) |
| L2 [MED] | threads compile execFile on host thread, outside the spawn gate | **FIXED** WP1 932e82b (threads compile off-thread; compileGates left on host: harness reasons) |
| L3 [MED] | MEMORY.md-triggered compile cannot change anything while healthy | **FIXED** WP1 34a347c (MEMORY.md events gated by indexEventMayChange; 3 mutations) |
| L4 [LOW] | every window compiles every burst | **ACCEPTED-RECORDED** (integrator's decision, in the owner's review table): an mtime skip can lose an edit, and after L5 and L10 each window's compile runs off the host thread and at most one writes; reasoned under "Open threads after 1.9.0", finding 11 |
| L5 [LOW] | overlapping compiles, older wins | **FIXED** WP1 01ac35f (one in flight, one queued; 2 mutations) |
| L6 [LOW] | watchers lost across overlapping re-activate | **FIXED** WP1 22b98c2 (activate disposes before build; stale disposer no-op; 2 mutations) |
| L7 [LOW] | rule-usage hashes allow list twice per push | **DECLINED-MEASURED** WP3 95cd0ea (1.89 min / 3.16 p50 ms warm n=30, record names the cold measure that would reopen) |
| L8 [NOTE] | per-push status reads; revisionOf(PACKAGED_GUARD) once | **FIXED** WP2 02b03b4 (packaged revision read once) |
| L9 [NOTE] | record row "fullReport re-reads" has stale numbers | **ACCEPTED-RECORDED** WP3 9b4197b (dated note with warm figures, conclusion kept, cold re-measure named) |
| L10 [NOTE] | recall.py rewrites unchanged compiled file | **FIXED** WP1 3018410 (identical compile writes nothing; file id and mtime unchanged) |
| L11 [NOTE] | spawn gate wall clock | **FIXED** WP3 65d3dd5 (process.hrtime.bigint; stepped-clock takeover test) |
| D1 [LOW] | extension README "all 19 settings" (20) | **FIXED** WP4 611ea36 (20 settings; readme-settings test, 7 mutations) |
| D2 [LOW] | release notes "timed out after 30 s" (probe timer 5 s) | **FIXED**: the v1.9.0 notes replaced 2026-10-20 with WP4's corrected body ("the probe's own 5 s timer"), its guard sentences in WP2's wording |
| D3 [LOW] | "shrinking edits always pass" false (dup of R4) | **FIXED** WP2 b27dce8 (= R4) |
| D4 [MED] | README exit-2 path / "one short turn" never observed | **FIXED** WP2 9aa78dc + f6160d9 (observed/not-observed statement; real-home restricted measurements) |
| D5 [LOW] | allowManagedHooksOnly claim has no artefact; "any event" overgeneralised | **FIXED** WP4 771aa9e (scripts/probe-user-hooks.js + test, 8 mutations; claims narrowed to 3 events; run once 2026-10-20: 6/6 not fired) |
| D6 [LOW] | stale record statements (3255, 3435, 3140) | **FIXED** WP4 4b93947 (dated superseded notes) |
| D7 [LOW] | TREE_ENDING counted as a product race | **FIXED** WP4 97cebb1 + integrator 0e6059e (one race; notes edited) |
| D8 [NOTE] | README §6 "(<memory file>)", "by name" | **FIXED** WP1 b90437b |
| D9 [NOTE] | README node fallback %ProgramFiles%\nodejs | **FIXED** WP2 9aa78dc |
| D10 [LOW] | backup when settings.json absent at first on | **FIXED** WP2 2ebf9c8 (absent marker; no later snapshot) |
| D11 [LOW] | release notes "one-line status block", "until a memory declares a status" | **FIXED**: the same edit (the block may span lines and is collapsed and cut at 240 characters; a closed status installs nothing) |
| D12 [NOTE] | ext README lineBudget wording; label list omits unreadable | **FIXED** WP4 611ea36 (lineBudget) + WP2 9aa78dc (label list) |
| D13 [NOTE] | a comment in memoryLint.js cited a range of recall.py that had drifted off GATE_BEGIN | **FIXED** WP3 41d1c35 (the citation repointed, anchored on GATE_BEGIN) |
| D14 [LOW] | parity test skips recall.py half on CI; entries diverge | **FIXED** WP3 c4fd8b9 (parity step in gates-manage CI job, ACOLYTE_REQUIRE_PYTHON=1) |
| S1 [MED] | probe fixed dir in shared tmp | **FIXED** WP2 a92dbd6 (<config>/wildcarding, non-recursive, refusal on planted dir) + integrator 36a66ed (same for probe-user-hooks.js) |
| S2 [LOW-MED] | probe unbounded run; npm claude.cmd child survives | **FIXED** WP2 897cc9d + f6160d9 (--tools "" --no-session-persistence, npmShimLaunch, deadline tree kill; --strict-mcp-config removed: it made /goal misreport) |
| S3 [LOW] | probe false "not restricted" | **FIXED** WP2 8ad2bfe (positive evidence required) |
| S4 [NOTE] | Windows basename case; 8.3/ADS/UNC/junction fail open | **FIXED**/ACCEPTED WP2 abf0b10 (win32 case + trailing dot/space folded, GUARD_REVISION 3; 8.3/ADS/UNC/junction fail open, recorded) |
| S5 [LOW] | control/bidi chars survive in thread text/stem | **FIXED** WP1 3018410 (C0/C1/DEL/bidi stripped in text, stem, INDEX path; 4 mutations) |
| S6 [MED] | INDEX line names no file | **FIXED** WP1 3018410 (INDEX line names the index, home-relative) |
| S7 [none] | Auto Learn tighten-only: no bypass (verified negative) | **CLOSED-VERIFIED** (auditor) |
| S8 [NOTE] | wrapper around our copy counted as ours | **FIXED** WP2 4a0c73a (ours = node + our copy only; wrapper is foreign) |
| I1 [LOW] | MultiEdit test cannot fail | **FIXED** WP2 8ff4ae5 (unique old_strings; growing MultiEdit exits 2) |
| I2 [LOW] | CLAUDE_CONFIG_DIR half-supported | **FIXED** WP2 c9dfd65 (configDirFor: settings, copy, backup, remote-settings follow CLAUDE_CONFIG_DIR) |
| I3 [NOTE] | open threads on by default, not said in README | **FIXED** WP1 b90437b (README: on by default) |
| I4 [NOTE] | prose --> refused (deliberate) | **ACCEPTED-RECORDED** (record ~3279-3280, D's decision) |
| I5 [LOW] | probe CLI-only (dup of F3) | **FIXED** WP2 e24489f (= F3) |
| I6 [NOTE] | spawn-timing harness not in tree | **FIXED** WP4 bf74856 (scripts/measure/ capture, summary, two observation experiments; test, 7 mutations) |
| F1 [MED] | hookEventAllowed dead + disproved; docs hookBlocked | **FIXED** WP3 b246622 (removed with fields, test, TEST_ONLY; docs to measured rule) |
| F2 [LOW] | assessPolicy().capabilities dead | **FIXED** WP3 929a86a (removed) |
| F3 [MED] | VSIX UI names CLI verbs it does not ship | **FIXED** WP2 e24489f (palette command probeUserHooks; extension policy line; census test) + WP1 1fa38b7 (threads refreshHint) |
| F4 [LOW] | smoke regex (dup of R6) | **FIXED** WP2 f64b98b (= R6) |
| F5 [LOW] | measures differ (dup of R7) | **FIXED** WP3 c4fd8b9 (= R7) |
| F6 [LOW] | budgets restated (INDEX_BUDGETS, modal) | **FIXED** WP3 a963752 (INDEX_BUDGETS from GUARD_BUDGETS) + WP2 b27dce8 (modal from BUDGETS) |
| F7 [NOTE] | hookPolicy fields/foreign unread | **FIXED** WP2 b72ece2 (status prints source: lines; foreign field dropped) |
| F8 [NOTE] | duplicate fence helpers | **FIXED** WP3 0f184a6 (helpers named for their rule and twin; memory-index-guard.js left as is to avoid a revision bump) |
| F9 [LOW] | dead CSS .listhead | **FIXED** WP3 d1a60ce (removed; CSS census) |
| F10 [NOTE] | stale prose (record 3254, dead-exports comment) | **FIXED** WP4 4b93947 (record) + WP3 41d1c35 (dead-exports comment) |
| F11 [NOTE] | recall.py mixed refusal omits --json etc.; --gates/--open-threads ignore extra args | **FIXED** WP3 944e617 (recall.py: a query's flags refused beside a mode that runs alone) + integrator b458ed1 (`--gates` (on, off, status, refresh) and `--open-threads` refuse an extra argument; 2 mutations) |
| G1 | dead-exports TEST_ONLY needs reasons | **FIXED** WP3 ae73398 ({name: reason} map; blank reason fails) |
| G2 | routes census sender->arm; panelScript slice | **FIXED** WP3 418d826 (own script slice; sender -> arm) |
| G3 | weak line-ref anchors | **FIXED** WP3 2d540af (weak-anchor report on every run) |
| G4 | parity fixtures lack lone CR/U+2028/\f; INDEX_BUDGETS/modal unpinned | **FIXED** WP3 c4fd8b9 + a963752 + WP2 b27dce8 |
| B1 (BACKLOG) | hookEventAllowed per-event | **FIXED** WP3 b246622 (= F1) |
| B2 (BACKLOG) | README command count unpinned | **FIXED** 62b7f05 (test + 2 mutations) |
| B3 (BACKLOG) | editor gauge no entry-count rule | **FIXED** WP3 01bdff3 (gauge 16-entry ceiling, diagnostic, 4 mutations) |
| B4 (BACKLOG) | release-version.test.js failed once under masked full run | **DECLINED-MEASURED**: 50 runs in a row, 850 tests, 0 failures (2026-10-20, no load); diagnostic + control test 1f9a14f (mutation fired) |
| B5 (BACKLOG) | synthetic click on Claude memory row head did not land | **DECLINED-MEASURED**: probe 4/4 moves, head point (141,360) vs Auto Learn (190,362), in-frame hit matches, hovered false: harness coordinate model after scrollIntoView; card verified via DOM (38483a7); rebuilding the coordinate model is out of proportion |
| B6 (BACKLOG) | guard does not replay quote normalisation | **ACCEPTED-RECORDED** WP2 (fail open; Claude Code's normalisation is not statable from its bytecode) |

**Found by the integrator while releasing, all closed:**

| Item | Disposition |
|---|---|
| CI's Node 20 and 22 jobs cancelled 16 tests (run 39413648790, on all four of them) where Node 24 and the development box passed | **FIXED**, `dd8543c`. `threadsWindow` in `test/extension-open-threads.test.js` unrefs every real timer its `setTimeout` stub passes through, and one test waited 600 ms through it. With nothing else holding the loop, Node 20 and 22 ended the file with that promise pending ("Promise resolution is still pending but the event loop has already resolved") and cancelled it and the 15 tests after it; each job read fail 0, cancelled 16. The wait now uses `node:timers/promises`. There is no Node 20 or 22 on this box, so the re-run on that commit (39414614295, 8 of 8) was the check. |
| `drive-installed.js` still drove the 1.9.0 toggle and failed 16 of 17 against the installed 1.9.1 | **FIXED**, `a5d0be9`. It drives the card's Refresh, then off, on and off. Mutation: Refresh made a no-op in a copy of the installed extension (`--subject`) failed exactly that check, "refresh: nothing was compiled". |
| WP3's residual: `--gates-compile` had no refusal list, so `--gates-compile --json` or `--rebuild` was dropped in silence | **FIXED**, `b458ed1`. It runs alone, `--gates-allow-empty` aside, and `--gates-allow-empty` without it is refused. Every caller in the tree sends one of those two shapes. Two mutations, each failing `test/gates-manage.sh` on its own line. |
| WP2's residual: a 1.9.0 backup taken by `off` after an `on` with no settings.json holds the guard-installed bytes | **ACCEPTED-RECORDED** (integrator's decision, in the owner's review table). It needs that exact sequence on 1.9.0, which was the latest release for about two hours and has one known install, this box, whose settings.json existed. The product only writes that backup (`src/memory-guard-install.js`, `backupPathFor`) and never reads it; it is there for a restore by hand. |
| WP2's residual: on POSIX the probe's deadline ends the child alone | **ACCEPTED-RECORDED**, the class already recorded for the execFile sites ("execFile's own `timeout` orphaned the program under a launcher", POSIX): no process group without `detached`, and an npm `claude` there is one process. |
| The palette probe through a `claude.cmd` that is not npm's shape can outlive a host that dies outright | **ACCEPTED-RECORDED**, the class recorded under "On Windows an npm `codex.cmd` outlived an extension host that died outright": a native `claude.exe` and npm's shim (run as `node <script>` by `npmShimLaunch`) are the host's direct children and die with it; only cmd.exe's grandchild can break away, and only when the host dies rather than deactivates, inside the probe's 60 s. **Corrected 2026-10-20 (fix/scripts-docs-192): the premise is false.** Claude Code's own npm install is that shape. Its package's `bin` is `bin/claude.exe` (2.1.293 on the development box), so npm writes cmd-shim's direct-exe `claude.cmd`, which starts `claude.exe` itself and which `npmShimLaunch` does not read: on an npm install the probe always runs as cmd.exe with claude.exe under it. On a timeout the deadline's `endProcessTree` (taskkill /T) ends that whole tree. Deactivate does not reach it: the palette's `memoryGuardProbe` child is never handed to `trackChild`, so deactivate's reaping does not see it (read from the code, not measured). A deactivate that leaves the host running still has the deadline; a host that exits while the probe runs (a window reload or close as much as a crash) ends cmd.exe through libuv's job and leaves claude.exe, which the job lets break away. What bounds that claude.exe is its own run: a refusal in seconds where hooks are restricted (4.3 s measured), else one turn with no built-in tools on an inert goal. The label stays as the integrator decided it, but that decision rested on a deactivate ending the tree, so it is the integrator's to re-confirm; handing the probe's child to `trackChild` would close the reload half. **Re-confirmed 2026-10-20 by the integrator, after the merge of fix/guard-probe-192:** that branch's `ed95579` hands the palette probe's child to `trackChild`, so on Windows a deactivate (a reload, a window close, a disable or an update) tree-kills cmd.exe and the claude.exe under it, and the 2 s close grace after the deadline settles the probe even when a held pipe keeps 'close' from coming. Only a host that dies outright while the probe runs leaves claude.exe, and the label stands for that case alone. |

**Claude Code's own check on unusual Windows path spellings (added 2026-10-20, fix/scripts-docs-192).**
Claude Code 2.1.293 requires manual approval before it writes a path that carries an 8.3 short-name
`~digit`, a `\\?\` or `\\.\` prefix, an alternate-data-stream colon, trailing dots or spaces,
or a UNC or WebDAV form: its `fEt()` checks, each with `classifierApprovable` false, so the auto-mode
classifier cannot approve one either. The strings were read from the installed `claude.exe` 2.1.293
by the pass-2 audit, and that is what is known: no session has been seen to prompt on one, no other
version was read, and whether a permission mode skips the ask is not known. It is why the guard's
fail-open spellings ("The MEMORY.md guard audit", finding 11: 8.3 names, `::$DATA` streams, `\\?\`
and UNC) are covered upstream for that client version: a Write to the index through one of them
reaches the user as a prompt, not in silence. Junction targets are not among them and stay uncovered.
A client that drops or changes those checks reopens finding 11.

**Evidence for the release.** The tag `v1.9.1` is at `8aab0ed`, the `--no-ff` merge of
`release/1.9.1`. The full battery at `b458ed1`: 2028 tests, 2022 pass, 0 fail, 0 cancelled, 6
skipped (the masked view 2004 pass, 0 fail, 24 skipped); smoke 18 of 18; `recall-py.sh`,
`gates-manage.sh`, `gates-stale.sh` and `threads-compile.sh` ALL PASS; 304 of 304 line references
anchored. CI 8 of 8 on `b458ed1` (run 39416456795) and on the merge (39416832500); the Python job's
`memory-guard-parity` step ran 4 tests with none skipped under `ACOLYTE_REQUIRE_PYTHON=1`. The
published `ai-acolyte-v191.vsix` (release.yml run 39416884826) matches the local build in all 66
entries apart from line endings. Against the installed 1.9.1 (VS Code 1.142.0): `drive-installed.js`
17 of 17, `drive-vscode.js` 4 of 4, 6 of 6 with `--review-runtime yes --dashboard-ui yes`, and 6 of
6 with `--mcp-only yes --review-runtime yes`. Not run: `scripts/verify-release.ps1`, which is
written for after a VS Code reload, and a reload would have ended the agent session cutting the
release; it is the owner's step at the next reload.

**Two measurement hazards from this release, for anyone repeating it:**

- *A bare `bash` from Python is WSL's on this box.* A mutation runner that called
  `subprocess.run(["bash", ...])` got `C:\Windows\System32\bash.exe`, which failed to start
  (`execvpe(/bin/bash) failed`) and exited 1, so two mutants read as killed without the harness
  running. Caught because the failing line named WSL; the rerun names Git Bash by full path.
- *The development box runs Node 24 only.* A test that passes here can be cancelled on Node 20 or
  22 when it waits on an unref'd timer, so CI's older runtimes are the only check of that class.

## The 1.9.2 audit clearance: the second pass (2026-10-20)

The maintainer's instruction was to audit again after each release and to keep going until a pass
finds nothing new. The second pass audited what 1.9.1 changed (`e9994db..8aab0ed`, 58 files) with
three read-only lenses: regressions, functions that cannot run and calls that go nowhere; leaks,
dead code and optimisation; documentation claims, security and findings worth surfacing. It filed
22 distinct findings, one of them MED and none HIGH. Four fix packages took them to dispositions on
their own branches, merged `--no-ff` into `release/1.9.2` in this order: WP-B `fix/threads-192`, WP-C
`fix/cli-strip-192`, WP-A `fix/guard-probe-192`, WP-D `fix/scripts-docs-192`. Each FIXED row names
the commit whose message carries the mutation that made its test fail; each package's runner
restored every mutated file and checked it by sha256.

| id | Finding | Disposition |
|---|---|---|
| S1 [MED] | README 1.9.1 paragraph and both release notes said 1.9.0's probe passed --strict-mcp-config; no release did (the flag lived 26 minutes inside fix/guard-audit); 1.9.0's real false "not restricted" was any exit 0 | **FIXED**: both GitHub release bodies corrected 2026-10-20 (integrator) and README.md's 1.9.1 paragraph in WP-D bac4379; the true fix is "any exit 0 read as allowed" (src/memory-guard-install.js, the positive-evidence check) |
| S2 [LOW] | guard folds `MEMORY.md.` / trailing space to the index, then reads the literal name (ENOENT): a compacting Write blocked, a growing Edit allowed | **FIXED** WP-A cc78a6b (case fold only, GUARD_REVISION 4; the fold restored failed 2 tests incl. "a trailing-dot or trailing-space spelling of the index fails open") |
| S3 [LOW] | probe-user-hooks.js base moved under `.claude/`, a sensitive path to Claude Code, so its Write cases likely stop landing | **FIXED** WP-D d4b410a (per-user state base, no .claude segment, AI_ACOLYTE_PROBE_BASE override; 3 mutations) |
| S4 [LOW] | npmShimLaunch never matches Claude Code's own npm shim (direct-exe template), so the probe always runs through cmd.exe; the record's accepted row rests on a false premise | **ACCEPTED-RECORDED** (integrator's decision, in the owner's review table): npmShimLaunch is not taught the direct-exe template, which would change the Codex launch paths too; the record row's premise corrected (WP-D 4b4f4c9) and re-confirmed (93af048) after WP-A's trackChild fix |
| S5 [LOW] | README: probe dir "used only when it is empty and yours": the owner check is POSIX-only | **FIXED** WP-A 3d605e9 (README: the owner check exists only where process.getuid does) |
| S6 [LOW] | README: "a 60 second deadline that ends the whole process tree": Windows only | **FIXED** WP-A 3d605e9 (README: the whole tree on Windows, the child alone on POSIX) |
| S7 [NOTE] | --guidance refuses no extra arguments and wins dispatch first (= R2) | **FIXED** WP-C 27c20ed (= R2; --guidance on, off and status refuse stray words) |
| S8 [NOTE] | _THREAD_STRIP keeps invisible format characters (soft hyphen, zero-width, word joiners, BOM, tag block) | **FIXED** WP-C 119a946 + 58cdc21 (both twins; strip and kept axes in test/threads-compile.sh; 9 mutations) |
| S9 [NOTE] | Claude Code 2.1.293 already asks a person before writing the guard's fail-open spellings: record it with the client version | **FIXED** WP-D 4b4f4c9 (dated record note: Claude Code 2.1.293's own manual-approval checks, read from its binary; junction targets stay uncovered) |
| L1 [LOW] | palette probe child never reaches trackChild, so deactivate cannot end it (= R7) | **FIXED** WP-A ed95579 (options.track; 2 mutations, "deactivate ends a ... probe that is still running") |
| L2 [LOW] | a compile queued behind a running one still spawns after the switch goes off (= R5) | **FIXED** WP-B d0715ba (spawnThreadsCompile asks the switch; mutation failed "the queued compile spawned nothing after the switch went off") |
| L2b [LOW] | refreshOpenThreads installs after its compile without re-checking the switch: a queued Refresh installs the block while off (found by WP-B) | **FIXED** WP-B d0715ba (refreshOpenThreads re-checks the switch after its compile; mutation failed "the Refresh that waited on it installed nothing") |
| L3 [LOW] | probe-user-hooks.js runs claude with spawnSync+timeout through cmd.exe: orphan, then the next run's rmSync crashes | **FIXED** WP-D 48b3217 + 1716d30 (async run, tree-kill deadline, 2 s grace that also releases the pipes, exit 3 for a busy directory; 6 mutations) |
| L4 [LOW] | no DevToolbox venv: every MEMORY.md burst logs "venv not found" forever (indexEventMayChange true while nothing is compiled) | **FIXED** WP-B 821312f (threadsCompileTools: nothing armed or spawned without the toolbox, the reason logged once per activation; 12 mutations with R3) |
| L5 [NOTE] | extension.js memoryStoreDir fallback serves only stale test stubs | **FIXED** WP-B 01b82e8 (the fallback removed; 23 stubs export memoryStoreDir; test/memory-lint-stubs.test.js census; 3 mutations) |
| L6 [NOTE] | probeUserHooks refreshes the dashboard for nothing | **FIXED** WP-A 24d94f6 (refresh dropped; mutation failed "the hooks probe pushes nothing to the dashboard") |
| L7 [NOTE] | taskkill-tree-order.js: unbounded pid-file wait, temp dir left on failure | **FIXED** WP-D 9e05f21 (LEAF_WAIT_MS deadline, try/finally; 2 mutations) |
| R1 [LOW] | Repair is a dead end when a foreign guard command sits beside ours with its node gone | **FIXED** WP-A fc1501f (no Repair beside a foreign guard; 2 mutations) |
| R2 [LOW] | only --gates/--open-threads/--memory-guard refuse extras; a second verb after --guidance, --seed, --learn or --drain is dropped | **FIXED** WP-C 27c20ed (one verb per run, exit 2 naming them; no legitimate two-verb caller in the tree; 2 mutations) |
| R3 [LOW] | "Refresh open threads" stays forever with an unreadable target or with no venv | **FIXED** WP-B 821312f (Refresh needs a compile that can run, and judges readable targets only; the card names a skipped file) |
| R4 [LOW] | the probe settles only on 'close': a held pipe hangs it, probingUserHooks stays true, the CLI hangs | **FIXED** WP-A 6521912 + 9fb4256 (settles 2 s after the deadline and destroys its pipe ends; 2 mutations) |
| R6 [NOTE] | recall.py --selftest, --list, --rebuild (no query) drop query flags; --list and --selftest drop a query | **FIXED** WP-C a0c6ffd (--selftest, --list and a bare --rebuild refuse what they would drop; 4 mutations) |

**The MED finding was the integrator's own.** The 1.9.1 README paragraph, its release notes and the
correction added to the 1.9.0 notes all said 1.9.0's probe passed `--strict-mcp-config`. None did:
v1.9.0 ran `claude -p "/goal probe"` and read any exit 0 as "not restricted" (finding S3 of the first
pass). The flag existed only inside `fix/guard-audit`, added in `897cc9d` and removed in `f6160d9`
26 minutes later. The integrator wrote the sentence from that branch's history without checking it
against the tag. Both GitHub release bodies were corrected the day the audit found it, and the README
in WP-D's `bac4379`.

**Evidence for the release.** The tag `v1.9.2` is at `c362e77`, the `--no-ff` merge of
`release/1.9.2`. The full battery on the integration (`93af048`): 2048 tests, 2042 pass, 0 fail, 0
cancelled, 6 skipped (the masked view 2024 pass, 0 fail, 24 skipped); smoke 18 of 18;
`recall-py.sh`, `gates-manage.sh`, `gates-stale.sh` and `threads-compile.sh` ALL PASS; 307 of 307
line references anchored. CI 8 of 8 on the integration (run 39433523576), on the release commit
`cb93d3b` (39433997268) and on the merge (39434463316). The published `ai-acolyte-v192.vsix`
(release.yml run 39434481542) matches the local build in all 66 entries apart from line endings.
Against the installed 1.9.2 (VS Code 1.142.0): `drive-installed.js` 17 of 17, its guard check
running the packaged copy at revision 4, and `drive-vscode.js` 4 of 4, 6 of 6 with
`--review-runtime yes --dashboard-ui yes`, and 6 of 6 with `--mcp-only yes --review-runtime yes`.
`scripts/verify-release.ps1` waits for the owner's next VS Code reload, as for 1.9.1.

**Merging.** Every conflict between the packages was in line-number digits (nine hunks in all, across two merges),
taken from the integration side and then repointed by `fix-refs-after-merge.sh`, which traces each
move through the merge's diff and refuses anything that is not digits-only. WP-A could not edit this
file, so ten of its references here were broken on its branch; the repoint after its merge fixed
them with the rest (17 fixed, 0 ambiguous).

**Seeds for the third pass,** noticed by the fix packages outside their briefs: gate names printed
to a terminal pass invisible format characters (`UNSAFE_FOR_TERMINAL` in `src/gates-manage.js`, and
a twin in extension.js without the tag block); variation selectors are kept in thread text; five
verbs still ignore a stray word (`--bypass on extra` and similar); the child-process census reads
extension.js only, so a spawn in `src/` is listed by no test; the probe's confirmation says "60 s at
most" where the answer can come about 62 s after the start; a stray process in the probe's
directory makes its cleanup fail in silence.
