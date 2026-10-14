# Engineering record

What this project already decided, measured, or disproved. **Not a queue.** Open work lives
in `BACKLOG.md`; this file exists so a later session does not re-derive an answer,
or re-propose something already refuted with evidence.

MAX modes were removed from the product in the post-1.5.1 work. References below
are retained as historical incident evidence, not as descriptions of current
commands or supported behavior.

Split out of `BACKLOG.md` on 2026-09-14, when that file had reached 2,509 lines.
Its own preamble said closed items are removed since git holds the history, and that had
never once been practised: measured across twelve commits the file only ever grew. That pass
deleted 34 closed entries, moved 27 here, and left 36 genuinely open ones behind.

Four kinds of thing are here, and the distinction matters:

- **Refuted.** Built, measured, and found not to work. The `Refuted optimizations`
  section is explicitly a do-not-retry list.
- **Retracted.** Figures published in this repo and later found wrong, sometimes with the
  sign reversed. Read the correction, not the original.
- **Constraints.** Facts that decide how a future change must be shaped, such as what
  `runWildcarding`'s lock actually guarantees, or where an fs measurement is valid.
- **Standing decisions.** Calls the maintainer made deliberately. Not debt, and not to be
  reopened without asking.

The measurement protocol this project holds itself to, stated here because it is the rule
most often broken: **a performance figure is only real measured cold, in fresh interleaved
processes, against a purpose-built variant with the change removed.** Every figure here that
was not taken that way turned out to be wrong. The end-to-end noise floor for a ~60 ms spawn
on this machine is roughly +/-2 ms min and +/-5 ms p50, so any in-process saving under ~2 ms
is unmeasurable at the process level.

---

## Process-spawn follow-ups (2026-10-14)

Three follow-ups to "Process spawns: the v1.6.3 lifecycle and performance confirmation", below,
each re-verified in the code before it was changed.

### Bare-name spawns: the census — FIXED

1e11efa fixed this for taskkill. The premise, re-measured with libuv 1.52.1 and Node 24.19.0:
handed a bare name, libuv looks in the CURRENT DIRECTORY before PATH, and the directory is the
child's `cwd` option when one is given, the spawner's otherwise. A copy of node named
`python.exe` in that directory answered a bare `spawnSync('python')` in place of Python 3.14.
Only the SPAWNING process's own environment can turn it off, with
`NoDefaultCurrentDirectoryInExePath` (libuv asks `NeedCurrentDirectoryForExePathW`, which reads
the caller's environment). Setting it in the child's `env` did nothing, and with it set in the
spawner the copy did not run. The agent shell this was measured from sets it, so every test
below deletes it from the process that spawns.

The census covers every `spawn`, `spawnSync`, `execFile` and `fork` in `src/`, `bin/` and
`vscode-extension/` (the packed `vscode-extension/src/` copy excluded). The registered
PostToolUse hook spawns nothing; `bin/wildcard-perms` has one spawn, behind `--gates`.

| Site | Program | Runs in | Bare name before | Planted copy could run | Disposition |
|---|---|---|---|---|---|
| `--gates refresh` (`bin/wildcard-perms:895#resolvedLaunch`) | `TOOLBOX_PYTHON`, else `python` | a SessionStart hook's cwd, the session's project (no installer registers one; a user can), or the shell's | yes, whenever `TOOLBOX_PYTHON` is unset | **yes**, reproduced | **FIXED**: found on PATH; nothing found still reads "spawnSync python ENOENT" |
| `execFileCaptured` in vscode-extension/extension.js, "Why did this prompt?" | `autoLearn.codexExecutable`, default `codex` | the extension host's: wherever VS Code was started, per 1e11efa (not re-measured; listing a live host's directory handle needs elevation) | yes: commandLaunch handed an unresolved name back bare | **yes**, reproduced | **FIXED**: rejects with "spawn codex ENOENT", the words execFile used |
| The version probe, both doors (`src/codex-version.js:254#commandLaunch`, `src/codex-version.js:311#commandLaunch`) | the located codex | `--learn status`: the shell's; the dashboard probe: the host's | only when the second PATH walk, made after the location was cached, found nothing | in that window only | **FIXED**: launches the identity's own file, so the launch and the cache key are one file |
| Every `.cmd`/`.bat` launch (`src/exec-resolve.js:124#systemProgram`) | `ComSpec`, else `cmd.exe` | every caller's | yes, with ComSpec unset or relative | then | **FIXED**: ComSpec only when absolute, else System32's |
| The PATH walk itself (`src/exec-resolve.js:87#isAbsolute`) | any | — | — | yes, through a relative entry: `.`, or an unexpanded `%VAR%\bin` that a REG_SZ PATH leaves literal | **FIXED**: absolute entries only |
| `defaultCodexValidator` in src/auto-learn-manager.js (the Auto Learn `execpolicy check`) | `codexExecutable`, default `codex` | the Auto Learn worker thread's (the host's); `--learn`: the shell's | no: unresolved on Windows throws its "codex executable not found" | no | none |
| `nativeRpc` and `nativeRpcAsync` in src/codex-mcp-config.js | `nodeExecutable`, default `node` | the caller's | no: unresolved throws | no | none |
| The config worker's app-server | `npmShimLaunch`'s node, else commandLaunch | `request.home` | no: unresolved is "Codex executable is not reachable" | no | none |
| `endProcessTree`, the worker's grace kill | `taskkillPath()` | — | no, since 1e11efa | no | none; the grace kill is the next entry |
| `npmShimLaunch`'s node | the shim's own `node.exe`, else PATH's | — | no: none found returns null and the `.cmd` route is used | no | none |
| `run` in src/codex-recall.js | an absolute `pythonExecutable`, an absolute existing `TOOLBOX_PYTHON`, or the toolbox manifest's absolute path | the worker's | no: anything else is the lexical fallback | no | none |
| The recall rebuild, sync and gate compile (three `execFile(st.py, …)` in extension.js) | `toolboxPython()`: `CODEX_TOOLBOX` or `%LOCALAPPDATA%\DevToolbox`, then `python\.venv\Scripts\python.exe` | the host's | no: a path, checked to exist first | no; a relative `CODEX_TOOLBOX` would be the user's own environment | none |
| src/spawn-thread.js's `execFile` | the caller's file: only the version probe | the host's | as the probe | — | covered by the probe row |
| `new Worker()` (spawn-thread, autoLearnWorkerRunner) | a module path, not a program | — | — | — | not a spawn |

**ACCEPTED-RECORDED, POSIX.** execvp walks PATH alone, so no site above searches the cwd
there. An empty or relative PATH entry is a cwd lookup that the user's own PATH asked for,
and execvp honours it; nothing here changes POSIX. **Not in the census:** the `scripts/`
harnesses spawn bare `taskkill`, `git` and `powershell.exe`, and some spawn
`commandLaunch('codex')` without checking it resolved. They are maintainer tools run from the
checkout and are not shipped.

**What changed.** `resolvedLaunch(name, args, syscall)` (`src/exec-resolve.js:143#resolvedLaunch`)
is commandLaunch that never returns a bare name. On Windows an unresolved name throws the error
spawn raises when there is nothing to find, in its words: `<syscall> <name> ENOENT`, code ENOENT,
with spawn's `syscall`. The hook's compile and `execFileCaptured` use it, the second inside the
promise, so it is a rejection there as before. extension.js is line-neutral. The version probe
launches `id.resolved`. On POSIX that is the file `walkFor` found, which is the one execvp would
run. A python found through PATHEXT can now be a `.cmd` or `.bat`, such as a pyenv-win shim, and
it runs through cmd.exe. A bare spawn skipped those, because libuv tries `.com` and `.exe` only.

**Pinned by**, each confirmed to fail with its own fix reverted:
- "CLI --gates refresh never runs a python planted in the project directory it runs in"
  (test/cli-gates.test.js). Reverted, the planted copy ran `recall.py --gates-compile`.
- "\"Why did this prompt?\" refuses a codex name PATH does not hold, and never runs the copy in
  the host's cwd" (test/dashboard-project-trust.test.js). Reverted, the planted copy ran the
  `execpolicy check` arguments.
- "the version probe launches the file its identity resolved, not whatever a second PATH walk
  finds" (test/codex-version.test.js). It covers both doors, each reverted separately.
- In test/exec-resolve.test.js:
  - "a name nothing on PATH holds is refused before spawn, so a copy planted in the current
    directory never runs". Its precondition runs the hazard for real.
  - "a relative PATH entry is never searched, so \".\" and an unexpanded %VAR% entry cannot
    supply a program".
  - "a batch shim runs System32's cmd.exe when ComSpec is missing or not a full path".
- Neutering `resolvedLaunch` alone fails both call-site tests as well.

### The config worker's grace kill read `exitCode` alone — UNREACHABLE as shipped; FIXED anyway

**Verified in form.** The kill in the worker's `finally` (src/codex-mcp-config.js) skipped a
child only when `exitCode` was set. A child that exited by a signal has `exitCode` null and
`signalCode` set, so this is the shape 6dfe60b fixed in `endProcessTree`. **Refuted as a live
defect**, measured on this box with Node 24.19.0:
- On Windows, `signalCode` is set only when THIS process ends the child with `child.kill()`
  (`SIGTERM`, exit code null). An outside `taskkill /F` gives exit code 1 with no signal, and
  an exit by itself gives its own code. libuv sets the exit signal only in `uv_process_kill`,
  and the worker never calls `child.kill()` on Windows.
- On POSIX the old branch was `child.kill('SIGTERM')`. After 'exit', Node's `kill` finds
  `_handle` null and returns false without signalling (read from Node 24's own source; the
  probe returned false on all three exit kinds).

**What changed.** The grace kill is now `endProcessTree(child)`. Its guard reads both codes,
and on Windows it runs System32's taskkill /T. On POSIX it tries the group signal, which fails
with ESRCH because the app-server leads no group, and then calls `child.kill()`, exactly what
the old branch did. One guard for every tree kill means a later `child.kill()` in the worker
cannot make the old shape reachable. Its Windows taskkill is now asynchronous; the worker was
only awaiting 'close' anyway. Pinned by "the config worker's grace kill skips an app-server
that exited by a signal, and still ends a live one" (test/codex-mcp-config.test.js,
Windows-only, because on POSIX the two versions behave the same). It drives the state in the
real worker: a preload kills the `.cmd` stand-in's cmd.exe as the `finally` begins, so the exit
is by a real signal. The node under it holds stdout, so 'close' comes 3 s after the 1 s grace,
and the preload records every taskkill and runs none. Under the old kill it recorded
`taskkill /PID <the signalled PID> /T /F`, 1.0 s after that PID's exit. Its control, a live
app-server, records the tree kill with the fix in place. 1e11efa's planted-taskkill worker test
still fails with taskkill named bare, now in `endProcessTree`.

### The push bench is in the repo — DONE

`scripts/measure-push-host-thread.js` is the measurement behind the push figures in "Process
spawns", below. Until now it lived outside the repo as four files (the bench, a PowerShell
loop and two summarisers); it is now one script. Usage is in its header. What it guarantees:
- Every sample is a fresh process, the trees alternate sample by sample, and it reports n and
  p50 [min-max].
- A tree is this checkout, or any revision extracted with `git -c core.autocrlf=false archive`
  into its own temp dir.
- It writes only under one temp dir it creates, and checks every write against that dir. A
  sample's HOME, USERPROFILE, CODEX_HOME, TMP, TEMP, APPDATA and LOCALAPPDATA all point there,
  and the sample asserts this itself before it runs anything.
- The provider credentials are removed using the one shared list,
  `PROVIDER_CREDENTIAL_ENV`, plus the rest of the `OPENAI_` and `AZURE_OPENAI_` families.
- The codex it is given is executed only, never written. A Codex install location (winget
  Links and Packages, npm's global folder, the folder and link target of the given codex and of
  PATH's) is never written, and `--tmp` inside one is refused before anything is created. A
  temp dir inside the checkout is refused as well. Tested against fake roots: all three
  refusals fire, and nothing is created.
- `--stand-in` writes a node stand-in into the temp dir, for a box with no codex.

**Re-run 2026-10-14** with the real winget codex.exe 0.161.0, n=11, `--before 2d8d223^ --after
2d8d223`, on a box shared with another worktree's suite runs:

| p50 [min-max], ms | a140dc5 | 2d8d223 | recorded |
|---|---|---|---|
| Cold push, push → next setImmediate | 704.7 [662.4-724.6] | 21.2 [19.3-55.0] | 673 → 20 |
| After a config.toml edit | 225.9 [218.6-232.4] | 8.8 [8.0-9.9] | 218 → 8.1 |
| Warm push | 7.6 [6.8-8.2] | 7.4 [7.0-10.5] | 7.2 → 7.0 |
| Loop-delay max: cold, after an edit | 707.8, 226.1 | 21.6, 16.1 | 674 → 20.6, 218 → 16.1 |
| Both answers on screen after a cold push | 1,762 | 1,318 | 1,586 → 1,229 (n=7) |

The order of magnitude reproduces, and the "before" column is about 5 % above the recorded
figures, inside this box's process-level swing (see the MEASUREMENT HAZARD in the v1.6.2
section). This branch against its base fb5f44f (n=7, same codex) measured: cold 22.7 against
22.3, after an edit 9.0 against 9.1, warm 7.5 against 8.0. The bare-name and grace-kill changes
cost the push nothing measurable.

---

## The v1.6.3 release commit's CI failures (2026-10-14)

CI run 38525363435 on `7cbba2b` failed 5 of 7 jobs; Windows Node 24 and the PowerShell 5.1
installer job passed. Two failures were test defects and one was a real POSIX defect. Reproducing
it found a second real defect. The confirmation audit added two LOW findings in the same files.

| Finding | Disposition | Evidence |
|---|---|---|
| `codex-version.test.js` cancelled on Node 20/22 | **FIXED (test)**, `09ced02` | The timeout case awaited the probe's deliberately unref'd timer, and the stand-in child is not a process, so nothing held the loop. Node 24's runner happened to keep its own loop alive. The test now fires the timer by hand and pins that it is unref'd. No product path awaits that timer alone: a real child is a ref'd handle, and `--learn status` probes synchronously (verified on Node 22). |
| Deactivate left a hung codex running on Linux | **FIXED**, `f8a3b92` | `execFile` copies a fixed option list to `spawn` and drops `detached`, so the trust worker never led a process group. The `-pid` signal therefore hit ESRCH. The worker is now `spawn`ed, and the app-server stays in the worker's group, so one signal ends the whole tree. Windows was never affected. |
| A worker whose host dies orphaned its codex | **FIXED on POSIX**, `c108d04`; Windows residual below | With the host SIGKILLed, the worker ran to its 25 s deadline and then died of an unhandled EPIPE before its armed kill fired; the codex was alive 30 s later. The worker now ignores stdout/stderr errors and watches its parent (ppid change or parent gone), which ends both within about 2 s. |
| The version-probe dashboard test raced on Linux | **FIXED (test)**, `5ab4cc5` | It assumed `--version` is slower than the 150 ms settle. That holds for cmd.exe → node, not for sh → node. The stand-in's `--version` is now gated. |
| `endProcessTree` could aim a tree kill at a freed PID | **FIXED**, `6dfe60b` | A signal-killed child has `exitCode` null and `signalCode` set; both are read now. Measured: at 'exit' the gap before 'close' is under a millisecond here. Unverified: taskkill /T walks ParentProcessId, which Windows does not clear when a parent dies. |
| A trust-ask timeout was cached for the life of the window | **FIXED**, `e79e2a9` | A timeout now stands for 60 s, and the next push then asks again. A codex that never answers costs one ask per minute of pushes, not one per push. Other outcomes are cached as before. |

**HARNESS HAZARD, 2026-10-14.**
- Linux in podman:
  - Stream `git -c core.autocrlf=false archive <rev>` into the container, not a folder subset.
  - Run with `--init`, because a zombie still answers `kill(pid, 0)`.
  - The node images have no git and run as root, so 13 tests fail there on any commit. Compare against a control run on the base commit.
- Windows: a `.cmd` stand-in's hidden console host keeps its cwd for about 1 s after the last client dies, and Node 24's `rmSync` does not retry that EPERM.

## The v1.6.3 confirmation audit (2026-10-14)

Two read-only audits re-checked `7cbba2b` against v1.6.2 before tagging. The first covered
regressions and dead code: suites green, and 281 common commands showed no new refusals; the
census catches planted defects. The second covered lifecycle and performance: no new leak, and
every figure at or better than v1.6.2. Their findings, beyond the two in the CI table above:

| Finding | Disposition | Evidence |
|---|---|---|
| A stored null-rule family that had not run since the upgrade could be written despite a user deny or managed ask (MEDIUM) | **FIXED**, `819e4ab` | Reproduced with no scan: a deny on `Bash(cargo --version *)` and a managed ask on `Bash(df -h:*)` listed as policy `unknown`, and a reviewed apply wrote both. `takeExporterRule` now runs first in `refresh` and sets the stored rule to what the write itself renders (`candidateClaudePermission`, now exported). Every reader judges the rule that lands. `revivesNullRule` (b4643ed) was a second, untested source of the same rule and is removed. Pinned by `test/auto-learn-null-revival.test.js`, which uses a scanner that throws if called. |
| A missing configured history root pinned the Codex evidence rebuild in silence | **FIXED**, `3ce06e0` | It blocks auto-safe and makes a reviewed apply throw, so it is a reason, not a note. `rebuildHeldOpenReason` names folders only and never a path, and fires only when a pending transcript was not found by the walk. The scan-health line's ✓ is a follow-up (BACKLOG). |
| A pending project-trust verdict rendered "No saved permissions yet" | **FIXED**, `8f2af8f` | The empty message also requires `codexCounted`. While the verdict is pending, the list ends with a "not listed yet" line. Controls cover the settled verdict and the truly empty case. |
| make's other program variables still rendered in Codex export | **FIXED**, `b9854f6` | Reproduced: 44 broad rows, for example `make AR=./x lib`. Refused now: every program in GNU make's built-in table outside VMS (`src/default.c`), the GNU Coding Standards program variables, and the built-in rules' full command lines (`COMPILE.*`, `LINK.*` and so on). Matching is case-exact. 18 data rows still render (VERBOSE, PREFIX, DESTDIR, CFLAGS, …). just is unchanged: measured with just 1.58.0, it has no built-in variables, and overriding an undeclared one is an error. |
| `memory.recallScript` and `backupMirrorPath` were window-scoped | **FIXED**, `177c901` | Both are `"scope": "machine"`, read through `inspect().globalValue` like `autoLearn.codexExecutable`. A workspace value is never used. |
| The push figures left out CreateProcess time on the host thread | **FIXED**, `2d8d223` | MEASURED: `execFile` blocks its caller inside CreateProcess, at p50 428 ms for the real winget `codex.exe` and 203 ms for node. The recorded "106 ms cold" held only with a `.cmd` stand-in. Both of the push's spawns now start from worker threads: see "Process spawns: the v1.6.3 lifecycle and performance confirmation (2026-10-14)", which has the corrected figures. |
| The hook's in-place fallback could empty settings.json under a teardown kill | **FIXED**, `3c2724d` | See "A held settings.json was rewritten in place by a hook that can be killed" in the v1.6.2 post-release audit section. |

## The v1.6.2 post-release audit (2026-10-14)

Four read-only audits ran over the released v1.6.2: regressions, dead code and dead ends,
lifecycle and leaks, and performance. The live hook path and every standing decision were
intact; a differential over the new matcher axes (wrappers, safe and kept environment variables,
xargs, star-free rules) found 0 disagreements between the coverage index and a full scan in
18,000 cases, and every generalizer difference against v1.6.1 over 140,000 entries was a stated
narrowing or the documented wrapper re-key. Everything below was found by those audits and fixed
or recorded the same day.

| Finding | Disposition | Evidence |
|---|---|---|
| The dashboard push blocked the extension host on a synchronous Codex `config/read` | **FIXED**, `c85c10d` | Introduced by the trusted-project discovery. The push now reads the trust verdict from cache, a miss refreshes in the background (tracked, 10 s bound, tree-killed on deactivate), and only `.codex` folders with `rules/` are asked about. Cold push 1,106 → 106 ms, push after a `config.toml` edit 980 → 9 ms, a Codex that never answers 31,331 ms → under 120 ms. **CORRECTED 2026-10-14:** the "after" figures hold only for the `.cmd` stand-in they were taken with. With the real winget codex.exe the same push held the host 673 ms cold and 218 ms after an edit (p50, n=11; scripts/measure-push-host-thread.js), because the spawns it started block the calling thread; both now run on worker threads, see "Process spawns: the v1.6.3 lifecycle and performance confirmation". |
| `autoLearn.codexExecutable` was window-scoped | **FIXED**, `b7c9a8d` | A workspace setting chose the executable the push now runs. Machine scope, read from the user tier only. (VS Code already disables the extension in Restricted Mode, because it declares no `untrustedWorkspaces`.) |
| A rebuild could finish while a Codex root was missing | **FIXED**, `7ce6217` | A vanished root read as a clean walk, so pending ids were dropped and auto-safe could grant against a failure in that root (reproduced: granted on scan 2, revoked on scan 3). A missing configured root now holds the rebuild open; an `archived_sessions/` that never existed is benign, a dangling link there is not. |
| Reviewed Claude rules for informational forms disappeared, and an upgrade revoked them | **FIXED**, `3417398`, `bee0f82` | The exporter honoured an explicit null rule on the false premise that every withholding reason was also a complexity reason. The learner now writes the informational word, and only an env-kept assignment withholds a rule. Families stored with a null rule were revived on their next run (`b4643ed`); until that run the managed-inert and user-deny checks still judged the null while the write rendered the derived rule (F1 of the v1.6.3 confirmation audit, reproduced: a reviewed apply of stored state wrote a user-denied and a managed-ask rule). The rule is now derived on load by the exporter function the write calls (`takeExporterRule`), which replaces the next-run revival. |
| Codex export bypasses and gaps | **FIXED**, `4a02252`, `09df009`, `bee0f82`, `e6d227c`, `f23e978`, `08978d9`, `c16728e`, `1d66310`, `b11038d`, `453c980` | Versioned and aliased interpreter names and `.cmd`/`.bat` spellings normalize to their base for every refusal table. hyperfine and wsl render only measured informational forms; duckdb runs an init file's `.shell` even under `--version` (measured) and is broad at any depth. iex, Invoke-Expression, Invoke-Command and icm are broad. bunx, pnpx, `deno x` and `dx` are judged as their long forms. A runner `-e` value that loads or names a program, any `--env-file`/dotenv option, a make or just override that chooses the recipe shell, and node's `--openssl-config` / `--experimental-config-file` make a prefix broad. The exporter header now states the governing principle (narrow only when the program is pinned and every option is modelled inert) so a later residual is judged by it rather than by a new audit. **ACCEPTED-RECORDED:** tokens after a fixed subcommand or task target stay unread (make excepted), so `npm test --node-options=…` is admitted; refusing it would refuse `npm test`, which already runs whatever the package script says (measured with npm 11.17.0). |
| `bash -C <script>` widened unrecorded | **CORRECTION** | `668a685`'s "none went the other way" held for its 132-prefix probe, not the whole space: `["bash","-C","x.sh"]` was refused before only because the old check lowercased `-C` (noclobber) to `-c`. Benign — noclobber runs nothing and the prefix pins the script. |
| The starter pack tripped its own diagnostic | **FIXED**, `0b063ed` | `Bash(export *)` (in the pack since v1.0.0, not one of the 13 maintainer-kept grants) is removed; the 13 are exempt from the over-broad count by one shared list with a drift test. |
| The Codex memory lint missed dangling references in common Markdown spellings | **FIXED**, `9d5f622` | The token boundary aimed at a `skills/` false positive also silenced `**rollout_summaries/x.md**`, `./…`, `|…|`, `label:…`. |
| A dead branch with a false mutation claim | **FIXED**, `ddbb329` | Reachable after all (a stripped wrapper followed only by assignments); now pinned by a test. |
| Lifecycle and cost | **FIXED**, `c85c10d`, `d27ac77`, `dde59b0`, `1828046`, `e8c74e6`, `a16e586`, and the atomicWrite commit after them | The version probe's resolved path is cached (597 → 5 stats per push); one cache slot per executable; a deactivate kill is never cached as a timeout; tracked children are ended as process trees (an npm `.cmd` shim left its grandchildren running); the project-trust cache holds parsed trust only, never `config.toml` text; download retries carry the activation generation; the scan-trouble log keys on kinds of trouble. The history-store probe reads thread ids from the projection table alone and reuses the scan's own listing: 247.9 → 23.3 ms on a 1M-item synthetic home, verdicts identical. One rename-retry policy (codes, ten attempts, 0.9 s) is shared by every writer. |
| Dead code and duplication | **FIXED**, `1e70869`, `3579e52`, `5e51476`, `9166322`, `d9c6103`, `309e00d`, `7a8d968`, `63bc23c`, `2e727e0`, `10398ba`, `cd839bc` | A full `processAllowList` pass per push fed a field nothing rendered; it and other unread payload fields, a dead message route, unsupplied option keys and dead `scripts/` exports are gone. The census counts an import only when its name is used, audits `scripts/` and reads git's tree; new tests assert every payload field has a reader and every message route a sender. `RISK_RANK`, the rename-retry set and the harness credential list each have one copy; the Codex version record and `permissions.js`'s require closure are pinned by tests. |
| Installers | **FIXED**, `d7e936e`, `592bf06` | Spaced and `/cygdrive/` spellings are recognised and spaced registrations quoted; `uninstall.sh` folds case only on Windows. |
| CI exposure | **FIXED**, `0c0f549` | `vsce` pinned to 4.0.0 and packaged on Node 22 (it declares Node ≥ 22; Node 20 is end-of-life); a Node 24 leg matches the extension host's runtime. |
| The hook blocked every Bash/PowerShell call | **FIXED in the installers**, `c56ebdb`; live registration a maintainer decision | The installers write `"async": true`: documented on code.claude.com/docs/en/hooks (read 2026-10-14), first in Claude Code 2.1.15, and every client from 1.0.82 to 2.1.14 parses hooks with a non-strict schema that strips the key, so the hook simply stays synchronous there. Concurrent runs are covered by the policy lock and the idempotent pass. Recorded cost: under `claude -p` a still-running async hook is killed at teardown, so a rare in-place settings write could be cut short — the reason applying it to an existing registration is the maintainer's call. |
| A lost failure across a session switch | **ACCEPTED-RECORDED**, `4eb4177` | No real rollout writes a `session_meta` mid-file (13 rollouts, 704 calls surveyed); the verdict is pinned by a test. |

**MEASUREMENT HAZARD, 2026-10-14.** This box no longer matches the protocol's baseline: a bare
`node -e 0` costs about 330 ms (Git Bash plus node about 550 ms) under endpoint security, against
the ~50 ms the noise floor at the top of this file assumes, and process-level deltas swung by up
to 15 ms between runs. A process-level A/B here needs in-process timing or a much larger n. The
same day, under four concurrent worktrees driving Codex, one `codex execpolicy check` contract
run took 547 s of repeated 60 s timeouts and passed in 20 s alone — the timeouts held, and the
product's validator (30 s, in the Auto Learn worker) is off the extension-host thread.

### A held settings.json was rewritten in place by a hook that can be killed — FIXED, `3c2724d`

Found by an audit on 2026-10-14, after the installers began registering the hook `"async": true`
(the table's "hook blocked every Bash/PowerShell call" row, whose recorded cost this closes for
every write the hook makes). `writeFileAtomicSync` (`src/permissions.js:29#writeFileAtomicSync`) writes a
unique `<target>.<pid>.<base36>.wc.tmp`, retries the rename ten times (0.9 s), and then used to
write the target IN PLACE: truncate, then fill.

| Measured by the audit | |
|---|---|
| Fallback rate, uncontended | 0 of 380 writes |
| Fallback rate, another process holding settings.json for 0.9 s or more | every write, even when the holder shares delete |
| The truncating open | waits about 90–120 ms in the endpoint scanner first |
| The window that follows | settings.json reads 0 bytes for p50 0.36 ms, max 1.2 ms |
| Loss rate | ESTIMATED, not measured: about 3×10⁻⁴ per fallback write that overlaps a `claude -p` teardown |

Why it mattered: `claude -p` kills a still-running async hook at teardown, and a kill inside the
window leaves settings.json EMPTY, with deny rules, hooks and env gone. Rare, and the worst outcome
this tool can produce. Re-verified before anything changed: a second Node process holding the file
through Node's own open (which shares read, write and delete) made `writeFileAtomicSync` spend
986 ms on refused renames and then write in place, with the fallback warning.

**What changed.**
- `writeFileAtomicSync(target, content, { inPlaceFallback })`, default `true`, which is the old
  behaviour. Under `false` (`src/permissions.js:94#inPlaceFallback`), once the retries run out the
  temp is unlinked, the target is left byte-identical, and it throws `SETTINGS_CONTENDED_CODE` with
  the refused rename as its cause. A rename failure no retry fixes (EXDEV, ENOENT) is thrown as
  itself, so the hook never waits in silence for a holder that does not exist. Against the same
  holder: 963 ms, then the coded throw, the file unchanged, no temp, no warning.
- `SETTINGS_CONTENDED_CODE` is now defined at `src/permissions.js:928#SETTINGS_CONTENDED_CODE`,
  because that module may require only `./permission-match`. `src/settings-write.js:20#SETTINGS_CONTENDED_CODE`
  imports and re-exports it, so there is one definition and every existing reader is unchanged.
- The option is plumbed through `createSettingsWriter` (`src/settings-write.js:148#inPlaceFallback`)
  to both of its writes, and through `drainLocalSettings` (`src/local-settings.js:211#inPlaceFallback`)
  to the drain's snapshot and its prune.
- The hook passes `false` for every write it makes: the wildcarding write
  (`bin/wildcard-perms:573#inPlaceFallback`) and the drain (`bin/wildcard-perms:609#inPlaceFallback`),
  which carries it to the promotion into settings.json and to the snapshot and prune of
  settings.local.json. CONTENDED is handled like a busy policy lock
  (`bin/wildcard-perms:602#SETTINGS_CONTENDED_CODE`): exit 0, nothing on stderr, nothing written,
  and the next tool call redoes the pass, which is idempotent. The fixed-point cache needed no
  change. It writes with a plain `writeFileSync`, where a torn key is a miss, and the hook records
  a key only for bytes it verified as a fixed point, never after a write attempt. So a contended
  pass leaves no key, and the next call is a miss that redoes it.
- A held drain SNAPSHOT now stops the prune instead of being skipped
  (`src/local-settings.js:174#SETTINGS_CONTENDED_CODE`). Writing it in place could empty the whole
  history. Skipping it and pruning anyway would leave that round out of the only record of what
  the project had approved. Stopping costs nothing, because the next call does both.
- The orphan sweep (`src/permissions.js:954#sweepOrphanedTemps`). Nothing ever removed the temp of
  a writer killed inside its retry window, which is a full copy of settings.json. Each write now
  removes sibling files that meet all three tests: the name is exactly
  `<basename>.<digits>.<base36>.wc.tmp`, matched as a literal prefix and suffix so no basename
  character is read as regex syntax; lstat says regular file; and the mtime is more than ten
  minutes old (`ORPHAN_TEMP_MIN_AGE_MS`). A live writer's temp lives about a second. The cost is
  one readdir, paid only when a write happens. Every error is swallowed, and the sweep runs on both
  paths.

**Who still writes in place, and why.** Everything except the hook:
- the extension: its settings writer, its drain, its backup copies and its Codex config write;
- the user-invoked CLI verbs: `--bypass`, `--max off`, `--seed`, `--drain`,
  `--codex-workspace-rules remove` and `--codex-max off`;
- the guidance, derived-guidance, Codex hook, MCP config, legacy-backup and bypass-sidecar writers.

No teardown kills them mid-pass, and an update they drop would not be redone by itself, so the old
trade still holds for them. An extension host can also be killed at shutdown. If that is ever
measured, the extension can opt in with the same one option; `vscode-extension/extension.js` was
not changed in this pass. `atomicWrite` in src/auto-learn-manager.js and `strictWrite` in
src/codex-memory-gates.js never had a fallback: both fail closed.

**Pinned by** seven tests at the end of `test/settings-write.test.js`, and four at the end of
`test/cli-hook.test.js`. One of the four is Windows-only and holds the file with a real process.
Every test was run against a revert of its fix:
- Reverting all four source files at once fails every one of them except the control. The control
  passes at baseline and fails only when the default flips.
- Each of sixteen single-point mutations is killed by the test written for it. They cover the
  option branch, the sweep call, each plumbing site, the snapshot rethrow, an unescaped basename
  pattern, the age test, the isFile test, a hook that reports contention, a flipped default,
  contention reported for EXDEV, and a second definition of the constant.

**Residual, recorded.**
- A holder that NEVER lets go now means the hook never writes, in silence, where it used to write
  in place. Nothing measured on this box holds settings.json for longer than a scan. The extension
  and the verbs still write in place, and against a permanent holder the in-place write is exactly
  the risky one.
- When the wildcarding write is contended and a drain is also due, the drain's promotion can wait
  its own 0.9 s. A contended hook run is therefore bounded by about 1.8 s of retries, which the
  async registration keeps off the tool call.

## Process spawns: the v1.6.3 lifecycle and performance confirmation (2026-10-14)

The second confirmation audit of the 1.6.3 commit (lifecycle and performance, measured) found
four process-spawn defects, and CI run 38535034218 a fifth in the same worker. Each was
re-verified in the code before it was changed; the measurements below were taken again for this
record, on the development box, with the method named in each row.

| Finding | Disposition | Evidence |
|---|---|---|
| The dashboard push held the extension host for every spawn it started | **FIXED**, `2d8d223` | Verified: on Windows `spawn()` and `execFile()` return only once CreateProcess has. Measured here, how long spawn() held the calling thread (n=15, p50): node 207 ms, cmd.exe 74 ms, taskkill 61 ms, the real winget codex.exe 465 ms; the audit had 203 and 428 ms. The push ran the version probe's execFile inline and the trust worker's spawn in the microtask after it. **Design: one worker thread per spawn** (src/spawn-thread.js), running the existing code unchanged (the probe's execFile, and `nativeRpcAsync`) and holding the ChildProcess there. The host holds a ThreadChild, which `track` hands to trackChild, and `endProcessTree` ends it by asking the thread to run `endProcessTree` on the real child. So the tree kill, the POSIX group signal, the freed-PID guard, the 10 s backstop, the worker deadline (counted from the host's call), the 16 MiB bound, the wordings, the one-refresh latch and the 60 s timeout TTL are the same code, not copies of it. The process tree is unchanged, so host death is too: measured, a host SIGKILLed with the thread in between still took its worker on Windows, because libuv's kill-on-close job belongs to the process. `new Worker()` costs the host 0.44 ms (p50, n=15), and a 700 ms spin on the main thread saw a longest gap of 4.1 ms while a thread spawned the real codex (5.1 ms with no spawn at all). **Declined, design (b): the trust ask itself on a thread**, which would also drop the node spawn. It makes the app-server a direct child of the host, which loses c108d04's host watch on POSIX (nothing would end a hung codex after a host death), it leaves the npm-shim residual on Windows as it is, and the node spawn is off the host thread anyway. **Measured** with the real codex.exe 0.161.0 (HOME, USERPROFILE and CODEX_HOME in a fresh temp dir, OpenAI variables removed) through the real `_push()` under the stub-vscode harness of test/dashboard-project-trust.test.js, a fresh process per sample, the tree before this change and after it interleaved, n=11, host-thread time from the push to the next setImmediate, p50: cold push with a project `.codex/rules` 673 → 20 ms, push after a config.toml edit 218 → 8.1 ms, warm push 7.2 → 7.0 ms. Reproduce with `node scripts/measure-push-host-thread.js --codex <codex> --before 2d8d223^ --after 2d8d223` (re-run under "The push bench is in the repo", above). The event-loop-delay histogram's maximum agrees: 674 → 20.6 and 218 → 16.1 ms, where about 16 ms is this box's timer floor. Both answers were on screen 1,586 → 1,229 ms after a cold push (p50, n=7), because the two spawns no longer queue on one thread. Pinned by "a cold push starts no process on the host thread, and both Codex answers still arrive" (test/dashboard-project-trust.test.js; fails with `offThread` dropped from either call) and by test/spawn-thread.test.js, whose tree-kill test fails with the thread ignoring the end request or with `endProcessTree`'s END_TREE branch removed. Still on the host thread: the extension's four execFile sites (user-initiated or background, not the push) and deactivate's own taskkill. |
| execFile's own `timeout` orphaned the program under a launcher | **FIXED** on Windows, `f1f2de1`; POSIX **ACCEPTED-RECORDED** | execFile's timeout is `child.kill()` on the one PID it holds, and on Windows each of the extension's four execFile children is a launcher: an npm `codex.cmd` (cmd.exe → node) for the 30 s `codex execpolicy check` in `execFileCaptured`, and the DevToolbox venv `python.exe` for the recall rebuild and sync (180 s) and the gate compile (60 s). That `python.exe` is a redirector whose interpreter is its child (measured: the interpreter's parent PID was the PID spawn returned). Ended that way the program kept running, and because it held the pipes it inherited, execFile's callback never came either; endProcessTree could not reach it afterwards, because it finds a tree by its root. Each site now takes its deadline from `endTreeAfter` (src/exec-resolve.js), the version probe's pattern: a timer of its own that tree-kills the still-live root. The four lengths and the reported wording ("Command failed: …" plus stderr) are unchanged. Pinned by "a deadline from endTreeAfter ends the program under a launcher, which killing the launcher alone leaves running" (test/exec-resolve.test.js; fails with the timer calling `child.kill()`) and "every execFile site takes its deadline from endTreeAfter, never from execFile's own timeout" (test/extension-lifecycle-async.test.js; fails with one site reverted). **POSIX:** endProcessTree reaches a whole tree only through a process group, and execFile cannot start a group leader (it drops `detached`, f8a3b92), so the deadline ends the child alone there, exactly as before. These sites have no grandchild on POSIX: a venv's python is the interpreter, `RECALL_REEXEC=1` suppresses recall.py's own re-run, and a native codex is one process. An npm-installed codex on POSIX is node → native codex; whether that launcher forwards SIGTERM was not re-verified here. |
| The trust worker's graceful timeout could lose to the host's backstop | **FIXED**, `a140dc5` | CI run 38535034218 failed "the asynchronous layers read does not block…" on Node 20 / windows-latest only ("unavailable: the worker timed out", 6,478 ms). Confirmed in the code, not reproduced on the runner: the worker armed `deadlineMs` (timeoutMs − 3 s) as a length, after its own start, its module load and its codex spawn, then spent a 1 s grace and a synchronous taskkill before it exited, so the graceful path needed startup plus taskkill under 2 s, in the 4 s test and the 10 s product budget alike. The deadline is now a time, `deadlineAt`, fixed when `nativeRpcAsync` is called (src/codex-mcp-config.js, "THE DEADLINE IS A TIME, NOT A LENGTH"), so the worker's start comes out of the codex's 7 s and the whole 3 s margin is left for the grace, the kill and the exit. Budget, grace, backstop and wordings are unchanged; a worker that starts after its deadline fails the call at once. Pinned by "a worker that starts after its deadline still ends its own codex before the host's backstop" (a preload holds the worker 5.5 s, past the 5 s deadline of an 8 s budget; fails with the deadline made a length again). The original test still fails with `deadlineAt` dropped. |
| On Windows an npm `codex.cmd` outlived an extension host that died outright | **FIXED** for the shim npm writes; any other `.cmd` **ACCEPTED-RECORDED** | Verified in "a worker whose host dies outright" (test/codex-mcp-config.test.js): libuv puts every child in a kill-on-close job that allows silent breakaway, so the worker's job held cmd.exe and not the shim's node, which survived the host. The worker now launches its app-server through `npmShimLaunch` (src/exec-resolve.js). A `.cmd` whose text is exactly cmd-shim's (npm 7 and later; @openai/codex needs one of those), with a relative target that exists, runs as `node <target>`, using the shim's own node.exe or else node from PATH, as the shim itself would choose. That node is then the worker's own child, in the worker's job, and the native codex the npm launcher starts is in that node's job. Anything else returns null and launches through cmd.exe as before. Small and in one place: the worker's launch only; the version probe and the execpolicy check exit by themselves and keep the `.cmd`. Pinned by "the shim npm writes is run as the node script it names; every other shape is left alone" (test/exec-resolve.test.js). Its shim is generated by the cmd-shim (8.0.0 here) bundled with the running node's npm, so it is npm's own output, and six other shapes return null. Also pinned by "on Windows, an npm-shim codex dies with a host that dies outright" (test/codex-mcp-config.test.js), which fails with the worker back on `commandLaunch` alone. A winget or standalone codex.exe was never affected: it is the worker's direct child. **Residual:** a hand-written or other-generator `.cmd` still breaks away. Deactivate's taskkill /T still ends it; only an outright host death does not. S1's design leaves this as it was, because the node worker still exists (design (b) was declined). Observed once and not reproduced: when a whole running suite was killed from outside, an npm stand-in that a worker started at that same instant survived. That fits libuv adding a child to its job only after CreateProcess returns (200–470 ms here), so a worker killed inside that call leaves the child in no job. Unverified. |
| Bare `taskkill` is resolved from the current directory | **FIXED**, `1e11efa` | libuv resolves a bare name itself and looks in the cwd before PATH unless the environment carries `NoDefaultCurrentDirectoryInExePath`. Measured (libuv 1.52.1, Node 24.19.0): with the variable unset, a copy of node named `taskkill.exe` in the cwd ran in place of System32's; with it set, it did not. The extension host's cwd is wherever VS Code was started, and the Codex config worker inherits it. The variable was set in the agent shell the audit ran from, and in neither the user nor the machine environment, so a test run from such a shell passes against the unfixed code: both new tests remove it. `endProcessTree` and the config worker's grace kill now run `taskkillPath()`, `%SystemRoot%\System32\taskkill.exe`. Pinned by "the tree kill runs System32's taskkill, not one planted in the current directory" (test/exec-resolve.test.js) and "the config worker's own kill runs System32's taskkill, not one planted in its cwd" (test/codex-mcp-config.test.js); each fails with its own site reverted. The planted copy's flag is not the only witness, because endpoint scanning can hold a freshly copied executable's first run past the kill's own timeout: the first test also requires that the node under a cmd.exe dies, which only `/T` does, and the second that the worker's own deadline is the answer. Same class, not changed here: `bin/wildcard-perms` spawns `TOOLBOX_PYTHON \|\| 'python'` by bare name, and `commandLaunch` hands an unresolved name back bare, which `execFileCaptured` then spawns. Both are fixed since, with the rest of the census, under "Bare-name spawns: the census". |

## The 1.6.2 backlog clearance (2026-10-13)

Prompted by two dashboard rows that were both false: Auto Learn read **"scan degraded —
Codex history store has moved"** and Codex memory read **"1 issues"**. The maintainer then
asked for `BACKLOG.md` to be cleared outright. Every open entry was re-verified against the
tree first, because the file's own preamble says entries rot, and two of them had: five of the
"seven surviving mutants" had been killed by `590df24` on 2026-09-24, three days before the
tracker was restored claiming no test would notice, and `managedPolicyPath` had gained three
script suppliers. What follows is each disposition and its evidence. Nothing here was closed
by re-reading its own prose.

### The archived-thread false alarm — FIXED, `9abc330`

**Cause.** Archiving a thread in the Codex app MOVES its rollout from
`sessions/YYYY/MM/DD/` to a flat `archived_sessions/`. The store check walked `sessions/`
only, so every archived thread still named by `thread_history_1.sqlite` or
`session_index.jsonl` read as an orphan, and `stale: true` persisted until the thread was
unarchived. On the development box: four archived threads, the oldest 170 MB, all four
marked `archived = 1` with an `archived_sessions\` `rollout_path` in Codex's own
`state_5.sqlite` `threads` table. It was a detector that fired on an ordinary user action,
which is the failure this check's own test file names: "a detector that fires on everything
is not a detector."

**The real migration signal was looking in the wrong place too.** The check treated any
entry in a `rollout-migrations/` directory as a reason. No such directory has ever existed
here. Codex records migrations in `state_5.sqlite` `rollout_migration_state`, which held one
row, `legacy_to_paginated_v1`, and that migration is benign: the projection cursor
(`thread_history_projection_state.next_rollout_byte_offset`) equalled the rollout's size for
13 of 13 threads, so the store is still a projection of the files. A migration having run is
now a note; only proven divergence makes `stale`.

**What the check does now.** It accounts for `sessions/` and `archived_sessions/` in ONE
comparison per Codex home (a naive second root would have made each root report the other's
threads as orphans), re-walks once before calling anything an orphan, and uses the state
database to *classify* a missing thread — relocated (a reason: Codex writes where we do not
read), archived then deleted (a note), or orphaned (a reason) — never to add ids. A projection
cursor strictly past its file's end is a new reason. Reasons and notes name directories, never
paths. The dashboard says what diverged ("4 Codex threads with no transcript") instead of the
fixed sentence, and logs reasons to the output channel when they change.

**Two defects found inside the fix and shipped with it.**

- **A fork head-seed double count.** Three of the archived rollouts are forks with two head
  `session_meta` lines (the fork's id, then the parent's). The full parse applies both;
  `codexHeadSeed` applied only the first, so a call first read in an append slice was filed
  under the fork and counted again under the parent on the next full read — which archiving
  forces, because cursor keys are path hashes. The seed now applies every consecutive head
  record. Identity was deliberately NOT re-keyed to the thread id: that would recount every
  observation already stored. **ACCEPTED-RECORDED:** calls in those three forks that were
  first counted from an append slice before this fix are counted once more on the first full
  read of `archived_sessions/`. Bounded and one-time.
- **A pending-file leak.** `codexEvidencePendingFiles` ids are path hashes; a transcript
  archived during a Codex evidence rebuild left an id nothing could read again, held
  `codexEvidenceRebuildPending` true forever and blocked auto-safe apply. A clean walk now
  drops pending ids it no longer enumerates; a walk that failed on a root keeps them (the
  half of the old witness that still holds). A moved file that is still being caught up is
  re-added under its new id, so the rebuild stays open until it is read.

**`partial` was never an error.** It is set in one place and means "deferred by the per-file
per-scan ingest budget; the cursor advanced to a newline and the next scan continues". It was
rendered as trouble, which would have shown "scan degraded" for the three scans the 170 MB
archive needs. It now reads "catching up on N large transcript(s) (X MB left)". The genuinely
partial read, `mode: 'unreadable'` (a skipped stretch), was counted nowhere; it is now
`unreadable` and is trouble.

**Acceptance on a copy of the real Codex home.** Exact, not stale, 13 rollouts (4 archived),
zero findings, one migration note. Catch-up took three scans (partial 2 → 1 → 0) with no
degraded trigger on any of them. Archiving the largest live rollout (100 MB) afterwards added
**zero** observations, success counts 77 → 77, cursors 13 → 13. 34 mutants, all killed.

**Measured facts, Codex 0.161.0 on Windows, 2026-10-13.** `threads.has_user_event` is 0 for
all 13 rows, including threads with transcripts, so it cannot classify anything.
`rollout_path` mixes `\\?\`-prefixed and plain spellings. Every observation Codex writes has
a `call_id`; an observation without one would put its file path into its identity and would
recount on a move, which is theoretical today. `node:sqlite` DOES load in the VS Code 1.141.1
extension host (Electron 43.7.7, Node 24.21.0): the comments that said no shipping VS Code
carries it were out of date, and the `unavailable` tier stays only because the engine floor is
`^1.80`.

### The Codex memory false positive — FIXED, `b158f3d` and `f9f0e24`

`lintFile` matched any forward-slash path merely ENDING in `skills/<x>/SKILL.md` and checked
it against `memories/skills/`. Rollout summaries are session narrative and cite the session
project's own `skills/` paths; the flagged one existed in its project. Backslash spellings of
the same reference never matched, so the verdict depended on slash direction. Codex
regenerated the store mid-fix and `MEMORY.md` gained two bare project-skill citations of its
own, so the rule had to be sharper than "registry files only". Evidence for the final rule, from
the installed Codex 0.161.0 consolidation template: "If you reference skills, do it in body
bullets only (for example: `- Related skill: skills/<skill-name>/SKILL.md`)", and its read
path opens `skills/` only "if MEMORY.md directly points to" them. So a `skills/` reference is
linted only on a `Related skill(s):` line of `MEMORY.md` or `memory_summary.md`;
`rollout_summaries/` references are linted everywhere, as whole tokens. Diagnostics carry a
0-based line. The live store went from 3 diagnostics to 0, and the row says "1 issue", not
"1 issues".

### The live hook ran a checkout 142 commits old — FIXED

Found while diagnosing the above: the box's PostToolUse hook pointed at the pre-rename
checkout directory at v1.4.13 — before the MAX retirement — while the maintained checkout
lived under the new name. No fix since 1.4.13 had reached a real tool call, and nothing could
have noticed: smoke drives `$REPO/bin/wildcard-perms` directly and `verify-release.ps1` only
checks that SOME PostToolUse hook exists. The hook was repointed by hand through
`writeTransform` with a backup. The trap itself was in the installers: both deduplicated by
exact command string, so installing from a moved, renamed or re-cloned checkout ADDED a second
hook beside the stale one and both fired. `1aa811a` makes both installers recognise this tool
from any checkout and repoint it in place (matcher, position and fields kept, deduplicated per
matcher, old → new printed); the uninstallers also remove a registration whose target file is
gone and name, but leave, a live other checkout's. Four pre-existing installer defects found
alongside, all FIXED: `verify-installers.ps1` leaked 22 sandboxes per run under an 8.3 `%TEMP%`
because `Remove-Item` fails on short names (`97de88f`); `install.sh`'s starter-pack count threw
`MODULE_NOT_FOUND` under Git Bash (`263ae96`); `install.sh` under Git Bash registered a bare
Windows path, which pops "How do you want to open this file?" on every hook fire (`6f8925c`,
now byte-identical to `install.ps1`'s `node "<path>"`); and an 8.3 spelling of the same
checkout read as another checkout (`4908466`). ACCEPTED-RECORDED from that last one: the
`.ps1` pair expands 8.3 names but not junctions or symlinks, so a linked spelling is still
repointed — harmlessly, with a wrongly worded notice.

### Shell grammar minted into broad grants — FIXED, `a910daf`; exporter gap — FIXED, `64b4eaa`

`generalizePermission` keyed on any first token, so `Bash(for f in a b)` became
`Bash(for *)`, `Bash(if …)` became `Bash(if *)` and `Bash($EDITOR x)` became
`Bash($EDITOR *)`, contradicting the module's own comment. Measured with
`src/permission-match.js`: `Bash(for *)` covers `Bash(for f in *; do rm -rf "$f"; done)`, and
`processAllowList` then pruned every other exact loop as covered. Bash entries that open with a
reserved word, an expansion, a subshell or group, a glob in the command name, an
assignment-only line, or an expansion inside an env prefix now stay verbatim
(`FOO=$(rm -rf ~) git status` used to become `Bash(-rf *)`). The keyword sets are copies of the
classifier's, not imports, because `src/fixed-point-cache.js` stamps only `permissions.js` and
`permission-match.js`; an import would let a classifier edit change the pass's output while
the cache kept answering "already a fixed point". A drift test holds the copies in step.
Live-list impact on this box: none — old and new output byte-identical.

The Codex export refusal table missed 27 of the learner's 43 wrapper roots, so a reviewed bare
`["node"]` or `["xargs"]` rendered (99 spellings with `.exe`/`.cmd`). It is now the union of
its own list and the learner's. A union is right for refusal specifically: refusing more is the
safe direction, and the import can never shrink the exporter's own extras. Side effect,
intended: reviewed multi-token runner rules on the Claude side (`Bash(node --version *)`) are
now refused at any depth, as `Bash(just --version *)` already was.

### Every other open entry

| Entry | Disposition | Evidence |
|---|---|---|
| Tracker 1, seven surviving mutants | **REFUTED for five, FIXED for two, plus an eighth found and FIXED** | Five were killed by `590df24` (2026-09-24). `COVER_KEY_CACHE_LIMIT` and the non-string passthrough are now pinned (`cb8dc6d`; the passthrough comment's "stale memo" rationale was also wrong — `ruleMatches` refuses every non-string). The third `lockedRetries` reset, after the lock, was a survivor nobody listed (`b9c5a40`). |
| Tracker 2, option keys with zero suppliers | **`managedPolicyPath` CLOSED-VERIFIED; the other four FIXED**, `42e5a15` | `managedPolicyPath` has three runtime-script suppliers since `63cb99e` and now a test supplier that kills the stat-path and read-path mutants. `defaultTool`, `priorCursors` and the duplicate `homeDir`/`successThreshold` spellings were removed with their unreachable branches after a tree-wide zero-supplier grep; a test on the extension's option object guards the supplier side, since re-adding a dead fallback leg is unobservable. |
| The Auto Learn worker deadline is environment-variable only | **FIXED**, `a22209f` | `permissionWildcarding.autoLearn.workerTimeoutSeconds` (default 300, 0 disables, `machine` scope so a repository cannot switch the deadline off). The runner re-reads it per operation, and it is supplied only when the user set it, so the environment variable still governs otherwise. |
| Trusted project rule directories never enumerated | **FIXED**, `d5200f9` | Measured on codex-cli 0.161.0 in isolated sessions: a project's `.codex/rules` is obeyed only when Codex trusts the project; `config/read` with `includeLayers` lists exactly the obeyed layers. Discovery asks Codex, cached on `config.toml`; with no reachable codex only an exact trusted `[projects]` entry counts and the rest is named in `blindSpots`. The user-scope write validator deliberately excludes project rules, so one broken project file cannot block user-scope maintenance everywhere. `scripts/check-codex-project-rules-runtime.js` re-runs the measurement. |
| The Codex Stop hook failed on budget deferral | **FIXED**, `0d266fd` | `partial` is progress. A deferral alone exits 0; a deferral of this turn's own rollout is reported as a `systemMessage`. Errors, unreadable stretches and blind scans still fail. |
| A reported `DatabaseSync` deprecation | **CLOSED-VERIFIED and hardened**, `71b685f` | DEP0210 is real and documentation-only (Node 26.11.0): 26.11.1 exports `Database === DatabaseSync`, synchronous, with no warning even under `--pending-deprecation`; 22.23.3, 24.19.0 and 24.21.0 export `DatabaseSync` only. The readers prefer `Database` only when it is provably that class. The real noise was Node 22's ExperimentalWarning printed over a clean `--learn scan`; it is filtered for that one require. |
| `scripts/smoke.sh`'s tautological cache assertion | **FIXED**, `18fad85` | After the restore the hook runs again; PASS only if the cache text, its mtime and `settings.json` are unchanged. Under a temp-home harness the old block passed a stale-stamp key, a stale-bytes key and a hook that exits 3. |
| Declare and exercise a Codex version window | **FIXED**, `afbe9d5` | Window 0.145.0-0.161.0 in `src/codex-version.js` and `docs/codex-compatibility.md`, reported as information only (dashboard line, `--learn status`), enforced only as the CI pin. |
| Provision Codex in CI | **FIXED**, `71b1961` | Contract and guidance-matrix tests run on the Node 22 legs against `@openai/codex@0.161.0`; `ACOLYTE_REQUIRE_CODEX` makes a skip a failure. **ACCEPTED-RECORDED:** the runtime harnesses stay out of CI — they drive Codex's real sandbox and approval path, unobserved on a hosted runner, and most are Windows-only. |
| Runtime harnesses against 0.161.0 | **CLOSED-VERIFIED**, `e5360c2` | Every CLI-only loopback harness passes after harness-side drift fixes: the shell tool is `exec_command` now (the responder reads the offered tool names), Windows clamps a yield to at least 10 s, an 8.3 short path, and the MCP rollout shape. The MCP harness surfaced a product defect, open in `BACKLOG.md`. |
| Direct-shell evidence beyond the observed shape | **ACCEPTED-RECORDED as of `9a10261`** | With `code_mode`, 0.161.0's custom `exec`/`wait` cells are captured as a sanitized fixture: completed cells classify correctly, continued cells are withheld as unknown. The join is open in `BACKLOG.md`. |
| A representative matrix of shell wrappers | **CLOSED-VERIFIED on Windows**, `e4d3985` | `codex execpolicy check` never unwraps a shell (20/20 rows agree with the guidance); at runtime, chains of allowed commands run unprompted and a new command, a redirection, `$()` or a wrapper prompts (13/13). Nothing contradicted the guidance text. The POSIX list is open. |
| The runtime provenance hash missed the exporter's dependencies | **FIXED**, `92db159` | The hash covers the transitive local `require()` closure of its roots, derived from the source, and the harness fails if a loaded subject module falls outside it. |
| Large, partially missing real history | **CLOSED-VERIFIED**, `9abc330` | The archived-thread acceptance ran over a copy of a real Codex home: 13 rollouts, 4 archived, one of 170 MB. |
| Hosted-web outcomes; prompt causes outside visible policy | **ACCEPTED-RECORDED** | Neither can be exercised through the loopback provider: hosted tools run server-side, and a prompt with no visible rule has no local policy to read. |
| Codex 0.161.0 MCP results invisible to the parser | **FIXED**, `6eb35c1` | Outcomes are `item_completed` `McpToolCall` items; their `id` equals the call's `call_id` on all 5 real rollouts, so both shapes land on one observation, and a pinned pre-change id proves the old shape's identity did not move. The VS Code MCP suite asserts through the same shared check (`a777d59`). |
| Continued code-mode cells earned no evidence | **FIXED**, `d934419`, `53b7212` | A `wait` binds to the single open yielded cell with its id in its session; ambiguity withholds, a re-yield stays pending, `terminate` credits nothing. Measured on 0.161.0: a resume appends to the same rollout and restarts cell ids, a fork is a new file from 1, and a wait for a cell killed at the restart gets "not found" — a close, never a failure. **DECLINED-MEASURED:** `thread_settings_applied` as a resume epoch, because a same-process override turn writes it while its running cell survives. **ACCEPTED-RECORDED:** after a reload, a new cell reusing a still-open old cell's id is withheld with it. |
| Call groups keyed by call id alone | **FIXED**, `a672b3a` | Worse than recorded: a failure in one session turned another session's direct `exec_command` success into `failed`. Groups are keyed by session and call id; ten pre-change observation ids are pinned unmoved. |
| Runtime harnesses read the user's home `AGENTS.md` | **FIXED**, `128172f` | Codex's `AGENTS.md` walk stops at any directory holding a `.git` entry, even a non-repository one, while project layers and trust count only a real repository. Each workspace gets an empty `.git`, and a canary one level up fails the run if foreign instructions reach a request. |
| The wrapper matrix's POSIX case list | **CLOSED-VERIFIED for prompting; ACCEPTED-RECORDED for execution** | Run 2026-10-13 in a `node:20-slim` container on codex-cli 0.161.0: all 12 POSIX cases prompt exactly as the guidance says (0 approvals for the four allowed chains, 1 for each of the eight that must prompt; the empty-rules control prompts). The allowed commands did not execute inside the unprivileged container, most likely because Codex's Linux sandbox cannot start there, so the harness's execution witness reads DIFFER for those four. |
| The Codex Stop hook's reasons never reached the user | **FIXED**, `5611d4d` | Codex 0.161.0 reads a Stop hook's stderr only on exit 2, which blocks the run. Lost evidence, blind scans and a held lock are now a path-free `systemMessage` with exit 0; malformed input and an unanticipated crash still exit 1, so "cannot run" stays distinct from "found a problem". |
| Tests that failed under parallel load | **FIXED**, `597b4f7`, `1d6b776` | Windows refuses a rename while anything holds a handle: a directory rename while a file inside is open (EPERM), a file replace while the target is open, a junction while the new directory is open (EBUSY). CPU load alone never reproduced it; a stand-in scanner holding each new file 10 ms did, in up to 60 of 60 runs, and 0 after. `strictWrite` was the one product writer with no retry and now retries the same rename, re-reading the target first. The recall model download's rename retries on timers (`b4271f3`). Lesson: a stress harness that models a scanner must use a private TEMP; the first one here held other worktrees' fixtures. |
| A missing Codex executable read differently on Linux | **FIXED**, `78b7d34` | `commandLaunch` resolves only on Windows, so on POSIX the config worker's "not reachable" pre-check never fired and spawn's own ENOENT text broke the trusted-project fallback note; red on both Ubuntu CI legs, green on Windows. |
| `timeout`/`command`/`builtin` collapsed to root-wide grants | **FIXED**, `d946f01`, refined `9a5324e` | Per Claude Code's permissions page and its 2.1.296 binary, a fixed set of wrappers is stripped before matching, so a wrapped approval keys on the command it runs. The binary's allow-path stripper is narrower than the docs (`stdbuf` only with fused modes; `xargs` only innermost). The learner and the generalizer now share one routine. |
| Env-var prefixes | **FIXED**, `a9e2adf` | Claude Code 2.1.296 strips a leading assignment only for 39 known-safe names with plain values, and tries a rule against both the raw and the stripped text. Any other assignment is now kept verbatim in a generated rule. Live list: 37 env-prefixed entries, all unchanged. |
| The matcher did not model stripping | **FIXED**, `122901f` | `ruleMatches` tries raw and stripped text (Bash only); coverage can only move toward "covered". Live list: 0 more entries pruned. Cost per `processAllowList` pass on 581 entries: about +0.3 ms warm, +1.7 ms cold. |
| Codex prefixes ending in inline code, exec wrappers, interpreters | **FIXED**, `30f92a4`, `a309f54`, `668a685` | Inline-code flags anywhere after a runner, 31 exec wrappers with their own option grammars, privilege changers at any depth, and interpreters that must pin a script or module. Probes: 41, 80 and 70 previously rendering prefixes refused; none opened. |
| Digit-leading roots, path-rooted executables | **FIXED**, `2b8e6b2`, `82dbe01`, `675ce3a` | `7z`-style names generalize and promote; numeric and range literals stay verbatim; any first token with a separator, a leading `~` or a drive letter stays exact. |
| Over-broad grants minted by the old generalizer | **FIXED**, `f218881` | A read-only count of wildcard grants keyed on shell grammar, with a filtered picker. This box: 2 of 425 (`Bash(export *)`, `PowerShell(& *)`). |
| Gate and memory diagnostics numbered lines differently | **FIXED**, `9ff0414` | 0-based everywhere internally. |
| Starter-pack wrapper entries | **FIXED**, `c31aa30` | `Bash(timeout *)` and `Bash(nohup *)` removed, `Bash(command *)` narrowed to `Bash(command -v *)`, `Bash(xargs *)` kept. The 13 maintainer-decided blanket grants are untouched. |
| A refused code-mode cell read `failed` | **FIXED**, `3521c46` | Measured with marker files on 0.161.0: a refused nested `exec_command` never runs, and the cell reports "Script failed" plus "Script error:" and the same refusal text a direct call returns (the approval-never escalation refusal, or the user decline). Direct calls already read that as unknown; cells now match, including through a wait. Only the exact shape and the two measured messages count. **ACCEPTED-RECORDED:** other refusal sources (an execpolicy `forbidden`, a Guardian or auto-review denial, an aborted approval, a nested `tools.shell_command`) are unmeasured and still read failed — the conservative direction. |
| A declined MCP call counted as `failed` | **FIXED**, `3f9a224` | A decline never reaches the server and is recorded as `status: failed`, `error: {message: "user rejected MCP tool call"}`, no `result`; a server error has the same structure with a different message, so only the measured decline (and 0.145.0's `{Err: "user rejected MCP tool call"}`) reads unknown. A decline vetoes a success for the same call. MCP families are review-only, so review counts move and no grant changes. **ACCEPTED-RECORDED:** an MCP `cancel`, a Guardian denial and a server that dies mid-call are unmeasured and still read failed. |
| Dev-environment runner prefixes | **FIXED**, `b0685b2` | Exec forms (`uv run`, `poetry`/`pipx run`, `npm`/`pnpm`/`yarn exec`, `docker`/`podman` `exec` and `run`, `kubectl exec`, `direnv exec`, `mise exec`) stay broad until they name a narrow command; `ssh` and `devbox` are broad at any depth — devbox's own source runs an ad-hoc command through `eval`; make/just/npm value options are modelled. Probe: 154 of 268 refused, none opened; live list 0 changes. **ACCEPTED-RECORDED:** benign docker/pnpm/yarn top-level options beyond the modelled few are refused as unknown (the safe direction), and `go run`/`cargo run`/`dotnet run` run project code, the same class as `npm test`. |
| Env-led learner families | **FIXED**, `794d7ae` | A run led by an assignment Claude Code keeps forms its own family with the generalizer's rule, and a quoted, expanding or credential-shaped value is keyed `NAME=<redacted>` with no rule, so no secret reaches the state file. **ACCEPTED-RECORDED:** families stored before the split keep mixed counts and stay review-only; there is no way to split them. |
| Recall download temp name | **FIXED**, `7e43af2` | `<dest>.<pid>.<random>.tmp`; a failing download unlinks only its own file. |
| Docs bullet merge; the strip model's re-read | **FIXED**, `7a42d4b` | `scripts/check-claude-strip-model.js` compares the installed Claude Code's known-safe environment names with `CLAUDE_SAFE_ENV_VARS` (2.1.296: the same 39). **ACCEPTED-RECORDED:** it checks the names only; the value class and the wrapper regexes remain a documented manual re-read on each Claude Code release. |
| The Windows file-holder stress harness | **FIXED**, `4b41fb7` | `scripts/stress-windows-holders.js`, private TEMP enforced, with a self-check. |
| "A value is a command" Codex prefixes | **FIXED**, `894e86d` | Measured in a private temp dir: `git -c core.fsmonitor=CMD status`, `tar --to-command` / `--checkpoint-action=exec`, `scp -S`, `sftp -D` and `fd -x` each ran CMD. A GIT dispatcher refuses `-c`, `--config-env` and `--exec-path` before the subcommand while `-C dir` stays a path; rsync, scp, sftp, tar, find and fd run any command; compose and nerdctl take docker's grammar. Probe: 72 of 76 refused, none opened. **ACCEPTED-RECORDED:** a git subcommand's own command-valued options (`git grep -O<cmd>`, `rebase -x`, `bisect run`, `submodule foreach`, `difftool -x`, `fetch --upload-pack`) still pass a reviewed rule naming that subcommand. None of those subcommands is ever applied automatically (`SAFE_GIT` holds only read subcommands without such options), so the exposure is limited to a rule a human approved. |
| Program-naming environment variables | **FIXED**, `520103d` | `PAGER`, `EDITOR`, `GIT_SSH_COMMAND` and 17 more are refused in env-led reviewed rules, `CC`/`CXX`/`MAKE` deliberately (refusing more is the safe failure); data-valued variables still render. |
| Env-led `.exe` spellings | **FIXED**, `1be8dc2` | `FOO=1 cat` and `FOO=1 cat.exe` are one family granting both spellings, through the plain-key migration machinery. |
| Stale recall download temp files | **FIXED**, `ff0559b` | At download start, `<dest>.*.tmp` older than 24 h (and the legacy fixed name) is swept; a younger one may be another window's live transfer and is kept. |
| Already-scanned Codex history kept old verdicts | **FIXED**, `9a7ca3f` | `CODEX_EVIDENCE_REVISION` 3 → 4 re-reads Codex history once through revision 3's mechanism; Claude evidence, grants, reviewed sets and Undo are untouched and auto-apply pauses until the re-read completes. The bump alone would have counted a preserved grant's replayed failures twice and absorbed a genuinely new failure; a still-preserving record now restarts from its Claude failures and an outgrown one is dropped. Measured on a copy of real history: 3 scans, 40 Codex calls re-read, 0 of 13 families differ from a same-parser catch-up, no Claude count or grant moved. **ACCEPTED-RECORDED:** the 20,000-hash cap evicts Claude dedupe hashes to make room for re-read Codex ones (26 here), as any new evidence would. |
| Shebang'd scripts checked out CRLF | **FIXED**, `d426a81`, `f66931c` | Ten scripts gained `text eol=lf`; a renormalize changed no index blob. |
| The `file:line` gate catches less than it looks like | **FIXED**: mechanism `92199d6`, migration `ff1eb33`, `dbd3c57`, `fd803b2`, ratchet in the commit that closed this row | Every collected citation (193) is `file:line#anchor`, chosen by hand from its target and from the commit that introduced it; that morning 61 of 160 were STALE and none could fail. The suite now fails on a missing anchor as well as a moved one, so a new citation cannot slip back into the heuristic. Within hours of landing, a merge moved 14 anchored lines: `--fix-anchored` repaired the unique ones and named the rest for a hand repoint, instead of citing the wrong code. Mid-merge, `git ls-files` lists a conflicted path once per stage; the file list is de-duplicated. | `file:line#identifier` is checked exactly and `--fix-anchored` repoints a uniquely moved anchor. Its first live catch came hours later: a merge moved the anchored line and the suite failed instead of citing the wrong code. |
| `precedence` returned, never read | **FIXED**, `da9b08a` | A keys test pins the verdict shape. |
| `CODEX_BUNDLE_CACHE` export and its stale citation | **FIXED**, `acc9f79` | Export removed with its `PENDING_REMOVAL` entry; the constant and its default-argument use stay. |
| Case-mismatched rule target on Windows | **FIXED**, `dfc04a2` | Wider than recorded: reachable from shipped code, because `readdir` returns the on-disk name and the target basename is hard-coded lowercase. One win32 `key()` now drives the target check, dedupe and substitution. |
| Packaging gate reports but does not quarantine | **FIXED**, `c22ff68` | `gateOrQuarantine` removes the rejected VSIX and its stamp and rethrows the gate's own error. |
| `warnedOnce` survives a same-realm re-activate | **FIXED**, `4eb25fe` | Cleared in `activate()`; the module-state inventory below was re-counted the same day. |
| Cosmetic: `swapped` in the contract test | **FIXED**, `5d67373` | |
| `explicit: true` legacy cleanup has no UI entry | **ACCEPTED-RECORDED** | By design: `test/dashboard-view.test.js` pins that the retired ids regain no dashboard route, and an existing user keybinding still reaches them. |
| Project-local card reports on a path it did not watch | **FIXED**, `770c62c` | One shared `localRoots()`; an untrusted window lists its files but shows no dry run; the payload names every path. |
| …recursive discovery of nested `settings.local.json` | **DECLINED** | It would promote approvals granted inside nested clones into user scope from a parent window — the trust concern the drain gate exists for — and the CLI hook already drains each session's own cwd. |
| `liveChildren` and `liveTransfers` are parallel sets | **ACCEPTED-RECORDED** | Kept separate because the kill verbs differ. Revisit trigger: a third kind of in-flight job. |
| Three roots that fit neither table | **FIXED**, `edb59ed` | `just`, `make`, `hyperfine` and `duckdb` are shell wrappers in the learner, each with a dated citation of the tool's own docs, and refused as bare Codex prefixes. |
| `1..6` emits a live `PowerShell(1..6 *)` | **FIXED**, `3ebbf04` | A leading `<int>..` in PowerShell is `missing-command-root` + `script-syntax`; `7z` and Bash are unaffected. |
| 14% of stored approvals can never be wildcarded | **FIXED**, `0ecd9b0` | Read-only `deadShellApprovals` plus a Saved-permissions line and a filtered picker; nothing is removed automatically. `shell-structure` alone is excluded: it fires for path executables, which do match again (69 false positives measured). This box: 68 of 137 exact shell approvals (12.1% of 562). |
| The returned-object dead-code rule | **DECLINED-MEASURED** | Re-measured 2026-09-27 at one finding, with five false-positive classes and a real-AST requirement that would cost the repo its first dependency. |
| Cancelling the model download mid-redirect | **REFUTED** (2026-09-27, unchanged) | |
| npm CLI publishing | **Owner decision 2026-10-13**, see "Deferred by the maintainer" | |
| Stale screenshots | **Owner decision re-affirmed 2026-10-13**, see "Deferred by the maintainer" | |

---

## Further Codex outcome closures (2026-09-28, unreleased)

The final combined Stage C has 52 verified files, aggregate
`3074c8ae9a60623d40c93f32ba6ff6329890a18b3d902917a40731866d41ae73`.
Its full source suite reports 1,080 passes, two skips and zero failures among 1,082
tests, with no source/test drift (`acolyte-features-suite-gZjx2V/report.json`).
Seven actual editor groups pass against this stage, and both fresh native wait outcomes
pass. The compatibility record links final provenance and transfer of the unchanged
negative-control modules. Earlier native batches retain their exact staged subjects.
No release, installation, commit or tag was performed. A final comparison with the old
backlog found no dropped Codex outcome; broader validation and policy-discovery limits
remain recorded as open.

CLOSED-VERIFIED: editor-open background learning. Actual completed Codex history was
ingested by the watcher and by the unchanged one-minute reconciliation timer after a
deliberately missed notification. Disabling either route failed its native ingestion
group. This closes an unverified existing outcome, not a previously missing feature.

FIXED in development: after-turn editorless learning; native memory discovery, ambient
diagnostics and source passage search; reviewed widening of authored stored approvals;
and reviewed portable project imports. The compatibility record names immutable stages,
full evidence directories, exact native groups and deliberately failing controls for
each. No release, tag, package or replacement of the user's working extension was needed.

Native memory testing found a real BOM offset defect: the adapter retained a UTF-8 BOM,
while VS Code's TextDocument removed it. Stage A found the passage but could not select
it. Explicit BOM provenance now translates only that known difference; Stage B selects
both the first and a later passage exactly. Reintroducing the offset error fails only
that native group after the five earlier groups pass.

The reviewed-rule tests also corrected two fixture assumptions. Codex already allows
the read-only `git status` command, so zero approval prompts before widening was expected
runtime behavior, not a product failure. Its proof now checks explicit policy coverage.
A custom executable supplies the real import prompt transition and restrictive-argument
control. The planner does not classify `git diff` as auto-safe; stale/recovery fixtures
now use supported prefixes. All failed preliminary runs remain preserved.

FIXED in development: authoritative MCP outcome ingestion and exact reviewed native
per-tool approvals. Six actual VS Code groups and seven fresh Codex calls pass; no-op
approval, Undo and recovery writers each fail their intended group. The immutable subject,
loaded hashes and witnesses are recorded in
`D:/.ai-work/scratch/acolyte-validation-mcp-dev-20260928/results.json`. MCP candidates
remain separate from Claude permissions and shell rules. Semantic retrieval and its
editor acceptance retain their separate evidence. CPU semantic tests use only synthetic
sources and the installed CPUExecutionProvider, with no local GPU, model download or
private-corpus evaluation. Keyword fallback is always identified.

FIXED in development: native semantic recall. Seven CPU groups and four actual editor
groups cover paraphrase retrieval across registry, rollout and skill sources, exact source
selection, actual index rebuild and explicit keyword fallback. Semantic bypass, rebuild
no-op and silent fallback controls each fail the intended native group. The canonical
record is `acolyte-validation-mcp-recall-dev-20260928/native-recall-results.json` under
scratch. No general search-quality score or performance improvement is claimed.

The native gate compiler's final review reproduced an actual deletion bug: malformed
`scope` metadata was treated as a complete zero-section compilation, so automatic refresh
emptied the installed body. The final helper rejects malformed/unsupported scalars visibly,
accepts ordinary metadata comments, and preserves valid project/task scope as a distinct
zero result. Eighteen tests pass, and all five new scalar/metadata controls fail exactly
their named tests (`acolyte-native-gate-scope-mutations-zGZvpM/evidence.json`). Earlier
helper checks killed 21 transaction/annotation mutations; UI checks killed 16 more.
Stage B replaces only that helper in the immutable 52-file Stage A. Six fresh Codex
processes load full installed/refreshed bodies and verify absence after removal; the
missing-block control fails at the actual request. Evidence is
`acolyte-validation-native-gates-dev-20260928/final-runtime-provenance.json`.
FIXED in development: the same stage passes seven editor groups covering gates and
read-only MCP receipts, with 16 UI actions/status observations. Install, refresh and
receipt-visibility controls each fail exactly the intended group. The unchanged Stage A
also fails its malformed-source group after the first four pass. Full profiles and
screenshots are retained in that directory's `native-results.json`.

FIXED in development: direct exec_command/write_stdin completion learning. Actual Codex
runs initially left both success and failure unknown. Exact process attribution and
header-only terminal metadata now classify both correctly; interactive or ambiguous
completions remain unknown. Twelve parser mutations fail their intended assertions,
and disabling the process bridge fails a fresh runtime outcome after the command and
wait execute. The records are `acolyte-wait-history-mutations-41lYsS/report.json` and
`acolyte-wait-runtime-validation-61hUMH/report.json`. Revision 3 replays old completed
cursors once without replacing Claude evidence, policy or Undo; reverting the revision
fails its named migration test (`acolyte-wait-revision-mutation-JmpPFV/report.json`).
Custom cell continuation remains outside this measured shape.

One full-suite attempt was stopped after independent native-gate activation jobs consumed
the lifecycle fixture's synthetic Auto Learn wedge. The fixture now distinguishes those
jobs, and all 36 lifecycle tests pass. The incomplete run is retained as
`acolyte-features-suite-4Z06NR/aborted.json`, not counted as a passing suite. New gate
teardown and deferred-refresh behavior also have their own directly exercised regressions.

### Built-in tools do not inherit the MCP approval proof (2026-09-28)

DECLINED-MEASURED for adding an approval exporter solely to mirror the measured
`view_image` calls: three fresh Codex 0.145.0 processes requested zero approvals.
The valid PNG returned structured `input_image` content; invalid bytes still emitted an
`imageView` completion event, without a success status. Completion therefore cannot be
treated as successful image processing. Runtime evidence is
`D:/.ai-work/scratch/acolyte-view-image-probe-hbRWef/evidence.json`; substituting invalid
bytes for the valid fixture fails the image-output witness, recorded in
`D:/.ai-work/scratch/acolyte-view-image-mutation-6jSmpc/report.json`.

The hosted-web boundary stays open. A metadata-only read of 64 current-profile rollouts
found 70 `WebSearch` completion items with result fields but no authoritative outcome
status, and no direct `web_search_call` or web end records. The report at
`D:/.ai-work/scratch/acolyte-builtin-metadata-CvcHSs/metadata.json` contains only types,
field names, status metadata and counts. No prompts, arguments, URLs or result bodies
were retained. A scripted hosted-search result would not prove actual retrieval or
approval behavior. No built-in counters, guessed successes or speculative permission
exports were added. This scoped decision does not establish platform impossibility.

## Codex recovery and derived guidance: FIXED in development (2026-09-28)

The user asked for extension behavior to work with Codex and then asked us to close
the gaps. This is feature validation, not a separate approval or naming program.
The seven comparison areas were not seven failures of the existing learning path.
Reusable learned prefixes and cross-workspace user rules already had real-runtime
evidence; rewriting stored literal approvals and importing authored project rules
were distinct work, closed by the later reviewed-rule batch recorded above.

This batch gave two comparison areas FIXED dispositions. Retained literal policy supports
explicit missing-rule restore, deliberate-removal suppression, preservation of
surviving claims and a resumable write intent. Codex derived guidance uses current
managed policy plus successful Codex-only observations, with full-body review and
separate routing into the active Codex instruction file. The scoped limitations and
source entry points are recorded in `docs/codex-compatibility.md`.

Recovery Stage B, 38 files, aggregate
`0bfd4d881ab7aac06545dca9642f06a2fd4aa3e73e530f8b313ebd20da669e2e`, passed nine real
VS Code groups. The new groups cover four recovery flows and derived Accept/Decline,
with two fresh Codex instruction checks. A no-op Restore fails exactly group eight;
a no-op derived Accept fails exactly group nine. Both record the real control click,
changed source hash and executed mutation witness. The complete pre-modal suite was
885 tests, 883 passed and two platform skips. The final modal has 51 passing focused
checks and two mutation failures for truncated content and writing after teardown.
Standalone recovery checks add ten fresh processes and six execpolicy probes per
default/custom layout. Central proof is
`D:/.ai-work/scratch/acolyte-validation-recovery-dev-20260928`.

The first native negative attempt failed on a prior removal flow because the harness
polled a locking inventory method. It is retained as incomplete evidence, not a
successful mutation test. Passive byte/journal polling removed that interference.
The first full-body modal run failed because its observer counted an unlabeled close
icon as a decision. The corrected observer requires all four labeled actions and the
full instruction; the product dialog fit visibly throughout.

There was no packaging, installation, version bump, tag or release. Immutable stages
allow continued development of the hook and memory work without rewriting the test
subject. Installed 1.5.10 and its existing VSIX remain unchanged.

## Which of desktop-ai-companion's optimisation learnings transfer here (2026-09-22)

Moved out of BACKLOG.md on 2026-09-22. The question was asked by the owner; this is the
measured answer, and it belongs here rather than in a queue where an unticked box invites
somebody to re-derive it.

**The technique does NOT transfer, exactly as the item predicted, and now it is measured.**
AgentFlow's 1.7x came from `DirectoryInfo.EnumerateFiles` returning `FileInfo` with the write
time already filled in by the directory scan. **Node's `Dirent` exposes `name` and `parentPath`
and nothing else** (checked directly on Node 24.16.0: no `mtime`, no `size`). `findJsonlFiles`
already uses `withFileTypes` and never stats a discovered file; the one stat per file exists
because the cursor needs `size`, which `Dirent` cannot supply. That stat costs **47 ms across
955 files** and there is nothing to win.

**Two more of their findings are already solved here**, worth recording so nobody re-proposes
them: scans run off the extension host in a worker thread, via
`runAutoLearnWorker('scan', { mode: cfg.mode, threshold: cfg.threshold })` at
`vscode-extension/extension.js:1557#runAutoLearnWorker`, which is the fix their pane still needs. And the
watcher-plus-reconciliation-sweep architecture their backlog defers to is what this repo
already runs.

**Measured and not worth doing**, so the numbers exist before someone guesses: the locale-aware
sort of 955 paths is **12 ms**; the two path hashes per file are **22 ms**. The only remaining
lever of any size is the head/tail re-hash over every unchanged file, **140 to 160 ms**, and it
needs a correctness argument rather than a performance one, because it is what proves a file was
not rewritten in place between scans.

**What DID transfer was a question, not a technique:** what does the five-hundredth tick cost?
Asking it of the scan is what surfaced the entry above.

---

## What a transcript cursor means, and why catch-up beats skipping

Settled 2026-09-22 while fixing the oversized-transcript defect. Read this before changing
anything about `scanHistoryFiles`' read path.

**A cursor asserts exactly one thing: bytes `[0, size)` of this file are accounted for.**
Nothing requires `size` to equal the file's CURRENT size, and that gap is the whole fix. A scan
that consumes a bounded slice records what it consumed; the next scan resumes there. Nothing is
skipped, so no failure can be silently lost, and the cursor never has to express a hole.

**Three designs were considered and two rejected.**

- A `partial: true` marker on the cursor. **Impossible without a schema change.** `cursor()` at
  `src/auto-learn-manager.js:508-520#cursor` is a strict whitelist with no boolean leg, applied both on
  read and on scan-replace, and it drops unknown fields SILENTLY — the marker would vanish in
  the same tick it was created. Bumping `VERSION` to carry it reset every existing state file
  then, because `STATE_MIGRATIONS` was empty and `migrateState` returns null for an unregistered
  step. (It has since gained the 1→2 and 2→3 steps, so a bump now needs a registered step, not
  a reset.)
- A size ceiling that skips the remainder. **Rejected on safety.** `isAutoSafeCandidate`
  requires `counts.failed === 0` (`src/auto-learn.js:1052#counts.failed`), so a skipped byte range containing
  the one failure for a family would let that family become auto-safe. Skipping is not a
  performance trade here, it is a permissions trade.
- Progressive catch-up. **Taken.** Bounded work per tick, honest cursor, nothing lost.

**The budget is measured from the CURSOR, not from the slice start, and the difference is not
cosmetic.** The append path reaches back up to `overlapBytes` (256 KB) to find a record
boundary. Budgeting from the slice start meant that on any cap smaller than the overlap the
entire budget went on re-reading bytes already accounted for: the cursor never advanced and
catch-up looped forever. Caught by the differential test, not by inspection.

**MEASURED 2026-09-22, live corpus, one call per fresh process.** 955 transcripts before, 962
after (this session's own files landed in between), 819 MB Claude plus 5.98 GB Codex.

| | steady-state tick | bytes read | errors |
|---|---|---|---|
| before | 755 / 783 / 790 / 803 / 849 ms | 118 MB every tick, forever | 1, permanent |
| after, catching up | 1088 then 942 ms | 190 MB then 176 MB, twice only | 0 |
| after, steady | **303 / 316 / 341 ms** | **0** | **0** |

The 2,266,973,030-byte transcript that caused it had never been ingested at all; it is now.

**Do not "simplify" the chunk cap away.** `READ_CHUNK_BYTES` exists because `fs.readSync`'s
length argument is an int32: one call asking for 2,266,973,030 bytes wraps to -2,027,994,266 and
throws before reading anything. It is a parameter of `readRange` rather than a bare constant
specifically so a test can drive it with a small file; a 2 GiB fixture is not writable in a test
suite, and a cap only its own default can reach is a guard nothing can prove.

---

## Verified working, nothing to do

Auto Learn applies. Both symptoms that opened the 2026-09-02/03 work are gone,
confirmed on a real machine 2026-09-03: `~/.codex/rules/permission-wildcarding.rules`
written with 43 `prefix_rule` entries, state `applied.claude` 23 and
`applied.codex` 50, `lastApplication` set across `claude`, `claude-claims` and
`codex`, Review count back to 0.

The allow/deny backup is mirrored off-tree. Added 2026-09-09 after the event
below: the primary copy at `~/.claude/backups/allow-list.latest.json` sits inside
the directory it exists to survive the reset of, which is why the 423 live entries
came back that day on the extension's in-memory copy rather than off disk. It now
dual-writes to `~/.permission-wildcarding/allow-list.latest.json`, overridable via
`permissionWildcarding.backupMirrorPath` for another volume; restore reads the
primary and falls back to the mirror.

Mutation-tested rather than merely green, since three of the four assertions are
about a second file that a naive implementation writes anyway: dropping the mirror
write kills 3 tests, dropping the read fallback kills exactly the recovery test,
and replacing the fallback with a **union** kills exactly the stale-mirror test —
that last one added because the fallback-not-union decision was initially
untested, and a union would resurrect a deliberately pruned entry. Suite 290
tests, 289 pass, 1 POSIX-only skip, 0 fail.

Tiers 1-3 of the 2026-09-09 audit are burned down, 2026-09-10. Thirteen entries
above were removed as closed; the commits carry the mutation results that justify
each. Headlines, all measured on this machine:

- **The hook locks and rebases.** It was the highest-frequency writer of
  settings.json and the only one that neither locked nor re-read. Two phases now:
  the unlocked read is a negative test only, and the changed path takes one lock
  covering both the write and the drain, discards the snapshot and recomputes
  inside it. Replaying the delta instead would have lost a permission outright —
  `Bash(npm test)` granted while MAX was on, marked removed by the stale pass and
  deleted after `--max off` deliberately preserved it. Interleaved measurement,
  n=14 each: min 157 / median 175 ms before AND after, so the common path is
  unchanged.
- **processAllowList: 57 -> 6 ms warm, 85.8 -> 11.6 ms cold** at 423 entries, and
  the same index now serves the other two coverage pools (policy-guard's worst
  case 15.5 -> 6.47 ms). `isCoveredBy` is untouched and still decides every
  answer; the index only narrows, so only a false negative could change a result.
  The differential test found one on its first run — `Bash(rm -rf /*)` has its
  star inside the last token — which is why token-misaligned rules go to the
  linear fallback.
- **Codex evidence is observable again.** `extractNestedShellCommands` accepted
  only `tools.shell_command` while `auto-learn.js` already knew `exec_command`, so
  current Codex transcripts yielded ZERO observations in every mode. Fixing the
  extractor alone was not enough: `customExecCanAttributeSuccess` matched the same
  narrow set, which would have left every call permanently `unknown` and
  `counts.success` at 0. Append-mode `cwd`/`session` are now re-seeded by reading
  forward to the first newline — a fixed-size read cannot work, because the real
  `session_meta` line is 22,095 bytes of Codex system prompt.
- **The extension no longer outlives its own async work.** One `deactivated` flag,
  released on re-activate; all four `execFile` children tracked and killed; the
  worker runner nulled and the busy latch cleared, so a same-realm re-activate is
  not permanently stuck rejecting "Auto Learn is deactivating".
- **The dashboard is under test at all** — 8 tests including a permanent backtick
  guard over the `_html` template literal, after three syntax breaks came from
  one. No production export was needed: capturing argument 2 of
  `registerWebviewViewProvider` was the whole unlock.
- **The release harness is committable**, parameterized by four environment
  variables with auto-discovery, and verified both configured (16 PASS) and
  entirely bare (14 PASS, 6 INFO) so a fresh clone gets skips rather than red.

Suite: **297 -> 337 passing**, 2 platform skips, 0 fail, CI green on ubuntu and
windows x node 20 and 22.

### The coverage index's residual cost, and the trigger that replaced the old one

Live split is now 401 indexed / **3** fallback (2026-09-10), after star-free rules
were dropped from the pool entirely — they cannot cover anything, and 20 of the
previous 23 fallback entries were star-free. Cold `processAllowList` measured
~12.5 -> ~9.3 ms in matched processes.

The residual cost is O(n x fallback), because a rule with a glob INSIDE a token
(`Bash(g* *)`, `Bash(mkfs* *)`) cannot be found by a literal-prefix lookup. That
class is still quadratic — measured n=1600 at 238.5 ms — but it **cannot grow from
this tool's own operation**: `generalizePermission` only emits `Tool(root *)` with
root matching `/^[A-Za-z][\w.-]*$/`, so no `*` can land inside a token. This
sentence also named `mineWildcard`, which was deleted on 2026-09-24 as dead code
with no consumer anywhere including its own file; the substance is unchanged,
because `generalizePermission` and `promotionFor` carry the same constraint.
Re-measured 2026-09-24: live count 5 against a trigger of ~25, so the trigger below
still has not fired.

So the old "revisit if the fallback share passes ~20%" trigger is retired: the
number that could actually grow was the star-free count, and it is gone.
**New trigger: revisit only if `stats().fallback` exceeds ~25 entries**, which
would mean a starter-pack change or hand-written glob-in-token rules. Indexing
that class is possible (bucket on the mandatory literal prefix before the first
`*`, which the compiled regex is anchored on) but is not warranted at 3 entries.

Worth remembering how the one bug here got out: the index's whole safety argument
is that only a false NEGATIVE can change an answer, and a false negative shipped.
`coverIndexKey` treated `:` as a token boundary and `coverLookupKeys` did not, so
colon-form wildcards on non-command tools — including three `Skill(...)` entries in
`patterns/starter-pack.json` — were indexed under a key no lookup could generate,
and being indexed were not in the fallback either. The differential test's
generator only emitted `Bash`/`PowerShell`, where matching rewrites `:*` to ` *`,
so 300 random cases per run could not reach it. Fixed and covered three ways
2026-09-10. The lesson is about the CORPUS, not the code: a differential test is
only as good as the axes its generator actually varies.

### Killing a child can orphan its grandchild

`deactivate()` now kills the four tracked `execFile` children, but `recall.py`
re-execs itself into the toolbox venv (`RECALL_REEXEC=1`), so killing the
immediate child can leave the process that actually does the embedding running. A
process-group kill (`taskkill /T` on Windows) is what would make this certain.

### Module state that still survives deactivate

**Re-counted 2026-10-13. The 2026-09-10 count below it is kept for the record and
is superseded.** Method, so the next count can be compared like for like: every
column-0 `let` in `vscode-extension/extension.js`, plus every module-scope `const`
holding a `Set` or `Map`; then, for each name, every assignment, increment,
`.clear()`, `clearTimeout`/`clearInterval`, or call to a helper that clears it,
inside the bodies of `activate()` and `deactivate()`. A module-scope `const`
holding a stateless object (`settingsWriter`) is not counted.

**38 module-level mutables**: 33 `let` bindings (`let debounceTimer` through
`let activationGeneration`, plus `let extensionVersionMemo` further down) and 5
containers (`liveChildren`, `warnedOnce`, `liveTransfers`, and the two watcher
Maps `memoryCardWatchers` and `gatesCorpusWatchers`). Against `deactivate()`:

- **13 `let` bindings assigned**: `outputChannel` (disposed first), `dashboard`,
  `memoryLint`, `autoLearnManager`, `autoLearnManagerKey`, `autoLearnCardCache`,
  `codexFeatureUi`, `codexMemoryLint`, `codexMemoryGatesUi`, `codexMemoryReport`,
  `deactivated` (set to `true`), and, only when no re-activate happened during the
  awaited drain, `autoLearnWorkerRunner` and `autoLearnBusy`.
- **2 containers emptied** by helpers it calls, after killing or destroying what
  they held: `liveChildren` by `killLiveChildren()`, `liveTransfers` by
  `abortLiveTransfers()`.
- **9 timer handles cleared, not nulled**: `debounceTimer`, `recallSyncTimer`,
  `memBounce`, `gatesBounce`, `autoLearnBounce`, `autoLearnTimer` (an interval),
  `policyBounce`, `localDrainBounce`, `dashboardBounce`. Holding a dead handle costs
  nothing. The 2026-09-10 text said "eleven timer handles" and listed these nine;
  nine is the count.
- **2 watcher Maps emptied by the host, not by `deactivate()`**: `activate()`
  registers `disposeMemoryWatchers()` as a context subscription, so they empty when
  VS Code disposes the subscriptions after `deactivate()` resolves.
- **12 untouched**: `policyLock`, `lockedRetries`, `lastRun`, `recallRebuildAt`,
  `autoLearnLastError`, `autoLearnFailureCount`, `autoLearnNextRetryAt`,
  `localDrainRetries`, `localDrainAt`, `activationGeneration`,
  `extensionVersionMemo`, `warnedOnce`.

`activate()` resets five: `deactivated = false`, `activationGeneration += 1`,
`autoLearnBusy = false`, `autoLearnWorkerRunner = null` and, since 2026-10-13,
`warnedOnce.clear()`. It also repopulates `dashboard`, `memoryLint`,
`codexFeatureUi`, `codexMemoryGatesUi`, `codexMemoryLint` and `codexMemoryReport`,
and re-arms `recallSyncTimer`.

(`activationGeneration` is bumped, never reset, by design: it is the counter
`deactivate()` compares against after its drain.) That leaves **10 names that cross
a same-realm re-activate with neither function touching them**, each inert or
minor. `extensionVersionMemo` memoizes this module's own `package.json`, which
cannot change under it. `policyLock` holds a lock path and closures and no OS
handle between calls; the 2026-09-10 text called it a "disposed object", but
nothing disposes it and nothing needs to. `statusBar`, the other "disposed object"
named then, is no longer a module binding. The other eight are scalars: the retry
budgets `lockedRetries` and `localDrainRetries`, the timestamps `lastRun`,
`localDrainAt` and `recallRebuildAt`, and the Auto Learn failure fields
`autoLearnLastError`, `autoLearnFailureCount` and `autoLearnNextRetryAt`.

`warnedOnce` is the one with a visible effect, and it is not in the 2026-09-10 list
because it did not exist until 2026-09-24. warnOnce's comment promises "once per
distinct message, per activation", and nothing cleared the Set, so after a
re-activate (an extension disable/enable, or an upgrade) a warning the previous
activation had given was never repeated. Cleared with the other resets at the top
of `activate()` 2026-10-13, and pinned by "a same-realm re-activate repeats a
once-per-activation warning" in test/extension-lifecycle-async.test.js, which fails
with the clear removed (1 warning across two activations, not 2).

Still true 2026-10-13: two of the scalars have a real if minor effect across a
same-realm re-activate. `autoLearnNextRetryAt` carries a backoff over, and
`autoLearnFailureCount` carries the count that computes it. Not worth a change on
its own; worth doing next time this file is open.

Superseded 2026-09-10 count, as written then: 28 module-level mutables, **9 reset**
by `deactivate()`, 19 surviving. The five that held real memory were dropped then
and still are: `dashboard` and `memoryLint` each retained the whole
`ExtensionContext`, and `autoLearnManager`/`autoLearnManagerKey`/
`autoLearnCardCache` held parsed history state, the largest thing this extension
builds.

### Non-interactive runs refuse every output redirection

Measured 2026-09-03, Claude Code 2.1.258. Four `-p` probes were refused with
"Output redirection to '<path>' was blocked … may only write to files in the
allowed working directories", including a target inside the session's own working
directory that the refusal itself listed as allowed. The identical redirect
succeeded in an interactive session. Reads as `-p` failing closed because it
cannot prompt, with a message naming the wrong reason. Not this project's bug;
recorded because it invalidates any redirect experiment run through `-p`.

### Claude Code's built-in read-only command set — the inference was wrong, the probe is still owed

**Investigated read-only 2026-09-14. The conclusion below is withdrawn; the doc
now carries an honest marker instead of a confident claim either way.**

Original: `hostname` ran with no matching allow entry and no prompt, so the
built-in set is wider than the 14 commands `docs/claude-code-permissions.md`
lists from the docs. The list is used to argue which pack entries are redundant,
so it is worth pinning down before acting on that argument again.
`scripts/auto-mode-audit.js` is the wrong tool (it reads load-time warnings);
this needs a per-command probe.

**What checking actually found:**

- The official permissions page states the set outright, names the same 14 plus
  read-only `git`, and adds that it **is not configurable** — to require a prompt
  for one of them you add an `ask` or `deny` rule. It reads as a closed list, not
  as examples. `hostname` is not in it, and neither are `date`, `whoami`, `uname`
  or `df`.
- So "the set is wider" does not follow from the sighting. **The sighting has a
  simpler explanation that was never ruled out:** the machine it was taken on
  runs `permissions.defaultMode: auto`, and in auto mode the classifier decides
  everything. This file already documents that mode, in the section table and in
  "Auto mode discards part of your allow list". An unprompted command under auto
  says nothing about the read-only set, because the classifier would have allowed
  it regardless. The starter pack does not contain a `hostname` entry either, so
  the pack was not the explanation.
- **The probe is still owed, and it now has a precondition it did not have
  before: pin the mode to `default`.** Run each candidate with no matching allow
  entry, no `ask`/`deny` rule and the classifier out of the picture, then record
  whether it prompts. A probe run in `auto` measures the classifier and cannot
  answer this question at all — which is exactly how the `hostname` reading went
  wrong the first time.
- Running that probe needs a live Claude Code and is a behavioural experiment;
  no amount of reading settles it, so it was not attempted here.
  `docs/claude-code-permissions.md` now carries the withdrawal, the closed-set
  citation, and the one-directional rule: "it is on the list, so the grant was
  redundant" holds; "it is not on the list, so the grant did something" does not.

### Two things the burn-down proved about this file's own claims

Worth keeping because both were wrong here for a while:

- The drift-test entry said `test/policy-guard.test.js` compared against a third
  hand-copy in `autoLearnUi.js`. That was true once; commit `103b7e8` replaced
  it with a delegation, so the test did reach the canonical matcher and STILL
  could not fail, because all eight of its cases happened to agree. A test can
  be vacuous without being wired wrong.
- The Codex entry said ~40% of resolvable evidence was discarded, from a probe
  that counted output payloads. Re-measured with the real parser: 30 of 6,870
  observations, 28 of them failures, and no candidate changed disposition. Count
  the thing the code counts, not the thing that looks like it.

### RETIRED 2026-09-24: "a single transcript will eventually exceed the 512 MB string limit"

**This entry guarded a door that no longer exists, and its trigger could never fire.**
Kept as a correction rather than deleted, because the mechanism it described is the
kind a later session would re-derive.

It said `parseHistorySlice` does `buffer.toString('utf8')` on a whole file and throws
`ERR_STRING_TOO_LONG` past `MAX_STRING_LENGTH`, with "revisit when any single
transcript passes 200 MB". Both halves are now wrong. `parseJsonlRecords` decodes PER
LINE, so there is no whole-file decode left on that path; the only whole-buffer decode
remaining is inside the 1 MiB-capped `codexHeadSeed`. And the 64 MiB per-file ingest
cap added on 2026-09-22 means no single read reaches 200 MB in the first place, so the
trigger was unreachable as well as unnecessary.

**What replaced the risk, and it is on a different axis.** The pressure is not bytes in
one transcript, it is total observations per scan across the whole corpus: 764 files on
this box today, against 660 two and a half months earlier. Nothing is written against
that axis. The honest trigger is a per-scan observation count, not a per-file size, and
it does not exist yet.

### Inert bookkeeping candidates

Around a quarter of candidates are complex with no permission, so they can never
render a rule, never appear in Review, and cost no prompts: shell keywords
(`for`, `done`) and quoted-executable basenames. Masking is not at fault, checked
against bash heredocs and both PowerShell here-string forms. Cosmetic only.

### Optimization, measured and ranked

All from the 2026-09-10 pass. The hook's own sync I/O is clean — one
`readFileSync` (0.16 ms) and one `existsSync` (0.18 ms) on the common path, no
per-candidate I/O, no lock. Of a 66 ms process wall, ~50 ms is spawn + node boot
and not ours.

| Item | Measured | Frequency |
|---|---|---|
| ~~`require('./managed-policy')` is eager~~ **DONE 2026-09-10.** The figure was wrong three times: 0.61 ms recorded, 2.3 ms predicted by a stub harness that also pre-cached `permission-match`, then 1.27 ms claimed here. Two independent second-party measurements — 30 interleaved repo-resident pairs (**0.889 ms**, min 0.858) and 40 pairs across materialized `33612fe` vs `cd1f50c` trees (**1.01 ms** p50/min) — put it at **0.86–1.04 ms**. The 1.27 was 20–35% high. ~~**The retracted 2.3 ms figure still shipped in a code comment**~~ — **FIXED 2026-09-14.** It shipped in the former managed-policy header near the top of `permissions.js`; that header was later removed with the retired MAX implementation, so Git now holds the historical location rather than a current file:line anchor. | ~0.9 ms | per hook call |
| A fixed-point cache keyed on a CONTENT HASH of settings.json lets the hook skip the read, the module load and the pass | our-code p50 11.80 -> 2.46 ms; wall 62.3 -> 53.6 ms; 30/30 hits | per hook call |
| ~~`memoryReport()` runs TWICE per dashboard refresh~~ **DONE 2026-09-10.** "11.22 ms" was the COMBINED cost of both calls, not the saving — the second is much cheaper because the file cache and the JIT are warm. Measured directly, 11 interleaved fresh processes: one call 6.99 ms, two 9.92 ms, so hoisting saves **2.93 ms** and 25 fs syscalls | 2.93 ms | per refresh |
| `runWildcarding` takes the policy lock even on the unchanged path; the CLI hook was deliberately changed not to | lock cycle 3.72 ms of 9.60 ms, plus contention with Auto Learn | per settings.json write |

Two notes worth keeping. The fixed-point cache **needs a decision, not just
work**: it adds a new cache file on the hook path. Use a pure-JS hash, not
`crypto` — `require('crypto')` alone is 3.5 ms and ate 40% of the win
(re-measured 2026-09-10 by a second party at 4.65 p50 / 3.40 min cold, so this
is conservative). Every failure mode is "miss -> full pass".

**CORRECTED 2026-09-10.** The sentence that used to end this paragraph — "a
forced-miss run measured 15.72 vs 18.28 ms, so there is no cold-path regression"
— is **wrong, with the sign backwards**, and those two numbers are not the same
quantity. Against a purpose-built no-cache variant, two independent runs agree
that the **miss path costs 2.4–3.9 ms MORE** than having no cache at all
(n=41: +3.90 p50 / +2.44 min; n=21: +4.81 / +2.54). In-process accounting
agrees: module load 1.97 + stamp 0.53 + hash 0.72 + failed key read 0.23 + key
write 1.07.

It is still clearly the right trade — saving 9.2 against a cost of 3.9 puts
break-even at a **30% hit rate** and the real rate is near 100% — but the claim
must be *restated*, not deleted. Every settings.json change now costs a few ms
more than it did before the cache existed.

And the opposite conclusion for the extension, recorded so nobody applies the
hook's lesson by analogy: its eager requires are **not** worth making lazy.
Activation is 31.4 ms of requires plus 53.5 ms of `activate()`, paid once per
window at `onStartupFinished`.

### The dashboard's remaining duplicate reads

Deferred with a reason, not forgotten. The file is read 3-4x per `_push`
(`extension.js` at the push itself, then `readSettings()` in `autoLearnCardData`,
in `frictionState`, and via `localCardData`'s `readUserSettings`) with the value
already in hand at the top. Hoisting it needs signature changes in three more
functions and would save ~0.3 ms — and `frictionState()` may legitimately want a
fresh read, so threading a stale one trades a sub-millisecond gain for a possible
correctness regression. Not worth it.

One of them was not in that class and is gone. The three-state pill added a
`readSettingsState()` beside the push's own `readSettings()`, so `_push` opened
and parsed the file **twice before the first card was built** — for two values
that come out of one call, since `readSettingsState()` returns the parsed object
beside the state. Deleting the duplicate needed no signature change anywhere and
carries no stale-read risk, because the two reads it collapses were taken
microseconds apart and could already disagree: Claude Code rewrites
settings.json on every approval, `/model` and `/effort`. Filed here so the
deferral above is not read as covering it. No timing figure is claimed for the
removal; it is a deletion, not an optimisation.

Likewise `CLAUDE.md` and `~/.codex/AGENTS.md` are read 2x each because
`guidanceCardData` and `gatesCardData` both walk `installedGuidanceTargets()`,
and `gates.generated.md` is read 3-5x because `gatesStatus` (`src/agent-gates.js`)
reads it twice in one expression when gates are installed.

**The hazard that makes these riskier than they look:** `compiledGateCount()`
calls `readCompiled()` with **no home argument** deliberately, per the
no-singleton discipline documented in `agent-gates.js` and `agent-guidance.js` —
paths are resolved at CALL time so a test with a mocked home reads the mocked
file. A hoisted compiled-text value must be home-bound or a mocked-home test
silently reads the real file and passes for the wrong reason.

### The fixed-point cache's known limits

Both accepted, both worth knowing before extending it.

**A code change that preserves BOTH mtime and size is invisible.** The version
segment stats `src/permissions.js` and `src/permission-match.js`. `git checkout`
sets a fresh mtime so the motivating case (bisecting the generalizer) is covered;
hashing the ~43 KB of source instead would close it for ~0.1 ms plus I/O.

**The key covers `processAllowList` and nothing else.** Verified that the allow
array plus the code in those two files is the complete input set —
`patterns/starter-pack.json` is read at exactly one place, inside `--seed`, and
no policy read feeds the pass. If the hit path is ever widened to skip anything
else (the local-settings drain, managed policy, the MAX markers), those inputs are
NOT in the key and a third stat is required. A hit currently skips only the
generalization pass; `finish()` is still reached on all five of `run()`'s tails,
so the drain gate is unaffected.

**If the extension ever adopts it**, the cache belongs in memory, not in the
shared file: the extension host is long-lived, and its copy of the generalizer is
the generated mirror `vscode-extension/src/`, not the root path the version
segment stats.

## Deferred by the maintainer

### The CLI ships inside the extension only — decided 2026-10-13

The npm name is reserved (`ai-acolyte@0.0.1`, a placeholder, 2026-09-25) and the backlog
held the packaging work behind one unmade decision: does `wildcard-perms` ship standalone? **No,
for now: the CLI ships only inside the extension and the repository checkout.** The root
manifest stays `private: true` (pinned by `test/installers.test.js`) and keeps the name
`permission-wildcarding`, no `bin`, no `files` list and no publish workflow. What a reversal
would need is recorded where it was worked out and stays true: `docs/acolyte-rename-migration.md`
"Phase 3, the CLI name" (an `acolyte` name with `wildcard-perms` kept as a forwarding shim,
because every installed hook records the old command string), the decision that a published
build disables the CLI drain entirely (strangers clone untrusted code), Trusted Publishing over
OIDC rather than a token (the account's 2FA is a security key, so CI has no OTP), and a separate
publish job on Node ≥ 22.14 because the test and release jobs pin Node 20 on purpose. Publishing
itself cannot run from an agent tool call (`EOTP`, no TTY for the browser approval).

### The README screenshots stay as they are until a re-capture — re-affirmed 2026-10-13

Unchanged from 2026-09-27: `img/01-wildcarding.png` shows a `v1.4.13` badge, every count dates
from 2026-09-16, and three images carry legible local paths. Re-capture is mechanically possible
now — `scripts/vscode-acceptance/renderer.js` already calls `Page.captureScreenshot`, and its
`inspectDashboardDocument` computes the element rectangles a per-card `clip` would need — but
it needs a showcase fixture (the acceptance fixtures are test states, e.g. an empty allow list),
a neutral `TEMP`/`TMP` (this box's temp path carries the username), and a capture after the
version bump. The privacy gate is text-only and will never check a PNG.

### The 13 blanket wrapper grants in the starter pack

`Bash(bash|sh|python|python3|node|npx|pwsh|powershell *)`, `PowerShell(& *)`,
`PowerShell(python|python3|powershell|node *)`. Each is an arbitrary-execution
grant, the learner refuses to propose these exact shapes, and the Codex exporter
rejects one of them as "too broad" while the Claude seed installs it. Left in
place on the maintainer's call 2026-09-03. Note that auto mode discards most of
this class at load, so they are inert there and live only in manual. That sentence
used to end "which is the mode MAX switches to"; MAX was retired on 2026-09-24 and
nothing switches the mode any more.

### An audit of a live allow list

Turning the same measurement on a real ~300-entry list to report which entries
are broader than the evidence supports. Offered and deferred.

### Codex's policy cache is checked for EXPIRY only, never for account identity

The cap Codex MAX obeys is read from `~/.codex/cloud-config-bundle-cache.json`, and that
object carries three fields beside the payload the parser reads: `cached_at`, `expires_at`
and `account_id`. Measured 2026-09-21, none of the three appeared anywhere in `src/`,
`bin/` or `vscode-extension/`; the cache on this box had a **one-hour TTL that lapsed
2026-09-03T17:20:47Z**, declared `allowed_approval_policies = ["on-request", "untrusted"]`,
and had kept the toggle disabled for eighteen days while Codex itself accepted
`approval_policy = "never"` on threads dated 2026-09-14 and later. The account the bundle
was signed for was also not the signed-in one.

**Expiry shipped 2026-09-22. Account identity will not.** Two of the three fields are read;
`account_id` is deliberately left alone, and this is a decision rather than an omission.
Learning which account is signed in means reading `~/.codex/auth.json`, which holds live
OAuth tokens and an API key, and no feature in this repo is worth teaching it to open that
file. Expiry alone already unblocks the case that was reported — a bundle from a previous
login is also, always, a bundle that has aged out.

Two shapes settled at the same time, both load-bearing for anything that touches this later:

- **The cap stands.** An expired bundle is not silently promoted to "no restriction": a
  machine offline past the TTL would then drop a control that is genuinely in force. What
  changed is that the refusal stopped being final — `blockedBy: 'enterprise-policy-stale'`
  carries the dates, the dashboard button stays clickable behind a modal naming them, and
  the CLI needs `--override-stale-policy`.
- **Absence of an expiry is not expiry.** Every bundle fixture in the suite omits the field,
  and a truncated cache would read as expired under the opposite rule — the same
  fail-open the `allowedApprovalPolicies` comment warns about, arriving through another
  door. Only an `expires_at` that parses and sits strictly in the past counts.

Not re-derivable from the code: whether the cache path is still the one Codex writes. It
was re-confirmed against the shipping Codex binary on 2026-09-22, which is what made the
expiry work worth doing at all.


---

### Fixed in this pass

- **`writeTransform` could destroy the whole settings.json and report success.**
  `absent -> {}` was treated as the legitimate first run on *every* attempt,
  including retries. Reproduced end to end: `--max on` with one external delete
  inside the transform replaced 432 allow entries plus `model`, `effortLevel` and
  `agentPushNotifEnabled` with 7 blanket entries, recorded an **empty** allow
  snapshot, and exited 0. Now refuses on the read, ahead of a second transform
  call, so `applyMax` never snapshots `{}`.
- **`deniesLost` gated on `Array.isArray`,** so `deny: "Bash(rm -rf *)"` was
  written away with `wrote: true`. Now compared by value for non-array shapes.
- **`deactivate()` nulled its retainers after the awaited drain,** so a same-realm
  re-activate had its `dashboard` and `memoryLint` nulled by the old teardown's
  continuation — 0 pushes reached the successor's live webview and all ~35
  `dashboard?.refresh()` call sites were permanent no-ops.
- **Three post-teardown writers** (`ensureGuidance`, `scheduleAutoLearn`,
  `resetAutoLearnTimer`) now carry the `deactivated` guard.
- **Test isolation:** `delete require.cache[extensionPath]` left every `src/`
  module holding the first harness's `os` stub, so later tests resolved
  `home = os.homedir()` defaults to an earlier test's deleted temp home. Suite-wide
  temp-dir leak 3/run -> 0.
- **`SETTINGS_CONTENDED_CODE` now has a production consumer** — the vanish
  refusal above. The earlier entry calling it unconsumed is resolved.

### Refuted optimizations — do not retry

Each was built and measured, not reasoned about:

- **`NODE_COMPILE_CACHE`**: 1.88 p50 / 2.73 min **worse** on a hit, 2.86 / 2.06
  worse on a miss.
- **Doing the fs work before installing the stdin listeners**, so the 5.68 ms
  pipe wait overlaps our sync work: **1.27 p50 worse**. The stdin wait is not
  overlappable.
- **Inlining the cache module** to remove a whole module load: −0.14 p50 /
  −0.02 min. Zero.
- **`utf8` instead of a Buffer read** for settings.json: −0.56 / −0.41 ms, below
  the noise floor.

And the governing measurement fact: **the end-to-end noise floor for a ~60 ms
spawn on this machine is roughly ±2 ms in min and ±5 ms in p50**, so any
in-process saving under ~2 ms is unmeasurable at the process level. Three
candidates whose in-process cost measured 1–2 ms each came out at exactly zero
end-to-end. In-process stage timings do **not** add up to end-to-end deltas.

### The scope probe is a safety mechanism, not dead weight

Recorded because it reads as removable and is not. Stages 1–3 of
`processAllowList` are 54% of the pass and `coveredByScope` returns 0 on the
live list — but dropping the probe diverges on 1 of 83 differential cases, and
the divergence is a permission **widening**: on
`['Bash(rm -rf /*)', 'Bash(rm -rf /home)', 'Bash(rm -rf /home/x)']` the shipped
pass yields `['Bash(rm -rf /*)']` and the probe-free version yields
**`['Bash(rm *)']`**, because `Bash(rm -rf /home)` generalizes to `Bash(rm *)`
and only the probe keeps it specific long enough for prune to drop it.

It reads as dead weight on the live list *precisely because* that list is
already a fixed point, which is the only state in which it must fire zero times.

### Claims from today's commits that do not hold

- **`f041031`'s `preMax`/`wroteOnto` change is behaviour-neutral and completely
  untested.** Its message calls it a correctness fix — "both halves now come from
  ONE read" — but the old code was `applyMax(settings, turningOn)`, whose
  `res.settings` was computed **in memory from `settings`**. There was one read
  then and one now. Two mutants on the former `wroteOntoAllow` variable in the
  pre-removal extension implementation — it was named `preMax` when this was
  written — the post-MAX list, and `[]`, both
  **SURVIVED** the full 400-test suite. The four purge assertions in
  `test/policy-backup.test.js` guard the filter and the `MAX_ALLOW_CORE`
  constant; the only thing that varies with the argument is `detectMcpServers`,
  and at the time no test asserted an `mcp__*` blanket entry leaves the backup.
  One does now: "legacy cleanup preserves MCP blankets for servers introduced
  after MAX" at `test/policy-backup.test.js:652#blankets`, added in answer to this entry
  and since renamed from "MAX off purges a blanket that arrived WHILE MAX was
  on". Control:
  restoring the top-level `require('../src/permissions')` **is** caught, so that
  guard is real and this one is not.
- **`if (!res.changed)` in `toggleMax` is unreachable,** and the commit has it
  backwards: deriving `turningOn = !isMaxOn(latest)` from the same `latest` is
  exactly what makes it un-reachable. 65 shapes of `latest` enumerated (5 allow
  sets x 3 hook states x 4 modes, plus `{}`, `null`, non-array allow, bare
  `hooks`): **0 yielded `changed: false`**. The same function's wording also read
  backwards: "MAX is already ${turningOn ? 'OFF' : 'ON'}" answered a click asking
  for ON with "already OFF". Both are historical: the whole `toggleMax`
  implementation was DELETED on 2026-09-24, so there is no line to cite and Git
  holds the code this paragraph describes.
- **The version badge's degradation claim is false for the case it names.** For a
  **malformed** manifest the catch never runs: Node refuses to load
  `extension.js` at all (`ERR_INVALID_PACKAGE_CONFIG` at
  `getNearestParentPackageJSON`), so there is no dashboard to degrade. The guard
  does work for a manifest that is absent or valid-but-versionless.
- **`compiledGateCount`'s bullet fallback is unreachable** on any corpus
  `recall.py` can emit (0 of 8 gate sections has more than one top-level bullet).
  Kept as defensive, but it is not a tested path.

### Structural notes carried forward

- **The `writeTransform` shape and deny guards judge the transform's OUTPUT,** so
  unlike the `SETTINGS_UNREADABLE` refusal they cannot run before it. By the time
  either throws, `applyMax`'s snapshot and approve script have landed. Tolerable
  only because both transforms are idempotent overwrites, so the leftovers are
  inert. **A future transform whose side effects are not idempotent must not use
  this writer** — now stated in the code as well.
- **The fixed-point code stamp covers `permissions.js` and `permission-match.js`
  but not `settings?.permissions?.allow` at `bin/wildcard-perms:460#allow`,** where the
  allow array the pass runs on is extracted. Changing *which* field feeds the
  pass would not invalidate existing keys.
- **12 module-level frozen-home constants**, not the 8 recorded earlier: 6 in
  `extension.js` (`SETTINGS`, `BACKUP_DIR`, `MIRROR_BACKUP_DEFAULT`,
  `PROJECTS_DIR`, `CODEX_SESSIONS_DIR`, `RECALL_MODEL_HOME`) and 6 in `src/`
  (`codex-max.js` x3, `permissions.js` x3 — `BYPASS_STATE_FILE`,
  `MAX_STATE_FILE`, `APPROVE_DIR` — plus `policy-lock.js`'s `POLICY_LOCK_PATH`).
  The `require.cache` purge is now consistent across the four extension-harness
  test files, which is what made the frozen homes harmless; the constants remain
  a trap for the next harness.
- **~6650 leftover temp directories** had accumulated in `%TEMP%` on the dev
  machine from the leak fixed above. The leak is closed; clearing the historical
  residue is a one-time manual step, deliberately not automated.

### The CLI drain has no trust gate, and that is now an accepted risk (2026-09-24)

The extension refuses to drain an untrusted workspace: `drainableRoots()` returns `[]`
unless `vscode.workspace.isTrusted`. The CLI hook has no equivalent and no analogue
available to it. It takes `cwd` from the PostToolUse payload on stdin, tests that project
for `.claude/settings.local.json`, and drains it into USER scope on a path that is quiet
by design.

The gate that runs is `PROMOTABLE`, and it tests PORTABILITY, never provenance. So a
cloned repository that commits a `.claude/settings.local.json` containing a clean command
family clears it and that family lands in the user's global allow list. Nothing in the
flow shows a prompt, and the only trace is one stderr line on a hook that prints nothing
in the normal case.

**Decision 2026-09-24: keep the behaviour, record the risk.** The two alternatives were an
explicit trusted-roots allowlist, which puts a first-run step in front of every new
project for a threat the owner does not face on a single-user box, and removing CLI drain
entirely, which would stop promoting approvals for every folder VS Code never opens. The
exposure is bounded by what `PROMOTABLE` already refuses: script blobs, absolute-path
executables, MCP tools and file/web families all stay local, so the reachable damage is a
command-family grant the user would very likely have approved anyway.

Revisit if this repository is ever used on a machine that clones untrusted code, which is
the condition that changes the answer. Do not re-file it as a defect without that change.

### The two stat-keyed caches can still return a stale verdict

`policyFingerprint` and `autoLearnStateStamp` both key on `${stat.mtimeMs}:${stat.size}`,
so a same-size in-place rewrite inside timestamp granularity is invisible to both.
Accepted when written and re-affirmed 2026-09-24. The alternative is a content hash, and
the record already declines that trade for the fixed-point cache on the opposite grounds:
replacing a content hash with `mtime:size` weakens the one property that module exists
for. These two are not in that position. Both recompute on the next real change.

### The transcript corpus is mirrored to D: on a schedule, not junctioned (2026-09-24)

`~/.claude/projects` holds every session transcript and the memory store, measured at
**1.0 GB across 1,596 files on 2026-09-24**, up from 732.7 MB on 2026-09-14. It is a plain
directory, Claude Code's path for it is not configurable, and the 2026-09-10 profile wipe
took the lot once already. Nothing in this repository protects it and nothing in it can.

The originally proposed fix, junctioning the directory to a git repo on `D:`, was refused:
C: is the only SSD on this box, so a junction would move every transcript append onto a
spinning disk and trade a durability problem for a latency one on the hot path of every
session. That trade was never stated when the fix was proposed.

**Decision 2026-09-24: a scheduled mirror.** ROBOCOPY `/MIR` every six hours to
`D:\.backups\claude-corpus`, driven by a Scheduled Task. Writes stay on the SSD, loss is
bounded to one interval instead of everything, and deletions propagate so the mirror does
not become a second unbounded corpus. First run: 1,608 files, 1.05 GB.

The script lives outside every checkout on this box, deliberately. **The corpus is private
and must never enter this public repository under any option.** Two things it got wrong
first and now guards against: `[TimeSpan]::MaxValue` is the obvious spelling for an
indefinite repetition and the Task Scheduler rejects it as out of range, and the first
version logged "registered" after a `Register-ScheduledTask` that had just failed, because
the error was non-terminating and the log line could not fail. It reads the task back now.


---

## HARNESS HAZARD: when a mutation run reports that nothing died

Recorded 2026-09-22 after six false results in one session, across two
independent harnesses written by two different authors. Every time, the
harness was broken and the tests were fine.

**The symptom is the tell, and it is the only reason any of these were
caught.** A clean sweep of SURVIVED is not a result. Mutants die at a high
rate in this repo because assertions are written to name the mutation that
must break them, so when nothing dies, suspect the harness first.

**Output decoding, twice.** A Python harness ran `node --test`, captured with
`text=True`, and anchored `^. tests (d+)$` with `re.M`. Windows supplied CRLF,
so `$` never matched; and the console codepage decoded node's summary glyph as
three characters, so the single-character wildcard never matched either. The
harness read "I could not find a test count" as "no assertion fired" and
reported six survivors for six clean suites. Decode explicitly, normalise
CRLF, and never anchor on a glyph you did not choose.

**Exit codes through a pipe.** Checking a PowerShell harness with
`... | tail -3; echo $?` reports the exit status of `tail`, which is always 0.
A mutated run that had correctly exited 1 looked like a pass. Capture the exit
code of the process under test, not of the last stage of the pipeline.

**`pathlib.write_text` rewrites line endings.** On Windows it translates `\n`
to `os.linesep`, so a harness that read a file, patched it and wrote it back
converted `memory/recall.py` from LF to CRLF -- a file `.gitattributes`
declares `text eol=lf`. The harness's own "restored byte-identical" assertion
compared DECODED text, where universal newlines hide the difference, so it
passed. Only `git status` noticed. Use `write_bytes`, and if you assert a
restore, assert it on bytes.

**`String.prototype.replace` interprets the replacement.** A `$` followed by a
backtick in a REPLACEMENT string means "insert everything before the match".
A JS patch harness whose replacement text contained that pair spliced the head
of the file into a regex literal; the file stopped parsing and the harness
reported 121 assertion failures while measuring nothing. Use split/join for
literal replacement, and run `node --check` on every file a harness patches
before trusting a single number from the run.

**The rule that catches all of them.** Assert that the run HAPPENED before
reading its verdict: a nonzero test count, a witness assertion label in the
output, or a control mutation that must die. A harness that cannot distinguish
"the suite ran and nothing fired" from "the suite never ran" is not reporting
a result.

## MEASUREMENT HAZARD (mechanism CORRECTED below — read to the end)

**Read this before benchmarking anything in this project, and before trusting any
fs figure recorded in this file.**

Byte-identical files, same count, same volume, both arms interleaved in one
process with a rotating order, warm, n=31:

| location | 17-file read | per file | 17-file stat | per file |
|---|---|---|---|---|
| `~/.claude/projects/.../memory` | **1.46 ms** p50 | 0.086 ms | 0.90 ms | 0.053 ms |
| a `%TEMP%` copy of the same bytes | **8.54 ms** p50 | 0.502 ms | 0.83 ms | 0.049 ms |

**Reads: 5.9x. Stats: unaffected.** So the ratio between "read every file" and
"stat every file" is **1.6x in the real location and 10.3x in a temp dir** — which
inverts the conclusion of any stat-stamp-versus-read optimization.

I ruled out the obvious alternative explanation. A **fixed-path** `%TEMP%` corpus
measured twice — once with the files freshly created, once with them established
from the previous run — gave **7.69 ms and 7.72 ms**. Identical. It is not
first-touch cost and not a Defender scan-on-create; it is the location,
persistently. (Defender exclusions could not be read to confirm the mechanism —
`Get-MpPreference` requires elevation — and the mechanism does not change the
measurement.)

**Why this mattered.** The 2026-09-10 optimization audit measured the extension
"against a temp `HOME` mirroring the live corpus", so every fs figure it produced
for the extension is inflated ~6x on its read component. That is the single cause
of three refuted rows in the table above. The audit even observed the anomaly —
"only `~/.claude/settings.json`, which every process on this box hammers, gets
down to 0.159 ms" — and attributed it to that file being *frequently accessed*
rather than to *where it lives*.

### MECHANISM CORRECTED — it is the file EXTENSION, plus a path exclusion

The "6x in `%TEMP%`" framing above reproduces reliably and is still the wrong
explanation. Cross-testing content x location x size x **extension** — 19 files
of 2,700 identical bytes in ONE directory, warm, n=41, ms per file:

```
.js 0.095   .cjs 0.093   |   .md 0.505  .json 0.514  .txt 0.512
                             .mjs 0.517  .ts 0.508   .ps1 0.509  (no ext) 0.513
```

The dominant variable is the **extension**, not the directory. A separate path
effect sits on top: byte-identical `.md` reads at **0.084 ms** inside
`~/.claude` versus **0.491-0.532 ms** in `%TEMP%`, `C:\Users\<user>` and
another volume. `statSync` is barely affected either way. That is the signature
of Defender exclusions — by extension for `.js`/`.cjs`, by path for `~/.claude`.
Unconfirmed: `Get-MpPreference` needs elevation, so this is inferred from
behaviour.

**The corrected rule, which is narrower than my first version:**

- **`require()` of a `.js` module is location-independent.** Cold module-load
  and require-chain figures measured in a sandbox are **valid**. The blanket
  "sandbox fs numbers are wrong" was too broad and would have discarded good
  measurements — including the 212-byte-floor result above, which used `.js`
  files outside the repo and therefore still stands.
- **`.json` and `.md` reads are 4-6x inflated outside the excluded path.** The
  dashboard's own 87-call fs plan measures **4.87 min / 5.61 p50 ms** against
  the real `~/.claude` and **18.99 / 20.82** against a byte-identical sandbox
  mirror: 15.3 ms p50 of pure artifact. So the three refuted rows above are
  still correctly refuted; only the reason changes.
- So "read every file" versus "stat every file" is **1.6x where the data lives
  and 10.3x in a sandbox**, which inverts the conclusion of any
  stat-stamp-versus-read optimization.
- CPU-bound measurements (`processAllowList`, `coverLookupKeys`) are unaffected
  by either effect and are the most trustworthy figures in this file.

Worth confirming elevated, because it changes where every future fs measurement
in this project should be sited.

## Whole-object settings.json writers: FIVE sites, not one

The earlier entry called the apply path — built at `const updated = {`, written by
`atomicWrite(change.path, change.content)`, `src/auto-learn-manager.js:2286-2343#updated` —
"a third unrebased whole-object writer". Right, but incomplete, and the migration
is harder than it looked.

Sanctioned writers: `function writeAllow` at `src/settings-write.js:152#writeAllow` (rebasing
merge, written at `src/settings-write.js:217#writeFileAtomicSync`) and `function writeTransform`
at `src/settings-write.js:263#writeTransform` (CAS + verbatim, written at
`src/settings-write.js:371#writeFileAtomicSync`).

Unrebased whole-object writers still outstanding:

| Site | Nature |
|---|---|
| `const updated = {` at `src/auto-learn-manager.js:2286-2289#updated`, written `src/auto-learn-manager.js:2343#change.content` | The apply path. Has an `unchanged()` recheck at `src/auto-learn-manager.js:2340-2342#unchanged`, so it is **check-then-act, not CAS** — a write landing between the check and the `renameSync` inside `atomicWrite` is undetected. When it *is* detected it **throws**, so a routine Claude Code `/model` write turns a legitimate apply into a user-visible error plus rollback churn. |
| `{ ...permissions, allow: next }` at `src/auto-learn-manager.js:2850#next`, written `src/auto-learn-manager.js:2931#item.content` | **A fourth site, previously unrecorded.** `releaseClaudeGrants`, for `undo()`. Same shape, and **weaker** — no `unchanged()` recheck before the write at all. |
| `change.before.content` at `src/auto-learn-manager.js:2062#change.before.content` | `rollback()` restores it — a full-file write of stale bytes, guarded only by an `afterHash` check at `src/auto-learn-manager.js:2058#change.afterHash`. |
| `atomicWrite(item.target.path, item.current.content)` at `src/auto-learn-manager.js:2950#item.current.content` | `undo()`'s inner rollback, same shape, `src/auto-learn-manager.js:2946#item.restored.hash` hash guard. |
| `{ ...local, permissions }` at `src/local-settings.js:278#local` | Different file (`.claude/settings.local.json`) but the same class — and **the widest read-to-write window in the repo**: `src/local-settings.js:217#readFileSync` read → `src/local-settings.js:278#writeFileAtomicSync` write, spanning two `readUserSettings()` calls AND a full `writeAllow` to user settings. Claude Code writes this file too; it is where project-scoped "always approve" lands. `createSettingsWriter({ settingsPath: <local> })` would work here. |

**Why the migration is blocked, and it is not a small thing.** `applyUnlocked`
needs a **two-file atomic window**: `updateClaudeClaims` mutates `claims` in
place, and both `nextManagedClaude` (persisted into `state.managedClaude`) and
the claims *file* content are derived from that same read. Neither existing
writer supports two files. `writeTransform`'s retry loop would re-run only the
settings.json transform and leave attempt N-1's claims content — **a silently
corrupt claims registry, which is worse than today's throw.**

Three further blockers for whoever attempts it:
- Neither writer takes a backup, and `undo()` depends on `beforeHash` and
  `existed`. `change.afterHash` must be recorded from what the writer *actually
  wrote*, not from `change.content`, or `undo()`'s `untouched` test misclassifies.
- `rollback()` at `src/auto-learn-manager.js:2062#change.before.content` blindly restores `change.before.content`. If the writer
  rebased onto fresher bytes, rollback reverts the concurrent change — the exact
  bug, at the failure site.
- The new vanish guard in `writeTransform` would make `rollback()` **re-create a
  settings.json an external actor deliberately deleted.** That is a new defect
  the migration would introduce, and no existing test would catch it.

**Prerequisite, since met:** `grep "Policy changed" test/` returned nothing, so
the entire "detect and throw" behaviour that justifies this writer's safety was
unpinned, and swapping it for a retrying writer would have passed the full suite
silently. The "Policy changed" guard is pinned now: `test/auto-learn-manager.test.js:595-614#Policy`
records why, and the two tests are at `test/auto-learn-manager.test.js:616#survive` and
`test/auto-learn-manager.test.js:696#targets`.

## `runWildcarding`'s lock: the constraint that decides any refactor

Recorded because it is easy to get wrong and the failure is a data loss, not a
slowdown. `writeAllow` replays a **delta computed against the caller's
snapshot**, and its own note at `src/settings-write.js:173-179#NOTE` names this
caller: *"WRONG for one whose whole output is a function of the list it read …
Such a caller must re-read and recompute first."*

Today `runWildcarding` satisfies that **by accident of structure** — its
`readSettings()` happens to sit inside the lock, so the snapshot is nearly
`latest`. **Moving the read out of the lock without an authoritative in-lock
re-read and recompute reintroduces the MAX / `Bash(npm test)` deletion bug**
that the note above `wildcardUnderLock` (`bin/wildcard-perms:549-554#DISCARDED`) guards
against. Its worked `Bash(npm test)` example left that note with MAX in `d947565`, so Git
holds the full text.

Two further traps for that refactor, both real:
- **Key on file BYTES, not the parsed allow list.** The unchanged path is where
  "a deny rule added by hand first reaches the backup" (`vscode-extension/extension.js:3022-3024#rides`);
  a key on the allow list makes a deny-only edit a hit, and that rule never gets
  backed up. Two byte sequences can also parse equal.
- **Keep `backupPolicy` on the unchanged path.** It is the only thing that
  rebuilds a *deleted* backup — not hypothetical: on 2026-09-09 every directory
  under `~/.claude` was recreated and this path is what restored the mirror. It
  self-short-circuits when the union is unchanged, so it costs a read, not a
  write. Skipping it would also make five `test/policy-backup.test.js` tests go
  **vacuous rather than fail**, which is the "one early return away from becoming
  vacuous" hazard already recorded for that file.
- `lockedRetries` is reset only on the lock-completed path, so an early return
  that never reaches the lock strands the retry budget.

An in-memory memo (skip the pass entirely, not just the lock) carries five
further hazards and is deliberately NOT being done: a deleted backup never
rebuilt, deny-only edits lost, poisoning the memo on a busy-lock-deferred pass
(the one way to genuinely *miss* a generalization — only ever record a
"no work due" verdict from the same read, never after a write, a busy lock, or a
`SETTINGS_UNREADABLE`), the `lockedRetries` reset, and array aliasing
(`processAllowList` returns its input array for an empty/non-array input).

Also worth folding in eventually: activation takes **two** lock acquisitions
back to back — `runWildcarding()` then `drainLocal()` — which is the shape
`bin/wildcard-perms:487-500#ONE` ("ONE lock acquisition covering both jobs") was
deliberately fixed away from for the hook.

## `preMax` is misnamed, and the audit's read of it was wrong too

The removed purge argument was
`const wroteOntoAllow = wroteOnto?.permissions?.allow ?? []`, named `preMax`
when this record was written.
Two corrections:

- **It cannot be reverted.** `f041031` deleted the `readSettings()` call
  entirely, so there is no in-scope expression to revert to. The mutation that
  would actually test the change — `preMax = <the earlier read's allow>` —
  **cannot be written against the current code.** The audit's two surviving
  mutants therefore do not test the change; they test whether `detectMcpServers`
  matters.
- **The name and its comment are both wrong.** When turning MAX *off*,
  `wroteOnto?.permissions?.allow` is the **MAX-ON on-disk list**, not the pre-MAX
  list — the pre-MAX list lives only in the sidecar snapshot and is re-unioned by
  `disableMaxAllow`. The comment repeated the error too. Both have since been
  fixed in place before the feature was retired: the variable became
  `wroteOntoAllow`, and its comment stated the correction rather than the error.

Why both mutants survive, verified by running the real functions on both existing
fixtures (byte-identical purge sets for all three variants):
`buildMaxAllowSet`'s first seven elements are the `MAX_ALLOW_CORE` **constant**,
so only the `mcp__*` tail varies — and `detectMcpServers` matches the *prefix*
`mcp__S__`, so any specific `mcp__S__tool` surviving into the restored list still
yields server `S`. The only discriminating input is an `mcp__<S>__*` blanket that
lands **while MAX is on**, for a server with no other `mcp__S__`-prefixed entry.

### The per-project memory split is deferred, and the reason is not technical

`RECALL_MEMORY_DIRS` now makes a split *possible*: search spans corpora while `--lint` and
`--gates-compile` stay on the primary. What is not done is physically relocating memories
into per-project directories.

It only pays off if sessions are launched inside each project, which is not current
practice. Doing it would mean writing `.claude/settings.json` into 13 other repos, several
public, while a concurrent session was demonstrably active in at least one of them (two
agent worktrees appeared during this work). And it buys little that the index diet did
not already buy: deleting the slug vocabulary took `MEMORY.md` from 163 lines to 84, which
was the whole point.

Revisit only if launching per-project becomes the habit. Until then this is speculative
restructuring of a live memory store.

### The retrieval gate cannot run in CI, and its question set cannot be published

`memory/bench/gate_recall.py` is committed; `memory/bench/queries.json` is gitignored,
because it maps a private corpus (the same reason `bench_embed.py`'s query set is). So the
gate is reproducible only on a machine with both the corpus and the model.

`test/recall-py.sh` covers the *mechanics* against synthetic fixtures and is the thing that
would catch a regression. The quality numbers are a local measurement, not a CI gate, and the
commit message is where they live. Naming this so a later reader does not mistake the absence
of a CI job for an oversight.

### min-max versus RRF is unresolved, and 24 queries cannot resolve it

Measured on the 24-question set: min-max MRR 0.830, RRF 0.832, identical R@1 (0.79), R@3
(0.83) and median (1.0). RRF was marginally better on worst rank (39 vs 48).

Min-max ships as the default on a structural argument rather than a measured one: RRF fuses
ranks, so a document *no* query term touches scores as merely "last" rather than abstaining,
and its floor sits only 3x below its ceiling. Min-max lets the lexical leg contribute exactly
0.0 when it separates nothing, degrading to pure cosine. `mode="rrf"` is reachable from
`rank()` with no CLI flag so the question stays open.

`FUSE_W` swept 0.3-0.8: R@1 flat at 0.79 across 0.4-0.7, MRR flat, only worst-case monotonic
(22 at w=0.3, 48 at 0.5, 76 at 0.7). Left at 0.5 deliberately. **Do not tune it on this query
set**, `memory/bench/README.md` already says R@1 swings of one or two queries are noise at
twice this sample size.

### A gate that the unchanged code also passes is not a gate

Worth recording as a method note, because it nearly shipped. The plan specified the retrieval
gate as "median rank <= 2". Every mode scores a median of 1.0 on this corpus, vector-only
included, so that criterion would have passed against completely unchanged code. R@1 is what
moves (0.58 → 0.79) and is what the resident slug vocabulary was actually buying.

`gate_recall.py` now gates on R@1 with an MRR-lift proof, and `--fuse-w 1.0` is the built-in
mutation: it disables the lexical leg, collapses hybrid onto vector exactly, and must exit 1.

### `EMBED_CHAR_CAP` is decorative and the real cap is four times smaller

`EMBED_CHAR_CAP = 8000` looks like the limit on what gets embedded. It is not: `_encode`
truncates to 256 tokens, which on this corpus means a median of ~832 characters, 26% of the
already-capped text, worst case 9%.

bge-small's real context window is 512, so doubling the token cap is one line and doubles the
visible prefix of every file. It is not free: it needs an `EMBED_ID` bump and a full re-embed,
and `EMBED_ID` is pinned in `recall.py`, `src/recall-index.js` and asserted equal in
`test/recall-index.test.js`, so three files move together. Unmeasured in isolation:
`bench_report.md`'s "bge-small +qprefix" row conflates the window with the query prefix, so
that row is not evidence either way. Complement to BM25, not a substitute: an 8,000-char file
would still be ~75% invisible.

### This repo now ships two products under one name

`memory/` plus `src/agent-gates.js`, `src/recall-index.js`, `vscode-extension/memoryLint.js`
and the Memory card are a memory-management tool. The permission-wildcarding half is a
different tool. They share the VS Code extension for a real reason, under a managed policy
that defines only `PostToolUse`, the extension is the only durable automation surface, which
is what `## Design principle: watch the cause, don't hook the event` is about.

The cost is discoverability: nobody searching for an agent-memory tool finds
"permission-wildcarding", and the README (68 KB) and this file (54 KB) both carry two
products' worth of material. Not proposing a split, the coupling is genuine and two release
trains sharing a 34 MB model asset would be worse. Recording it so the naming question is
asked deliberately rather than discovered.

---

### Repo state and product state diverge until a release is cut

`vscode-extension/memory/recall.py` is a gitignored build artifact regenerated by
`scripts/package.mjs`, and `recallScriptPath()` prefers that bundled copy over the checkout. So
after any merge touching `memory/recall.py`, the installed extension keeps running the previous
version until `npm run package` and a reinstall. For c369e58 that meant the extension's own
`autoSyncRecallIfStale` loop kept hitting the unconverging deletion bug the merge had just
fixed, for as long as the VSIX was stale.

Not a contract break, and the interface is identical across versions. Worth stating as a release
rule: a merge that changes `memory/recall.py` is not in the product until the VSIX is rebuilt.

### The version bump is half of that release rule

Rebuilding is not enough on its own. `4471fe5` set the manifest pair to 1.4.4 and a VSIX was built
from it. Commits `8ce8c3a` and `312f86c` then changed `extension.js` and `memory/recall.py` on top
of that without touching the version, so a freshly built `permission-wildcarding-1.4.4.vsix` and
the earlier 1.4.4 named two different builds. VS Code keys upgrades on the version string, so
installing an equal version over an existing one is a silent no-op, which presents to a user as
"in-place upgrades do not work". Bumped to 1.4.5 on 2026-09-14.

Bump `vscode-extension/package.json` and the root `package.json` together.
`test/installers.test.js:511#manifests` — "the two package manifests report the same version" —
asserts they agree, and the extension manifest is authoritative because `release.yml`
defaults its version input to it.

## `file:line` rot: measured rates, and what a STALE verdict is worth

From the correction pass of 2026-09-14, which took the tree from OK 39 / STALE 60 /
UNVERIFIABLE 47 to OK 107 / STALE 23 / UNVERIFIABLE 17 across 162 references. Read this
before running another pass, and before trusting a raw count from
`node scripts/check-line-refs.js`.

**A STALE verdict is a candidate, not a proof, and the real rate was measured twice.**
A 16-reference hand sample put the share of STALE verdicts that are genuinely wrong at
about 80%. A full pass over all 73 non-OK rows in `BACKLOG.md` measured it at **34
changed against 39 left alone**, and **27 of 42 STALE**. So roughly two STALE in three
are real and one in three is a correct reference the checker misjudged, and most
UNVERIFIABLE rows were simply fine. **The 80% figure is retracted**; it came from too
small a sample. Never bulk-apply the checker's `suggest` field: in the cases examined it
named a neighbouring symbol often enough to be wrong on its own.

**Neither cheap automated bound decides anything.** Zero of the 115 non-OK references
pointed past the end of their target file, so "past EOF" clears all of them. And "the
cited line exists" is satisfied by a reference that is 1,425 lines off inside the right
file, which was the one confirmed transcription error of the pass. Only reading both
ends settles it.

**The rot is churn-driven, so it recurs.** 71% of the unresolved references pointed into
files that this single effort touched, and 99% into files touched in the last 120
commits. A concrete measure of the speed: a citation of `counts = Counter(terms)` in
`memory/recall.py` was verified by hand at line 470 and was wrong about an hour later,
in the same session, because merging a branch added 14 lines above it and moved that
statement to 484. A correction pass is therefore maintenance, not a fix. (Written
without the `file:line` form on purpose, so an example of a WRONG reference does not
enter the checker's own count as a real one.)

**Writing the anchor next to the citation is what makes a reference survivable.** Prose
that quotes the identifier actually sitting at the cited line can be checked by machine
forever; prose that only describes the code can never be checked by anything and rots
silently. Quoting the symbol converted 13 rows straight to OK in `BACKLOG.md` alone and
took `docs/engineering-record.md` from 2 verifiable citations to 19.

**Anchor placement before or after the citation is NOT a rule** — that belief was a
workaround for a defect, now fixed. `judge()` stripped a reference from the prose but
left the backticks around it, so a backticked reference collapsed to an orphan pair that
paired with the next real anchor's opening backtick and shifted every code span after
it. Two agents hit it independently on different files and both concluded the anchor had
to come first. It does not. See the note on `REF_STRIP_RE` in
`scripts/check-line-refs.js`, and the regression test
`an anchor written AFTER a backticked reference is still extracted`.

**Some references cannot be fixed and should not be chased.** Code that was deleted
rather than moved has no line to point at. A citation whose whole purpose is to record
where a retracted figure was wrongly said to live must stay wrong to make its point.
Both are in the tree on purpose.

**Declared anchors, added 2026-10-13: a citation can now be checked exactly.** Write
`file:line#identifier` or `file:start-end#identifier`. The anchor is one identifier,
optionally dotted (`fooBar`, `$scope`, `fs.realpathSync`), with trailing `.` or `:` read
as sentence punctuation. The reference is OK when the anchor occurs on the cited line, or
on any line of a cited range, as a whole token: not preceded or followed by `[\w$]`, the
boundary class the heuristic already uses for identifiers. So `scan` does not match
`scanTrouble` or `_scan`, does match `this.scan(`, and a dotted anchor is literal, a
prefix of a member chain. Citations are masked out before the search, so a citation is
never counted as an occurrence of its own anchor. Anything else is BROKEN, with every
line the anchor occurs on now. That includes a malformed anchor (`#foo-bar` is captured
whole and reported, not parsed as `foo`) and an ambiguous basename, which the bounds
check skips for an un-anchored reference: an anchor promises an exact check, and one
that cannot name its file cannot keep that promise. An anchored reference never reaches
the heuristic: no prose is read and no `suggest` is produced. **Because it reads no prose
it cannot cry wolf, so unlike STALE it is asserted**: `checkBounds`, and with it
`test/line-refs.test.js`, fails on a BROKEN anchored reference. A count floor,
`ANCHORED_FLOOR`, stops an edit quietly dropping one. The 159 un-anchored references the
tree held came out with identical verdicts, details and `suggest` lists, row for row.

**`node scripts/check-line-refs.js --fix-anchored` repoints a moved anchor, and this does
not contradict "never bulk-apply `suggest`".** That rule stands because `suggest` comes
from an anchor RECOVERED out of prose, which is wrong about one time in three. The fixer
acts only on an anchor the author DECLARED, and only when it occurs on exactly one line
of the target as a whole token. That leaves one possible answer and nothing to rank; the
judgement was the author's, made when they chose the anchor. It rewrites the cited line
number to that line and touches nothing else. Zero occurrences (renamed or deleted), two
or more, descending ranges, unresolvable targets and malformed anchors are reported and
left alone, and the run exits 1 while any anchored reference stays BROKEN. A range keeps
its length and is RE-HEADED on the anchor, so the fix is exact when the anchor names the
range's first line. Anchor ranges that way: the signature, the heading, the opening
statement. A mid-range anchor still lands inside the fixed range, but its old offset was
never recorded, and the FIXED line says "re-headed" so it gets looked at. A shift that
would run past the end of the file is refused rather than clipped. Each edit splices one
run of digits at a computed offset, verified against the parsed digits before anything
is written, so CRLF files stay CRLF. A second run writes nothing.

Two limits to know before migrating. A **bare continuation** such as `(:489)` after a
citation is not extracted at all, because `REF_RE` needs a file token, so it can be
anchored only by spelling the file out. And **an anchor is only as relocatable as it is
rare**: the first one in the tree, in `memory/recall.py`, anchors `slice` on the
gate-compile stderr slice in `vscode-extension/extension.js`, where that token is on 7
lines. It checks exactly, but if it moves, the fixer lists the 7 lines and leaves it to a
person. Same day, `.py`, `.yml` and `.yaml` comments started being scanned. That added
exactly one reference, and it was this one: it had cited a line 327 away from the slice
it described, and nothing could see it.

## Optimizations measured and DECLINED — do not re-derive these

Moved out of `BACKLOG.md` on 2026-09-14. Each was built or profiled, not guessed, and
each was rejected on the number rather than on taste. They were sitting in the queue
under headings like "none urgent", which is how a decision gets re-litigated: a reader
sees an unticked box, not a conclusion.

The measurement bar these were held to: cold, in fresh interleaved processes, against a
purpose-built variant with the change REMOVED. A warm loop or a sandboxed temp HOME has
been wrong every time, twice with the conclusion inverted.

### The JSONL byte-level prefilter: identical, and slower on every workload

Measured 2026-09-22. The idea was to skip `toString` and `JSON.parse` for lines
that cannot contain a tool call, testing the raw bytes for a marker first.

**Correctness was the gate and it passed completely.** Full-corpus differential
in 32 MiB boundary-aligned windows: 6,817.2 MiB of 6,817.2 MiB, 969 files,
1,141 windows, 97,469 observations per side, comparing every field plus the
non-enumerable parser offsets. **Zero mismatches.** Repeated at a 7 MiB window
so the slice boundaries fall elsewhere: zero again. The differential harness
was mutation-proven: dropping the Codex `function_call` marker produced 45
mismatches and lost 3,764 observations.

**It is slower everywhere.** Cold, interleaved, fresh processes, min / p50, the
delta being baseline minus prefilter so negative is worse:

| workload | delta |
|---|---|
| claude-append 0.53 MiB | -1.10 / -1.93 |
| claude-ingest 58.1 MiB | -27.48 / -30.68 |
| codex-ingest 59.1 MiB | -15.62 / -10.91 |
| whole corpus 2,185.9 MiB | -1035.2 / -1210.5 |

The skip test costs O(line bytes x markers) and the saving only lands on
skipped bytes. Measured skip rates: Claude 0.8% of lines and 1.4% of bytes;
Codex 73.5% of lines but only 34.5% of bytes corpus-wide, and 6.0% in an
ingest-sized slice. Codex lines are huge, p50 866 bytes and max 10.8 MB, so the
lines that do NOT skip get scanned an extra time for nothing.

**The prefix-bounded repair is unsafe and was not timed.** First-marker byte
offset over the corpus reaches 592,928 for Claude and 1,316,527 for Codex, so
even a 4 KB prefix window would silently drop 7,430 Claude and 1,192 Codex
lines. Silently losing evidence to save time is the trade this project does not
make.

**A figure of mine that does not reproduce, corrected here rather than left to
be cited.** A CPU profile taken earlier that day attributed 243 ms to
`parseJsonlRecords` over a 550 KB appended slice, and that number appears in
this session's reasoning about where scan time goes. A real 550 KiB-capped tail
parses cold in **9.9 to 13.5 ms**, and the whole 969-file, 356 MiB sweep of
550 KiB tails is 2,087 ms in one process. The 243 ms is roughly 20x anything
reproducible. Most likely it was the profiler's own attribution over a slice
that also carried GC and first-call compilation, read as steady-state cost.
Do not cite it.

### The four refuted rows from the 2026-09-10 ranked table

Moved out of `BACKLOG.md` on 2026-09-22, where they had sat struck through inside a
priority table for twelve days. A struck-through row in a worklist is still a row: it
reads as something someone decided not to do yet, rather than something that was measured
and is false.

**All four shared one cause: they were measured in a sandboxed temp `HOME`, where reads
cost roughly 6x what the same bytes cost in the real `~/.claude`.** That inflation is the
single most productive error in this project's measurement history, and it is why the bar
above says what it says.

| claim | measured figure | truth |
|---|---|---|
| `fullReport` re-reads the whole memory corpus every push | 6.98 / 7.96 ms | **0.56 ms.** Read 1.46 ms p50 against stat 0.90 ms over 17 files is a 1.6x ratio, not 10.3x. The growth argument was wrong too: a stat stamp scales with the corpus exactly as the reads do |
| 44 KB of verb bodies compiled on every hook call | 1.12 / 2.50 ms | **0.00 ms.** The real 44.4 KB file is 43.87 / 48.54 ms; a 1.8 KB stub is 44.00 / 48.73; a 212-byte floor is 43.01 / 48.48. V8 pre-parses and lazily compiles, so unexecuted verb code is free. **Do not re-derive this**: it proposed a 30 KB refactor of the most safety-critical file in the project for nothing |
| `gates.generated.md` read 5x per push | 1.55 / 1.69 ms | **~0.34 ms** |
| `CLAUDE.md` and `~/.codex/AGENTS.md` read twice each | ~0.89 ms | **~0.17 ms** |

### From the hook and extension profiling pass

**`activate()`'s two lock acquisitions.** Premise stale, counted empirically: a converged
list with no project-local file takes **0** acquisitions, 1 if either half has work, and
2 only on a first run. Taking the lock off both unchanged paths already did this. Merging
would fuse two independent retry budgets for near-zero gain.

**Inlining `fixed-point-cache` into the CLI.** Built the arm and verified it removes
exactly 2 fs calls. Three cold runs give sign-consistent deltas of +0.8 to +3.7 ms,
entirely inside the noise floor. About 200 lines duplicated for nothing.

**The FNV-1a loop.** 0.513 min / 0.600 p50 cold, but the second call is 0.088/0.101, so
**84% of it is V8 warm-up rather than the loop**. A 4-byte-unrolled variant is SLOWER
cold. Replacing the content hash with `mtime:size` would weaken the one property the
module exists for.

**The 19 `statSync` in `recallIndexStatus`** (0.765/0.848, the largest single fs
component). They ARE the staleness check, and `recall_index.json` is not watched. A stale
"not stale" badge is worse than 0.8 ms.

**Repeated small reads**, all at or below the bar and confirming earlier refutations:
`settings.json` 3x (0.302/0.506), `gates.generated.md` 3x (0.118/0.450), `CLAUDE.md` 2x
(0.073/0.306), `MEMORY.md` 2x (0.142/0.149).

**Perfect fs dedupe as a package.** 87 calls to 62 saves only 1.54/1.64 ms against the
real location, LESS than the sum of its parts, because each part carries shared per-call
overhead. The `fastLint` item alone captures 70% of it, so the package is worth strictly
less than its best member.

**Hit-path baseline, for anyone who thinks something crept in:** still 13 fs calls, and
`require.cache` on a hit holds exactly 2 modules. The dominant remaining term is NOT fs.
It is the stdin round-trip at 3.78 min / 5.48 p50 ms, of which only about 1.2 ms is
stream overhead the hook controls.

### From the allow-list and learner profiling pass

**Per-observation `aggregateObservations`.** Looks like a batch function called in a
loop, which is usually a finding. Measured 53.29 ms against 50.21 ms batched over 1,422
observations, a 6% difference. Not worth the restructure.

**`new RegExp` in `history-adapters.js`.** Never appears in the CPU profile at all.

**Multiple `readSettings()` per extension event.** 0.127 ms each, and the freshness is
deliberate and documented. See also the note above on the same call being re-read inside
one dashboard push, which WAS worth removing, because that one was a duplicate rather
than a refresh.

**The double `JSON.stringify` compare.** 0.038 ms.

**`memory/recall.py` has no hot-path issue.** `build_or_update` already gates
re-embedding on `mtime` plus size, so the expensive work does not run on an unchanged
corpus.

**`fastLint`'s `existsSync` probes, answered from the listing. DECLINED AS A TIMING
CLAIM, kept on the syscall count. 2026-09-24.** The backlog row read "saves 1.07 min /
1.23 p50 ms per push, real `~/.claude`, warm, n=61". **It did not reproduce.** Measured
three ways against a purpose-built arm with the change removed: on `_push()` end to end,
p50 +0.64 / +1.25 / +0.62 ms with min −1.17 / +0.51 / −0.79 ms, so the sign flips at the
minimum; on `memoryReport()` alone, the regime the original figure used, min −0.134 /
+0.412 / +0.223 and p50 1.064 / 0.618 / 1.075 across n=61, n=81, n=41. The p50 is in the
right neighbourhood and the minimum is not stable. The change shipped anyway, on the
DETERMINISTIC count (`memoryReport()` goes 10 `existsSync` to 1), which is the same basis
the `refresh()` item used. **Do not restore the timing figure.**

**Threading the selection listing into `fullReport`. ZERO saving on this box.** There is
currently one store with a `MEMORY.md`, so selection short-circuits before listing
anything and `readdirSync` per report is back at 2, not the 4 the backlog recorded. It
removes one `readdirSync` per report only with two or more stores, which is what its test
asserts. Kept for that case; claimed for nothing today.

**Stale figures corrected 2026-09-24, all of them by large factors.** The memory corpus is
**137 files, not 17**. `recall_index.json` is **1.20 MB, not 157 KB or 122 KB**.
`recallIndexStatus` does **~136 `statSync`, not 19** — the refutation above still holds,
only the number moved. `fullReport` at "0.56 ms" is from the 17-file era. Re-measure
anything keyed to those numbers before citing it.

**What DID clear the bar, for contrast: memoising the `recall_index.json` parse.** Read
plus parse is 4.62 min / 6.14 p50 ms against 0.035 / 0.045 ms for a `statSync` of the same
file, so it is the largest single fs term in a push. Cold, fresh process per sample, arms
interleaved and rotated: **4.11 / 7.07, 6.62 / 6.90, 5.23 / 5.88 ms saved** off a 43-46 ms
steady push across three runs, roughly 13-15%. The first push in a fresh process is inside
the noise, necessarily, because nothing is memoised yet. NTFS mtime granularity here is
~0.5 ms (191 distinct stamps over 200 back-to-back same-size rewrites), so `mtimeNs` buys
no extra resolution and `{ bigint: true }` was not added. What is cached is a projection,
not the parse: the full parse retains 486 KB, the projection 16 KB, because `vec` is 384
floats per memory and no caller reads it.

---

## The 2026-09-25 measurement pass: fourteen claims, one survivor

Every open performance item in `BACKLOG.md` was measured to the standing protocol in one
serial pass, with nothing else running. **One was implemented, seven declined with
numbers, five were already at HEAD, one was a breakdown.** The declines are the product.

### The one that survived, and the refutation that was aimed at a different change

**Hook stdin no longer goes through `process.stdin`. IMPLEMENTED.** The Socket
construction plus the event-loop round trip for `data`/`end` was the largest remaining
term in a hook call. Cold, fresh interleaved processes, real hook spawn with a real
PostToolUse payload, both arms on the cache-hit path: against a purpose-built reverted
arm, n=41 x3, **min -5.359 / -6.382 / -5.567, p50 -3.815 / -5.852 / -5.677** off a
59-65 ms call. Re-measured against shipped code rather than an approximation: min
-3.657 / -5.330 / -3.953, p50 -3.868 / -6.018 / -5.218. **8-9% off every PostToolUse
call.**

It is not the wait for data: with the payload written 20 ms after spawn, -4.810 / -6.205.
**The recorded refutation "doing the fs work before installing the stdin listeners was
1.27 p50 WORSE" is true and measured a DIFFERENT change** — it kept the stream. That
entry should not be read as covering this one.

Deliberately NOT `fs.readFileSync(0, 'utf8')`: that buffers the whole payload before
anything can cap it, reinstating the unbounded accumulation the 1 MiB cap exists to
prevent. A bounded `fs.readSync` loop measures the same.

### Declined, with the number. Do not retry any of these.

**The hook keys twice on a miss.** 0.487 min / 0.699 p50 ms, cold n=41, real 45,891-byte
settings.json. **Smaller than the recorded ~1.2 ms**, a quarter of the bar, and paid only
on a miss whose real rate is near zero.

**Path probes poison the rule-match cache. THE PREMISE IS FALSE.** `normalizedRules` and
`compiledRules` are separate Maps with separate size checks and only rule strings reach
the compiled one. Measured after 1,000 / 5,000 / 10,000 / 20,000 synthesized
`Tool(<path>)` probes against the real 149-rule managed set: compiled = **78, 78, 78, 78.
Never once evicted.** Only `normalizedRules` thrashes. Cost of that thrash at 20,000
probes, cold n=15: with the cap raised out of reach, min -46.178 / **p50 +23.017**, sign
flips, claim nothing. With the probe never cached, -22.026 / -2.977 of 2,290 ms, i.e.
0.00015 ms per probe. The cap is meanwhile earning its keep as a leak bound: without it
`normalized` reaches 20,271.

**The drain reads settings.json four times.** It reads it **five** times on the one call
that promotes, then 1 read / 0 passes on every call after. One extra read is 0.263 / 0.317
ms, so removing all of them is ~1.3 ms on a once-per-project event. **Zero
`.claude/settings.local.json` files exist anywhere under the working root**, so the path
does not run here at all. The five reads are the unlocked probe, the in-lock plan read,
the writer's state read, the writer's rebase re-read, and the verify-after-write read that
"the truth is the file, not the intent" rests on.

**`new RegExp` in a nested loop, policy-exporters.** At the realistic 60-block export: min
-0.166, **p50 +0.009**, sign flips. At 200 blocks: -0.772 / -0.809, still well under the
bar, on a validator that only runs when Codex rules are exported. The
`history-adapters.js` refutation now has a sibling.

**`[...deny, ...ask]` spread and `coversPrefix` lowercasing.** The CPU cost is real and
reproduces: isolated over 525 real allow entries, cold n=41, **saving 3.757 min / 3.803
p50**. It does not survive into the only call that contains it. A real `status()` over the
live 618-candidate state, cold n=31 x3: p50 **-1.409 / -1.247 / -2.404** of a 146-167 ms
call. Under the bar, and it would buy that with a `tokens`/`lower` sync invariant on the
exported `rulePrefix` shape. **Declined on the containing call, not on the microbenchmark**
— that distinction is the whole point.

**`best_line` calls `_display_keys` per printed result.** In-process the recorded ~5 ms is
right (0.459/0.513 per call, k=10). It does not survive to the process: run 1 min **+3.379**
/ p50 -8.967; run 2 min **+6.979** / p50 **+1.702**. Sign flips within a run and between
runs. The cause is visible below: this box drifted 25% across the session, 20x the effect.

**The sticky dashboard hint. Declined because the `coverIndexKey` memo already spent it.**
The hint's entire ceiling is one warm `processAllowList` per push, now 0.996 min / 1.197
p50 (n=200, A/B interleaved). A hint that never missed saves less than that. The recorded
1.38-2.19 / 1.65-2.20 is stale, and **the guard-test problem never has to be solved.** For
the record it IS solvable, so the blocker is the number and not the test: the pass-count
assertion re-expresses on OUTPUT as `pendingWildcard === 0` after a stale hint, because
trusting a stale hint against a 15-entry disk list renders 16, not 0.

### Figures corrected

**The `coverIndexKey` memo's own source comment does not reproduce.** It records warm n=270
`0.983/1.095 -> 0.483/0.540`. A no-memo arm measures **0.483/0.774** — their stated AFTER is
the measured BEFORE, and the memo arm is 0.065/0.107. Either the arms were labelled
backwards or the workload differed. The DO verdict is unaffected; the magnitudes are wrong.

**`recall.py`'s "1.0 s fixed cost with ~0.7 s unaccounted" is stale and now resolved.**
Total is **660.1 min / 688.9 p50**, not 1.0 s. The breakdown, n=11 fresh processes:
`import numpy` 110.7/116.8 (17%), `import onnxruntime` 81.9/88.8 (13%), **the ONNX session
190.6/205.1 (30%)**, **the BM25 corpus build 83.0/90.8 (13%)**, index load plus 136 stats
26.1/28.0, module body 9.6/10.3, query embed 6.5/6.9, matmul 0.067/0.102. So the
"unaccounted 0.7 s" is the session plus the corpus build. **First run after a boot pays
552 ms for the session, not 194**, because the 34 MB model comes off disk.

**Measurement drift on this box is 25%.** The same arms re-run forty minutes later moved
every one of them by that much. `recall.py` whole-process timing **cannot resolve anything
under ~30 ms here**; only in-process phase timing can. Three items were settled in-process
for that reason.

### Adjacent finding — DONE 2026-09-27, this entry was stale

`onnxruntime` is used at exactly one line and `numpy` only inside the embedder, the matmul
and `--selftest`, yet both are imported at module scope. `--lint`, `--lexical-only`,
`--gates-compile` and `--list` therefore pay **237 min / 244 p50 ms** of imports they never
touch, and `--gates-compile` is on the extension's corpus-watcher path.

**That was fixed and this entry did not say so.** `memory/recall.py:104-105#_LazyModule` now binds both
through a `_LazyModule` proxy (`np = _LazyModule("numpy")`, `ort = _LazyModule("onnxruntime")`),
and the comment at line 51 records the change from the old `import onnxruntime, numpy`.
Verified 2026-09-27 rather than read off the source: `python -X importtime recall.py --lint`
loads **neither** module.

⚠ **The lesson is about this file, not about the imports.** The entry sat under a heading
whose section is titled "do not re-derive these", so it was actively steering work away from
something already complete. A record of open findings needs the same disposition discipline
the backlog has — an entry is FIXED, DECLINED or OPEN, and "not acted on" is a claim with a
shelf life. It was caught only because a recommendation was checked against the code before
being made.

## MEASUREMENT HAZARD: `npm publish --dry-run` exits 0 on a private package

Checked against **npm 11.13.0**, 2026-09-27, while adding `"private": true` to the root
manifest. The obvious way to confirm the flag works is the obvious wrong one:

```
$ npm publish --dry-run
npm notice Publishing to https://registry.npmjs.org/ with tag latest and default access (dry-run)
+ permission-wildcarding@1.5.5
$ echo $?
0
```

That reads exactly like the flag is inert. It is not. The refusal lives at **line 15 of
libnpmpublish's `lib/publish.js`** — `if (manifest.private) throw EPRIVATE` — and npm calls
libnpmpublish **only when `!dryRun`**, at line 181 of its own `lib/commands/publish.js`. So the
one guard that stops a real publish is the one a dry run never reaches.

(Those two are deliberately not written in `file:line` form. They name npm's tree, not this
one, and `scripts/check-line-refs.js` correctly refuses a citation it cannot resolve against a
tracked file — which it did, on the first draft of this entry.)

A second trap sits beside it. `npm`'s *own* `lib/commands/publish.js` also tests `private`, at
line 142, but that test is `if (workspace && manifest.private)` and exists so
`npm publish --workspaces` skips private members. Reading only that file, in a repo that is not
a workspace, supports the opposite and equally wrong conclusion: that npm no longer honours
`private` at all.

**So `private: true` does block a real publish here, and neither reading npm's publish command
nor running a dry run demonstrates it.** Both were tried in that order and both pointed the
wrong way.

## A control that names a cause it does not require

`drainLocalSettings` blocks on **migration evidence** — the retired approve-all hook, or allow
entries the retired implementation generated that are still in user scope. It deliberately does
**not** block on `legacy.allow`, both blanket grants being live, because `Bash(*)` and
`PowerShell(*)` can be the user's own choice and blocking a legitimate drain is the worse error.
That trade-off is pinned by *"user-owned broad grants without migration evidence do not block the
drain"* in `test/local-settings.test.js`.

Both user-facing messages nevertheless told the reader the opposite: *"Legacy Bash(\*) and
PowerShell(\*) grants cover every local entry"*, and the dashboard label read *"legacy blanket
detected"*. Reachable counter-example, now a test: a user whose snapshot-derived `Read(*)` and
`Write` are still in user scope, with **neither** blanket grant anywhere, is blocked and told
that blanket grants cover every local entry.

`BACKLOG.md` had framed this as "either the condition or the wording is wrong". **It is the
wording.** The condition is correct and was already pinned by a named test; the first reading of
this entry proposed changing the predicate, which would have broken that test and penalised
exactly the legitimate user it protects. Fixed 2026-09-27 in `extension.js`, `bin/wildcard-perms`
and the guard's own comment.

The `legacy-blanket` report key is left alone: five call sites agree on it, and renaming a
contract to fix a sentence is the wrong trade. It carries a comment saying the name is
historical.

**Nothing asserted either string**, which is why the wording outlived the condition. There is now
a source-text tripwire beside the behavioural test. It is honest about being a tripwire: both
strings live inside a webview template and an inline CLI branch, so neither is reachable from a
unit test, and the guard asserts the CONDITION (the block does not imply blanket grants) rather
than that the strings exist.

⚠ **There were THREE sites, not two, and the first fix missed one.** The status row —
`setState('stLocal', ...)` at `vscode-extension/extension.js:4723#stLocal` — said the same thing in two
words, `legacy blanket detected`, and the tripwire, written against the long sentence, did not
know that spelling.
It was caught by grepping the **installed VSIX** after packaging 1.5.6, not by the suite, which
was green, and not by re-reading the patch, which looked complete. The tripwire now carries a
list of spellings rather than one regex.

This is the same lesson as the release-note claim about validating the deployed artefact, and it
keeps arriving from a different direction: **a patch script that asserts `count === 1` proves
its pattern was unique, not that the pattern was the only place the thing was said.** Uniqueness
of a string is not coverage of a concept. Grep the artefact for the CONCEPT afterwards.
