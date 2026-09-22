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

### NEXT SESSION (queued 2026-09-21): do desktop-ai-companion's optimisation learnings transfer here?

Asked directly by the owner after an optimisation pass on `desktop-ai-companion`'s AgentFlow
module. A first measurement was taken the same evening so tomorrow starts from numbers instead of
from a hypothesis.

**Baseline, MEASURED 2026-09-21, one run per fresh process, on the toolbox interpreter:**

| What | Time |
|---|---|
| `recall.py "<query>" -k 3`, end to end | **1.27 / 1.10 / 1.07 s** |
| Bare interpreter start (`python -c pass`) | 0.08 / 0.06 / 0.06 s |
| `import numpy, onnxruntime` | 0.37 / 0.35 / 0.36 s |
| Live memory corpus | **133** `.md` files at `~/.claude/projects/d---ai-work/memory` |

So roughly **1.0 s of fixed cost per invocation**, of which the interpreter is 0.06 s and
numpy+onnxruntime is about 0.30 s. **That leaves ~0.7 s unaccounted for and it is the whole
target**: candidates are the ONNX model load, the vocab read at `memory/recall.py:241`, embedding
the query, and BM25 over 133 files. Break that down FIRST; do not optimise any of it on a hunch.

**The learning that transfers is a rule about which measurement to take, not a technique.** Match
the measurement to the process lifecycle:

- AgentFlow polls forever in one process, so **warm** is its steady state. Cold figures overstated
  it by 55% (31 ms cold against 19 ms warm for identical code), and per-item work was worth fixing:
  one syscall per file instead of two took the directory sweep from 18.3-20.9 ms to 11.0-12.6 ms.
- `recall.py` is a **fresh process every invocation**, so **cold IS its steady state**. A warm loop
  would flatter it and measure something that never happens in production.

**The technique does NOT transfer, and that is the point of writing this down.** `recall.py:393`
does `os.listdir` then `os.stat` per file, which is the exact two-syscalls-to-one pattern that just
paid 1.7x in AgentFlow, and `os.scandir` caches stat data the same way .NET's `FileInfo` does. **Do
not do it.** 133 stats against a 1.0 s fixed cost is invisible. A technique that has just worked
somewhere else is the most seductive wrong answer available, and this one has a name and a measured
refutation attached before anyone spends an afternoon on it.

**Non-performance shapes from the same session that are worth an hour here**, because this repo has
the same failure modes on record:

- **Unreachable code behind a shipped claim.** AgentFlow's Notify-mode screen watch could not run
  from the day it shipped, because a value the caller computed was only ever non-default in the
  other mode. Neither a green suite nor a live smoke test found it. Ask of the gate compiler and the
  extension watcher: *what input reaches this branch?* `MEMORY.md`'s own gate-count line has been
  wrong three times, which is the same shape.
- **An assertion made vacuous by a refactor.** Making a predicate pure meant its test injected the
  value that used to be read, so the test would have passed even if no real mode ever supplied
  `true`. Worth grepping this repo's tests for arguments that only ever arrive as literals.
- **A guard that looks like ceremony.** A 250 ms socket timeout looked pointless because a closed
  loopback port "obviously" refuses instantly. It takes **2,063 ms**. Measure what a guard guards
  before deleting it. See `docs/engineering-record.md` for the local equivalents.

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

### Smaller measured perf items, none urgent

- `src/policy-guard.js:117` — `missingFromLive`'s cover fallback is quadratic
  when backup entries are not present verbatim in live, which its own comment
  calls "the normal state". 0.13 ms today because the Set fast path hits;
  **15.5 ms** measured with no verbatim hits. Same prefix-index fix.
- The drain path in `bin/wildcard-perms` reads settings.json 4 times and runs
  processAllowList twice per drain.
- `src/policy-exporters.js:537` (also 476, 677) — `new RegExp` inside a nested
  loop; five hoistable constants. Codex-validator path only.
- `src/managed-policy.js:164/184/185` — `[...deny, ...ask]` spread twice per
  assessed permission, and `coversPrefix:69` re-lowercases both sides of every
  token comparison when the rule side could be lowered once at rulePrefix time.
  4.48 to 2.36 ms per 285 candidates against 300 rules. Managed boxes only.

The five things checked here and found NOT worth doing moved to
`docs/engineering-record.md` on 2026-09-14, under "Optimizations measured and DECLINED".
They were conclusions sitting in a queue, which is how a settled decision gets
re-litigated by someone who sees an unticked box.

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


### The two drain paths disagree about what "the project" is

Found 2026-09-16 while answering why the Project-local card reads zero. Not a bug: the
hook covers what the card misses. It is a UI blind spot, which is the class where a
control reports on something other than what is actually running.

The extension drains exactly one file. `const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath`
at `vscode-extension/extension.js:908` takes the FIRST workspace folder, and
`return path.join(workspaceRoot, LOCAL_RELATIVE);` at `src/local-settings.js:44` is a
single join with no recursion.

The CLI drains a different one. `const cwd = hookCwd(input);` at `bin/wildcard-perms:331`
takes the Claude Code session's own directory, and `:332-333` tests
`<cwd>/.claude/settings.local.json` on every tool call.

So with the editor open at a parent directory and sessions running inside
`projects/<name>`, a project-local file is drained by the hook and is invisible to the
card. The card can read "drained" while a subproject has an undrained file. Nothing is
lost, but the number on screen is not answering the question a reader thinks it is.

Worth knowing before trusting that card as a diagnostic. The honest fixes are either to
make the card name the path it actually watched, or to have it discover local files
beneath the workspace root rather than only at it. Measured on this box the same day:
exactly one `settings.local.json` exists anywhere under the working root, it is empty,
and its mtime is 12 days old, so the zeros were never evidence about promotability in
the first place.

### The public-repo privacy gate is text-only, and images bypass it

Recorded 2026-09-16, not as a defect to fix but so nobody assumes coverage that is not
there. The owner has reviewed and accepted the current instance.

Everything that keeps private content out of this repo greps. The seed-pack filter, the
scans over tracked files and commits, and `test/source-encoding.test.js` all operate on
text. On 2026-09-16 commit `7f5cbf9` excluded 78 allow entries from the starter pack for
being machine-specific, naming absolute paths with drive letters, quoted executable
paths, and other projects as the disqualifying classes. Forty-four minutes later
`b8203a9` committed a screenshot that renders all three of those classes as pixels, on
the README front page. The text gate held exactly as designed; the image walked past it.

What is actually new in that image, as opposed to already public in tracked text: an
internal tool name and its build-directory layout. The project name it also shows has
been in `memory/README.md` since v1.0.0, and the username is out of scope by the owner's
decision.

No automated fix is proposed. An OCR gate on PNGs is more machinery than this earns, and
a rule saying "look at screenshots before committing them" is the kind of check nobody
runs. The useful thing is knowing the boundary: **a scan reporting a repo clean has
scanned its text.** If a future pass adds images, someone has to look at them. Structural
checks that ARE cheap and were run here: no bytes after `IEND`, so no embedded original,
and the only metadata chunk is the capture tool's name, with no EXIF, author or GPS.

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

**Re-measured 2026-09-14, and the numbers in this entry were badly out of date.** The
corpus rebuilt itself by accumulation: 660 transcripts, 732.7 MB, oldest 2026-07-10,
against the 7 files and 6 MB recorded right after the profile wipe. The memory corpus is
123 files in one store. So the loss described here is history, and the derived-state
warnings that followed it (candidates at 50, observationHashes at 352) are stale.

**The exposure is unchanged, which is why this stays open.** `~/.claude/projects` is a
plain directory, confirmed today: `(Get-Item $p).LinkType` is empty. The same event
would take the same 732.7 MB. Nothing in this repo protects it and nothing in this repo
can, because Claude Code writes both transcripts and memories under
`~/.claude/projects/<workspace>/` and that path is not configurable. `recall.py` supports
`RECALL_MEMORY_DIR`, which relocates the READER only.

**The fix this entry proposed conflicts with a recorded constraint, so do not just do
it.** It says to junction the directory to a git repo on `D:`. C: is the only SSD on this
box, and the workspace memories already record that the older "just move it to D:" advice
in the space analyses is wrong for that reason. This is 732.7 MB of actively appended
transcript on the hot path of every session, so a junction to a spinning disk trades a
durability problem for a latency one. That trade was never stated when the fix was
proposed.

**What actually needs deciding, and it is the owner's call, not an engineering one:**
whether durability here is worth either a second SSD target, or accepting slower
transcript writes, or a scheduled copy rather than a junction (which keeps the hot path
on C: and bounds the loss to one interval instead of everything). The corpus is private
and must never enter this public repo under any of those options.

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
- Two fallback branches can never run, because each is an alias of the function
  checked immediately before it and no test injects a partial mock.
  `return manager.getStatus();` at `vscode-extension/extension.js:1019` follows a
  `manager.status` check, and `src/auto-learn-manager.js:2007` exports
  `getStatus: status`. `manager.getCandidates(options)` at
  `vscode-extension/extension.js:1026` follows a `manager.listCandidates` check, and
  `src/auto-learn-manager.js:2009` exports `getCandidates: listCandidates`.
  Re-verified 2026-09-14. A correction pass read this entry as closed because it also
  named `list()`: that alias IS still exported on the same line as `getCandidates`, but
  it is not part of either fallback chain, so naming it here was the imprecision that
  made the entry look refuted.
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
- `'the hook fires once, after a successful write'` at `test/settings-write.test.js:129`
  asserts `onWrite` fires once on success; nothing asserts it does NOT fire when
  `writeAllow` throws, and nothing asserts the CLI writer has no `onWrite` — that
  "deliberate rather than dropped" question rests entirely on a comment.
- `test/extension-lifecycle-async.test.js`'s `trackChild` check is a source-text
  scan for `trackChild(execFile(`, so a correct `const c = execFile(...);
  trackChild(c);` would fail it and a `spawn()` would slip past.

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

### Smaller confirmed items, all of them in `bin/` or the extension

Re-verified 2026-09-14 against the tree. Four of the original seven are gone: the
zero-byte `policy-lock` orphan is FIXED (`honourFor` in `src/policy-lock.js`), `run()` now
reads `if (!settings || typeof settings !== 'object') return finish(input, false);` at
`bin/wildcard-perms:282` so the missing `return` is CLOSED, and the junction-breadth and
`/cygdrive` items were argued out rather than fixed (text proposed for
`docs/engineering-record.md`). What is left needs files this pass was not allowed to touch.

- **The hook accumulates stdin without a bound.** `input += chunk` at `bin/wildcard-perms:96`
  has no cap, and a PostToolUse payload carries tool output.
  A cap with a graceful "no cwd, no drain" fallback costs nothing.
- **`wildcardUnderLock` ignores `writeAllow`'s `addedAllow`.** `const added   =
  after.filter(...)` / `const removed = before.filter(...)` at `bin/wildcard-perms:382-383`
  compute the diff from this function's own pre-write snapshot, while the write it just
  made returns the real counts. That is the exact anti-pattern `src/settings-write.js:212-214`
  documents ("A caller that reports its own intent instead ends up announcing … '+299
  restored' over a file that already had them"). Only a stderr diagnostic.
- **The teardown flag can be cleared under a pending teardown.** `deactivate()`
  sets `deactivated = true`, then awaits a drain with no deadline; `activate()`
  sets it false. If VS Code's deactivate timeout expires first and a same-realm
  re-activate runs, the OLD deactivate's continuation then nulls the SUCCESSOR's
  runner without draining it. A second consequence of the recorded "no deadline"
  item. SUSPECTED — depends on VS Code await semantics not verifiable from here.

## From the 2026-09-10 optimization and correctness pass

Four phases landed (`1b41205..cd1f50c`): `managed-policy` off the hook path, the
dashboard's doubled memory report, the last three whole-object writers, and the
hook fixed-point cache. What follows is what was found and deliberately left.

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

The six items measured and DROPPED here moved to `docs/engineering-record.md` on
2026-09-14, under "Optimizations measured and DECLINED", along with the hit-path
baseline below. Each was built or profiled and rejected on the number.

**Hit path re-baselined: still 13 fs calls, nothing crept in.** `require.cache`
on a hit holds exactly 2 modules. The dominant remaining term is **not fs** — it
is the stdin round-trip at 3.78 min / 5.48 p50 ms, of which only ~1.2 ms is
stream overhead the hook controls.

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

### Three assertions in the memory suites still cannot fail for the mutation they name

Re-verified 2026-09-14. The four repairs this entry used to record are done and removed;
the 400-char frontmatter precondition it listed as "honestly labelled rather than fixed"
is now fixed too — `test/recall-py.sh:120-122` recovers `SCOPE_AT` with `grep -bo` and
fails unless the offset is `-gt 400`, so it pins the offset rather than the file size.
What remains is three source-text or fixture weaknesses in the two memory suites.

- **`test/recall-index.test.js:238-239`** — the `assert.match` whose message reads "the
  index write is no longer atomic" matches a bare `os.replace(tmp, INDEX_PATH)` anywhere in
  `recall.py`. It still passes with that statement wrapped in `if False:` or hoisted above
  the `json.dump`, because nothing in the pattern says where it sits. The assertion
  immediately above it at `test/recall-index.test.js:236` pins the `if todo or gone or
  force:` condition and the `save_index` call that must follow it in one pattern, and is
  the shape to copy. This is the exact pattern the standing gates forbid.
- **`test/recall-py.sh:206-212`, compile stability.** The fixture writes one gate file
  (`g.md`), so removing `sorted()` from the corpus walk cannot change the order the two
  compiles see, and on NTFS directory entries come back name-ordered anyway. `[ "$ONE" =
  "$TWO" ]` therefore holds for a build with no ordering guarantee at all.
- **`test/recall-py.sh:98`, `.tmp` residue.** `[ -e "$MEM/recall_index.json.tmp" ] && fail`
  also passes if `save_index` reverts to a plain in-place `json.dump`, which creates no
  temp file to leave behind. It fires only for "write tmp, forget `os.replace`", and the
  source-text pin above does not cover the other half either, so between them the atomic
  write has no assertion that fails when it stops being atomic.

### `verify-release.ps1`'s `--lint` block has no proof of life

Everything else in the Python-side list is closed; this is the residue, and it is in a file this
pass could not touch. `scripts/verify-release.ps1:277-287` runs `recall.py --lint` once and then
asks five questions of the captured text. Four are NEGATIVE (`-not ($lint -match 'over budget')`
and friends), so all four pass against empty output — a lint that crashed reads identically to a
lint that found nothing. Only `Check 'lint reports the index clean'` is positive, and it is
carrying all five.

Two things have changed under it since it was written, and both make that worse:

- **`clean:` no longer prints on this box, for corpus reasons.** `--lint` now reports three
  `type: feedback` memories with no `scope:` and two paired `<!-- gate -->` blocks with no
  `scope:` (`heredoc-eats-backslashes`, `xml-comments-reject-double-hyphen`). The one positive
  check therefore fails on a healthy tree, which is exactly how a check gets muted.
- **The verdict got stricter.** `clean:` now tests all eight findings it prints rather than five,
  so more legitimate corpus states will suppress it.

The fix is one line — assert `$lint` is non-empty and `$LASTEXITCODE` is 0 before reading it, the
pattern already used for the `--gates refresh` capture ten lines above. The script itself stays
untestable: it writes to the real `~/.claude`.

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
pruned 2000, cursors 5000, observation hashes 20000, managed hits 200).

**The obvious two-line fix is NOT safe, checked 2026-09-14.** Deleting a record whose two lists
both emptied looks free, and is not, because the empty-map state is load-bearing elsewhere. The
seeding branch `Object.keys(state.codexTargets).length === 0` at `src/auto-learn-manager.js:969`
adopts the legacy flat `state.applied.codex` into the FIRST target ever seen, and that is a
one-time migration. Evicting the last surviving record puts the map back to empty and re-arms it,
so the next target seen takes the migration path instead of starting clean. The traced outcome is
harmless today, because `:972` keeps the flat field mirrored to the current target so a re-seed
copies an empty list, but that is a property of the current mirroring rather than of the eviction,
and it is an unreasonable amount of reasoning to accept for roughly 50 bytes per abandoned target.

If it is ever worth doing, the eviction has to be paired with a separate "migration already ran"
marker so the seeding branch stops depending on the map being empty. Do not do one without the
other.

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

### What is left of the `file:line` rot, after the 2026-09-14 correction pass

The pass is done and most of this is closed. Measured rates, the checker bug it uncovered and
the rule about what a STALE verdict is worth are in `docs/engineering-record.md`; only the
residue belongs here.

`node scripts/check-line-refs.js` reports **165 references: OK 119, NEAR 16, STALE 17,
UNVERIFIABLE 13, 0 BROKEN** as of 2026-09-16, against OK 39 / STALE 60 / UNVERIFIABLE 47 before
the pass. The total moves in both directions as documentation is rewritten: the README audit
added 21 verified citations, then the README rewrite removed 671 lines of prose and some
citations with them. The OK share is the number worth reading, not the total. Re-measure before
quoting this rather than trusting it: an
earlier version of this paragraph went stale within a day.

**Not all 45 remaining non-OK rows are defects, and a future pass should not treat them as a
worklist.**
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
- **RESOLVED 2026-09-14.** The correction pass flagged entries here that looked closed by current
  code. Checked one at a time against the source, and the flag was right twice and wrong once:
  the newline-fusion and inner-END-marker halves of the managed-block entry are genuinely fixed
  (by the mid-file `separator` at `src/agent-guidance.js:180-183` and `escapeMarker` at
  `src/agent-guidance.js:108`) and were removed, leaving only the concurrency half; the
  `grantedBy` perf bullet is closed by `grantedByIndex` at `src/local-settings.js:84` and was
  removed; but the `manager.getStatus()` fallback entry is STILL OPEN, and was flagged closed
  only because it also named an alias that is not part of the fallback chain. Trusting the flag
  would have deleted a live finding.
- **One bullet is refuted, not stale.** It claimed `bin/wildcard-perms` had no `return` on a
  `finish()` call. Line 282 now reads
  `if (!settings || typeof settings !== 'object') return finish(input, false);`.

### The release workflow's node24 bump is unverified until a release runs

The test matrix half of this is CLOSED: run 34935429588 is green on all five jobs with zero
deprecation annotations, against the run before it where all five carried one.

What is left is a verification gap, not a defect. `release.yml` runs only on a release, so its
two bumps, `actions/upload-artifact@v6` and `softprops/action-gh-release@v3`, have never
executed. That is also why the deprecation was invisible there: the annotation the test matrix
raised never mentioned those two, because that workflow had not run. Nothing to do until the next
release; check that run rather than assuming it.

Worth keeping because the original entry got the fix wrong in a way that would have looked done.
It said "bump both to `@v5`". Checking each action's `action.yml` at each major shows the first
node24 major is not the same for all of them: `actions/upload-artifact@v5` is STILL node20, so a
uniform `@v5` would have left one action on the deprecated runtime while the annotation went
quiet. The pins that actually clear it are checkout v5, setup-node v5, upload-artifact v6 and
gh-release v3.

### Optimization proposals, each with the measurement that would settle it

No numbers asserted. This repo's rule is that a figure is real only when measured cold, in fresh
interleaved processes, against a purpose-built variant with the change removed.

**The `numpy` matmul at `memory/recall.py:636-642`** replaced a Python dot product per document. Its
own comment says "Immaterial for one CLI query, real across a bench run", which is the honest
framing. To settle: run `memory/bench/gate_recall.py` cold in fresh interleaved processes against a
variant with the matmul reverted, over the 24-question set, and report the per-query MEDIAN. The
~620 ms ONNX session dominates the total and would swamp the signal.

**`counts = Counter(terms)` at `memory/recall.py:497-499`** is almost certainly unmeasurable end to end on a 123-file
corpus. What would prove otherwise: `_lex_index` alone, timed in fresh processes over a synthetic
corpus ten times the size, with the hand-rolled loop restored in the comparison variant. Low value.

**`src/permissions.js:52`'s "no sleep after the last attempt"** removes up to 200 ms from a 1.1 s
worst case. The saving is real by construction; the open question is whether the path is ever
reached. Fault-injection measurement: stub `fs.renameSync` to throw `EBUSY` unconditionally and time
`writeFileAtomicSync` to completion, both variants, cold. The answer belongs in
`docs/engineering-record.md`.
