# Backlog

Open items, with the evidence that justifies each one.

**Closed items are removed, not struck through.** Git holds the history. Refuted claims,
retracted figures, measurement hazards and standing decisions live in
`docs/engineering-record.md`; read that before proposing work, or you will re-propose
something already disproven there with evidence.

Anything measured says so and names the date. Anything unverified says that too.

**Emptied 2026-09-25.** This file was 955 lines and 88 open items. Every one was given a
disposition: fixed and deleted, proven already done and deleted, or measured and moved to
the record as a decline. What is below is what survived that, plus what the work itself
found. The suite went 574 to 710 tests over it.

---

## Open

### Codex certification: breadth, not depth

`docs/codex-certification.md` holds the evidence and the current status, which is
**conditionally certified for `codex-cli` 0.145.0 on Windows**. What is left:

- **No declared version window that FAILS.** One platform, one contract-tested version.
  Nothing breaks when Codex moves outside it, so the next breaking change arrives as a
  silent wrong answer rather than a red test. This is the largest remaining gap.
- **The contract tests cannot run in CI.** GitHub's runners have no `codex` binary and no
  authentication for one, so they skip with a banner naming the reason. A self-hosted
  runner is the only way this becomes continuous; until then the evidence is a local
  artefact with a date on it.
- **`classifyCodexOutput` is unreachable from any real rollout on this box.** It runs only
  for the direct `function_call` shell shape. Across all 53 rollouts here the
  `function_call` names are `wait`, `spawn_agent`, `wait_agent`, `send_message`,
  `list_agents`, `followup_task`, `interrupt_agent`; every shell call arrives as
  `custom_tool_call` name `exec` and takes the `_customExec` branch. A mutation making the
  function always return `success` survived the fixture. Measured 2026-09-25. Its own
  comment already said "NOT VERIFIED AGAINST A REAL SAMPLE"; this is how far that goes. A
  fixture was deliberately NOT invented for a shape nobody has seen.
- **Qualify the shell-guidance claim.** Official documentation permits splitting simple
  chains for policy evaluation, while the Windows 0.154 probe did not match the wrapper
  form the extension currently describes. The guidance text has not been corrected.

### The `file:line` gate catches less than it looks like it catches

`test/line-refs.test.js` fails a citation only when it lands on a **vacuous** line — blank,
or a bare closing brace. A stale citation pointing at a plausible-looking line is invisible
to CI. Measured 2026-09-25, and the label matters: `check-line-refs` reports **OK 35 | NEAR 16 |
STALE 51 | UNVERIFIABLE 17** over 119 references. **84 is the non-OK TOTAL; STALE is 51.** An
earlier version of this very entry called 84 the STALE count, which is the kind of error it
exists to complain about. None of the 51 fails the suite.

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
heuristic. That is a corpus-wide change to ~145 references and has not been attempted.

Related, found the same day: a drift scan that required citations to begin with a directory
(`src/`, `vscode-extension/`) missed every bare-filename form (`extension.js:2521`), which  <!-- line-refs:ignore -->
was 20 of the 35 citations one change touched.

### The Project-local card reports on a path it did not watch

Not a bug; the hook covers what the card misses. It is a UI blind spot, which is the class
where a control reports on something other than what is running.

`drainableRoots()` (`vscode-extension/extension.js:2693`) enumerates every workspace folder,
but `localSettingsPath` is a single non-recursive join, so the extension drains one file per
open FOLDER and never a subdirectory. The CLI hook drains the Claude Code session's own cwd
on every tool call. With the editor open at a parent and sessions running in
`projects/<name>`, a file the hook drains is invisible to the card, and the card can read
"nothing to drain" while a subproject file is being drained under it.

⚠ **An earlier version of this entry named the wrong cause** and would have sent a fix at
`workspaceFolders?.[0]`, which governs Auto Learn's state partitioning and is not on the
drain path at all. Corrected 2026-09-24.

The honest fixes are to make the card name the path it actually watched, or to discover
local files beneath the workspace root rather than only at it. Neither is done. Measured
2026-09-25: **zero `.claude/settings.local.json` files exist anywhere under the working
root**, so the zeros on that card were never evidence about promotability in the first
place.

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

### From the 2026-09-25 audits: what was found and NOT fixed

Three read-only audits ran over the whole two-day effort. Everything they found in the
product was fixed the same day and is not listed here; what follows is what was left, each
verified against the tree.

**The highest-yield gate this repo does not have.** Of fourteen confirmed dead-code findings,
**zero** would be caught by widening `test/dead-exports.test.js`, and **nine** would be caught
by one new check: *a property on a returned object literal that no caller reads*. The census
reads `module.exports` and nothing else, so module-local functions, option keys on a context
object, fields on a result object, arguments at a call site, and everything in `bin/`,
`scripts/` and `test/` are invisible to it by construction. That is not a defect in the
census; it is the shape of its blind spot, now measured.

**The drain guard and its own message disagree.** `src/local-settings.js:215-225` blocks on
`legacy.hook || legacy.generatedAllow.length`. The predicate it replaced also covered
`legacy.allow` — both `Bash(*)` and `PowerShell(*)` present in user scope — which
`legacyClaudeMaxStatus` still computes and which the guard now omits. So a user whose snapshot
is absent and whose approve hook is already gone is no longer blocked, while
`vscode-extension/extension.js` and `bin/wildcard-perms` both still say *"legacy Bash(\*) and
PowerShell(\*) grants cover every local entry"*, a message that cannot fire for the case it
names. Either the condition or the wording is wrong. Mitigated by the high-water local backup,
so grants are recoverable.

**Two trackers were lost, not two items.** The "untested-but-correct mutants that survive"
table (7 rows) and the "6 option keys with no supplier" list were both deleted in the
burn-down. Every name in the first now appears somewhere under `test/`, so some are plausibly
covered, but the seven mutants were not re-run. The second class lost its only tracker when
the dead-export census replaced it, and the census does not read option keys.

**Suspected, each with the reason it could not be closed:**

- **Cancelling the model download inside the redirect window** may leave the promise pending
  and the `.tmp` fd open: `httpsGetFollow` returns without calling `onResponse` when
  `handle.cancelled` is set at a 3xx, so `fail()` never runs. Either the branch is unreachable
  (a `destroy()` before the 3xx emits `error` first) or it is that leak; the two readings could
  not be separated. `liveTransfers` holds only the request handle, not the write stream.
- **A case-mismatched `target` defeats the substitute invariant on Windows.**
  `src/codex-policy.js:414-426` compares `resolved` (on-disk casing) with `target`
  (`path.resolve`) by exact string, with no case folding. Both sides derive from `os.homedir()`
  today so they agree; a user-configured `codexRulesPath` with different casing would leave the
  deployed file visible AND append the pending one, a state the code says no write produces.
- **The packaging gate reports but does not quarantine.** `scripts/package.mjs` runs
  `assertRetiredMaxAbsent(out)` after `vsce` has written the artefact, so a rejected VSIX stays
  in the repo root where a later step or a human picking the newest `.vsix` can still ship it.
- **`warnedOnce` survives a same-realm re-activate.** Module-scope `Set`, never cleared by
  `activate()` or `deactivate()`, unlike every sibling latch. Its comment says "once per
  activation"; it is once per realm. Bounded in practice, so cost is nil and only the contract
  is wrong.
- **The `explicit: true` legacy-cleanup path has no UI entry point.** `toggleMax` and
  `toggleCodexMax` are registered but deliberately absent from the manifest, and there are no
  keybinding contributions, so for a real user the whole explicit half of `offerLegacyCleanup`
  is unreachable and anyone whose state is snapshot-only is never offered the cleanup.

**Cosmetic, listed so they are not rediscovered as findings:** the `fixed-point cache is back`
assertion in `scripts/smoke.sh` writes a value and reads it straight back, so it is close to a
constant equalling itself — the property it argues for is delivered by making the restore
unconditional, not by that assertion. And `test/codex-contract.test.js` builds a `swapped`
string it never asserts on (`void swapped;`); the real mutant is built two lines below.

⚠ **The `file:line` corpus got worse across this effort, not better.** `check-line-refs`
reports **OK 36 | NEAR 16 | STALE 55 | UNVERIFIABLE 17** over 124 references, against OK 119
on 2026-09-16. Twenty-six of the STALE ones were written by this effort. The gate cannot see
them, for the reason given in the entry above.
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
requirements are read only from the local bundle cache, `~/.codex/rules` is the only rule
directory enumerated, and Codex account identity is deliberately never read because that
would mean opening `~/.codex/auth.json`.
