# AI Acolyte (VS Code extension)

Watches `~/.claude/settings.json` and live-generalizes approved Claude Code
permissions to depth-aware wildcards. The Activity Bar dashboard has one shared
**Optimize permissions** action: it generalizes Claude entries, then opens the
existing review for wider Codex prefixes. Codex changes still require confirmation.
The saved-rule total combines Claude allow entries and local Codex shell allow
declarations, with a per-agent breakdown. It excludes Codex prompt/forbidden rules
and native MCP settings; it does not measure effective command access. Unreadable
or unsupported inputs produce an incomplete count instead of a false zero.
A trusted project's `.codex/rules` count too, once Codex has said which project folders
it trusts. The panel never waits for that answer: it asks in the background, shows the
Codex count as a lower bound (`1+`) with "Checking which project rule folders Codex
trusts…" meanwhile, and redraws when the answer lands. A `.codex` folder with no `rules`
folder is not asked about at all.

**Permission tools** starts collapsed. View/remove opens one searchable list for Claude
and Codex; restore and project import ask which agent to manage. Codex hook and native MCP configuration
remain specific to Codex.

Below the Permissions card the rows sit in three labelled groups:
- **Activity:** **Agent sessions** and **Auto Learn**.
- **Memory & instructions:** **Claude memory**, **Codex memory**, **Memory gates** and **Shell-style guidance**.
- **Permissions:** **Project-local**, **Permission tools** and **Saved permissions**.

**Saved permissions** combines Claude allow entries and local Codex allow rules, labels each
agent, and alternates agents in a 12-entry preview. Claude entries keep one-click removal, and
Codex entries open their existing rule review. The overflow link searches both agents.

**Rule use.** A line under the list says how often each Claude allow rule covered a call in
your transcripts, counted daily in the background. Its **review** link lists the rules with no
use found. Such a rule may still be used by a session that keeps no transcript, so each removal
stays a confirmed choice.

**Agent sessions** lists the Claude and Codex sessions that wrote a transcript in the last 15
minutes. For each it shows the app, the folder name, the permission mode when it is recorded,
the last activity, and the subagents that are working.
**Claude memory** and **Codex memory** are two rows with the same layout and the same actions.
Each shows the CPU model status, its folder, four figures, an issues line, **Search**, **Rebuild**
and **Inspect memory sources**, its gates, and the agent version. The Claude card also has an
open-threads line ("Open threads: 2 installed (Claude, Codex)"), the INDEX warning while
`MEMORY.md` is past a budget, and **Turn on / Turn off open threads**.

Version **1.9.0** supports Codex history-based learning, reviewed rule changes, recovery,
MCP approvals, instruction guidance and native memory workflows. Real-editor and fresh
Codex runtime checks verify the documented outcomes. Coverage remains scoped to the
tested CLI, platform, policy syntax and tool shapes; the feature-by-feature acceptance
matrix records the evidence and remaining boundaries in
[`docs/codex-compatibility.md`](../docs/codex-compatibility.md). Open work is tracked
under "Codex compatibility: feature coverage and real-app validation" in `BACKLOG.md`.

File watching and manual dashboard actions run in the extension and do not require
a Claude Code hook. The optional Codex after-turn hook has its own review requirement.

On every write it also saves a high-water-mark backup of the allow list **and the
deny list** to `~/.claude/backups/allow-list.latest.json`, so a managed-settings
refresh that resets `settings.json` can't lose your accumulated wildcards or your
safety boundary. Choose **Restore permissions**, then **Claude Code**, under
**Permission tools** or through the title-bar `history` icon. The
`Acolyte: Restore prunes from backup` command remains available.

deny is restored alongside allow deliberately: every other feature here ends its
safety argument at "deny still wins", so bringing permissions back without the
rules that bound them would be worse than not restoring at all. Both halves land
in a single atomic write, and an older allow-only backup file is still read and
upgraded in place.

That primary copy lives *inside* `~/.claude`, which covers a `settings.json` rewritten in
place but not that whole directory being recreated. So the same payload is mirrored
off-tree to `~/.permission-wildcarding/allow-list.latest.json`, or wherever
`permissionWildcarding.backupMirrorPath` points — put it on another volume to survive more
than a reset. The mirror is written second and best-effort, so a bad path can never cost
you the primary; restore reads the primary first and falls back to the mirror. Fallback
rather than union, on purpose: unioning a stale mirror would hand back the entry you
deliberately pruned.

## Review noise

The Auto Learn review list hides candidates an existing allow rule already
covers — proposing `Bash(rg --files *)` when `Bash(rg *)` is already granted
changes no prompt, and the wildcarding pass prunes the entry on its next run
anyway. The count is shown in the picker title so nothing disappears silently.
When nothing is left to offer, Review says so in a modal dialog with the covered
count, and **Show covered** lists each hidden family beside the allow rule that
covers it. That list is read-only. Review shows its progress in the status bar
from the click, waits for a scan that is already running, and reports a failed
scan instead of returning in silence.
Only your user settings are visible to that check, so it can hide redundancy but
never risk; deny- and ask-governed families still reach review, labelled with the
rule that overrides them.

The confirmation step before applying is driven by **risk and policy override**,
not by auto-safe eligibility. `autoSafe` answers "may a machine apply this
unattended" — the wrong question for someone who has just ticked rows in a
picker, and since auto-safe narrowed to suffix-closed roots nothing in the review
list is ever auto-safe, so that prompt fired on every selection and could not be
avoided. An unavoidable confirmation is a click-through, not a gate. Now a plain
read-only grant applies without a prompt, and anything else is confirmed with the
specific entries named — what the grant can do, and whether policy overrides it
anyway.

## Cross-agent Auto Learn

Auto Learn incrementally scans local Claude Code history
(`~/.claude/projects/**/*.jsonl`) and Codex history (`~/.codex/sessions/**/*.jsonl`, plus
`~/.codex/archived_sessions/*.jsonl`, where Codex moves an archived thread's transcript, and
the `.jsonl.zst` files Codex compresses idle transcripts into, in either folder). It
correlates each requested tool call with its matching result. Confirmed successes add positive
evidence. Confirmed failures are retained as negative evidence and block `auto-safe`
eligibility; they do not increase the success threshold. Unanswered, incomplete, and pending
calls are ignored until a result arrives. Ambiguous outer success from a multi-command Codex
`functions.exec` is not assigned to every nested command.
Even a single nested call needs a statically unconditional call shape and explicit nested
exit-code evidence before it is counted as successful.

Both adapters feed one normalized learner, while separate exporters preserve each agent's
policy model. Claude Code receives supported Bash / PowerShell patterns merged into
`~/.claude/settings.json`; Codex receives exact argv-prefix `prefix_rule` entries and literal
unions in a dedicated rules file. Claude-style globs are not copied into Codex rules.

One `tool_result` carries one exit status however many commands the string held, so an outcome
is credited only where it is provable: every link of an all-`&&` chain, or the final segment of
a `;`, newline or pipe chain. A `||` branch and an ambiguous failure credit nothing. Heredoc
and here-string bodies are masked before splitting, so file contents and commit prose never
become commands.

For Claude Code, non-shell transcripts supply exact MCP tool proposals, observed
`WebFetch(domain:host)` proposals and file-tool counts without an inferred path rule.
These families are never applied automatically. Codex MCP tools use a separate reviewed
native approval setting, described below; they do not become Claude permissions or shell
prefix rules. The review list also marks policy overrides.

The extension scans at startup, watches both agents' JSONL history, and reconciles every five
minutes by default. Incremental reconciliation, stable observation IDs and deduplication are
designed to prevent double counting. The eviction defect that once let a re-read inflate
a family past its threshold is fixed, and pinned by `test/auto-learn-evidence-cap.test.js`. A scan will not always finish a file: one tick ingests a bounded amount
per transcript, and what it could not reach is REPORTED rather than papered over, as `partial`,
`unreadable` and `unmatchedResults`. The cursor records what was consumed, so the next tick
resumes exactly where it stopped. Workspace-partitioned state stays under the user profile at
`~/.claude/wildcarding/auto-learn-state.<workspace-hash>.json` (or
`auto-learn-state.json` without a workspace). It contains normalized families, source labels,
outcome counts, stable hashes, and `path-sha256:<24-hex>` cursor locators — never raw command
arguments, transcript text, prompts, or absolute transcript filenames.

### Modes and safety

- **`observe`** — collect evidence only; do not recommend or apply policy.
- **`recommend`** — the default; show learned candidates for explicit review.
- **`auto-safe`** — automatically apply only deterministic, low-risk, read-only candidates
  after `permissionWildcarding.autoLearn.successThreshold` confirmed successes (default **3**) and
  only while the candidate has zero confirmed failures.

A workspace may lower the mode but never raise it above your user setting (see "Every
setting"). So **Cycle mode** saves a step above your user setting in user settings, where it
applies to every workspace that does not lower it, and saves any other step where the mode
already lives.

Auto-safe excludes destructive, administrative, credential-related, network-capable,
package-install, arbitrary-wrapper, and ambiguous candidates. They may appear in review, but
are never automatically applied. Claude `deny` entries and managed policy continue to win.
Read-only classification alone is insufficient: an automatically exported prefix must remain
safe for every later argument it authorizes. File/secret readers, remote-capable prefixes, and
other broad read families therefore stay review-only.

Suffix closure is judged on the pattern, not the observation. An auto-applied
`Bash(<root> *)` is matched against whole future command strings, and a trailing `*` admits
shell syntax as readily as arguments — `Bash(echo *)` also matches `echo <anything> >
<anywhere>`, and no allow pattern can exclude a redirection. Auto-safe is therefore limited to
roots where no argument can reach stdout, which excludes `echo`, `printf`, the `Write-*`
cmdlets, `basename`, `dirname`, `Get-Date`, and `git cat-file` (its `--textconv` runs the diff
driver the repository names). All stay available for review. One residual is accepted: an
auto-safe root can still truncate an arbitrary path with fixed content (`whoami > somefile`),
so catastrophic paths belong in `permissions.deny` — which this extension never writes.

### Review and policy output

The Auto Learn card carries **Scan now**, **Review (N)**, **Undo**, **Why prompt?** and
**Turn on** / **Turn off**, and they post five of the message arms the webview host handles; the switch is at
`vscode-extension/extension.js:5134#switch`. This sentence has now been wrong three times: twice it
claimed four was the total, once it cited a DESCENDING range, and the correction itself then
cited the wrong line. The
second time cited a DESCENDING line range, which is not a range at all.
**Apply safe candidates** and **Cycle mode** are Command Palette only — see the command
list at the end of this file. Apply keeps a recoverable snapshot; Undo restores the most
recent Auto Learn application. The repository CLI uses the same service:

```bash
bin/wildcard-perms --learn scan
bin/wildcard-perms --learn status
bin/wildcard-perms --learn apply
bin/wildcard-perms --learn undo
```

The CLI uses its current directory as the workspace partition and user Codex rules by
default. Run it from the same workspace as VS Code, or pass `--workspace <path>` plus
`--codex-scope user|off`, `--threshold <count>`, `--mode`, and `--codex-executable` to
mirror the extension settings. **Workspace Codex scope is withdrawn.** Three different
trust notions were in play (VS Code workspace trust, the CLI
accepting the flag unguarded, and Codex project trust, which is neither), so the capability
was removed rather than shipped with a trust model nobody could state. `--codex-scope
workspace` now parses, refuses, names the reason and changes nothing;
`wildcard-perms --codex-workspace-rules status|remove` is the one-way cleanup.

Codex history, generated rules, managed-policy cache and user instructions follow
`CODEX_HOME` when set, otherwise `~/.codex`. Guidance and gates use the nonempty
`AGENTS.override.md` when present, otherwise `AGENTS.md`. Enabling a feature removes
its old managed block from the inactive sibling; disabling removes it from both files.
User text and the other feature block are preserved. An unreadable override is reported.

Codex rules default to `<Codex home>/rules/permission-wildcarding.rules`. The
`permissionWildcarding.autoLearn.codexScope` setting is `user` or `off`; `off` learns without
exporting Codex policy. The `workspace` value was withdrawn and the manifest enum no longer
offers it. Setting it by hand turns Codex export OFF and says so, and never falls back to user
scope silently.
Every generated rule must pass an
isolated `codex execpolicy check` before a write; validation failure leaves active rules unchanged.
That check now evaluates every visible rule file together, not just the generated one: `--rules`
is repeatable and Codex resolves a conflict toward the MORE restrictive decision, measured
order-independently against codex-cli 0.145.0. A neighbouring file that forbids the prefix blocks
the write, which `test/codex-contract.test.js` proves end to end against the real binary.
Claude and Codex applications use separate snapshots and output targets. Restart Codex after
applying or undoing Codex rules because it loads them at startup.

**Why did this prompt?** evaluates Claude user-settings precedence or runs `codex execpolicy
check` against visible user and trusted-workspace rules. Its result explicitly notes that
managed/system policy, session approval state, and sandbox restrictions are outside that view.
See the official Codex [rules](https://learn.chatgpt.com/docs/agent-configuration/rules) and
[permissions](https://learn.chatgpt.com/docs/permissions) documentation.

### Codex workflows

**Review Codex approvals** proposes supported literal widenings of stored approvals.
**Import project Codex rules** proposes portable declarations from the workspace's
`.codex/rules` files for user scope, including overlapping project restrictions. Review
shows the source, destination and complete proposed declarations. Both preserve original
declarations and refuse stale proposals ([reviewRules](codexFeaturesUi.js#L124),
[prepare](../src/codex-reviewed-plans.js#L214)). This reviewed import is separate from the withdrawn
automatic workspace export setting.

**Show Codex rules** lists local literal allow, prompt and forbidden rules; confirmed
removal applies only to supported allow declarations ("Remove this Codex allow rule?",
`vscode-extension/extension.js:5083#showWarningMessage`).
Auto Learn remembers removals across workspaces. **Restore Codex rules**
adds captured missing declarations while preserving current rules and excluding deliberate
removals (`vscode-extension/extension.js:4883#showCodexRestorePicker`, [restore exclusions](../src/codex-policy-backup.js#L168)). Computed
policy stays read-only. Interrupted writes offer an explicit completion step.

**Review Codex MCP approvals** reviews one observed server/tool pair. Approval changes
that tool's native user configuration; different future arguments are covered, and the tool
is not classified as safe. **Undo approval** restores the saved prior setting; changed
configuration requires review ([reviewMcp](codexFeaturesUi.js#L177),
[restoreCodexMcpApproval](../src/codex-mcp-config.js#L462)). Other tools, server settings and project trust are preserved.

**Configure Codex after-turn learning** adds a Stop hook using the current Auto Learn mode,
so completed turns can be learned while the editor is closed. Configuration alone does
not activate it: review the exact definition in Codex `/hooks`
([configureHook](codexFeaturesUi.js#L26)). This supplies after-turn learning, not immediate
per-tool timing. Reviewed rules, MCP approval/Undo and hook controls have staged real-editor
and fresh-runtime evidence in the compatibility document.

The other Auto Learn settings are `permissionWildcarding.autoLearn.enabled` (default
**true**), `permissionWildcarding.autoLearn.intervalMinutes` (default **5**),
`permissionWildcarding.autoLearn.debounceSeconds` (default **20** — the quiet window a
watcher-driven scan waits out, so a burst of transcript writes coalesces into one scan),
`permissionWildcarding.autoLearn.codexExecutable` (default `codex`), and
`permissionWildcarding.autoLearn.workerTimeoutSeconds` (default **300**, `0` disables it —
how long one worker operation may run before the extension stops waiting). The full list of
all 19 settings is at the end of this file.

**AI Acolyte: Toggle Auto Learn**, and the card's **Turn on** / **Turn off** button, switch
`autoLearn.enabled` in your user settings. Off stops the extension's background scans; **Scan
now** still scans when you ask. Codex's after-turn Stop hook and `wildcard-perms --learn` are
separate and do not read the setting, so turning Auto Learn off here does not stop either. When
a workspace or folder setting holds Auto Learn off, turning it on first asks, in a modal that
names the settings file, before it removes that value: the file may be a `.vscode/settings.json`
the repository commits. Dismissing it changes nothing.

`autoLearn.codexExecutable` is **machine-scoped**: set it in user settings. The extension
runs that program without asking (`--version` for the dashboard's version line, `app-server`
to ask which project rule folders Codex trusts, `execpolicy check` for Auto Learn), so a
value in a repository's `.vscode/settings.json` is ignored rather than run. The extension is
also disabled in Restricted Mode: it declares no `untrustedWorkspaces` capability, which
VS Code treats as not supporting Workspace Trust. Trusting a folder still does not let the
folder choose the binary.

### Future local CPU assistance

Auto Learn is currently pure Node and does not call a model. CPU BGE embeddings for clustering
and local Ollama labels or explanations are future advisory extension points; neither is wired
into Auto Learn today. If added, they will not override deterministic parsing, risk
classification, or `codex execpolicy check`. The separate Claude and Codex memory controls
use CPU BGE recall indexes; neither index participates in Auto Learn approval decisions.

## Memory-index lint

The extension also keeps the Claude Code **file-memory index** honest. `MEMORY.md`
is loaded into every session, so each entry should stay a one-line hook (running
status belongs in the per-fact memory file or the project repo). This feature is
pure Node — no Python, no model, no Claude Code hook — so it ships in the VSIX and
works under a managed policy.

- A **status-bar gauge** (`$(book) mem: 1.9k tok · N to fix`) shows the always-loaded
  token cost and, warning-tinted, how many issues it found. Click it for the full
  report (an output channel: over-budget lines, broken links, unresolved `[[links]]`).
- **Editor diagnostics** squiggle each `MEMORY.md` line over the width budget (any line, counted
  in characters), any index link pointing at a missing file, and any broken HTML comment: a
  `<!--` inside an open comment, an orphan `-->`, or a `<!--` never closed. Claude Code strips
  comments from the index, so each of those leaks text into every session or hides it.
- Past **140 lines** (the MEMORY.md guard's target, below the 200-line load cap) the gauge
  turns to a warning and names the target: the index still loads whole, and each addition
  should now take a line out.
- It auto-discovers every `~/.claude/projects/*/memory/MEMORY.md`, updates on save and
  on external edits, and can be pinned or tuned via the `permissionWildcarding.memory.*`
  settings (`enabled`, `dir`, `lineBudget` for one hook's width, `maxLines` for how many lines
  Claude Code actually loads, `totalBudget`, `recallScript`). Command:
  `Acolyte: Lint memory index`.

The lint is not a hook and needs none. The optional **MEMORY.md guard** is: a Claude Code
`PreToolUse` hook that refuses an edit after which the index ends past a budget and is worse on
it than before (140 lines, 12,000 bytes, 300 characters on a line, 16 `- ` entries, no broken
comment). Deleting whole lines passes unless it breaks an HTML comment or a code fence; for a
broken comment the fix is to close or remove the whole comment. It uses those fixed budgets; the `memory.*` settings tune
this gauge, not the hook. Turn it on with **Toggle MEMORY.md guard**, which asks first. Where a
managed policy sets `allowManagedHooksOnly` or `disableAllHooks`, Claude Code runs no user hook,
so the guard is installed and inert there, and the card says so. The root README section "The
MEMORY.md guard" has the rule, the install and the policy caveat.

The semantic-recall side of memory hygiene is `memory/recall.py`, a separate CPU tool
(bge-small ONNX cosine fused with BM25). The **script** is bundled into the VSIX:
packaging copies it into `extMemory` (`scripts/package.mjs:39#extMemory`), and `recallScriptPath`
(`extension.js:656#recallScriptPath`) probes that bundled copy before any checkout, so a fresh install
can rebuild the index with no repository on disk. The ~32MB model is **not** bundled; the
Memory card fetches it on first use into `~/.claude/wildcarding/models/`, writing
`<name>.<pid>.<random>.tmp` (unique per download, so two windows downloading at once never
share one, since 2026-10-13) and renaming on success. **Cancel** or any failure unlinks
that partial inside `close()`'s callback — `fs.unlinkSync(tmp)` (`extension.js:922#fs.unlinkSync`) —
and resolves only after it, so a cancelled download leaves nothing behind. Unlinking *beside*
the close raced the still-open write handle and lost on Windows, which orphaned every
cancelled transfer. A download whose host is **killed** (a crash, not a normal
deactivate, which unlinks) cannot clean up, so each download first sweeps any `<name>.*.tmp`
— the per-writer scheme and a pre-2026-10-13 fixed `bge-small.onnx.tmp` alike — older than a
day (`sweepStaleModelTemps`), never its own and never one young enough to be another window's
live transfer. See the Memory card section below.

## Memory card (dashboard)

The dashboard also carries a **Memory card** that surfaces what the lint gauge
doesn't — the state of the CPU recall model and the vector cache. The card's own
status is a passive filesystem probe: `recallStatus` (`extension.js:733#recallStatus`) tests for
the model asset and the venv, and never runs Python.

- **CPU LLM** status: `ready` when both `bge-small.onnx` and the DevToolbox venv
  (which carries `onnxruntime`) are present, otherwise it names what's missing.
- **Stats**: tokens loaded per session (red past the byte budget), memory-file count,
  and how many memories are in the recall vector cache (read straight from
  `recall_index.json`).
- An **issues line** (`N over budget · N broken links`) that links to the full lint
  report; or `✓ index clean` when there's nothing to fix.
- **⟳ Rebuild recall index** — the one button. It runs `recall.py --rebuild` in the
  DevToolbox venv to force a full CPU re-embed (model + corpus pinned via env so the
  cache matches the card). A full rebuild happens *only* here, because you asked for one.
- A **MEMORY.md guard** line and button: `off`, `on`, `on (copy outdated)`, `on (needs repair)`
  or `foreign`, followed every time by whether Claude Code will run it here. The button turns the
  guard on (after a confirmation naming the hook and the `node` it runs), repairs it, or turns it
  off.

Python does run unattended in two other places, both gated on your having opted in.
`autoSyncRecallIfStale` (`extension.js:1135#autoSyncRecallIfStale`) runs `recall.py` **incrementally** — not
`--rebuild` — on startup and whenever `MEMORY.md` changes, and only when the cache is
genuinely behind the corpus. Staleness is decided per file, on size and mtime, by
`entryMatchesFile` (`src/recall-index.js:104#entryMatchesFile`) — plus the embed identity, and never a bare
count. The index file itself is excluded, because it is the index and is never embedded.
A 15-minute cooldown prevents back-to-back runs; a status-bar message confirms each sync,
and a failure is logged to the extension host console without a notification.
Separately, the gate compiler spawns
`recall.py --gates-compile`, but only once the memory-gates block is installed.
**Manage memory gates…** runs `recall.py` only when you open it or click in it: it lists the
gate memories of the store that compiles, retires or restores the ones you uncheck or check
(rewriting their `scope:` value and nothing else, after a snapshot of the memory folder into
`~/.claude/wildcarding/gate-snapshots`), compiles once, and installs the result only while
`gates.enabled` is on. **Compile and install** in the same panel compiles and installs what the
memories hold, which is how a change whose compile or install failed is finished.
`memory.dir`, `gates.enabled` and `guidance.enabled` are **machine-scoped** for the same reason
as the script path below: the first names the corpus whose `scope: global` gate blocks become
your standing orders in every project, and the other two decide what your global `CLAUDE.md`
and `AGENTS.md` carry, so all three are read from user settings only.
The open-threads compiler spawns `recall.py --threads-compile` after a memory edit that can
change its list (a file that mentions `status:` or a status marker, any edit while a thread is
listed, and every `MEMORY.md` change, for the INDEX line), a few seconds after activation when
a memory declares `status:`, a compile already exists or `MEMORY.md` is past a budget, and when
`openThreads.enabled` is turned on. Only edits in the store that compiles count. While the
setting is off it compiles nothing. `openThreads.enabled` is machine-scoped for the same reason
as `gates.enabled`.

`permissionWildcarding.memory.recallScript` overrides the script path and is checked first,
but you should not normally need it: the VSIX carries its own copy of `recall.py`, and the
dev/source layout is auto-detected. Nothing else is probed. An open workspace folder's own
`memory/recall.py` is never used, in any layout, because that would let a repository choose the
script the extension runs; a checkout elsewhere is named through this setting. The status probe
works regardless of the path. It is
**machine-scoped**, like `backupMirrorPath`: the extension runs that script, and writes the
mirror of your allow and deny lists where that path says, so both are read from user settings
only and a repository's `.vscode/settings.json` cannot set either.

### Native Codex memory

The separate **Codex memory** row reads `memory_summary.md`, `MEMORY.md`,
`rollout_summaries/*.md` and `skills/*/SKILL.md` under the selected Codex home's `memories`
directory. Raw inputs, sessions and SQLite are excluded ([discoverCodexMemory](../src/codex-memory.js#L101)).
Ambient diagnostics refresh when sources are created, edited or deleted
([codexMemoryLint](codexMemoryLint.js#L66)). Codex line counts are informational; Claude's
index-line budget is not imposed on the native registry. The extension reports absent or
unreadable sources and does not infer feature enablement, generate memories or rewrite
native files ([inspectMemory](codexFeaturesUi.js#L106)).

**Search native memory** combines CPU BGE similarity with keyword matching and opens the
exact current source passage. **Rebuild Codex recall index** re-embeds selected passages
into a private cache scoped to the Codex home ([cacheLocation](../src/codex-recall.js#L64),
[rebuildMemoryIndex](codexFeaturesUi.js#L91)). These actions use the existing Python/model
assets without downloading a model or using the GPU. When semantic retrieval is unavailable,
search reports the reason and offers keyword matches ([searchMemory fallback](codexFeaturesUi.js#L62)).
Actual editor checks cover semantic passage selection, BOM offsets, rebuild and the visible
fallback. Rebuild reports failure rather than claiming a keyword-only result rebuilt vectors.

**Review native memory gates** is implemented separately from the shared Memory gates
switch. It compiles deliberate extension annotations: leading `scope: global` frontmatter
and paired `<!-- gate -->` / `<!-- /gate -->` sections. Review shows the full body before
installation into the active Codex instruction file. An installed marker opts in to automatic
refresh; Remove stops it. Incomplete sources retain the installed body, and native sources
and shared gate blocks are preserved ([refreshNativeCodexGates](../src/codex-memory-gates.js#L347),
[native gate review](codexMemoryGatesUi.js#L82)). Fresh Codex instruction loading is verified.
The staged editor run passed all seven native-gate/MCP-receipt groups. Install and refresh
no-ops, and hiding a changed-config MCP receipt, each failed the intended check; the older
helper also failed the malformed-scope retention check. The compatibility document records
`acolyte-validation-native-gates-dev-20260928/native-results.json` and its evidence.
Codex is not claimed to generate these annotations. Start a new session to load instruction changes.

## Install

Needs **VS Code 1.80** or newer (`engines.vscode` is `^1.80.0`) and **Node >= 20** for the
CLI half in the repository.

Download the `.vsix` from the repository's
[Releases](https://github.com/bigfnj/ai-acolyte/releases), then in
VS Code: **Extensions view (`Ctrl+Shift+X`) → `···` menu → Install from VSIX…**
and pick the file. `code --install-extension <file>.vsix --force` also works and
does register into the active profile -- measured on VS Code 1.10x, 2026-09-22,
three installs in a row, each one appearing in `extensions.json` as the active
`local.permission-wildcarding-<version>`. A folder copy still does not. The
earlier text here claimed the CLI did not register either; it contradicted the
root README, which tells you to use exactly that command.

The `PostToolUse` hook (the non-GUI half of this tool) is installed separately
from the repository root — see `install.sh` / `install.ps1`.

MIT licensed.

## When managed policy lands

Org policy does not necessarily arrive as a file. A console-managed org
configures restrictions server-side, where the only local trace is
`~/.claude/policy-limits.json` — sometimes nothing at all — so a guard keyed to
an admin-dropped `managed-settings.json` would watch nothing. The trigger is
therefore "approvals stopped being there": checked on every settings change, on
any policy-file change, and once at startup.

Only a bulk loss is repaired without asking; a small one prompts with a one-click
re-assert. The ✕ prune drops its entry from the backup, so a deliberate removal
is never resurrected. Approvals are affected two ways, and only one is recoverable:

- **Missing** — the refresh reset `settings.json`. Re-asserted automatically from
  the backup. If nothing was lost, nothing is written, so a policy that keeps
  rewriting the file never becomes a write loop.
- **Shadowed** — managed `deny`/`ask` outranks a user `allow` entry, by Claude
  Code's precedence. Reported with the exact managed rule responsible, never
  rewritten, because rewriting cannot win.

## Why did this prompt?

The diagnostic reads org policy, not just your user settings. On a console-managed
org there is no `managed-settings.json` to check, so "check managed policy" was
useless advice and an unqualified **ALLOW** was the wrong answer to give someone
whose org was prompting them.

- **Claude** — the verdict is reported as your user settings only, followed by the
  server-delivered restrictions found in `~/.claude/policy-limits.json`, named
  individually. Precedence is stated as managed/org > deny > ask > allow > default.
- **Codex** — the signed enterprise bundle
  (`~/.codex/cloud-config-bundle-cache.json`) is checked **first**, because its
  `[[rules.prefix_rules]]` outrank anything Auto Learn can write. If a rule governs
  the command root, the diagnostic names the rule and its justification and says
  plainly that a user rule cannot override it. It also reports an
  `allowed_approval_policies` cap when one applies.

## Auto Learn card

Five buttons: **Scan now**, **Review (N)**, **Undo**, **Why prompt?**, **Turn on** / **Turn off**

**Turn on** / **Turn off** is the Toggle Auto Learn command, and its label follows the state.
While Auto Learn is off, the collapsed row reads "disabled · Turn on".

**Review** shows a live count of candidates the picker will actually offer —
candidates an existing allow rule already covers are excluded from the count, since
approving them changes no prompt. The **safe** tile counts the auto-safe part of that
same list, so a covered auto-safe family appears under "already covered" and not as
safe. **Optimize permissions** handles existing saved
permissions in both agents; Auto Learn Review handles history-derived proposals.

**Apply safe** and **Cycle mode** were dropped from the card and remain in the
Command Palette. Apply safe is a no-op wherever nothing is auto-safe — which, once
auto-safe narrowed to suffix-closed roots, is most real machines — and Cycle mode
cycles between one useful mode and two that do nothing there.

## Every command

The manifest registers 39 commands under AI Acolyte in the
Command Palette. Selected commands also appear as
dashboard title-bar buttons.

| Command | What it does |
| --- | --- |
| Optimize permissions (Claude + Codex) | Generalize Claude permissions, then review supported wider Codex prefixes |
| View / remove permissions | Search Claude and Codex permissions together; inspect or remove a selected entry |
| Count how often each saved Claude rule is used | Recount, over all Claude transcripts, how often each allow rule covered a call; the Saved permissions card shows the result |
| Restore permissions | Choose an agent, then open its existing recovery action |
| Import project permissions | Choose an agent, then use Claude local promotion or reviewed Codex import |
| Wildcard Claude permissions | Run only the Claude generalization pass |
| Restore prunes from backup | Merge the saved allow **and** deny backup back in |
| Show all tracked wildcards | Search Claude wildcard entries only; picking one offers removal confirmation |
| Show Codex rules | Inspect local literal rules and confirm supported allow-rule removal |
| Restore Codex rules | Review captured missing declarations while retaining current rules and deliberate removals |
| Auto Learn - Scan now | Read new Claude Code and Codex transcript history |
| Auto Learn - Scan now (compatibility command) | The same action under the pre-rename command id, so an existing binding still resolves |
| Auto Learn - Review candidates | Tick the families to grant, with policy overrides labelled |
| Auto Learn - Apply safe candidates | Apply only the deterministic read-only, suffix-closed ones |
| Auto Learn - Undo last application | Release this claimant's grants through the claims registry |
| Auto Learn - Cycle mode | `observe` → `recommend` → `auto-safe`. A step above your user setting is saved in user settings; any other step is saved where the mode already lives |
| Auto Learn - Why did this prompt? | Diagnose one command against user settings and org policy |
| Toggle Auto Learn | Turn the extension's background scans off or on, in user settings. Turning on asks before it removes a workspace or folder value that holds Auto Learn off. Codex's after-turn Stop hook and `wildcard-perms --learn` are separate |
| Auto Learn - Show families blocked by managed policy | Families whose prompt no user rule can stop, with the rule |
| Derived guidance - review mitigations for prompts no rule can stop | Accept / decline each measured mitigation by id |
| Drain project-local approvals into user scope | Promote, verify, then prune `.claude/settings.local.json` |
| Review Codex Approvals | Review supported widenings of stored literal approvals |
| Import Project Codex Rules | Review portable project declarations and accompanying restrictions for user scope |
| Review Codex MCP Approvals | Approve one exact server/tool pair or undo a saved approval |
| Configure Codex after-turn learning | Configure/remove the Stop hook; activation still requires Codex's own hook review |
| Toggle shell-style guidance for Claude Code and Codex | Instructions for commands whose approvals are easier to reuse |
| Toggle memory gates for Claude Code and Codex | Install or remove your compiled standing orders |
| Toggle MEMORY.md guard | Add or remove the optional `PreToolUse` hook that refuses an edit after which a `MEMORY.md` index ends past a budget and is worse than before; asks before adding it, and says when managed policy will stop Claude Code running it |
| Check whether Claude Code runs user hooks | Ask the installed Claude Code, once, whether managed policy stops it running user hooks (the MEMORY.md guard among them); asks first, because where hooks are allowed it is one short real Claude Code turn, and reads Claude Code's own answer as restricted, not restricted or unknown |
| Manage memory gates… | Retire or restore one gate memory at a time, in the store that compiles |
| Toggle open threads | Install or remove the open-threads block: every memory whose `status:` is still open, and an INDEX line while `MEMORY.md` is past a budget |
| Lint memory index | The `MEMORY.md` bloat + broken-link report |
| Search Claude memory | Search your Claude memory by meaning and keywords, and open a match at its line |
| Rebuild recall index | Force a full CPU bge-small re-embed |
| Inspect Claude memory sources | List every Claude memory store, the one the card shows, its issues and gates |
| Search Codex native memory | Search by meaning and keywords, with a visible keyword fallback |
| Rebuild Codex Memory Recall Index | Force CPU embedding of selected native passages into the profile's private cache |
| Inspect Codex native memory | Open source availability and diagnostic details |
| Review Native Codex Memory Gates | Review, install, refresh or remove the separate native gate block |

## Every setting

All 20 keys under `permissionWildcarding.*`, with the defaults the manifest declares.

The Auto Learn worker deadline, `autoLearn.workerTimeoutSeconds`, is the one that needs a
word. It exists so a worker wedged in a synchronous filesystem call cannot hold teardown open
forever; raise it only if a legitimately slow scan is being cut off. It is **machine-scoped**:
VS Code ignores it in workspace and folder settings, and the extension reads only the user
value, so a repository's `.vscode/settings.json` cannot switch the deadline off. While it is unset, the older environment override
`PERMISSION_WILDCARDING_WORKER_TIMEOUT_MS` (milliseconds, `0` disables) still applies; once
set, the setting wins. An edit applies to the next scan, with no reload.

Five keys are **tighten-only**: `autoLearn.enabled`, `autoLearn.mode`,
`autoLearn.successThreshold`, `autoLearn.codexScope` and `localDrain.enabled`. Each decides
whether the extension writes your global files unattended, so a workspace or folder value may make
it stricter than your user setting but never looser. A repository's `.vscode/settings.json` can
put one project in `observe` or turn Auto Learn off there, but it cannot switch you to `auto-safe`
or turn Auto Learn back on. A value that would loosen one is ignored, and
the Acolyte output channel says so once per window. With no user setting, the default is the bar.

| Setting | Default | Meaning |
| --- | --- | --- |
| `backupMirrorPath` | `""` | Off-tree copy of the allow/deny backup. Empty means `~/.permission-wildcarding/allow-list.latest.json`; point it at another volume to survive more than a `~/.claude` reset. Machine-scoped: a workspace value is ignored |
| `autoLearn.enabled` | `true` | The extension's background scans of history. **Toggle Auto Learn** and the card's button switch it in user settings. A workspace may only make it stricter: it can turn Auto Learn off, never on when your user setting has it off |
| `autoLearn.mode` | `"recommend"` | `observe` / `recommend` / `auto-safe`. A workspace may only make it stricter: a workspace or folder value can lower the mode, and one above your user setting is ignored |
| `autoLearn.successThreshold` | `3` | Confirmed successes before an auto-safe candidate applies. A workspace may only make it stricter: it can raise the threshold, never lower it below your user setting |
| `autoLearn.intervalMinutes` | `5` | Periodic reconcile, the backstop for missed watcher events |
| `autoLearn.debounceSeconds` | `20` | Quiet window a watcher-driven scan waits out |
| `autoLearn.codexScope` | `"user"` | `user` / `off` — where generated Codex rules land. `workspace` was withdrawn. A workspace may only make it stricter: it can turn export `off`, never back to `user` when your user setting says `off` |
| `autoLearn.codexExecutable` | `"codex"` | Codex CLI the extension runs (`execpolicy check`, `--version`, `app-server`). Machine-scoped: a workspace value is ignored |
| `autoLearn.workerTimeoutSeconds` | `300` | Seconds one worker operation may run before the extension stops waiting; `0` disables. Machine-scoped: a workspace value is ignored |
| `localDrain.enabled` | `true` | Automatic project-local drain. Off still leaves the button. A workspace may only make it stricter: it can turn the drain off, never on when your user setting has it off |
| `guidance.enabled` | `true` | Keep the shell-style block installed on activation. Machine-scoped: a workspace value is ignored |
| `gates.enabled` | `true` | Keep the memory-gates block installed on activation. Machine-scoped: a workspace value is ignored |
| `openThreads.enabled` | `true` | Keep the open-threads block in step with your memories: compile after an edit that can change it, after activation when there is anything to say, and on turning it on; install the result. Off removes the block, and nothing compiles or installs it. Machine-scoped: a workspace value is ignored |
| `claudeStripModelCheck` | `true` | Once per new Claude Code binary (about 30 s after activation, on a worker thread), compare its known-safe environment variables with the 2.1.296 list the generalizer models, and warn once on a difference. Never edits the list: a change still needs a release. Machine-scoped: a workspace value is ignored |
| `memory.enabled` | `true` | Claude index lint/gauge and native Codex diagnostics; native gate refresh has a separate installed-marker opt-in |
| `memory.dir` | `""` | Pin one Claude memory store instead of auto-discovering; Codex uses its selected home. Machine-scoped: a workspace value is ignored |
| `memory.lineBudget` | `300` | Characters one index hook line may use |
| `memory.maxLines` | `200` | Lines Claude Code actually loads from `MEMORY.md` |
| `memory.totalBudget` | `12000` | Byte budget for the whole always-loaded index |
| `memory.recallScript` | `""` | Override the `recall.py` path; checked before the bundled copy. Machine-scoped: a workspace value is ignored |
