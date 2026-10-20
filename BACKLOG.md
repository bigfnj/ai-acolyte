# Backlog

Open items, with the evidence that justifies each one.

Every closed item needs a checkable disposition: FIXED, CLOSED-VERIFIED,
DECLINED-MEASURED or ACCEPTED-RECORDED. Keep the disposition here or link its evidence
in `docs/engineering-record.md` before removing the open entry. Git history alone is
not a completion record. Read that engineering record before proposing work, including
refuted claims, retracted figures, measurement hazards and standing decisions.

Anything measured says so and names the date. Anything unverified says that too.

**Cleared 2026-10-20 for 1.9.1.** The six entries open at 1.9.0 and the 65 findings of the full
audit run after it were each taken to a disposition: FIXED with a mutation-tested commit,
DECLINED-MEASURED with its number, CLOSED-VERIFIED, or ACCEPTED-RECORDED. All 70 rows, the
integrator's own six and the evidence are in `docs/engineering-record.md` under "The 1.9.1 audit
clearance (2026-10-20)", where B1 to B6 are the six entries this file held.

**Released 2026-10-20 as 1.9.1.** The tag `v1.9.1` is at `8aab0ed`, the `--no-ff` merge of
`release/1.9.1`. CI is green on all 8 jobs on the merge (run 39416832500) and on the release
branch (39416456795); the first branch run (39413648790) failed on Node 20 and 22 alone, 16 tests
cancelled by a test's wait on an unref'd timer, fixed in `dd8543c`. The published
`ai-acolyte-v191.vsix` (release.yml run 39416884826) matches the local build in all 66 entries
apart from line endings. Against the installed 1.9.1: `drive-installed.js` 17 of 17 (its
open-threads check now drives Refresh, off, on and off) and `drive-vscode.js` 4 of 4, 6 of 6 and
6 of 6 in the same three groups as 1.9.0. Suite at `b458ed1`: 2028 tests, 2022 pass, 0 fail, 6
skipped (masked view 0 fail); smoke 18 of 18. `scripts/verify-release.ps1` was not run, because
it follows a VS Code reload; it is the owner's step. The v1.9.0 release notes were corrected the
same day (the probe's 5 s timer, one spawn race, the status block, the guard's rule).

**Cleared 2026-10-20 for 1.9.0.** All five entries open on 2026-10-19 were re-verified against the
tree and closed: the spawn-timing family FIXED, the worker-runner cancellation DECLINED-MEASURED,
the `agents:` entry and its rampage-drain note CLOSED-VERIFIED, the workspace-tighten entry
CLOSED-VERIFIED with its two ACCEPTED-RECORDED residuals moved into the record, and the VS Code
acceptance entry CLOSED-VERIFIED. Each disposition and its evidence is in `docs/engineering-record.md`
under "The 1.9.0 backlog clearance (2026-10-20)".

**Released 2026-10-20 as 1.9.0.** The tag `v1.9.0` is at `8324b6d`, the `--no-ff` merge of
`release/1.9.0`. CI is green on all 8 jobs on the merge (run 39402040201) and on the release branch
(runs 39400001253 and 39401520799), and the Python job's new `test/threads-compile.sh` step ran on
GitHub ("24 indexes, 12 past a budget", ALL PASS). The published `ai-acolyte-v190.vsix` (release.yml
run 39402110398) matches the local build in all 66 entries apart from line endings. Against the
installed 1.9.0: `drive-installed.js` 17 of 17 (two new checks: the MEMORY.md guard end to end
through the packaged copy, and open threads through the packaged recall.py), and `drive-vscode.js`
4 of 4 by default, 6 of 6 with `--review-runtime yes --dashboard-ui yes` (now reading the Claude
memory card's guard and open-threads lines from the real webview), and 6 of 6 with `--mcp-only yes
--review-runtime yes`. Suite at the merge: 1966 tests, 1960 pass, 0 fail, 6 skipped (masked view 0
fail); smoke 18 of 18. The live worktree is on the other development box, so moving it is a step
for that machine (the record's clearance section says why). 1.9.0 adds the MEMORY.md guard, the
Open threads block and Toggle Auto Learn, makes `autoLearn.enabled` tighten-only, and fixes one
Windows spawn race (a tree kill its caller started now also reads as ended, a contract rather than
a visible fault; corrected 2026-10-20 from "two races"); the record has a section for each.

**Cleared 2026-10-13 for 1.6.2.** Every entry open on that morning was re-verified against
the tree and given a disposition; they are recorded in `docs/engineering-record.md` under
"The 1.6.2 backlog clearance (2026-10-13)" and removed from here. Two had rotted in the way
this file warns about: five of the "seven surviving mutants" had been killed three days before
the tracker was restored claiming otherwise, and an option key listed as having no supplier had
three. What is below is only what is still in flight, plus what that work found.

**Released 2026-10-19 as 1.8.1.** The tag `v1.8.1` is at `82268a2`. CI is green on all 8 jobs. The published
asset matches the local build in all 62 entries, the drives passed 15 of 15 and 6 of 6, and the live worktree
has moved to the tag. The dashboard rows sit in the user's order, in three labelled groups:
Activity (Agent sessions, Auto Learn), Memory & instructions (Claude memory, Codex memory, Memory gates,
Shell-style guidance) and Permissions (Project-local, Permission tools, Saved permissions).

**Released 2026-10-19 as 1.8.0.** The tag `v1.8.0` is at `09219e5`. CI is green on all 8 jobs, reached
through a stretch of GitHub API 502s and queued runners. The published asset matches the local build in all 62
entries, the drives passed 15 of 15 and 6 of 6, and the live worktree has moved to the tag. The Claude memory and Codex memory rows have the same layout and actions,
as the user asked. Claude memory gains Search (`recall.py --json`), Inspect memory sources, a gates line
and the Claude Code version. Codex memory gains the CPU model line, four figures (its summary's tokens
and lines, files, embedded passages) and an issues line. The record has it under "The two memory cards".

**Released 2026-10-19 as 1.7.2.** The dashboard's Memory row is now Claude memory, to match the Codex
memory row beside it. It was named before Codex support existed, and its row key is unchanged.
Evidence recorded 2026-10-20: Tests and Release VSIX green for `3e8ba86`, and the published asset
matches a local build of the tag in all 61 entries apart from line endings.

**Released 2026-10-19 as 1.7.1.** Each Agent sessions row is laid out on two lines: the badge
and folder name, then the details beneath. As one flex row, the details squeezed the folder name
to one character wide in a narrow sidebar (the user's screenshot). The header line now reads "watching
Claude & Codex history", with the settings path on its hover. Evidence recorded 2026-10-20: Tests and
Release VSIX green for `4fe6a32`; the release itself was pruned by the keep-three rule, so its asset
can no longer be compared.

**Released 2026-10-16 as 1.7.0.** The tag `v1.7.0` is at `0c7ad66`. CI is green on all 8 jobs. The
published asset matches the local build in all 61 entries, apart from line endings. The installed
drive passed 15 of 15 and the real-editor drive 6 of 6. The live worktree has moved to the tag.
The Saved permissions card counts how often each Claude rule
is used and offers the rules with no use found for review. A new Agent sessions row lists the
sessions active in the last 15 minutes. Both came from AgentFlow. The record has them under
"Rule use and agent sessions, from AgentFlow", including the AgentFlow features that were declined.

**Released 2026-10-16 as 1.6.8.** The tag `v1.6.8` is at `bb5c6d8`. CI is green on all 8 jobs.
The published asset matches the local build entry by entry, apart from line endings. The
real-editor drive passed 6 of 6 on VS Code 1.142.0, and the live worktree has moved to the tag.
Auto Learn now reads the `.jsonl.zst` files Codex compresses idle rollouts into, which ends the
second "scan degraded" false alarm. The record has it under "Codex compresses idle rollouts to
`.jsonl.zst`".

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

Nothing open (2026-10-20, after 1.9.1). A new entry carries its evidence and its date.

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
and value class are still re-read by hand. The MEMORY.md guard cannot be exercised live on the
development box, whose managed policy restricts user hooks (`--memory-guard probe` reads
"restricted"): it is verified by tests that spawn the hook with Claude Code's payloads, and by the
packaged-copy drive. Two things wait for a box where user hooks run: an end-to-end check that the
exit-2 reason reaches the model, and the `if` filter (`Edit(//**/MEMORY.md)`), whose matching for
`Write` could not be observed, so the hook filters in-process and pays a node start per Write or Edit.
