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

**Released 2026-10-16 as 1.6.8.** Auto Learn reads the `.jsonl.zst` files Codex compresses idle
rollouts into, which ends the second "scan degraded" false alarm. The record has it under "Codex
compresses idle rollouts to `.jsonl.zst`".

**Released 2026-10-15 as 1.6.6 and 1.6.7.**
- 1.6.6 (`36696ec`): the Claude Code strip model is checked on each update.
- 1.6.7 (`f1407bf`): workspace settings may only tighten Auto Learn and the drain.

The live hook now runs a release worktree, moved to each new tag (first done for v1.6.7). The
record has the details under "Decided 2026-10-15: the live hook".

**Released 2026-10-15 as 1.6.5** (tag `v1.6.5` at `6f6ed60`, CI green on all 8 jobs including the new
Python gate-edit job, the asset verified entry by entry). It ports rampage's memory-gates work: G1–G7
hardening, per-agent gates and retire/restore. It also reports gates found in other stores. **1.6.4** (`35c3358`) fixed the silent Review button.
**Released 2026-10-14 as 1.6.3** (tag `v1.6.3` at `1fb294a`, CI green on all 7 jobs, the published
asset verified entry by entry against the local build). Every finding from the 1.6.3 confirmation
audits, their follow-up waves and the final pre-tag audit is fixed or recorded in
`docs/engineering-record.md`. What follows is only what is still open.

The pattern worth naming, still true: **an entry rots in a way its own prose cannot show.**
Re-verify before acting on anything here, including this paragraph.

---

## Open

### Memory gates: `agents:` targeting (2026-10-14; all three gaps closed)

A read-only census of this box found 0 compiled gates and 1 qualifying memory. The 16 gates in
the repo's comments, from a 119–123-memory corpus, lived on the development machine. Three
defects surfaced along the way, and all three are closed, with their evidence in
`docs/engineering-record.md` under "Rampage's memory-gates hardening, ported (2026-10-14)" and
"Per-agent memory gates (2026-10-14)":

- **CLOSED, FIXED by reporting (`a9a2dbf`): the compiler reads one store and ignored the rest
  without saying so.** By the maintainer's decision the other stores are still never compiled.
  `recall.py --lint` and the dashboard's gates card now name each other store and its count of
  gate memories that are not installed.
- **CLOSED, FIXED (`c6a1878`): `agents:` targeting was ignored.** A gate marked `agents: [codex]`
  was installed into Claude's `CLAUDE.md` too. Now `agents:` decides which agents get each gate,
  and once one names a subset the compile writes one file with a section per agent, each under
  its own header sha, read once and refused whole if any section is torn. The older checkout's
  per-agent files are never read. A corpus with no `agents:` key compiles and installs byte for
  byte as before, pinned against `d624539` by test/recall-py.sh.
- **CLOSED, FIXED (`659be23`): `src/agent-gates.js`'s header said gates need `type: feedback`.**
  It now says selection is on `scope: global` alone.

**Note (user, 2026-10-14):** the private spin-off `bigfnj/rampage` ("a memory manager for Claude
Code") has feature work on memory gates and on Project-local draining. Its memory-gates hardening
(`7139659`) was ported in wave-h1 (the record section above), and its "retire and restore memory
gates one at a time" (`e5c0ee7`) in wave-h3 (the record's "Retire and restore memory gates
(2026-10-14)"). Its Project-local drain work is not mapped yet. Check it before designing that.

### Decided 2026-10-15, CLOSED: a workspace may lower Auto Learn's mode, never raise it

**CLOSED, FIXED (`ea1fabe`).** The evidence is in `docs/engineering-record.md` under "Workspace
settings may only tighten (2026-10-15)". wave-f15's census had found that a repository's
`.vscode/settings.json` could set `autoLearn.mode` to `auto-safe` and so opt the user into
unattended grants to the global files. Now `autoLearn.mode`, `autoLearn.successThreshold`,
`autoLearn.codexScope` and `localDrain.enabled` are tighten-only. A workspace or folder value may
make each one stricter than the user's own setting, never looser. A looser value is ignored, with
one output line. The Cycle mode command writes user settings for any step above the user's mode.
This entry can go once that release ships.

Also from wave-f15, ACCEPTED-RECORDED rather than queued:
- **Argument splitting on the cmd route.** A token ending in `\` before the closing quote merges
  with the next argument. That is argument splitting, not injection, and it affects only a
  non-npm batch-file codex.
- **The version probe still runs an npm `codex.cmd` through cmd.exe.** It is safe with fixed
  arguments.

### VS Code acceptance has not run against the 1.6.2 tree

`scripts/drive-vscode.js` launches an isolated VS Code instance, and on 2026-10-13 every launch
was refused: a staged VS Code update held the `vscode-updating` mutex ("Code is currently being
updated"), which is released only when the running VS Code exits. The packaged-build drive
(`scripts/drive-installed.js`), both suites and every CLI-only Codex harness passed; the
real-editor groups, including the MCP acceptance suite's new 0.161.0 shape check, are unrun.
Run `node scripts/drive-vscode.js --extension-dir <stage>` (plus `--review-runtime yes
--dashboard-ui yes`) after the next VS Code restart.

### A worker-runner timing test was cancelled once under heavy load

2026-10-13, while four worktrees ran full suites at once: a long timing test in
`test/auto-learn-worker-runner.test.js` was cancelled in one full run; the file alone passed 16
of 16. The Windows rename-holder flakes measured the same day had a different cause and are
fixed; this one is unreproduced.

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
deliberately never read because that would mean opening `~/.codex/auth.json`; and the
Claude Code allow-path model (the 39 known-safe environment variables and the wrapper
stripper in `src/permission-match.js`) was read from Claude Code 2.1.296, because the public
docs list neither. Since 2026-10-15 the variable list is checked automatically on each Claude
Code update: the extension re-reads it once per new binary and warns when it differs
(`src/claude-strip-model.js`). A list change still needs a release, and the wrapper stripper
and value class are still re-read by hand.
