# Codex compatibility

**The original seven feature comparisons now have recorded dispositions.** Supported
Codex outcomes below are implemented or verified through actual VS Code and fresh Codex
checks. Version 1.6.0 incorporates these changes. Broader version/platform coverage,
unobserved history formats and continuous validation remain open; this is not a universal
claim about every Codex configuration.

## Feature-by-feature acceptance matrix

"Implemented" means a code path exists. "Missing" identifies the specific implementation
path named in that row. "Unverified" means acceptance evidence is still absent. A missing
path does not establish that the broader user outcome is absent, or that the Codex
platform cannot support it.

The rows compare extension implementation paths. Their count is not a count of broken
Codex workflows or a mandate to reproduce every Claude mechanism. Where an existing
Codex path already supplies the user outcome, verify that outcome before proposing
another implementation. For example, Auto Learn already writes reusable prefixes even
though reviewed widening of previously stored entries is a separate path. Codex history
also has automatic watchers and periodic scans; their existing editor-open behavior has
its own real-host evidence below.

| Extension capability | Codex implementation | Evidence and remaining acceptance |
|---|---|---|
| Generalize existing approvals | FIXED in development for reviewed literal widening | Auto Learn already emits reusable prefixes. The review proposes a shorter proven-safe prefix from an authored literal approval, preserves the source, checks effective policy and records an interrupted-write intent. Actual Cancel/Apply, explicit rule coverage, stale refusal and recovery pass. Codex already allows the test's read-only git command, so this does not claim a prompt reduction for that command. |
| Project-local approval promotion | FIXED in development for reviewed portable literal imports | Exact portable project declarations can be reviewed for user scope. Overlapping project restrictions accompany an imported allow, while nonportable or computed inputs remain read-only. Source bytes are preserved. Actual import makes a harmless custom command run without approval in a sibling workspace while its restricted argument still prompts. |
| High-water policy backup and restore | FIXED in development for captured literal declarations | Saved declarations survive scans and later grants, scoped to their original Codex home/file. Restore preserves current declarations and claims, excludes intentional removals, and journals interrupted writes. Default/custom-home runtime checks and four actual VS Code recovery flows pass. A no-op Restore fails its native group. See the recovery batch below. |
| Existing rule inventory and prune | Implemented in development for literal local rules | The separate Show Codex rules command lists local allow/prompt/forbidden declarations and source files. Confirmed allow-rule removal records shared suppression before writing; current builds prevent other workspaces and ordinary Undo from reviving a removed prefix. Unsupported computed files and ambiguous ownership are read-only. Real-app acceptance for this development batch is recorded below. |
| Post-tool approval hook | FIXED in development for after-turn learning | Codex 0.145.0 flushes completed results before Stop, but after synchronous PostToolUse. The Stop adapter scans completed Codex history with the persisted learning mode. Actual no-editor default/custom-profile checks pass success, failure, deduplication, automatic export and fresh-process reuse. Native Configure/Cancel/Remove passes; a no-op writer fails. Hook configuration still requires Codex's separate exact-definition review. Immediate per-tool timing is not claimed. |
| Shell history scan and outcome learning | Implemented; separate-wait completion FIXED in development | `parseCodexJsonl` (`src/history-adapters.js:1342#parseCodexJsonl`) parses actual new Codex shell transcripts. The real dashboard Scan button learns individually approved executions and deduplicates repeat scans. Fresh direct exec_command/write_stdin runs now preserve success and failure; ambiguous or interactive outcomes remain unknown. Revision 3 replays old Codex evidence once while preserving Claude counts and grant/undo records. Custom cell continuations and unobserved formats remain outside this proof. |
| Non-shell Auto Learn | FIXED in development for exact reviewed MCP approvals | Authoritative MCP records supply exact server/tool identity and success/failure/unknown counts without retaining arguments or response bodies. Review changes one native user-config approval setting; these candidates cannot become Claude permissions or shell rules. Actual VS Code passes six groups with seven fresh runtime calls and three failing controls. Hosted web and other built-in tools do not inherit this proof. |
| Built-in image and web tools | Measured native boundary; hosted-web outcomes remain unverified | Three fresh `view_image` calls needed no approval. Only the valid image returned structured image content; invalid input also emitted a completion event, so completion alone cannot establish success. Seventy historical web completion records exposed no authoritative outcome status. No speculative approval exporter or successful-run counters were added. See the measured boundary below. |
| Reviewed and automatic policy export | Implemented, including shared ownership in 1.5.10 | Real VS Code safe-apply produces effective rules. The actual dashboard Review button, checkbox and Grant dialog export a rule learned from real Codex history. A fresh process executes it without approval; a different executable still prompts. Shared ownership retains other workspaces' grants and rechecks effective policy even when only ownership changes. The learned custom-command prefix covers its arguments, so changing only an argument is not a negative control for that grant. |
| Auto Learn backup and undo | Implemented, with conservative shared-policy conflicts | The actual dashboard Undo button restores exact policy bytes and learner state in one workspace; a fresh Codex process requests approval again. Version 1.5.10 also checks shared ownership before Undo, including identical rules whose bytes never changed. A conflicting older Undo refuses without writing; undoing the newer transaction first permits the earlier Undo. |
| Shell-style guidance | Implemented for default/custom home and overrides | Wording now distinguishes Codex shell splitting from Claude generalization (`src/agent-guidance.js:91#GUIDANCE_BODY`). Real VS Code configuration events write/remove the blocks. Actual dashboard Add, Cancel and Remove also have file and persisted-setting checks, including installation into empty Codex and Claude files. Fresh Codex receives the full packaged guidance body; removal is verified. Custom homes, nonempty overrides, empty override fallback and unreadable targets have focused checks. |
| Memory gates | FIXED in development for explicitly marked native global sections | A separate native compiler reviews the full body and refreshes an installed block without changing native sources. Fresh default/custom Codex sessions load installed/refreshed bodies and confirm absence after Remove. Actual editor checks cover Cancel/Install, edits, zero/refill, override migration, malformed-source retention, Remove and stale review refusal. The old malformed-scope compiler fails the preserved case; install and refresh no-ops fail their intended native groups. |
| Memory index, lint and recall integration | FIXED in development for native discovery, lint and semantic recall | Reads the native summary, task registry, rollout summaries and memory skills with exact passage provenance. Raw staging inputs, SQLite and sessions are excluded. Actual later-created sources, diagnostic repair/deletion, search, inspection and BOM selections pass in VS Code. CPU semantic retrieval finds zero-keyword paraphrases across registry, rollout and skill sources; actual rebuild replaces poisoned vectors and missing-model searches visibly fall back to keywords. Three disabled-path controls fail their intended native groups. |
| Derived guidance for recurring friction | FIXED in development for supported repository-query advice | Current cached Codex managed prompt rules are compared with Codex-only successful run counts. A full-body dialog reviews advice before installation into the active Codex instruction file. Actual Accept/Decline and fresh instruction loading/removal pass; a no-op Accept fails the native check. Counts describe observed runs, not historical prompt dialogs. |
| "Why did this prompt?" | Implemented for visible local policy | `explainAutoLearnPrompt` (`vscode-extension/extension.js:2235#explainAutoLearnPrompt`) inspects visible rules and cached requirements. Three actual diagnostic dialogs agree with adjacent fresh Codex outcomes: reviewed command allowed, unrelated executable declined, original command declined after Undo. They name the selected rules file and disclose that managed/system policy, session approval state and sandbox restrictions remain outside the check. |

## September 27-28 runtime evidence

### Version 1.6.0 release candidate

The final local VSIX has SHA256
`7b201cadba96b72aa5abd6232f79f687dd9b2a6ec4e0e3ffa30206b108dd49e7`.
All 46 executable modules match the validated combined Stage C byte for byte; only
the product version, README and packaging metadata differ. The extracted VSIX passes
seven real-editor groups with 16 actual UI cases, and 14 simulated packaged-handler
checks. Its full source suite passes 1,080 tests, with two platform/capability skips
and zero failures (`acolyte-features-suite-8PZgWe/report.json`). No source/test drift
occurred during that run. The final editor evidence and artifact comparison are under
`D:/.ai-work/scratch/acolyte-release-1.6.0/native` in `result.json` and
`artifact-provenance.json`.

Release checks also pass 17 live CLI/hook smoke checks, 16 installer checks under
Windows PowerShell 5.1, the Python recall behavior suite, memory lint, starter-pack
mirroring and built-version synchronization. These local results precede remote CI
and publication; later hosted results belong to the commit and release run.

### Final combined development check

Stage C at `D:/.ai-work/scratch/acolyte-combined-dev-20260928-c/extension` contains
52 verified files, aggregate SHA256
`3074c8ae9a60623d40c93f32ba6ff6329890a18b3d902917a40731866d41ae73`.
The full source suite passes 1,082 tests: 1,080 pass, two platform/capability skips,
zero failures, and no source/test changes during the run. The report is
`D:/.ai-work/scratch/acolyte-features-suite-gZjx2V/report.json`.

This combined stage passes all seven native gate/MCP-receipt editor groups, with 16
actual UI actions/status observations. Eight relevant routing/helper/UI modules and the
harness match Stage B byte for byte, retaining the three deliberately failing controls.
The final result and comparison live beside the Stage B evidence in
`acolyte-validation-native-gates-dev-20260928/native-final-stage-provenance.json` and
`native-results.json`. Fresh actual Codex success and nonzero-exit wait cases also pass
against Stage C; `acolyte-validation-combined-dev-20260928-c/wait-completion/results.json`
binds its loaded parser to the earlier twelve parser controls and runtime negative.
Only six explanatory comment lines changed between that parser evidence and Stage C.

Earlier feature batches below retain their own immutable subjects and controls; the
combined result does not claim that every earlier native scenario was rerun on Stage C.
The final source suite includes all their regression tests. Version remains 1.5.10,
the existing VSIX is byte-identical, and the installed extension was not replaced.
There was no commit, tag, package, release or user reload for this development batch.

### Unreleased development batch: native memory gates and wait completion

Native gate Stage B contains 52 files, aggregate
`96640302355995b1ea24c0fe3069d4b09e051534834a7aa53a3260b8db033740`.
Six fresh default/custom-home Codex sessions load complete installed/refreshed bodies
and confirm absence after removal. Omitting the installed block fails the actual request
assertion. The runtime record is
`D:/.ai-work/scratch/acolyte-validation-native-gates-dev-20260928/final-runtime-provenance.json`.

The same stage passes seven real VS Code groups and 16 UI actions/status observations:
activation; Cancel/Install; automatic edits and zero/refill; override migration;
malformed-source retention and Remove; stale review refusal; and visible read-only MCP
receipts. Native sources, unrelated instruction text and shared blocks are preserved.
Install no-op, refresh no-op and hidden receipt controls fail exactly groups two, three
and seven, with preceding groups passing. The unchanged older Stage A fails group five:
malformed quoted scope wrongly empties the installed body. Stage B retains it and reports
the source error. Complete profiles, screenshots and loaded-module witnesses are in
`D:/.ai-work/scratch/acolyte-validation-native-gates-dev-20260928/native-results.json`.

Fresh Codex 0.145.0 runs also reproduced a separate history defect: a direct
`exec_command` followed by `write_stdin` stayed unknown for both zero and nonzero exits.
The parser now joins exact process identity within one rollout and reads terminal
metadata only before stdout. Interactive input, duplicate ownership, conflicting calls
and unrelated IDs do not manufacture a success. Incremental scans widen back to the
owning command when needed and deduplicate the terminal observation.
`D:/.ai-work/scratch/acolyte-wait-runtime-validation-61hUMH/report.json` records two
passing native outcomes and a bridge-disabled control that still executes the command
and wait but fails the outcome assertion. Twelve isolated parser controls are recorded
in `acolyte-wait-history-mutations-41lYsS/report.json`. Revision 3 reopens old completed
cursors once; reverting it fails the new migration test while policy and Claude evidence
remain preserved (`acolyte-wait-revision-mutation-JmpPFV/report.json`). Custom
`functions.exec`/`functions.wait` cell continuation is a separate unverified boundary.

### Unreleased development batch: native semantic recall

The immutable 50-file MCP/semantic Stage A, aggregate
`d2b3c425a1fb623c6acde2bdd5f87f2511414ea0ff68022255e02598de3633a4`, passes seven
CPU runtime groups and four real VS Code groups. The CPU proof exercises the installed
ONNX model through CPUExecutionProvider only, with no downloads or inference service.
It checks zero-BM25 paraphrases, passages beyond one model window, same-size edits with
restored timestamps, deletions, empty corpora, rebuild and profile/cache isolation.
The native run makes five actual UI selections: registry, rollout and skill results,
Rebuild, and keyword fallback. The three semantic queries rank the expected source
first and select its exact text, including the BOM case. Rebuild replaces four valid-shape
poisoned vectors. An unavailable model produces the exact fallback warning and a usable
keyword result while source and cache bytes are preserved.

Central evidence is `D:/.ai-work/scratch/acolyte-validation-mcp-recall-dev-20260928`:
`cpu-semantic/evidence.json` and `native-recall-results.json`. Disabling semantic
retrieval, rebuild and the fallback warning fails exactly native groups two, three
and four, after preceding groups pass. Each control records changed loaded hashes,
advanced timestamps and an executed branch witness, with identical harness hashes.
Screenshots were inspected. Earlier harness-only text/coordinate failures are retained
and are not counted as product failures or successful proof. This establishes these
retrieval cases, not a general quality or performance claim.

### Unreleased development batch: reviewed MCP approvals

`D:/.ai-work/scratch/acolyte-validation-mcp-dev-20260928/results.json` binds the
50-file MCP/semantic Stage A below to six passing real VS Code groups. Seven fresh
Codex processes supply three individually approved successes and one executed failure,
then prove exact-tool reuse without a prompt, a neighboring tool still prompting, and
Undo restoring the original prompt. Actual Cancel, stale review refusal and interrupted
change recovery are included. Separate no-op approval, Undo and recovery writers each
fail exactly their intended native group with changed loaded-module hashes and execution
witnesses. The configuration writer uses native config RPC, preserves other tool/server
settings and project trust, and retains an explicit recovery intent. Plugin or other-layer
server configuration remains read-only. These are development-stage checks, not a release.

### Measured boundary: built-in image viewing and hosted web

Codex 0.145.0 executed three isolated `view_image` cases with a scripted local provider:
a valid generated PNG, a missing file and invalid image bytes. All requested zero
approvals. The valid result contained an `input_image` part in both the persisted output
and the next provider request. Invalid image bytes produced only text, yet still emitted
the same `imageView` completion event with no status. Missing input produced a plain
output string. Evidence: `D:/.ai-work/scratch/acolyte-view-image-probe-hbRWef/evidence.json`.
Replacing the valid fixture with invalid bytes fails the structured-image assertion;
`D:/.ai-work/scratch/acolyte-view-image-mutation-6jSmpc/report.json` records the changed
script hash, advanced mtime and execution witness. No model inference or credentials
were used, and no approval export was needed for these measured calls.

A read-only metadata scan covered all 64 existing rollouts in the current default profile;
there was no distinct ambient `CODEX_HOME` override. Seventy
`event_msg.item_completed` records contained `item.type = WebSearch`, with
`action`, `id`, `query`, `results` and `type` fields, but no authoritative outcome status.
There were no direct `web_search_call` or web end records in this sample. The report at
`D:/.ai-work/scratch/acolyte-builtin-metadata-CvcHSs/metadata.json` retains only event/tool
types, field names, status metadata and counts, not prompts, arguments, URLs or results.
This does not establish successful searches or fresh hosted-web approval behavior. A
scripted provider fabricating hosted search output would not supply that missing proof.
The local protocol schema exposes web availability modes and search options; those are
not evidence of an MCP-style per-tool grant. Built-in observation counters and approval
exports remain absent, with no claim that the platform cannot support another path.

### Unreleased development batch: reviewed stored approvals and project imports

Stage `D:/.ai-work/scratch/acolyte-approvals-dev-20260928-a` has 46 files, aggregate
SHA256 `a51916278925a2ef79846d39317b643fab9f99d3dc8701cbdae8604f311b4dab`.
The receipt explicitly excludes the then-unfinished, unreferenced MCP config module;
the staging wrapper verifies that exclusion has no production require. This is an
immutable test subject, not the subsequently edited checkout.

The focused actual VS Code run passes six groups and seven UI cases: activation;
stored approval Cancel/Apply; project import with accompanying restriction; unsupported
source read-only behavior; a source edit while the confirmation modal is open; and
Finish change after an interrupted reviewed write. Five fresh Codex calls and three
real execpolicy checks accompany the UI checks. Both full proposal dialogs fit the
native viewport, including source, destination, restrictions and scope; the stale refusal
and recovery dialog were also visually inspected.

The stored-approval case changes explicit rule coverage from `git status --short` to
`git status`. Codex's built-in read-only allowance already lets `git status --porcelain`
execute, so approval counts cannot establish a prompt reduction in this case. The first
fixture incorrectly assumed otherwise, and its failed run is retained. The project case
uses a harmless custom executable: before import it prompts, after import another
workspace executes it without prompting, and `--restricted` still prompts. A second
preliminary fixture incorrectly assumed `git diff` was auto-safe; the corrected stale
and recovery cases use measured supported planner inputs. Neither failed attempt is
counted as product proof.

`D:/.ai-work/scratch/acolyte-validation-approvals-dev-20260928/results.json` links the
complete positive and negative profiles and verifies identical harness hashes. A no-op
reviewed writer fails exactly group two after activation passes. A no-op Finish change
fails exactly group six after five earlier groups pass. Both have changed loaded-module
SHA, advanced mtime and branch witnesses, with independent on-disk assertions.

The pure proposal helper has 14 focused tests and 20 killed mutations. Store/UI/worker
and evidence-revision controls have 14 killed mutations in
`acolyte-reviewed-writer-mutations-Nhyi0f/report.json`. Subsequent integration added a
cross-journal check: an interrupted MCP config write also blocks a new or resumed shell
policy write. Its killed mutation is in `acolyte-mcp-review-mutations-UQnw3W/report.json`.
All these paths preserve original authored sources and deliberate-removal suppression.

The later combined MCP/semantic stage has 50 files and aggregate
`d2b3c425a1fb623c6acde2bdd5f87f2511414ea0ff68022255e02598de3633a4` under
`D:/.ai-work/scratch/acolyte-mcp-recall-dev-20260928-a`. The corresponding full source
suite passes 1,042 tests: 1,040 pass, two platform skips, no failures, no source changes
during the run (`acolyte-features-suite-w3Hlil/report.json`). This suite result does not
replace the separate native MCP and semantic UI acceptance work.

### Unreleased development batch: after-turn hook and native memory

Final feature stage `D:/.ai-work/scratch/acolyte-features-dev-20260928-b` contains
45 files, aggregate SHA256
`ac8e3407f63619b4143bd4ac4d5618035f4e81fa00035d5227c574bed21617f1`.
Version remains 1.5.10. No package, installation or release was needed.

`scripts/drive-vscode.js --features-only yes --review-runtime yes` drives the actual
VS Code 1.139.1 UI. All six groups pass: activation; hook Cancel/Configure/Remove;
ambient diagnostics for files created later; native search and inspection; diagnostic
repair/deletion; exact first and later passage selection from a UTF-8 BOM registry.
The last group reproduced a real defect in Stage A before the adapter/UI fix.
Both selected ranges were inspected in editor screenshots, with source bytes preserved.

Central evidence is under `D:/.ai-work/scratch/acolyte-validation-features-dev-20260928`:
`native-positive-b-result.json`, `native-final-custom/acceptance.json` and
`stage-b-provenance.json`. Stage A's no-op hook writer, collapsed selection and disabled
memory watcher fail exactly groups two, four and three respectively. Stage B's wrong BOM
offset fails exactly group six after the prior five pass. Every mutation records changed
loaded-module hash, advanced mtime and branch execution; failed earlier attempts remain
in the record and are not counted as valid controls.

The hook runtime uses actual Codex 0.145.0 Stop callbacks in isolated default and custom
profiles: untrusted configuration does not execute, explicitly reviewed fixture hooks do,
completed failures stay failures, repeated tool-free turns do not duplicate evidence,
and persisted auto-safe mode writes a rule consumed by a fresh process. Installation
preserves foreign hooks and does not modify the trust store. The UI only configures the
hook; Codex's exact-definition review remains required.
These runtime cases are bound to the earlier 42-file hook Stage A, aggregate
`9716a249e22cc55af5112ea0535c4abe8659ba898ccbcdcf428f7fb070a2b8ad`.
Their complete fixture evidence and helper/installer mutation reports are copied with
byte checks into `D:/.ai-work/scratch/acolyte-validation-hook-dev-20260928`; its
`provenance.json` also verifies the frozen stage and unchanged 1.5.10 VSIX.

`scripts/check-codex-memory-runtime.js` verifies native prompt loading from the final
adapter: default and custom profiles each pass three fresh-process cases for disabled
memories, disabled use, and enabled summary use. A missing-summary mutation fails the
enabled-loading witness after the prior two pass. Final evidence lives in
`acolyte-validation-native-memory-dev-20260928/final-default`, `final-custom` and
`final-missing-summary-negative`. The scripted unauthenticated provider captures one
request per case; it performs no inference. Codex itself creates fixture Git metadata
and an ad-hoc instruction file, which the evidence records. Original memory bytes remain
unchanged. This proves summary loading, not memory generation or semantic recall.

CLOSED-VERIFIED for preexisting editor-open learning: the transcript watcher learns a
real completed command without Scan/Review/Apply, and the unchanged one-minute timer
learns a deliberately missed notification. Disabling each callback fails its ingestion
group. The isolated host evidence is
`D:/.ai-work/scratch/acolyte-validation-background-dev-20260928/results.json`, bound
to the earlier immutable recovery Stage B. It does not claim editorless or per-tool timing.

### Unreleased development batch: policy recovery and Codex derived guidance

Final stage `D:/.ai-work/scratch/acolyte-recovery-dev-20260928-b` contains 38 files with
aggregate SHA256 `0bfd4d881ab7aac06545dca9642f06a2fd4aa3e73e530f8b313ebd20da669e2e`.
It retains version 1.5.10; there was no package, installation, tag or release.
Stage A supplied standalone runtime evidence; B differs only in extension.js to show
the entire derived instruction in a modal and guard cancellation after teardown.
Later hook/memory work is separate and does not change this frozen test subject.

The retained catalog is under `<home>/.ai-acolyte/backups`, separate from the usual
default or custom Codex directory. Scans, inventory views and Codex grants retain
literal declarations (`src/codex-rule-store.js:210#backup`). A reset of a Codex directory
that itself contains this backup directory also deletes the backup; this is not
whole-user-home disaster recovery. Computed files and unsupported generated bodies
remain read-only. The feature cannot recover declarations it never captured.

Restore rechecks the displayed original path, existence, hash and saved identity
(`src/codex-rule-store.js:267#restore`). Current decisions and ownership moves are conflicts.
Removed allow overlaps stay excluded, including broader and narrower saved grants.
External prompt/forbidden declarations can be restored. Restored generated grants
become an unowned baseline; surviving workspace claims remain and missing old owners
are not recreated. Effective-policy validation precedes the durable restore intent.
Recovery accepts only recorded before/after bytes, preserving concurrent edits. It
replays the validated transaction rather than rerunning the validator on recovery.

Both default and custom-override layouts passed ten fresh Codex processes and six
execpolicy probes each. Loss restored prompting; selected restoration restored reuse;
intentional removal stayed excluded. Unrelated grants and restrictive sibling rules
survived. Eligibility was synthetic and explicitly reviewed; execution, approvals and
policy validation used actual Codex 0.145.0 with a scripted loopback responder.
Evidence is retained in `acolyte-codex-restore-runtime-q6c0KW` and
`acolyte-codex-restore-runtime-mWJoIr` under the Windows temporary directory.

Derived advice uses current managed policy and per-source evidence
(`derivedFor`, `src/auto-learn-manager.js:1862#derivedFor`; `src/derived-guidance.js:236#deriveCodexMitigations`). It offers reuse of
known Git query results while their scope and repository state remain unchanged.
It does not infer historical approval dialogs, suggest bypassing managed policy,
or copy Claude-specific tool advice into Codex. Unreadable or absent policy preserves
previously installed instructions. Accept/decline reconciles the selected Codex
instruction target independently from Claude.

Before the final modal adjustment, the complete source suite passed 885 tests:
883 passed, zero failed, two platform skips. The final modal has 51 passing focused
checks and two killed body/teardown mutations. Backup/claims checks killed ten isolated mutations, manager/store/worker
checks killed nine, restore UI checks killed fifteen, and derived-guidance checks
killed thirteen. Each mutation names its intended failure and records changed
module hash, advanced mtime and execution witness.

FIXED in development: final Stage B passes nine actual VS Code acceptance groups
on VS Code 1.139.1, extension-host Node 24.20.0. Four restore flows cover Cancel,
missing-rule restoration, intentional-removal exclusion and finishing an interruption.
Derived Accept/Decline are clicked through a full-body dialog; two fresh Codex
processes receive and then lose the exact accepted instruction. Screenshots confirm
that the whole instruction and all decisions fit in the review dialog.

A no-op Restore fails exactly group eight after seven prior groups pass. A no-op
derived Accept fails exactly group nine after eight prior groups pass. Both controls
record the actual button action, changed module hash and executed branch witness,
then fail on missing on-disk output. Earlier incomplete harness attempts are retained
and are not counted as successful mutation checks. Central evidence is at
`D:/.ai-work/scratch/acolyte-validation-recovery-dev-20260928`, including
`native-final-positive-result.json`, both `native-final-*-noop-result.json` files,
`native-final-stage-provenance.json`, runtime reports, mutation reports and screenshots.

### Unreleased development batch: Codex rule inventory and removal

The package version remains 1.5.10. This development batch is tested from an isolated
source staging directory, with no new VSIX, installation, tag or release. The previously
installed 1.5.10 does not contain this feature.

Repeatable development validation uses `node scripts/stage-extension.mjs --out
<new-directory-outside-checkout>`. Point `scripts/drive-vscode.js` at that directory with
`--extension-dir`, `--review-runtime yes`, `--dashboard-ui yes`, `--codex-prune yes`, and
`--codex-layout custom-override`. `scripts/check-codex-prune-runtime.js` uses the same
`--extension-dir` and checks either `--codex-layout default` or `custom-override`.
Staging records file hashes and leaves the manifests, installed extension and VSIX alone.

`parseCodexRules` (`src/codex-rule-inventory.js:155#parseCodexRules`) reads a complete restricted literal
Starlark file or returns an explicit unsupported result with no partial rule list. Declaration spans retain UTF-8
and CRLF text outside the selected declaration (`src/codex-rule-inventory.js:178#removeRuleSpans`).
`inventory` (`src/codex-rule-store.js:77#inventory`) enumerates user
rules under the selected Codex home, preserves source and decision, and requires current
file hashes plus real `codex execpolicy check` validation before removal
(`src/codex-rule-store.js:170-184#found.fileHash`). The extension offers this through Show Codex rules and
the dashboard's Codex prefix rules row.

The shared removal record is scoped to the Codex home. It suppresses overlapping learned
prefixes, including broader grants that would cover a removed narrower command, across
workspaces using current builds. Removing a generated declaration updates every identical
ownership claim while retaining unrelated claims (`src/codex-claims.js:86#pruneCodexClaims`). Ordinary
Undo refuses a snapshot that could restore a suppressed prefix. A transaction for another configured Codex target
refuses after deliberate removals rather than guessing the old target's removal scope.

An interruption retains the intended before/after hashes and bytes. `finish`
(`src/codex-rule-store.js:129#finish`), exposed as "Finish interrupted Codex removal", resumes
only when each target still contains its exact recorded before or
after bytes; a concurrent edit is preserved and requires reconciliation. New Codex writes
and Undo refuse while removal is pending. The last completed removal retains original
bytes in the record. The separate recovery batch above adds retained policy restore.

Limits remain explicit: only allow declarations are removable; prompt and forbidden rules
are inspection-only. Computed Starlark and unsupported literal syntax are read-only.
Generated blocks owned by a different rule target, ambiguous markers, and markers crossing
declarations are also read-only. Other existing matching rules can still allow a command.
Older builds do not read the new removal record. Restart Codex to load changed rules.
Managed/system policy, trusted project rule discovery, session approvals and sandbox state
remain outside this local inventory.

The full suite passes 830 tests: 828 passed, zero failed, and two platform-specific skips.
This includes 15 removal/ownership regressions, nine parser tests and worker routing.
The final confirmation text also passes 72 focused UI/dashboard tests. Ten isolated
store/manager mutations, seven parser mutations and six UI mutations each trigger a
named failure with changed-module hash and execution witnesses.

The final staged extension passes all seven actual VS Code acceptance groups on VS Code
1.139.1 (extension-host Node 24.20.0). Six new inventory flows use actual dashboard,
picker and dialog controls: Cancel, Remove, inspection of prompt and forbidden rules,
inspection of unsupported policy, and Finish interrupted removal. Independent file and
state checks prove cancellation preserves bytes, removal retains unrelated declarations,
and recovery clears the saved intent without touching unrelated files. Screenshots of
the compact confirmation and recovery dialog were also inspected.

Both default and custom-override layouts pass nine fresh Codex processes apiece on
Codex CLI 0.145.0. Removed commands prompt again and declining approval prevents execution;
a second workspace cannot regrant them; unrelated granted commands remain allowed.
Eligibility in these standalone cases uses explicitly labeled synthetic history with real
policy validation and runtime execution. The native suite separately retains its existing
actual-history learning checks. All model responses are scripted loopback fixtures with
no provider inference or credentials.

A runtime suppression mutation recreates the removed rule and fails the named regrant
assertion after seven earlier cases pass. One extra fresh process proves the broken
grant really executes without approval. A no-op actual Remove mutation also fails exactly
the seventh native group after the first six pass, while recording the clicked control
and the executed changed-module witness. A separate no-op Finish removal mutation passes
all five earlier inventory flows, then fails the same group because the pending intent
survives a false success response. Its actual button click and changed-module execution
are witnessed too.

Evidence is retained at `D:/.ai-work/scratch/acolyte-validation-prune-dev-20260928`:
`provenance.json`, `tests.tap`, `default-runtime/evidence.json`,
`custom-runtime/evidence.json`, `native-final-custom/acceptance.json`, mutation reports
and the native screenshots. Provenance verifies all 37 final staged files against current
source. The final stage differs from the standalone runtime stage only in confirmation
text within `autoLearnUi.js`; all runtime modules match. The existing 1.5.10 VSIX hash
remains unchanged. No new package, installation, commit, tag or release was made.

### Earlier packaged checkpoints

The initial packaged extension was 1.5.7; the continuation results below cover 1.5.8,
1.5.9 and 1.5.10.
These checks use isolated profiles and do not
change the user's current editor, instructions or active permission files.

- `node scripts/drive-installed.js --extension-dir <packaged-extension>` invokes packaged
  command handlers with simulated VS Code APIs. It covers Codex scan/apply/diagnose/undo,
  policy decisions, instruction toggles and byte preservation. This is not a real host.
- `node scripts/drive-vscode.js --extension-dir <packaged-extension>` launches the actual
  VS Code application and its extension host. It checks activation, configuration events,
  Codex-only scan, safe apply, real rule decisions and undo. History and gates are synthetic.
  It does not click dashboard controls or exercise the review picker.
- Adding `--review-runtime yes --codex-layout custom-override` connects real Codex
  history, Scan Now, the actual Review checkbox and Grant dialog, fresh-process approval
  behavior, extension Undo, and the actual Codex diagnostic dialogs. This mode uses a private helper development extension
  because VS Code's extension-test mode refuses modal dialogs. It selects the supported
  custom dialog style and drives visible controls through a loopback renderer connection
  restricted to the uniquely named fixture window. The product extension is unmodified.
- Adding `--dashboard-ui yes` to that combined run checks actual Scan, Review, Undo and
  Why buttons, their enabled states, and the guidance and gates controls. It observes
  Codex-only partial state, then exercises Add, Cancel
  and Remove, including a second installation starting with both agents' files empty.
  The renderer uses stock Node CDP and identifies the dashboard's separate Electron
  iframe by its parent target and the exact URL observed in the owned window. It clicks
  real controls and the host independently checks the resulting files and settings.
  The launcher is Windows-only; the recorded command-line Node runtime is 24.16.0.
- `node scripts/check-codex-runtime.js --extension-dir <packaged-extension>` starts four
  fresh Codex processes with a scripted loopback model responder. Without the rule, one
  approval is requested and declined. With the generated rule, the command executes with
  exit zero and its own output witness, without approval. A neighboring argument requests
  approval. Removing the rule restores that request in the next process.
- The same runtime check inspects the first outbound model request: the full packaged
  guidance body, managed gate witness and user-owned instruction are present when enabled.
  After removal, managed content is absent and the user instruction remains. The actual
  generated rollouts are parsed by the selected extension: execution becomes success;
  declined commands never become successful evidence.

The runtime fixture uses on-request approvals, a read-only sandbox, and a shell command
explicitly requesting escalation. Other approval modes are not covered. The responder
performs no inference and uses no provider credentials. It proves
Codex loads the instructions and evaluates/executes the generated policy. It does not prove
that a model follows the instructions. Reports include the runtime version and hashes of
the packaged modules. Removing the generated rule must fail the allowed-case assertion:

    node scripts/check-codex-runtime.js --extension-dir <packaged-extension> --mutation remove-generated-rule

The original September 24 record listed fresh-session prompt and instruction-loading gaps.
A later rewrite dropped those requirements after CLI rule checks. The checks above restore
those outcomes with explicit boundaries. The combined September 28 check closes the
real-history review, rescan deduplication and extension-undo-to-runtime chain. Actual-host
diagnostics now agree with the same runtime transitions for visible local rules. Version
1.5.9 adds actual dashboard instruction-control checks. The continuation also drives all
four Auto Learn buttons through the actual webview routes, with independent state, policy
and fresh-process assertions. Command-only runs remain available without `--dashboard-ui`.

## Validation results for this change

On September 27, the complete Node suite reported 747 tests: 745 passed, zero failed,
and two platform/capability skips. The parser fixes have seven focused regressions;
mutations disabling explicit-shell handling, mixed-call attribution protection, and
pending-process detection each produced exactly one targeted failure.

The final 1.5.7 artifact passed 14 simulated-extension checks, three real extension-host
acceptance groups, and four fresh Codex runtime cases. The real host ran VS Code 1.139.1
with Node 24.20.0; Codex reported 0.145.0. Startup Auto Learn is disabled during the manual
scan assertion so a background scan cannot mask a broken command handler.

Negative controls also failed as intended: a no-op Scan Now command and a no-op safe-apply
command each failed the real-host workflow; removing the generated rule failed the
runtime allowed-command assertion. Simulated-driver mutations separately caught broken
apply, undo, diagnostic output and a missing Codex instruction target.

These results validate the listed paths and are not a substitute for the open feature
and acceptance work above. The new checks are not yet CI jobs.

### Version 1.5.8 continuation, completed September 28

The complete suite reports 777 tests: 775 passed, zero failed, and two platform/capability
skips. The packaged 1.5.8 extension passes all 14 simulated-extension checks in both the
default layout and a custom `CODEX_HOME` with an active override. Four fresh Codex runtime
cases also pass in each layout, including instruction loading/removal and approval behavior.
Packaged code and memory assets matched source bytes. Version 1.5.8 was installed locally;
installed code matched the tested package, with only VS Code installation metadata added
to the manifest. Existing user editor windows were not reloaded.

Migration has 12 focused cases and ten killed mutations. Custom instruction routing,
hidden-block cleanup and dashboard reporting also have targeted mutation evidence. An
isolated copy of the existing learner state normalized without errors; original candidate
counts were retained in the audit archive and the live state stayed byte-identical.

The real VS Code host passes four acceptance groups in each layout, including
replaying three old false successes to zero while preserving the prior grant and undo.
The first fixture used a review-only command; changing it to an eligible read-only command
fixed setup. Disabling the packaged migration in an isolated copy fails exactly that
group on three stale successes; the other groups pass. The host records the changed module
hash and updated timestamp, and the original package remains unchanged. The installed
extension also passes the custom-home host checks, including hidden-block cleanup and undo.

The installed extension passes five groups with the optional combined workflow. Its six
fresh Codex processes cover three individually approved executions, execution after Review
with no approval, a different executable declined, and the original command declined after
Undo. Real script output and execution logs corroborate the runtime events. Background
learning is disabled until after the explicit scan and deduplication assertions, so a
watcher cannot make a broken Scan Now command appear to work. The renderer confirms the
exact candidate, checked checkbox, Grant dialog and successful host completion.
Replacing Review's registered handler with a no-op in an isolated installed copy fails
only the fifth group because no Codex grant appears. The first four groups pass. The
mutant callback's execution witness, advanced timestamp and host-reported module hash
prove the changed entry was executed; installed product files and the original VSIX stay
unchanged.

The three diagnostic dialogs are driven through the real agent picker, shell picker,
command input and result dialog. They check the normalized invocation independently of
the PowerShell wrapper, which can have a different policy result. The selected custom
rules path and stated blind spots are visible, and policy, learner state, runtime
configuration and execution logs remain unchanged during each diagnostic. The first
reader used DOM `textContent`, which loses the dialog's rendered line breaks; switching
to `innerText` corrected the harness without changing the product.

A copied installed entry was then changed to report `allow` for a normalized command
whose real checker returned no decision. The neighboring command still prompted and
was declined in the adjacent Codex process. The actual dialog check failed on that false
allowance, while the four base groups passed. A branch execution witness, advanced module
timestamp and host-reported hash identify the mutant; the installed tree and VSIX stayed
unchanged. Evidence is retained in `native-diagnostic-negative-control-summary.json`
under the local `acolyte-validation-1.5.8` evidence directory.

### Version 1.5.9 dashboard continuation, September 28

Version 1.5.9 corrects collapsed instruction badges when only one agent has the managed
block. Guidance now says `partially installed`; gates say `<count> partially installed`,
consistent with the expanded cards. The regression discovers actual Codex-only files and
also checks both-off and both-on states. Removing either partial-label branch or the
guidance warning condition makes exactly one named assertion fail. The complete suite
reports 778 tests: 776 passed, zero failed, and two platform/capability skips.

The packaged extension passes six real-host groups with the custom Codex home and active
override. The installed extension also passes all six groups with the default Codex home.
The added dashboard group records 11 steps: partial-state observation, Add to
complete partial installation, Cancel and Remove for each block, then Add from both-off
and removal again. Actual files and persisted settings agree with the visible controls;
user text, independent blocks and the inactive base file are preserved. Screenshots show
the corrected partial badges and both-on state. The gate fixture is precompiled and its
quantity is not a memory-compilation check.

Replacing the dashboard's `toggleGuidance` message route with a witnessed no-op in a copied
package fails only the sixth group at guidance Add. The other five groups pass. The
changed module's timestamp, hash and executed route witness prove the mutation reached
the real UI path. Source, canonical package and VSIX bytes stay unchanged. Records and
screenshots are saved under the local `acolyte-validation-1.5.9` evidence directory.

Version 1.5.9 is installed locally. Its code and memory assets match source and the tested
VSIX; the manifest differs only by VS Code installation metadata. Existing editor windows
were not reloaded. The successful dashboard run was unattended. Earlier frame-discovery
and pointer-routing probes are retained as debugging evidence, including one manually
assisted probe that is excluded from the acceptance result. The final driver uses actual
root and child hit tests plus hover before a single press/release for each action.

### Version 1.5.10 continuation, September 28

Focused regressions reproduced two shared-policy defects in the previous implementation: applying
workspace B's unrelated rule removed A's rule, and Undo in A could remove an identical rule
that B still owned. `src/codex-claims.js` now stores target-specific ownership keyed by the
workspace state identity. The writer renders every retained claim, and the ledger is part
of the same backup/rollback/Undo transaction as the policy. Claim-only changes also run
the real policy validator, so a new owner cannot be reported as granted when another
enumerated rule requires a prompt or forbids the command. State version 3 protects the
new transaction target from older writers of the same state; the version 2 migration
preserves evidence.

Twelve focused regressions cover independent workspaces, identical prefixes, custom state
paths, separate rule targets, legacy blocks, malformed ledgers, manual block deletion, rollback
and conservative Undo. Eight isolated mutations each trigger one intended failure, with
changed module hashes, advanced timestamps and execution witnesses. The original installed
1.5.9 also fails the real runtime retention assertion: A runs after its own grant, B runs
after its grant, then A prompts because B removed its rule.

Two additional checks use the packaged manager and actual Codex policy checker: after
A grants a prefix, an enumerated sibling rule changes its decision to `prompt` or
`forbidden`. B's identical claim is rejected in both cases, preserving both workspaces'
state, the shared ledger and all rule bytes.

`node scripts/check-codex-shared-runtime.js --extension-dir <packaged-extension>` checks
single-workspace removal, unrelated workspace grants and identical shared prefixes in
14 fresh Codex processes. Eligibility observations in this runner are synthetic and
explicitly reviewed. Its permission decisions and command executions come from real Codex.
It is separate from the real-history dashboard workflow and does not claim UI coverage.

The dashboard workflow now verifies seven actual button routes: Scan, repeat Scan, Review,
Undo and three Why dialogs. Both scans must advance persisted scan time while background
learning is disabled. Review requires an enabled button, the selected checkbox and Grant;
Undo must become disabled after restoring policy. Diagnostics preserve the claims ledgers
as well as rules, learner state, configuration and execution logs. The simulated legacy
upgrade fixture has no shared ledger, matching a pre-version-3 transaction.

The final 1.5.10 package passes all six real VS Code acceptance groups with a custom
home and active override; the installed copy passes the same six groups with the default
home. Both layouts also pass all 14 shared-rule runtime cases. The complete Node suite
reports 791 tests: 789 passed, zero failed and two platform/capability skips. Thirty-one
code, manifest and memory files match source, package and installation; installation
metadata and the packaging tool's README link rewrite are checked separately.

Five copied dashboard routes were deliberately broken: Scan, only the second Scan,
Review, Undo and Why. Each mutation executes its recorded branch, fails exactly the
combined runtime group at the blocked action, and leaves the four earlier groups passing.
The dependent instruction group is explicitly not run after that failure. Module hashes,
advanced timestamps and branch witnesses establish that each changed package ran;
canonical package, source, VSIX and harness remain unchanged throughout each control.
These results are recorded under `D:/.ai-work/scratch/acolyte-validation-1.5.10`.

Shared ownership has explicit limits. A pre-ledger generated block remains an unowned
baseline, even if its text equals one workspace's grant. Removing or altering a generated
rule stops the next writer instead of being silently reversed. Conflicting Undo refuses;
it does not merge historical snapshots. Older active binaries in other workspaces do not
understand the ledger, so mixed-version writers are not covered. This work supplies the
ownership foundation for inventory/prune; it does not implement deliberate-removal
suppression, inventory UI or high-water recovery.

## Supported version window

| Field | Value |
|---|---|
| Runtime and contract tested | `codex-cli` 0.145.0, Windows, September 27 and 28, 2026 |
| Extension host exercised | VS Code 1.139.1, Node 24.20.0, Windows |
| Also exercised | 0.154.0, Windows, 2026-09-24 audit |
| Declared window | **0.145.0-0.161.0, declared 2026-10-13**, information only; see the October 13 section below |
| Rule syntax | `prefix_rule`, generated by `renderCodexRules` |
| Validator | `codex execpolicy check --rules <file> [--rules <file> …] -- <command>` |

## Version window and Codex 0.161.0 evidence, October 13, 2026

**A window is declared, and it only ever informs.** `src/codex-version.js` lists every
version this repository has exercised and the window they span, and answers which
`codex-cli` the configured executable is. Codex ships often, so a build outside the
window means "not exercised here", never "broken": nothing is disabled, the result's
severity is always `info`, and the dashboard shows it as one muted line in the Codex
card whose row state never reads it. A status that turned amber on every Codex update
would be the always-on false alarm this release removes elsewhere.

| Version | Platform | Date | What was exercised |
|---|---|---|---|
| 0.145.0 | Windows | 2026-09-28 | Fresh-session runtime harnesses (default and custom layouts), real VS Code acceptance groups, execpolicy contract; first exercised 2026-09-27 (the 1.5.7 artifact) |
| 0.154.0 | Windows | 2026-09-24 | CLI-only execpolicy and local-state audit; no runtime harness |
| 0.161.0 | Windows | 2026-10-13 | Execpolicy contract and guidance matrix (winget binary and the npm `.cmd` shim), every CLI-only loopback runtime harness below, code-mode history shapes. NOT exercised: the VS Code acceptance groups and real-history corpora |

Date is the most recent run on that version, the `date` of its entry in
`CODEX_TESTED_VERSIONS`; `test/codex-version-record.test.js` holds this table, and the
declared window above, to that list. The 0.145.0 row read `2026-09-27/28` until
2026-10-14 while the list said `2026-09-28` (v1.6.2 audit): both days are in the record
above (the 1.5.7 artifact on September 27, 1.5.8 to 1.6.0 on September 28), so the list
was right about the latest run and the first day moved into the description.

The status reaches the user three ways: `codexCli` in `wildcard-perms --learn status`
(null, with nothing spawned, when there is no Codex home), the dashboard line, and
`scripts/check-codex-version.js`. The probe is one `--version` spawn with a 5 s timeout,
parsed only as `codex-cli X.Y.Z[-pre]`, cached per executable and resolved file (path,
mtime, size), and never throws. Extending the window means recording a run here and in
`CODEX_TESTED_VERSIONS`; CI refuses a pin that is not in that list.

**CI now asks Codex.** The Node 22 legs of both runners install `@openai/codex@0.161.0`
(a launcher plus per-platform optional dependencies; a `codex`/`.cmd`/`.ps1` shim trio on
Windows), verify that the binary the product would launch is exactly the pin, and set
`ACOLYTE_REQUIRE_CODEX`, which turns the contract and guidance-matrix skips into
failures. Locally, with the npm package in a scratch global prefix and the winget binary
removed from PATH, the check resolves the `.cmd` shim and both files pass 12 of 12. The
Node 20 legs stay without Codex on purpose. In an Alpine Node 22 container the same npm
install printed `codex-cli 0.161.0`; the full Linux suite was not run there (the
container host stopped mid-session), so the ubuntu leg is first verified by CI. No
runtime-harness job was added: the harnesses are deterministic on this machine (three
consecutive runtime and wrapper runs agree) but they drive Codex's real sandbox and
approval path, which has not been observed on a hosted runner, and most target Windows.

**Runtime harnesses against 0.161.0.** One staged subject
(`acolyte-stage-c1-final-20261013`, 55 files), Windows, isolated homes, scripted loopback
responder, no credentials. Evidence directories are named; all are under the temp root.

| Harness | Result | Evidence |
|---|---|---|
| `check-codex-runtime.js` | 4/4 default, 4/4 custom-override, 4/4 twice more; `remove-generated-rule` fails case 2 | `acolyte-codex-runtime-S5oQTi`, `-nUKTcQ`, `-ngzFo6`, `-fcHPL0`; mutation `-BjTPi0` |
| `check-codex-hook-runtime.js` | 5/5 CLI turns + 1/1 fresh process, both layouts | `acolyte-codex-hook-runtime-uKQc7B`, `-ALm2Pe` |
| `check-codex-wait-runtime.js` | success and nonzero exit, each through a real `write_stdin`; a process-bridge-disabled subject fails the parser witness | `acolyte-wait-completion-hQMxRk`; control `-CnXigt` |
| `check-codex-memory-runtime.js` | 3/3 both layouts; `omit-summary` fails 2/3 | `acolyte-codex-memory-runtime-ApZ9C0`, `-eRhDwJ`; mutation `-7JspV6` |
| `check-codex-native-gates-runtime.js` | 3/3 both layouts; `omit-native-block` fails 0/3 | `acolyte-native-gates-runtime-IBmDrt`, `-lI7MPe`; mutation `-4oo0ZP` |
| `check-codex-prune-runtime.js` | 9/9 both layouts | `acolyte-codex-prune-runtime-1oPevh`, `-bfqZJl` |
| `check-codex-restore-runtime.js` | 10/10 both layouts | `acolyte-codex-restore-runtime-Lv8wA0`, `-T6hezK` |
| `check-codex-shared-runtime.js` | 3/3 groups, 14/14 processes, both layouts | `acolyte-codex-shared-runtime-ZjXq1l`, `-JJH92L` |
| `check-codex-mcp-runtime.js` | every Codex fact passes; the history parser recognises 0 of 5 outcomes, so it FAILS (product defect below) | `acolyte-codex-mcp-runtime-ddsfLK` |
| `check-codex-code-mode-runtime.js` | passes; regenerated fixture byte-identical to the committed one | `acolyte-code-mode-Ykg4PU` |
| `check-codex-wrapper-runtime.js` | 13/13 agree + 2 observations, three runs; `empty-rules` fails exactly the 4 allow cases | `acolyte-codex-wrapper-runtime-zrAKV2`, `-6WvaNr`, `-3Hkuac`; mutation `-bmt91J` |
| `check-codex-project-rules-runtime.js` | 11 sessions pass (another change's harness, rerun here) | `acolyte-codex-project-rules-VovCEF` |

Not run: `check-codex-recall-runtime.js` starts no Codex at all (CPU embedding
acceptance), and `drive-codex-background.js` / `drive-vscode.js` launch an isolated VS
Code, outside this CLI-only pass.

**Harness drift found and fixed, none of it a product result.** (1) 0.161.0 no longer
offers `shell_command` to the fixture model; its default, `unified_exec = false` and
`code_mode` catalogs expose `exec_command`/`write_stdin`. The responder now reads the tool
names from the request it receives and prefers `shell_command` when offered, so older
binaries keep their recorded shape. (2) `exec_command`'s yield is clamped to 10-30 s on
Windows, so the wait canary's 3.5 s process finished in its first call; it now runs 12 s.
(3) Codex canonicalizes an 8.3 short temp path to its long form before injecting the
memory root; both spellings are accepted. (4) The MCP rollout shape changed, below. Also
recorded: these temp workspaces sit inside the developer's home directory, which on this
machine is itself a git repository with its own `AGENTS.md`, and 0.161.0 loads that file
as project instructions in every fresh session. It is read only, sent only to the loopback
responder and kept only in temp evidence; every assertion uses unique witnesses, so no
result depends on it, and nothing from it entered a tracked file.

**Product defect: MCP outcomes on 0.161.0 are invisible to the history parser.** 0.145.0
wrote `event_msg/mcp_tool_call_end` with `{invocation, result: {Ok|Err}}`, which is the
only shape `codexMcpObservation` in `src/history-adapters.js` reads. 0.161.0 writes none;
each outcome is an `event_msg/item_completed` whose item is `{type: "McpToolCall", server,
tool, status, result: {content, isError}}`, or `{status: "failed", error: {message}}` when
declined. All five runtime cases produced zero MCP observations, so reviewed MCP approvals
learn nothing from 0.161.0 history. Approvals themselves still apply; only the evidence
counts are lost. Not fixed in this change because that parser is being edited
concurrently; the MCP harness fails until it is, and names each case.

**Code-mode cell continuation is observed, and bounded.** With `code_mode` enabled in an
isolated home, 0.161.0 exposes `exec` (a custom, grammar-format tool) and `wait`. A cell
that finishes inside its yield window returns "Script completed" plus the nested
`exec_command` JSON with `exit_code` as its own `custom_tool_call_output`; the parser
credits those correctly. A yielded cell returns "Script running with cell ID N", and its
completion arrives as the `function_call_output` of the later `wait` call, linked to the
cell only by that ID; IDs are allocated per session in order. The parser leaves continued
cells `unknown`: no success is invented, and a nonzero continued run is not counted as a
failure either. `test/codex-code-mode-history.test.js` pins that limit beside the safety
property (true outcome or withheld, never the opposite) on the sanitized real fixture
`test/fixtures/codex-code-mode-rollout-sanitized.jsonl` and two derived interleavings.

**The shell guidance's Codex claims hold on 0.161.0, at both layers.**
`codex execpolicy check` matches raw argv by prefix and never interprets a shell:
`test/codex-guidance-matrix.test.js` passes 20 of 20 rows (shell and PowerShell wrappers,
`cmd /c`, `env`, script files and their hosts, a `VAR=value` prefix and absolute paths get
no match from the inner rule; a chain passed as argv tokens is matched by its first
prefix). Chain splitting is a runtime property, so the wrapper harness asks a fresh
app-server: on Windows (default shell pwsh 7) `&&`, `;` and `|` chains of allowed commands
ran without a prompt, while a chain with one new command, a redirection, a `$()`
subexpression, an `$env:` assignment chain, `cmd /c`, `pwsh -Command`,
`powershell -Command` and an absolute path all prompted and executed nothing. Recorded,
not claimed: an `exec_command` naming `shell: "bash"` on Windows ran Git Bash by absolute
path and no prefix rule applied to it, not even a single allowed command. The POSIX case
list (`VAR=value cmd`, `bash -c`, `sh -c`) has not run yet. No guidance text changed.

**Runtime provenance is derived.** The runtime harness hashed six hand-picked modules;
`src/policy-exporters.js` now requires `src/auto-learn.js`, which requires
`src/tool-learn.js`, so neither change reached the record. The hashed set is now the local
require closure of those six (eleven files today), checked against the modules that
actually loaded on every run (`test/runtime-provenance.test.js`).

Superseded by this section: the "Declared window: none yet" row above, the "One platform,
one recorded contract-tested version" paragraph under Still not proven, and the CI
paragraph below.

## Codex 0.161.0 follow-up, October 13, 2026: harness isolation and history-parser gaps

Added after the section above; it amends that section where it says so and replaces none
of it. Same machine, `codex-cli` 0.161.0, Windows, isolated temp homes, scripted loopback
responder, no credentials.

**The harness workspaces are their own project roots now, and a canary proves it.** The
section above records that 0.161.0 loaded the developer's home `AGENTS.md` into every
fresh harness session. One correction to it: the home directory is not a git repository.
Its `.git` is a directory holding only a credentials file, which git itself rejects, and
Codex counted it anyway, because the `AGENTS.md` walk tests a `.git` by existence. Measured
through `runtimeCase` in a temp tree (`acolyte-root-probe-SIgiRe`): an empty `.git` in the
workspace stopped the walk there; without one, an empty `.git` one level up became the
root, its `AGENTS.md` was loaded, and the home file was not. The same empty directory
counts for nothing else: project layers and trust ignore a `.git` that is not a repository
(the project-rules record above), the product's own repository check requires `HEAD`, and
git rejects it. So `isolateWorkspaceInstructions` in `scripts/check-codex-runtime.js`
gives each workspace an empty `.git` (an existing one, such as the hook harness's real
repository or a worktree's `.git` file, is left alone) and puts a canary `AGENTS.md`
beside an empty `.git` of its own in the workspace's parent, refusing to plant outside the
temp tree or in its root. Every harness that drives a session asserts the canary is absent
from every request its loopback receives. The chain Codex loads is contiguous from the
root down to the cwd, so a root anywhere above the workspace puts the canary in the
request, and the parent's own `.git` makes that true on a machine whose home has no marker
at all. `project_root_markers` was not used: any mention of it in `config.toml` widens
`src/codex-policy.js`'s candidate scan to every ancestor `.codex` folder, the real
`~/.codex` included, which a harness modelling a typical profile should not do.
`scripts/vscode-acceptance/mcp.js` reuses the MCP case with the VS Code driver's own
workspace, so the check is opt-in in that shared case; the acceptance suite does not ask
for it and was not run here.

Mutation: with the workspace marker removed, the code-mode harness failed 5/5 sessions
(`acolyte-code-mode-AcCa5r`, canary in every rollout, home file in none) and the runtime
harness failed its first case (`acolyte-codex-runtime-MVboeg`). Restored byte-identical.

| Harness | Result after the change | Evidence |
|---|---|---|
| `check-codex-runtime.js` | 4/4 default, 4/4 custom-override | `acolyte-codex-runtime-hS8yLU`, `-bhN2Wr` |
| `check-codex-hook-runtime.js` | 5/5 CLI turns + 1/1 fresh process, both layouts | `acolyte-codex-hook-runtime-JxzZr0`, `-CI297T` |
| `check-codex-wait-runtime.js` | success and nonzero, each through a real `write_stdin` | `acolyte-wait-completion-jqr9A8` |
| `check-codex-memory-runtime.js` | 3/3 both layouts | `acolyte-codex-memory-runtime-T1TKbK`, `-iKXz5m` |
| `check-codex-native-gates-runtime.js` | 3/3 both layouts | `acolyte-native-gates-runtime-MviJNi`, `-ZIu96J` |
| `check-codex-prune-runtime.js` | 9/9 both layouts | `acolyte-codex-prune-runtime-w7xpvh`, `-ycylZZ` |
| `check-codex-restore-runtime.js` | 10/10 both layouts | `acolyte-codex-restore-runtime-Gdo5l2`, `-FZDeeF` |
| `check-codex-shared-runtime.js` | 3/3 groups, 14/14 processes, both layouts | `acolyte-codex-shared-runtime-Il4ksY`, `-HCBH4Q` |
| `check-codex-wrapper-runtime.js` | 13/13 agree + 2 observations | `acolyte-codex-wrapper-runtime-e06QTL` |
| `check-codex-project-rules-runtime.js` | 11 sessions pass, so the empty `.git` moved no rule or trust result | `acolyte-codex-project-rules-zhhviB` |
| `check-codex-code-mode-runtime.js` | passes | `acolyte-code-mode-fPP7Qf` |
| `check-codex-mcp-runtime.js` | every Codex fact and the canary pass; the parser check still fails 5/5 on this subject (fixed below) | `acolyte-codex-mcp-runtime-LLYYvB` |

None of those evidence trees contains the home file's content; `acolyte-codex-mcp-runtime-ddsfLK`
from the section above does. One limit stays: the project-rules harness's plain-folder
cases still get their project LAYER root from whether the home is a real repository,
which no empty marker can change without changing what those cases measure.

**MCP outcomes on 0.161.0 reach the history parser.** This closes the product defect the
section above reports. `codexMcpObservation` in `src/history-adapters.js` now also reads
`event_msg/item_completed` with an `McpToolCall` item, and maps it onto the old record's
meaning: `completed` with `isError: false` is success, `isError: true` is failed whatever
the status, and a declined call (`failed` with `error`, the old `Err`) is failed. An
`error` beside a `result` is failed, as `Err` beside `Ok` was; anything else (no `isError`,
a non-boolean one, no result, a status still in progress) is withheld as unknown. Only a
direct `event_msg` record counts. The item's `id` is the call id (it equals the namespaced
`function_call`'s `call_id` on all five rollouts), so both shapes hash to the same
observation id and a rollout carrying both counts the call once; 0.161.0 wrote none of the
old records, so that merge is tested on a derived file. The sanitized fixture
`test/fixtures/codex-mcp-item-completed-sanitized.jsonl` is the five case rollouts,
written by the harness's new `--write-fixture`; two consecutive runs wrote byte-identical
files. `test/codex-mcp-item-completed.test.js` pins the five real verdicts, the status
mapping, the spoof refusals, the cross-shape identity against a pre-change pinned id, the
append-then-full-read identity and a sanitization gate; `test/codex-mcp-history.test.js`
(the 0.145.0 shape) is unchanged and passes.

The MCP harness against this checkout now passes, parser included: 5/5 cases, verdicts
failed, success, failed, failed, success (`acolyte-codex-mcp-runtime-NkOEE2`, `-cKyzNs`,
`-nPg2mE`). Against the pre-change parser it fails 5/5, as recorded above
(`acolyte-codex-mcp-runtime-LLYYvB`). Mutation: eight parser mutants (the new shape unread,
a separate identity for it, a decline read as unknown, `completed` as success without
`isError`, `isError: true` ignored under `completed`, `error` beside `result` ignored, the
item accepted from any record type, the type matched case-insensitively) were each killed.
Not changed and not run: `scripts/vscode-acceptance/mcp.js` still asserts the 0.145.0
`mcp_tool_call_end` record and will fail on 0.161.0 until it accepts both shapes.

**Code-mode cells continued by `wait` are joined to their outcome.** This replaces the
bounded limit the section above records, and amends the matrix row "Shell history scan
and outcome learning" and the "History coverage is still bounded" paragraph under Still
not proven: code-mode cell continuations are no longer outside the proof on 0.161.0. The
harness gained two shapes. A cell whose command outlasts its waits yields AGAIN from a
`wait` with the same header ("Script running with cell ID 5"; 12 s against 5 s waits gave
two repeated yields and a completing third wait, so the wait is not clamped the way
`exec_command`'s yield is), and `wait` with `terminate: true` returns "Script terminated".
`codeModeJoin` in `src/history-adapters.js` opens a cell on its yield, keyed by session
and cell ID, and binds each `wait` result to the single open cell with that key: a
repeated yield keeps it open, a terminal result closes it and the cell's own output plus
every bound result are applied as one result through the same group rule a directly
completed cell meets, and a terminate (the argument, read wide, or a "Script terminated"
result) closes it with nothing applied. Two open cells with one key, a wait whose own
definitions disagree, a wait for an ID never yielded and a repeated yield naming another
cell are all withheld. Only the header line counts, so a cell's stdout cannot open, close
or credit anything, and a yield is applied as pending, which also closes a gap that
predates the join: a yielded cell whose stdout said "Script completed" used to be
credited with success. A bound result whose cell is outside an append slice is reported
through `_codexUnmatchedWaits`, so the scanner's bounded reconcile widen reaches it and
the cell comes back under its full-read identity and verdict. One exception is recorded
in the code: a conflicting open cell older than the slice's start is invisible to the
slice, which then binds where a full read withholds; it needs two runtimes allocating
IDs in one session, and the slice's verdict is still never the opposite one.

The sanitized fixture now holds six cells (the first four byte-identical to wave c1's;
three runs wrote byte-identical files). Harness on 0.161.0: against the parser before the
join it fails exactly the four continued cells (`acolyte-code-mode-FGjN3U`: continued
success, continued failure, re-waited success and the sequence's cell 3 read `unknown`);
with the join it passes 7 sessions, verdicts complete success, complete failure,
continued success, continued failure, re-waited success, terminated withheld, and the
same six in one session (`acolyte-code-mode-gdcdgw`, `-q7K3zz`). The harness now asserts
those exact verdicts rather than "true or withheld". Mutation: fifteen parser mutants
were each killed by `test/codex-code-mode-history.test.js` (join disabled; binding by
recency instead of ID; the first of two open cells bound; terminate credited; a
"Script terminated" result treated as a completion; terminate read only as `true`; a
repeated yield treated as terminal; a repeated yield naming another cell accepted; a
yield not pending; a yield line matched anywhere in the output; IDs not scoped by
session; disagreeing wait definitions accepted; join results not handed to the scanner;
a wait for an unseen cell not reported; a bound result with no call in the slice not
reported).

## Codex 0.161.0 follow-up, October 13, 2026: acceptance-suite MCP shapes, session-scoped call groups, code-mode continuity

Added after the section above; it amends that section where it says so and replaces none
of it. Same machine, `codex-cli` 0.161.0, Windows, isolated temp homes, scripted loopback
responder, no credentials.

**The VS Code MCP acceptance suite reads both rollout shapes.** This closes the "Not
changed and not run" line above. `scripts/vscode-acceptance/mcp.js` checked each real MCP
outcome by filtering for the 0.145.0 `mcp_tool_call_end` record alone, which 0.161.0 never
writes, so every case would have failed before any product behaviour was checked. The
Codex-side check is now one function, `assertMcpRolloutOutcome` in
`scripts/check-codex-mcp-runtime.js`, called by the harness's own `main()` and by the
suite: each shape present must name the expected server and tool, an executed call must
carry its result with the expected `isError` (and, in the new shape, the item's own
`status`), and a declined call must carry an error and no result. It deliberately does not
read the rollout through the product parser, whose verdict `main()` checks separately. The
suite also opts into the instruction-isolation canary when its workspace's parent is
inside the temp tree, which is where `drive-vscode.js` puts it, by the same test
`isolateWorkspaceInstructions` applies (`workspaceUnderTempTree`), and then requires every
provider request to have been checked. The driver itself was not run (VS Code has a
pending update that blocks new instances). `test/vscode-acceptance-mcp.test.js` proves the
assertion on the five real 0.161.0 rollouts
(`test/fixtures/codex-mcp-item-completed-sanitized.jsonl`), on the same outcomes rewritten
into the 0.145.0 record, and on both together; shows the suite's former check rejects all
five real rollouts; and pins the suite's source. MCP harness on 0.161.0 through the shared
assertion: passed, 5/5, shape `item_completed/McpToolCall`, no parser misses
(`acolyte-codex-mcp-runtime-k0COwe`). Mutation: fifteen mutants were each killed (either
shape unread; `isError` uncompared in either shape; a declined item allowed a result;
`status` uncompared; any record type counted; duplicates accepted; result content ignored;
the temp predicate accepting the temp root, or paths outside the temp tree; `main()` off
the shared assertion; the suite not asking for the canary check, not requiring every
request checked, or not isolating its workspace), and the suite as it stood before this
change fails the source test.

**A call is grouped with its result inside its own session.** `parseCodexJsonl` joined
each call to its result through maps keyed by the call id alone, while everything else it
joins (observation identity, unified-exec process ids, code-mode cell IDs, MCP identity)
was already scoped by session. So two sessions in one rollout file that reused a call id
shared one group: the second session's real successes were withheld, and either session's
failure was applied to the other's call of the same id (a direct `exec_command` success
read `failed` because the other session's call failed). Real call ids are unique and a
rollout Codex writes holds one session, so this is defence in depth, but the five real MCP
rollouts concatenated in the MCP fixture all use one call id. The key is now (the session
in effect at the record, call id), the scope identity already uses, so no observation id
moves: `test/codex-session-call-groups.test.js` pins ten ids taken from the parser before
the change (the six real code-mode cells, a direct and a `write_stdin`-finished
`exec_command`, a call with no call id, and a call after a fork head, which keeps the
parent file's own id), and they pass before and after. It also shows each of two sessions
sharing every call id reads exactly as it reads alone, in either order and with a
failure in one, and that an append slice of a forked rollout reaches the full-read id,
session and verdict: through the overlap, through the bounded widen, and from the head
seed alone when the slice starts at the call. The code-mode session-scope test now runs
with shared call ids as well as renamed ones. Against the parser before the change, the
three shared-id tests fail and the identity and append tests pass. Mutation: eight
mutants were each killed (groups keyed by call id alone, by cwd, or by the slice seed
instead of the in-order session; the wait join looking its cell up outside its session;
a previous result merged across sessions; identity gaining the command or losing the
session; the append seed applying only the first head `session_meta`).

**Code-mode cells across turns, resumes and forks, measured; a wait across a reload is no
longer read as the cell's failure.** The code-mode harness drives a case as steps now
(turns, app-server restarts, `thread/resume`, `thread/unsubscribe`, `thread/fork`, and
`codex exec` / `codex exec resume` processes), and its sixteen continuity cases assert
what they measured. Only a yield names a cell's ID, so the probe cells yield. Measured:

- *Across turns*: a cell left running at the end of a turn survives into the next turn of
  the same process, where a wait returned its completion, and allocation continues (1,
  then 2). A `thread/resume` inside the same process, also after `thread/unsubscribe`,
  keeps the runtime the same way.
- *Resume*: a resume into a new process (app-server `thread/resume` with or without
  overrides, and `codex exec resume`) appends to the same rollout file, writes no new
  `session_meta`, and restarts allocation at 1 (cells 1, 2, then 1). A cell left running
  at the restart is gone: its nested command is recorded failed with exit -1 at shutdown,
  and a wait for its ID gets the runtime's own answer, `Script failed` / `Script error:
  exec cell 1 not found`. A wait for a cell that already completed gets the same answer,
  so a reused ID can never hand an old wait a new cell's result.
- *Fork*: `thread/fork` writes a new rollout whose one `session_meta` is the fork's own,
  with `forked_from_id`, and none of the parent's items; the fork allocates from 1, the
  parent continues its own sequence (1, 2, then 3), and a wait in the fork for the
  parent's running cell gets "not found".

So (session, cell ID) does name two cells in one file after a resume. A closed cell never
collides with a later one, and a resumed session whose cells all finished reads exactly.
The defect was the open one: the parser bound the runtime's "not found" as that cell's
terminal result, and its "Script failed" header credited a cell whose command had been
killed with a failure (cases `resumed-open-cell`, `resumed-reallocated`,
`exec-resumed-open-cell`). `codeModeMissingCell` in `src/history-adapters.js` recognises
the exact two-part answer, for the ID the wait itself named, and the join closes every
open cell under that key with nothing applied, as for a terminate, and reports nothing
for a widen. No resume epoch was added to the key, because none is needed and the one
candidate marker is wrong: a reload writes `event_msg/thread_settings_applied`, but so
does a same-process turn whose `turn/start` carries setting overrides, and the cell
running across that turn survived and completed (`turn-overrides`). What remains is a
cell left open at a reload whose ID the new runtime hands to a new cell before anything
waits on the old one: two open cells under one key, both withheld by the existing rule
(`resumed-reused-id`; the new cell really succeeded, and that is the coverage the rule
gives up). The append-slice exception the code-mode section records is now reachable by
a resume and is pinned in its measured shape: a slice that starts past the old cell's
yield binds the new cell to its own true outcome where a full read withholds, under the
same id, never the opposite. How a script's own throw is written was measured too: a
thrown `Error` carries `Error: ` and a stack line, which the shape excludes, so the cell
stays failed (`thrown-not-found`); a thrown bare string is written exactly as the
runtime's answer, so that cell reads as stopped, withheld and never credited
(`thrown-string`). A command's stdout cannot write that part; only the cell's own script
can, naming the very cell it runs in.

`test/fixtures/codex-code-mode-continuity-sanitized.jsonl` holds the eighteen thread
rollouts of those cases, sanitized as the sequence fixture is, and two consecutive runs
wrote byte-identical files. `test/codex-code-mode-continuity.test.js` pins every measured
fact above from the fixture, every cell's exact verdict alone and in one file with the
rest, the defect and its control, the exact-shape refusals (another cell's ID, a third
part, another header, stdout below `Output:`, one string, trailing text, a thrown
`Error`'s spelling, the cell's own output), the two open cells, the absent widen, the
append-slice identity across the resume boundary, the bounded exception, and a
sanitization gate. Against the parser before this change, six of its eight tests fail.
Harness on 0.161.0: all 23 sessions pass, every verdict exact, and the regenerated
sequence fixture is byte-identical to the committed one (`acolyte-code-mode-O6Tlx6`); a
second run of the sixteen continuity sessions passed and wrote a byte-identical
continuity fixture (`acolyte-code-mode-A9EyII`). Against the parser before this change,
exactly the four cells the fix is for fail, each read `failed` (the three stopped cells
and the thrown bare string), and `resumed` passes (`acolyte-code-mode-YurUAM`).
Mutation: ten parser mutants were each killed (the answer ignored; accepted for any
cell ID; leaving the cell open; reported for a widen; its head allowed stdout or any
header; more parts allowed; trailing text allowed; a thrown `Error` accepted; the shape
read from a cell's own output). Not measured: an interactive `codex resume` in the TUI,
which this harness may not drive; two runtimes writing one session at once; and forks by
the older builds whose rollouts open with two `session_meta` records (the archive
section), where the fork's own cells share the parent's scope and a collision with a
parent cell left open would be withheld by the same rule.

## Codex 0.161.0 follow-up, October 13, 2026: a refused nested command is not a cell's failure

Added after the section above; it amends none of it. Same machine, `codex-cli` 0.161.0,
Windows, isolated temp homes, scripted loopback responder, no credentials.

**A code-mode cell whose nested command Codex refused is withheld, as the same refusal on a
direct call already is.** Found while the continuity cases were written: under `codex exec`
(approval never), a cell whose nested `tools.exec_command` asked for escalation read
`failed`, though its command never ran. Auto Learn's rule is that a confirmed failure is
negative evidence and a requested call that never ran is no evidence at all, so the verdict
was conservative but not true. The direct-call treatment was checked first, because it is
the one to mirror: on 0.161.0 a declined direct `exec_command` writes
`exec_command failed: CreateProcess { message: "Rejected(\"rejected by user\")" }` as its
whole output (the project-rules harness's declined cases, `acolyte-codex-project-rules-ar7WsG`),
which carries no exit code and no script wording, so the parser reads it `unknown`. Declined
direct calls are not counted as failures; nothing pinned that reading until this change. The
code-mode harness gained three refusal cases. Each puts a refused call beside one that ran
and exited nonzero, as a cell and as a direct `exec_command` call, and each script's first
act creates a marker file, so which commands ran is read from disk:

- `refused-never`: `codex exec`, approval never, an escalation request. No prompt; the
  refusal is `approval policy is Never; reject command — you cannot ask for escalated
  permissions if the approval policy is Never`.
- `declined`: an app-server prompt answered `decline`; the refusal is the declined direct
  call's message above.
- `declined-after-yield`: the decline answered 3 s late, so the cell yields first and the
  refusal arrives as its `wait`'s result.

A direct call's whole output is the message. A cell's result is `Script failed` with nothing
under `Output:` beside `Script error:` plus the same message, word for word: the nested call
fails with the direct call's own words, and the script dies of it. `codeModeRefused` in
`src/history-adapters.js` recognises exactly that two-part shape (it shares
`codeModeScriptError` with the not-found answer) carrying exactly one of the two measured
messages, and the parser applies such a result as `unknown` with no nested status, in the
cell's own result and in a `wait`'s result, where it still closes the cell. That is the
declined direct call's reading, and the direct shape itself is untouched. A cell whose
command ran and exited nonzero stays `failed`; it sits beside the refused one in every
session. A command's stdout cannot write the shape. A script that throws one of the
messages as a bare string can, as `thrown-string` measured for not-found, and that cell
reads withheld, never credited.

`test/fixtures/codex-code-mode-refusal-sanitized.jsonl` holds the three rollouts, sanitized
as the continuity fixture is (a direct call's `Chunk ID` and `Wall time:` are normalised
too; neither occurs in the older fixtures), and two runs wrote byte-identical files.
`test/codex-code-mode-refusal.test.js` pins the measured texts and shapes, every call's
verdict alone and in one file, parity between each refused cell and its refused direct
call, the never-the-opposite property on these records, the exact-shape refusals (a thrown
`Error`'s spelling, leading or trailing text, a third part, stdout below `Output:`, one
string, no `Script error:` prefix, another policy named, another rejection reason), the
refusal through a wait closing the cell, the direct shape unchanged, append-slice identity
across the refused cell's wait, and a sanitization gate. Against the parser before this
change, five of its seven tests fail. Harness on 0.161.0: all 26 sessions pass, every
verdict exact, and the sequence and continuity fixtures regenerate byte-identical to the
committed ones, in two full runs (`acolyte-code-mode-7jTzKY`, `-J7BWuv`, the second
against the committed parser and harness bytes); those two and a run of the refusal cases
alone wrote the same refusal fixture (`acolyte-code-mode-PC4DDT`). Against the parser before this change,
exactly the three refused cells fail, each read `failed`, and both refused direct calls
read `unknown` (`acolyte-code-mode-y1hnyf`). Mutation: fourteen parser mutants were each
killed (the refusal unrecognised; the cell's own result, or a wait's, not neutralised, or
keeping its nested status; any script error, or /reject/i, accepted; any head after
`Script failed`; more parts; no prefix needed; either measured message dropped; the
neutralisation widened to direct outputs; a refusal through a wait leaving the cell open).

**Not changed, and inconsistent with that rule: a declined MCP call counts as failed.**
The MCP reader maps a declined call (`status: failed` with `error`, the old `Err`) to
`failed` (the MCP section above; `codexMcpStatus` reads `Err` the same way). A declined
MCP call never ran either. It is a different record with its own consequences for reviewed
MCP approvals, so it is left for a change of its own rather than altered beside this one.
Not measured here: other refusal sources (an execpolicy `forbidden` rule, a Guardian or
auto-review denial, an approval aborted rather than declined, and a nested
`tools.shell_command`), whose messages this parser does not know and so still reads, in a
cell, as the script's failure.

## Codex 0.161.0 follow-up, October 13, 2026: a declined MCP call is no evidence either

Added after the section above, and it closes that section's "Not changed" paragraph. It
also amends the MCP section's mapping ("a declined call ... is failed") and the MCP
harness's recorded verdicts; nothing else is replaced. Same machine, `codex-cli` 0.161.0,
Windows, isolated temp homes, scripted loopback responder, no credentials.

**A declined MCP call reads `unknown`, as a declined shell call does.** The rule is the
shell readers' rule: a confirmed failure is negative evidence, and a requested call that
never ran is none. The MCP harness's two declined cases (`default-prompt-decline`,
`neighbor-remains-prompt`, where the local server's log shows no `tools/call`) were
re-measured. The rollout's `McpToolCall` item is exactly `status: "failed"`, `error:
{message: "user rejected MCP tool call"}`, and no `result` key. The 0.145.0 record of a
decline is `result: {Err: "user rejected MCP tool call"}`. That is the shape measured on
real 0.145 rollouts on September 28 and transcribed into `test/codex-mcp-history.test.js`;
no 0.145 binary is on this machine to measure again, and it is the same message 0.161.0
writes. A sixth case, `exact-approved-server-error`, was added: the fixture server answers
`tools/call` for a `crash` tool with a JSON-RPC error. Codex records that call in the
decline's own structure (`status: "failed"`, an `error`, no `result`) and differs only in
the words. Its message is "tool call error: tool call failed for" plus the backquoted
`fixture/crash`, a blank line, then `Caused by:` and an indented `Mcp error: -32603:
acolyte-mcp-crash-witness`. So a reader keyed on structure alone would have withheld a
real failure.

`codexMcpDeclinedItem` and `codexMcpDeclinedEnd` in `src/history-adapters.js` recognise
only those exact decline shapes. The 0.161.0 item must have exactly that one-key error
with a failed status and no result; the 0.145.0 record must be exactly that single `Err`.
Such a decline is read `unknown`, and its identity is unchanged: the pinned
`codex:716a610061674ce24a251479` does not move. Everything else that fails stays `failed`:
a tool that ran and returned `isError: true`, a call the server failed, and any other
`Err`. A decline still vetoes a success recorded for the same call. One call written
both declined and succeeded (two shapes, or a repeated record) is contradictory and is
withheld, as conflicting identities are, while a failure beside a decline still wins.
Codex MCP candidates are review-only at every threshold (`autoSafe: false` in
`src/auto-learn.js`; review eligibility counts successes only, `src/codex-mcp-review.js`),
so this moves a decline from the failed to the unknown count shown in review and never
decides a grant. Stored evidence from rollouts already scanned keeps its old verdict
until `CODEX_EVIDENCE_REVISION` (`src/auto-learn-manager.js`) is next raised. None of the
2026-10-13 parser changes raised it.

`assertMcpRolloutOutcome` in the MCP harness asserts rollout facts, not the parser's
verdict, so none of its existing expectations changed. It gained an optional
`errorMessage`, the exact recorded error, which the harness passes for both declines and
the server error. The VS Code MCP acceptance suite passes none, so it asserts exactly what
it did. Its learned counts (three successes, one `isError` failure) come from calls that
ran and are scanned before any decline, so they do not change either. The harness's own
parser expectation had encoded "declined = failed" and now names each case's verdict.
`test/fixtures/codex-mcp-item-completed-sanitized.jsonl` gained the sixth session, and its
first five are a byte-identical prefix of the fixture before this change. The tests:

- `test/codex-mcp-item-completed.test.js` pins the six real verdicts and both exact
  messages.
- Its decline test shows the server-error record with the decline's words swapped in
  reads `unknown`: the words alone decide. It also pins the variants that stay `failed`:
  capitalised, trailing text, another key, a bare string, a null or real `result`, and
  another status or none.
- The two-shape test pins the veto either way round, and failure-wins beside a decline.
- `test/codex-mcp-history.test.js` pins the 0.145.0 decline and its exactness.
- `test/codex-mcp-learning.test.js` pins the review counts: success 1, failed 1, unknown 2
  (was 1, 2, 1), still `observe` and never auto-safe.
- `test/vscode-acceptance-mcp.test.js` pins the shared assertion's exact-error checks.

Against the parser before this change, six of those files' 27 tests fail. MCP harness on
0.161.0: 6/6 cases pass, with verdicts unknown, success, failed, unknown, success, failed
(`acolyte-codex-mcp-runtime-Yrc9iw`, `-CFSRmA`; the two runs wrote byte-identical
fixtures). Against the parser before this change,
exactly the two declines fail, each read `failed` (`acolyte-codex-mcp-runtime-xU6iEs`).
Mutation: thirteen parser mutants were each killed:

- a decline read `failed` again;
- either shape's decline unrecognised;
- the 0.161.0 decline keyed on structure rather than its words;
- extra error keys, a result key, or any status allowed;
- extra keys beside `Err`, or `Err` matched by `/rejected/i`;
- the veto removed, or never recorded;
- a decline erasing a recorded failure;
- a decline given its own identity.

Not measured: an approval answered `cancel` rather than `decline`, a Guardian or
auto-review denial of an MCP call, and a server that dies mid-call. Their messages are not
the measured decline, so they still read `failed`.

## Codex 0.161.0 follow-up, October 13, 2026: Codex evidence revision 4

Added after the section above; it amends the matrix row "Shell history scan and outcome
learning" ("Revision 3 replays old Codex evidence once") and replaces nothing else.

**Already-scanned Codex history is re-read once with the 2026-10-13 parser corrections.**
None of them raised `CODEX_EVIDENCE_REVISION` (`src/auto-learn-manager.js`): 0.161.0 MCP
outcomes, session-scoped call groups, the code-mode join with its "not found" and refusal
handling, the MCP decline, and the fork head seed. So a transcript scanned before them
kept the older parser's verdicts. Revision 4 uses the mechanism revision 3 used for the
`write_stdin` fix. On load, the Codex counts are reset to the Claude ones and the Codex
observation hashes are dropped. Each Codex cursor becomes a pending file read again from
byte 0. Claude counts, hashes and cursors, grants, reviewed sets, Codex targets and the
Undo transaction are untouched. The rebuild-pending flag pauses automatic application
until the re-read completes, and clears on a clean walk (the pending-leak rule of
`9abc330`). The dashboard shows its existing "rebuilding older Codex evidence" note.

**A second rebuild had to stop one historical failure counting twice.** A grant that a
rebuild preserves keeps a failure baseline: the retained Claude failures, plus each Codex
failure the replay re-reads. A revision-3 record's baseline already holds its replay's
Codex failures, and revision 4 resets the Codex counts and replays them again. Left as it
was, the baseline held them twice and would absorb a genuinely new failure: measured in
the new test, where a Claude failure after the rebuild did not revoke the grant. So a
revision-3 record that still preserves its grant restarts from the retained Claude
failures, and its definitions are kept. One that a newer, unreconciled failure had already
outgrown is dropped rather than refreshed into grandfathering it, so the grant meets the
normal rules at the next apply, as it already would have; the migration itself revokes
nothing. The undated-failure tally restarts too, because the replay recounts it. Records
for families with no Codex evidence, and the `legacyCodexEvidence` audit archive (the
first archive is kept), are as revision 3 left them.

The tests are in `test/codex-evidence-migration.test.js`. The transcript uses the record
shapes 0.161.0 was measured to write. The re-read moves a joined cell from unknown to
success, and a refused cell and a declined MCP call from failed to unknown. A
revision-3 state re-reads once and keeps every Claude count, hash, cursor and grant.
Undo still works, a second scan and a fresh load start nothing, and a revision-4 state
hands its Codex cursors to the scanner as they are. A preserved grant keeps its
protection once, and a new failure after the rebuild revokes it; an outgrown record is
dropped. The two revision-pinned assertions name the current revision.

- Against the manager before this change, the three new tests fail along with the two
  revision-pinned ones, and the control passes.
- Mutation: eight manager mutants were each killed. They were the revision left at 3;
  the bump alone (a revision-3 record kept as it was); an outgrown record refreshed or
  kept; a preserving record dropped; the undated tally not restarted; a current state
  rebuilt on every load; and Claude counts not retained.

**Measured on a copy of this machine's real history** by the new
`scripts/measure-codex-evidence-rebuild.js`. The copy covers 13 rollouts (371 MB) plus
`session_index.jsonl`, `thread_history_1.sqlite` and `state_5.sqlite`, all copied into a
fresh temp tree. The process's home points at the copy, the originals are hashed before
and after (unchanged), and the copy is deleted at the end. Claude history was not copied,
so no Claude evidence could arrive. Two revision-3 Auto Learn states exist, both
workspace-scoped (their roots recovered from their ids) and both in `recommend` mode:

- *The state last scanned on October 7* (8 Codex families, 14 Codex runs, 5 Claude
  grants, 1 preserved grant).
  - The rebuild was pending on load with 6 files and took 3 scans; the large rollouts
    are read across scans by the ingest budget, and the pending flag held all 3.
  - It re-read 40 Codex calls: the 14 already counted plus 26 written since. After it,
    13 families held 17 successes and 23 failures.
  - A control on the same copy and the same parser, with the revision held at 3, ends
    in identical Codex families: 0 of 13 differ. So on this corpus the corrections move
    no verdict already counted; the change is the history written since the last scan,
    which a plain catch-up also reads.
  - All 446 Claude families' counts were unchanged, and so were the Claude cursors, the
    5 Claude grants, the reviewed sets and Undo. The preserved grant kept baseline 0
    with 0 failures.
  - The 20,000-hash cap evicted 26 Claude dedupe hashes (19,986 to 19,960) to make room
    for the re-read Codex ones. The control evicts the same 26, so it is the cap's
    ordinary work, and no count moved.
- *Today's state* (0 Codex families).
  - The rebuild was pending on load with 9 files and took 3 scans.
  - No Codex call falls under its workspace before or after.
  - Claude counts, all 9,825 hashes, cursors and grants were unchanged.

In both, a fresh load afterwards started nothing and one more scan re-counted nothing.
The only `codexTargets` difference is the copy's own Codex rules file, which sits under
the copy's home and so registers as a new, empty target; every target the state already
had is unchanged.

## Recorded CLI and local-state evidence

**`--rules` is repeatable, and conflicts resolve toward the MORE RESTRICTIVE decision,
order-independently.** Two rule files disagreeing about one prefix, 0.145.0:

    A alone  (allow)      exit 0   decision "allow"
    B alone  (forbidden)  exit 0   decision "forbidden"
    A then B              exit 0   matchedRules [allow, forbidden]  decision "forbidden"
    B then A              exit 0   matchedRules [forbidden, allow]  decision "forbidden"

The validator passes every `.rules` file in the selected Codex home's `rules` directory, with the temp file
standing **in place of** the one being replaced rather than beside it. A neighbouring
`org-overrides.rules` forbidding `rg` blocks a write that validates perfectly on its own,
and reverting to a single `--rules` lets it through. That is the test which proves the
change is load-bearing rather than cosmetic.

**`codex execpolicy check` self-tests the emitted `match`/`not_match` lists at parse
time.** Swapping them on any emitted rule makes the whole file fail to load:

    Error: failed to parse policy at <file>
    Caused by: expected example to not match rule `PrefixRuleMatch { … }`: wctool list

So the examples this tool emits are load-bearing, not documentation. Exercised across all
five emitted rules (two single-token, two two-token, one three-member git union), with an
exact positive per `match` entry, a near miss per `not_match` entry, four hand-written
near misses, and five non-members of the emitted union.

**A rejected check costs nothing.** With a hand-written rule outside our markers that
Codex refuses to load, `apply()` throws, the deployed file is byte-identical, the
candidate stays pending for `codex`, `appliedTo` excludes it, and `lastApplyAt` is null.

**Against the real deployed file**, 2026-09-24: `~/.codex/rules/permission-wildcarding.rules`,
20,234 bytes. The shipped enumerator found 1 rule file; `rg --files` allow, `whoami` allow,
`no-such-tool-xyz` no decision. Byte-identical afterwards, no validator temp file left behind.

**The managed-requirements parser is exact, and says so when it is not.** Against the real
bundle cached on this box (19,545 chars, 13 prefix rules, 0 unsupported), the old parser
and the replacement differ on five commands:

| argv | old parser | new parser |
|---|---|---|
| `push` | forbidden | no rule |
| `repo` | forbidden | no rule |
| `delete` | forbidden | no rule |
| `--force` | forbidden | no rule |
| `gh repo delete x` | prompt | **forbidden** |

The first four are commands the organisation does not forbid. The last is the dangerous
direction: the old parser returned the FIRST matching block and the broad `gh` prompt rule
is written above the narrow `gh repo delete` forbidden one. Supported pattern positions are
`{any_of=[…]}`, `{token="…"}` and a bare string; anything else becomes an explicit
`unsupported` entry, sets `degraded`, and is named beside the verdict, for a match and a
non-match alike, because "no managed rule governs this" is a claim about the whole policy.

**History storage matched the measured local stores.** Measured 2026-09-24:
52 rollout files under `~/.codex/sessions`, and `~/.codex/thread_history_1.sqlite` with
`thread_turns` 20, `thread_items` 567, `thread_history_projection_state` 52. That table's
columns are `thread_id`, `next_rollout_byte_offset`, `next_rollout_ordinal`: a cursor INTO
the rollout files. Its 52 thread ids matched the 52 rollout filenames exactly, zero orphans
either way. **sqlite is a projection, so the reader was not changed.**
`codexHistoryStoreState` compares the two on every scan and reports `codexHistoryStale`
plus `codexHistoryInspected`. The current implementation distinguishes `exact`,
`unavailable`, `partial` and `skipped`: an unavailable SQLite API is not proof of
healthy storage or of stale history (`src/history-adapters.js:2559#unavailable`). VS Code 1.141.1
(Node 24.21.0) loads `node:sqlite`; hosts within the `^1.80` engine floor may not, so the
`unavailable` tier stays (measured 2026-10-13). This storage check does not detect every
possible rollout-format change.

**Archived threads live in a second folder.** Measured 2026-10-13 on the development box,
13 threads: archiving a thread in Codex MOVES its rollout from
`~/.codex/sessions/YYYY/MM/DD/` to a flat `~/.codex/archived_sessions/`, and
`thread_history_1.sqlite` and `session_index.jsonl` go on naming it. Codex's own thread
table, `threads` in `~/.codex/state_5.sqlite`, marks exactly the four archived threads
`archived = 1` with a `rollout_path` in the archive (on Windows some rows carry the `\\?\`
prefix and some do not). Its `rollout_migration_state` holds one row,
`legacy_to_paginated_v1`, and it is benign: for 13 of 13 threads
`next_rollout_byte_offset` equals the rollout file's size. A walk of `sessions/` alone read
the four archived threads as orphans, and the dashboard reported "Codex history store has
moved" on every scan. Auto Learn now reads both folders; the detector accounts for the
archive, uses `state_5.sqlite` only to CLASSIFY a thread still missing after the walk
(relocated outside the scanned folders, archived and then deleted, or orphaned), records
migrations as notes rather than reasons, and flags a store cursor past the end of its
transcript. Three of the four archived rollouts are forks whose head carries two
`session_meta` records, the fork's and then its parent's; the append-slice seed now applies
both, as the full read does, so a fork read again after it is moved is not counted twice
(`codexHeadSeed`, `src/history-adapters.js:1987#codexHeadSeed`).

**Idle rollouts are compressed in place.** Measured 2026-10-16 on the development box, 17
threads: nine rollouts had become `rollout-<ts>-<uuid>.jsonl.zst`, five in
`sessions/YYYY/MM/DD/` and all four in `archived_sessions/`. Every compressed one was last
written eight or more days earlier and every plain one within three. Each is one zstd frame
whose header declares its decompressed size. `state_5.sqlite` still names the `.jsonl` in
`rollout_path`, and `next_rollout_byte_offset` equals the DECOMPRESSED size for all nine. A
reader that took `.jsonl` only lost the nine threads, and the detector reported the five live
ones as orphans and the four archived ones as deleted archives, so the dashboard said "scan
degraded" again. Auto Learn now reads `.jsonl.zst` as a transcript: decompressed whole into
memory (up to 256 MB decompressed; the largest measured is 170 MB, 0.5 s), then read with the
same cursor, ingest cap and append logic as a plain file. An unchanged compressed file is
recognised from its header's declared size and mtime without decompressing. The frames are
walked from their headers before decoding, because Node 24.19.0's `zstdDecompressSync`
returns only the first frame of a multi-frame file, and returns a truncated file's prefix
without an error. A runtime without zstd (Node before 22.15.0) and a file past the ceiling
are reported as not read, never as trouble. The detector counts a `.jsonl.zst` as the
rollout, takes it as the file a state row's `.jsonl` names, and compares the projection
cursor with the decompressed length (`transcriptLength`).

**Workspace scope is withdrawn and gated.** `--codex-scope workspace` parses, refuses,
names the reason and changes nothing. The extension accepts the setting value, turns Codex
export OFF, explains, and never silently falls back to user scope.
`wildcard-perms --codex-workspace-rules status|remove` is the one-way cleanup and will not
touch a rules file it cannot prove it wrote. The packaging gate was proven **against the
built VSIX, not the checkout**: with the capability restored and `node scripts/package.mjs`
re-run, the gate read the new artefact and reported

    permission-wildcarding-1.5.1.vsix still carries withdrawn Codex workspace scope:
    - extension/extension.js: withdrawn workspace-scope symbol trustedWorkspaceRoot
    - extension/package.json: codexScope still offers the withdrawn "workspace" value

## Still not proven

**One platform, one recorded contract-tested version.** Nothing pins a window and nothing
fails when Codex moves outside it. Version coverage remains open alongside the missing
features and real-app acceptance outcomes above.

**History coverage is still bounded.** The September 25 corpus of 53 rollouts contained
nested `exec` shell calls, so it could not validate the direct-shell classifier. On
September 27 the runtime harness produced actual `shell_command` rollouts and checked
successful and declined outcomes with the packaged parser. That closes the missing-sample
claim for this shape. The September 28 direct exec_command/write_stdin proof above closes
terminal process completion for that shape. Custom cell continuations, other unobserved
shell/tool formats and parser-format monitoring remain open. `classifyCodexOutput` is
defined at `src/history-adapters.js:799#classifyCodexOutput`; nested outcomes are handled by
`applyCodexGroupResult` at `src/history-adapters.js:1178#applyCodexGroupResult`.

**Legacy evidence is rebuilt with an audit trail.** State version 2 records a parser
revision and per-source counts. Old Codex cursors are reread with the corrected parser;
known Claude evidence remains. Where old mixed-source hashes were pruned, the original
candidate and counts remain in `legacyCodexEvidence` in the state file named by
`--learn status`. Unverifiable counts cannot qualify a new automatic approval. The
dashboard shows rebuilding status and excluded counts without hiding review actions.
Previously applied/reviewed policy and existing undo records are preserved through the
migration. Incomplete history remains explicitly pending instead of claiming completion.
New Claude failures and Codex failures dated after migration still count against automatic
grants during a rebuild. Codex failures without timestamps cannot always be distinguished
from old replayed failures, so existing grants are retained in that case and the dashboard
reports the number of undated failures. These failures cannot qualify a new approval.

**Managed requirements are read only from the local bundle cache.** Server-side policy,
Guardian decisions, session approval state and sandbox restrictions stay invisible. Now
stated in every verdict rather than implied.

**Project rule discovery is incomplete.** The enumerator follows `CODEX_HOME`, falling
back to `~/.codex`, and accepts explicitly supplied extra directories. It does not
automatically discover trusted project rule directories. A check against this set does
not establish the effective policy of every Codex configuration.

**Instruction target discovery follows the active user file.** Writers honor custom
`CODEX_HOME` and a nonempty `AGENTS.override.md`, and leave empty overrides empty so they
do not hide the base file. Missing/unreadable targets are distinguished, and inactive
managed copies are removed without deleting user text. Codex's
[instruction discovery documentation](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
describes those alternatives. The corrected guidance also follows the documented distinction
between simple shell splitting and complex wrappers in
[Codex rules](https://learn.chatgpt.com/docs/agent-configuration/rules).

## CI

**Updated 2026-10-13:** the Node 22 legs now install a pinned Codex and fail rather than
skip; the Node 20 legs keep the skipping behaviour described next. See the October 13
section above. The paragraph below is the September record.

The current contract tests skip when no `codex` binary is reachable, with a banner on
stderr and an inline reason on each skipped test (`test/codex-contract.test.js:38-50#probe`).
The recorded off-PATH run produced 1 pass and 6 skips. A run that reaches the binary
prints `codex --version`; it does not compare that version with a supported range.
These tests call the local rule checker rather than an authenticated provider session.
CI needs a provisioned CLI or suitable runner to exercise them; fresh-session acceptance
requires its own setup and evidence.

## Account identity is deliberately not read

The policy cache is checked for expiry only. Learning which account is signed in means
opening `~/.codex/auth.json`, which holds live OAuth tokens and an API key, and no feature
here is worth teaching this tool to open that file. A decision, not an omission; see
`docs/engineering-record.md`.

## Re-run this when

The supported Codex version window moves, the rule syntax changes, or the session-history
storage changes. Each invalidates the evidence above rather than merely ageing it.
