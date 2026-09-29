# Backlog

Open items, with the evidence that justifies each one.

Every closed item needs a checkable disposition: FIXED, CLOSED-VERIFIED,
DECLINED-MEASURED or ACCEPTED-RECORDED. Keep the disposition here or link its evidence
in `docs/engineering-record.md` before removing the open entry. Git history alone is
not a completion record. Read that engineering record before proposing work, including
refuted claims, retracted figures, measurement hazards and standing decisions.

Anything measured says so and names the date. Anything unverified says that too.

**Historical cleanup, 2026-09-25. The current backlog is still open.** This file was
955 lines and 88 open items. Every one was given a
disposition: fixed and deleted, proven already done and deleted, or measured and moved to
the record as a decline. What is below is what survived that, plus what the work itself
found. The suite went 574 to 731 tests over it.

**Verified against the code 2026-09-27, and twenty claims here were wrong.** Three read-only
passes checked every open entry against the tree rather than against its own prose. One
finding was **refuted outright** (the `httpsGetFollow` leak), two mechanisms were described
as something the code does not do (`SHELL_WRAPPERS` stripping, the census reading
`module.exports`), one proposed gate turned out to be worth **one** finding rather than
nine, two measurements were off (zero local settings files is one; ~145 references is 129),
and several citations pointed at the wrong lines — including one inside the dead-export
census itself. Corrections are inline and dated, not appended, so an entry cannot be read
without its correction. **Two deleted trackers were recovered** from `b5b206f^` and are
restored below.

The pattern worth naming: **an entry rots in a way its own prose cannot show.** Every
correction below came from running the thing or reading the line, never from re-reading the
entry. Re-verify before acting on anything here, including this paragraph.

---

## Open

### Codex compatibility: feature coverage and real-app validation

`docs/codex-compatibility.md` holds the feature inventory and dated evidence. The
September 27-28 work closes the original seven feature comparisons for the supported
outcomes below, with real-host/runtime checks. Broader version, format and CI coverage
remains open. Dispositions retain the earlier entries so validation progress does not
silently drop unfinished outcomes.

Version 1.6.0 incorporates the feature changes recorded below as FIXED in development.
Their dated evidence retains the original stage/version rather than relabelling old runs.

- **FIXED in 1.5.10: shared Codex rule ownership.** Reproduced September 28 in
  `test/codex-shared-claims.test.js`: applying an unrelated grant from workspace B
  replaces workspace A's generated rule; claiming the same prefix in B then undoing A
  removes the rule B still relies on. The initial regression run has two failures and
  one passing manual-edit refusal control. The shared ledger now retains other owners,
  records ownership when rule bytes stay identical, rechecks effective policy before a
  claim-only grant, and refuses a conflicting Undo without writes. Twelve regressions and
  eight killed mutations cover the fix. The old installed extension also fails the fresh
  runtime retention check; the updated writer passes it. See the 1.5.10 record in the
  compatibility document for baseline preservation and mixed-version limitations.
- **FIXED in development: literal Codex inventory/prune.** A separate
  Codex inventory and confirmed allow-rule removal now have source paths. Shared
  suppression blocks recreation by other workspaces and ordinary Undo; unsupported
  computed files and ambiguous generated ownership are read-only. Interrupted removals
  preserve an intent and expose explicit recovery. Fifteen regressions and ten killed
  manager/store mutations cover removal behavior; parser/UI checks have their own
  controls. Actual staged VS Code passes seven acceptance groups, including six inventory
  flows covering Cancel, Remove, read-only decisions/files and interrupted-removal recovery.
  Eighteen fresh Codex checks across default/custom homes prove prompting after removal,
  suppression across workspaces and unrelated grants surviving. Disabling suppression
  recreates the rule and a fresh Codex process runs it without approval; the check fails.
  A no-op actual Remove route fails exactly its native acceptance group.
  A no-op Finish removal route also fails that group after its other five flows pass,
  retaining the pending intent despite the deliberately false success result.
  No release or installation was needed. Details, mutation witnesses and limits are in
  the development batch section of `docs/codex-compatibility.md`.
- **Original seven feature comparisons: dispositions by user outcome.** These counted Claude
  implementation paths without a full Codex counterpart, not seven established failures
  in the working Codex workflow. Do not automatically turn a Claude-specific mechanism
  into another feature to build. Establish the missing user outcome and whether an
  existing Codex path supplies it; record that evidence before closing or implementing.
  Existing-approval generalization adds broader coverage while preserving authored approvals: Codex
  Auto Learn already emits reusable prefixes (`src/policy-exporters.js:350`). Project-local
  promotion originally lacked a Codex migration path; the reviewed import below closes
  that gap. Generated rules already defaulted to user scope, so sharing was not absent.
  Immediate hook integration means a post-tool callback; Codex already has transcript
  watchers and periodic scans (`vscode-extension/extension.js:1987`). CLOSED-VERIFIED
  September 28: actual editor-open ingestion works without a Scan command, and the
  unchanged one-minute reconciliation timer catches a deliberately missed notification.
  Disabling either route fails its corresponding real-host ingestion check. Evidence:
  `acolyte-validation-background-dev-20260928/results.json` under the scratch directory.
  This proves the preexisting outcome; it does not claim immediate per-tool timing.
  Full high-water
  backup/restore remains separate from the existing Auto Learn snapshots and Undo.
  FIXED in development, September 28: retained literal declarations, explicit
  missing-rule restore, suppression, shared ownership preservation and recovery intent.
  Twenty fresh Codex cases and twelve execpolicy probes pass across default/custom
  layouts. Final staged VS Code passes all nine acceptance groups, including four
  recovery flows. Disabling the actual Restore write fails exactly group eight.
  Non-shell learning, native memory source/index/recall integration, and derived guidance
  were additional comparisons: shell learning and shared memory-gate installation
  already work. Derived guidance now has Codex-only run evidence, current managed-policy
  matching and agent-specific instruction routing. FIXED in development, September 28:
  actual Accept/Decline, full-body review and fresh Codex instruction loading/removal
  pass; a no-op Accept fails exactly group nine. Two modal/teardown mutations also fail.
  FIXED in development, September 28: native memory discovery, passage search, ambient
  lint and the after-turn hook. The hook passes default/custom-profile runtime checks
  with the editor closed; actual Configure/Cancel/Remove, memory creation/repair/deletion,
  search/inspection and UTF-8 BOM source selections pass six native VS Code groups.
  Disabling each write/watch/selection route fails its intended native group.
  Evidence: `acolyte-validation-features-dev-20260928` and
  `acolyte-validation-native-memory-dev-20260928` under scratch; the compatibility
  record names immutable stages and controls. FIXED in development: semantic recall,
  exact passage selection and index rebuild pass four real-editor groups; disabling
  semantic retrieval, rebuild or the fallback warning fails its intended group.
  Evidence: `acolyte-validation-mcp-recall-dev-20260928/native-recall-results.json`.
  FIXED in development: native gate compilation has six fresh Codex instruction-loading
  checks and seven passing editor groups covering gates and read-only MCP receipts.
  Install, automatic refresh and receipt-visibility controls fail their intended groups;
  the original malformed-scope compiler also fails the preserved real-editor case.
  Evidence: `acolyte-validation-native-gates-dev-20260928/native-results.json`.
  FIXED in development, September 28: stored-approval widening
  and project-rule import pass six real-editor groups, including Cancel, source preservation,
  restrictive dependencies, stale review refusal and interrupted-write recovery. Fresh Codex
  uses the imported user rule while its restrictive argument still prompts. Writer and recovery
  no-ops fail exactly their intended native groups. Evidence:
  `acolyte-validation-approvals-dev-20260928/results.json` under scratch. MCP ingestion
  now has real outcome evidence. FIXED in development: exact MCP tool review, native
  config write, Undo, stale refusal and interrupted-write recovery pass six editor groups
  and seven fresh Codex processes. All three no-op writer controls fail their intended
  groups (`acolyte-validation-mcp-dev-20260928/results.json`). Built-in image viewing
  requested no approval in three measured calls. Hosted-web outcomes remain unverified;
  completion records are not counted as successful calls.
  These records establish neither Codex platform impossibility nor that every missing
  mechanism needs a literal port. The FIXED dispositions above have their own
  code, tests and deliberately failing controls in the compatibility record.
  Any future backup restore must honor the shared deliberate-removal record. Computed
  Starlark remains explicitly read-only rather than being treated as a union of literals.
- **Core acceptance chain: CLOSED-VERIFIED; external prompt causes remain bounded.** Real VS Code configuration events and
  Codex-only synthetic-history scan/safe-apply/undo now have checks. Separate fresh Codex
  processes demonstrate approval reuse, a neighboring prompt, rule removal and instruction
  loading/removal. CLOSED-VERIFIED on September 28: the installed extension learns real
  Codex executions, deduplicates a repeat scan, grants through the actual Review checkbox
  and Grant dialog, and Undo restores prompting in a fresh process. The optional
  `drive-vscode --review-runtime yes` case records this chain. CLOSED-VERIFIED for
  actual diagnostic UI against those visible-rule transitions: reviewed allow, unrelated
  command declined, and post-Undo decline. A false-allow diagnostic mutation fails the
  actual dialog check; selected rule paths and blind spots are also asserted.
  CLOSED-VERIFIED in 1.5.9 for dashboard instruction toggles: Add, Cancel and Remove
  preserve both agents' user text, independent blocks and persisted settings. The check
  includes installation into both empty files. CLOSED-VERIFIED for dashboard Auto Learn
  button routes: Scan/rescan with background learning disabled, Review/Grant, Undo and
  three Why dialogs all reach independently checked state and fresh-process outcomes.
  Five no-op route mutations, including only the second Scan, each fail exactly the
  intended acceptance group with an execution witness and the changed package hash.
  Prompt causes outside visible policy remain open.
  The previous September 24 requirement remains traceable to this combined evidence.
- **Historical evidence migration implemented in 1.5.8; broader acceptance remains.**
  Revisioned source counts invalidate old Codex cursors and reread available history.
  Original mixed counts are archived; uncertain attribution is excluded from new automatic
  approvals rather than assigned to an invented source. Grant definitions and prior undo
  records survive. Tests reproduce false pending-process successes and preserve Claude
  evidence. CLOSED-VERIFIED for the installed upgrade/undo workflow in default and custom
  homes: disabling migration leaves three false successes and fails exactly its host
  assertion. An isolated copy of the existing saved state also normalizes without errors
  and preserves original counts. Large, partially missing real history still needs
  representative acceptance coverage; no saved-state wipe is used.
- **Declare and exercise a supported version window.** The new runtime harness records
  Codex and host versions, but no range is declared or enforced. Current fresh-session
  evidence covers Codex 0.145.0 on Windows. Earlier CLI-only evidence also exercised
  0.154.0. Source schema versioning at `src/auto-learn-manager.js:39` is unrelated.
- **Provision Codex in CI.** Contract tests still skip with an explicit reason when the
  binary is absent. They use the local rule checker and do not require provider auth.
  New real-host/runtime checks have not been wired into continuous validation.
- **Expand direct-shell evidence beyond the observed shape.** The old 53-rollout corpus
  contained only nested `exec` shell calls. Its always-success classifier mutation
  survived because nested statuses independently determined the verdict. CLOSED-VERIFIED
  for the missing real `shell_command` sample: the September 27 runtime harness now
  parses actual successful and declined transcripts with the packaged parser. Broader
  formats remain bounded; no universal parser claim follows. A September 28 actual
  `exec_command` plus later `write_stdin` reproduction found that both success and failure
  stayed unknown. The development parser now joins exact process identity within one
  rollout, checks terminal metadata before stdout and withholds ambiguous or interactive
  outcomes. FIXED in development: fresh success and nonzero-exit runs now classify
  correctly, and disabling the process bridge fails the same runtime check. Twelve
  parser controls fail their intended assertions. Evidence:
  `acolyte-wait-runtime-validation-61hUMH/report.json` and
  `acolyte-wait-history-mutations-41lYsS/report.json` under scratch. Revision 3 reopens
  old completed cursors once while preserving Claude counts, grants and Undo; reverting
  the revision fails its migration test. Custom `functions.exec`/`functions.wait`
  continuation and other unobserved formats remain outside this proof.
- **Finish guidance coverage across Codex configurations.** The emitted body and its
  module comment now distinguish simple shell splitting from complex wrappers; the full
  corrected body is checked in a fresh session's outbound request. This addresses the old
  wording defect. Version 1.5.8 adds custom `CODEX_HOME` and active `AGENTS.override.md`
  support across history, rules, instructions and diagnostics. A representative matrix
  of shell wrappers remains open. Policy enumeration still omits automatic discovery
  of trusted project rule directories (`src/codex-policy.js:380`).
- **FIXED in 1.5.9: partial instruction badges disagreed with their cards.** When only
  Codex had the managed block, collapsed guidance said `not installed` and gates said
  `<count> waiting`, while the expanded cards correctly said `PARTIAL`. Both badges now
  say `partially installed`. The dashboard regression uses actual Codex-only instruction
  files plus both-off and both-on controls. Removing either partial-label branch or the
  guidance warning condition causes exactly one named failure. The corrected labels are
  also visible in the isolated real VS Code dashboard.

### The `file:line` gate catches less than it looks like it catches

`test/line-refs.test.js` fails a citation only when it lands on a **vacuous** line — blank,
or a bare closing brace. A stale citation pointing at a plausible-looking line is invisible
to CI.

⚠ **That list was incomplete** (verified 2026-09-27). `checkBounds`
(`scripts/check-line-refs.js:599-644`) also fails on a missing file, an unreadable file, an
out-of-bounds line, and a **descending range** (`:623-632`, added after three shipped in one
commit). And it SKIPS ambiguous basenames entirely (`:605`), so an ambiguous reference can
never fail the suite. The floor assertions matter too: `test/line-refs.test.js:65-77` and
`:114-133` both require `refs.length >= 100`, so a silently-dead extractor fails rather than
passing with zero findings.

**The measurement, stated once so it cannot drift in two places: run**
`node scripts/check-line-refs.js --quiet`. On 2026-09-27 it reported **OK 47 | NEAR 16 |
STALE 49 | UNVERIFIABLE 17** over 129 references, exit 0. It read **OK 38 | NEAR 16 | STALE
54 | UNVERIFIABLE 17** over 125 on 2026-09-25. None of the STALE rows fails the suite.

Where they concentrate, measured 2026-09-27: **28 of the 49 STALE sit in five files** —
`docs/engineering-record.md` 12, `vscode-extension/extension.js` comments 5,
`test/dashboard-view.test.js` 5, `src/fixed-point-cache.js` 3, `src/auto-learn-manager.js` 3.

Two corrections this entry had to make to ITSELF, which is the point. It first called 84 the
STALE count when 84 was the non-OK TOTAL. It then quoted two different counts in two places,
both already stale within hours. **Re-run the command rather than trusting any number written
here**, including this one.

This bit three times during the 2026-09-25 work. A README citation was semantically wrong
for several revisions and stayed green until an unrelated two-line comment edit pushed its
target onto a `}`. A record citation had been 11 lines stale on `main` and passed for the
same reason. And eight of ten citations repaired in one pass were already pointing at the
wrong content before that pass touched anything.

The stronger STALE verdict is deliberately not asserted, and `docs/engineering-record.md`
says why: it picks a neighbouring symbol often enough that asserting it would fail the suite
on correct references, and a gate that cries wolf gets suppressed. **So this is a known
limit rather than a bug.** What would close it without that cost is an anchor form — cite
`file:line` plus the identifier expected there — which is checkable exactly and needs no
heuristic. That is a corpus-wide change to **129** references (not the ~145 this entry used
to claim) and has not been attempted.

Feasibility, measured 2026-09-27, because it is cheaper than it reads. An anchor can be
**optional**: it lands in a new capture group on `REF_RE`
(`scripts/check-line-refs.js:57-62`), `REF_STRIP_RE` (`:85`) inherits it for free since it is
derived from the same source, and `judge()` (`:440`) takes one early branch when the anchor
is present, bypassing the entire heuristic path. Un-anchored references keep their current
verdicts verbatim, so the corpus can migrate one reference at a time, with a ratchet on the
anchored count mirroring the existing `>= 100` floor. Note that a hypothetical
`src/foo.js:12#fooBar` **already parses today** — `#` is not in the lookahead class —  <!-- line-refs:ignore -->
so the syntax can be adopted textually before it is enforced. (That example carries an
ignore marker: it names no real file, and the checker rightly called it BROKEN on the first
draft of this entry.) And the text to anchor with is already there: **128 of 129**
cited spans carry >= 8 characters of real content, so a `code`-kind anchor is writable by
hand for all but one (`test/policy-backup.test.js:57`, whose cited line is literally `//`).

Related, found the same day: a drift scan that required citations to begin with a directory
(`src/`, `vscode-extension/`) missed every bare-filename form (`extension.js:2521`), which  <!-- line-refs:ignore -->
was 20 of the 35 citations one change touched. ⚠ **That limitation was never a property of
`scripts/check-line-refs.js`**, corrected 2026-09-27: `resolveTarget` (`:147-161`) falls back
to a basename lookup and resolves bare filenames fine. It was an ad-hoc scan from that
session and nothing like it is committed. 39 of the 129 references are bare today.

**A real blind spot, found 2026-09-27 and not previously recorded: `.py`, `.yml`, `.yaml`
and `.json` are never scanned for references at all.** `SOURCE_EXT`
(`scripts/check-line-refs.js:103`) admits only `.js`, `.mjs`, `.cjs`, `.ps1`, `.sh`, plus four
extensionless names at `:104` — while `commentRuns` (`:361`) already implements hash-style
comment detection for `.py`, `.yml` and `.yaml`. That capability is dead code: nothing routes
those extensions to it. Live casualty: `memory/recall.py:1130` cites  <!-- line-refs:ignore -->
`extension.js:3013`, a gates-status getter. That citation is quoted here because it is  <!-- line-refs:ignore -->
WRONG, so it carries an ignore marker rather than being counted as a claim of ours. The
real `slice(0, 300)` sites are
`vscode-extension/extension.js:896`, `:942` and `:3127`. `memory/recall.py` is tracked, so
this is a stale citation that the checker, the test and the `--quiet` count are all blind to.
Fixing it is one line in `SOURCE_EXT`, and it will raise the reference count.

### The Project-local card reports on a path it did not watch

Not a bug; the hook covers what the card misses. It is a UI blind spot, which is the class
where a control reports on something other than what is running.

`drainableRoots()` (`vscode-extension/extension.js:2842`) enumerates every workspace folder,
but `localSettingsPath` (`src/local-settings.js:42-46`) is a single non-recursive join, so the
extension drains one file per open FOLDER and never a subdirectory. The CLI hook drains the
Claude Code session's own cwd on every tool call (`bin/wildcard-perms:501-515`, reading
`event.cwd` off the hook payload). With the editor open at a parent and sessions running in
`projects/<name>`, a file the hook drains is invisible to the card, and the card can read
"nothing to drain" while a subproject file is being drained under it.

⚠ **Three corrections, 2026-09-27.** The citation above said `:2693`; `drainableRoots()` is
at **`:2772`**, and `:2693` is an unrelated comment block. **The card does not call
`drainableRoots()` at all** — `localCardData()` (`:2881-2902`) carries its own duplicated copy
of the same filter, and that copy **omits the `isTrusted` gate** `drainableRoots()` applies,
so an untrusted workspace still gets dry-run numbers while the drain itself refuses. And the
blind spot is three-fold rather than two: the **watcher** glob at `:2000-2007` is
`.claude/settings.local.json` with **no `**/` prefix**, so a subdirectory file fires no
watcher event either. Never discovered, never watched, never named.

The subtitle already tries to name the path (`:4132`): with one folder it renders the real
`~`-relative path, but with two or more it collapses to the bare constant
`.claude\settings.local.json`, which names nothing. That is the exact surface a "name the
path it watched" fix would touch.

⚠ **An earlier version of this entry named the wrong cause** and would have sent a fix at
`workspaceFolders?.[0]`, which governs Auto Learn's state partitioning and is not on the
drain path at all. Corrected 2026-09-24.

The honest fixes are to make the card name the path it actually watched, or to discover
local files beneath the workspace root rather than only at it. Neither is done.

⚠ **The "zero files" measurement is off by one**, re-measured 2026-09-27: exactly **one**
`.claude/settings.local.json` exists under the working root, at `D:\.ai-work\` itself, and
its `permissions.allow` is empty. An empty allow returns early at `src/local-settings.js:212`,
so the card still reads zeros and the conclusion survives — but the premise "no such file
exists" does not, and the one that does exist sits exactly where the card looks.

If recursive discovery is ever built, the walker to copy is `findJsonlFiles`
(`src/history-adapters.js:934-1029`), the only production recursive walk in the repo: iterative
rather than recursive, cycle-safe on `fs.realpathSync.native` keys (`path.resolve` was tried
and is NOT enough — it preserves 8.3 short names so one directory got two keys), and it
handles Windows junctions, which report neither `isDirectory()` nor `isFile()`. It is not
exported and it honours no ignore list at all, not even `node_modules`. `vscode.workspace.
findFiles`, which honours `files.exclude` natively, is currently unused anywhere in the
extension.

### Two surfaces with no way to configure them

- **The Auto Learn worker deadline is environment-variable only.** It is overridable via
  `PERMISSION_WILDCARDING_WORKER_TIMEOUT_MS` or the runner option, but
  `vscode-extension/package.json` declares no `autoLearn.workerTimeoutMs` contribution, and
  `getConfiguration()` cannot read an undeclared key. So a VS Code user has no Settings-UI
  lever for it.
- **`liveChildren` and `liveTransfers` are parallel sets with one lifecycle.** Kept separate
  because the kill verbs differ (`child.kill()` versus `handle.destroy(err)`) and merging
  them needs a wrapper object per entry. Worth revisiting if a third kind of in-flight job
  appears.

### Unverifiable citations, opportunistic only

The residual UNVERIFIABLE rows in `scripts/check-line-refs.js` are prose that never names
anything literal. Each can be made checkable by quoting the identifier that actually sits at
the cited line. **Worth doing when a sentence is being edited anyway, not as a sweep** — and
note the record's standing warning never to bulk-apply the checker's `suggest` field.

### Publishing the CLI to npm: packaging first, the workflow last

The name is reserved. `ai-acolyte@0.0.1` was published 2026-09-25: two files, 1431 bytes
unpacked, a `package.json` and a README saying outright that the version reserves the name
and installs nothing useful. Verified from the registry rather than the publish output, by
comparing `dist.shasum` against the `npm pack --dry-run` shasum that was privacy-scanned.

**No CI change is needed yet, and the workflow is the last step rather than the first.**
Neither `release.yml` nor `test.yml` contains `npm publish`, a `registry-url`, or any token,
and that is currently correct: there is nothing publishable to push.

- **The root manifest is not a package.** `name` is `permission-wildcarding`, not
  `ai-acolyte`, so a publish would push the wrong name. There is no `bin`, so a global
  install would put nothing on PATH. There is no `files` and no `.npmignore`, so a publish
  would ship the entire tree including `test/`, `img/`, `docs/` and any VSIX sitting in the
  root. Fixing that shape is the real work, and it rests on a decision nobody has made:
  **does the CLI ship standalone at all, or only inside the extension?**
- **`"private": true` was added 2026-09-27**, so an accidental `npm publish` in the repo
  root is refused rather than pushing the whole tree under the wrong name. Taking it off is
  now a deliberate step in the publish work, and `test/installers.test.js` fails if it goes
  missing. ⚠ `npm publish --dry-run` **exits 0 on a private package** and will not
  demonstrate this; the reason, and the two npm source sites involved, are in
  `docs/engineering-record.md`.
- **Use Trusted Publishing over OIDC when it is wired, never a token.** This account's 2FA
  is a security key, so CI has no OTP to present, and npm no longer offers a TOTP
  authenticator at all. Granular tokens with 2FA bypass are being restricted by npm:
  account changes Aug 2026, direct publishing Jan 2027. OIDC needs no stored secret. It
  wants `permissions: id-token: write`, `setup-node` given
  `registry-url: 'https://registry.npmjs.org'`, then a plain `npm publish`, authorized once
  with `npm trust github ai-acolyte --file <workflow>.yml --repo bigfnj/ai-acolyte
  --allow-publish`. Confirmed against docs.npmjs.com/trusted-publishers, 2026-09-25.
- **It cannot reuse the existing release job.** Trusted publishing requires npm >= 11.5.1
  and Node >= 22.14.0. `release.yml:23` and `test.yml:80` both read `node-version: "20"`,
  and that pin is deliberate: Node 20 is where `node:sqlite` is absent, the asymmetry
  `scripts/mask-sqlite.js` exists to catch. So the publish belongs in its own job on a
  current Node, not as an edit to either of those.

Publishing itself stays manual regardless of CI: see `docs/acolyte-rename-migration.md` for
why an agent tool call cannot do it (`EOTP`, no TTY to wait on the browser approval).

### Three roots that fit neither family table

Found 2026-09-25 while seeding `pipx`, `rclone`, `uv` and `uvx` from the development box's
real allow list. These three also hold a bare `Bash(<root> *)` grant there, but neither
`FAMILY_ROOTS` nor `SHELL_WRAPPERS` is obviously right for them, so they were left alone
rather than guessed at.

⚠ **This entry described a mechanism that does not exist.** Corrected 2026-09-27:
**`SHELL_WRAPPERS` does not strip anything.** Membership does exactly two things
(`src/auto-learn.js:648-649`): it raises `risk` to `'shell'` and adds the reason
`shell-wrapper`, which `isAutoSafeCandidate` rejects. Nothing in `src/` unwraps a
`bash -lc "..."` payload; the only stripping in `deriveBaseInvocation` is a hard-coded bash
preamble list (env assignments, `command`, `builtin`, `timeout`) at `:517-535`, and those
names are literals, not table entries.

Measured behaviour of all three today, all identical and all unbraked:

| Command | Permission emitted | Risk | Reasons |
|---|---|---|---|
| `just build` | `Bash(just *)` | unknown | `unknown-command` |
| `hyperfine 'sleep 1'` | `Bash(hyperfine *)` | unknown | `unknown-command` |
| `duckdb -c "SELECT 1"` | `Bash(duckdb *)` | unknown | `unknown-command` |

- **`just`** runs a recipe named by its argument. A recipe name is not a command, so even if
  stripping existed the result would be meaningless rather than conservative.
- **`hyperfine`** runs its quoted argument as a command. ⚠ It would **not** land on
  `quoted-executable`: that fires only when the FIRST token is quoted
  (`src/auto-learn.js:554`), and `hyperfine` is bare. Measured above.
- **`duckdb`** executes SQL that can read files, write files and install extensions. It is
  neither a subcommand dispatcher nor a shell wrapper; it is closer to an interpreter, and
  no existing table describes that shape.

Each needs its own decision with its own evidence. One sweep across all three would be the
wrong shape of answer.

The pattern to follow if any of them is adopted is commit `a7a2035`: table edits only,
alphabetically inserted, each addition preceded by a comment naming the date and the per-root
evidence, plus one new test with a mutation-named assertion per entry. Note that
`FAMILY_ROOTS` and `FAMILY_SUBCOMMANDS` (`src/auto-learn.js:78-115`) **must move together** —
a root added to the first without a subcommand list in the second makes every invocation
`family-subcommand-unknown`. Also note there are TWO unrelated `SHELL_WRAPPERS` tables:
`src/auto-learn.js:62-72` (40 entries, the classifier) and `src/policy-exporters.js:11-15`
(20 entries, the Codex-export refusal path). They are not interchangeable.

### 14% of this box's stored approvals can never be wildcarded

Measured 2026-09-25 against the development box's live `~/.claude/settings.json`: of **509**
`Bash`/`PowerShell` allow entries, **71 (13.9%)** begin with something that is not a command
at all, and **65** contain an unquoted `;`.

| Shape | Count |
|---|---|
| Starts with a `$variable` assignment | 57 |
| Starts with a control keyword (`foreach`, `if`, `1..6`) | 14 |
| Contains an unquoted `;` | 65 |

These are multi-statement approvals stored verbatim. They can never match anything again,
which is precisely what the shell-style guidance this tool installs into `CLAUDE.md` warns
about. The tool has been generating that guidance while being unable to see that the user's
own list is 14% populated by the thing it warns against.

**The product opportunity is a diagnostic, not a rule.** Nothing can generalize these, so
there is no rule to propose; what is missing is telling the user they exist and that each
one is dead weight that will re-prompt on the next variation. Nothing surfaces this against
the INSTALLED allow list, as opposed to against newly observed history.

⚠ **The three reasons this entry named would miss the largest bucket.** Corrected
2026-09-27 by running the live classifier against each shape:

| Shape | Count | Reasons actually produced |
|---|---|---|
| `$variable` assignment | 57 | `dynamic-executable` + **`missing-command-root`** — NOT
  `shell-structure`, because `!root` takes the other branch at `src/auto-learn.js:629` |
| `foreach` / `if` | part of 14 | `reserved-keyword` + `script-syntax` + `shell-structure` |
| `1..6` | part of 14 | **`unknown-command` only**, and it emits a live
  `PowerShell(1..6 *)` permission with `complex: false` |
| unquoted `;` | 65 | `compound-command`, per segment |

So a diagnostic keyed on `script-syntax`, `shell-structure` and `compound-command` alone
would miss all 57 assignment-shaped entries and the `1..6` cases. The set it actually needs
is `{missing-command-root, dynamic-executable, reserved-keyword, script-syntax,
shell-structure, compound-command}`. Note `shell-structure` is an ALIAS, not an independent
signal (`src/auto-learn.js:625-626`), and it is mutually exclusive with
`missing-command-root`.

Plumbing, if it is built: the closest existing analogue is `autoLearnScanHealth`
(`vscode-extension/extension.js:1239-1277`), a derived read-only summary hung off the card
payload and rendered through the shared `scanTrouble` helper so badge and body cannot
disagree. The live allow list should be read via `readSettingsState()` (`:184`), which the
dashboard already calls once per push — a second `readSettings()` would be a regression the
comment at `:3483-3500` explicitly warns about.

### From the 2026-09-25 audits: what was found and NOT fixed

Three read-only audits ran over the whole two-day effort. Everything they found in the
product was fixed the same day and is not listed here; what follows is what was left, each
verified against the tree.

**The returned-object check: re-measured 2026-09-27, and it is worth much less than this
entry claimed.** The proposal was *a property on a returned object literal that no caller
reads*, said to catch nine of fourteen dead-code findings. Those fourteen were fixed on
2026-09-25. Run against the tree today the rule yields **one** finding, not nine:
`precedence` at `vscode-extension/autoLearnUi.js:169`, whose only other occurrences in the
whole tree are a test NAME and prose. Three weaker candidates have no production `.prop`
reader but are load-bearing anyway (see FP-4 below): `bypassDisabled` and
`forcedDefaultMode` at `src/policy-guard.js:151,153`, and `skippedCount` at
`src/auto-learn-manager.js:2273`.

**The naive form of the rule is unsound before it is even run.** Of 231 returned-object-
literal sites carrying 920 (site, key) pairs, **176 of 315 distinct names appear at more
than one site, covering 85% of all pairs** — `changed` alone appears at 38 sites across 9
modules. A rule phrased as "no caller reads this property name" is therefore silenced for
85% of pairs by an unrelated object that happens to share a name.

Five false-positive classes, each large enough to sink it on its own:

1. **Whole object `JSON.stringify`d to CLI stdout** (`bin/wildcard-perms:349`, `:735`,
   `:749`). Every key of the ~30-key `scan`/`apply`/`undo` results is a user-visible output
   field with no `.prop` reader. `src/auto-learn-manager.js:2024-2028` says so in a comment.
2. **The webview boundary.** ~20 keys are posted by `postMessage` and read only inside a
   template-literal `<script>` (`vscode-extension/extension.js:4213-4227`). A text scan sees
   those readers; **an AST does not** — that script is string data to the parser.
3. **The worker-thread boundary.** `src/auto-learn-worker.js:25-34` posts
   `{ok, result, error:{message, code, stack}}`; the readers are in another file on another
   thread (`vscode-extension/autoLearnWorkerRunner.js:162-170`), with no call site linking
   them.
4. **`assert.deepEqual` pins a property without reading it.** `test/policy-guard.test.js:
   98-105` pins the whole shape, so deleting `bypassDisabled` fails the build even though
   nothing reads it. This repo uses `deepEqual` for contract pinning heavily.
5. **Spread, both directions** (`src/auto-learn.js:670-677`,
   `src/auto-learn-manager.js:1362-1370`) and **dynamic dispatch** off the returned API
   object (`manager[operation](...args)`, `src/auto-learn-worker.js:20`). Also persisted
   state, where the reader is a later process run.

**Implementation constraint, measured:** a regex/brace-matching version is not viable. A
loose key extractor reported 18 candidates of which ~14 were parser artefacts, a 78%
artefact rate. It needs a real AST, and no parser is vendored — `node_modules/` is absent
and this repo has zero dependencies by design, so the check would cost the repo its first
one. Given a yield of one finding, that trade looks bad.

⚠ **And this entry described the census wrongly.** `test/dead-exports.test.js` does NOT
"read `module.exports`": it `require()`s each module in a sandbox with `vscode` stubbed and
`os.homedir` redirected, then enumerates the live exports object (`:190-219`). Consumer
detection is four regexes (`:251-306`). And `bin/`, `scripts/` and `test/` are **not**
invisible to it — they are invisible as SUBJECTS (their own exports are never audited) but
fully scanned as CONSUMERS, with `bin/wildcard-perms` added by hand at `:164` precisely
because it is the highest-frequency consumer. The genuine blind spots are the ones listed
above plus: comment and string matches count as consumers; `import * as ns` and default
imports are not among the four shapes; and the census is a non-recursive `readdir` of
`src/` and `vscode-extension/` only.

**New, and self-referential: the census contains a stale citation of its own.**
`test/dead-exports.test.js:81-82` says `CODEX_BUNDLE_CACHE` is at `src/codex-policy.js:71`,  <!-- line-refs:ignore -->
used at `:12` — both quoted as the defect, hence the ignore marker. The constant is at
`src/codex-policy.js:11` and `readEnterpriseBundle` at `:13`; `:71` is a
comment line. The claim is still true, the coordinates are not.


**Two trackers were lost, not two items — and BOTH ARE RECOVERED.** They were deleted in
`b5b206f`; `git show b5b206f^:BACKLOG.md` has them. Neither was in
`docs/engineering-record.md`. Re-verified against HEAD 2026-09-27.

**Tracker 1, seven surviving mutants** (correct at HEAD, no test would notice a reversion),
ranked by what a reversion costs:

| Site | Mutant | Consequence |
|---|---|---|
| post-lock `reportAlreadyOptimal` (`vscode-extension/extension.js:2786`) | branch to `if (false)` | `backupPolicy` never runs on the "someone else generalized it while we waited" path, so **a deleted backup is not rebuilt** — the one property its comment promises |
| toast counts | revert to the probe's `after`/`before` | wrong added/removed numbers shown |
| `lastRun` assignment | delete it | the dashboard's "last run" never advances |
| probe read guard | delete `if (!settings)` | reports "already optimal" over an unreadable settings.json |
| both `lockedRetries = 0` resets (`:2643`, `:2654`) | delete either | retry budget strands or never strands; untested at both |
| `COVER_KEY_CACHE_LIMIT` (`src/permissions.js:385`) | set to 3 | the comment's "5000 is load-bearing" is asserted nowhere |
| `coverLookupKeys` non-string passthrough (`src/permissions.js:389`) | delete it | nothing observes it |

**Tracker 2, option keys read with zero suppliers — now FIVE, not six.**
`busyMessage` gained a production supplier at `src/agent-guidance.js:281` (commit `9dfcda6`)
and is closed. Still open, each leaving an unreachable branch:

- `managedPolicyPath` — read at `src/auto-learn-manager.js:1244`, `:1259`; no supplier anywhere, tests included.
- `defaultTool` — read at `src/history-adapters.js:765` (moved from `:718`); makes that early return unreachable.
- `priorCursors` — `src/history-adapters.js:1281`, the second leg of `options.cursors || options.priorCursors`.
- `homeDir` and `successThreshold` — unreachable because `vscode-extension/extension.js:1087-1088` sets BOTH spellings on the same object literal, so the `||` and `??` legs at `src/auto-learn-manager.js:1288` and `:1292` never fire.

**Suspected, each with the reason it could not be closed:**

- ~~**Cancelling the model download inside the redirect window**~~ **REFUTED 2026-09-27.**
  The early return at `vscode-extension/extension.js:728` is real and IS reached.
  `test/extension-lifecycle-async.test.js:1604-1620` drives exactly it. But it does not leak:
  the only way `handle.cancelled` becomes true is `handle.destroy(err)` (`:721`), which also
  calls `handle.req.destroy(err)`, and a destroyed request emits `'error'`, which reaches
  `onResponse(null, err)` at `:732` and runs `fail()`. The test asserts the promise settles.
  Both destroy callers supply an Error, so the event always fires. Of the two readings this
  entry could not separate, **the first one was right**. The `liveTransfers` half of the claim
  stands — it holds only the request handle, not the write stream — so the premise was sound
  and only the antecedent never occurs.
- **A case-mismatched `target` defeats the substitute invariant on Windows.**
  `src/codex-policy.js:414-426` compares `resolved` (on-disk casing) with `target`
  (`path.resolve`) by exact string, with no case folding. Both sides derive from `os.homedir()`
  today so they agree; a `codexRulesPath` with different casing would leave the deployed file
  visible AND append the pending one, a state the code says no write produces.
  ⚠ **Not reachable from any shipped surface**, verified 2026-09-27: there is no
  `codexRulesPath` setting in the manifest (17 keys, none of them a rules path) and no CLI
  flag. Both producers hard-code it off `os.homedir()` (`vscode-extension/extension.js:1045`,
  `bin/wildcard-perms:324-325`). It is reachable only through the programmatic API, i.e. an
  embedder or a test. That lowers it well below the other items here.
- **The packaging gate reports but does not quarantine.** `scripts/package.mjs:56-62` runs
  `assertRetiredMaxAbsent(out)` after `vsce` has written the artefact, with no `try`/`catch`
  and no `rmSync(out)`, so a rejected VSIX stays in the repo root where a human picking the
  newest `.vsix` can still ship it. The ordering is deliberate and pinned —
  `test/retired-max-package-gate.test.js:65-73` asserts the gate runs AFTER packaging, so the
  fix is quarantine-on-failure, not reordering. ⚠ **CI cannot ship a rejected artefact**
  (verified 2026-09-27): `release.yml` runs packaging as its own step and neither upload step
  carries `if: always()`, so a throw stops the job first. **The exposure is local only** —
  and three `.vsix` files are sitting in the repo root right now.
- **`warnedOnce` survives a same-realm re-activate.** Module-scope `Set`
  (`vscode-extension/extension.js:233-242`), never cleared by `activate()` or `deactivate()`,
  unlike every sibling latch — both reset `deactivated`, `activationGeneration`,
  `autoLearnBusy` and `autoLearnWorkerRunner` with a paragraph of rationale each. Its comment
  says "once per activation"; it is once per realm. Bounded in practice, so cost is nil and
  only the contract is wrong. ⚠ **Found 2026-09-27: the repo's own inventory misses it too.**
  `docs/engineering-record.md:226-245` enumerates module state surviving `deactivate()` — "28
  module-level mutables, 9 reset, 19 surviving" — and `warnedOnce` is not in that list. Same
  gap, second location.
- **The `explicit: true` legacy-cleanup path has no UI entry point.** `toggleMax` and
  `toggleCodexMax` are registered (`vscode-extension/extension.js:2217-2220`) but deliberately
  absent from the manifest — verified: `contributes` has no `keybindings` key at all, and
  their absence is ENFORCED by `scripts/assert-retired-max-absent.mjs:24-29`. So the explicit
  half of `offerLegacyCleanup` is unreachable and anyone whose state is snapshot-only is never
  offered the cleanup. ⚠ **One entry point does exist and this entry did not credit it**
  (2026-09-27): a user's own pre-existing `keybindings.json` binding from a pre-retirement
  release. That is an intended, tested path — `scripts/drive-installed.js:223-228` asserts
  both ids stay reachable "because an existing keybinding calls them". The claim is exact only
  for users who never bound them.

**Cosmetic, listed so they are not rediscovered as findings:** the `fixed-point cache is back`
assertion in `scripts/smoke.sh` writes a value and reads it straight back, so it is close to a
constant equalling itself — the property it argues for is delivered by making the restore
unconditional, not by that assertion. And `test/codex-contract.test.js` builds a `swapped`
string it never asserts on (`void swapped;`); the real mutant is built two lines below.

⚠ **The `file:line` corpus got worse across this effort, not better**, and roughly half the
stale citations were written by it. The counts live in one place only, in the entry above;
do not restate them here. The gate cannot see them, for the reason that entry gives.
### The screenshots are stale, and one of them is provably wrong

Eyeballed 2026-09-27, which `docs/acolyte-rename-migration.md` had listed as never done.
That file now holds the full inventory; the short version is that `img/01-wildcarding.png`
shows a version badge reading **`v1.4.13`** against a current 1.5.4, every count in the set
is from 2026-09-16, and three of the eight carry legible local paths including a username
and an unrelated project's build directory, on a public repo.

The rename did **not** invalidate them: all eight are single-card crops with no window
title, so the old product name appears nowhere. `03-maxmode.png` went with the MAX
retirement in `d947565`, so no retired surface is pictured either.

**Owner decision 2026-09-27: re-capture later, leave the set alone until then.** Worth
doing against a scratch `HOME` so the paths are not this machine's. Nothing automated will
ever catch this — the privacy gate is text-only, and a PNG has no line for a checker to
read.

---

## Deliberately not here

Three classes of thing were moved out of this file rather than closed, because they are not
queue items:

**Declines with a number** live in `docs/engineering-record.md` under "Optimizations
measured and DECLINED" and "The 2026-09-25 measurement pass". Seven performance items were
settled there on 2026-09-25, including two whose recorded figures did not reproduce and one
whose premise was measured false. Do not re-derive them.

**Owner decisions** live in the record under "Deferred by the maintainer": the CLI drain
trust gap, the two stat-keyed caches, the text-only privacy gate, and the transcript-corpus
backup, which is now a scheduled mirror rather than an open question.

**Standing limits** are stated where they bite rather than tracked here: Codex managed
requirements are read only from the local bundle cache; rule inventory follows the selected
`CODEX_HOME/rules` and explicit extra directories, without automatic discovery of every
trusted project directory; and Codex account identity is deliberately never read because that
would mean opening `~/.codex/auth.json`.
