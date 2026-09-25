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
`vscode-extension/extension.js:1121`, which is the fix their pane still needs. And the
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
  `src/auto-learn-manager.js:443-454` is a strict whitelist with no boolean leg, applied both on
  read and on scan-replace, and it drops unknown fields SILENTLY — the marker would vanish in
  the same tick it was created. Bumping `VERSION` to carry it resets every existing state file,
  because `STATE_MIGRATIONS` is empty and `migrateState` returns null for an unregistered step.
- A size ceiling that skips the remainder. **Rejected on safety.** `isAutoSafeCandidate`
  (`src/auto-learn.js:841`) requires `counts.failed === 0`, so a skipped byte range containing
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

Re-measured 2026-09-10: 28 module-level mutables, **9 reset** by `deactivate()`,
19 surviving. The five that held real memory are now dropped — `dashboard` and
`memoryLint` each retained the whole `ExtensionContext`, and
`autoLearnManager`/`autoLearnManagerKey`/`autoLearnCardCache` held parsed history
state, the largest thing this extension builds.

What remains is inert by inspection: eleven timer handles (`debounceTimer`,
`recallSyncTimer`, `memBounce`, `gatesBounce`, `autoLearnBounce`, `autoLearnTimer`,
`policyBounce`, `localDrainBounce`, `dashboardBounce`) which are all cleared above
— holding a dead handle costs nothing — plus scalars (`lockedRetries`,
`localDrainRetries`, `localDrainAt`, `recallRebuildAt`, `lastRun`,
`autoLearnLastError`, `autoLearnFailureCount`, `autoLearnNextRetryAt`) and two
disposed objects (`statusBar`, `policyLock`).

Two of the scalars have a real if minor effect across a same-realm re-activate:
`autoLearnNextRetryAt` carries a backoff over, and `autoLearnFailureCount` carries
the count that computes it. Not worth a change on its own; worth doing next time
this file is open.

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
  One does now: "MAX off purges a blanket that arrived WHILE MAX was on" at
  `test/policy-backup.test.js:416`, added in answer to this entry. Control:
  restoring the top-level `require('../src/permissions')` **is** caught, so that
  guard is real and this one is not.
- **`if (!res.changed)` in `toggleMax` is unreachable,** and the commit has it
  backwards: deriving `turningOn = !isMaxOn(latest)` from the same `latest` is
  exactly what makes it un-reachable. 65 shapes of `latest` enumerated (5 allow
  sets x 3 hook states x 4 modes, plus `{}`, `null`, non-array allow, bare
  `hooks`): **0 yielded `changed: false`**. `extension.js:2393`'s wording also
  reads backwards: "MAX is already ${turningOn ? 'OFF' : 'ON'}" answers a click
  asking for ON with "already OFF".
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
  but not `settings?.permissions?.allow` at `bin/wildcard-perms:290`,** where the
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
`atomicWrite(change.path, change.content)`, `src/auto-learn-manager.js:1571-1611` —
"a third unrebased whole-object writer". Right, but incomplete, and the migration
is harder than it looked.

Sanctioned writers: `function writeAllow` at `src/settings-write.js:145` (rebasing
merge, written at `:210`) and `function writeTransform` at `:254` (CAS + verbatim,
written at `:369`).

Unrebased whole-object writers still outstanding:

| Site | Nature |
|---|---|
| `const updated = {` at `src/auto-learn-manager.js:1571-1574`, written `:1611` | The apply path. Has an `unchanged()` recheck at `:1606-1610`, so it is **check-then-act, not CAS** — a write landing between the check and the `renameSync` inside `atomicWrite` is undetected. When it *is* detected it **throws**, so a routine Claude Code `/model` write turns a legitimate apply into a user-visible error plus rollback churn. |
| `{ ...permissions, allow: next }` at `src/auto-learn-manager.js:1922-1924`, written `:1968` | **A fourth site, previously unrecorded.** `releaseClaudeGrants`, for `undo()`. Same shape, and **weaker** — no `unchanged()` recheck before the write at all. |
| `change.before.content` at `src/auto-learn-manager.js:1370` | `rollback()` restores it — a full-file write of stale bytes, guarded only by an `afterHash` check at `:1361`. |
| `atomicWrite(item.target.path, item.current.content)` at `src/auto-learn-manager.js:2002` | `undo()`'s inner rollback, same shape, `:1983` hash guard. |
| `{ ...local, permissions }` at `src/local-settings.js:245` | Different file (`.claude/settings.local.json`) but the same class — and **the widest read-to-write window in the repo**: `:201` read → `:245` write, spanning two `readUserSettings()` calls AND a full `writeAllow` to user settings. Claude Code writes this file too; it is where project-scoped "always approve" lands. `createSettingsWriter({ settingsPath: <local> })` would work here. |

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
- `rollback()` at `:1365` blindly restores `change.before.content`. If the writer
  rebased onto fresher bytes, rollback reverts the concurrent change — the exact
  bug, at the failure site.
- The new vanish guard in `writeTransform` would make `rollback()` **re-create a
  settings.json an external actor deliberately deleted.** That is a new defect
  the migration would introduce, and no existing test would catch it.

**Prerequisite, since met:** `grep "Policy changed" test/` returned nothing, so
the entire "detect and throw" behaviour that justifies this writer's safety was
unpinned, and swapping it for a retrying writer would have passed the full suite
silently. The "Policy changed" guard is pinned now: `test/auto-learn-manager.test.js:492-511`
records why, and the two tests are at `:513` and `:593`.

## `runWildcarding`'s lock: the constraint that decides any refactor

Recorded because it is easy to get wrong and the failure is a data loss, not a
slowdown. `writeAllow` replays a **delta computed against the caller's
snapshot**, and its own note at `src/settings-write.js:166-172` names this
caller: *"WRONG for one whose whole output is a function of the list it read …
Such a caller must re-read and recompute first."*

Today `runWildcarding` satisfies that **by accident of structure** — its
`readSettings()` happens to sit inside the lock, so the snapshot is nearly
`latest`. **Moving the read out of the lock without an authoritative in-lock
re-read and recompute reintroduces the MAX / `Bash(npm test)` deletion bug**
documented at `bin/wildcard-perms:360-374`.

Two further traps for that refactor, both real:
- **Key on file BYTES, not the parsed allow list.** The unchanged path is where
  "a deny rule added by hand first reaches the backup" (`extension.js:2521-2523`);
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
`bin/wildcard-perms:317-335` ("ONE lock acquisition covering both jobs") was
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
`ILT-wt-*` worktrees appeared during this work). And it buys little that the index diet did
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
`test/installers.test.js:465` — "the two package manifests report the same version" —
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
| `fullReport` re-reads the whole memory corpus every push | 6.98 / 7.96 ms | **0.56 ms.** Read 1.46 ms p50 against stat 0.90 ms over 17 files is a 1.6x ratio, not 10.3x. The growth argument was wrong too: a stat stamp scales with the corpus exactly as the reads do |
| 44 KB of verb bodies compiled on every hook call | 1.12 / 2.50 ms | **0.00 ms.** The real 44.4 KB file is 43.87 / 48.54 ms; a 1.8 KB stub is 44.00 / 48.73; a 212-byte floor is 43.01 / 48.48. V8 pre-parses and lazily compiles, so unexecuted verb code is free. **Do not re-derive this**: it proposed a 30 KB refactor of the most safety-critical file in the project for nothing |
| `gates.generated.md` read 5x per push | 1.55 / 1.69 ms | **~0.34 ms** |
| `CLAUDE.md` and `~/.codex/AGENTS.md` read twice each | ~0.89 ms | **~0.17 ms** |

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
