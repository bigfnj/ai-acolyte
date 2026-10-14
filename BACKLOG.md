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

### In flight: v1.6.3 CI and the confirmation audit (2026-10-14)

The 1.6.3 release commit (7cbba2b) is not tagged. Its CI failures, the freed-PID tree kill and
the cached trust timeout are fixed and recorded under "The v1.6.3 release commit's CI failures
(2026-10-14)". Still open from the confirmation audit of that commit:

- **MEDIUM.** A stored null-rule family that has not run since the upgrade can be written
  despite a user deny or managed ask. The boundary checks judge the stored null field; the write
  renders the derived rule. Deny still wins at runtime, so this is a dead entry reported as
  applied, not an escalation.
- **LOW.** A missing configured history root pins the Codex evidence rebuild without saying so.
- **LOW.** A pending project-trust verdict can render "No saved permissions yet".
- **LOW.** make's other implicit program variables (`RM=`, `AR=`, …) still render in Codex
  export.
- **LOW.** `memory.recallScript` and `backupMirrorPath` are window-scoped, so a workspace can
  choose them.

A second confirmation audit (lifecycle and performance, MEASURED 2026-10-14) found no new leak
and no performance regression; every 1.6.3 figure is at or better than 1.6.2. It found:

- **The recorded push figures are wrong.** On this box, `execFile()` blocks the calling thread
  inside CreateProcess before returning. The real 332 MB winget `codex.exe` takes 428 ms (p50),
  node 203 ms. So "106 ms cold" holds only with a `.cmd` stand-in. With the real Codex, a cold
  push blocks the host for about 690 ms (the version probe plus the trust-worker spawn), and a
  push after a `config.toml` edit for about 211 ms, not 9 ms. The fix is to make those spawns
  from a worker thread; the record must be corrected either way.
- **execFile's own `timeout` orphans grandchildren.** A `.cmd` shim killed this way leaves its
  node child alive. The sites are `execFileCaptured` and the Python children in `extension.js`.
  The fix is the version probe's pattern: its own timer calling `endProcessTree`.
- **Bare `taskkill` is resolved by libuv, which searches the cwd before PATH.** Use
  `%SystemRoot%\System32\taskkill.exe`.
- **On Windows, an npm `.cmd` codex can outlive an extension host that dies outright.**
  MEASURED 2026-10-14 with a stand-in that never reads stdin. A Node host killed outright (not
  deactivated) takes the trust worker with it through libuv's kill-on-close job, and the
  worker's job takes its `cmd.exe`. The shim's node grandchild breaks away from both jobs and
  keeps running. Deactivate's `taskkill /T` is unaffected. Unverified against a real build: a
  real codex that reads stdin should see EOF when the worker dies. Options are to resolve the
  shim to its node target and spawn node directly, or to accept the residual. Recorded in
  `test/codex-mcp-config.test.js`, "a worker whose host dies outright".

Each one moves to the engineering record with its disposition when it is fixed and gated.

### For the maintainer to decide (from the v1.6.2 audit, 2026-10-14)

The audit's findings are fixed and recorded in `docs/engineering-record.md` under "The v1.6.2
post-release audit (2026-10-14)". Two need the maintainer, because each changes the live
environment rather than the code:

- **The live hook runs the development checkout.** Any edit, branch checkout or mutation run in
  the maintained checkout changes the code the next real tool call runs against the real
  `settings.json` (the fixed-point stamp invalidates, so the edited generalizer runs at once).
  The backup mirror makes that recoverable. Pointing the hook at a stable copy (a worktree
  pinned to the latest tag, or the installed VSIX's bundled CLI) would separate the two.
- **Applying `"async": true` to the live hook registration.** The installers now write it (it
  takes a Node spawn, about 0.35–0.57 s on this box, off every Bash/PowerShell call). Re-running
  the installer from the checkout the hook should use applies it. The recorded cost is that
  `claude -p` kills a still-running async hook at teardown. Since wave-f8 (2026-10-14), that
  kill can no longer empty `settings.json`: the hook never writes in place. A killed pass is
  simply redone on the next tool call. See the engineering record's v1.6.2 post-release audit
  section.

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
