'use strict';

// Cross-agent policy exporters for Auto Learn. The learner emits a neutral
// candidate; these exporters are the final safety boundary before it becomes a
// Claude wildcard or a Codex executable-policy rule.

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
// form such as `Bash(just --version *)`, as for every wrapper here.
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
const OWN_SHELL_WRAPPERS = [
  'bash', 'bash.exe', 'cmd', 'cmd.exe', 'command.com', 'dash', 'dash.exe',
  'duckdb', 'duckdb.exe', 'fish', 'fish.exe', 'hyperfine', 'hyperfine.exe',
  'just', 'just.exe', 'ksh', 'ksh.exe', 'make', 'make.exe', 'powershell',
  'powershell.exe', 'pwsh', 'pwsh.exe', 'sh', 'sh.exe', 'wsl', 'wsl.exe',
  'zsh', 'zsh.exe',
  ...['busybox', 'builtin', 'chroot', 'chrt', 'doas', 'firejail', 'flock', 'gdb', 'ionice',
    'ltrace', 'nice', 'nocorrect', 'noglob', 'nohup', 'nsenter', 'pkexec', 'runas', 'runuser',
    'script', 'setsid', 'stdbuf', 'strace', 'su', 'sudo', 'systemd-run', 'taskset', 'time',
    'timeout', 'unshare', 'valgrind', 'watch'].flatMap((root) => [root, `${root}.exe`]),
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
INLINE_CODE_FLAGS.set('python3', INLINE_CODE_FLAGS.get('python'));
INLINE_CODE_FLAGS.set('py', INLINE_CODE_FLAGS.get('python'));

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
// chroot's NEWROOT, taskset's mask, chrt's priority). The option lists are each tool's
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
  strace: { flagPattern: /^-[cCdDfFhiknqrtTvVwxyzZ]+$/,
    values: ['-e', '-o', '-p', '-s', '-E', '-P', '-S', '-a', '-b', '-I', '-u', '-X', '-O', '-U', '--output', '--trace',
      '--expr', '--attach', '--string-limit', '--env', '--trace-path', '--columns', '--user'],
    fused: /^(?:-[eopsEPSabIuXOU].|--[a-z-]+=)/ },
  ltrace: { flagPattern: /^-[bcCfhiLrSStTV]+$/,
    values: ['-a', '-A', '-e', '-l', '-n', '-o', '-p', '-s', '-u', '-x', '-D', '-F', '-w', '--align', '--config',
      '--indent', '--library', '--output', '--where'],
    fused: /^(?:-[aAelnopsuxDFw].|--[a-z-]+=)/ },
  valgrind: { flagPattern: /^(?:-[vqd]+|--[a-z0-9-]+(?:=.*)?)$/ },
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
const ALWAYS_BROAD_WRAPPERS = new Set([
  'doas', 'eval', 'firejail', 'gdb', 'pkexec', 'runas', 'runuser', 'script', 'su', 'sudo', 'systemd-run', 'watch',
]);

// The prefix after an exec wrapper's options and operands: possibly empty, `LOOKUP` for
// `command -v`, or null when an option is unknown or the "command" is an option.
function execWrapperInner(base, prefix) {
  const grammar = EXEC_WRAPPER_GRAMMAR.get(base);
  const flags = new Set(grammar.flags || []);
  const values = new Set(grammar.values || []);
  let k = 1;
  for (; k < prefix.length; k += 1) {
    const token = String(prefix[k]);
    if (token === '--') { k += 1; break; }
    if (!token.startsWith('-') || token === '-') break;
    if (grammar.lookup?.test(token)) return LOOKUP;
    if (flags.has(token) || grammar.flagPattern?.test(token)) continue;
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

function wrapperIsBroad(prefix) {
  const root = canonicalRoot(prefix?.[0]);
  if (!SHELL_WRAPPERS.has(root)) return false;
  if (prefix.length === 1) return true;
  const base = root.replace(/\.(?:exe|cmd)$/, '');
  if (INLINE_CODE_FLAGS.has(base) && prefix.slice(1).some((token) => INLINE_CODE_FLAGS.get(base)(String(token)))) {
    return true;
  }
  // xargs execs the named command directly, with no shell, so `["xargs", "rm"]` is no
  // broader than `["rm"]` with arguments read from stdin, which a reviewer may already
  // approve; `["xargs", "sh"]` is as broad as `["sh"]`. Hence the recursion. A prefix that
  // ends before naming a command (`["xargs", "-0"]`, `["env", "FOO=1"]`) runs anything.
  if (base === 'env' || base === 'xargs') {
    const inner = innerCommandPrefix(base, prefix);
    return inner === null || inner.length === 0 || wrapperIsBroad(inner);
  }
  // The process and exec wrappers, by the same rule (EXEC_WRAPPER_GRAMMAR above), and the
  // ones no named command can narrow (ALWAYS_BROAD_WRAPPERS).
  if (ALWAYS_BROAD_WRAPPERS.has(base)) return true;
  if (EXEC_WRAPPER_GRAMMAR.has(base)) {
    const inner = execWrapperInner(base, prefix);
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
  if (['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(root)) {
    if (['-c', '-command', '-encodedcommand', '-enc'].includes(second)) return true;
    return !['-file', '-f'].includes(second) || prefix.length < 3;
  }
  if (['bash', 'bash.exe', 'dash', 'dash.exe', 'fish', 'fish.exe', 'ksh', 'ksh.exe', 'sh', 'sh.exe', 'zsh', 'zsh.exe'].includes(root)) {
    return ['-c', '-lc'].includes(second);
  }
  return prefix.length < 2;
}

function candidateIsWrapper(candidate, prefix) {
  return Boolean(candidate?.wrapper || candidate?.isWrapper || candidate?.is_wrapper ||
    SHELL_WRAPPERS.has(canonicalRoot(prefix?.[0])));
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

function prefixIsKnownRisky(prefix) {
  if (!Array.isArray(prefix) || prefix.length === 0) return true;
  const root = canonicalRoot(prefix[0]);
  if (DESTRUCTIVE_OR_ADMIN_ROOTS.has(root) || NETWORK_OR_INSTALL_ROOTS.has(root) ||
      STATE_MUTATING_ROOTS.has(root)) return true;
  if (root === 'git' || root === 'git.exe') {
    return prefix.length < 2 || !SAFE_GIT_READ_SUBCOMMANDS.has(String(prefix[1]).toLowerCase());
  }
  if (root === 'rg' || root === 'rg.exe') {
    return prefix.length < 2 || !SAFE_RG_PREFIXES.has(String(prefix[1]));
  }
  if (prefix.length === 1 && [
    'docker', 'docker.exe', 'node', 'node.exe', 'perl', 'perl.exe', 'py',
    'py.exe', 'python', 'python.exe', 'python3', 'python3.exe', 'ruby',
    'ruby.exe',
  ].includes(root)) return true;
  return false;
}

function candidateEligibleForCodex(candidate, options) {
  const reviewed = options?.includeReviewed === true;
  if ((!isAutoSafe(candidate) && !reviewed) || candidateIsComplex(candidate)) return null;
  const prefix = normalizePrefix(candidate);
  if (!prefix || candidateContainsSecret(candidate, prefix)) return null;
  if (candidateIsWrapper(candidate, prefix)) {
    if (!reviewed || wrapperIsBroad(prefix)) return null;
  }
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

  const root = canonicalRoot(pattern[0]);
  const second = pattern.length > 1
    ? (Array.isArray(pattern[1]) ? pattern[1] : [pattern[1]]).map((value) => String(value).toLowerCase())
    : [];
  if (['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(root) &&
      (pattern.length === 1 || (pattern.length === 2 && second.some((value) => ['-c', '-command'].includes(value))))) {
    errors.push(`Rule ${number}: broad PowerShell command prefix is forbidden`);
  }
  if (pattern.length === 1 && ['curl', 'curl.exe', 'py', 'py.exe', 'python', 'python.exe', 'python3', 'python3.exe'].includes(root)) {
    errors.push(`Rule ${number}: bare ${root} prefix is too broad`);
  }
  if ((root === 'git' || root === 'git.exe') && pattern.length === 1) errors.push(`Rule ${number}: bare git prefix is too broad`);
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

function claudePermissionIsSafe(parsed, options) {
  const reviewed = options?.includeReviewed === true;
  if (!parsed || parsed.root === '&') return false;
  const root = parsed.root.toLowerCase();
  if (DESTRUCTIVE_OR_ADMIN_ROOTS.has(root) || NETWORK_OR_INSTALL_ROOTS.has(root) ||
      STATE_MUTATING_ROOTS.has(root) || SHELL_WRAPPERS.has(root)) return false;
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
const EXPORTER_PERMISSION_ROOT = /^([A-Za-z_][A-Za-z0-9_]*)\(([^\s)]+)([\s\S]*)\)$/;
function normalizePermissionSpelling(permission) {
  const text = String(permission == null ? '' : permission);
  const match = EXPORTER_PERMISSION_ROOT.exec(text);
  if (!match) return text;
  return `${match[1]}(${match[2].replace(/\.exe$/i, '')}${match[3]})`;
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
};
