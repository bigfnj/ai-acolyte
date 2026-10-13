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

### Codex coverage: version window, CI, runtime evidence

- **Declare and exercise a supported version window.** Evidence covers Codex 0.145.0 and
  0.154.0; this box now runs 0.161.0. No range is declared, and nothing reports a version
  outside it. Any report must be informational: a warning on every Codex update would be an
  always-on signal, the defect class 1.6.2 removes.
- **Provision Codex in CI.** The contract tests skip with a stated reason when the binary is
  absent; they need no provider auth.
- **Exercise the runtime harnesses against 0.161.0**, including the wait/exec shapes, and
  record what is still unobservable through the loopback provider.
- **A representative matrix of shell wrappers** against the guidance text's claims.
- **The runtime provenance hash** in `scripts/check-codex-runtime.js` covers
  `src/policy-exporters.js` but not the local modules it now requires.

### Trusted project rule directories

Policy enumeration reads only `<CODEX_HOME>/rules` and never discovers the `.codex/rules`
directory of a project Codex trusts, while `src/codex-reviewed-plans.js` already enumerates
`<workspace>/.codex/rules` without checking trust. Measure what Codex 0.161.0 actually loads
before deciding the fix.

### Two Auto Learn surfaces with no configuration, and four option keys with no supplier

- The worker deadline is environment-variable only; no setting reaches it.
- `defaultTool`, `priorCursors`, and the duplicate `homeDir`/`successThreshold` spellings are
  read but never supplied, leaving unreachable branches.

### Follow-ups from the archived-thread fix

- **The Codex Stop hook fails on budget deferral.** It treats `partial > 0` as an incomplete
  scan and exits 1. With `archived_sessions/` a default root since 2026-10-13, a large
  archived rollout fails the first few Stop hooks per workspace state while it is caught up.
  `partial` is progress, not failure.
- **A reported `DatabaseSync` deprecation** (said to be an alias of `Database`, DEP0210, in
  newer Node). Unverified.
- **`scripts/smoke.sh`'s "fixed-point cache is back" check** writes a value and reads it
  straight back, so it can fail only on an I/O error.

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

`test/line-refs.test.js` fails a citation only when it lands on a missing file, a line past
the end, a descending range, a blank line or a bare closing brace. A stale citation pointing at
a plausible line is invisible to CI. **Run `node scripts/check-line-refs.js --quiet` rather
than trusting a number written here**; on 2026-10-13 it read 217 references with 99 STALE.
The proposed close is an optional anchor form, `file:line#identifier`, checkable exactly.
Separately, `SOURCE_EXT` admits no `.py`, `.yml` or `.yaml`, though `commentRuns` already
handles hash comments, so `memory/recall.py:1130` cites a wrong `extension.js` line that  <!-- line-refs:ignore -->
nothing can see.

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
