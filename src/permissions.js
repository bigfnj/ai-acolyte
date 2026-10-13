'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ruleMatches, sameRule } = require('./permission-match');

// Rename codes that are transient on Windows: another process (Claude Code
// writing settings.json, Defender/Search indexer scanning the temp file, or a
// second wildcarding writer) held a handle at the instant of the atomic swap.
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ETXTBSY']);

// Block the calling thread briefly without a dependency. Only hit on the rare
// Windows EPERM retry path, so the short stall is acceptable.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Atomically replace `target` with `content`.
//
// On Windows, fs.renameSync maps to MoveFileEx(REPLACE_EXISTING), which fails
// with EPERM/EACCES/EBUSY whenever another process holds the destination (or
// the newly written temp) open — a structural race here because Claude Code
// itself writes settings.json, and that write is what triggers wildcarding.
// Retry the rename with backoff (as write-file-atomic / graceful-fs do), then
// fall back to an in-place write so a transient lock never silently drops the
// update. Cleans up its own temp file on every path.
function writeFileAtomicSync(target, content) {
  // Unique per-writer temp name so the hook and the VS Code extension (or two
  // extension hosts) never collide on one shared *.wc.tmp.
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.wc.tmp`;
  // The ONE path that could leave the temp behind. Everything after this line
  // either renames the file away or reaches the unlink in the in-place
  // fallback's finally, so the loop below and the fallback were already covered
  // and this was not. `fs.writeFileSync` CREATES the file before it writes, so a
  // throw part-way through — ENOSPC, EDQUOT, EACCES on a hardened directory, EIO
  // — leaves a partial `<target>.<pid>.<rand>.wc.tmp` next to settings.json
  // forever, with a name nothing ever cleans up and a shape that looks like the
  // user's own settings to anything globbing the directory.
  //
  // src/auto-learn-manager.js:133-162 is the shape being copied: every exit
  // unlinks. The throw still propagates unchanged — this is a cleanup, not a
  // swallow, and the caller's error handling is the contract.
  try {
    fs.writeFileSync(tmp, content, 'utf8');
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never created, or already gone */ }
    throw err;
  }

  const MAX_ATTEMPTS = 10;
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE_RENAME_CODES.has(err.code)) break;
      // No sleep after the LAST attempt: nothing follows it to retry, so the final
      // 200ms bought nothing and was a fifth of the 1.1s worst case. That window is
      // Atomics.wait, an unyieldable thread block, and in the extension it blocks the
      // extension-host thread, which is why the fixed-point cache uses a plain write.
      if (attempt < MAX_ATTEMPTS - 1) sleepSync(20 * (attempt + 1)); // 20,40,…,180ms
    }
  }

  // Rename kept failing: the target stayed held for the whole window. Write in
  // place as a last resort — non-atomic, but settings.json is small and losing
  // the update is worse than a brief window where a reader might see a partial
  // file (both readers here already tolerate a failed parse).
  // lastErr was assigned on every failed attempt and read on NO path, so a
  // non-retryable rename failure fell silently into the in-place write with the
  // original cause discarded. Say what went wrong: this is the branch where the
  // atomic guarantee was given up, and it should not be silent about why.
  // Unconditional, and it used to be guarded by `if (lastErr)`, which no reachable input
  // could make false: both exits from the loop run the catch above, so lastErr is always set.
  process.emitWarning(`writeFileAtomicSync: rename failed (${lastErr.code || lastErr.message}), `
    + 'wrote in place instead', 'PermissionWildcardingAtomicFallback');
  try {
    fs.writeFileSync(target, content, 'utf8');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// ── generalization ────────────────────────────────────────────────────────────
//
// Design (v1.3+): collapse every command-tool approval to its command ROOT
// (depth-1), so one approval silences that command everywhere — including inside
// compound commands and pipelines, which Claude Code decomposes and checks per
// sub-command. There are no per-command depth rules and no noGeneralize
// carve-outs: destructive commands wildcard like everything else. The safety
// boundary is `permissions.deny` (always wins, evaluated per sub-command), not
// this generalizer. Both Bash(...) and PowerShell(...) are generalized.
//
// What is never generalized is a line with no command root to key on: a shell
// keyword, an expansion, a subshell, a range literal. That is not a carve-out
// for a dangerous command, it is the absence of a command, and wildcarding it
// grants whatever the shell later decides to run (bashOpensScript, below).

// Tools whose argument is a shell command line we key on by its first token.
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
const MIXED_FAMILY_ROOTS = new Set([
  'cargo', 'choco', 'docker', 'dotnet', 'gh', 'git', 'go', 'helm', 'kubectl',
  'npm', 'npx', 'pip', 'pip3', 'pnpm', 'winget', 'yarn',
]);

// PowerShell tokens that begin a script construct rather than a plain command.
// A first-token wildcard on these is meaningless, so we leave them verbatim.
//
// The second row was added 2026-10-13 so this set covers every word in the
// classifier's POWERSHELL_RESERVED (src/auto-learn.js). Before, `exit 1`,
// `throw "x"` or `data { ... }` generalized to `PowerShell(exit *)` and the like:
// a rule the classifier itself refuses to propose (`reserved-keyword` blocks the
// permission), minted by this pass from one exact approval. None of them can run
// a program by itself, so the cost was a nonsense grant rather than a dangerous
// one; zero such entries were on the development box's allow list that day.
// The set is a COPY, not an import (see BASH_SCRIPT_KEYWORDS below), and
// test/permissions-keywords.test.js fails if the classifier gains a word it lacks.
const PS_SCRIPT_KEYWORDS = new Set([
  'foreach', 'for', 'if', 'while', 'do', 'switch', 'try', 'function', 'filter',
  'begin', 'process', 'end', 'param', 'return', 'trap', 'class', 'enum', 'using',
  'break', 'catch', 'continue', 'data', 'dynamicparam', 'else', 'elseif', 'exit',
  'finally', 'from', 'in', 'throw', 'until', 'workflow',
]);

// True when the wildcard is a trailing scope wildcard, i.e. the arg already ends
// in `*` ("git *", "ext=\"/c/…\" *", "Read(*)"). Claude Code writes these itself
// for prefix-style approvals; they are already generalized, and re-tokenizing a
// quoted path here would shatter it into junk ("\"/c/Program *"). Leave them.
function isScopeWildcarded(arg) {
  return /\*\s*$/.test(arg);
}

// Strip leading `VAR=value` environment prefixes (quoted or bare) so the command
// itself is what we key on. "GITHUB_TOKEN=xxx git push" → "git push";
// "CUDA_HOME=/usr/local/cuda nvcc x.cu" → "nvcc x.cu".
function stripEnvPrefixes(cmd) {
  const re = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/;
  let rest = cmd.trim();
  while (re.test(rest)) rest = rest.replace(re, '');
  return rest;
}

// Claude Code's process wrappers, stripped from a Bash entry so the rule keys on the
// command that actually runs. What decides this is how Claude Code MATCHES, and it is
// documented (code.claude.com/docs/en/permissions, "Wrappers", read 2026-10-13):
// "Before matching Bash rules, Claude Code strips a fixed set of wrappers, so a rule
// like `Bash(npm test *)` also matches `timeout 30 npm test`. The stripped wrappers are
// `timeout`, `time`, `nice`, `nohup`, and `stdbuf`, plus the shell builtins `command`
// and `builtin`, and zsh's `noglob`." Not stripped: the query form `command -v`, and
// zsh's `nocorrect`. "Bare `xargs` is also stripped ... only when `xargs` has no
// flags." The list "is built in and is not configurable". The shapes accepted below
// are the ones the wrapper routine in the shipped CLI accepts (read out of Claude Code
// 2.1.296's binary the same day): a `timeout` duration `^\d+(\.\d+)?[smhd]?$` after
// its documented options, `nice -n N` or `nice -N`, `stdbuf` with at least one
// `-i`/`-o`/`-e` mode, `command` with `-p` only. A shape outside those is one that
// routine reports it "can't be checked before it runs", so it is not stripped here
// either and the entry stays verbatim.
//
// Until 2026-10-13 this pass keyed on the wrapper itself: `timeout 5 rg x` became
// `Bash(timeout *)` and `nohup make` became `Bash(nohup *)`, while the classifier
// (src/auto-learn.js deriveBaseInvocation) already stripped `timeout`, `command` and
// `builtin`. Keying on the inner command is right under either reading of the
// matcher. The docs say the inner rule matches the wrapped run, so `Bash(rg *)`
// covers `timeout 5 rg x`. And `Bash(timeout *)` is aimed at text Claude Code has
// already removed: dead weight if only the stripped command is checked, or, if the
// raw text were checked as well, a grant for every command `timeout` can run, the
// rule the classifier refuses to propose for exactly that reason.
//
// `env` is NOT stripped, deliberately: the documented list does not name it (only "a
// leading assignment of certain known-safe environment variables" is stripped), so
// `env FOO=1 make` still collapses to `Bash(env *)`, a runner root treated like
// `bash` by this section's design. Stripping a wrapper Claude Code keeps would be the
// worse error: the rule would never match, the next run would prompt, and this pass
// would generalize the fresh approval away again, every time. The same binary routine
// does have an `env` branch, but nothing documents it on the allow path. Bash only:
// the docs scope this to Bash rules, and `timeout` in PowerShell is timeout.exe, the
// Windows sleep utility, not a wrapper.
const TIMEOUT_DURATION = /^\d+(?:\.\d+)?[smhd]?$/;
const TIMEOUT_VALUE = /^[A-Za-z0-9_.+-]+$/;

// How many leading tokens the wrapper at tokens[0] occupies, itself included: 0 when
// tokens[0] is not a stripped wrapper (including `command -v`, matched as itself, and
// `xargs` with a flag), -1 when it is one but in a shape that is not stripped.
function wrapperLength(tokens) {
  const at = (k) => tokens[k];
  switch (tokens[0]) {
    case 'time': case 'nohup': case 'noglob': return 1;
    case 'builtin': return at(1) === '--' ? 2 : 1;
    case 'nice':
      if (at(1) === '-n' && /^-?\d+$/.test(at(2) || '')) return 3;
      return /^-\d+$/.test(at(1) || '') ? 2 : 1;
    case 'timeout': {
      let k = 1;
      for (let g = at(k); g !== undefined; g = at(k)) {
        if (['--foreground', '--preserve-status', '--verbose', '-v'].includes(g)) k += 1;
        else if (/^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/.test(g) || /^-[ks][A-Za-z0-9_.+-]+$/.test(g)) k += 1;
        else if (['--kill-after', '--signal', '-k', '-s'].includes(g) && TIMEOUT_VALUE.test(at(k + 1) || '')) k += 2;
        else if (g.startsWith('-')) return -1;
        else break;
      }
      return TIMEOUT_DURATION.test(at(k) || '') ? k + 1 : -1;
    }
    case 'stdbuf': {
      let k = 1;
      for (let g = at(k); g !== undefined; g = at(k)) {
        if (/^-[ioe]$/.test(g) && at(k + 1) !== undefined) k += 2;
        else if (/^-[ioe]./.test(g) || /^--(?:input|output|error)=/.test(g)) k += 1;
        else if (g.startsWith('-')) return -1;
        else break;
      }
      return k > 1 ? k : -1;
    }
    case 'command': {
      let k = 1;
      for (let g = at(k); g !== undefined && g.startsWith('-') && g !== '--'; g = at(k)) {
        if (!/^-[pvV]+$/.test(g)) return -1;
        if (/[vV]/.test(g)) return 0;
        k += 1;
      }
      return at(k) === '--' ? k + 1 : k;
    }
    case 'xargs': return at(1) !== undefined && !at(1).startsWith('-') ? 1 : 0;
    default: return 0;
  }
}

// The command a Bash line runs once every leading wrapper is removed, as a SUFFIX of
// `text` (bashOpensScript measures the stripped prefix by length, so it must be one),
// or null when a wrapper is present in a shape that is not stripped, or wraps nothing.
// An inner token that starts with `-` is what the CLI calls "an incomplete fragment"
// (`time -p make`, `nice --adjustment=5 make`), and is refused the same way.
function stripBashWrappers(text) {
  let rest = text;
  for (let guard = 0; guard < 8; guard += 1) {
    const tokens = [...rest.matchAll(/\S+/g)];
    const consumed = tokens.length ? wrapperLength(tokens.map((m) => m[0])) : 0;
    if (consumed === 0) return rest;
    if (consumed < 0 || consumed >= tokens.length || tokens[consumed][0].startsWith('-')) return null;
    rest = rest.slice(tokens[consumed].index);
  }
  return null;
}

// Characters that make a Bash first token something other than a literal command
// name: an expansion (`$VAR`, `${X}`, `$(cmd)`, a backtick), a grouping or
// subshell opener (`{`, `(`, `((i++))`), an operator fused onto a word (`a;b`,
// `x|y`, `<in`), negation or history (`!`), a pathname glob (`g*`, `?`) and an
// inner quote (`a"b c"`). In every one of these the program that runs is decided
// when the shell expands the line, not by the text the rule would name, so
// `Bash(<token> *)` grants whatever the expansion produces. A leading `#` is a
// comment, which runs nothing and so names nothing. `[` alone is NOT here: it is
// the `test` builtin, a fixed-purpose command, and is wildcarded like `test`.
const BASH_NON_WORD = /^#|[$`(){};|&<>!*?"']/;
const BASH_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// True when a Bash entry opens with something that is not a command, so the
// first-token wildcard below would mint a grant for shell grammar instead of for
// a program. Reported 2026-10-13: `Bash(for f in a b)` became `Bash(for *)`,
// `Bash(if …)` became `Bash(if *)` and `Bash($EDITOR x)` became `Bash($EDITOR *)`,
// although the comment above BASH_SCRIPT_KEYWORDS already said `for` must not seed
// `Bash(for *)`. That set was consulted only by src/local-settings.js; the
// generalizer never read it. Measured that day with src/permission-match.js, the
// repo's one model of Claude Code's matcher: `Bash(for *)` covers
// `Bash(for f in *; do rm -rf "$f"; done)`, `Bash(if *)` covers
// `Bash(if true; then curl x | sh; fi)`, and processAllowList then PRUNES every
// other exact loop on the list as covered, so one approved loop became a grant for
// every loop. Claude Code's own splitter checks the segments of a compound line
// separately (docs/claude-code-permissions.md section 2), which bounds that when a
// loop is split, but this pass would just as readily turn an approved `do X`
// segment into `Bash(do *)`. No model of the splitter exists in the repo, so that
// half is inferred. Neither shape was on the development box's list that day.
//
// The env-assignment prefix is still stripped first, deliberately unchanged:
// Claude Code strips a leading `VAR=value` before matching (documented, and
// relied on in src/auto-learn.js), so `FOO=1 git status` generalizes to
// `Bash(git status *)`, which permission-match.js confirms matches the command
// Claude Code actually checks, `git status`. What that strip cannot vouch for is
// an assignment whose VALUE holds an expansion: the strip regex takes `\S*`, so
// `FOO=$(rm -rf ~) git status` splits inside the substitution and the derived
// "root" is `-rf`. Those, and an assignment with no command after it at all
// (`Bash(FOO=bar)`, which used to become `Bash(FOO=bar *)`), stay verbatim.
function bashOpensScript(arg, stripped, first) {
  if (BASH_SCRIPT_KEYWORDS.has(first.toLowerCase())) return true;
  if (BASH_NON_WORD.test(first) || BASH_ASSIGNMENT.test(first)) return true;
  const envPrefix = arg.trim().slice(0, arg.trim().length - stripped.length);
  return /\$[({]|`/.test(envPrefix);
}

// Generalize a shell command to a root wildcard, retaining one subcommand for
// mixed-capability dispatchers such as git and package managers.
function generalizeCommandArg(arg, tool) {
  // Env prefixes first, then Claude Code's wrappers (above), so `FOO=1 timeout 5 rg x`
  // keys on `rg`. A wrapper in a shape that is not stripped leaves the entry verbatim.
  const stripped = tool === 'Bash' ? stripBashWrappers(stripEnvPrefixes(arg)) : stripEnvPrefixes(arg);
  if (stripped === null) return `${tool}(${arg})`;
  // A quoted/path executable cannot be represented safely by the legacy
  // first-token wildcard. Leave it exact; Auto Learn can review a normalized
  // family without ever producing malformed `"C:\Program *` permissions.
  if (/^["']/.test(stripped) || /^(?:\.{0,2}[\\/]|[A-Za-z]:[\\/])/.test(stripped)) {
    return `${tool}(${arg})`;
  }
  const first = stripped.split(/\s+/)[0] || '';
  if (!first) return `${tool}(${arg})`; // nothing to key on — leave verbatim
  // PowerShell never reaches this with a non-command first token: its caller
  // admits only `[\w.-]` names (isPowerShellCommandName: a letter first, or a digit
  // that does not make a number) outside PS_SCRIPT_KEYWORDS. Bash had no
  // such gate, so it gets one here, and only Bash: `select` and `set` are
  // ordinary PowerShell aliases (Select-Object, Set-Variable), not keywords.
  if (tool === 'Bash' && bashOpensScript(arg, stripped, first)) return `${tool}(${arg})`;
  const parts = stripped.split(/\s+/);
  // `command -v` / `-V` is the one `command` form Claude Code does not strip: it looks
  // a name up and runs nothing. It keeps its flags, as a mixed-family root keeps its
  // subcommand, so the grant is the lookup rather than `Bash(command *)`, whose reach
  // depends on the very stripping question the wrapper comment above settles.
  if (tool === 'Bash' && first === 'command' && /^-[pvV]+$/.test(parts[1] || '')) {
    let end = 1;
    while (/^-[pvV]+$/.test(parts[end] || '')) end += 1;
    return `${tool}(command ${parts.slice(1, end).join(' ')} *)`;
  }
  const normalized = first.toLowerCase().replace(/\.(?:cmd|exe)$/i, '');
  if (MIXED_FAMILY_ROOTS.has(normalized)) {
    const subcommand = parts[1] || '';
    if (!/^[A-Za-z0-9][\w.-]*$/.test(subcommand)) return `${tool}(${arg})`;
    return `${tool}(${first} ${subcommand} *)`;
  }
  return `${tool}(${first} *)`;
}

// A PowerShell token that starts with a digit is a NUMBER when it is a numeric
// literal, and the statement is then an expression that runs nothing: `42`, `1.5`,
// `0x1F`, `0b101`, `1e3`, `10kb`, `5l`, `2d`. A range literal (`1..6`) is an
// expression too. Any other digit-leading token in command position is a command
// name, so `7z a x.zip` runs 7z. Until 2026-10-13 the gate below admitted only an
// `[A-Za-z]` first character, so `PowerShell(7z a x.zip)` stayed exact while
// `Bash(7z a x.zip)` became `Bash(7z *)`. The classifier settled the same question
// that day (commit 3ebbf04, POWERSHELL_RANGE_LITERAL in src/auto-learn.js): only the
// range literal is script syntax, and `7z` keeps its root. This pass refuses a little
// more, every numeric literal and not only the range, because a wildcard on `42`
// names no program either.
const PS_NUMERIC_LITERAL =
  /^(?:0x[0-9a-f]+|0b[01]+|\d+(?:\.\d*)?(?:e[+-]?\d+)?)(?:u?[ysl]|u|n|d)?(?:kb|mb|gb|tb|pb)?$/i;
function isPowerShellCommandName(first) {
  if (/^[A-Za-z][\w.-]*$/.test(first)) return true;
  return /^\d[\w.-]*$/.test(first) && !first.includes('..') && !PS_NUMERIC_LITERAL.test(first);
}

// Generalize a PowerShell arg. The `& "app.exe" …` call form collapses to a
// single "run any & invocation" wildcard; plain command/cmdlet names collapse to
// their root; script-like constructs (variables, keywords, subexpressions) are
// left verbatim because a first-token wildcard would be nonsense there.
function generalizePowerShellArg(arg) {
  const t = arg.trim();
  // `&` can launch any dynamically chosen executable. A root-wide call-
  // operator wildcard is effectively arbitrary execution, so keep it exact.
  if (/^&\s/.test(t)) return `PowerShell(${arg})`;
  const first = t.split(/\s+/)[0] || '';
  const isSimpleCommand =
    isPowerShellCommandName(first) && !PS_SCRIPT_KEYWORDS.has(first.toLowerCase());
  return isSimpleCommand ? generalizeCommandArg(arg, 'PowerShell') : `PowerShell(${arg})`;
}

// Generalize a single permission entry.
function generalizePermission(perm) {
  const m = perm.match(/^([A-Za-z][A-Za-z0-9:_-]*)\((.+)\)$/s);
  if (!m) return perm; // bare tool (WebSearch), mcp__server__tool, or odd format

  const [, tool, arg] = m;
  if (isScopeWildcarded(arg)) return perm; // already a trailing-scope wildcard
  if (!COMMAND_TOOLS.has(tool)) return perm; // Read / Edit / WebFetch / Skill / …

  return tool === 'PowerShell'
    ? generalizePowerShellArg(arg)
    : generalizeCommandArg(arg, tool);
}

// Bash reserved words / shell grammar that can begin a line but are not commands
// to wildcard (`for i in …` must not seed `Bash(for *)`). PowerShell's equivalents
// are already handled by generalizePowerShellArg via PS_SCRIPT_KEYWORDS.
//
// Until 2026-10-13 that sentence was a claim about nothing: generalizeCommandArg
// never consulted this set, so `for i in …` DID seed `Bash(for *)`. It consults
// it now, through bashOpensScript above. The last row was added the same day so the set
// covers every word in the classifier's BASH_RESERVED (src/auto-learn.js) except
// `source` and `[`, which are commands rather than grammar: `source` is the `.`
// script runner, wildcarded like `bash` and `sh` by this pass's design (see the
// header of this section), and `[` is `test`. `trap` is the one with teeth, since
// its argument is code run later, the same class as `eval`, which was already
// here. `export` and `readonly` join `declare`, `typeset` and `local`, which
// were. `(`, `((` and `[[` open a subshell, arithmetic and a conditional.
// test/permissions-keywords.test.js holds the exemption list and fails if the
// classifier gains a word this set lacks.
//
// `time` stays here although it is also one of Claude Code's stripped wrappers.
// stripBashWrappers runs first (2026-10-13), so `time make` keys on `make`, and a
// bare `time` or `time -p make` is left verbatim by the strip itself. What this entry
// still decides: a case variant the strip does not take (`Time make`), and
// src/local-settings.js refusing to promote an existing `Bash(time *)`.
//
// A COPY, not an import of BASH_RESERVED, and that is load-bearing.
// src/fixed-point-cache.js keys its "already a fixed point" verdict on the stat
// of exactly two files, this one and permission-match.js, and records that
// nothing else feeds processAllowList. Reading a set out of auto-learn.js would
// make a classifier edit change what this pass emits while the cache, seeing
// neither file move, kept answering HIT, and a spurious hit skips a due
// generalization silently, forever. It would also put the learner's require
// chain on the hook path, which bin/wildcard-perms keeps lean on purpose.
//
// Exported for src/local-settings.js, which applies the same test when deciding
// whether a project-local approval is portable enough to promote. That and
// bashOpensScript are its two consumers.
// `mineWildcard` used to sit directly below this set and
// apply it too — a "legacy history-mining compatibility helper" that turned a
// command string into `Tool(root *)` for a caller that no longer exists. It is
// deleted rather than merely unexported, because nothing in src/, bin/,
// vscode-extension/, scripts/ or test/ referenced it at all: not a destructure,
// not a namespace member access, not even inside this file. Cross-agent Auto
// Learn does that job in its own modules, and `promotionFor` in
// local-settings.js is the live version of the same idea, portability bar and
// all.
const BASH_SCRIPT_KEYWORDS = new Set([
  'for', 'while', 'until', 'do', 'done', 'if', 'then', 'elif', 'else', 'fi',
  'case', 'esac', 'select', 'function', 'time', 'coproc', 'in',
  'declare', 'typeset', 'local', 'set', 'unset', 'eval', 'exec',
  '!', '{', '}', '(', '((', '[[', 'export', 'readonly', 'return', 'trap',
]);

// Returns true if `specific` is fully matched by `wildcard` (glob: * = anything).
function isCoveredBy(specific, wildcard) {
  // Identity is not coverage, and `Tool(cmd:*)` is the same rule as
  // `Tool(cmd *)`, so the two spellings are identity too rather than one
  // covering the other.
  if (sameRule(specific, wildcard)) return false;
  return ruleMatches(wildcard, specific);
}

// ── coverage index ────────────────────────────────────────────────────────────
//
// The two coverage scans below were 99.8% of processAllowList, which the hook
// pays on every tool call: 348,588 RegExp.test() calls per pass at 423 entries,
// ~52 ms of a 56 ms pass, and quadratic on a list that only ever grows
// (measured BEFORE this index: 100 entries 3.0 ms, 423 entries 52.7 ms, 841
// entries 254.2 ms).
//
// THOSE ARE THE "BEFORE" NUMBERS AND THEY ARE NO LONGER WHAT THIS COSTS. With the
// index in place, measured 2026-09-10 cold in a fresh process: 8.1 ms at 430
// entries. Left in place because they are the justification for the index
// existing, but labelled — an unlabelled 52-254 ms already misled a reviewer into
// sizing a concurrency window at 60 ms when it is 10 ms, which changed the design
// they recommended.
//
// This index does NOT reimplement matching. It NARROWS the candidate set, and
// `isCoveredBy` — untouched — still decides every answer. So a false positive
// costs one extra regex and changes nothing, and only a false NEGATIVE could
// alter a result. That asymmetry is the whole safety argument, and it is why the
// differential test in test/cover-index.test.js can assert byte-identical
// cover-sets rather than merely "looks right".
//
// Indexable means `Tool(<literal> *)` or `Tool(<literal>:*)` with NO glob inside
// the literal. Established empirically against the real matcher:
//
//   no     Bash(gi *)     vs Bash(git status)   <- matching is token-aware
//   MATCH  Bash(git *)    vs Bash(git status)
//   MATCH  Bash(git *)    vs Bash(git)          <- the trailing star matches empty
//   MATCH  Bash(g* *)     vs Bash(git status)   <- a glob INSIDE a token matches
//   MATCH  Bash(mkfs* *)  vs Bash(mkfs.ext4 /dev/sda)
//
// The last two cannot be found by any literal-prefix lookup, so a rule whose
// literal contains a glob goes to the linear fallback. `Bash(mkfs* *)` is not
// hypothetical — it ships in the starter pack's deny half.
const RULE_SHAPE = /^([A-Za-z][A-Za-z0-9:_-]*)\((.*)\)$/s;
const KEY_SEP = '\u0000';

// Memoized for the same reason and by the same rule as coverLookupKeys below:
// a pure function of one string, so a global memo is correct regardless of which
// pool calls it. Safer than that one, in fact — this returns a string or null,
// both immutable, so there is no shared-array hazard to argue about at all.
//
// Worth it because the earlier memo moved the bottleneck. With coverLookupKeys
// cached, `createCoverIndex` became the dominant term — the two index builds are
// 21.2% + 21.4% of a warm pass, now EQUAL to the two covers() sweeps — and
// coverIndexKey is 74% of a build. Measured against a purpose-built arm with the
// memo removed, interleaved, warm n=270: 0.983/1.095 -> 0.483/0.540 ms at 431
// entries, a 51% cut, and 55% at 1200.
//
// `undefined` is the miss sentinel, which is why a non-indexable rule's `null`
// is stored explicitly rather than left absent — the same distinction
// permission-match.js's `cached()` documents.
const COVER_INDEX_KEY_CACHE_LIMIT = 5000;
const coverIndexKeyCache = new Map();

function coverIndexKey(rule) {
  if (typeof rule !== 'string') return coverIndexKeyUncached(rule);
  const hit = coverIndexKeyCache.get(rule);
  if (hit !== undefined) return hit;
  const key = coverIndexKeyUncached(rule);
  // Wholesale clear, not an LRU: the bookkeeping would cost more than the work
  // it saves, and reaching this bound means a caller is synthesising rules in a
  // loop. The cap has to exceed the list length or a clear lands mid-sweep and
  // hands the next sweep a cold memo.
  if (coverIndexKeyCache.size >= COVER_INDEX_KEY_CACHE_LIMIT) coverIndexKeyCache.clear();
  coverIndexKeyCache.set(rule, key);
  return key;
}

function coverIndexKeyUncached(rule) {
  const parts = RULE_SHAPE.exec(rule);
  if (!parts) return null;
  const [, tool, arg] = parts;
  if (!/\*\s*$/.test(arg)) return null;                  // not a trailing-scope wildcard
  // The star must sit on a TOKEN BOUNDARY, i.e. be preceded by whitespace or a
  // colon, or be the whole argument. `Bash(rm -rf /*)` fails this: stripping its
  // star leaves `rm -rf /`, which is not a prefix of `rm -rf /home` at any
  // whitespace boundary, so a lookup would miss it — a false negative, the one
  // error class that can change an answer. The differential test caught exactly
  // this case before it shipped. Such rules go to the linear fallback.
  const head = arg.replace(/\*\s*$/, '');
  if (head !== '' && !/[\s:]$/.test(head)) return null;
  const literal = head.replace(/[\s:]+$/, '');
  if (/[*?]/.test(literal)) return null;                 // glob inside the literal
  return `${tool}${KEY_SEP}${literal}`;
}

// Every key a candidate could be covered by: the tool-wide key, then the
// candidate's own argument truncated at each token boundary. Sliced from the
// ORIGINAL string rather than rebuilt from split tokens, so runs of internal
// whitespace and quoted paths keep their exact bytes — rebuilding with single
// spaces would miss `Bash("C:\Program  Files\x.exe" *)` and a miss is the one
// error class that matters here.
//
// A COLON is a token boundary here for the same reason it is one in
// coverIndexKey: `Skill(dataviz:*)` indexes under `Skill\0dataviz`, so a lookup
// that only broke at whitespace generated `Skill\0` and `Skill\0dataviz:report`
// and never reached that bucket. The two functions have to agree on what a
// boundary is, or the rule is both indexed AND unreachable — it is not in the
// linear fallback either, so nothing else looks at it. That shipped: five
// oracle-confirmed false negatives, including the three colon-form Skill
// wildcards in patterns/starter-pack.json and the documented
// `WebFetch(domain:*)`. Extra keys cost only a bucket probe, because
// isCoveredBy still decides every answer; a MISSING key changes the answer.
function coverLookupKeysUncached(specific) {
  const parts = RULE_SHAPE.exec(specific);
  if (!parts) return [];
  const [, tool, arg] = parts;
  const keys = [`${tool}${KEY_SEP}`];
  for (let i = 0; i <= arg.length; i += 1) {
    if (i === arg.length || /[\s:]/.test(arg[i])) {
      keys.push(`${tool}${KEY_SEP}${arg.slice(0, i).replace(/[\s:]+$/, '')}`);
    }
  }
  return keys;
}

// Memoized on the candidate string, because that string is the ONLY input:
// coverLookupKeys reads nothing from the pool, the buckets or the module, so a
// global memo returns a provably identical answer no matter which
// createCoverIndex asked. Determinism is the entire safety argument here — this
// needs no differential of its own, unlike the index it feeds, whose keys are
// still checked against the full-scan oracle in test/cover-index.test.js.
//
// Worth it because the walk is per-CHARACTER: a regex probe on every character
// of every argument, plus a slice and a trailing-separator replace per boundary
// (8,018 argument characters and 1,479 keys per sweep on the live 431-entry
// list), and processAllowList runs TWO sweeps — the scope probe, then the prune
// — over largely the same strings. The dashboard then repeats the whole pass on
// every refresh, which is where a warm memo pays for itself.
//
// Measured 2026-09-10. Method, because a warm loop against an inferred baseline
// has been wrong here before: the "before" arm is this file with the memo
// actually reverted, both arms interleaved inside ONE loop with a rotating order.
// Figures are min/p50 ms, before -> after.
//   warm, one long-lived process — the dashboard's regime, per refresh
//     431 entries   n=300   2.19/2.50 -> 1.01/1.14
//     1200 entries  n=300   7.53/9.35 -> 3.36/4.26
//   cold, a fresh process per sample — the hook's regime, one pass then exit
//     431 entries   n=40    8.27/9.89 -> 7.64/9.04
//     1200 entries  n=40   28.46/30.75 -> 25.47/29.46
// The honest exception: on a list that has NOT yet converged, generalization
// rewrites most candidates, so the two sweeps ask about different strings (15.7%
// candidate overlap, not 100%) and the cold pass is ~0.3 ms SLOWER — the memo
// pays for inserts it never reads. That is a first-ever pass on a fresh machine;
// it writes the converged list back, and every pass after it is the case above.
//
// Bounded, and evicted by wholesale clear rather than LRU, for the reasons
// written out at permission-match.js:38-57 and not re-argued here: the hook
// process exits after one pass but the VS Code extension host holds this module
// for a whole session, so an unbounded map keyed on rule strings is a slow leak,
// and an LRU's bookkeeping would cost more than the walk it saves. The six-line
// idiom is replicated rather than imported from permission-match.js because
// exporting a shared cache helper would make a module boundary out of six lines
// that both sides want to tune separately.
//
// The number is the same 5000, and here it is load-bearing rather than copied:
// one sweep visits every entry once, so a cap below the list length would clear
// mid-sweep and hand the next sweep a cold memo. 5000 keeps even the 3,200-entry
// growth case named above inside a single sweep. Measured at the cap with
// realistic candidates, a full memo costs 3.5 MB of heap — the price of the
// bound, and the reason it is not larger.
//
// Two deliberate details:
//   * Only STRINGS are memoized, matching normalizeRule (permission-match.js:81).
//     An object key is memoized by reference, so the next parse's fresh object
//     never hits it and each one holds a slot, and itself, until a clear. (Not a
//     stale ANSWER: ruleMatches refuses non-strings. Corrected 2026-10-13.)
//   * The memoized value is an array handed out BY REFERENCE, which is safe only
//     while every caller treats it as read-only. The one caller is `narrow`
//     below, which iterates it with for...of and never sorts, pushes or splices;
//     it copies what it needs into its own `out` array. A caller that mutated
//     the keys would corrupt the memo for every later caller, so if one ever
//     needs to, return `keys.slice()` here.
const COVER_KEY_CACHE_LIMIT = 5000;
const coverKeyCache = new Map();

function coverLookupKeys(specific) {
  if (typeof specific !== 'string') return coverLookupKeysUncached(specific);
  const hit = coverKeyCache.get(specific);
  if (hit !== undefined) return hit;
  const keys = coverLookupKeysUncached(specific);
  if (coverKeyCache.size >= COVER_KEY_CACHE_LIMIT) coverKeyCache.clear();
  coverKeyCache.set(specific, keys);
  return keys;
}

// Introspection, so the cap can be asserted rather than assumed — the same
// reason permission-match.js:131-136 exposes matchCacheStats. A bound nothing
// observes is not a bound: a test without this can only show that results
// survive an eviction, which stays true when the cap is deleted.
function coverIndexKeyCacheStats() {
  return { size: coverIndexKeyCache.size, limit: COVER_INDEX_KEY_CACHE_LIMIT };
}

function coverKeyCacheStats() {
  return { size: coverKeyCache.size, limit: COVER_KEY_CACHE_LIMIT };
}

// `covers(specific)` answers "does anything in this pool cover it", and
// `coveredBy(specific)` returns the covering entries, both with the same result
// the full scan would give.
function createCoverIndex(pool) {
  const indexed = new Map();
  const fallback = [];
  for (const rule of pool) {
    // A rule with no `*` cannot cover anything, so it belongs in neither the
    // buckets nor the fallback. escapeLiteral (permission-match.js:59-61)
    // escapes every regex metacharacter INCLUDING `?` and excluding `*`, and
    // the only `*` -> `.*` expansion is at :94 — so a star-free rule compiles
    // to a fully anchored literal that matches nothing but itself, and
    // isCoveredBy already excludes identity via sameRule.
    //
    // This is not a micro-optimisation. On the live 424-entry list 20 of the 23
    // unindexable rules are star-free (`Skill(dataviz)`, `Edit`, `Write`,
    // `WebSearch`, one-off literal commands), and because the fallback is
    // consulted for EVERY candidate they absorbed 8,480 of prunePermissions'
    // 10,153 isCoveredBy calls — 83% of the work, for a guaranteed `false`.
    // Measured: cold processAllowList 12.38 -> 8.85 ms per hook call, warm
    // 3.82 -> 2.45 ms per dashboard refresh. It also retires the growth mode
    // that mattered: star-free entries are what a real allow list accumulates,
    // and with them gone the fallback is 3 rules with no growth axis, so a
    // 3,200-entry list goes from 1,190 ms to 15.6 ms.
    if (!rule.includes('*')) continue;
    const key = coverIndexKey(rule);
    if (key === null) { fallback.push(rule); continue; }
    const bucket = indexed.get(key);
    if (bucket) bucket.push(rule); else indexed.set(key, [rule]);
  }
  const narrow = (specific) => {
    const out = [];
    for (const key of coverLookupKeys(specific)) {
      const bucket = indexed.get(key);
      if (bucket) out.push(...bucket);
    }
    // A rule with a glob in its literal is unreachable by lookup, so the
    // fallback is always consulted. It is small in practice — 27 of 423 here.
    out.push(...fallback);
    return out;
  };
  return {
    covers: (specific) => narrow(specific).some((rule) => isCoveredBy(specific, rule)),
    coveredBy: (specific) => narrow(specific).filter((rule) => isCoveredBy(specific, rule)),
    stats: () => ({ indexed: indexed.size, fallback: fallback.length }),
  };
}

// Remove entries that are fully covered by a broader entry in the same list.
//
// The index is built once per call rather than per entry, which is what turns
// the quadratic scan linear. Identity is preserved by isCoveredBy itself
// (`sameRule` first), so an entry can never prune itself — the old `i !== j`
// index inequality was only equivalent to string inequality because
// processAllowList dedupes through a Set first, and relying on that coincidence
// here would break the moment a caller passed a list with duplicates.
function prunePermissions(allows) {
  const index = createCoverIndex(allows);
  return allows.filter((perm) => !index.covers(perm));
}

// Full pipeline: generalize → deduplicate → prune.
function processAllowList(allows) {
  if (!Array.isArray(allows) || allows.length === 0) return allows;

  const existingScopes = allows.filter((permission) => /\*\s*\)$/.test(permission));
  // Indexed once for the whole map, not re-scanned per entry. The old
  // `scope !== permission` guard is dropped as redundant rather than lost:
  // isCoveredBy defers to sameRule first, so an entry never covers itself, and
  // that holds for the `Tool(cmd:*)` / `Tool(cmd *)` spellings too — they are the
  // same rule rather than one covering the other.
  const scopeIndex = createCoverIndex(existingScopes);
  const generalized = [...new Set(allows.map((permission) => {
    if (scopeIndex.covers(permission)) {
      return permission;
    }
    return generalizePermission(permission);
  }))];
  return prunePermissions(generalized);
}

// ── bypass toggle ─────────────────────────────────────────────────────────────
//
// A personal "skip every prompt" switch — our own version of Claude Code's
// bypassPermissions mode, flipped by writing `permissions.defaultMode` in
// settings.json. It is NOT permanent: turning it ON stashes the previous mode in
// a sidecar file so turning it OFF restores exactly what you had.
//
// bypassPermissions is the widest suppression Claude Code exposes — it captures
// every tool, every Bash/PowerShell command, every unapproved/MCP tool, and the
// compound/`$(...)`/subshell cases wildcarding can't reach. What it does NOT
// touch (by Claude Code's design, not ours): your `permissions.deny` rules still
// BLOCK matching commands, and Claude Code's hard circuit breakers (rm -rf / and
// ~ removals, incl. command-substitution forms) always fire. Those are the only
// things left standing under bypass, and both are safety floors rather than prompts.
//
// defaultMode is read at session start / context rollover, so a flip takes full
// effect on the next Claude Code window reload rather than instantly mid-turn.
const BYPASS_MODE = 'bypassPermissions';
const FALLBACK_MODE = 'default'; // restore target when no stashed mode exists
const BYPASS_STATE_FILE = path.join(os.homedir(), '.claude', 'backups', 'wildcarding-bypass.json');

function readBypassState() {
  try { return JSON.parse(fs.readFileSync(BYPASS_STATE_FILE, 'utf8')) || {}; }
  catch { return {}; }
}

function writeBypassState(state) {
  // Best-effort — a lost stash only degrades the OFF restore to FALLBACK_MODE.
  try {
    fs.mkdirSync(path.dirname(BYPASS_STATE_FILE), { recursive: true });
    writeFileAtomicSync(BYPASS_STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  } catch { /* ignore */ }
}

// The active permission mode, defaulting to Claude Code's own baseline.
function currentMode(settings) {
  return settings?.permissions?.defaultMode ?? FALLBACK_MODE;
}

function isBypassOn(settings) {
  return currentMode(settings) === BYPASS_MODE;
}

// `mode === null` removes the key rather than writing a value the user never had.
function withMode(settings, mode) {
  const permissions = { ...(settings?.permissions ?? {}) };
  if (mode === null || mode === undefined) delete permissions.defaultMode;
  else permissions.defaultMode = mode;
  return { ...settings, permissions };
}

// Compute the settings object for turning bypass on/off. Side effect: stashes the
// previous mode (on) or reads it back (off) via the sidecar so the toggle round-
// trips. Returns { changed, settings, from, to }; `changed` is false for a no-op
// (already in the requested state), leaving the stash untouched.
function applyBypass(settings, on) {
  const from = currentMode(settings);
  if (on) {
    if (from === BYPASS_MODE) return { changed: false, settings, from, to: from };
    writeBypassState({ savedMode: from, savedAt: new Date().toISOString() });
    return { changed: true, from, to: BYPASS_MODE, settings: withMode(settings, BYPASS_MODE) };
  }
  if (from !== BYPASS_MODE) return { changed: false, settings, from, to: from };
  const saved = readBypassState().savedMode;
  const to = (typeof saved === 'string' && saved && saved !== BYPASS_MODE) ? saved : FALLBACK_MODE;
  return { changed: true, from, to, settings: withMode(settings, to) };
}

// BYPASS_MODE and BYPASS_STATE_FILE came off this list and stayed in the file.
// Both are internal to the four bypass functions below them, and so is
// prunePermissions, whose only caller is processAllowList at :717.
//
// readBypassState is the one this comment got WRONG, and the correction is worth
// the space. It used to be named here as one of the functions "the CLI, the
// extension and the tests have always reached the behaviour" through. Nothing
// reached it, in any of the three: it is called at :783 and nowhere else in the
// repository. The claim then argued AGAINST its own test — "applyBypass's own
// round trip does not already pin" was false, because no test ever turned bypass
// OFF. Mutating this function to `return {}` left all 696 tests green. It is
// exported for test/bypass-round-trip.test.js, which is what makes that mutation
// fail now.
module.exports = {
  generalizePermission, BASH_SCRIPT_KEYWORDS,
  isCoveredBy, createCoverIndex, processAllowList, writeFileAtomicSync,
  coverKeyCacheStats, coverIndexKeyCacheStats,
  currentMode, isBypassOn, applyBypass, readBypassState,
};
