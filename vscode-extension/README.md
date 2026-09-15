# Permission Wildcarding (VS Code extension)

Watches `~/.claude/settings.json` and live-generalizes approved Claude Code
permissions to depth-aware wildcards. Adds an Activity Bar dashboard: a hero card
with the "Active" / "Idle" state, the version, the approved total and the
wildcards / specific split, plus **Wildcard Now** and **Restore prunes from
backup**; then seven collapsible rows, closed by default and summarised on the
right — **Auto Learn**, **MAX modes**, **Project-local**, **Shell-style
guidance**, **Memory gates**, **Memory**, and **Wildcards tracked**. That last
row lists each tracked wildcard with a one-click prune, capped at a 12-entry
preview so it cannot become the panel.

Because it is a VS Code extension rather than a Claude Code hook, none of this
depends on a hook being allowed to fire, so it keeps working where a managed
policy disables user hooks.

On every write it also saves a high-water-mark backup of the allow list **and the
deny list** to `~/.claude/backups/allow-list.latest.json`, so a managed-settings
refresh that resets `settings.json` can't lose your accumulated wildcards or your
safety boundary. Recover both with **Restore prunes from backup** (dashboard
button, title-bar `history` icon, or the `Permission Wildcarding: Restore prunes from
backup` command).

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
(`~/.claude/projects/**/*.jsonl`) and Codex history (`~/.codex/sessions/**/*.jsonl`). It
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

Beyond the shell, the same transcripts feed three Claude-only families that are **never applied
automatically**: an MCP call proposes the exact `mcp__server__tool` observed and never a server
wildcard; a web fetch proposes `WebFetch(domain:host)` from the observed URL; and file tools are
counted per tool with no path and no inferred rule at all. The review list also marks a
candidate that the current deny or ask policy would override.

The extension scans at startup, watches both agents' JSONL history, and reconciles every five
minutes by default. Incremental reconciliation, stable observation IDs, and deduplication
prevent gaps and double counting. Workspace-partitioned state stays under the user profile at
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

The Auto Learn card carries **Scan now**, **Review (N)**, **Undo** and **Why prompt?**, and
those are also the only four message arms the webview host handles (`autoLearnScan`,
`autoLearnReview`, `autoLearnUndo`, `autoLearnWhy` at `extension.js:3237-3240`).
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
`--codex-scope user|workspace|off`, `--threshold <count>`, `--mode`, and
`--codex-executable` to mirror the extension settings.

Codex rules default to `~/.codex/rules/permission-wildcarding.rules`. The
`permissionWildcarding.autoLearn.codexScope` setting can target the trusted workspace's
`.codex/rules/permission-wildcarding.rules`, or be `off` to learn without exporting Codex policy.
Auto Learn never overwrites `default.rules`. Every generated rule must pass
`codex execpolicy check` before a write; validation failure leaves active rules unchanged.
Claude and Codex applications use separate snapshots and output targets. Restart Codex after
applying or undoing Codex rules because it loads them at startup.

**Why did this prompt?** evaluates Claude user-settings precedence or runs `codex execpolicy
check` against visible user and trusted-workspace rules. Its result explicitly notes that
managed/system policy, session approval state, and sandbox restrictions are outside that view.
See the official Codex [rules](https://learn.chatgpt.com/docs/agent-configuration/rules) and
[permissions](https://learn.chatgpt.com/docs/permissions) documentation.

The other Auto Learn settings are `permissionWildcarding.autoLearn.enabled` (default
**true**), `permissionWildcarding.autoLearn.intervalMinutes` (default **5**),
`permissionWildcarding.autoLearn.debounceSeconds` (default **20** — the quiet window a
watcher-driven scan waits out, so a burst of transcript writes coalesces into one scan), and
`permissionWildcarding.autoLearn.codexExecutable` (default `codex`). The full list of all 17
settings is at the end of this file.

### Future local CPU assistance

Auto Learn is currently pure Node and does not call a model. CPU BGE embeddings for clustering
and local Ollama labels or explanations are future advisory extension points; neither is wired
into Auto Learn today. If added, they will not override deterministic parsing, risk
classification, or `codex execpolicy check`. The separate Memory card can rebuild the
standalone `memory/recall.py` BGE index; that index does not participate in Auto Learn.

## Memory-index lint

The extension also keeps the Claude Code **file-memory index** honest. `MEMORY.md`
is loaded into every session, so each entry should stay a one-line hook (running
status belongs in the per-fact memory file or the project repo). This feature is
pure Node — no Python, no model, no Claude Code hook — so it ships in the VSIX and
works under a managed policy.

- A **status-bar gauge** (`$(book) mem: 1.9k tok · N to fix`) shows the always-loaded
  token cost and, warning-tinted, how many issues it found. Click it for the full
  report (an output channel: over-budget lines, broken links, unresolved `[[links]]`).
- **Editor diagnostics** squiggle each `MEMORY.md` hook line over the budget and any
  index link pointing at a missing file.
- It auto-discovers every `~/.claude/projects/*/memory/MEMORY.md`, updates on save and
  on external edits, and can be pinned or tuned via the `permissionWildcarding.memory.*`
  settings (`enabled`, `dir`, `lineBudget` for one hook's width, `maxLines` for how many lines
  Claude Code actually loads, `totalBudget`, `recallScript`). Command:
  `Permission Wildcarding: Lint memory index`.

The semantic-recall side of memory hygiene is `memory/recall.py`, a separate CPU tool
(bge-small ONNX cosine fused with BM25). The **script** is bundled into the VSIX:
packaging copies it into `extMemory` (`scripts/package.mjs:38`), and `recallScriptPath`
(`extension.js:553-560`) probes that bundled copy before any checkout, so a fresh install
can rebuild the index with no repository on disk. The ~32MB model is **not** bundled; the
Memory card fetches it on first use into `~/.claude/wildcarding/models/`, writing `<name>.tmp`
and renaming on success. **Cancel** or any failure unlinks that partial inside `close()`'s
callback — `fs.unlinkSync(tmp)` (`extension.js:693`) — and resolves only after it, so a
cancelled download leaves nothing behind. Unlinking *beside* the close raced the still-open
write handle and lost on Windows, which orphaned every cancelled transfer. See the Memory
card section below.

## Memory card (dashboard)

The dashboard also carries a **Memory card** that surfaces what the lint gauge
doesn't — the state of the CPU recall model and the vector cache. The card's own
status is a passive filesystem probe: `recallStatus` (`extension.js:622`) tests for
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

Python does run unattended in two other places, both gated on your having opted in.
`autoSyncRecallIfStale` (`extension.js:794`) runs `recall.py` **incrementally** — not
`--rebuild` — on startup and whenever `MEMORY.md` changes, and only when the cache is
genuinely behind the corpus. Staleness is decided per file, on size and mtime, by
`entryMatchesFile` (`src/recall-index.js:88`) — plus the embed identity, and never a bare
count. The index file itself is excluded, because it is the index and is never embedded.
A 15-minute cooldown prevents back-to-back runs; a status-bar message confirms each sync,
and a failure is logged to the extension host console without a notification.
Separately, the gate compiler spawns
`recall.py --gates-compile`, but only once the memory-gates block is installed.

`permissionWildcarding.memory.recallScript` overrides the script path and is checked first,
but you should not normally need it: the VSIX carries its own copy of `recall.py`, and the
dev/source layout is auto-detected. The status probe works regardless of the path.

## Install

Needs **VS Code 1.80** or newer (`engines.vscode` is `^1.80.0`) and **Node >= 20** for the
CLI half in the repository.

Download the `.vsix` from the repository's
[Releases](https://github.com/bigfnj/permission-wildcarding/releases), then in
VS Code: **Extensions view (`Ctrl+Shift+X`) → `···` menu → Install from VSIX…**
and pick the file. Installing via the GUI registers the extension into the
active profile (a plain `code --install-extension` or folder copy does not, and
the Activity Bar icon will not appear).

The `PostToolUse` hook (the non-GUI half of this tool) is installed separately
from the repository root — see `install.sh` / `install.ps1`.

MIT licensed.

## Skip every prompt — two agents, two switches

Each switch names the agent it applies to, writes a different file, and leaves a
different floor underneath. They are siblings, not one setting.

| Switch | Agent | Writes | Floor left underneath |
| --- | --- | --- | --- |
| **Claude MAX** (recommended) | Claude Code | `~/.claude/settings.json` | `permissions.deny` + circuit breakers |
| **Codex MAX** | Codex | `~/.codex/config.toml` | the sandbox (`sandbox_mode` untouched) |

The status bar shows both agents at once (`Claude MAX · Codex prompts`), so an
active "skip everything" is never ambiguous about what it covers.

**Codex MAX** targets `approval_policy = "never"` and deliberately leaves
`sandbox_mode` alone. Codex has no deny list, so the sandbox is its only floor —
removing it too would leave nothing able to refuse a command. You still get
stopped for out-of-workspace writes and network access, which are the cases worth
being asked about. On a console-managed org an `allowed_approval_policies` cap
may forbid `never`. The switch then reports itself **unavailable** and writes nothing
(`blockedBy: 'enterprise-policy'` at `src/codex-max.js:267-272`): every other value it could
write still prompts *and* equals the org's own default, so setting it and calling that "MAX
on" would claim prompts are skipped when they are not. Restart Codex to apply; it reads
config at startup.

`config.toml` is edited surgically, line by line, so literal-string paths, inline
arrays and nested `[plugins."x@y"]` tables survive. Turning it off restores the
file byte for byte.

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

It also flags when `allowManagedHooksOnly` makes MAX's approve hook inert — the
allow-wildcard layer keeps working, which is why MAX has two layers.

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

Four buttons: **Scan now**, **Review (N)**, **Undo**, **Why prompt?**

**Review** shows a live count of candidates the picker will actually offer —
candidates an existing allow rule already covers are excluded from the count, since
approving them changes no prompt. **Wildcard Now (N)** in the title bar shows how
many allow entries the wildcarding pass would change; it reads 0 when your policy
is already fully generalized.

**Apply safe** and **Cycle mode** were dropped from the card and remain in the
Command Palette. Apply safe is a no-op wherever nothing is auto-safe — which, once
auto-safe narrowed to suffix-closed roots, is most real machines — and Cycle mode
cycles between one useful mode and two that do nothing there.

## Every command

All 19, as registered in `contributes.commands`. Each is prefixed
`Permission Wildcarding:` in the Command Palette. Four are also title-bar buttons on the
dashboard view: Toggle Claude MAX, Wildcard Now, Auto Learn - Scan now, and Restore prunes
from backup.

| Command | What it does |
| --- | --- |
| Wildcard Now | Run the generalization pass over `~/.claude/settings.json` once |
| Restore prunes from backup | Merge the saved allow **and** deny backup back in |
| Show all tracked wildcards | The full list with a filter box, past the card's 12-entry preview; picking one removes it after a confirm |
| Auto Learn - Scan now | Read new Claude Code and Codex transcript history |
| Auto Learn - Scan now (compatibility command) | The same action under the pre-rename command id, so an existing binding still resolves |
| Auto Learn - Review candidates | Tick the families to grant, with policy overrides labelled |
| Auto Learn - Apply safe candidates | Apply only the deterministic read-only, suffix-closed ones |
| Auto Learn - Undo last application | Release this claimant's grants through the claims registry |
| Auto Learn - Cycle mode | `observe` → `recommend` → `auto-safe` |
| Auto Learn - Why did this prompt? | Diagnose one command against user settings and org policy |
| Auto Learn - Show families blocked by managed policy | Families whose prompt no user rule can stop, with the rule |
| Derived guidance - review mitigations for prompts no rule can stop | Accept / decline each measured mitigation by id |
| Toggle Claude MAX | Allow-list wildcards + the `PreToolUse` approve hook |
| Toggle Codex MAX | `approval_policy = "never"`; `sandbox_mode` untouched |
| Drain project-local approvals into user scope | Promote, verify, then prune `.claude/settings.local.json` |
| Toggle shell-style guidance in `~/.claude/CLAUDE.md` | The marker-fenced block that stops un-generalizable approvals |
| Toggle memory gates in `~/.claude/CLAUDE.md` | Install or remove your compiled standing orders |
| Lint memory index | The `MEMORY.md` bloat + broken-link report |
| Rebuild recall index | Force a full CPU bge-small re-embed |

## Every setting

All 17 keys under `permissionWildcarding.*`, with the defaults the manifest declares.

| Setting | Default | Meaning |
| --- | --- | --- |
| `backupMirrorPath` | `""` | Off-tree copy of the allow/deny backup. Empty means `~/.permission-wildcarding/allow-list.latest.json`; point it at another volume to survive more than a `~/.claude` reset |
| `autoLearn.enabled` | `true` | Scan history at all |
| `autoLearn.mode` | `"recommend"` | `observe` / `recommend` / `auto-safe` |
| `autoLearn.successThreshold` | `3` | Confirmed successes before an auto-safe candidate applies |
| `autoLearn.intervalMinutes` | `5` | Periodic reconcile, the backstop for missed watcher events |
| `autoLearn.debounceSeconds` | `20` | Quiet window a watcher-driven scan waits out |
| `autoLearn.codexScope` | `"user"` | `user` / `workspace` / `off` — where generated Codex rules land |
| `autoLearn.codexExecutable` | `"codex"` | Binary used for `codex execpolicy check` |
| `localDrain.enabled` | `true` | Automatic project-local drain. Off still leaves the button |
| `guidance.enabled` | `true` | Keep the shell-style block installed on activation |
| `gates.enabled` | `true` | Keep the memory-gates block installed on activation |
| `memory.enabled` | `true` | The `MEMORY.md` lint, gauge and diagnostics |
| `memory.dir` | `""` | Pin one memory store instead of auto-discovering |
| `memory.lineBudget` | `300` | Characters one index hook line may use |
| `memory.maxLines` | `200` | Lines Claude Code actually loads from `MEMORY.md` |
| `memory.totalBudget` | `12000` | Byte budget for the whole always-loaded index |
| `memory.recallScript` | `""` | Override the `recall.py` path; checked before the bundled copy |
