# Backlog

Open items, with the evidence that justifies each one.

Every closed item needs a checkable disposition: FIXED, CLOSED-VERIFIED,
DECLINED-MEASURED or ACCEPTED-RECORDED. Keep the disposition here or link its evidence
in `docs/engineering-record.md` before removing the open entry. Git history alone is
not a completion record. Read that engineering record before proposing work, including
refuted claims, retracted figures, measurement hazards and standing decisions.

Anything measured says so and names the date. Anything unverified says that too.

**Cleared 2026-10-13 for 1.6.2.** Every entry open on that morning was re-verified against
the tree and given a disposition; they are recorded in `docs/engineering-record.md` under
"The 1.6.2 backlog clearance (2026-10-13)" and removed from here. Two had rotted in the way
this file warns about: five of the "seven surviving mutants" had been killed three days before
the tracker was restored claiming otherwise, and an option key listed as having no supplier had
three. What is below is only what is still in flight, plus what that work found.

The pattern worth naming, still true: **an entry rots in a way its own prose cannot show.**
Re-verify before acting on anything here, including this paragraph.

---

## Open

### Codex 0.161.0 history shapes the parser does not read yet

Found 2026-10-13 by running every CLI-only runtime harness against codex-cli 0.161.0.

- **MCP results are invisible.** 0.161.0 no longer writes `event_msg/mcp_tool_call_end`, the
  only shape `codexMcpObservation` reads; each outcome is now an `event_msg/item_completed`
  whose item is `{type: "McpToolCall", server, tool, status, result: {content, isError}}`. The
  parser saw 0 of 5 real outcomes, so reviewed-MCP Auto Learn learns nothing from 0.161.0
  history. The approvals themselves still apply.
- **Continued code-mode cells earn no evidence.** With `code_mode`, a yielded `exec` cell's
  completion arrives in a later `wait` call's output, linked only by a per-session cell id.
  Such cells are withheld as unknown (safe: no false success, no failure credit) because no
  join exists.
- **Harness isolation.** The temp workspaces sit under `%TEMP%`, inside the user's home; Codex
  walks up to the nearest project root and loaded the home directory's own `AGENTS.md` as
  project instructions in harness sessions. It went only to the loopback and only into temp
  evidence, but it makes harness results depend on the user's files.
- **The POSIX case list of the wrapper runtime matrix has not run.** The Windows list passed
  13/13 against the guidance; the Linux run was cut short when the container host stopped.

### The Codex Stop hook's failure reasons never reach the user

Measured against codex-rs 0.161.0: for a Stop hook, Codex reads stderr only on exit 2 (which
BLOCKS the run and must never be used here); any other non-zero exit marks the run Failed with
"hook exited with code N" and nothing else. So every reason the hook has ever printed on
failure was discarded. Exit 0 with a `systemMessage` is shown as a warning.

### Follow-ups from the shell-grammar fix

- `timeout`, `command` and `builtin` still collapse to root-wide grants. Whether that is a
  defect depends on whether Claude Code strips them before matching; unmeasured.
- Narrower Codex prefixes ending in an inline-code flag (`["python","-c"]`, `["node","-e"]`,
  `["env","FOO=1"]`) still render.
- The PowerShell generalizer refuses digit-leading roots, so `7z` grants stay exact.
- The path-rooted check misses `~/…` and relative `.venv/bin/…`.
- No diagnostic names wildcard grants the old generalizer minted from shell grammar
  (`Bash(export *)` on this box).
- Codex memory diagnostics number lines from 0 and the gate compiler's from 1, merged into one
  array by `inspectNativeCodexGates`.

### The `file:line` gate catches less than it looks like it catches

`test/line-refs.test.js` fails an UN-anchored citation only when it lands on a missing file, a
line past the end, a descending range, a blank line or a bare closing brace. A stale one
pointing at a plausible line is invisible to CI. **Run `node scripts/check-line-refs.js --quiet`
rather than trusting a number written here**; on branch wave-e1 (88a4c1d plus the anchor work,
2026-10-13) it read 160 references, 1 anchored, with 64 STALE.

**The mechanism landed 2026-10-13; the migration has not.** An anchored citation,
`file:line#identifier`, is checked exactly and asserted, and `--fix-anchored` repoints one
whose anchor moved to exactly one other line. See the engineering record, "`file:line` rot".
Converting the existing corpus waits until code stops moving. The `.py`/`.yml`/`.yaml` blind
spot is closed, and the `memory/recall.py` citation it hid is corrected and anchored.

### Tests that fail under parallel load

Measured 2026-10-13 while several worktrees ran the suite at once: "parent link replacement
after inventory is stale…" (`test/codex-reviewed-plans.test.js`) failed once in a full run and
passed three isolated reruns; `test/codex-memory-gates.test.js` hit one `EPERM` on a temp-dir
rename; and one full run on `main` reported a single failure that did not reproduce on the
immediate rerun. Each is a test that depends on timing or on exclusive temp-directory access.

---

## Deliberately not here

Three classes of thing were moved out of this file rather than closed, because they are not
queue items:

**Declines with a number** live in `docs/engineering-record.md` under "Optimizations
measured and DECLINED" and "The 2026-09-25 measurement pass". Do not re-derive them.

**Owner decisions** live in the record under "Deferred by the maintainer": the CLI drain
trust gap, the two stat-keyed caches, the text-only privacy gate, the transcript-corpus
backup, the 2026-10-13 decision that the CLI ships inside the extension only, and the
screenshots, which stay until a re-capture.

**Standing limits** are stated where they bite rather than tracked here: Codex managed
requirements are read only from the local bundle cache; Codex account identity is
deliberately never read because that would mean opening `~/.codex/auth.json`.
