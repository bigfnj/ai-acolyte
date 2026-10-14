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

### VS Code acceptance has not run against the 1.6.2 tree

`scripts/drive-vscode.js` launches an isolated VS Code instance, and on 2026-10-13 every launch
was refused: a staged VS Code update held the `vscode-updating` mutex ("Code is currently being
updated"), which is released only when the running VS Code exits. The packaged-build drive
(`scripts/drive-installed.js`), both suites and every CLI-only Codex harness passed; the
real-editor groups, including the MCP acceptance suite's new 0.161.0 shape check, are unrun.
Run `node scripts/drive-vscode.js --extension-dir <stage>` (plus `--review-runtime yes
--dashboard-ui yes`) after the next VS Code restart.

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

### `check-line-refs.js` triples every citation while a merge is unresolved

Found 2026-10-13 merging wave-a12: during an unfinished merge `git ls-files` lists a conflicted
file once per index stage, so the checker collected each citation in it three times, and
`--fix-anchored` planned the same edit three times and (correctly) refused to write when the
second application no longer matched. Staging the resolved files cleared it. The file list
should be de-duplicated so the counts and the fixer are right mid-merge too.

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
stripper in `src/permission-match.js`) was read from Claude Code 2.1.296 and must be re-read
when Claude Code updates, because the public docs list neither.
