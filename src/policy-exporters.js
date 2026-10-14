'use strict';

// Cross-agent policy exporters for Auto Learn. The learner emits a neutral
// candidate; these exporters are the final safety boundary before it becomes a
// Claude wildcard or a Codex executable-policy rule.
//
// The governing principle (stated 2026-10-14, after the v1.6.2 audit's residuals, so that a new
// tool, option or variable is judged by it rather than by a new audit): a reviewed prefix is
// narrow only when it pins the program it runs, a script, module, package or fixed-purpose
// subcommand named literally, and every option and variable it carries is one a table here
// models as inert. Anything else makes it broad: an option or variable whose value is code text
// (`-c`, `-e`, `--eval`, make's `!=`), or names a program, a shell or the shell's arguments
// (`SHELL=`, `.SHELLFLAGS=`, `--shell`, `GIT_PAGER=`, `-e`/`--rsh`), or names a file that can load
// code or choose what runs (an env or dotenv file, an init, rc, config or OpenSSL file, a preload),
// or changes who the program runs as (`-u`, `--privileged`, sudo); an option no table lists, since
// its arity and effect are unknown; and a prefix that ends before the program is pinned. An exact
// informational form (`--version`, `--help`) is narrow only where it was MEASURED to print and
// exit before anything after it runs. The broad verdict is the safe failure, always: a reviewer
// can narrow a refused prefix, but cannot see what a narrow verdict let through. Three limits are
// known and recorded rather than closed: tokens after a fixed-purpose subcommand or a task target
// are that command's own and stay unread (make excepted, which reads them all), so a prefix still
// admits whatever its continuation adds (`["npm", "test"]` admits `npm test --node-options=...`,
// ACCEPTED-RECORDED); the tables enumerate runners, so a runner no table here names is judged by the
// generic rule as an ordinary program, which leaves a new exec-style tool narrow until a table names
// it (ACCEPTED-RECORDED; the remedy is adding it here, as the M1 census did on 2026-10-14); and the
// Claude half is stricter than this, refusing a wrapper or runner root at any depth by membership
// (64b4eaa), whatever the rest of the rule names.

// The one thing taken from the learner, and only to REFUSE more; see SHELL_WRAPPERS
// below for why that direction, and only that one, is safe to share.
const { SHELL_WRAPPERS: LEARNER_SHELL_WRAPPERS } = require('./auto-learn');

const GENERATED_FORMAT_VERSION = 1;
const CODEX_BEGIN_MARKER = '# BEGIN permission-wildcarding generated rules';
const CODEX_END_MARKER = '# END permission-wildcarding generated rules';

// `duckdb`, `hyperfine`, `just` and `make` (each with its `.exe` spelling, because
// canonicalRoot keeps the suffix) added 2026-10-13, alongside the same four in the
// learner's own SHELL_WRAPPERS in src/auto-learn.js. That table only raises risk; it
// cannot stop this exporter. MEASURED that day: a reviewed candidate the learner builds
// from `just build`, `make all`, `hyperfine 'sleep 1'` or `duckdb -c "SELECT 1"` carries
// the bare prefix `[root]`, is not `complex`, and rendered as a valid `prefix_rule` with
// that one-token pattern under `includeReviewed`: nothing here refused it, and the
// validator below bans only bare python, curl, git and PowerShell. A one-token pattern
// for any of the four is arbitrary execution, by recipe, by benchmarked command or by
// `.shell`. Membership here makes `wrapperIsBroad` refuse the bare prefix while still
// allowing a reviewed, narrower one (`["just", "build"]`), which is exactly how `sh` and
// `bash` are already treated. On the Claude side the bare `Bash(<root> *)` was already
// refused (it is on neither root list); membership also refuses a reviewed multi-token
// form such as `Bash(just --version *)`, as for every wrapper here. For hyperfine and duckdb
// the "narrower one" was a mistake, corrected 2026-10-14: naming a command or a database
// narrows neither (measured; RUNNER_GRAMMAR, at their entries), so they are broad at any
// depth now, hyperfine bar its informational forms and duckdb with none.
//
// The gap that sentence used to record ("NOT the full list of runners the learner
// knows: node, npx, uvx, xargs and others are absent") is closed as of 2026-10-13.
// MEASURED that day: of the learner's 43 SHELL_WRAPPERS roots, 27 were absent from
// this table, and every one of the 27 rendered a reviewed bare prefix (`["node"]`,
// `["npx"]`, `["uvx"]`, `["xargs"]`, `["parallel"]`, `["env"]`, `["eval"]`,
// `["iex"]`, ...) as a valid one-token `prefix_rule` under `includeReviewed`, each
// a grant to run whatever program or code its arguments name; 99 leaks counting
// the `.exe` and `.cmd` spellings. So the table below is now the UNION
// of this module's own list and the learner's, in each spelling canonicalRoot can
// hand over: the bare name, `.exe`, and `.cmd`, which is how npm, npx, pnpm and
// yarn are installed on Windows and which NETWORK_OR_INSTALL_ROOTS already spells.
//
// BACKLOG records the two tables as "not interchangeable", and they still are not:
// the learner's membership only raises risk, this one refuses rules, and this one
// keeps entries the learner lacks (`command.com`, every `.exe`). A union is correct
// for the REFUSAL direction specifically, and only for it. Refusing more is the safe
// failure here, so a root the learner adds can only make this gate stricter; and the
// import can never shrink this module's own extras, because OWN_SHELL_WRAPPERS stays
// a literal that is unioned in, not replaced. That is also why this does not break
// the "independent copy, so a bug in one does not propagate" rule the auto-safe
// tables below follow. That rule guards against a gate silently OPENING; through a
// union, the learner's table can only close this one further. The one way it could
// open is the learner DROPPING a root only it lists, which is why
// test/policy-exporters.test.js names every newly covered root as a literal, so a
// removal there fails here. The narrower-prefix rule in wrapperIsBroad is untouched:
// a reviewed `["node", "--version"]` or `["npx", "tsc"]` still renders, exactly as
// `["just", "build"]` does. On the Claude side the union does what membership has
// always done there (claudePermissionIsSafe refuses a wrapper root at any depth), so
// a reviewed `Bash(node --version *)` or `Bash(command -v *)`, which rendered before,
// is now refused like `Bash(just --version *)`. That asymmetry between the two
// halves predates this change and is not altered by it.
//
// The process and exec wrappers in the last row were added 2026-10-13. MEASURED that
// day against the previous exporter: a reviewed bare or option-only prefix for each of
// `sudo`, `doas`, `nohup`, `nice`, `time`, `timeout 5`, `stdbuf -oL`, `watch`, `setsid`,
// `ionice`, `flock lock`, `busybox`, `nsenter` and `strace` rendered as a valid
// prefix_rule under `includeReviewed`, because none of them was on either table, and
// each one runs whatever command follows it. The row also takes the wrappers in the
// same class that nothing had measured yet (`chroot`, `unshare`, `taskset`, `chrt`,
// `ltrace`, `valgrind`, `builtin`, `noglob`, `nocorrect`, `pkexec`, `su`, `runuser`,
// `runas`, `script`, `firejail`, `systemd-run`, `gdb`); EXEC_WRAPPER_GRAMMAR and
// ALWAYS_BROAD_WRAPPERS, beside wrapperIsBroad, give the reason for each one and say
// how far a reviewed prefix has to go before it is narrow. `env`, `exec`, `eval`,
// `command` and `xargs` were already refused bare through the learner's table and are
// not repeated here; their depth rules live in the same two places. Each root is
// spelled bare and with `.exe`, as above (`sudo.exe` is a real Windows 11 binary).
//
// The M1 census (2026-10-14) adds more programs whose whole job is to run another, found missing from
// every table. Each was checked against its man page or official docs and placed like its closest
// modelled sibling, and listed as a literal in test/policy-exporters.test.js (M1) so a drop fails by
// name. The identity changers and ungoverned sandboxes (`bwrap`, `proot`, `setpriv`, `sg`,
// `systemd-nspawn`) join ALWAYS_BROAD_WRAPPERS, broad at any depth like sudo, with their reasons there.
// The pure exec wrappers that exec their trailing argv directly (`caffeinate`, `cgexec`, `numactl`,
// `prlimit`, `sandbox-exec`, `unbuffer`, `xvfb-run`) get an EXEC_WRAPPER_GRAMMAR entry each, so a
// reviewed prefix is as narrow as the command it names, as for `nice` and `timeout`. `flatpak` is a
// RUNNER_GRAMMAR dispatcher whose `run` is broad. All are in this own table, not the learner's,
// because Claude Code does not strip them, which is where busybox, chroot and strace already sit. The
// census is bounded by the header's third limit; the further candidates are docs/engineering-record.md
// (M1), ACCEPTED-RECORDED and narrow until a table names them.
const OWN_SHELL_WRAPPERS = [
  'bash', 'bash.exe', 'cmd', 'cmd.exe', 'command.com', 'dash', 'dash.exe',
  'duckdb', 'duckdb.exe', 'fish', 'fish.exe', 'hyperfine', 'hyperfine.exe',
  'just', 'just.exe', 'ksh', 'ksh.exe', 'make', 'make.exe', 'powershell',
  'powershell.exe', 'pwsh', 'pwsh.exe', 'sh', 'sh.exe', 'wsl', 'wsl.exe',
  'zsh', 'zsh.exe',
  // bunx and pnpx, the short names of `bun x` and `pnpm dlx` (2026-10-14, RUNNER_ALIASES). The
  // learner lists them too; they are spelled here as well so the refusal does not hang on it.
  // `dx` is `deno x`'s alias, here only (RUNNER_ALIASES says why).
  'bunx', 'bunx.exe', 'pnpx', 'pnpx.exe', 'dx', 'dx.exe',
  ...['builtin', 'busybox', 'bwrap', 'caffeinate', 'cgexec', 'chroot', 'chrt', 'doas', 'firejail',
    'flock', 'gdb', 'ionice', 'ltrace', 'nice', 'nocorrect', 'noglob', 'nohup', 'nsenter', 'numactl',
    'pkexec', 'prlimit', 'proot', 'runas', 'runuser', 'sandbox-exec', 'script', 'setpriv', 'setsid',
    'sg', 'stdbuf', 'strace', 'su', 'sudo', 'systemd-nspawn', 'systemd-run', 'taskset', 'time',
    'timeout', 'unbuffer', 'unshare', 'valgrind', 'watch', 'xvfb-run'].flatMap((root) => [root, `${root}.exe`]),
];
// The learner normalizes `.exe` away (src/auto-learn.js normalizeRoot) and this
// module does not (canonicalRoot keeps the suffix), so each learner root is added in
// every spelling a candidate prefix can carry. A root that already has a suffix, or
// is not a plain name at all (`.`), is added as written.
function exporterSpellings(root) {
  const name = String(root).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_+-]*$/.test(name)) return [name];
  return [name, `${name}.exe`, `${name}.cmd`];
}
const SHELL_WRAPPERS = new Set([
  ...OWN_SHELL_WRAPPERS,
  ...[...LEARNER_SHELL_WRAPPERS].flatMap(exporterSpellings),
]);

const DESTRUCTIVE_OR_ADMIN_ROOTS = new Set([
  'add-content', 'bcdedit', 'bcdedit.exe', 'chattr', 'chmod', 'chown',
  'clear-content', 'clear-disk', 'copy-item', 'dd', 'del', 'diskpart',
  'diskpart.exe', 'erase', 'format', 'format.com', 'icacls', 'icacls.exe',
  'kill', 'mkfs', 'move-item', 'net', 'net.exe', 'new-item', 'out-file',
  'reg', 'reg.exe', 'reboot', 'remove-item', 'rename-item', 'restart-computer',
  'rm', 'rmdir', 'runas', 'runas.exe', 'sc', 'sc.exe', 'set-content',
  'shutdown', 'shutdown.exe', 'stop-computer', 'stop-process', 'su', 'sudo',
  'takeown', 'takeown.exe', 'taskkill', 'taskkill.exe',
]);

const NETWORK_OR_INSTALL_ROOTS = new Set([
  'aria2c', 'choco', 'choco.exe', 'curl', 'curl.exe', 'ftp', 'ftp.exe', 'gh',
  'gh.exe', 'invoke-restmethod', 'invoke-webrequest', 'irm', 'iwr', 'nc',
  'netcat', 'npm', 'npm.cmd', 'npx', 'npx.cmd', 'pip', 'pip.exe', 'pip3',
  'pip3.exe', 'scp', 'scp.exe', 'sftp', 'sftp.exe', 'ssh', 'ssh.exe',
  'telnet', 'telnet.exe', 'wget', 'wget.exe', 'winget', 'winget.exe',
]);

// A Claude root wildcard covers every argument and subcommand. Consequently
// this allow-list is intentionally much smaller than the set of narrow Codex
// prefixes that can be emitted safely.
const CLAUDE_SAFE_BASH_ROOTS = new Set([
  'bat', 'batcat', 'cat', 'df', 'du', 'file', 'head', 'hostname', 'jq', 'ls',
  'md5sum', 'printenv', 'pwd', 'readlink', 'realpath', 'rg', 'sha1sum',
  'sha256sum', 'sha512sum', 'stat', 'strings', 'tail', 'tokei', 'tree',
  'uname', 'wc', 'where', 'where.exe', 'which', 'whoami', 'whoami.exe',
]);

const CLAUDE_SAFE_POWERSHELL_ROOTS = new Set([
  'compare-object', 'convertfrom-csv', 'convertfrom-json', 'convertto-csv',
  'convertto-html', 'convertto-json', 'format-custom', 'format-list',
  'format-table', 'format-wide', 'get-acl', 'get-childitem', 'get-command',
  'get-content', 'get-culture', 'get-date', 'get-filehash', 'get-host',
  'get-item', 'get-location', 'get-member', 'get-process', 'get-service',
  'get-winevent', 'group-object', 'join-path', 'measure-object', 'out-string',
  'resolve-path', 'select-object', 'select-string', 'sort-object', 'split-path',
  'test-path',
]);

// Roots a reviewer may wildcard by hand, kept separate from the two sets above
// because those state a stronger property: every argument is read-only, which
// is what lets the automatic path use them. These are not read-only. `ctest`
// runs whatever the project defines and `magick` writes files, so neither can
// ever be auto-applied; `isAutoSafeCandidate` requires read-only risk, and a
// selection here is named in the confirmation prompt before it lands.
//
// The list is evidence-driven rather than aspirational: each root is one the
// starter pack already grants for the other shell, so refusing to propose it
// meant the learner disagreed with the seed it ships. A single-token root
// belongs here only when a human granting it wholesale is a decision the
// project has already made.
const CLAUDE_REVIEWABLE_ROOTS = new Set([
  'cmake', 'cmake.exe', 'ctest', 'ctest.exe', 'magick', 'magick.exe',
]);

const SAFE_GIT_READ_SUBCOMMANDS = new Set([
  'blame', 'cat-file', 'count-objects', 'describe', 'diff', 'for-each-ref',
  'grep', 'log', 'ls-files', 'ls-tree', 'name-rev', 'rev-parse', 'shortlog',
  'show', 'status', 'whatchanged',
]);
const SAFE_RG_PREFIXES = new Set(['--files', '--type-list', '--help', '--version', '-h', '-V']);
// `cat-file` is absent deliberately: `git cat-file --textconv` runs the diff
// driver the repository names, so it stays readable (SAFE_GIT_READ_SUBCOMMANDS,
// above) without ever being auto-applied.
const AUTO_SAFE_GIT_SUBCOMMANDS = new Set([
  'count-objects', 'ls-files', 'ls-tree', 'rev-parse', 'show-ref', 'status',
]);
const STATE_MUTATING_ROOTS = new Set(['date', 'date.exe', 'hostname', 'hostname.exe']);
// This gate is deliberately a second, independent copy of the learner's list in
// src/auto-learn.js — a bug in one should not propagate to the other. A root
// qualifies only when no argument can reach its stdout, so roots whose argument
// *is* the output (echo, printf, Write-*, basename, dirname, Get-Date -Format)
// are excluded: one grant would otherwise become an arbitrary-content file write.
//
// The rationale used to say no Claude Code allow pattern can exclude a
// redirection. That is wrong, and the gate survives the correction. MEASURED
// 2026-09-03 against Claude Code 2.1.258: the redirect target IS intercepted
// independently of the command rule, `Bash(echo *)` allowed, five probes. In a
// non-interactive `-p` run every redirect was refused ("Output redirection to
// '<path>' was blocked"), including one inside the session's own working
// directory that the refusal itself listed as allowed. In an interactive session
// the identical redirect SUCCEEDED silently and wrote the file, because a
// tool-wide `Write` grant covers the write, and patterns/starter-pack.json seeds
// exactly that grant.
//
// So the guard is real but it is not protection we get for free: with `Write`
// allowed, an auto-applied `Bash(echo *)` does write arbitrary content to an
// arbitrary path. What the guard changes is blast radius, from anywhere on disk
// to anywhere inside the session's working directories. Still worth excluding.
// See docs/claude-code-permissions.md section 4.
const AUTO_SUFFIX_CLOSED_ROOTS = new Set([
  'false', 'get-alias', 'get-computerinfo', 'get-culture', 'get-host',
  'get-location', 'get-member', 'get-psprovider', 'get-timezone', 'pwd',
  'true', 'uname', 'uname.exe', 'whoami', 'whoami.exe',
]);
const AUTO_UNSAFE_REASONS = new Set([
  'credential-sensitive', 'environment-prefix', 'network-command',
  'prefix-suffix-unsafe', 'remote-argument', 'shell-structure',
]);


function canonicalRoot(token) {
  const normalized = String(token == null ? '' : token).replace(/\\/g, '/');
  return (normalized.split('/').pop() || '').toLowerCase();
}

// The program a command root names, for the lookups that REFUSE (2026-10-14). canonicalRoot
// keeps the spelling, so each refusal table was keyed by the spellings someone thought to list,
// and a name nobody listed was an ordinary unknown command: "two tokens, so narrower" on the
// Codex half, "not on any risky list" on the Claude half. MEASURED that day against 3417398:
// `["python3.12", "-c", "x"]`, `["nodejs", "-e", "x"]`, `["python.bat", "-c", "x"]`,
// `["sudo.cmd", "rm"]` and `["pwsh.cmd", "-Command", "x"]` each rendered as a reviewed
// prefix_rule while `python`, `node`, `sudo` and `pwsh` were refused, and `Bash(python3.12 x.py
// *)` rendered as a reviewed Claude rule where `Bash(python x.py *)` is refused by membership.
//
// Two normalizations, both toward the base the tables already hold:
//   * the Windows launch suffixes `.exe`, `.cmd` and `.bat`. A bare name resolves through
//     PATHEXT to any of them, and npm, npx, pnpm and yarn install as `.cmd`, pyenv-win's
//     shims as `.bat`. `.com` is deliberately not stripped: `command.com` is the DOS shell,
//     not the `command` exec wrapper, and has its own entry.
//   * versioned and distribution names of one interpreter, which take its switches: CPython's
//     `python3.12`, `python2.7`, `python3.13t` (free-threaded), `pythonw`, the `-dbg` builds,
//     PyPy, and the `py`/`pyw` launchers; Debian's `nodejs` and versioned `node20`; `ruby3.2`;
//     `perl5.36`; `php8.2` and `php82`; `pwsh-preview` and `pwsh-lts`; Debian's `yarnpkg`. Each
//     pattern needs the base name followed only by digits, dots or those exact suffixes, so a
//     tool that merely starts with one (`python3-config`, `nodemon`, `node-gyp`, `perldoc`,
//     `phpunit`, `pytest`) is untouched.
//
// Only refusal lookups use this: the wrapper, interpreter, runner and risk tables, the
// validator's bare-prefix bans. The allow tables (CLAUDE_SAFE_*, CLAUDE_REVIEWABLE_ROOTS,
// AUTO_SUFFIX_CLOSED_ROOTS, the git and rg read sets) keep the exact spelling, because `cat.cmd`
// is a batch file that happens to be called cat, and trusting it as cat would widen a gate.
// Normalizing toward a base can make a prefix NARROWER than the generic rule judged it (the
// generic rule calls `["python3.12", "-m", "pytest", "-x"]` broad for ending in an option; the
// python grammar calls it pinned), and that is the base's own verdict: `["python", "-m",
// "pytest", "-x"]` already renders. src/auto-learn.js keeps an independent copy for its
// wrapper lookup (interpreterAlias); test/policy-exporters.test.js holds the two to the same
// spellings.
const COMMAND_ALIASES = [
  [/^(?:python\d*(?:\.\d+)*[dmtw]*(?:-dbg)?|pypy\d*(?:\.\d+)*|pyw?)$/, 'python'],
  [/^node(?:js)?\d*(?:\.\d+)*$/, 'node'],
  [/^ruby\d+(?:\.\d+)*$/, 'ruby'],
  [/^perl\d+(?:\.\d+)*$/, 'perl'],
  [/^php\d+(?:\.\d+)*$/, 'php'],
  [/^pwsh-(?:preview|lts)$/, 'pwsh'],
  [/^yarnpkg$/, 'yarn'],
];
function commandBase(token) {
  const name = canonicalRoot(token).replace(/\.(?:exe|cmd|bat)$/, '');
  const alias = COMMAND_ALIASES.find(([pattern]) => pattern.test(name));
  return alias ? alias[1] : name;
}

function cleanOneLine(value, maxLength = 240) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function starlarkString(value) {
  return JSON.stringify(String(value))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function isAutoSafe(candidate) {
  return Boolean(candidate) &&
    (candidate.autoSafe === true || candidate.auto_safe === true);
}

function candidateRiskIsUnsafe(candidate) {
  if (!candidate) return true;
  const flags = [
    'admin', 'administrative', 'dangerous', 'destructive', 'isAdmin',
    'isDangerous', 'isDestructive', 'mutating', 'mutation', 'network',
    'privileged', 'remote', 'risky', 'writes',
  ];
  if (flags.some((key) => candidate[key] === true)) return true;

  const unsafeLabel = (value) => {
    if (value == null || value === '') return false;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value > 1;
    if (Array.isArray(value)) return value.some(unsafeLabel);
    if (typeof value === 'object') {
      return ['level', 'risk', 'category', 'categories', 'kind', 'flags']
        .some((key) => Object.prototype.hasOwnProperty.call(value, key) &&
          unsafeLabel(value[key]));
    }
    const label = String(value).trim().toLowerCase();
    if (!label || ['none', 'safe', 'low', 'low-risk', 'minimal', 'read-only', 'readonly', '0', '1'].includes(label)) return false;
    return true;
  };

  return [candidate.risk, candidate.riskLevel, candidate.risk_level,
    candidate.riskCategory, candidate.riskCategories, candidate.categories]
    .some(unsafeLabel);
}

function candidateIsComplex(candidate) {
  return Boolean(candidate?.complex || candidate?.isComplex ||
    candidate?.is_complex || candidate?.compound || candidate?.isCompound);
}

function candidateHasAutomaticBlock(candidate) {
  return (Array.isArray(candidate?.reasons) ? candidate.reasons : [])
    .some((reason) => AUTO_UNSAFE_REASONS.has(String(reason)));
}

function normalizePrefix(candidate) {
  // Only the learner's reviewed prefix is authoritative. Never derive policy
  // from a raw command string or a full observed argv.
  if (!Array.isArray(candidate?.prefix) || candidate.prefix.length === 0) return null;
  if (!candidate.prefix.every((token) => typeof token === 'string' && token.length > 0)) return null;
  if (candidate.prefix.some((token) => /[\u0000-\u001f\u007f]/.test(token) || token.includes('*'))) return null;
  return candidate.prefix.slice();
}

function candidateContainsSecret(candidate, prefix) {
  if (candidate?.secretBearing || candidate?.secret_bearing || candidate?.containsSecrets ||
      candidate?.contains_secrets || candidate?.credential === true || candidate?.sensitive === true) return true;
  return prefix.some((token) =>
    /^(?:[^=]*(?:api[_-]?key|authorization|credential|password|secret|token)[^=]*)=/i.test(token) ||
    /^bearer\s+\S+/i.test(token)
  );
}

// Flags that hand an interpreter its program as text. A reviewed prefix holding one is
// arbitrary execution exactly as `bash -c` is (refused below since before 2026-10-13):
// `["python", "-c"]` admits `python -c "<anything>"`. Until 2026-10-13 only the shells
// had this check, so `["python", "-c"]`, `["node", "-e"]`, `["env", "FOO=1"]` and
// `["xargs", "-0"]` each rendered as a valid reviewed prefix_rule (measured that day:
// wrapperIsBroad returned false for all four, because a two-token prefix of a
// non-shell runner was always "narrower").
//
// A flag ANYWHERE after the root counts, not only in the second position or the last.
// `bash -c` is refused at position two whatever follows, and finding where an
// interpreter's options end needs its value-option table (`python -W ignore -c` hides
// `-c` behind a value), which this module does not keep. So a reviewed prefix that
// merely carries the same text as a script argument (`["python", "x.py", "-c"]`) is
// refused too: the safe failure, and the reviewer can still narrow differently.
// Short-option clusters are matched where the interpreter accepts them (`python -Ic`,
// `perl -ne`, `ruby -pe`, `node -pe`). Ruby's `-E` is an encoding, not code; it is
// refused anyway, deliberately, because it costs nothing. `npx -c`/`--call` runs a shell
// command string, the same class, so it is here too. PowerShell and the POSIX shells
// keep their own branches below.
const INLINE_CODE_FLAGS = new Map(Object.entries({
  python: (token) => /^-[bBdEhiIOPqRsSuvVx]*c/.test(token),
  node: (token) => ['-e', '--eval', '-p', '--print', '-pe', '-ep'].includes(token)
    || /^--(?:eval|print)=/.test(token),
  bun: (token) => ['-e', '--eval', '-p', '--print'].includes(token) || /^--(?:eval|print)=/.test(token),
  deno: (token) => token === 'eval' || token === '--eval' || token.startsWith('--eval='),
  ruby: (token) => /^-(?!-)[A-Za-z0-9]*[eE]/.test(token),
  perl: (token) => /^-(?!-)[A-Za-z0-9]*[eE]/.test(token),
  php: (token) => /^-[rRBE]/.test(token) || /^--(?:run|process-(?:code|begin|end))(?:=|$)/.test(token),
  npx: (token) => token === '-c' || token === '--call' || token.startsWith('--call='),
}));
// `python3` and `py` had their own rows here until 2026-10-14; commandBase now hands every
// CPython, PyPy and launcher spelling over as `python`, so one row serves them all.

// `env` and `xargs` run whatever command follows their own options, so a prefix is
// only as narrow as the command it names. Returns that inner prefix (possibly empty),
// or null when an option is not one these tables know, which is treated as broad.
// `env -S` / `--split-string` takes a whole command line in one argument, so it is
// deliberately absent and lands on null.
const ENV_FLAGS = new Set(['-i', '-0', '-v', '-', '--ignore-environment', '--null', '--debug']);
const ENV_VALUE_OPTIONS = new Set(['-u', '--unset', '-C', '--chdir']);
const XARGS_FLAGS = new Set(['-0', '--null', '-r', '--no-run-if-empty', '-t', '--verbose', '-p',
  '--interactive', '-x', '--exit', '-o', '--open-tty', '--show-limits', '-e', '-i', '-l',
  '--eof', '--replace', '--max-lines']);
const XARGS_VALUE_OPTIONS = new Set(['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '-n',
  '--max-args', '-P', '--max-procs', '-s', '--max-chars', '--process-slot-var', '-J', '-R', '-S']);
function innerCommandPrefix(base, prefix) {
  let k = 1;
  for (; k < prefix.length; k += 1) {
    const token = String(prefix[k]);
    if (token === '--') { k += 1; break; }
    if (base === 'env') {
      if (token.includes('=') && !token.startsWith('-')) continue;           // NAME=VALUE
      if (ENV_FLAGS.has(token) || /^--(?:unset|chdir)=/.test(token) || /^-[uC]./.test(token)) continue;
      if (ENV_VALUE_OPTIONS.has(token)) { k += 1; continue; }
    } else {
      if (!token.startsWith('-')) break;
      if (XARGS_FLAGS.has(token) || /^-[0rtpx]+$/.test(token) || /^--[a-z-]+=/.test(token)) continue;
      if (/^-[adEILnPsJRSeil]./.test(token)) continue;                       // a fused value: -n1, -I{}
      if (XARGS_VALUE_OPTIONS.has(token)) { k += 1; continue; }
    }
    if (token.startsWith('-')) return null;
    break;
  }
  // env still reads NAME=VALUE pairs after `--`.
  while (base === 'env' && k < prefix.length && String(prefix[k]).includes('=')) k += 1;
  return prefix.slice(k);
}

// The process and exec wrappers (added 2026-10-13, see OWN_SHELL_WRAPPERS). Each EXECS
// the command named after its own options, with no shell in between, so it gets the
// env/xargs treatment above: a reviewed prefix is exactly as narrow as the command it
// names, `["timeout", "5", "rm"]` is `["rm"]` under a time limit, `["timeout", "5", "sh"]`
// is `["sh"]`, and a prefix that stops before naming one (`["timeout", "5"]`, `["nice",
// "-n", "10"]`, `["stdbuf", "-oL"]`, `["flock", "lock"]`) admits any command at all.
//
// Per wrapper: `flags` take no value, `values` take the next token, `fused` matches an
// option carrying its value in the same token, `operands` counts the fixed positional
// arguments that come before the command (timeout's DURATION, flock's lock file,
// chroot's NEWROOT, taskset's mask, chrt's priority), and `env`/`envFused` name an option that
// sets the command's environment (strace's `-E`, since L3). The option lists are each tool's
// own (GNU coreutils for timeout, nice, nohup, stdbuf and chroot; util-linux for setsid,
// ionice, flock, nsenter, unshare, taskset and chrt; GNU time; strace(1), ltrace(1),
// valgrind(1); bash/zsh for builtin, noglob, nocorrect), cross-checked against the
// per-wrapper option tables in Claude Code 2.1.296's binary, read the same day, where
// one exists. An option a table does not know returns null, which is broad: guessing
// its arity could take the command for a value or a value for the command.
//
// `command` is an exec wrapper too (`command -p` searches a default PATH), except that
// `-v` and `-V` turn it into a lookup that runs nothing; that case is `LOOKUP` and narrow.
// `exec` replaces the shell with the command it names (`-a NAME`, `-c`, `-l`). Both were
// refused bare through the learner's table already, and `["command", "sh"]` and
// `["exec", "sh"]` rendered until this table existed, because a two-token prefix of a
// wrapper with no grammar of its own was "narrower".
const LOOKUP = Symbol('lookup');
const EXEC_WRAPPER_GRAMMAR = new Map(Object.entries({
  timeout: { flags: ['--foreground', '--preserve-status', '--verbose', '-v'],
    values: ['-k', '-s', '--kill-after', '--signal'], fused: /^(?:-[ks].|--(?:kill-after|signal)=)/, operands: 1 },
  nice: { values: ['-n', '--adjustment'], fused: /^(?:-n.|--adjustment=|-\d+$)/ },
  nohup: {},
  stdbuf: { values: ['-i', '-o', '-e', '--input', '--output', '--error'], fused: /^(?:-[ioe].|--(?:input|output|error)=)/ },
  time: { flags: ['-p', '-a', '-q', '-v', '--portability', '--append', '--quiet', '--verbose'],
    values: ['-f', '-o', '--format', '--output'], fused: /^(?:-[fo].|--(?:format|output)=)/ },
  setsid: { flags: ['-c', '-f', '-w', '--ctty', '--fork', '--wait'], flagPattern: /^-[cfw]+$/ },
  ionice: { flags: ['-t', '--ignore'], values: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid', '--pgid', '--uid'],
    fused: /^(?:-[cnpPu].|--(?:class|classdata|pid|pgid|uid)=)/ },
  // flock's `-c`/`--command` (a shell command line, the `bash -c` case) is deliberately
  // not listed: before the lock file it is an unknown option, and after it the
  // leading-dash rule in execWrapperInner refuses it; both are broad.
  flock: { flags: ['-s', '-x', '-e', '-u', '-n', '-o', '-F', '--shared', '--exclusive', '--unlock', '--nonblock',
    '--nb', '--close', '--no-fork', '--verbose'], flagPattern: /^-[sxeunoF]+$/,
  values: ['-w', '-E', '--timeout', '--wait', '--conflict-exit-code'],
  fused: /^(?:-[wE].|--(?:timeout|wait|conflict-exit-code)=)/, operands: 1 },
  // A BusyBox applet name is the command; `["busybox", "sh"]` is `["sh"]` by the recursion.
  busybox: {},
  nsenter: { flags: ['--all', '--no-fork', '--preserve-credentials', '--follow-context'],
    flagPattern: /^(?:-[muinpUCTrwaFZ]+|--(?:mount|uts|ipc|net|pid|user|cgroup|time|root|wd)(?:=.*)?)$/,
    values: ['-t', '-S', '-G', '--target', '--setuid', '--setgid'], fused: /^(?:-[tSG].|--(?:target|setuid|setgid)=)/ },
  unshare: { values: ['-R', '-w', '-S', '-G', '--root', '--wd', '--setuid', '--setgid', '--propagation',
    '--setgroups', '--monotonic', '--boottime'],
  flagPattern: /^(?:-[muinpUCTfrc]+|--(?:mount|uts|ipc|net|pid|user|cgroup|time|fork|kill-child|mount-proc|map-root-user|map-current-user|map-auto|map-users|map-groups|keep-caps|propagation|setgroups|monotonic|boottime|root|wd|setuid|setgid)(?:=.*)?)$/ },
  chroot: { flags: ['--skip-chdir'], values: ['--userspec', '--groups'], fused: /^--(?:userspec|groups)=/, operands: 1 },
  taskset: { flags: ['-a', '-c', '-p', '--all-tasks', '--cpu-list', '--pid'], flagPattern: /^-[acp]+$/, operands: 1 },
  chrt: { flagPattern: /^(?:-[abdefimoprRv]+|--(?:all-tasks|batch|deadline|ext|fifo|idle|max|other|pid|reset-on-fork|rr|verbose))$/,
    values: ['-T', '-P', '-D', '--sched-runtime', '--sched-period', '--sched-deadline'],
    fused: /^(?:-[TPD].|--sched-(?:runtime|period|deadline)=)/, operands: 1 },
  // strace's `-E VAR=VAL`/`--env=VAR=VAL` "Runs the command with the environment variable var=val
  // set for execution", and a bare `-E VAR` "Removes var from the inherited environment variables
  // before executing the command" (strace(1), man7.org, read 2026-10-14; src/strace.c update_env
  // adds a value holding `=` and removes any other). So an assignment is judged as a container's
  // `-e` is, and a bare name, which only removes, is harmless (`envUnsetsBare`; L3, 2026-10-14).
  // `--e=` and `--en=` are `--env=` too: strace parses with getopt_long, which takes an
  // unambiguous prefix, and `env` is its only long option that starts with `e` (src/strace.c
  // longopts, read the same day). Until then `-E` was a plain value option, so `["strace", "-E",
  // "LD_PRELOAD=./x.so", "cat"]` rendered (measured against 0f29d7f). `-e` is strace's filter
  // expression, not the environment, and stays a value option.
  //
  // `-o`/`--output` (M2, 2026-10-14): "If the argument begins with '|' or '!', the rest of the
  // argument is treated as a command and all output is piped to it" (strace(1), man7.org, read
  // 2026-10-14), so a value starting with `|` or `!` is a program strace runs, judged broad by
  // `outputPipesToCommand`; a plain file path stays narrow. getopt_long resolves `--output`, and
  // its ambiguous prefixes `--o`/`--ou`/`--out`/`--outp`/`--outpu`, through `outSep`/`outFused`, so
  // `--out=|./x`, which the generic `--[a-z-]+=` fused form accepted as inert, is refused too. `-o`
  // and `--output` leave `values` for those two keys; `o` stays in the fused char class but outFused,
  // checked first, handles every `-o...`. Until this, `-o`/`--output` were plain value options, so
  // `["strace", "-o", "|./x", "cat"]` and `--out=|./x` rendered (measured against the M1 commit).
  strace: { flagPattern: /^-[cCdDfFhiknqrtTvVwxyzZ]+$/,
    values: ['-e', '-p', '-s', '-E', '-P', '-S', '-a', '-b', '-I', '-u', '-X', '-O', '-U', '--trace',
      '--expr', '--attach', '--string-limit', '--env', '--trace-path', '--columns', '--user'],
    fused: /^(?:-[eopsEPSabIuXOU].|--[a-z-]+=)/,
    outSep: /^(?:-o|--o(?:u(?:t(?:p(?:u(?:t)?)?)?)?)?)$/, outFused: /^(?:-o|--o(?:u(?:t(?:p(?:u(?:t)?)?)?)?)?=)(.+)$/,
    env: ['-E', '--env'], envFused: /^(?:-E|--e(?:nv?)?=)(.+)$/, envUnsetsBare: true },
  ltrace: { flagPattern: /^-[bcCfhiLrSStTV]+$/,
    values: ['-a', '-A', '-e', '-l', '-n', '-o', '-p', '-s', '-u', '-x', '-D', '-F', '-w', '--align', '--config',
      '--indent', '--library', '--output', '--where'],
    fused: /^(?:-[aAelnopsuxDFw].|--[a-z-]+=)/ },
  valgrind: { flagPattern: /^(?:-[vqd]+|--tool=[a-z][a-z0-9-]*|--(?!tool=)[a-z0-9-]+(?:=.*)?)$/ },
  // The M1 pure exec wrappers (2026-10-14), each documented to exec its trailing argv directly, so
  // judged recursively like nice and timeout. Options from each tool's man page (cited beside it); an
  // option no table lists is broad, as everywhere here.
  numactl: {  // numactl(8), "runs processes with a specific NUMA scheduling or memory placement policy"
    flags: ['-a', '--all', '-l', '--localalloc', '-b', '--balancing', '-s', '--show', '-H', '--hardware'],
    values: ['-i', '--interleave', '-w', '--weighted-interleave', '-m', '--membind', '-N', '--cpunodebind',
      '-C', '--physcpubind', '-p', '--preferred', '-P', '--preferred-many', '-c', '--cpubind'],
    fused: /^(?:-[iwmNCpP].|--(?:interleave|weighted-interleave|membind|cpunodebind|physcpubind|preferred|preferred-many|cpubind)=)/ },
  // prlimit(1), "prlimit will run this command with the given arguments". Each resource option takes an
  // OPTIONAL value, which getopt accepts only fused, so a bare resource option is a flag (a query) and a
  // fused one carries its numeric limit; -p/--pid operate on an existing process and name no command.
  prlimit: { flags: ['--noheadings', '--raw', '--verbose', '--core', '--data', '--nice', '--fsize',
    '--sigpending', '--memlock', '--rss', '--nofile', '--msgqueue', '--rtprio', '--stack', '--cpu',
    '--nproc', '--as', '--locks', '--rttime'], flagPattern: /^-[cdefilmnqrstuvxy]+$/,
  values: ['-o', '--output', '-p', '--pid'],
  fused: /^(?:-[cdefilmnqrstuvxy][0-9:]|--(?:core|data|nice|fsize|sigpending|memlock|rss|nofile|msgqueue|rtprio|stack|cpu|nproc|as|locks|rttime|output|pid)=)/ },
  cgexec: { flags: ['--sticky'], values: ['-g'], fused: /^-g./ },     // cgexec(1), "executes the task command ... in the given control groups"
  unbuffer: { flags: ['-p'] },                                        // unbuffer(1) (expect), runs `program [ args ]`; -p for a pipeline
  // xvfb-run(1), "The specified command is then run using the X display" of the Xvfb server it starts.
  'xvfb-run': { flags: ['-a', '--auto-servernum', '-l', '--listen-tcp', '-h', '--help'],
    values: ['-e', '--error-file', '-f', '--auth-file', '-n', '--server-num', '-p', '--xauth-protocol',
      '-s', '--server-args', '-w', '--wait'],
    fused: /^(?:-[efnpsw].|--(?:error-file|auth-file|server-num|xauth-protocol|server-args|wait)=)/ },
  // caffeinate(8) (macOS), `caffeinate [-disu] [-t timeout] [-w pid] [utility arguments...]`; it forks
  // and runs the utility while holding a sleep assertion.
  caffeinate: { flags: ['-d', '-i', '-m', '-s', '-u'], flagPattern: /^-[dimsu]+$/, values: ['-t', '-w'], fused: /^-[tw]./ },
  // sandbox-exec(1) (macOS), `sandbox-exec [-f file] [-n name] [-p string] [-D key=value ...] command`;
  // it enters a sandbox and then executes the command. The profile is a sandbox DSL, not a program.
  'sandbox-exec': { values: ['-f', '-n', '-p', '-D'], fused: /^-[fnpD]./ },
  builtin: {},
  noglob: {},
  nocorrect: {},
  command: { flagPattern: /^-p+$/, lookup: /^-p*[vV][pvV]*$/ },
  exec: { flagPattern: /^-[cl]+$/, values: ['-a'], fused: /^-a./ },
}));

// Wrappers that are broad at ANY depth, so naming a command after them narrows nothing:
//   * watch: joins its arguments and runs them with `sh -c` (procps watch(1); `-x`
//     execs instead, and is not modelled, so a reviewed `["watch", "ls"]` admits `watch
//     ls '; rm -rf x'`). Claude Code agrees this one cannot be checked: its docs list
//     `watch` among the exec wrappers a prefix rule never auto-approves.
//   * eval: concatenates its arguments and evaluates them as shell code.
//   * script: runs `-c COMMAND` through a shell, and with no `-c` starts one.
//   * sudo, doas, pkexec, su, runuser, runas: they change the identity the command runs
//     as, so `["sudo", "rm"]` is not as narrow as `["rm"]`: it is a grant to delete as
//     root what a reviewed `["rm"]` could only delete as the user. `su -c` and `runuser
//     -c` take a shell command line, `sudo -s`/`-i` start a shell, and `runas` takes the
//     program as one command-line string.
//   * firejail: older releases ran the program through `/bin/sh -c` unless
//     `--shell=none` was given, so its arguments can be shell text.
//   * systemd-run: many options take values (`-p`, `-E`, `--unit`, `--uid`) and some set
//     the identity, and this module keeps no table of them, so the named command cannot be
//     located reliably. Refused rather than guessed.
//   * gdb: `-ex` and `-x` run debugger commands, which include `shell` and `python`, so
//     `gdb --args prog` is an interpreter around prog rather than prog.
//   * parallel (added with the interpreter rule, 2026-10-13): GNU parallel runs each
//     composed command line through a shell ($PARALLEL_SHELL, else the invoking shell;
//     parallel(1), "--shell"), so `["parallel", "gzip"]` admits `parallel gzip ';' rm -rf
//     x ::: a`. Unlike xargs, naming the command narrows nothing. Until then it had only
//     the generic rule, so every two-token parallel prefix rendered.
//   * iex and invoke-expression (2026-10-14): PowerShell's Invoke-Expression and its one
//     alias. Its argument is a whole script, not a command name: `iex 'Get-Date | Out-Null;
//     Set-Content iex1.txt X'` ran both statements (MEASURED in a private temp directory,
//     PowerShell 7.6.6, as did `IEX`, `Invoke-Expression -Command` and the module-qualified
//     `Microsoft.PowerShell.Utility\Invoke-Expression`, which canonicalRoot reduces to the
//     cmdlet name), so whatever a reviewed prefix names after it is code text, and one that
//     ends at an option admits any script. A second positional argument is rejected ("A
//     positional parameter cannot be found", measured), so an exact `["iex", "Get-Date"]`
//     admits little beyond itself; it is refused anyway, the safe failure: the learner keys an
//     `iex` run on the bare root, so only a hand-built candidate carries a longer prefix, and a
//     reviewer who wants one script can grant its file. Both were learner SHELL_WRAPPERS (so
//     refused bare, and at any depth on the Claude half) and had only the generic rule here,
//     so `["iex", "Get-Date"]` and `["invoke-expression", "x"]` rendered (measured against
//     0ecf75b: 9 of the 13 prefixes test/policy-exporters.test.js lists).
//   * icm and invoke-command (2026-10-14): PowerShell's Invoke-Command and its one alias run
//     the script block they are handed, locally or on every computer `-ComputerName` names,
//     and `-FilePath` runs a script file there. MEASURED in a private temp directory with a
//     marker-file payload: `Invoke-Command -ScriptBlock { ...; Set-Content ic1.txt X }`, `icm {
//     ... }`, `ICM -ScriptBlock ([scriptblock]::Create("..."))`, the module-qualified
//     `Microsoft.PowerShell.Core\Invoke-Command { ... }` and `-ArgumentList` each wrote their
//     marker under PowerShell 7.6.6, and `icm { ... }` under Windows PowerShell 5.1 as well
//     (`(Get-Alias -Definition Invoke-Command).Name` is `icm`, its only alias). Until then
//     neither name was on any table, so even a bare `["icm"]` rendered (measured against
//     fd05398). They join the learner's SHELL_WRAPPERS too, which is how this module's union
//     reaches wrapperIsBroad for them.
//   * setpriv, sg (M1, 2026-10-14): identity changers like sudo. setpriv "Sets or queries various
//     Linux privilege settings" and sets the real/effective UID and GID (--reuid, --regid,
//     --init-groups; util-linux setpriv(1)); sg runs its command "with the /bin/sh shell" under a
//     different group (sg(1)), so it is shell text as well.
//   * bwrap, systemd-nspawn, proot (M1, 2026-10-14): namespace and container builders with ungoverned
//     options this module keeps no table of, so the command cannot be located reliably, as for
//     systemd-run. bwrap's `--setenv VAR VALUE` sets the command's environment (LD_PRELOAD),
//     `--uid`/`--gid` change its identity and `--cap-add` grants capabilities (bwrap(1)), so
//     `["bwrap", "--bind", "/", "/", "sh", "-c", "x"]` and `["bwrap", "--setenv", "LD_PRELOAD",
//     "./x.so", "cat"]`, which rendered by the generic rule until now (L3 recorded the second), are
//     broad; systemd-nspawn's `--bind`, `--setenv`, `-u`/`--uid` and `--capability` do the same
//     (systemd-nspawn(1)); proot's `-0`/`--root-id` "Make current user appear as root", `-q`/`--qemu`
//     "Execute guest programs through QEMU as specified by command" names an emulator, and `-b`/`--bind`
//     maps host paths (proot(1)).
const ALWAYS_BROAD_WRAPPERS = new Set([
  'bwrap', 'doas', 'eval', 'firejail', 'gdb', 'icm', 'iex', 'invoke-command', 'invoke-expression', 'parallel',
  'pkexec', 'proot', 'runas', 'runuser', 'script', 'setpriv', 'sg', 'su', 'sudo', 'systemd-nspawn',
  'systemd-run', 'watch',
]);

// The wrappers whose exact `--version` or `--help` prefix is narrow on the Codex half
// (2026-10-14). Until then the walk read either word as an unknown option, so `["timeout",
// "--version"]` and `["xargs", "--help"]` were refused with no reason anywhere. MEASURED that
// day, each with a payload after the informational word that writes a marker file, and a
// control run without the word that did write it: `timeout --version 5 sh -c '...'` and
// `--help`, `nice --version`/`--help`, `nohup --version`/`--help`, `stdbuf --version`/`--help`,
// `chroot --version / sh -c '...'` and `--help` (GNU coreutils 8.32), `env --version sh -c
// '...'` and `--help`, `echo g | xargs --version sh -c '...'` and `--help` (GNU findutils
// 4.10.0). None wrote its marker: each prints and exits inside its option loop, before the
// command it would run is reached. Only the long forms: none of these tools has a short one.
//
// Not opened, and why:
//   * the other exec wrappers (setsid, ionice, flock, nsenter, unshare, taskset, chrt, strace,
//     ltrace, valgrind, time, busybox) were not measured: none is on the box, or the one that
//     is is another program (Git for Windows' `strace` is Cygwin's, `time` is a shell keyword).
//   * the shell builtins (builtin, noglob, nocorrect, command, exec): their informational
//     forms are not documented, and `command --version` would look up a command of that name.
//   * ALWAYS_BROAD_WRAPPERS: the identity changers (sudo, doas, pkexec, su, runuser, runas)
//     and the shell-text and unbounded runners (watch, script, firejail, systemd-run, gdb,
//     parallel) stay broad at any depth, the row's own rule. eval is the one that cannot be
//     opened at all: POSIX eval takes no options and joins its arguments into shell text, so
//     whether `eval --version '; CMD'` runs CMD depends on the shell (bash 5's builtin
//     rejects `--version` as an invalid option, measured; a POSIX eval does not parse it).
// On the Claude half every one of these is a SHELL_WRAPPERS member and refused at any depth,
// informational forms included, by the membership 64b4eaa pinned: `Bash(timeout --version *)`
// is a rule for a wrapper Claude Code strips anyway.
const WRAPPER_INFO_ROOTS = new Set(['env', 'xargs', 'timeout', 'nice', 'nohup', 'stdbuf', 'chroot']);

// The prefix after an exec wrapper's options and operands: possibly empty, `LOOKUP` for
// `command -v`, or null when an option is unknown or the "command" is an option.
//
// `grammar` is an EXEC_WRAPPER_GRAMMAR entry, or (since 2026-10-13) the exec half of a
// RUNNER_GRAMMAR node below, with prefix[0] being the runner's own exec word (`run`,
// `exec`). Two keys exist only for runners: `untilDashDash` (kubectl exec and mise exec
// read positionals and options alike until `--`, and only what follows it is the
// command, so a prefix with no `--` walks to its end and names none) and `module` (`uv
// run -m X` runs `python -m X`, handed on as exactly that so the interpreter grammar
// judges it).
// strace writes its trace to a command, not a file, when the `-o`/`--output` value begins with `|`
// or `!` (strace(1); M2, 2026-10-14). ltrace's `-o` has no such rule: it fopen()s the name
// (ltrace options.c, `case 'o'`), so ltrace keeps a plain value option and only strace carries these.
function outputPipesToCommand(value) {
  const text = String(value == null ? '' : value);
  return text.startsWith('|') || text.startsWith('!');
}

function execWrapperInner(grammar, prefix) {
  const flags = new Set(grammar.flags || []);
  const values = new Set(grammar.values || []);
  let k = 1;
  for (; k < prefix.length; k += 1) {
    const token = String(prefix[k]);
    if (token === '--') { k += 1; break; }
    if (!token.startsWith('-') || token === '-') {
      if (grammar.untilDashDash) continue;
      break;
    }
    if (grammar.lookup?.test(token)) return LOOKUP;
    if (grammar.module?.includes(token)) return ['python', '-m', ...prefix.slice(k + 1)];
    if (flags.has(token) || grammar.flagPattern?.test(token)) continue;
    // A container's environment option (`env`/`envFused`, docker and compose, 2026-10-14), and
    // strace's `-E`/`--env` since L3: judged before the value is skipped, by envOptionIsUnsafe.
    if (grammar.env?.includes(token)) {
      if (envOptionIsUnsafe(grammar, prefix[k + 1])) return null;
      k += 1; continue;
    }
    const fusedEnv = grammar.envFused?.exec(token);
    if (fusedEnv && envOptionIsUnsafe(grammar, fusedEnv[1])) return null;
    // strace's `-o`/`--output` piped to a command (`|cmd`/`!cmd`; M2, 2026-10-14). Judged before the
    // value is skipped: a separated value is the next token, a fused one is captured. A plain file path
    // continues as a normal value option.
    if (grammar.outSep?.test(token)) {
      if (outputPipesToCommand(prefix[k + 1])) return null;
      k += 1; continue;
    }
    const outPipe = grammar.outFused?.exec(token);
    if (outPipe) { if (outputPipesToCommand(outPipe[1])) return null; continue; }
    if (values.has(token)) { k += 1; continue; }
    if (grammar.fused?.test(token)) continue;
    return null;
  }
  const inner = prefix.slice(k + (grammar.operands || 0));
  // A "command" that starts with `-` is an option this walk did not reach, not a
  // program. flock is the case that needs it: its `-c` comes AFTER the lock file
  // (`flock lock -c "cmd"`, util-linux flock(1)), so the operand count alone would hand
  // `["-c"]` on as the command and judge it narrow.
  return inner.length && String(inner[0]).startsWith('-') ? null : inner;
}

// Interpreters and shells: a reviewed prefix is narrow only once it PINS the program,
// i.e. names the script path or module the interpreter will run, or when it is exactly
// one inert informational form. Decided 2026-10-13. Until then any two-token prefix of
// these roots was "narrower" unless it held an inline-code flag (INLINE_CODE_FLAGS), so
// `["python", "-u"]`, `["bash", "-x"]`, `["node", "-r"]` and `["python", "-m"]` each
// rendered (measured against fa9db35 that day), and each admits whatever the next token
// is, including the code flag itself: `python -u -c '<anything>'`, `bash -x -c ...`,
// `node -r x -e ...`, `python -m <any module>`.
//
// The walk reads the interpreter's own options until the program: `flags` take no
// value, `values` take the next token (so `["python", "-W", "ignore"]` names no
// program), `fused` carry the value in the same token, and `pin` options take the program
// itself as their value (`python -m MODULE`, `php -f FILE`). A prefix that ends inside
// the options is broad, which is the "ends in `-u`, `-x`, `-r`, `-m`, `-W`, `-X`, `-O`,
// `-B`, `--require`" rule, and so is an option a table does not list: guessing that an
// unknown option takes no value would read its value as the script. That is also how an
// option that hands over code or stdin is refused: `bash -c`/`-s` (and any cluster
// holding `c` or `s`), `php -a`/`-S`, fish's `-c`/`-C` and `-` itself are deliberately
// absent from every table, so they land on "unknown". The one `broad` pattern is node's,
// for a code URL in a fused preload (`--import=data:...`) that the generic `--x=y` form
// would otherwise accept. Once a program is pinned the remaining tokens are ITS
// arguments, so `["python", "-m", "pytest", "-x"]` is narrow; an inline-code flag
// anywhere is still refused first (30f92a4).
//
// `info` is the set of exact second tokens that print and exit before anything runs. The
// four the decision names (`--version`, `-V`, `--help`, `-h`) are the default; the POSIX
// shells get only the long two, because there `-h` is `set -h` (hashall) and the shell
// goes on to read commands, and dash and ksh take `-V` as an editing mode.
//
// bun and deno dispatch on a subcommand first. `run`, `serve`, `compile`, `create` and
// `x` need a target after them (`["deno", "run"]` admits any script or URL); `exec`
// (bun's shell), `repl` and deno's `eval` are broad at any depth; any other first word,
// a file or a fixed-purpose subcommand such as `test`, pins. Their top-level options are
// not modelled (the two entries list none), so any of them is an unknown option and
// broad, the safe failure.
//
// bun's `x` is the exception among the targets (2026-10-14): it is `bunx`, bun's npx, which
// fetches or locates a package by name and runs its binary, so like `npx` and `pnpm dlx` it is
// judged by the command it names (`exec` below): `["bun", "x", "tsc"]` renders and `["bun",
// "x", "sh"]` does not. Until then any named target pinned it, so `["bun", "x", "sh"]` and
// `["bun", "x", "python", "-c", "x"]` rendered while `["npx", "sh"]` was refused (measured
// against e6d227c).
//
// deno's `x` joined it later the same day: deno 2.9.5's own help reads "Execute a binary from npm
// or jsr, like npx" (`deno x --help`, read on the box; not run, because it fetches packages), so
// `["deno", "x", "tsc"]` renders and `["deno", "x", "sh"]` does not; until then any named target
// pinned it (measured against b11038d). Every option deno x takes before the binary
// (`--preload FILE`, `-c/--config FILE`, `--env-file`, `--allow-scripts`, ...) is unmodelled, so
// broad, the governing principle in the header. `deno run SCRIPT` is unchanged: the target is
// the script or `npm:`/`jsr:` specifier it runs, and any option after `run` is broad.
const DEFAULT_INFO = new Set(['--version', '-V', '--help', '-h']);
const SHELL_INFO = new Set(['--version', '--help']);
const POSIX_SHELL_GRAMMAR = {
  info: SHELL_INFO, plus: true,
  // set-option letters that take no value; `c` (code), `s` (stdin), `o`/`O` (a value) are absent
  flagPattern: /^[-+][abefhiklmnprtuvxBCDEHPT]+$/,
  flags: ['--login', '--noprofile', '--norc', '--posix', '--restricted', '--verbose', '--debugger', '--noediting',
    '--dump-strings', '--dump-po-strings', '--pretty-print', '--version', '--help'],
  // a cluster that ENDS in o/O takes the next token as its value (`-euo pipefail`)
  values: ['--rcfile', '--init-file'], valuePattern: /^[-+][abefhiklmnprtuvxBCDEHPT]*[oO]$/,
};
const PYTHON_GRAMMAR = {
  info: DEFAULT_INFO,
  flagPattern: /^(?:-[bBdEhiIOPqRsSuvVx?]+|--(?:version|help|help-env|help-xoptions|help-all)|-\d[\d.]*(?:-(?:32|64|arm64))?|-V:\S+)$/,
  values: ['-W', '-X', '--check-hash-based-pycs'], fused: /^(?:-[WX].|--check-hash-based-pycs=)/,
  pin: ['-m'], pinFused: /^-m./,
};
const INTERPRETER_GRAMMAR = new Map(Object.entries({
  python: PYTHON_GRAMMAR,                             // every CPython/PyPy/py spelling (commandBase)
  node: {
    info: new Set([...DEFAULT_INFO, '-v']),
    flags: ['-i', '--interactive', '-c', '--check', '--inspect', '--inspect-brk', '--inspect-wait', '--no-warnings',
      '--trace-warnings', '--enable-source-maps', '--expose-gc', '--trace-uncaught', '--pending-deprecation',
      '--no-deprecation', '--throw-deprecation', '--trace-deprecation', '--preserve-symlinks',
      '--preserve-symlinks-main', '--test', '--watch', '--abort-on-uncaught-exception', '--experimental-vm-modules',
      '--experimental-strip-types', '--no-experimental-strip-types', '--experimental-transform-types',
      '--frozen-intrinsics', '--no-addons', '--trace-exit', '--zero-fill-buffers'],
    values: ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions',
      '--inspect-port', '--title', '--input-type', '--watch-path', '--test-reporter',
      '--test-reporter-destination', '--test-name-pattern', '--test-skip-pattern', '--redirect-warnings',
      '--unhandled-rejections', '--icu-data-dir', '--report-dir', '--diagnostic-dir'],
    // `--import=data:text/javascript,...` and friends carry the code in the option itself,
    // fused or as the next token. `--env-file` and `--env-file-if-exists`, fused or not, are
    // broad too (2026-10-14, the env-file decision at DOCKER_EXEC): node applies a NODE_OPTIONS
    // line from the file. MEASURED that day, Node 24.19.0, in a private temp directory:
    // `node --env-file=x.env z.js` and `node --env-file x.env z.js`, x.env holding
    // `NODE_OPTIONS=--require ./y.js`, each ran y.js; `node z.js` did not. Until then both were
    // plain value options, so `["node", "--env-file", "x.env", "x.js"]` rendered.
    //
    // Two more files that decide what loads, broad the same way since the same day, MEASURED
    // with Node 24.19.0 in the same directory:
    //   * `--openssl-config=FILE`: OpenSSL reads it at startup (a malformed file aborted node with
    //     "OpenSSL configuration error"), and a `providers` section's `module = PATH` is a shared
    //     library it loads and initialises: with `module = ./missing-provider-module.dll` under
    //     node's `nodejs_conf` section, node aborted in OpenSSL's initialisation trying to activate
    //     it. A present module would have run its own init code. It was a value option until then.
    //   * `--experimental-config-file=FILE`: node.config.json's `nodeOptions` take `require` and
    //     `import`, so a file holding `{"nodeOptions": {"require": ["./y2.js"]}}` ran y2.js (and
    //     the `import` form too). It matched the generic fused form and was narrow until then.
    // `--openssl-shared-config` (node then honours the system `openssl_conf` section, a file the
    // prefix does not name; measured to abort the same way) and `--experimental-default-config-
    // file` (reads ./node.config.json) are flags no table lists, so unknown and broad already.
    broad: /^(?:--(?:require|import|loader|experimental-loader)=data:|--(?:env-file(?:-if-exists)?|openssl-config|experimental-config-file)(?:=|$))/,
    broadValue: /^data:/,
    fused: /^--[a-z0-9-]+=/,
  },
  ruby: {
    info: DEFAULT_INFO,
    flagPattern: /^(?:-[acdlnpsSvwy]+|-W\d?|-x\S*|-0\d*|-K\w|--(?:verbose|yydebug|jit|disable-gems|version|help))$/,
    values: ['-I', '-r', '-C', '-F'], fused: /^(?:-[IrCF].|--(?:enable|disable|dump|encoding|external-encoding|internal-encoding)=)/,
  },
  perl: {
    info: DEFAULT_INFO,
    flagPattern: /^(?:-[acnpsStTuUwWX]+|-[lC0]\d*|-i\S*|-[vh])$/,
    values: ['-I', '-M', '-m', '-D'], fused: /^-[IMmDxV]./,
  },
  php: {
    info: DEFAULT_INFO,
    flagPattern: /^-[nHeilmqsvw?]+$|^--(?:ini|version|help)$/,
    values: ['-c', '-d', '-z', '-t', '--rf', '--rc', '--re', '--rz', '--ri'], fused: /^-[cdzt]./,
    // `-a` (the interactive shell) and `-S` (the built-in web server) are absent: each runs
    // code this prefix does not name
    pin: ['-f'], pinFused: /^-f./,
  },
  bash: POSIX_SHELL_GRAMMAR, sh: POSIX_SHELL_GRAMMAR, dash: POSIX_SHELL_GRAMMAR, ksh: POSIX_SHELL_GRAMMAR,
  zsh: POSIX_SHELL_GRAMMAR,
  fish: {
    info: SHELL_INFO,
    flags: ['-i', '--interactive', '-l', '--login', '-n', '--no-execute', '-N', '--no-config', '-P', '--private',
      '--print-rusage-self', '--version', '--help'],
    values: ['-d', '--debug', '-o', '--debug-output', '-f', '--features', '-p', '--profile'],
    fused: /^--(?:debug|debug-output|features|profile)=/,
  },
  bun: { info: DEFAULT_INFO, subcommands: { target: ['run', 'x', 'create'], exec: ['x'], broad: ['exec', 'repl'] } },
  deno: { info: DEFAULT_INFO, subcommands: { target: ['run', 'serve', 'compile', 'x'], exec: ['x'], broad: ['repl', 'eval'] } },
}));

function interpreterIsBroad(base, prefix) {
  const grammar = INTERPRETER_GRAMMAR.get(base);
  const rest = prefix.slice(1).map(String);
  if (rest.length === 1 && grammar.info.has(rest[0])) return false;
  const flags = new Set(grammar.flags || []);
  const values = new Set(grammar.values || []);
  const pins = new Set(grammar.pin || []);
  let k = 0;
  for (; k < rest.length; k += 1) {
    const token = rest[k];
    if (token === '--') { k += 1; break; }
    if (!(token.startsWith('-') || (grammar.plus && token.startsWith('+')))) break;
    if (grammar.broad?.test(token)) return true;
    if (pins.has(token)) return k + 1 >= rest.length;                     // `-m MODULE`: pinned once named
    if (grammar.pinFused?.test(token)) return false;
    if (flags.has(token) || grammar.flagPattern?.test(token)) continue;
    if (values.has(token) || grammar.valuePattern?.test(token)) {
      if (grammar.broadValue?.test(rest[k + 1] ?? '')) return true;
      k += 1; continue;
    }
    if (grammar.fused?.test(token)) continue;
    return true;                                                          // an option this table does not know
  }
  if (k >= rest.length || rest[k] === '-') return true;                   // no program named
  if (!grammar.subcommands) return false;                                 // a script path or module name
  const word = rest[k];
  if (grammar.subcommands.broad.includes(word)) return true;
  if (!grammar.subcommands.target.includes(word)) return false;
  const target = rest[k + 1];
  if (target === undefined || target.startsWith('-')) return true;
  return Boolean(grammar.subcommands.exec?.includes(word)) && wrapperIsBroad(rest.slice(k + 1));
}

// Development-environment runners, package runners and task runners (decided 2026-10-13).
// A runner-exec form is broad until it names a concrete command, and is then judged by
// that command, exactly as the exec wrappers above are: `["uv", "run", "pytest"]` is
// `["pytest"]` inside the project environment, `["uv", "run", "python"]` is `["python"]`,
// and `["docker", "exec", "ctr", "sh"]` is `["sh"]` in a container. Claude Code's own page
// names the class (code.claude.com/docs/en/permissions, "Wrappers", read 2026-10-13):
// "Development environment runners such as `direnv exec`, `devbox run`, `mise exec`,
// `npx`, and `docker exec` are not in the list. Because these tools execute their
// arguments as a command, a rule like `Bash(devbox run *)` matches whatever comes after
// `run`, including `devbox run rm -rf .`."
//
// MEASURED 2026-10-13 against bceb66f with a 268-prefix synthetic probe: none of docker,
// kubectl, uv, poetry, pipx, direnv, devbox, mise or ssh was on either wrapper table, so
// under `includeReviewed` a reviewed `["uv", "run"]`, `["docker", "exec", "ctr", "sh"]`,
// `["kubectl", "exec", "pod", "--", "sh"]`, `["ssh", "host"]`, and even the bare `["uv"]`
// and `["docker"]`, each rendered as a valid prefix_rule. The learner hands over exactly
// those two-token shapes (`uv run pytest -x` keys on `["uv", "run"]`, because `run` is in
// its FAMILY_SUBCOMMANDS). npm, npx, uvx, pnpm, yarn, make and just were on the table but
// had only the generic rule, so `["npx", "sh"]`, `["npm", "exec", "sh"]` and `["make",
// "-C", "dir"]` rendered too. The probe counts are in the commit that added this block.
//
// A node is one of:
//   * RUNS_ANY_COMMAND: broad at any depth, with the reason beside its use.
//   * infoOnly(info): broad at any depth too, except for exactly the two-token forms in
//     `info`, each MEASURED inert with a trailing payload before it is listed (2026-10-14;
//     hyperfine and wsl, the reasons beside their entries).
//   * `{ exec }`: a runner-exec form. `exec` is an execWrapperInner grammar (flags, values,
//     fused, operands, and the two runner keys there); the command after it is judged by
//     wrapperIsBroad, recursively.
//   * `{ target }`: a task runner (make, just, `npm run`, `mise run`). Its options are
//     walked (`target` is the grammar), and the first positional, a target, recipe, script
//     or task NAME, narrows it, as a named recipe already did (`["just", "build"]`). A
//     prefix that ends inside the options, including right after a value option's value
//     (`["make", "-C", "dir"]`, `["npm", "--prefix", "dir"]`), has named none and is broad,
//     because the next token can be any target or another option.
//   * `{ sub }`: a dispatcher. Its own `options` (a grammar, or none modelled) are walked,
//     the next word selects a child; a word with no child is a fixed-purpose subcommand and
//     narrow (`["docker", "ps"]`, `["uv", "sync"]`), unless `fallback: 'exec'` says the tool
//     runs an unknown word as a command (pnpm and yarn run a package bin by name), in which
//     case that word is judged as the command.
// Everywhere: an option a table does not list is broad (its arity is unknown, so the
// command could be taken for its value or its value for the command), and `info` is the
// exact two-token forms that print and exit, as for the interpreters.
//
// What each table admits was read from each tool's own reference and, where one claim
// carries the decision, its source, the same day: docker exec/run (Docker CLI reference),
// kubectl exec (kubectl reference), mise exec (src/cli/exec.rs: the command needs `--` and
// is exec'd directly; only `-c` goes through a shell), direnv exec
// (internal/cmd/cmd_exec.go: `DIR COMMAND [...ARGS]`, run with syscall.Exec), devbox run
// (internal/devbox/devbox.go, below), uv run and uvx (uv CLI reference), npm exec, npx and
// npm config (npm docs).
const RUNS_ANY_COMMAND = 'broad';
const infoOnly = (info) => ({ info, any: true });
// The long informational forms alone: the short `-h`/`-V` are other options to too many of
// the tools this is used for (`tar -h` follows symlinks, `tar -V` is a volume label).
const LONG_INFO = new Set(['--version', '--help']);
// pflag clusters for docker: `-it`, `-dit`. `-u`/`--user` and `--privileged` are absent on
// purpose, so they are unknown and broad: one changes the identity the command runs as in
// the container, the other hands it the host's devices and capabilities, which is the
// reason sudo is broad at any depth (ALWAYS_BROAD_WRAPPERS). docker parses no option after
// the CONTAINER operand, so whatever follows it is the command.
//
// The environment the command gets (2026-10-14, the lead's decision on a finding of the same
// day): `-e`/`--env NAME=VALUE`, or a bare `-e NAME` that copies the caller's value, is read by
// `env` (envAssignmentIsUnsafe) and refused when NAME loads or names a program, as `["env",
// "LD_PRELOAD=x", "cat"]` is; a data-valued `-e FOO=bar` stays narrow. `--env-file` is absent,
// so broad, fused or not: the file's contents are unknowable when the prefix is reviewed, and
// any of its lines can be `LD_PRELOAD=...`. Not measured here (no container runtime is set up
// on the box); node's and uv's `--env-file` were, below.
const DOCKER_EXEC = {
  flags: ['-d', '-i', '-t', '--detach', '--interactive', '--tty'], flagPattern: /^-[dit]+$/,
  values: ['-e', '--env', '-w', '--workdir', '--detach-keys'],
  fused: /^(?:-[ew].|--(?:env|workdir|detach-keys)=)/, operands: 1,
  env: ['-e', '--env'], envFused: /^(?:-e|--env=)(.+)$/,
};
// `docker run IMAGE COMMAND`. Absent, so broad: `-v`/`--volume`/`--mount` (a bind mount of
// `/` makes the container root on the host), `--privileged`, `-u`/`--user`, `--entrypoint`
// (it replaces the program the prefix appears to name), and the namespace and capability
// switches (`--pid`, `--ipc`, `--userns`, `--uts`, `--network`, `--cap-add`, `--device`,
// `--security-opt`). `["docker", "run", "img"]` names no command and is broad: the next
// token can be any program in the image.
const DOCKER_RUN = {
  flags: ['-d', '-i', '-t', '--detach', '--interactive', '--tty', '--rm', '--init', '--read-only'],
  flagPattern: /^-[dit]+$/,
  values: ['-e', '--env', '-w', '--workdir', '--name', '-l', '--label', '--platform', '--pull',
    '-p', '--publish'],
  fused: /^(?:-[ewlp].|--(?:env|workdir|name|label|platform|pull|publish)=)/, operands: 1,
  env: DOCKER_EXEC.env, envFused: DOCKER_EXEC.envFused,                  // the environment, as for exec
};
// `docker compose exec|run SERVICE COMMAND`, with `-T` (no TTY) beside the docker flags.
const COMPOSE_EXEC = {
  flags: ['-d', '-i', '-t', '-T', '--detach', '--interactive', '--tty', '--no-TTY'], flagPattern: /^-[ditT]+$/,
  values: ['-e', '--env', '-w', '--workdir', '--index'], fused: /^(?:-[ew].|--(?:env|workdir|index)=)/, operands: 1,
  env: DOCKER_EXEC.env, envFused: DOCKER_EXEC.envFused,
};
const COMPOSE_RUN = {
  ...DOCKER_RUN, flagPattern: /^-[ditT]+$/,
  flags: [...DOCKER_RUN.flags, '-T', '--no-TTY', '--no-deps', '--service-ports', '--build', '--use-aliases',
    '--remove-orphans', '--quiet-pull'],
};
const DOCKER = {
  info: DEFAULT_INFO,
  sub: {
    exec: { exec: DOCKER_EXEC }, run: { exec: DOCKER_RUN },
    container: { sub: { exec: { exec: DOCKER_EXEC }, run: { exec: DOCKER_RUN } } },
    compose: { sub: { exec: { exec: COMPOSE_EXEC }, run: { exec: COMPOSE_RUN } } },
  },
};
// The standalone compose binaries take `docker compose`'s grammar (added 2026-10-13):
// `docker-compose`, which is the v1 Python CLI or, under the same name, the v2+ binary (the
// one on the development box reports "Docker Compose version v5.4.0" and documents `exec` as
// `docker compose exec [OPTIONS] SERVICE COMMAND [ARGS...]`, read that day), and
// podman-compose, which mirrors it. Until then neither was on any table, so a reviewed
// `["docker-compose", "exec", "web", "sh"]` rendered (measured against 3a451fd). Their global
// options (`-f`, `-p`, `--project-directory`, `--env-file`, `-H`) are not modelled, so any of
// them is broad, as it already is after `docker compose`.
const COMPOSE = { info: DEFAULT_INFO, sub: DOCKER.sub.compose.sub };
// kubectl parses its options anywhere before `--` (pflag, interspersed), so in `kubectl
// exec pod ls` a later `--as=system:admin`, `--context` or `-n kube-system` is kubectl's own:
// only `--` bounds the command, and the reference has deprecated the form without it.
// Absent, so broad: `--as`, `--as-group`, `--as-uid` (impersonation), `--user`, `--token`,
// `--kubeconfig`, `--context`, `--cluster` and `-s`/`--server` (who and where).
// `run`, `debug` and `attach` start a pod or debug container on a command line, or attach to
// a running process's stdin, and are not modelled: broad.
const KUBECTL = {
  info: DEFAULT_INFO,
  options: { values: ['-n', '--namespace'], fused: /^(?:-n.|--namespace=)/ },
  sub: {
    exec: { exec: {
      flags: ['-i', '-t', '-q', '--stdin', '--tty', '--quiet'], flagPattern: /^-[itq]+$/,
      values: ['-c', '--container', '-n', '--namespace', '-f', '--filename', '--pod-running-timeout'],
      fused: /^(?:-[cnf].|--(?:container|namespace|filename|pod-running-timeout)=)/, untilDashDash: true,
    } },
    run: RUNS_ANY_COMMAND, debug: RUNS_ANY_COMMAND, attach: RUNS_ANY_COMMAND,
  },
};
// `uvx` and `uv tool run`: fetch a tool by name and run it. `["uvx", "python"]` runs an
// interpreter (uv resolves `python` there), and the recursion refuses it like `["python"]`.
// `--env-file` is absent, so broad (2026-10-14, the env-file decision at DOCKER_EXEC): uv loads
// the file into the command's environment. MEASURED that day in a private temp directory, uv
// 0.12.2 offline: `uv run --no-project --env-file p.env python s.py`, p.env holding
// `PYTHONPATH=sc` and sc/sitecustomize.py writing a marker, wrote the marker; the same run
// without `--env-file` did not. `--no-env-file` (uv run) is a flag and stays.
const UVX_EXEC = {
  flags: ['--isolated', '-q', '--quiet', '-v', '--verbose', '--offline', '--no-cache', '-n', '--refresh',
    '--native-tls', '--no-config', '--no-progress', '--lfs', '--preview', '--managed-python', '--no-managed-python'],
  flagPattern: /^-[qvn]+$/,
  values: ['--from', '--with', '-w', '--with-editable', '--with-requirements', '--python', '-p', '--index',
    '--default-index', '--index-url', '-i', '--extra-index-url', '--find-links', '-f', '--cache-dir', '--color',
    '--config-file', '--directory', '--project', '--prerelease', '--resolution', '--exclude-newer',
    '--refresh-package', '--upgrade-package', '-P'],
  fused: /^(?:-[wpifP].|--(?:from|with|with-editable|with-requirements|python|index|default-index|index-url|extra-index-url|find-links|cache-dir|color|config-file|directory|project|prerelease|resolution|exclude-newer|refresh-package|upgrade-package)=)/,
};
// `uv run [OPTIONS] COMMAND`: the command runs in the project environment, directly.
// `-s`/`--script` marks the command as a script path, which the recursion then reads as one.
const UV_RUN = {
  ...UVX_EXEC,
  flags: [...UVX_EXEC.flags, '--no-project', '--all-extras', '--no-dev', '--frozen', '--locked', '--no-sync',
    '--no-env-file', '-s', '--script', '--gui-script', '--active', '--exact', '--all-packages', '--no-editable',
    '--only-dev', '--no-default-groups', '--all-groups', '--compile-bytecode'],
  flagPattern: /^-[qvns]+$/,
  values: [...UVX_EXEC.values.filter((value) => !['--from', '-w'].includes(value)), '--package', '--extra',
    '--group', '--only-group', '--no-group'],
  fused: /^(?:-[pifP].|--(?:with|with-editable|with-requirements|python|index|default-index|index-url|extra-index-url|find-links|cache-dir|color|config-file|directory|project|prerelease|resolution|exclude-newer|refresh-package|upgrade-package|package|extra|group|only-group|no-group)=)/,
  module: ['-m', '--module'],
};
const UV = {
  info: DEFAULT_INFO,
  options: {
    flags: ['-q', '--quiet', '-v', '--verbose', '--offline', '--no-cache', '-n', '--native-tls', '--no-config',
      '--no-progress', '--preview'], flagPattern: /^-[qvn]+$/,
    values: ['--directory', '--project', '--cache-dir', '--color', '--config-file'],
    fused: /^--(?:directory|project|cache-dir|color|config-file)=/,
  },
  sub: { run: { exec: UV_RUN }, tool: { sub: { run: { exec: UVX_EXEC } } } },
};
// npm reads its config options anywhere on the line (nopt), so these are walked at the top
// level and again after `run` or `exec`. Absent, so broad: `--script-shell` (the program
// every script runs through), `--node-options` (NODE_OPTIONS for every node a script starts,
// so `--require` anything), `--userconfig`/`--globalconfig` (a file that can set either),
// and `-c`/`--call` (a shell command line). A boolean option may be followed by `true` or
// `false`, which nopt takes as its value, hence `booleans`.
const NPM_OPTIONS = {
  booleans: true,
  flags: ['-g', '--global', '-s', '--silent', '-q', '--quiet', '-d', '-dd', '-ddd', '--ws', '--workspaces',
    '--include-workspace-root', '--if-present', '--ignore-scripts', '--json', '--offline', '--prefer-offline',
    '--prefer-online', '--no-audit', '--no-fund', '--force', '-f', '--legacy-peer-deps', '-y', '--yes', '--no',
    '--foreground-scripts', '--dry-run', '-D', '--save-dev', '-S', '--save', '-E', '--save-exact', '-O',
    '--save-optional', '--no-save', '-P', '--save-prod'],
  values: ['-C', '--prefix', '-w', '--workspace', '--loglevel', '--cache', '--registry', '--tag', '--omit',
    '--include', '--before'],
  fused: /^--(?:prefix|workspace|loglevel|cache|registry|tag|omit|include|before)=/,
};
const NPM_EXEC = {
  ...NPM_OPTIONS, values: [...NPM_OPTIONS.values, '--package'],
  fused: /^--(?:prefix|workspace|loglevel|cache|registry|tag|omit|include|before|package)=/,
};
// npx is npm exec. `-p` is `--package` here (it is `--parseable` elsewhere in npm).
const NPX_EXEC = {
  flags: ['-y', '--yes', '--no', '-q', '--quiet', '--ws', '--workspaces', '--include-workspace-root',
    '--prefer-offline', '--offline', '--prefer-online'],
  values: ['-p', '--package', '-w', '--workspace', '--registry', '--cache'],
  fused: /^--(?:package|workspace|registry|cache)=/,
};
// GNU make. A cluster of no-value letters may end in a value letter (`-kC dir`, `-kCdir`);
// `-j` and `-l` take an optional number; `NAME=VALUE` overrides a variable and names no
// target. Absent, so broad: `-E`/`--eval`, which evaluates its argument as makefile text,
// rules and recipes included.
//
// A variable override is judged since 2026-10-14 (`unsafeVariable`). GNU make reads ANY argument
// holding `=` as a variable definition with the makefile's own operators (`=`, `:=`, `::=`,
// `:::=`, `+=`, `?=`, `!=`), and a command-line definition overrides the makefile's (GNU make
// manual, "Overriding Variables"). So a prefix is broad when an override:
//   * uses `!=`, the shell assignment, which runs its value as a command while the line is read;
//   * sets the variable that chooses what runs every recipe line: SHELL (the shell program),
//     .SHELLFLAGS (its arguments, `-c` by default), MAKESHELL (the Windows and MS-DOS
//     spelling), or what make reads as more options or makefiles: MAKEFLAGS, MFLAGS,
//     MAKEFILES;
//   * names a variable that loads or names a program (envNameIsUnsafe: CC, MAKE, PATH,
//     LD_PRELOAD, ...), because make exports a command-line variable to every recipe's
//     environment. This makes `["make", "CC=gcc", "all"]` broad, which rendered until then: a
//     decision, the one 520103d made for `Bash(CC=gcc make *)`.
// A data override (`CFLAGS=-O2`, `V=1`) stays narrow. Until then the override test matched only
// `NAME=` with a C identifier, so `.SHELLFLAGS=...` and `X!=...` read as TARGET names: `["make",
// "SHELL=./x.sh", "test"]`, `["make", ".SHELLFLAGS=-ec", "test"]` and `["make", "X!=cmd", "all"]`
// rendered (measured against c16728e). No make is installed on the box, so this rests on the
// manual, not a run.
//
// AND THE PROGRAMS make's own rules run (2026-10-14, F6 of the v1.6.3 confirmation audit). The
// override test above refused CC, CXX and MAKE, by way of envNameIsUnsafe, and let every other
// program variable through: `["make", "AR=./x", "lib"]`, `["make", "RM=./x", "clean"]` and
// `["make", "COMPILE.c=./x", "all"]` rendered, and each runs ./x wherever a rule runs that
// variable, which make's built-in rules do with no line of the makefile naming it. By the
// principle at the top of this file a variable that names a program makes the prefix broad, so:
//   * MAKE_PROGRAM_VARIABLES, every program GNU make's built-in variable table defines outside
//     VMS (src/default.c, `default_variables`, read from the GNU make source mirror at c63a5bc,
//     2026-10-14): the manual's "Variables Used by Implicit Rules" list (AR AS CC CXX CPP FC M2C
//     PC CO GET LEX YACC LINT MAKEINFO TEX TEXI2DVI WEAVE CWEAVE TANGLE CTANGLE RM) plus the three
//     it defines and the manual's list leaves out: LD (`ld`; the manual does not list it, the
//     table does), OBJC and F77. Then the GNU Coding Standards' program variables ("Utilities in
//     Makefiles": $(AR) $(BISON) $(CC) $(FLEX) $(INSTALL) $(LD) $(LDCONFIG) $(LEX) $(MAKE)
//     $(MAKEINFO) $(RANLIB) $(TEXI2PDF) $(YACC); "Variables for Specifying Commands": INSTALL,
//     INSTALL_PROGRAM, INSTALL_DATA; read from gnulib's doc/make-stds.texi the same day). Those
//     are conventions, not make's own, and are here because a makefile written to the standard
//     runs them for exactly the targets a reviewed prefix names (`install`): a convention that
//     common is a variable that names a program in nearly every makefile that has it.
//   * MAKE_COMMAND_VARIABLE, the whole command lines the built-in rules run (the same table:
//     COMPILE.c, LINK.o, PREPROCESS.S, LEX.l, YACC.y, LINT.c, ... and CHECKOUT,v). Overriding one
//     replaces the command a rule runs outright.
// Matched exactly until L1 (below), as make's variable names are case-sensitive. Not refused, on
// purpose: the flags variables (CFLAGS, LDFLAGS, ARFLAGS, ...) and the install locations (PREFIX,
// DESTDIR, prefix, bindir, ...), which the same table and standard define as data, and any variable a
// makefile defines for itself, which is the makefile's own code, as a target's recipe is. just
// gains nothing here: it has no built-in variables and no implicit rules, and an override of a
// variable the justfile does not declare is an error (MEASURED, just 1.58.0, 2026-10-14: `just
// PYTHON=python3 build` and `just CC=evil build` both stop with "overridden on the command line
// but not present in justfile"), so what a justfile's PYTHON runs is the justfile's own code.
// J1 (the same day) changes the just half for a different reason: a just override is an
// ENVIRONMENT carrier under `set export`, judged as such (JUST below), and the Codex export's
// environment judgment now holds the build programs, so `["just", "AR=x", "build"]`, which F6
// left rendering, is broad: under `set export` it is `env AR=x` for every recipe, and a recipe
// that runs make then runs x. `["just", "PYTHON=python3", "test"]` still renders.
//
// FOLDED SINCE L1 (2026-10-14, the lead's decision, reversing F6's and K1's exact match here). A
// make or just override is judged by codexFoldedEnvNameIsUnsafe, the environment readers' check,
// because it is an environment assignment as well as a variable. GNU make "exports a variable
// only if it is either defined in the environment initially or if set on the command line and its
// name consists only of letters, numbers, and underscores", and "adds the variable and its value
// to the environment for running each line of the recipe" (the GNU make manual, "Communicating
// Variables to a Sub-make", read 2026-10-14). just does the same under `set export`: MEASURED with
// just 1.58.0 in a private temp directory, a justfile with `set export` and `node_options := ""`
// whose recipe runs node ran y.js under `just node_options=--require=./y.js r`, and node saw
// NODE_OPTIONS set. A native Windows child reads its environment case-insensitively (K1, at
// codexFoldedEnvNameIsUnsafe), so `make cc=x all` hands every recipe line a variable a child
// reading CC sees, though make's own `$(CC)` is untouched. Refusing it is the safe failure, so
// F6's pinned `["make", "cc=x", "all"]` is broad now. Data overrides still render in any case
// (`prefix=`, `PREFIX=`, `DESTDIR=`, `CFLAGS=`, `cflags=`, `VERBOSE=`, `V=`): the fold reaches
// only the program, code-loading and configuration sets. It also refuses a dotted spelling such
// as `compile.c=` or `.shellflags=`, which make neither reads as the built-in variable nor
// exports; that over-refusal is the cost of one predicate, and the safe direction.
const MAKE_SHELL_VARIABLES = new Set(['SHELL', '.SHELLFLAGS', 'MAKESHELL', 'MAKEFLAGS', 'MFLAGS', 'MAKEFILES']);
const MAKE_PROGRAM_VARIABLES = new Set([
  'AR', 'AS', 'CC', 'OBJC', 'CXX', 'CO', 'CPP', 'FC', 'F77', 'GET', 'LD', 'LEX', 'LINT', 'M2C', 'PC', 'YACC',
  'MAKEINFO', 'TEX', 'TEXI2DVI', 'WEAVE', 'CWEAVE', 'TANGLE', 'CTANGLE', 'RM',
  'BISON', 'FLEX', 'INSTALL', 'INSTALL_PROGRAM', 'INSTALL_DATA', 'LDCONFIG', 'RANLIB', 'TEXI2PDF',
]);
const MAKE_COMMAND_VARIABLE = /^(?:(?:COMPILE|LINK|PREPROCESS|LEX|YACC|LINT)\.[A-Za-z]+|CHECKOUT,v)$/;
const MAKE = {
  info: DEFAULT_INFO,
  target: {
    // A name holds no whitespace, `:`, `#` or `=`; spaces may surround it (`SHELL := x`).
    assignments: /^\s*([^\s:#=]*?)\s*([:+?!]*)=/,
    // codexEnvNameIsUnsafe is MAKE_SHELL_VARIABLES, MAKE_PROGRAM_VARIABLES, MAKE_COMMAND_VARIABLE
    // and envNameIsUnsafe, which this line named one by one until J1, plus cargo's program names
    // (a command-line variable reaches every recipe's environment, see above); folded since L1.
    unsafeVariable: (name, operator) => operator.includes('!') || codexFoldedEnvNameIsUnsafe(name),
    scanAll: true,
    flags: ['--always-make', '--environment-overrides', '--ignore-errors', '--keep-going', '--no-keep-going',
      '--stop', '--just-print', '--dry-run', '--recon', '--print-data-base', '--question', '--no-builtin-rules',
      '--no-builtin-variables', '--silent', '--quiet', '--no-silent', '--touch', '--trace', '--print-directory',
      '--no-print-directory', '--warn-undefined-variables', '--check-symlink-times', '--debug', '--output-sync',
      '--shuffle'],
    flagPattern: /^-[bBdeikLmnpqrRsStw]+$/,
    values: ['--directory', '--file', '--makefile', '--include-dir', '--old-file', '--assume-old', '--what-if',
      '--new-file', '--assume-new'],
    valuePattern: /^-[bBdeikLmnpqrRsStw]*[CfIoW]$/,
    optionalNumber: ['-j', '-l', '--jobs', '--load-average', '--max-load'],
    fused: /^(?:-[bBdeikLmnpqrRsStw]*[CfIoW].|-j\d+|-l[\d.]+|-O\w*|--(?:directory|file|makefile|include-dir|old-file|assume-old|what-if|new-file|assume-new|jobs|load-average|max-load|output-sync|debug|shuffle|jobserver-style)=)/,
  },
};
// just. `--set NAME VALUE` takes two tokens. Absent, so broad: `-c`/`--command` (runs a
// command), `--shell`, `--shell-arg` and `--shell-command` (they choose what runs every
// recipe line), `--chooser`/`--choose` (a chooser command run through a shell), and the
// modes that run no named recipe (`--evaluate`, which runs the justfile's backticks,
// `--edit`, `--list`, `--fmt`, `--init`, `--show`, ...). Also absent since 2026-10-14, by the
// env-file decision at DOCKER_EXEC: `--dotenv-filename`, `-E`/`--dotenv-path`, which name the
// environment file every recipe line runs under. Not measured (the decision is about what a
// reviewer cannot see, not about one tool's behavior); `--no-dotenv` stays a flag.
//
// The shell options stay absent, now MEASURED (just 1.58.0, private temp directory, 2026-10-14):
// `--shell pwsh --shell-arg ...` ran the recipe under pwsh, and `--dotenv-command "pwsh -File
// s.ps1"` (1.58's option to load a command's output as the environment) ran s.ps1, which wrote
// its marker. A variable override, `NAME=VALUE` or `--set NAME VALUE`, is judged by
// envNameIsUnsafe since the same day (codexEnvNameIsUnsafe since J1, which adds the build
// programs, and folded since L1, MAKE above): under `set export` it reaches every recipe's environment,
// and `just NODE_OPTIONS=--require=./y.js build` (NODE_OPTIONS declared in the justfile) ran y.js,
// measured. just overrides only variables the justfile declares, and no variable chooses the
// shell, so a data override stays narrow.
const JUST = {
  info: DEFAULT_INFO,
  target: {
    assignments: /^([A-Za-z_][A-Za-z0-9_-]*)()=/,
    unsafeVariable: (name) => codexFoldedEnvNameIsUnsafe(name),
    flags: ['-n', '--dry-run', '-q', '--quiet', '-v', '--verbose', '-u', '--unsorted', '--no-deps', '--no-dotenv',
      '--yes', '--highlight', '--no-highlight', '--unstable', '--timestamp', '--explain', '-g', '--global-justfile'],
    flagPattern: /^-v+$/,
    values: ['-f', '--justfile', '-d', '--working-directory', '--color', '--timestamp-format'],
    values2: ['--set'],
    fused: /^(?:-[fd].|--(?:justfile|working-directory|color|timestamp-format)=)/,
  },
};
const MISE_RUN = {
  flags: ['-f', '--force', '-n', '--dry-run', '-r', '--raw', '--timings', '--no-timings', '-q', '--quiet', '-S',
    '--silent', '--no-cache', '--no-prepare'],
  values: ['-j', '--jobs', '-o', '--output'], fused: /^(?:-j\d+|--(?:jobs|output)=)/,
};
// `mise exec [TOOL@VERSION]... -- COMMAND`: positionals before `--` are tools, not the
// command, and the command is exec'd directly (src/cli/exec.rs). `-c`/`--command` takes a
// shell command line and is absent.
const MISE_EXEC = {
  untilDashDash: true,
  flags: ['--raw', '--fresh-env', '--no-deps', '--deny-all', '--deny-env', '--deny-net', '--deny-read', '--deny-write'],
  values: ['-j', '--jobs', '--allow-env', '--allow-net', '--allow-read', '--allow-write'],
  fused: /^(?:-j\d+|--(?:jobs|allow-env|allow-net|allow-read|allow-write)=)/,
};
const PNPM_OPTIONS = {
  flags: ['-r', '--recursive', '-w', '--workspace-root', '-s', '--silent', '--parallel', '--stream'],
  values: ['-C', '--dir', '-F', '--filter', '--filter-prod'], fused: /^(?:-[CF].|--(?:dir|filter|filter-prod)=)/,
};
// git's own options, before its subcommand (decided 2026-10-13). In git a configuration
// VALUE is a command: `core.fsmonitor`, `core.pager`, `core.sshCommand`, `core.editor`,
// `diff.external`, `credential.helper`, `gpg.program`, `alias.NAME=!...` and `core.hooksPath`
// each name a program git runs, so `-c NAME=VALUE` hands the prefix's continuation a program
// to run, and `--config-env NAME=ENVVAR` does the same with the value taken from the
// environment. MEASURED 2026-10-13, git 2.55.0, in a private temp repository: `git -c
// core.fsmonitor='echo PWNED >&2; exit 1 #' status --short` printed PWNED (status, the
// subcommand AUTO_SAFE_GIT_SUBCOMMANDS trusts most), and so did `git -c alias.zz='!echo
// PWNED' zz` and `Z='!echo PWNED' git --config-env=alias.zz=Z zz`. `--exec-path=DIR` is the
// same class: it chooses the directory git runs its helper programs from (bare
// `--exec-path` only prints it). Until then nothing on the reviewed Codex path looked at a git
// prefix: `["git", "-c", "core.fsmonitor=x", "status"]` rendered, and so did bare `["git"]`,
// which the validator flags only after rendering (measured against 3a451fd).
//
// So `-c`, `--config-env` and `--exec-path=` are deliberately absent below: unknown, so broad,
// fused or not, wherever they sit before the subcommand. The walk is the RUNNER_GRAMMAR
// dispatcher's (runnerIsBroad), which also makes a prefix that ENDS in global options broad:
// `["git", "-C", "dir"]` and `["git", "--no-pager"]` have named no subcommand and admit `git -C
// dir -c core.pager=CMD log`. `-C`, `--git-dir`, `--work-tree`, `--namespace` and
// `--attr-source` take a value that is a path, not a program: they choose which repository,
// and so which repository config, git reads, which `cd dir && git status` does too, so
// `["git", "-C", "dir", "status"]` is exactly as narrow as `["git", "status"]`. After the
// subcommand every word is the subcommand's (`git commit -c HEAD` reuses a message, `git grep
// -c` counts), so no `-c` there is judged. Not covered, and recorded: a subcommand's own
// command-valued options. MEASURED the same day: `git grep -O'echo PWNED #' -e foo` and `git
// grep --open-files-in-pager=CMD foo` run CMD through a shell (`git grep foo -O...` is refused
// by git: options must precede the pattern), and grep is in SAFE_GIT_READ_SUBCOMMANDS, so the
// reviewed `Bash(git grep *)` and `["git", "grep"]` admit it; `rebase -x`, `bisect run`,
// `submodule foreach`, `difftool -x` and `fetch --upload-pack` are the write-side cases.
//
// git is not a RUNNER_GRAMMAR root, because membership there refuses every prefix of the root
// on the automatic path and `["git", "status"]` is auto-safe; wrapperIsBroad and
// candidateEligibleForCodex consult this node by name instead. The Claude side needed nothing:
// claudePermissionIsSafe already requires a SAFE_GIT_READ_SUBCOMMANDS word right after `git`,
// so `Bash(git -c x=y status *)` and `Bash(git -C dir status *)` were refused before this.
const GIT = {
  info: new Set([...DEFAULT_INFO, '-v']),
  options: {
    flags: ['-p', '--paginate', '-P', '--no-pager', '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks',
      '--no-advice', '--bare', '--html-path', '--man-path', '--info-path', '--exec-path', '--literal-pathspecs',
      '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs'],
    values: ['-C', '--git-dir', '--work-tree', '--namespace', '--attr-source'],
    fused: /^--(?:git-dir|work-tree|namespace|attr-source|list-cmds)=/,
  },
  sub: {},
};
const RUNNER_GRAMMAR = new Map(Object.entries({
  // ssh hands its arguments to the remote login shell as one command line, so naming a
  // command narrows nothing, and the remote host is outside anything a prefix can bound.
  // `-V` alone is narrow (2026-10-14): OpenSSH prints its version and exits inside its option
  // loop, so `ssh -V -o ProxyCommand='sh -c "echo X>s1.txt"' example.invalid` wrote nothing
  // (measured, OpenSSH_10.3p1). `--version` is not an ssh option. On the Claude side ssh stays
  // refused at any depth as a NETWORK_OR_INSTALL_ROOTS member.
  ssh: infoOnly(new Set(['-V'])),
  direnv: { info: DEFAULT_INFO, sub: { exec: { exec: { operands: 1 } } } },
  // devbox runs an ad-hoc command through `eval`: internal/devbox/devbox.go RunScript
  // (jetify-com/devbox main, read 2026-10-13) sets `env["DEVBOX_RUN_CMD"] =
  // strings.Join(append([]string{runCmd}, cmdArgs...), " ")` after `cmdArgs[idx] =
  // strconv.Quote(arg)`, and the generated script body is `eval $DEVBOX_RUN_CMD`. Go's
  // double quotes do not stop `$(...)`, backticks or `$VAR` in a POSIX shell, so `["devbox",
  // "run", "npm", "test"]` admits `devbox run npm test '$(rm -rf .)'`. A devbox.json script
  // is run from a joined command line too. Broad at any depth, like watch; `shell` and
  // `global` (whose own `run` is the same) likewise.
  devbox: { info: DEFAULT_INFO, sub: { run: RUNS_ANY_COMMAND, shell: RUNS_ANY_COMMAND, global: RUNS_ANY_COMMAND } },
  // `mise watch` drives watchexec with options this module does not model: refused, not guessed.
  mise: {
    info: DEFAULT_INFO,
    sub: { exec: { exec: MISE_EXEC }, x: { exec: MISE_EXEC }, run: { target: MISE_RUN }, r: { target: MISE_RUN },
      watch: RUNS_ANY_COMMAND },
  },
  uv: UV,
  uvx: { info: DEFAULT_INFO, exec: UVX_EXEC },
  // poetry's own options after `run` are not modelled, so any of them is broad. `shell` starts one.
  poetry: {
    info: DEFAULT_INFO,
    options: {
      flags: ['-q', '--quiet', '-v', '-vv', '-vvv', '--verbose', '-n', '--no-interaction', '--no-plugins',
        '--no-cache', '--ansi', '--no-ansi'],
      values: ['-C', '--directory', '-P', '--project'], fused: /^--(?:directory|project)=/,
    },
    sub: { run: { exec: {} }, shell: RUNS_ANY_COMMAND },
  },
  pipx: {
    info: DEFAULT_INFO,
    sub: { run: { exec: {
      flags: ['--no-cache', '--pypackages', '-v', '--verbose', '-q', '--quiet', '-e', '--editable', '--system-site-packages'],
      values: ['--spec', '--python', '--index-url', '-i', '--pip-args', '--backend'],
      fused: /^--(?:spec|python|index-url|pip-args|backend)=/,
    } } },
  },
  // `npm init <initializer>` is `npm exec create-<initializer>` (npm docs, init), so it needs
  // its target like `run`. `explore` spawns a shell in the package directory.
  npm: {
    info: DEFAULT_INFO, options: NPM_OPTIONS,
    sub: {
      exec: { exec: NPM_EXEC }, x: { exec: NPM_EXEC },
      run: { target: NPM_OPTIONS }, 'run-script': { target: NPM_OPTIONS }, rum: { target: NPM_OPTIONS },
      urn: { target: NPM_OPTIONS }, init: { target: NPM_OPTIONS }, create: { target: NPM_OPTIONS },
      innit: { target: NPM_OPTIONS }, explore: RUNS_ANY_COMMAND,
    },
  },
  npx: { info: DEFAULT_INFO, exec: NPX_EXEC },
  // pnpm and yarn run a word that is neither one of their commands nor a script as a package
  // bin (`pnpm jest`), hence `fallback: 'exec'`. pnpm's `-c`/`--shell-mode` (a shell) is
  // absent from every pnpm table. Yarn's `exec` runs its arguments as a script in Yarn's
  // portable shell, and `workspace`/`workspaces` re-dispatch a whole yarn command line.
  pnpm: {
    info: DEFAULT_INFO, options: PNPM_OPTIONS, fallback: 'exec',
    sub: {
      exec: { exec: { ...PNPM_OPTIONS, flags: [...PNPM_OPTIONS.flags, '--no-bail', '--report-summary', '--reverse'],
        values: [...PNPM_OPTIONS.values, '--resume-from'] } },
      dlx: { exec: { flags: ['-s', '--silent'], values: ['--package', '--allow-build'], fused: /^--(?:package|allow-build)=/ } },
      run: { target: PNPM_OPTIONS }, 'run-script': { target: PNPM_OPTIONS }, create: { target: PNPM_OPTIONS },
    },
  },
  yarn: {
    info: DEFAULT_INFO, fallback: 'exec',
    options: { flags: ['-s', '--silent'], values: ['--cwd'], fused: /^--cwd=/ },
    sub: {
      exec: RUNS_ANY_COMMAND, workspace: RUNS_ANY_COMMAND, workspaces: RUNS_ANY_COMMAND,
      dlx: { exec: { flags: ['-q', '--quiet'], values: ['-p', '--package'], fused: /^--package=/ } },
      // berry's `run` runs a script, or else a bin of that name, so it is judged as a command
      run: { exec: {} }, create: { target: {} },
    },
  },
  docker: DOCKER, podman: DOCKER,
  // nerdctl is containerd's Docker-compatible CLI, with the same `exec`, `run`, `container
  // exec|run` and `compose exec|run` forms; its global options (`--namespace`, `--address`,
  // `--snapshotter`) are not modelled and so are broad. Added 2026-10-13 with the compose
  // binaries (COMPOSE above).
  nerdctl: DOCKER, 'docker-compose': COMPOSE, 'podman-compose': COMPOSE,
  kubectl: KUBECTL,
  // flatpak (M1, 2026-10-14): `flatpak run APP` runs a sandboxed application, where `--command=COMMAND`
  // picks the binary to run instead of the app's own and `--filesystem=host` escapes the sandbox
  // (docs.flatpak.org, flatpak run, read 2026-10-14), so `run` is broad at any depth; a fixed
  // subcommand such as `flatpak list` or `flatpak info` is narrow, and the exact `--version`/`--help`
  // forms render. (flatpak-spawn, which runs a command in another sandbox, is a further candidate,
  // recorded not implemented: docs/engineering-record.md, M1.)
  flatpak: { info: DEFAULT_INFO, sub: { run: RUNS_ANY_COMMAND } },
  make: MAKE, just: JUST,
  // Tools whose option VALUE is a program to run, read anywhere on the line, so no prefix of
  // them can be narrow (added 2026-10-13). A prefix rule admits every continuation, and each
  // of these reads such an option after operands as well as before them:
  //   * rsync: `-e`/`--rsh COMMAND` is the remote shell it starts (rsync(1); also
  //     `--rsync-path`), and its option parser takes options after the paths, so `["rsync",
  //     "-a"]` admits `rsync -a -e 'CMD' src host:dst`. Not measured: no rsync on the box.
  //   * scp and sftp: `-S PROGRAM` is the transport they run, `-o ProxyCommand=CMD` and `-F
  //     FILE` hand ssh a local command, and sftp's `-D COMMAND` runs a local sftp server.
  //     MEASURED 2026-10-13 with OpenSSH_10.3p1: `scp -S ./x.sh g example.invalid:x` ran
  //     x.sh, and `sftp -D ./x.sh` ran it too. Both were already refused on the Claude side
  //     (NETWORK_OR_INSTALL_ROOTS); ssh itself is the entry at the top of this table.
  //   * tar: `--to-command=CMD`, `-I`/`--use-compress-program=PROG`,
  //     `--checkpoint-action=exec=CMD`, `-F`/`--info-script`/`--new-volume-script`,
  //     `--rsh-command` and a remote `-f host:archive`, which GNU tar reads after operands.
  //     MEASURED 2026-10-13 with GNU tar 1.35: `tar -cf a.tar g --checkpoint=1
  //     --checkpoint-action=exec='echo PWNED'` and `tar -xf a.tar --to-command='echo PWNED'`
  //     each printed PWNED, so even `["tar", "-tf", "a.tar"]` admits a program. (Windows'
  //     bsdtar 3.8.8 stops options at the first operand, measured the same day; which tar a
  //     prefix will meet is unknowable here, so the stricter reading wins.)
  //   * find and fd: `-exec`, `-execdir`, `-ok` and `-okdir` (find), `-x`/`--exec` and
  //     `-X`/`--exec-batch` (fd, measured the same day: `fd zz dir -x echo PWNED` ran echo)
  //     come after the paths, which is where every prefix ends. `fdfind` is Debian's name.
  //     Claude Code itself will not auto-approve `find` with an action through a prefix rule
  //     (docs/claude-code-permissions.md, "Exec wrappers and `find` actions"), so on the
  //     Claude side this refusal is belt and braces. It is kept because that guard is one
  //     harness version's documented behavior, fd has none, and it costs nothing measured:
  //     the learner never proposes a multi-token find rule (find is no family root), and 0 of
  //     the development box's 581 allow entries changed verdict.
  // Until this, each rendered as a reviewed Codex prefix_rule, bare included, and every
  // multi-token one but scp's and sftp's rendered as a reviewed Claude rule too (`Bash(tar
  // -xf *)`, `Bash(find . *)`, `Bash(rsync -a *)`), measured against 3a451fd. RUNS_ANY_COMMAND
  // refuses both, and the recursion carries it through every wrapper (`["xargs", "tar"]`).
  //
  // Except, since 2026-10-14, the exact long informational forms of tar, find and fd, on both
  // halves (infoOnly(LONG_INFO)). Each prints and exits before it reads the option that would
  // run something, MEASURED that day with a marker-file payload whose control run (the same
  // line without the informational word) did write the marker: `tar --version -cf a.tar g
  // --checkpoint=1 --checkpoint-action=exec='sh -c "echo X>r1.txt"'` and the `--help` twin
  // (GNU tar 1.35; neither wrote a.tar either), `find --version . -exec sh -c '...' ';'` and
  // `--help` (GNU findutils 4.10.0), `fd --version g -x sh -c '...'` (fd 10.4.2). The short
  // forms are not informational here: `tar -h` dereferences symlinks and `tar -V` names a
  // volume. Not opened: rsync (not measured, there is none on the box), scp and sftp (they
  // have no informational option: `scp -V` is "unknown option", measured).
  rsync: RUNS_ANY_COMMAND, scp: RUNS_ANY_COMMAND, sftp: RUNS_ANY_COMMAND, tar: infoOnly(LONG_INFO),
  find: infoOnly(LONG_INFO), fd: infoOnly(LONG_INFO), fdfind: infoOnly(LONG_INFO),
  // Runners whose arguments are commands or code wherever they sit, so naming one narrows
  // nothing (2026-10-14). Until then all three had only the generic ends-in-an-option rule at
  // the bottom of wrapperIsBroad, so `["hyperfine", "echo SAFE"]`, `["duckdb", "x.db"]` and
  // `["wsl", "ls"]` each rendered as a reviewed prefix_rule (measured against 4a02252). Each
  // was refused BARE since edb59ed and refused at any depth on the Claude side by membership;
  // only the Codex half narrowed them. MEASURED 2026-10-14 in a private temp directory with
  // harmless payloads that write a marker file:
  //   * hyperfine 1.20.0: every positional is a command to benchmark, so `hyperfine --runs 1
  //     -N 'cmd /c echo SAFE' 'cmd /c echo SECOND>m1.txt'` wrote m1.txt; `--prepare`, `--setup`,
  //     `--cleanup`, `--conclude` and `-S`/`--shell` are commands too. Its four informational
  //     forms are exact and inert: `hyperfine --version 'cmd /c echo X>m2.txt'`, `--help`, `-V`
  //     and `-h`, and `--version --setup '...' '...'`, wrote nothing (clap exits while parsing).
  //   * duckdb v1.5.5: `duckdb x.db ".shell cmd /c echo PWNED>d1.txt"` wrote d1.txt. And NO form
  //     of it is inert: `-version`, `--version`, `--help` and `-h` each exit before a trailing
  //     `.shell` argument runs, but `duckdb -version -init init1.sql`, with `.shell` in the init
  //     file, ran it before printing the version, as did `--version`, `--help` and `-h` (the
  //     sqlite3-derived shell reads `-init` in its first argument pass and runs the file before
  //     the second pass reaches `-version`). So `["duckdb", "--version"]`, which the generic
  //     rule's info exception rendered, admits a program too, and duckdb has no exception.
  //   * wsl 2.7.12: a command line after `wsl` runs in the distribution's login shell, `--`
  //     hands the rest over as-is, `-u`/`--user` picks the identity, and `-e`/`--exec` alone
  //     skips the shell. The `--exec` form could not be measured (this box has no distribution
  //     installed), and the learner never hands over a wsl prefix deeper than its informational
  //     forms, so a bounded exec form would buy no grant: broad. `wsl --version echo SAFE`
  //     printed the version and ran nothing (with no distribution, an attempt would have
  //     failed loudly), and `--help` likewise, so those two exact forms stay narrow.
  hyperfine: infoOnly(DEFAULT_INFO), duckdb: RUNS_ANY_COMMAND, wsl: infoOnly(LONG_INFO),
}));

// Short names that ARE a longer command line, judged as that command line (2026-10-14).
// `bunx` is `bun x` (bun's npx; INTERPRETER_GRAMMAR's bun entry judges it by the command it
// names) and `pnpx` is `pnpm dlx` (pnpm 7 and later; pnpm 6's pnpx was npx-like, the same
// runner-exec shape). Neither was on any table, so a reviewed bare `["bunx"]` or `["pnpx"]` and
// `["bunx", "sh"]`, `["pnpx", "sh"]` rendered (measured against e6d227c), each a grant to run
// any package bin or any program. Now `["bunx"]` is `["bun", "x"]`, broad until a command is
// named, and `["pnpx", "create-vite"]` is `["pnpm", "dlx", "create-vite"]`, narrow. Both are
// OWN_SHELL_WRAPPERS too, so the Claude half refuses them at any depth as it refuses bun and
// pnpm, and the learner lists them as wrappers.
//
// `dx` is `deno x` (added later the same day): `deno x --install-alias` "Creates a dx alias so
// you can run dx <command> instead of deno x <command>" (deno 2.9.5's help). It is an
// OWN_SHELL_WRAPPERS entry only, not a learner one, because the name is also Android's old
// dex tool, and on this exporter's side refusing that one too is the safe failure.
const RUNNER_ALIASES = new Map([['bunx', ['bun', 'x']], ['pnpx', ['pnpm', 'dlx']], ['dx', ['deno', 'x']]]);

// The index of the first token at or after `k` that is not one of `grammar`'s options, or
// -1 at an option it does not list. `grammar` may be undefined: nothing is modelled, so
// any option is unknown.
function skipRunnerOptions(grammar, tokens, k) {
  const flags = new Set(grammar?.flags || []);
  const values = new Set(grammar?.values || []);
  for (; k < tokens.length; k += 1) {
    const token = tokens[k];
    if (!token.startsWith('-')) return k;
    if (flags.has(token) || grammar?.flagPattern?.test(token)) {
      if (grammar.booleans && ['true', 'false'].includes(tokens[k + 1])) k += 1;
      continue;
    }
    if (values.has(token)) { k += 1; continue; }
    if (grammar?.fused?.test(token)) continue;
    return -1;
  }
  return k;
}

// A task runner's options, then the target. True (broad) when the prefix ends before one
// is named, or at an option the grammar does not list.
//
// `assignments` (a pattern capturing the variable name and the operator) and `unsafeVariable`
// judge a variable override (2026-10-14, MAKE and JUST above): one that names a shell or a
// program makes the prefix broad, a data override is skipped. `scanAll` is make's: GNU make
// permutes its options and reads overrides anywhere on the line, so the walk does not stop at
// the first target there but judges every token the prefix carries, and `["make", "test",
// "SHELL=./x.sh"]` or `["make", "test", "--eval=x"]` is as broad as with the token before the
// target. Until then the walk returned at the target and both rendered (measured against
// c16728e). Elsewhere (just, `npm run`, `mise run`, `pnpm run`) the tokens after the target are
// the recipe's or script's arguments and stay unread.
function targetIsBroad(grammar, rest) {
  const flags = new Set(grammar.flags || []);
  const values = new Set(grammar.values || []);
  let dashDash = false;
  let named = false;
  for (let k = 0; k < rest.length; k += 1) {
    const token = rest[k];
    if (!dashDash && token === '--') { dashDash = true; continue; }
    if (dashDash || !token.startsWith('-') || token === '-') {
      const assignment = grammar.assignments?.exec(token);
      if (assignment) {
        if (grammar.unsafeVariable?.(assignment[1], assignment[2])) return true;   // names a shell or a program
        continue;
      }
      if (!grammar.scanAll) return false;                                 // a named target
      named = true; continue;
    }
    if (flags.has(token) || grammar.flagPattern?.test(token)) continue;
    if (grammar.optionalNumber?.includes(token)) {
      if (/^\d+(?:\.\d+)?$/.test(rest[k + 1] ?? '')) k += 1;
      continue;
    }
    if (values.has(token) || grammar.valuePattern?.test(token)) { k += 1; continue; }
    if (grammar.values2?.includes(token)) {
      if (grammar.unsafeVariable?.(String(rest[k + 1] ?? ''), '')) return true;  // `--set NAME VALUE`
      k += 2; continue;
    }
    if (grammar.fused?.test(token)) continue;
    return true;                                                          // an option this table does not know
  }
  return !named;
}

function runnerIsBroad(node, rest) {
  if (node === RUNS_ANY_COMMAND) return true;
  if (rest.length === 1 && node.info?.has(rest[0])) return false;
  if (node.any) return true;                                              // infoOnly: nothing else narrows it
  if (node.exec) {
    const inner = execWrapperInner(node.exec, ['', ...rest]);
    return inner === null || inner.length === 0 || wrapperIsBroad(inner);
  }
  if (node.target) return targetIsBroad(node.target, rest);
  const at = skipRunnerOptions(node.options, rest, 0);
  if (at < 0 || at >= rest.length) return true;                          // no subcommand located
  if (Object.hasOwn(node.sub, rest[at])) return runnerIsBroad(node.sub[rest[at]], rest.slice(at + 1));
  return node.fallback === 'exec' ? wrapperIsBroad(rest.slice(at)) : false;
}

// The Claude half (claudePermissionIsSafe). A rule that reaches a runner-exec form is
// refused at ANY depth, the decision 64b4eaa made for every wrapper: `Bash(uv run pytest *)`
// would need the inner command judged by this module's Claude tables, which hold `rm` and
// `git push` to a stricter line than a reviewed Codex prefix, so the runner's own membership
// decides, as `Bash(npx tsc *)` and `Bash(timeout 5 rg *)` already are. A task runner's
// rule is refused only while it names no target (`Bash(mise run *)`); a fixed subcommand
// (`Bash(docker ps *)`, `Bash(uv sync *)`, `Bash(kubectl get *)`) is untouched.
//
// An exact informational form (`Bash(docker --version *)`) is narrow here too, as it is in
// runnerIsBroad (2026-10-14). b0685b2 said "exact informational forms (`["docker",
// "--version"]`) stay narrow", and on the Codex half they did, but this walk read
// `--version` as an unknown dispatcher option and refused it, so `Bash(docker --version *)`,
// `Bash(uv --version *)`, `Bash(poetry --version *)`, `Bash(podman --version *)` and
// `Bash(kubectl --help *)` were refused while their prefix_rules rendered (measured against
// 09df009). That refusal also revoked an applied `Bash(docker --version *)` on upgrade (see
// candidateClaudePermission). A runner that is ALSO a wrapper (npm, npx, make, just, hyperfine,
// wsl) is still refused at any depth on this half, by the membership 64b4eaa pinned; this
// line only reaches the runners that are not.
function reachesRunnerExec(node, rest) {
  if (rest.length === 1 && node.info?.has(rest[0])) return false;
  if (node === RUNS_ANY_COMMAND || node.exec || node.any) return true;
  if (!node.sub) return false;
  const at = skipRunnerOptions(node.options, rest, 0);
  if (at < 0 || at >= rest.length) return true;
  if (Object.hasOwn(node.sub, rest[at])) return reachesRunnerExec(node.sub[rest[at]], rest.slice(at + 1));
  return node.fallback === 'exec';
}
function claudeRuleRunsAnyCommand(tokens) {
  const node = RUNNER_GRAMMAR.get(commandBase(tokens[0]));
  if (!node) return false;
  const rest = tokens.slice(1).map(String);
  return reachesRunnerExec(node, rest) || runnerIsBroad(node, rest);
}

function wrapperIsBroad(prefix) {
  const root = canonicalRoot(prefix?.[0]);
  const base = commandBase(prefix?.[0]);
  const runner = RUNNER_GRAMMAR.get(base);
  // git's global options (GIT above): reached here directly and through every wrapper's
  // recursion, so `["xargs", "git"]` and `["timeout", "5", "git", "-c", "x=y", "status"]` are
  // as broad as the git prefix they name.
  if (base === 'git') return runnerIsBroad(GIT, prefix.slice(1).map(String));
  // A short name is judged as the long form it stands for (RUNNER_ALIASES).
  const alias = RUNNER_ALIASES.get(base);
  if (alias) return wrapperIsBroad([...alias, ...prefix.slice(1).map(String)]);
  if (!SHELL_WRAPPERS.has(root) && !SHELL_WRAPPERS.has(base) && !runner) return false;
  if (prefix.length === 1) return true;
  if (INLINE_CODE_FLAGS.has(base) && prefix.slice(1).some((token) => INLINE_CODE_FLAGS.get(base)(String(token)))) {
    return true;
  }
  // xargs execs the named command directly, with no shell, so `["xargs", "rm"]` is no
  // broader than `["rm"]` with arguments read from stdin, which a reviewer may already
  // approve; `["xargs", "sh"]` is as broad as `["sh"]`. Hence the recursion. A prefix that
  // ends before naming a command (`["xargs", "-0"]`, `["env", "FOO=1"]`) runs anything.
  if (prefix.length === 2 && WRAPPER_INFO_ROOTS.has(base) && LONG_INFO.has(String(prefix[1]))) return false;
  if (base === 'env' || base === 'xargs') {
    const inner = innerCommandPrefix(base, prefix);
    // The assignments env makes are judged (2026-10-14): `["env", "GIT_PAGER=x", "git", "log"]`
    // is a grant to run `x`, and `["env", "LD_PRELOAD=./x.so", "cat"]` one to load it, whatever
    // the command after them is. 520103d said "the Codex exporter is unaffected" because a Codex
    // prefix starts at the command, but env carries its assignments as arguments, and they were
    // walked over unread (measured against 09df009: both rows above rendered). Judged first as
    // the Claude half judges a leading one (assignmentIsUnsafe), and since J1 by the Codex
    // export's wider set (codexAssignmentIsUnsafe), which adds the build programs
    // (`["env", "AR=./x", "make", "all"]`) and reads every word env takes as an assignment,
    // `COMPILE.c=./x` included, not only a shell identifier's.
    if (base === 'env' && inner !== null && prefix.slice(1, prefix.length - inner.length)
      .some(codexAssignmentIsUnsafe)) return true;
    return inner === null || inner.length === 0 || wrapperIsBroad(inner);
  }
  // The process and exec wrappers, by the same rule (EXEC_WRAPPER_GRAMMAR above), and the
  // ones no named command can narrow (ALWAYS_BROAD_WRAPPERS).
  if (ALWAYS_BROAD_WRAPPERS.has(base)) return true;
  if (EXEC_WRAPPER_GRAMMAR.has(base)) {
    const inner = execWrapperInner(EXEC_WRAPPER_GRAMMAR.get(base), prefix);
    if (inner === LOOKUP) return false;
    return inner === null || inner.length === 0 || wrapperIsBroad(inner);
  }
  const second = String(prefix[1]).toLowerCase();
  // cmd.exe takes its command from the first `/c` or `/k` (`/r` is an old alias of `/c`)
  // after any number of other switches, and the switch may be fused to the command
  // (`/cdir`). Checking only the second token missed `["cmd", "/d", "/c"]` and `["cmd",
  // "/q"]`, which admits `cmd /q /c <anything>`. The only narrow cmd prefix would be one
  // that already holds a fixed command after `/c`, and that was refused before too, so
  // every cmd prefix is broad (2026-10-13).
  if (['cmd', 'command.com'].includes(base)) return true;
  if (base === 'powershell' || base === 'pwsh') {
    if (['-c', '-command', '-encodedcommand', '-enc'].includes(second)) return true;
    return !['-file', '-f'].includes(second) || prefix.length < 3;
  }
  // Interpreters and shells: narrow only once the program is pinned (INTERPRETER_GRAMMAR
  // above). The POSIX shells used to be checked on the second token alone (`-c`, `-lc`),
  // which let `["bash", "-x"]`, `["bash", "-ec"]` and `["sh", "-s"]` render.
  if (INTERPRETER_GRAMMAR.has(base)) return interpreterIsBroad(base, prefix);
  // Development-environment, package and task runners (RUNNER_GRAMMAR above), including
  // npm, npx, uvx, pnpm, yarn, make and just, which until 2026-10-13 had only the rule below.
  if (runner) return runnerIsBroad(runner, prefix.slice(1).map(String));
  // Every other runner (java, `.`, `source`, ...; duckdb, hyperfine and wsl left this rule for
  // RUNNER_GRAMMAR on 2026-10-14): a prefix that ends in an option has
  // not reached anything it could pin, and the next token could be the very switch that
  // hands over code, so it is broad unless it is exactly an informational form. Value
  // options are not modelled for these roots. The note that stood here, "`["make", "-C",
  // "dir"]` still renders; that is recorded, not solved", is solved by the make and just
  // tables above (2026-10-13).
  if (String(prefix[prefix.length - 1]).startsWith('-')) {
    return !(prefix.length === 2 && DEFAULT_INFO.has(String(prefix[1])));
  }
  return false;
}

function candidateIsWrapper(candidate, prefix) {
  return Boolean(candidate?.wrapper || candidate?.isWrapper || candidate?.is_wrapper ||
    SHELL_WRAPPERS.has(canonicalRoot(prefix?.[0])) || SHELL_WRAPPERS.has(commandBase(prefix?.[0])));
}

function prefixIsAutoSuffixClosed(prefix) {
  const root = canonicalRoot(prefix?.[0]);
  if (root === 'git' || root === 'git.exe') {
    return prefix.length >= 2 && AUTO_SAFE_GIT_SUBCOMMANDS.has(String(prefix[1]).toLowerCase());
  }
  if (root === 'rg' || root === 'rg.exe') {
    return prefix.length >= 2 && SAFE_RG_PREFIXES.has(String(prefix[1]));
  }
  return AUTO_SUFFIX_CLOSED_ROOTS.has(root);
}

// A refusal-table lookup in every spelling (commandBase, 2026-10-14). The tables list the bare
// name, so the base alone would find most entries; the exact spelling is tried too, so an entry
// that is itself a suffixed name commandBase keeps (`format.com`) still matches. Until then each
// of these tables was read by exact spelling, so a reviewed `Bash(git.cmd push *)`, `Bash(rm.cmd
// -rf *)` or `Bash(curl.bat https://example.invalid *)` rendered: the root was on no list and
// fell through to "not known risky" (measured against 09df009).
function refusedRoot(table, token) {
  return table.has(canonicalRoot(token)) || table.has(commandBase(token));
}

function prefixIsKnownRisky(prefix) {
  if (!Array.isArray(prefix) || prefix.length === 0) return true;
  const base = commandBase(prefix[0]);
  if ([DESTRUCTIVE_OR_ADMIN_ROOTS, NETWORK_OR_INSTALL_ROOTS, STATE_MUTATING_ROOTS]
    .some((table) => refusedRoot(table, prefix[0]))) return true;
  if (base === 'git') {
    return prefix.length < 2 || !SAFE_GIT_READ_SUBCOMMANDS.has(String(prefix[1]).toLowerCase());
  }
  if (base === 'rg') {
    return prefix.length < 2 || !SAFE_RG_PREFIXES.has(String(prefix[1]));
  }
  if (prefix.length === 1 && ['docker', 'node', 'perl', 'python', 'ruby'].includes(commandBase(prefix[0]))) return true;
  return false;
}

function candidateEligibleForCodex(candidate, options) {
  const reviewed = options?.includeReviewed === true;
  if ((!isAutoSafe(candidate) && !reviewed) || candidateIsComplex(candidate)) return null;
  const prefix = normalizePrefix(candidate);
  if (!prefix || candidateContainsSecret(candidate, prefix)) return null;
  // A prefix that opens with assignments (J1, 2026-10-14). The learner never builds one (its
  // prefix is the command's), but a reviewed or stored candidate can carry one, and every check
  // below read the assignment as the root, so `["CC=./x", "make"]`, `["FOO=1", "bash"]` and
  // `["LD_PRELOAD=./x.so", "cat"]` rendered (measured against 7d08ced). Whether Codex ever matches
  // such a rule is not known: its checker matches raw argv and does not strip an assignment
  // (test/codex-guidance-matrix.test.js), and the runtime's handling of `VAR=value cmd` has not
  // been measured (docs/codex-compatibility.md). So it is judged the way the Claude half judges
  // an env-led rule: under review only, each assignment by codexAssignmentIsUnsafe, and the
  // command after them by everything here.
  const command = prefix.findIndex((token) => !ASSIGNMENT_WORD.test(token));
  if (command !== 0) {
    if (command < 0 || !reviewed || prefix.slice(0, command).some(codexAssignmentIsUnsafe)) return null;
    return candidateEligibleForCodex({ ...candidate, prefix: prefix.slice(command) }, options) ? prefix : null;
  }
  // A runner root (RUNNER_GRAMMAR) is judged like a wrapper here and only here: it is not a
  // SHELL_WRAPPERS member, because membership there would also refuse `Bash(docker ps *)`
  // on the Claude side, at any depth (claudeRuleRunsAnyCommand draws that line instead).
  const base = commandBase(prefix[0]);
  if (candidateIsWrapper(candidate, prefix) || RUNNER_GRAMMAR.has(base)) {
    if (!reviewed || wrapperIsBroad(prefix)) return null;
  }
  // git on both paths (GIT above). The automatic one already needs an AUTO_SAFE_GIT_SUBCOMMANDS
  // word right after the root, which this never refuses, so only reviewed prefixes change.
  if (base === 'git' && wrapperIsBroad(prefix)) return null;
  if (!reviewed && (candidateRiskIsUnsafe(candidate) || candidateHasAutomaticBlock(candidate) ||
      prefixIsKnownRisky(prefix) || !prefixIsAutoSuffixClosed(prefix))) return null;
  return prefix;
}

function successCount(candidate) {
  for (const value of [candidate?.successCount, candidate?.successfulRuns,
    candidate?.successes, candidate?.counts?.success, candidate?.counts?.successful]) {
    const count = Number(value);
    if (Number.isFinite(count) && count > 0) return Math.floor(count);
  }
  return 0;
}

function patternKey(pattern) {
  return JSON.stringify(pattern);
}

function shellExampleArg(value) {
  const arg = String(value);
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg)) return arg;
  const quote = String.fromCharCode(34);
  const escaped = arg.replace(/\\/g, '\\\\').split(quote).join('\\' + quote);
  return quote + escaped + quote;
}

function expandPattern(pattern) {
  let commands = [[]];
  for (const position of pattern) {
    const alternatives = Array.isArray(position) ? position : [position];
    commands = commands.flatMap((prefix) => alternatives.map((token) => [...prefix, token]));
  }
  return commands;
}

function commandExample(argv) {
  return argv.map(shellExampleArg).join(' ');
}

function nonMatchExamples(pattern) {
  const unionIndex = pattern.findIndex(Array.isArray);
  if (unionIndex >= 0) {
    const argv = pattern.map((position) => Array.isArray(position) ? position[0] : position);
    const root = canonicalRoot(argv[0]);
    if ((root === 'git' || root === 'git.exe') && unionIndex === 1) {
      return [commandExample([argv[0], 'push']), commandExample([argv[0], 'reset', '--hard'])];
    }
    argv[unionIndex] = '__claude_wildcarding_not_allowed__';
    return [commandExample(argv)];
  }
  if (pattern.length === 1) return ['__claude_wildcarding_nonmatch__'];
  const argv = pattern.slice();
  argv[argv.length - 1] = `${argv[argv.length - 1]}__claude_wildcarding_nonmatch__`;
  return [commandExample(argv)];
}

function ruleJustification(candidates, options) {
  if (typeof options?.justification === 'string') {
    const fixed = cleanOneLine(options.justification);
    if (fixed) return fixed;
  }
  const custom = candidates.map((candidate) => cleanOneLine(candidate?.justification))
    .filter(Boolean).sort((a, b) => a.localeCompare(b));
  if (custom.length) return custom[0];
  const observed = candidates.reduce((sum, candidate) => sum + successCount(candidate), 0);
  return observed > 0
    ? `Auto Learn: ${observed} successful local history observation${observed === 1 ? '' : 's'}.`
    : 'Auto Learn: deterministic low-risk prefix from local history.';
}

function renderPattern(pattern) {
  const renderPosition = (position) => Array.isArray(position)
    ? `[${position.map(starlarkString).join(', ')}]`
    : starlarkString(position);
  return `[${pattern.map(renderPosition).join(', ')}]`;
}

function renderRule(record, options) {
  const renderList = (values) => values.map((value) => `        ${starlarkString(value)},`).join('\n');
  const matches = expandPattern(record.pattern).map(commandExample);
  return [
    'prefix_rule(',
    `    pattern = ${renderPattern(record.pattern)},`,
    '    decision = ' + starlarkString('allow') + ',',
    `    justification = ${starlarkString(ruleJustification(record.candidates, options))},`,
    '    match = [', renderList(matches), '    ],',
    '    not_match = [', renderList(nonMatchExamples(record.pattern)), '    ],',
    ')',
  ].join('\n');
}

function buildCodexRecords(candidates, options) {
  const byPattern = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    // Codex policy is an argv prefix for a program it will execute. An MCP
    // tool, a fetch domain or a file edit has no such shape, so a tool family
    // must never be rendered as one of its rules.
    if (candidate && typeof candidate === 'object' && candidate.kind === 'tool') continue;
    const prefix = candidateEligibleForCodex(candidate, options);
    if (!prefix) continue;
    const key = patternKey(prefix);
    if (!byPattern.has(key)) byPattern.set(key, { pattern: prefix, candidates: [] });
    byPattern.get(key).candidates.push(candidate);
  }

  let records = [...byPattern.values()];
  const gitGroups = new Map();
  for (const record of records) {
    const [root, subcommand] = record.pattern;
    if (record.pattern.length !== 2 ||
        !['git', 'git.exe'].includes(canonicalRoot(root)) ||
        !SAFE_GIT_READ_SUBCOMMANDS.has(String(subcommand).toLowerCase())) continue;
    if (!gitGroups.has(root)) gitGroups.set(root, []);
    gitGroups.get(root).push(record);
  }

  const groupedKeys = new Set();
  const unions = [];
  for (const [root, group] of gitGroups) {
    const subcommands = [...new Set(group.map((record) => record.pattern[1]))]
      .sort((a, b) => a.localeCompare(b));
    if (subcommands.length < 2) continue;
    group.forEach((record) => groupedKeys.add(patternKey(record.pattern)));
    unions.push({ pattern: [root, subcommands], candidates: group.flatMap((record) => record.candidates) });
  }

  records = records.filter((record) => !groupedKeys.has(patternKey(record.pattern)));
  records.push(...unions);
  records.sort((a, b) => patternKey(a.pattern).localeCompare(patternKey(b.pattern)));
  return records;
}

// `options.version` and `options.header` are gone. Between them they carried two
// dead keys and three dead arms — an overridden version, a custom header string,
// and `header: false` to suppress the header entirely — and none of the seven
// call sites across src/ and test/ ever set either. What is left is what every
// caller has always got.
function renderCodexRules(candidates, options = {}) {
  const header = [
    '# Generated by permission-wildcarding Auto Learn. Review before enabling.',
    `# Generator format version: ${GENERATED_FORMAT_VERSION}`,
  ];
  const body = buildCodexRecords(candidates, options).map((record) => renderRule(record, options));
  if (body.length === 0) body.push('# No auto-safe command prefixes were eligible.');
  return [...header, ...header.length && body.length ? [''] : [], ...body].join('\n').trimEnd() + '\n';
}

function lexicalMask(source) {
  const chars = source.split('');
  const stack = [];
  const errors = [];
  const quoteChars = new Set([String.fromCharCode(34), String.fromCharCode(39)]);
  const pairs = { ')': '(', ']': '[', '}': '{' };
  let quote = null;
  let escaped = false;
  let comment = false;

  for (let index = 0; index < chars.length; index++) {
    const character = chars[index];
    if (comment) {
      if (character === '\n') comment = false;
      else chars[index] = ' ';
      continue;
    }
    if (quote) {
      chars[index] = character === '\n' ? '\n' : ' ';
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '#') {
      chars[index] = ' ';
      comment = true;
      continue;
    }
    if (quoteChars.has(character)) {
      chars[index] = ' ';
      quote = character;
      continue;
    }
    if ('([{'.includes(character)) stack.push({ character, index });
    else if (')]}'.includes(character)) {
      const open = stack.pop();
      if (!open || open.character !== pairs[character]) {
        errors.push(`Unbalanced ${character} at offset ${index}`);
        break;
      }
    }
  }
  if (quote) errors.push('Unterminated string literal');
  if (stack.length) errors.push(`Unclosed ${stack[stack.length - 1].character} at offset ${stack[stack.length - 1].index}`);
  return { masked: chars.join(''), errors };
}

function findRuleBlocks(source, masked) {
  const blocks = [];
  const expression = /\bprefix_rule\s*\(/g;
  let match;
  while ((match = expression.exec(masked))) {
    const open = masked.indexOf('(', match.index);
    let depth = 0;
    let close = -1;
    for (let index = open; index < masked.length; index++) {
      if (masked[index] === '(') depth++;
      else if (masked[index] === ')' && --depth === 0) {
        close = index;
        break;
      }
    }
    if (close < 0) break;
    blocks.push({ start: match.index, end: close + 1, text: source.slice(match.index, close + 1), mask: masked.slice(match.index, close + 1) });
    expression.lastIndex = close + 1;
  }
  return blocks;
}

function assignedArray(block, name) {
  const assignment = new RegExp(`\\b${name}\\s*=`).exec(block.mask);
  if (!assignment) return null;
  const open = block.mask.indexOf('[', assignment.index + assignment[0].length);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < block.mask.length; index++) {
    if (block.mask[index] === '[') depth++;
    else if (block.mask[index] === ']' && --depth === 0) return block.text.slice(open, index + 1);
  }
  return null;
}

function patternSafetyErrors(pattern, number) {
  const errors = [];
  if (!Array.isArray(pattern) || pattern.length === 0 || Array.isArray(pattern[0])) {
    return [`Rule ${number}: pattern must begin with one exact executable token`];
  }
  for (const position of pattern) {
    const tokens = Array.isArray(position) ? position : [position];
    if (tokens.length === 0 || tokens.some((token) => typeof token !== 'string' || !token)) {
      errors.push(`Rule ${number}: pattern tokens must be non-empty strings`);
      continue;
    }
    if (tokens.some((token) => /[\u0000-\u001f\u007f]/.test(token))) errors.push(`Rule ${number}: control character in pattern token`);
    if (tokens.some((token) => token.includes('*'))) errors.push(`Rule ${number}: star tokens are not Codex argv wildcards`);
  }

  // A pattern that opens with assignments is judged by the command after them (J1, 2026-10-14,
  // beside candidateEligibleForCodex): `["FOO=1", "curl"]` passed here while `["curl"]` did not.
  const lead = pattern.findIndex((position) => Array.isArray(position) || !ASSIGNMENT_WORD.test(position));
  if (lead < 0) return [...errors, `Rule ${number}: pattern names no command after its assignments`];
  if (lead > 0) return errors.length ? errors : patternSafetyErrors(pattern.slice(lead), number);
  const root = canonicalRoot(pattern[0]);
  const base = commandBase(pattern[0]);                // every spelling of the root (2026-10-14)
  const second = pattern.length > 1
    ? (Array.isArray(pattern[1]) ? pattern[1] : [pattern[1]]).map((value) => String(value).toLowerCase())
    : [];
  if (['powershell', 'pwsh'].includes(base) &&
      (pattern.length === 1 || (pattern.length === 2 && second.some((value) => ['-c', '-command'].includes(value))))) {
    errors.push(`Rule ${number}: broad PowerShell command prefix is forbidden`);
  }
  if (pattern.length === 1 && ['curl', 'python'].includes(base)) {
    errors.push(`Rule ${number}: bare ${root} prefix is too broad`);
  }
  if (base === 'git' && pattern.length === 1) errors.push(`Rule ${number}: bare git prefix is too broad`);
  return errors;
}

function validateCodexRulesText(text) {
  if (typeof text !== 'string') return { valid: false, errors: ['Rules text must be a string'] };
  const scanned = lexicalMask(text);
  const errors = scanned.errors.slice();
  if (errors.length) return { valid: false, errors };

  const blocks = findRuleBlocks(text, scanned.masked);
  const remaining = scanned.masked.split('');
  if (remaining[0] === '\uFEFF') remaining[0] = ' ';
  blocks.forEach((block) => {
    for (let index = block.start; index < block.end; index++) remaining[index] = ' ';
  });
  if (remaining.join('').trim()) errors.push('Unexpected top-level executable policy content');

  const allowExpression = new RegExp(`\\bdecision\\s*=\\s*${starlarkString('allow')}`);
  const fields = ['pattern', 'decision', 'justification', 'match', 'not_match'];
  blocks.forEach((block, index) => {
    const number = index + 1;
    for (const field of fields) {
      if (!new RegExp(`\\b${field}\\s*=`).test(block.mask)) errors.push(`Rule ${number}: missing ${field}`);
    }
    if (!allowExpression.test(block.text)) errors.push(`Rule ${number}: generated decision must be allow`);
    for (const field of ['match', 'not_match']) {
      const arrayText = assignedArray(block, field);
      if (!arrayText || /^\[\s*\]$/.test(arrayText)) errors.push(`Rule ${number}: ${field} must contain inline tests`);
    }
    const patternText = assignedArray(block, 'pattern');
    if (patternText) {
      try {
        errors.push(...patternSafetyErrors(JSON.parse(patternText), number));
      } catch {
        errors.push(`Rule ${number}: pattern must use deterministic JSON-compatible string arrays`);
      }
    }
  });
  return { valid: errors.length === 0, errors };
}

// Beyond shell rules, a permission may name an exact MCP tool, one fetch
// domain, or a bare tool. None carries a wildcard: the grant is never wider
// than the call that was observed.
const MCP_PERMISSION = /^mcp__[A-Za-z0-9_.-]{1,64}__[A-Za-z0-9_.-]{1,64}$/;
const WEB_FETCH_PERMISSION = /^WebFetch\(domain:([A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+)\)$/;
function parseToolPermission(permission) {
  const value = String(permission);
  if (MCP_PERMISSION.test(value)) return { permission: value, tool: 'mcp', root: value, tokens: [value] };
  const fetched = WEB_FETCH_PERMISSION.exec(value);
  if (fetched) {
    return { permission: value, tool: 'WebFetch', root: fetched[1], tokens: [fetched[1]] };
  }
  if (value === 'WebSearch') return { permission: value, tool: 'WebSearch', root: value, tokens: [value] };
  return null;
}
function parseClaudePermission(permission) {
  const match = /^(Bash|PowerShell)\((.+) \*\)$/.exec(String(permission));
  if (!match) return null;
  const tokens = match[2].split(' ');
  const safeToken = /^[A-Za-z0-9_@%+=:,./\\-]+$/;
  if (tokens.length === 0 || tokens.some((token) => !token || !safeToken.test(token))) return null;
  if (candidateContainsSecret({}, tokens)) return null;
  return { permission: match[0], tool: match[1], root: tokens[0], tokens };
}

// A Claude rule that opens with `NAME=VALUE` words: the learner's env-led families
// (src/auto-learn.js candidateKey, 2026-10-13) propose `Bash(FOO=bar git status *)`, the
// one rule Claude Code matches against a line that opens with an assignment it does not
// strip. Until then every table below read the ASSIGNMENT as the root, so a reviewed
// `Bash(FOO=1 rm *)`, `Bash(FOO=1 bash *)` or `Bash(FOO=1 curl *)` rendered (root `foo=1`
// is on no list; measured 2026-10-13 against b0685b2). Now the command after the
// assignments is judged by everything here, the rule is reviewable only (the learner's
// `environment-prefix` reason keeps it off the automatic path as well), and an assignment
// that makes the program itself load code named by its value is refused outright: the
// dynamic loader's `LD_*` and `DYLD_*` (ld.so(8), dyld(1)), `PATH` (which file a bare name
// is), `BASH_ENV` and `ENV` (read and run by a non-interactive bash or sh), and the
// interpreters' start-up options and module paths. `Bash(LD_PRELOAD=./x.so cat *)` runs
// whatever `./x.so` holds, as broad as the `Bash(python *)` this module already refuses.
//
// PROGRAM_NAMING_ENV (added 2026-10-13) closes what that paragraph used to record as not
// covered: a variable whose VALUE names a program a tool later runs. The rule pins the value,
// but the value IS the program, so `Bash(GIT_PAGER=x git log *)` is a grant to run `x`, and
// `Bash(GIT_SSH_COMMAND=x git fetch *)` a grant to run `x` as git's transport, each as broad
// as the `Bash(x *)` this module gates on its own. A reviewer reading the git half sees a
// read-only subcommand and may miss that the assignment turns it into running `x`. The set is
// an explicit list, not a classifier:
//   * PAGER, GIT_PAGER, MANPAGER (the pager git, man and others spawn), EDITOR, VISUAL,
//     GIT_EDITOR (the editor they spawn), BROWSER (git web--browse, man -H), PROMPT_COMMAND
//     (bash runs it before each prompt), LESSOPEN and LESSCLOSE (an input preprocessor less
//     runs through a shell).
//   * git's command-valued variables: GIT_SSH and GIT_SSH_COMMAND (the transport), GIT_ASKPASS
//     (the credential prompt), GIT_EXTERNAL_DIFF (run per changed file) and GIT_PROXY_COMMAND.
//     SSH_ASKPASS and SUDO_ASKPASS are the same for ssh and sudo.
//   * CC, CXX and MAKE choose the compiler or the make a build runs. Refused deliberately,
//     though `CC=gcc make` is common and benign: the class is "a value that is a program", and
//     refusing more is the safe failure. The decision costs nothing measured here (0 of the
//     development box's 581 allow entries is an env-led rule that renders at all).
// NODE_OPTIONS, PYTHONSTARTUP, PERL5OPT and RUBYOPT are this class too and are already in
// CODE_LOADING_ENV (the interpreter start-up set), so they are not repeated. The Codex export
// judges a wider set than this one, codexEnvNameIsUnsafe below (J1), wherever it reads an
// assignment: an `env` wrapper's, a container's `-e`, a make or just override, and a prefix that
// opens with one. "The Codex exporter is unaffected" stood here until 2026-10-14, and then "a
// LEADING assignment never reaches it": the learner never builds such a prefix (its prefix is the
// command's), but a reviewed or stored candidate can carry one, and until J1 `["CC=./x",
// "make"]` and even `["LD_PRELOAD=./x.so", "cat"]` rendered, judged by no table.
const ASSIGNMENT_WORD = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const CODE_LOADING_ENV = new Set([
  'PATH', 'BASH_ENV', 'ENV', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'NODE_OPTIONS', 'NODE_PATH',
  'PERL5OPT', 'PERL5LIB', 'PERLLIB', 'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS',
]);
const PROGRAM_NAMING_ENV = new Set([
  'PAGER', 'GIT_PAGER', 'MANPAGER', 'EDITOR', 'VISUAL', 'GIT_EDITOR', 'BROWSER', 'PROMPT_COMMAND',
  'LESSOPEN', 'LESSCLOSE', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_EXTERNAL_DIFF',
  'GIT_PROXY_COMMAND', 'SSH_ASKPASS', 'SUDO_ASKPASS', 'CC', 'CXX', 'MAKE',
]);
function envNameIsUnsafe(name) {
  return CODE_LOADING_ENV.has(name) || PROGRAM_NAMING_ENV.has(name) || /^(?:LD|DYLD)_/.test(name);
}
// The Claude half's judgment of a leading assignment (claudePermissionIsSafe). FOLDED SINCE L2
// (2026-10-14, the lead's decision, as K1 folded the Codex export's): a native Windows program
// reads its environment case-insensitively, so `ld_preload=./x.so cat` or `node_options=... cat`
// is the variable itself there (K1 MEASURED the bash spelling `node_options=--require=./y.js node
// -e ...` running y.js). Only envNameIsUnsafe's own sets are folded, the ones this half already
// refused: CODE_LOADING_ENV, PROGRAM_NAMING_ENV and the loader prefixes `LD_` and `DYLD_`. None is
// added: J1's build programs, F6's make sets, cargo's names and K3's directories stay Codex export
// only, so G4(b)'s acceptance of `Bash(AR=x cargo build *)` stands, in any case (`Bash(ar=x cargo
// build *)` renders too). Claude Code's own strip is case-exact and unaffected: its allow path
// strips a leading `NAME=VALUE` only when its Set of 39 upper-case names `.has` the captured NAME
// as written (CLAUDE_SAFE_ENV_VARS, src/permission-match.js; re-read 2026-10-14 in the 2.1.296
// binary at the offset scripts/check-claude-strip-model.js reports: `let V=G[1] ... if(IG.has(V))`,
// no case conversion), so `lang=C git log` keeps its assignment and needs a rule that carries it.
// And no one of those 39 names is in a folded set, so the fold cannot refuse a rule for an
// assignment Claude Code strips.
function assignmentIsUnsafe(token) {
  const name = ASSIGNMENT_WORD.exec(token)[1];
  return envNameIsUnsafe(name) || envNameIsUnsafe(name.toUpperCase());
}
// The value of a container's `-e`/`--env` (execWrapperInner, 2026-10-14): `NAME=VALUE`, or a
// bare `NAME`, which docker and podman fill from the caller's own environment, so a value the
// prefix does not even show. Judged by the name alone either way; a missing value (the prefix
// ends at `-e`) is no assignment, and that prefix names no command anyway. Case folded since
// K1 (codexFoldedEnvNameIsUnsafe below).
function envAssignmentIsUnsafe(value) {
  return value !== undefined && codexFoldedEnvNameIsUnsafe(String(value).split('=', 1)[0]);
}
// An exec wrapper's environment option (execWrapperInner). Where a bare NAME removes the variable
// instead of copying it in (strace's `-E VAR`, `envUnsetsBare`; L3), only an assignment is judged.
function envOptionIsUnsafe(grammar, value) {
  if (grammar.envUnsetsBare && !String(value ?? '').includes('=')) return false;
  return envAssignmentIsUnsafe(value);
}

// THE BUILD PROGRAMS, CODEX EXPORT ONLY (J1, 2026-10-14: the lead's answer to the maintainer
// question G4(b) carried in docs/engineering-record.md). PROGRAM_NAMING_ENV refuses CC, CXX and
// MAKE on the premise that the value IS the program to run. That premise holds as much for every
// other variable a build tool reads as the name of a program, refusing more is the safe failure,
// and F6 (b9854f6) already refused the same names as make overrides. So every place the Codex
// export reads an assignment judges it by this one predicate: an `env` wrapper's assignments
// (wrapperIsBroad), a container's `-e`/`--env` (envAssignmentIsUnsafe above), a make or just
// override (MAKE's and JUST's unsafeVariable), and a prefix that opens with assignments
// (candidateEligibleForCodex). Matched exactly, as F6's names are: make's variable names are
// case-sensitive, and so is a POSIX environment. Since K1 (below) the ENVIRONMENT readers fold
// case through codexFoldedEnvNameIsUnsafe, and since L1 the make and just overrides do too.
//
// THE CLAUDE HALF IS NOT CHANGED. claudePermissionIsSafe judges a leading assignment by
// envNameIsUnsafe, as before (folded since L2, assignmentIsUnsafe above, its own sets only), so
// `Bash(AR=x cargo build *)` and `Bash(LD=./ld cargo build *)`
// still render at review: G4(b)'s acceptance stands there, because that rule keeps the literal
// value the user ran and matches no other (ruleMatches), and Claude Code strips neither name.
// Adding these names to PROGRAM_NAMING_ENV itself would have refused that rule too, which is
// why they live here and not there.
//
// The names:
//   * F6's sets, reused whole, because they fit: GNU make turns every environment variable into a
//     make variable, and "an explicit assignment in the makefile, or with a command argument,
//     overrides the environment" (GNU make manual, "Variables from the Environment"), while its
//     built-in defaults can be redefined "in the environment to alter how the implicit rules
//     work" ("Variables Used by Implicit Rules"; both read from make.txt on gnu.org 2026-10-14).
//     So `AR=./x make lib` runs ./x wherever a built-in rule runs $(AR) and the makefile does not
//     set AR. MAKE_PROGRAM_VARIABLES (make's
//     built-in program table and the GNU Coding Standards' program variables) and
//     MAKE_COMMAND_VARIABLE (the built-in rules' whole command lines; `env COMPILE.c=./x` sets
//     one, since env takes any `NAME=VALUE`) for that reason. MAKE_SHELL_VARIABLES too: make
//     reads MAKEFLAGS and MAKEFILES from the environment by name (the manual's "Communicating
//     Options to a Sub-make" and "The Variable MAKEFILES"), and SHELL there on MS-Windows
//     ("Choosing the Shell"). One difference from an override, and no difference to the
//     verdict: a makefile's own definition beats an environment value (unless `-e`), so an
//     env-led AR reaches only the rules the makefile leaves to the defaults.
//   * cargo's, each read 2026-10-14 from the Cargo Book's "Environment Variables" page
//     (doc.rust-lang.org/cargo/reference/environment-variables.html, "Environment variables
//     Cargo reads" and "Configuration environment variables") and its "Configuration" page
//     (config.html): RUSTC ("Instead of running rustc, Cargo will execute this specified
//     compiler"), RUSTC_WRAPPER and RUSTC_WORKSPACE_WRAPPER ("Cargo will execute this specified
//     wrapper"), RUSTDOC, RUSTFMT (`cargo fmt` runs it); their config spellings
//     CARGO_BUILD_RUSTC, CARGO_BUILD_RUSTC_WRAPPER, CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER and
//     CARGO_BUILD_RUSTDOC (build.rustc, "Type: string (program path)", and so on);
//     CARGO_TARGET_<triple>_LINKER ("The linker to use", "The triple must be converted to
//     uppercase and underscores") and CARGO_TARGET_<triple>_RUNNER ("The executable runner",
//     which `cargo run`, `cargo test` and `cargo bench` invoke with the built executable); the
//     credential providers CARGO_REGISTRY_CREDENTIAL_PROVIDER,
//     CARGO_REGISTRY_GLOBAL_CREDENTIAL_PROVIDERS, CARGO_REGISTRIES_<name>_CREDENTIAL_PROVIDER and
//     CARGO_CREDENTIAL_ALIAS_<name> (each a program cargo runs to get a token); and
//     CARGO_DOC_BROWSER, doc.browser ("program path with args") by the config page's general
//     rule that a key `foo.bar` is also `CARGO_FOO_BAR` (the entry itself names no variable).
//     BROWSER, which doc.browser defaults to, is already in PROGRAM_NAMING_ENV.
//   * the directories cargo's configuration and rustup's toolchains come from (CARGO_CONFIG_ENV;
//     K3, 2026-10-14, the lead's decision). J1 left CARGO_HOME out, as the config-file class rather
//     than a program name, and recorded it for the maintainer; the lead refuses it, as this file
//     refuses node's config-file options. Each read that day. CARGO_HOME "overrides the location
//     of this directory" (the Cargo Book's environment-variables.html), the home whose
//     "config.toml" is "Cargo's global configuration file" (guide/cargo-home.html), probed as
//     "$CARGO_HOME/config.toml" (config.html, "Hierarchical structure"), where build.rustc,
//     build.rustc-wrapper and target.<triple>.linker are each "Type: string (program path)".
//     RUSTUP_TOOLCHAIN "can specify custom toolchains, installable toolchains, or the absolute
//     path to a toolchain" (rustup's environment-variables.html), so it names the program's
//     directory outright, not only an installed name. RUSTUP_HOME "Sets the root rustup folder,
//     used for storing installed toolchains and configuration options" (the same page), so the
//     toolchain a rustup proxy such as cargo or rustc runs, and the settings that choose it, come
//     from the directory it names: a path again.
//   * the servers rustup downloads the toolchain and itself from (RUSTUP_SOURCE_ENV; L4,
//     2026-10-14, the lead's decision on what K3 left). Each read that day from rustup's
//     environment-variables page (doc/user-guide/src/environment-variables.md in rust-lang/rustup)
//     and its source. RUSTUP_DIST_SERVER "Sets the root URL for downloading static resources
//     related to Rust", the toolchains. RUSTUP_DIST_ROOT is its deprecated spelling ("Use
//     RUSTUP_DIST_SERVER instead"), still read "For backwards compatibility" when
//     RUSTUP_DIST_SERVER is unset (src/config.rs, dist_root_server). RUSTUP_UPDATE_ROOT "Sets the
//     root URL for downloading self-update", the rustup binary that every later rustup, cargo or
//     rustc proxy then is; under `auto-self-update = enable`, "`rustup update` and similar
//     commands will also check for, and install, any update to Rustup" (basics.md). And
//     RUSTUP_AUTO_INSTALL is on by default ("(default: 1) When set to `1`, installs the active
//     toolchain when it is absent"; restored by default in 1.28.1, after 1.28.0 turned it off, per
//     the CHANGELOG), so a plain `cargo build` with the active toolchain absent downloads one from
//     the dist server and runs it. Each names where the code that runs comes from, so it is
//     refused, as a program path is. RUSTUP_AUTO_INSTALL itself stays data: a switch on that
//     default, which chooses no source.
// Left out, on purpose:
//   * the flags variables of both tools (CFLAGS, LDFLAGS, ARFLAGS, ..., RUSTFLAGS,
//     CARGO_ENCODED_RUSTFLAGS, RUSTDOCFLAGS, CARGO_BUILD_RUSTFLAGS,
//     CARGO_TARGET_<triple>_RUSTFLAGS) and the locations (PREFIX, DESTDIR, CARGO_TARGET_DIR, ...).
//     They are data by the standing decision G4(a) records for `CFLAGS=-fplugin=./x.so`, even
//     though `RUSTFLAGS=-Clinker=./x` names a program the same way.
//   * rustup's data variables: RUSTUP_LOG (log verbosity), RUSTUP_TOOLCHAIN_SOURCE ("Set by
//     rustup to tell proxied tools how RUSTUP_TOOLCHAIN was determined"), RUSTUP_AUTO_INSTALL
//     (above), the terminal, I/O and download tuning (RUSTUP_TERM_*, RUSTUP_IO_THREADS,
//     RUSTUP_UNPACK_RAM, RUSTUP_CONCURRENT_DOWNLOADS, RUSTUP_DOWNLOAD_TIMEOUT), and RUSTUP_VERSION,
//     which "Overrides the rustup version (e.g. `1.27.1`) to be downloaded" from the server above:
//     a version, not a source (docs/engineering-record.md, L4).
//   * CARGO_ALIAS_<name>: its value is cargo's own arguments, not a program, the `npm test`
//     class the header records. CARGO_HOST_LINKER: not on either page. target.<triple>.ar:
//     "deprecated and unused".
//   * the cc crate's CC_<target>, TARGET_CC, AR_<target>, ...: a build-script library's, not
//     cargo's, and per-target patterns. And the other build tools (CMake's
//     CMAKE_<LANG>_COMPILER_LAUNCHER, Go's GOTOOLCHAIN, autoconf's ac_cv_*): not surveyed.
const CARGO_PROGRAM_ENV = new Set([
  'RUSTC', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'RUSTDOC', 'RUSTFMT',
  'CARGO_BUILD_RUSTC', 'CARGO_BUILD_RUSTC_WRAPPER', 'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER', 'CARGO_BUILD_RUSTDOC',
  'CARGO_REGISTRY_CREDENTIAL_PROVIDER', 'CARGO_REGISTRY_GLOBAL_CREDENTIAL_PROVIDERS', 'CARGO_DOC_BROWSER',
]);
const CARGO_PROGRAM_ENV_PATTERN =
  /^CARGO_(?:TARGET_[A-Z0-9_]+_(?:LINKER|RUNNER)|REGISTRIES_[A-Z0-9_]+_CREDENTIAL_PROVIDER|CREDENTIAL_ALIAS_[A-Z0-9_]+)$/;
const CARGO_CONFIG_ENV = new Set(['CARGO_HOME', 'RUSTUP_TOOLCHAIN', 'RUSTUP_HOME']);
const RUSTUP_SOURCE_ENV = new Set(['RUSTUP_DIST_SERVER', 'RUSTUP_DIST_ROOT', 'RUSTUP_UPDATE_ROOT']);
function codexEnvNameIsUnsafe(name) {
  return envNameIsUnsafe(name) || MAKE_SHELL_VARIABLES.has(name) || MAKE_PROGRAM_VARIABLES.has(name) ||
    MAKE_COMMAND_VARIABLE.test(name) || CARGO_PROGRAM_ENV.has(name) || CARGO_PROGRAM_ENV_PATTERN.test(name) ||
    CARGO_CONFIG_ENV.has(name) || RUSTUP_SOURCE_ENV.has(name);
}
// AN ENVIRONMENT NAME FOLDS CASE ON WINDOWS (K1, 2026-10-14, the lead's decision). A native
// Windows program looks its environment up case-insensitively, so an assignment to `rustc`,
// `ld_preload` or `Node_Options` is the variable itself there. MEASURED that day under Git Bash
// with node 24: `env node_options=--require=./y.js node -e ...` and the bash spelling
// `node_options=--require=./y.js node -e ...` each ran y.js and saw NODE_OPTIONS set, and a run
// with neither saw it undefined (J1 had measured `env rustc_probe=./x node` seeing
// RUSTC_PROBE). So every ENVIRONMENT reader in the Codex export judges a name by this, on every
// platform, because a rules file is not tied to the OS it was generated on and refusing more is
// the safe failure: an `env` wrapper's assignments (wrapperIsBroad), a container's `-e`/`--env`
// (envAssignmentIsUnsafe above; strace's `-E` too since L3) and a prefix that opens with assignments
// (candidateEligibleForCodex), the first and last through codexAssignmentIsUnsafe below. It is a
// superset of codexEnvNameIsUnsafe by construction: the exact name, its upper-case spelling
// (every set member is upper case), and the built-in command lines with their lower-case
// suffix (`COMPILE.c`, `CHECKOUT,v`) matched case-insensitively. That covers envNameIsUnsafe's
// sets too (CODE_LOADING_ENV, PROGRAM_NAMING_ENV, `LD_*` and `DYLD_*`), which were exact.
//
// USED for make's and just's own overrides too since L1 (MAKE's and JUST's unsafeVariable; the
// lead's decision, reversing K1's exact half). K1 kept them exact, because make's variable names
// are case-sensitive and `["make", "cc=x", "all"]` sets no compiler variable for make itself, and
// recorded that premise as unverified: make exports a command-line variable to every recipe
// line's environment, and just does so under `set export` (measured), where a Windows child reads
// it folded. MAKE's comment above has the sources (docs/engineering-record.md, K1 and L1).
const MAKE_COMMAND_VARIABLE_FOLDED = new RegExp(MAKE_COMMAND_VARIABLE.source, 'i');
function codexFoldedEnvNameIsUnsafe(name) {
  const text = String(name);
  return codexEnvNameIsUnsafe(text) || codexEnvNameIsUnsafe(text.toUpperCase()) ||
    MAKE_COMMAND_VARIABLE_FOLDED.test(text);
}
// A word that is an assignment to an unsafe name. env takes any `NAME=VALUE` that is not an
// option as an assignment (innerCommandPrefix), so the name is everything before the first `=`.
function codexAssignmentIsUnsafe(token) {
  const text = String(token);
  return !text.startsWith('-') && text.includes('=') && codexFoldedEnvNameIsUnsafe(text.split('=', 1)[0]);
}

function claudePermissionIsSafe(parsed, options) {
  const reviewed = options?.includeReviewed === true;
  if (!parsed || parsed.root === '&') return false;
  const command = parsed.tokens.findIndex((token) => !ASSIGNMENT_WORD.test(token));
  if (command !== 0) {
    if (command < 0 || !reviewed || parsed.tool !== 'Bash') return false;
    // envNameIsUnsafe, NOT the Codex export's codexEnvNameIsUnsafe: J1's build programs are
    // Codex export only, and G4(b)'s acceptance of `Bash(AR=x cargo build *)` stands here.
    // Folded since L2, so `Bash(ld_preload=./x.so cat *)` is refused (assignmentIsUnsafe).
    if (parsed.tokens.slice(0, command).some(assignmentIsUnsafe)) return false;
    return claudePermissionIsSafe({ ...parsed, root: parsed.tokens[command], tokens: parsed.tokens.slice(command) }, options);
  }
  const root = parsed.root.toLowerCase();
  if ([DESTRUCTIVE_OR_ADMIN_ROOTS, NETWORK_OR_INSTALL_ROOTS, STATE_MUTATING_ROOTS, SHELL_WRAPPERS]
    .some((table) => refusedRoot(table, root))) return false;
  if (claudeRuleRunsAnyCommand(parsed.tokens)) return false;
  if (!reviewed && !prefixIsAutoSuffixClosed(parsed.tokens)) return false;
  if (parsed.tokens.length === 1) {
    const automatic = parsed.tool === 'PowerShell'
      ? CLAUDE_SAFE_POWERSHELL_ROOTS : CLAUDE_SAFE_BASH_ROOTS;
    if (automatic.has(root)) return true;
    return reviewed && CLAUDE_REVIEWABLE_ROOTS.has(root);
  }
  if (root === 'git' || root === 'git.exe') {
    return SAFE_GIT_READ_SUBCOMMANDS.has(parsed.tokens[1].toLowerCase());
  }
  return !prefixIsKnownRisky(parsed.tokens);
}

// The learner's reasons for withholding a Claude rule from a run it does NOT call complex
// (2026-10-14; candidateClaudePermission below has the history). Only one exists:
// `environment-not-stripped` on a family whose kept assignment cannot be written into its
// rule. Every other learner null comes with a complexity reason, which refuses the candidate
// outright. test/auto-learn-info-flags.test.js holds the learner to that, so a new
// non-complex withholding has to add its reason here or fail there.
const CLAUDE_WITHHOLDING_REASONS = new Set(['environment-not-stripped']);
function candidateWithholdsClaudeRule(candidate) {
  return (Array.isArray(candidate?.reasons) ? candidate.reasons : [])
    .some((reason) => CLAUDE_WITHHOLDING_REASONS.has(String(reason)));
}

function candidateClaudePermission(candidate, options) {
  if (typeof candidate === 'string') return candidate;
  const reviewed = options?.includeReviewed === true;
  // A tool family states its own rule or has none. Never synthesize a shell
  // rule from its prefix: 'Edit' is not a command root.
  if (candidate?.kind === 'tool') {
    return reviewed && typeof candidate.claudePermission === 'string'
      ? candidate.claudePermission : null;
  }
  if ((!isAutoSafe(candidate) && !reviewed) || candidateIsComplex(candidate) ||
      (!reviewed && (candidateRiskIsUnsafe(candidate) || candidateHasAutomaticBlock(candidate)))) return null;
  // An explicit `claudePermission: null` is a rule the learner WITHHELD only when the
  // candidate also carries the reason that withheld it (CLAUDE_WITHHOLDING_REASONS); any
  // other null is re-derived from the prefix below, as every null was through v1.6.1.
  //
  // Corrected 2026-10-14. a9e2adf (2026-10-13) honoured EVERY explicit null, on the premise
  // that `environment-not-stripped` was the first withholding reason that is not also a
  // complexity reason, every earlier one (path, quoted or dynamic executable, reserved word,
  // call operator, unknown family subcommand, a prefix conflict) making the candidate complex,
  // which the line above already refuses. That premise was false: the learner also nulled the
  // rule for an informational family, `[root, --version|--help|-h|-V]`, with `complex: false`,
  // because permissionFor would not write a non-bare word (src/auto-learn.js INFO_PREFIX_FLAGS
  // has the history). Reproduced against 9467b09 (v1.6.2): three successes each of `cargo
  // --version`, `df -h` and `git status` rendered `Bash(cargo --version *)`, `Bash(df -h *)` and
  // `Bash(git status *)` under review at c09daab (v1.6.1) and only `Bash(git status *)` at
  // v1.6.2, while the Codex half rendered all three in both. Worse, the state file already held
  // those families with the null v1.6.1 wrote, so the first v1.6.2 scan+apply dropped them from
  // the retained set (auto-learn-manager applyUnlocked asks claudeEligible again) and removed
  // the applied reviewed `Bash(cargo --version *)`, `Bash(df -h *)` and `Bash(docker --version
  // *)` from `allow`, in auto-safe mode with no user action. The learner writes those rules
  // itself now; this gate is what keeps the families already stored with a null rendering.
  //
  // What a9e2adf wanted still holds: an env-led run whose kept assignment the rule cannot
  // carry (`FOO="two words" git status`, redacted, or one ahead of a wrapper) is keyed apart
  // and carries the reason, so it does not re-acquire the `Bash(git status *)` Claude Code never
  // matches against it. A candidate built by hand, with no such field, is synthesized as before.
  if (candidate && Object.prototype.hasOwnProperty.call(candidate, 'claudePermission')
      && candidate.claudePermission === null && candidateWithholdsClaudeRule(candidate)) return null;
  if (typeof candidate.claudePermission === 'string') return candidate.claudePermission;
  if (typeof candidate.claude_permission === 'string') return candidate.claude_permission;

  const prefix = Array.isArray(candidate.claudePrefix) ? candidate.claudePrefix
    : Array.isArray(candidate.claude_prefix) ? candidate.claude_prefix
      : Array.isArray(candidate.prefix) ? candidate.prefix
    : null;
  const root = typeof candidate.root === 'string' ? candidate.root : prefix?.[0];
  const tokens = prefix && prefix.every((token) => typeof token === 'string') ? prefix.slice() : [root];
  if (!root || candidateIsWrapper(candidate, [root]) || candidateContainsSecret(candidate, tokens)) return null;

  let tool = candidate.tool;
  if (tool !== 'Bash' && tool !== 'PowerShell') {
    const shell = String(candidate.shell || '').toLowerCase();
    if (shell.includes('powershell') || shell === 'pwsh' || /^[A-Za-z]+-[A-Za-z]/.test(root)) tool = 'PowerShell';
    else if (shell.includes('bash') || shell.includes('sh') || !shell) tool = 'Bash';
    else return null;
  }
  return `${tool}(${tokens.join(' ')} *)`;
}

// `git status` and `git.exe status` are ONE family of evidence and TWO rules:
// `Bash(git status *)` does not match the command `git.exe status`, so a family
// that observed both spellings needs both entries or half its runs bought
// nothing. Only spellings the candidate actually recorded are emitted, and each
// one is put through the same safety gate as the primary. An alternate is a
// grant, not a formatting detail.
//
// An independent copy of `normalizePermissionSpelling` from `src/auto-learn.js`,
// for the same reason the root tables above are copied: this module is the last
// gate before a rule is written and takes no dependency on the learner it
// checks. `test/auto-learn-spellings.test.js` asserts the two agree, so a change to
// one that the other does not follow fails loudly instead of drifting.
// The command root is the first word that is not a kept assignment (an env-led rule keeps its
// assignment values verbatim, 2026-10-13), so `Bash(FOO=1 cat *)` and `Bash(FOO=1 cat.exe *)`
// reconcile like `Bash(git status *)` and `Bash(git.exe status *)`. An independent copy of the
// learner's commandRootIndex, by the same drift rule as the rest of this file.
const EXPORTER_PERMISSION_ROOT = /^([A-Za-z_][A-Za-z0-9_]*)\(([^\s)]+)([\s\S]*)\)$/;
function exporterCommandRootIndex(words) {
  return words.findIndex((word) => !word.includes('='));
}
function normalizePermissionSpelling(permission) {
  const text = String(permission == null ? '' : permission);
  const match = EXPORTER_PERMISSION_ROOT.exec(text);
  if (!match) return text;
  const words = `${match[2]}${match[3]}`.split(' ');
  const at = exporterCommandRootIndex(words);
  if (at >= 0) words[at] = words[at].replace(/\.exe$/i, '');
  return `${match[1]}(${words.join(' ')})`;
}

function alternateSpellings(candidate, primary) {
  if (!candidate || typeof candidate !== 'object' || typeof primary !== 'string') return [];
  const observed = Array.isArray(candidate.permissions) ? candidate.permissions : [];
  const identity = normalizePermissionSpelling(primary);
  return observed.filter((item) => typeof item === 'string' && item !== primary &&
    normalizePermissionSpelling(item) === identity);
}

function renderClaudePermissions(candidates, options = {}) {
  const permissions = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const rendered = candidateClaudePermission(candidate, options);
    if (candidate && typeof candidate === 'object' && candidate.kind === 'tool') {
      // Opaque, networked or disk-mutating by nature, so an explicit review is
      // the only route these ever take into policy.
      const tool = options?.includeReviewed === true ? parseToolPermission(rendered) : null;
      if (tool) permissions.add(tool.permission);
      continue;
    }
    const parsed = parseClaudePermission(rendered);
    if (!claudePermissionIsSafe(parsed, options)) continue;
    permissions.add(parsed.permission);
    for (const spelling of alternateSpellings(candidate, parsed.permission)) {
      const other = parseClaudePermission(spelling);
      if (claudePermissionIsSafe(other, options)) permissions.add(other.permission);
    }
  }
  return [...permissions].sort((a, b) => a.localeCompare(b));
}

// The vestigial third parameter is gone, and with it the only leg of this
// function no production input could reach.
//
// History: an overload shim re-read an OBJECT third argument as `options`, which
// no caller ever passed, and was removed. What survived was a `processAllowList`
// parameter that only a TEST ever filled — the single production call site,
// src/auto-learn-manager.js, spelled it `null`. So the normalization branch was
// dead in the product and alive only in the test that existed to cover it: a
// closed loop where the test proved the test.
//
// Both files are now in one pass, so the parameter is removed rather than
// documented again. `options` moves to the third position; there was no caller
// passing four arguments to break.
function mergeClaudeAllow(existing, candidates, options = {}) {
  const manual = Array.isArray(existing) ? existing.slice() : [];
  const generated = renderClaudePermissions(candidates, options);
  const seen = new Set(manual.filter((value) => typeof value === 'string'));
  for (const permission of generated) {
    if (!seen.has(permission)) {
      manual.push(permission);
      seen.add(permission);
    }
  }
  return manual;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markerMatches(text, marker) {
  const expression = new RegExp(`^${escapeRegex(marker)}[ \\t]*\\r?$`, 'gm');
  const matches = [];
  let match;
  while ((match = expression.exec(text))) {
    let lineEnd = match.index + match[0].length;
    if (text[lineEnd] === '\n') lineEnd++;
    matches.push({ start: match.index, end: lineEnd });
  }
  return matches;
}

function stripManagedMarkers(text) {
  const normalized = String(text).replace(/\r\n/g, '\n').trim();
  if (!normalized.startsWith(CODEX_BEGIN_MARKER) || !normalized.endsWith(CODEX_END_MARKER)) return normalized;
  return normalized
    .slice(CODEX_BEGIN_MARKER.length, -CODEX_END_MARKER.length)
    .replace(/^\s*\n?/, '')
    .replace(/\n?\s*$/, '');
}

function mergeGeneratedCodexRules(existingText, generatedText) {
  const existing = String(existingText == null ? '' : existingText);
  const generated = stripManagedMarkers(generatedText == null ? '' : generatedText);
  const validation = validateCodexRulesText(generated);
  if (!validation.valid) {
    throw new Error(`Refusing to merge invalid generated Codex rules: ${validation.errors.join('; ')}`);
  }

  const managedBlock = [CODEX_BEGIN_MARKER, generated.trimEnd(), CODEX_END_MARKER, ''].join('\n');
  const begins = markerMatches(existing, CODEX_BEGIN_MARKER);
  const ends = markerMatches(existing, CODEX_END_MARKER);
  if (begins.length !== ends.length || begins.length > 1) {
    throw new Error('Cannot merge Codex rules with unbalanced or duplicate generated markers');
  }
  if (begins.length === 1) {
    if (begins[0].start >= ends[0].start) throw new Error('Cannot merge Codex rules whose generated markers are out of order');
    return existing.slice(0, begins[0].start) + managedBlock + existing.slice(ends[0].end);
  }
  if (!existing) return managedBlock;
  const separator = existing.endsWith('\n') ? (existing.trim() ? '\n' : '') : '\n\n';
  return existing + separator + managedBlock;
}

// The inverse of `mergeGeneratedCodexRules`, and the only thing that may touch a
// rules file this tool no longer maintains.
//
// Codex WORKSPACE scope is withdrawn (see bin/wildcard-perms), so an older
// release may have left `<repo>/.codex/rules/permission-wildcarding.rules`
// behind. Deleting that file wholesale is not an option: a user is free to have
// added their own rules to it, and this tool's marker pair is the ONLY proof of
// what it wrote. So the ownership rule is the same one the retired Codex MAX
// cleanup uses — no proof of ownership, no write — and the remainder is handed
// back rather than discarded.
//
// Returns `changed: false` with a reason for every shape it will not touch. A
// cleanup that silently did nothing and a cleanup that silently did the wrong
// thing look identical to the caller otherwise.
// `remaining` and `markers` are gone from the shape. `remaining` was a
// byte-identical duplicate of `text` on every one of the four returns, and
// `markers` was a count nothing anywhere read. Two names for one string invites
// a caller to believe they differ, which is a worse failure than the keystrokes
// it saved.
function removeGeneratedCodexRules(existingText) {
  const existing = String(existingText == null ? '' : existingText);
  const begins = markerMatches(existing, CODEX_BEGIN_MARKER);
  const ends = markerMatches(existing, CODEX_END_MARKER);
  if (!begins.length && !ends.length) {
    return { changed: false, text: existing, reason: 'no generated block' };
  }
  if (begins.length !== ends.length || begins.length > 1) {
    return {
      changed: false, text: existing,
      reason: 'unbalanced or duplicate generated markers',
    };
  }
  if (begins[0].start >= ends[0].start) {
    return {
      changed: false, text: existing,
      reason: 'generated markers are out of order',
    };
  }
  const remaining = existing.slice(0, begins[0].start) + existing.slice(ends[0].end);
  return { changed: true, text: remaining, empty: remaining.trim() === '' };
}

module.exports = {
  renderCodexRules,
  validateCodexRulesText,
  renderClaudePermissions,
  mergeClaudeAllow,
  mergeGeneratedCodexRules,
  removeGeneratedCodexRules,
  CODEX_BEGIN_MARKER,
  // Exported so the drift test can assert this gate and the learner's
  // independent copy still describe the same set.
  AUTO_SUFFIX_CLOSED_ROOTS,
  AUTO_SAFE_GIT_SUBCOMMANDS,
  normalizePermissionSpelling,
  // Consumed by src/auto-learn-manager.js (takeExporterRule, 2026-10-14): a family stored with a
  // null rule is given the rule this function derives for the write, so the manager's managed and
  // user-deny checks judge the rule that lands rather than the null.
  candidateClaudePermission,
};
