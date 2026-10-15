'use strict';

// One implementation of Claude Code's documented rule matching, shared by the
// wildcarding pass and the dashboard so the two cannot drift apart. Citations
// live in docs/claude-code-permissions.md; the two rules that are easy to miss:
//
//   1. `Tool(cmd:*)` is an equivalent spelling of `Tool(cmd *)`. A matcher that
//      knows only one form treats the two as unrelated rules, so it keeps both
//      in the allow list and reports a covered family as uncovered.
//   2. A trailing `*` with a space before it ALSO matches the bare command:
//      `Bash(ls *)` matches `ls`, and `Bash(git log *)` matches `git log`. That
//      holds only while the trailing `*` is the rule's only wildcard, so an
//      entry carrying a second `*` does not get the bare-command allowance.

const RULE_SHAPE = /^([A-Za-z_][A-Za-z0-9_]*)\(([\s\S]*)\)$/;

// Both rules below are documented for command specifiers, which is where a
// space separates a prefix from its arguments. Other tools use their own
// specifier grammar: a `Read(**/x)` path glob, or a `Skill(name:args)` where
// the colon is a field separator rather than the trailing-wildcard suffix.
// Applying command semantics there would be an inference, and the cost of
// being wrong is pruning a rule someone still needs, so it is not applied.
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);

// Both caches below are keyed on the exact rule string and hold the result of a
// pure function of that string, so nothing in them can go stale. That is what
// earns a cache here, and it is worth naming the contrast: auto-learn-manager.js
// deliberately refuses to cache a managed-policy decision, because that file is
// a client-refreshed copy and a stored verdict could contradict it. A string in,
// a string out, has no such hazard.
//
// Why it is worth anything: `ruleMatches` rebuilt a RegExp on every call, and
// `isCoveredBy` SAT inside both passes of `processAllowList` back when those
// passes were still quadratic. Measured on a real 316-entry allow list, one pass
// was 192,150 compilations and 507 ms; with these two maps it is 316
// compilations. Past tense on purpose: the coverage index in permissions.js has
// since narrowed both passes, so do not read this as a description of the
// current scan. `isCoveredBy` is still the one that decides every answer.
//
// Capped because the lifetime differs by two orders of magnitude between the two
// callers: the hook process exits after one pass, while the VS Code extension
// host holds this module for the whole session. A real allow list plus a managed
// policy is a few hundred distinct strings, so reaching this limit means a caller
// is synthesizing rules in a loop, which is a bug rather than a workload.
// Eviction is a wholesale clear, because an LRU's bookkeeping would cost more
// than the compile it saves.
const MATCH_CACHE_LIMIT = 5000;
const normalizedRules = new Map();
const compiledRules = new Map();

// `undefined` is the miss sentinel, which is why the compiled cache stores an
// explicit `null` for a rule that cannot compile rather than leaving it absent.
function cached(store, key, build) {
  const hit = store.get(key);
  if (hit !== undefined) return hit;
  const value = build();
  if (store.size >= MATCH_CACHE_LIMIT) store.clear();
  store.set(key, value);
  return value;
}

function escapeLiteral(value) {
  return String(value).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRuleUncached(rule) {
  const text = String(rule == null ? '' : rule);
  const parsed = RULE_SHAPE.exec(text);
  if (!parsed) return text;
  const [, tool, inner] = parsed;
  if (!COMMAND_TOOLS.has(tool)) return text;
  return inner.endsWith(':*') ? `${tool}(${inner.slice(0, -2)} *)` : text;
}

// Rewrites the `:*` spelling to the ` *` spelling for a command tool. Anything
// else is returned unchanged.
//
// Only a string is cached. `null` and `undefined` both normalize to `''` and
// must keep doing so, and keying them in the same map as the empty string would
// be a distinction this function does not draw but a caller might rely on.
function normalizeRule(rule) {
  if (typeof rule !== 'string') return normalizeRuleUncached(rule);
  return cached(normalizedRules, rule, () => normalizeRuleUncached(rule));
}

function ruleRegexSource(rule) {
  const normalized = normalizeRule(rule);
  const parsed = RULE_SHAPE.exec(normalized);
  if (parsed) {
    const [, tool, inner] = parsed;
    const wildcards = (inner.match(/\*/g) || []).length;
    if (COMMAND_TOOLS.has(tool) && wildcards === 1 && inner.endsWith(' *')) {
      // ` .*` optional, so the prefix alone matches too.
      return `${escapeLiteral(tool)}\\(${escapeLiteral(inner.slice(0, -2))}( .*)?\\)`;
    }
  }
  return escapeLiteral(normalized).replace(/\*/g, '.*');
}

// The compiled form of a rule, or `null` when it cannot compile.
//
// The `catch` is unreachable today and is kept as insurance rather than as a
// live path. Measured: `escapeLiteral` escapes every regex metacharacter except
// `*`, and `*` is always rewritten to `.*`, so no rule string can produce an
// invalid pattern. `Bash((`, `[`, `Bash({2,1})`, `\` and `(?<` all compile.
// Do NOT write a test asserting a rule "cannot compile": there is no such
// input, and the assertion would pass whether or not this guard exists. What is
// worth asserting, and is, is that a metacharacter is treated as a literal.
// The `null` sentinel exists so that if `escapeLiteral` ever narrows, the
// failure is cached rather than re-thrown on every call.
function compiledRule(rule) {
  return cached(compiledRules, rule, () => {
    try { return new RegExp(`^${ruleRegexSource(rule)}$`); }
    catch { return null; }
  });
}

// Does `rule` cover `permission`? Both sides are normalized, so a colon-form
// probe is understood as readily as a colon-form rule.
function ruleMatches(rule, permission) {
  // Before any normalization, so a non-string can never reach a cache key.
  if (typeof rule !== 'string' || typeof permission !== 'string') return false;
  // Every text Claude Code tries an allow rule against (claudeAllowCandidates, below).
  const targets = claudeAllowCandidates(permission);
  if (targets.some((target) => matchesTarget(rule, target))) return true;
  return matchesThroughXargs(rule, targets);
}

// True when the two strings are the same rule written differently.
function sameRule(left, right) {
  return normalizeRule(left) === normalizeRule(right);
}

// Introspection, so the cap can be asserted rather than assumed. Without this a
// test can only check that results survive an eviction, which stays true if the
// cap is deleted entirely: a bound nothing observes is not a bound.
function matchCacheStats() {
  return { normalized: normalizedRules.size, compiled: compiledRules.size, candidates: allowCandidates.size, limit: MATCH_CACHE_LIMIT };
}

// ── Claude Code's allow-path strip ──────────────────────────────────────────────
//
// Until 2026-10-13 ruleMatches compared a rule with the permission's own text and
// nothing else, so `Bash(rg *)` did not cover `Bash(timeout 5 rg x)` although Claude
// Code strips `timeout 5` before it consults that rule ("Before matching Bash rules,
// Claude Code strips a fixed set of wrappers, so a rule like `Bash(npm test *)` also
// matches `timeout 30 npm test`", code.claude.com/docs/en/permissions, "Wrappers", read
// 2026-10-13). That only ever UNDER-reported coverage: processAllowList kept entries a
// broader rule already covers, and the dashboard called covered families uncovered.
//
// What is modelled is the allow matcher in Claude Code 2.1.296's shipped binary (the CLI
// inside the VS Code extension, read the same day):
//   * each rule is tried against the command as written AND against it after a strip of
//     leading known-safe assignments and then of the fixed wrapper set;
//   * a rule ending in `*` is ALSO tried with `xargs ` in front of it, against both texts
//     (that is how "bare `xargs`" is stripped: the command keeps it, the rule gains it);
//   * an exact rule matches the stripped text too, so `Bash(./x.sh)` covers
//     `Bash(nohup ./x.sh)`.
// Bash only, as the docs scope it. Only ALLOW semantics: deny and ask strip more (every
// assignment, and exec wrappers such as sudo, watch and strace), so for a deny rule this
// answer stays a subset of Claude Code's, as it always was.
//
// Every strip is a SUBSET of what Claude Code strips. A shape it might strip that is not
// modelled is simply not stripped, because the costly error is the other one: claiming a
// cover Claude Code does not honour lets processAllowList PRUNE a rule still needed.
//
// The known-safe list and the wrapper routine live here, rather than in
// src/permissions.js where they were first written the same day, because the matcher
// needs them and permissions.js already imports this file (the reverse would be a
// cycle). src/fixed-point-cache.js stamps both files, so the cache stays sound;
// permissions.js and, through it, src/auto-learn.js import them.
//
// Re-read on each Claude Code release; measured from 2.1.296 on 2026-10-13. The name list
// below is checked by src/claude-strip-model.js, which reads the installed CLI binary: the
// extension runs it once per new Claude Code binary and warns on drift (since 2026-10-15),
// and `node scripts/check-claude-strip-model.js` exits 1 when the list differs from this one.
// Neither changes this list; a change still needs a release. The value class, the wrapper
// shapes and the matcher's order are a manual read of the same binary (that module's
// header says where to look).

// Claude Code 2.1.296's known-safe environment variables, copied verbatim from its
// allow-path routine, which strips a leading `NAME=VALUE ` only while NAME is one of
// these and VALUE matches `[A-Za-z0-9_./:-]+`. The docs page says only "certain
// known-safe environment variables" (read 2026-10-13). The evidence and what the
// wildcarding pass does with any other assignment are above splitEnvPrefix in
// src/permissions.js. Re-read on each Claude Code release; measured from 2.1.296 on
// 2026-10-13 (src/claude-strip-model.js compares it with an installed binary).
const CLAUDE_SAFE_ENV_VARS = new Set([
  'GOEXPERIMENT', 'GOOS', 'GOARCH', 'CGO_ENABLED', 'GO111MODULE', 'RUST_BACKTRACE', 'RUST_LOG',
  'NODE_ENV', 'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE', 'PYTEST_DISABLE_PLUGIN_AUTOLOAD',
  'PYTEST_DEBUG', 'ANTHROPIC_API_KEY', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_TIME', 'CHARSET',
  'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'TZ', 'LS_COLORS', 'LSCOLORS', 'GREP_COLOR',
  'GREP_COLORS', 'GCC_COLORS', 'TIME_STYLE', 'BLOCK_SIZE', 'BLOCKSIZE', 'COLUMNS', 'LINES', 'CLICOLOR',
  'CLICOLOR_FORCE', 'CI', 'DEBIAN_FRONTEND', 'GIT_TERMINAL_PROMPT',
]);
const STRIPPED_ENV_VALUE = /^[A-Za-z0-9_./:-]+$/;

// Does Claude Code strip this leading assignment before an allow rule is consulted?
// `value` is the text after `=` as written, quotes included.
function claudeStripsAssignment(name, value) {
  return CLAUDE_SAFE_ENV_VARS.has(name) && STRIPPED_ENV_VALUE.test(value);
}

// The wrapper shapes, and why each is accepted, are documented above stripBashWrappers
// in src/permissions.js, where the routine was first written.
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
    // The allow-path stripper takes only fused modes with a `[LN0-9]+` value
    // (`/^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+/` in 2.1.296). Until 2026-10-13 this also
    // took `-o L`, `--output=L` and `-o1M`, which only the safety walker accepts, so
    // `stdbuf -o L rg x` became `Bash(rg *)`, a rule the matcher never reaches past
    // that stdbuf: a prompt loop, not a widening.
    case 'stdbuf': {
      let k = 1;
      while (/^-[ioe][LN0-9]+$/.test(at(k) || '')) k += 1;
      return k === 1 ? -1 : k;
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

// The leading wrappers Claude Code strips from a line's words, as `{ length, refused }`:
// `length` tokens come off (every stripped wrapper with its own options), and `refused`
// says the next token is still a wrapper in a shape that is not stripped, or there is no
// command after them, or that command starts with `-` (what the CLI calls "an
// incomplete fragment": `time -p make`, `nice --adjustment=5 make`). Bare `xargs` is
// taken only as the innermost layer, and a wrapper after it is refused; `{ xargs: false
// }`, the matcher's call, stops at it instead, because the matcher reaches past xargs
// from the rule side (matchesThroughXargs).
//
// ONE routine for three callers since 2026-10-13: the wildcarding pass
// (stripBashWrappers in src/permissions.js), the learner's deriveBaseInvocation
// (src/auto-learn.js), which until then kept its own subset (`timeout`, `command`,
// `builtin`) and so proposed `Bash(nohup *)`, `Bash(nice *)`, `Bash(stdbuf *)`,
// `Bash(noglob *)` and `Bash(xargs *)` and stripped `command -v`, and this matcher.
// `tokens` are the words as written; names are compared exactly, as the CLI compares
// them (`Time` and `/usr/bin/timeout` are not stripped).
function claudeWrapperPrefix(tokens, { xargs = true } = {}) {
  let k = 0;
  for (let guard = 0; guard < 8; guard += 1) {
    if (!xargs && tokens[k] === 'xargs') return { length: k, refused: false };
    const consumed = wrapperLength(tokens.slice(k));
    if (consumed === 0) return { length: k, refused: false };
    const inner = tokens[k + consumed];
    if (consumed < 0 || inner === undefined || String(inner).startsWith('-')) return { length: k, refused: true };
    const isXargs = tokens[k] === 'xargs';
    k += consumed;
    if (isXargs) return { length: k, refused: wrapperLength(tokens.slice(k)) !== 0 };
  }
  return { length: k, refused: true };
}

// Bash command text after the strip Claude Code's allow matcher applies: leading
// known-safe assignments while the line opens with one, then every wrapper it strips,
// as far as it gets (a refused wrapper is where it stops, as the CLI's does). xargs is
// left in place for matchesThroughXargs.
//
// Most entries open with neither, and this runs once per distinct permission on the
// hook's cold pass, so the first word is checked before the line is tokenized:
// `wrapperLength([word]) !== 0` is true for exactly the stripped wrapper names (a lone
// `xargs` is 0), so the fast path needs no second list to keep in step. Measured
// 2026-10-13 on the development box's 581-entry list.
const STRIPPABLE_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(\S*)\s+/;
const FIRST_WORD = /^\S+/;
function claudeAllowStrip(text) {
  let rest = text.replace(/^\s+/, '');
  for (let m = STRIPPABLE_ASSIGNMENT.exec(rest); m && claudeStripsAssignment(m[1], m[2]);
    m = STRIPPABLE_ASSIGNMENT.exec(rest)) rest = rest.slice(m[0].length);
  if (wrapperLength([FIRST_WORD.exec(rest)?.[0]]) === 0) return rest;
  const words = [...rest.matchAll(/\S+/g)];
  const { length } = claudeWrapperPrefix(words.map((word) => word[0]), { xargs: false });
  return length ? rest.slice(words[length].index) : rest;
}

// The texts an allow rule is tried against, normalized: the permission itself, then the
// stripped form when the strip changed anything. Memoized like the two caches above (a
// pure function of one string), bounded the same way, and handed out frozen because the
// array is shared.
const allowCandidates = new Map();
function claudeAllowCandidatesUncached(permission) {
  const target = normalizeRule(permission);
  const parsed = RULE_SHAPE.exec(target);
  if (!parsed || parsed[1] !== 'Bash') return Object.freeze([target]);
  const stripped = claudeAllowStrip(parsed[2]);
  return Object.freeze(stripped === parsed[2].replace(/^\s+/, '') ? [target] : [target, `${parsed[1]}(${stripped})`]);
}
function claudeAllowCandidates(permission) {
  if (typeof permission !== 'string') return claudeAllowCandidatesUncached(permission);
  return cached(allowCandidates, permission, () => claudeAllowCandidatesUncached(permission));
}

function matchesTarget(rule, target) {
  if (normalizeRule(rule) === target) return true;
  const pattern = compiledRule(rule);
  return pattern === null ? false : pattern.test(target);
}

// A Bash rule ending in `*` also matches with `xargs ` in front of it, as the CLI tries
// it: `Bash(grep *)` covers `Bash(xargs grep x)` but not `Bash(xargs -n1 grep x)`, which
// the docs name as "matched as an `xargs` command". An exact rule gets no such variant.
// The variant's pattern opens with the literal `Bash(xargs `, so a target that does not
// cannot match it; checking that first spares a normalize and a compile on almost every
// call, which is the prune sweep's common case.
function matchesThroughXargs(rule, targets) {
  if (!targets.some((target) => target.startsWith('Bash(xargs '))) return false;
  const parsed = RULE_SHAPE.exec(normalizeRule(rule));
  if (!parsed || parsed[1] !== 'Bash' || !/\*\s*$/.test(parsed[2])) return false;
  const throughXargs = `Bash(xargs ${parsed[2]})`;
  return targets.some((target) => matchesTarget(throughXargs, target));
}

// `ruleRegexSource` is deliberately NOT exported. It had no consumer anywhere,
// production or test, and there is nothing it can prove that `ruleMatches`
// cannot: every property of the pattern it builds -- the bare-command
// allowance, the single-wildcard condition, a metacharacter treated as a
// literal -- is asserted through the matcher in test/permission-match.test.js,
// against the behaviour rather than against the regex text. Exporting the
// intermediate would invite an assertion on the SPELLING of a pattern, which
// breaks on a harmless refactor and proves nothing about matching.
//
// `MATCH_CACHE_LIMIT` is exported for the opposite reason: its VALUE is
// load-bearing (see the note above it) and `matchCacheStats().limit` reports
// the same constant, so a test reading only the report could not tell the
// enforced bound from the advertised one. The test destructures both and pins
// them together.
//
// The strip helpers are exported for src/permissions.js (the wildcarding pass and its
// cover index) and, through it, src/auto-learn.js, so all three agree on one routine.
// CLAUDE_SAFE_ENV_VARS is exported for src/claude-strip-model.js and its command line,
// scripts/check-claude-strip-model.js, which read it and never write it (2026-10-13; the
// reader moved to src/ on 2026-10-15).
module.exports = {
  normalizeRule, ruleMatches, sameRule,
  matchCacheStats, MATCH_CACHE_LIMIT,
  claudeStripsAssignment, wrapperLength, claudeWrapperPrefix, claudeAllowCandidates,
  CLAUDE_SAFE_ENV_VARS,
};
