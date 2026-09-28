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
| Shell history scan and outcome learning | Implemented; separate-wait completion FIXED in development | `parseCodexJsonl` (`src/history-adapters.js:956`) parses actual new Codex shell transcripts. The real dashboard Scan button learns individually approved executions and deduplicates repeat scans. Fresh direct exec_command/write_stdin runs now preserve success and failure; ambiguous or interactive outcomes remain unknown. Revision 3 replays old Codex evidence once while preserving Claude counts and grant/undo records. Custom cell continuations and unobserved formats remain outside this proof. |
| Non-shell Auto Learn | FIXED in development for exact reviewed MCP approvals | Authoritative MCP records supply exact server/tool identity and success/failure/unknown counts without retaining arguments or response bodies. Review changes one native user-config approval setting; these candidates cannot become Claude permissions or shell rules. Actual VS Code passes six groups with seven fresh runtime calls and three failing controls. Hosted web and other built-in tools do not inherit this proof. |
| Built-in image and web tools | Measured native boundary; hosted-web outcomes remain unverified | Three fresh `view_image` calls needed no approval. Only the valid image returned structured image content; invalid input also emitted a completion event, so completion alone cannot establish success. Seventy historical web completion records exposed no authoritative outcome status. No speculative approval exporter or successful-run counters were added. See the measured boundary below. |
| Reviewed and automatic policy export | Implemented, including shared ownership in 1.5.10 | Real VS Code safe-apply produces effective rules. The actual dashboard Review button, checkbox and Grant dialog export a rule learned from real Codex history. A fresh process executes it without approval; a different executable still prompts. Shared ownership retains other workspaces' grants and rechecks effective policy even when only ownership changes. The learned custom-command prefix covers its arguments, so changing only an argument is not a negative control for that grant. |
| Auto Learn backup and undo | Implemented, with conservative shared-policy conflicts | The actual dashboard Undo button restores exact policy bytes and learner state in one workspace; a fresh Codex process requests approval again. Version 1.5.10 also checks shared ownership before Undo, including identical rules whose bytes never changed. A conflicting older Undo refuses without writing; undoing the newer transaction first permits the earlier Undo. |
| Shell-style guidance | Implemented for default/custom home and overrides | Wording now distinguishes Codex shell splitting from Claude generalization (`src/agent-guidance.js:91`). Real VS Code configuration events write/remove the blocks. Actual dashboard Add, Cancel and Remove also have file and persisted-setting checks, including installation into empty Codex and Claude files. Fresh Codex receives the full packaged guidance body; removal is verified. Custom homes, nonempty overrides, empty override fallback and unreadable targets have focused checks. |
| Memory gates | FIXED in development for explicitly marked native global sections | A separate native compiler reviews the full body and refreshes an installed block without changing native sources. Fresh default/custom Codex sessions load installed/refreshed bodies and confirm absence after Remove. Actual editor checks cover Cancel/Install, edits, zero/refill, override migration, malformed-source retention, Remove and stale review refusal. The old malformed-scope compiler fails the preserved case; install and refresh no-ops fail their intended native groups. |
| Memory index, lint and recall integration | FIXED in development for native discovery, lint and semantic recall | Reads the native summary, task registry, rollout summaries and memory skills with exact passage provenance. Raw staging inputs, SQLite and sessions are excluded. Actual later-created sources, diagnostic repair/deletion, search, inspection and BOM selections pass in VS Code. CPU semantic retrieval finds zero-keyword paraphrases across registry, rollout and skill sources; actual rebuild replaces poisoned vectors and missing-model searches visibly fall back to keywords. Three disabled-path controls fail their intended native groups. |
| Derived guidance for recurring friction | FIXED in development for supported repository-query advice | Current cached Codex managed prompt rules are compared with Codex-only successful run counts. A full-body dialog reviews advice before installation into the active Codex instruction file. Actual Accept/Decline and fresh instruction loading/removal pass; a no-op Accept fails the native check. Counts describe observed runs, not historical prompt dialogs. |
| "Why did this prompt?" | Implemented for visible local policy | `vscode-extension/extension.js:1757` inspects visible rules and cached requirements. Three actual diagnostic dialogs agree with adjacent fresh Codex outcomes: reviewed command allowed, unrelated executable declined, original command declined after Undo. They name the selected rules file and disclose that managed/system policy, session approval state and sandbox restrictions remain outside the check. |

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
literal declarations (`src/codex-rule-store.js:190`). A reset of a Codex directory
that itself contains this backup directory also deletes the backup; this is not
whole-user-home disaster recovery. Computed files and unsupported generated bodies
remain read-only. The feature cannot recover declarations it never captured.

Restore rechecks the displayed original path, existence, hash and saved identity
(`src/codex-rule-store.js:253`). Current decisions and ownership moves are conflicts.
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
(`src/auto-learn-manager.js:1688`, `src/derived-guidance.js:236`). It offers reuse of
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

`parseCodexRules` (`src/codex-rule-inventory.js:155`) reads a complete restricted literal
Starlark file or returns an explicit unsupported result with no partial rule list. Declaration spans retain UTF-8
and CRLF text outside the selected declaration (`src/codex-rule-inventory.js:178`).
`inventory` (`src/codex-rule-store.js:63`) enumerates user
rules under the selected Codex home, preserves source and decision, and requires current
file hashes plus real `codex execpolicy check` validation before removal
(`src/codex-rule-store.js:131`). The extension offers this through Show Codex rules and
the dashboard's Codex prefix rules row.

The shared removal record is scoped to the Codex home. It suppresses overlapping learned
prefixes, including broader grants that would cover a removed narrower command, across
workspaces using current builds. Removing a generated declaration updates every identical
ownership claim while retaining unrelated claims (`src/codex-claims.js:86`). Ordinary
Undo refuses a snapshot that could restore a suppressed prefix. A transaction for another configured Codex target
refuses after deliberate removals rather than guessing the old target's removal scope.

An interruption retains the intended before/after hashes and bytes. `finish`
(`src/codex-rule-store.js:117`), exposed as "Finish interrupted Codex removal", resumes
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
| Declared window | **none yet**; nothing fails when Codex moves outside it |
| Rule syntax | `prefix_rule`, generated by `renderCodexRules` |
| Validator | `codex execpolicy check --rules <file> [--rules <file> …] -- <command>` |

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
healthy storage or of stale history (`src/history-adapters.js:1793`). This storage check
does not detect every possible rollout-format change.

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
defined at `src/history-adapters.js:769`; nested outcomes are handled by
`applyCodexGroupResult` at `src/history-adapters.js:890`.

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

The current contract tests skip when no `codex` binary is reachable, with a banner on
stderr and an inline reason on each skipped test (`test/codex-contract.test.js:38`).
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
