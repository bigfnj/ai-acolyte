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

### A test whose named case its fixture cannot reach

RESTORED 2026-09-25. This was open for weeks, and the burn-down DELETED it without fixing
it and without moving it to the record. That is the one outcome the disposition rule
forbids, and an audit OF the burn-down is what caught it.

`test/dashboard-view.test.js:556` asserts `app.passes.count - before === 1` under the message
"one pass per settings write, not two". Its fixture seeds `FIFTEEN` (`test/dashboard-view.test.js:364`),
a list the same file elsewhere calls already a fixed point, so **no settings write happens**
and the case the message names is unreachable. On the real write path `runWildcarding` runs
`processAllowList` twice by design, the unlocked probe plus the in-lock recompute, which is
what the assertion would have to tolerate.

The evidence that came with the original entry, and which now survives only in git history:
removing the hint on the optimal path is killed by this test; removing it on the **write**
path survives. **The write-path hint has no coverage at all.**

### The release workflow node24 pins have still never executed

RESTORED 2026-09-25, dropped by the same burn-down, and now live rather than theoretical
because 1.5.2 is the release whose run will execute them for the first time.

`.github/workflows/release.yml` runs only on a release, so `actions/upload-artifact@v6` and
`softprops/action-gh-release@v3` have never run. **Check that run rather than assuming it.**

Worth keeping because the original entry got the fix wrong in a way that would have looked
done. It said to bump both to `@v5`, and `actions/upload-artifact@v5` is STILL node20, so a
uniform `@v5` would have left one action on the deprecated runtime while the annotation went
quiet. The pins that actually clear it are checkout v5, setup-node v5, upload-artifact v6 and
gh-release v3.

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
