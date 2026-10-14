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

### Post-release audit of v1.6.2 (2026-10-14), being fixed

Four read-only audits ran over v1.6.2 (regressions, dead code, lifecycle, performance). The
live hook path and every standing decision were intact; these were found and are in flight:

- **The dashboard push blocks the extension host** on a synchronous Codex `config/read` spawn
  (about 1 s per cache miss, about 31 s when Codex hangs) whenever the workspace has a
  `.codex` folder. Introduced by the trusted-project discovery. `autoLearn.codexExecutable` is
  also window-scoped, so a workspace setting chooses the executable the push now runs.
- **A rebuild can finish while a Codex root is missing**, because a vanished root reads as a
  clean walk; auto-safe can then grant against a known failure in that root.
- **Reviewed Claude rules for informational forms** (`cargo --version`, `df -h`) are no longer
  produced, and an upgrade revokes ones already applied.
- **Exporter gaps**: versioned interpreter names (`python3.12 -c`, `nodejs -e`, `pypy3`) bypass
  the interpreter rules; `hyperfine`, `duckdb` and `wsl` are narrowable though each can run a
  shell; informational forms are refused inconsistently; `.cmd`/`.bat` spellings escape the
  wrapper rows; `env NAME=VALUE cmd` skips the program-naming check on the Codex side.
- **The starter pack seeds `Bash(export *)`**, which the new over-broad diagnostic flags, and the
  diagnostic also counts the maintainer-kept `PowerShell(& *)`.
- **The Codex memory lint misses dangling references** after `**`, `:`, `|`, `./` and `=`.
- **Lifecycle and cost**: the Codex version line walks PATH×PATHEXT on every push (434 stats,
  about 12 ms); its cache is never evicted; a probe killed by deactivate is remembered as
  "timed out"; the project-trust cache keeps raw `config.toml` text (secrets included) per
  edit; download retry timers lack an activation-generation check; the scan-trouble log
  signature includes counts; a per-scan `select distinct` over Codex's item table costs
  129 ms at 1M rows where a loose-index scan costs 20 ms.
- **Dead code and duplication**: a dashboard field nothing renders still costs a full
  `processAllowList` pass per push, plus other unread payload fields and an unused message
  route; option keys and arguments nothing supplies; dead exports in `scripts/`; an unused
  import that hides a test-only export from the census; four drifted copies of the
  rename-retry codes; twelve copies of the harness credential scrub list; `RISK_RANK` in two
  places; `CODEX_TESTED_VERSIONS` and the compatibility doc already disagree on a date; no test
  pins `permissions.js`'s require closure.
- **Installers**: an unquoted hook path with a space is not recognised; `uninstall.sh`
  lowercases paths on every platform, not only Windows.
- **CI**: the release job runs an unpinned `vsce` on an end-of-life Node 20 (vsce 4.0.0 wants
  Node ≥ 22), and nothing tests Node 24, the extension host's runtime.
- **The PostToolUse hook blocks every Bash/PowerShell call** for the cost of a Node spawn
  (about 0.35–0.57 s on this box under endpoint security). Claude Code 2.1.296's hook schema
  has `async: true`; whether older clients tolerate the key is being established first.

### For the maintainer to decide (from the same audit)

- **The live hook runs the development checkout.** Any edit, branch checkout or mutation run in
  the maintained checkout changes the code the next real tool call runs against the real
  `settings.json` (the fixed-point stamp invalidates, so the edited generalizer runs at once).
  The backup mirror makes that recoverable. Pointing the hook at a stable copy (a worktree
  pinned to the latest tag, or the installed VSIX's bundled CLI) would separate the two.
- **Applying `async: true` to the live hook registration** once the installers support it.

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
stripper in `src/permission-match.js`) was read from Claude Code 2.1.296 and must be re-read
when Claude Code updates, because the public docs list neither.
