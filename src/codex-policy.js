'use strict';

// Read-only inspection of Codex's cached managed requirements, and enumeration
// of the rule files Codex actually loads. This module deliberately does not edit
// config.toml or offer an approval-policy toggle.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CODEX_BUNDLE_CACHE = path.join(os.homedir(), '.codex', 'cloud-config-bundle-cache.json');

function readEnterpriseBundle(bundlePath = CODEX_BUNDLE_CACHE) {
  try { return JSON.parse(fs.readFileSync(bundlePath, 'utf8')); }
  catch { return null; }
}

function enterpriseRequirements(bundle) {
  const managed = bundle?.signed_payload?.bundle?.requirements_toml?.enterprise_managed;
  if (!Array.isArray(managed)) return '';
  return managed.map((entry) => String(entry?.contents || '')).join('\n');
}

function allowedApprovalPolicies(bundle) {
  const match = /allowed_approval_policies\s*=\s*\[([^\]]*)\]/.exec(enterpriseRequirements(bundle));
  if (!match) return null;
  return [...match[1].matchAll(/["']([^"']+)["']/g)]
    .map((entry) => entry[1].trim())
    .filter(Boolean);
}

function allowedSandboxModes(bundle) {
  const match = /allowed_sandbox_modes\s*=\s*\[([^\]]*)\]/.exec(enterpriseRequirements(bundle));
  if (!match) return null;
  const values = [...match[1].matchAll(/["']([^"']+)["']/g)]
    .map((entry) => entry[1].trim())
    .filter(Boolean);
  return values.length ? values : null;
}

// ── managed prefix rules ──────────────────────────────────────────────────────
//
// THE PARSER THIS REPLACES WAS APPROXIMATE AND SAID SO NOWHERE.
//
// It collected every quoted string in a `[[rules.prefix_rules]]` block, minus
// the decision and the justification, and called the remainder "patterns". Then
// it compared all of them against argv[0]. A root-only `any_of` worked by
// accident. An ordered multi-token pattern did not, and the failure was a
// CONFIDENT WRONG ANSWER rather than a shrug.
//
// Measured against the real bundle cached on the development box, codex-cli
// 0.145.0, with the managed rule
//
//   pattern = [{ any_of = ["git","git.exe"] }, { token = "push" },
//              { any_of = ["--force","-f","--force-with-lease","--mirror"] }]
//   decision = "forbidden"
//
// the old parser answered `["push"]` -> forbidden, `["repo"]` -> forbidden and
// `["delete"]` -> forbidden: three commands the org does not forbid at all. It
// also answered `["gh","repo","delete","x"]` -> prompt, because it returned the
// FIRST matching block and the broad `gh` prompt rule is written above the
// narrow `gh repo delete` forbidden one. That is the dangerous direction: a
// forbidden command reported as merely prompting.
//
// So this parser handles the schema exactly, resolves conflicts toward the more
// restrictive decision the way Codex does, and marks any block whose shape it
// does not recognise UNSUPPORTED rather than guessing. A caller that gets
// `degraded: true` has been told that a rule exists which this tool cannot read,
// and must not present its answer as complete.
//
// Supported pattern positions, and nothing else:
//   { any_of = ["a", "b"] }   alternatives at this position
//   { token = "push" }        one literal token at this position
//   "push"                    bare string, equivalent to { token = "push" }

const PREFIX_RULE_SEVERITY = new Map([['allow', 1], ['prompt', 2], ['forbidden', 3]]);

// What a local read of the bundle cache can never answer. Printed by the
// diagnostics rather than left implied, because "no managed rule governs this"
// is a claim about the whole policy and this module only sees one cached file.
const MANAGED_POLICY_BLIND_SPOTS = [
  'Only the locally cached enterprise bundle was read. Server-side policy, ' +
  'Guardian review decisions, session approval state and sandbox restrictions ' +
  'are not visible here and can still block or prompt.',
];

function normalizeRoot(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '');
}

// TOML comments, minus the ones that are really string content. Needed because
// the block body runs to the next table header, so a prose comment written
// between two rules lands inside the preceding rule — and the real bundle has
// several, one of which contains quoted words.
function stripTomlComments(line) {
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === '\\' && quote === '"') { index += 1; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '#') return line.slice(0, index);
  }
  return line;
}

// A table header, not a continuation line of an array. `[{ any_of = ...` opens
// with `[{`, so requiring an identifier character after the bracket keeps a
// multi-line `pattern = [` from being mistaken for the end of the block.
const TABLE_HEADER = /^\s*\[\[?[A-Za-z_][A-Za-z0-9_.-]*/;
const PREFIX_RULE_HEADER = /^\s*\[\[rules\.prefix_rules\]\]\s*$/;

function prefixRuleBlocks(text) {
  const blocks = [];
  let current = null;
  let inMultiline = false;
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fences = (line.match(/"""/g) || []).length;
    if (inMultiline) {
      if (fences % 2 === 1) inMultiline = false;
      continue;
    }
    if (fences % 2 === 1) { inMultiline = true; continue; }
    if (PREFIX_RULE_HEADER.test(line)) {
      current = { line: index + 1, body: [] };
      blocks.push(current);
      continue;
    }
    if (TABLE_HEADER.test(line)) { current = null; continue; }
    if (current) current.body.push(stripTomlComments(line));
  }
  return blocks.map((block) => ({ line: block.line, body: block.body.join('\n') }));
}

// Everything between `key = [` and its matching `]`, quote-aware. Returns null
// when the brackets do not balance, which is an unsupported shape rather than
// an empty pattern.
function bracketedValue(body, key) {
  const start = new RegExp(`(^|\\n)\\s*${key}\\s*=\\s*\\[`).exec(body);
  if (!start) return null;
  const open = start.index + start[0].length - 1;
  let depth = 0;
  let quote = '';
  for (let index = open; index < body.length; index += 1) {
    const char = body[index];
    if (quote) {
      if (char === '\\' && quote === '"') { index += 1; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return body.slice(open + 1, index);
    }
  }
  return null;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\' && quote === '"') { index += 1; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length);
}

function stringLiteral(text) {
  const trimmed = String(text).trim();
  const match = /^"((?:[^"\\]|\\.)*)"$|^'([^']*)'$/.exec(trimmed);
  if (!match) return null;
  return match[2] !== undefined ? match[2] : match[1].replace(/\\(.)/g, '$1');
}

function stringArray(text) {
  const trimmed = String(text).trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const values = [];
  for (const part of splitTopLevel(trimmed.slice(1, -1))) {
    const value = stringLiteral(part);
    if (value === null) return null;
    values.push(value);
  }
  return values;
}

function parsePatternPosition(text) {
  const bare = stringLiteral(text);
  if (bare !== null) return { kind: 'token', value: bare };
  const trimmed = String(text).trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return { error: `unsupported pattern position ${trimmed.slice(0, 60)}` };
  }
  const entries = splitTopLevel(trimmed.slice(1, -1));
  if (entries.length !== 1) {
    return { error: `pattern position carries ${entries.length} keys; only one is supported` };
  }
  const split = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*([\s\S]*)$/.exec(entries[0]);
  if (!split) return { error: `unsupported pattern position ${entries[0].slice(0, 60)}` };
  const [, key, raw] = split;
  if (key === 'token') {
    const value = stringLiteral(raw);
    if (value === null) return { error: 'token must be a string literal' };
    return { kind: 'token', value };
  }
  if (key === 'any_of') {
    const values = stringArray(raw);
    if (!values) return { error: 'any_of must be an array of string literals' };
    if (!values.length) return { error: 'any_of is empty' };
    return { kind: 'any_of', values };
  }
  return { error: `unsupported pattern key ${key}` };
}

// One `[[rules.prefix_rules]]` block. Returns either a rule or a reason it
// could not be read; never a partial rule, because a pattern missing a position
// matches more commands than the org wrote, which is the wrong direction.
function parsePrefixRuleBlock(block) {
  const decision = stringLiteral(
    /(^|\n)\s*decision\s*=\s*(.*)$/m.exec(block.body)?.[2] || '',
  );
  const justification = stringLiteral(
    /(^|\n)\s*justification\s*=\s*(.*)$/m.exec(block.body)?.[2] || '',
  ) || '';
  if (!decision) return { line: block.line, reason: 'no decision key' };
  if (!PREFIX_RULE_SEVERITY.has(decision)) {
    return { line: block.line, reason: `unknown decision "${decision}"`, decision };
  }
  const patternText = bracketedValue(block.body, 'pattern');
  if (patternText === null) {
    return { line: block.line, reason: 'no pattern array, or its brackets do not balance', decision };
  }
  const positions = [];
  for (const part of splitTopLevel(patternText)) {
    const position = parsePatternPosition(part);
    if (position.error) return { line: block.line, reason: position.error, decision };
    positions.push(position);
  }
  if (!positions.length) return { line: block.line, reason: 'pattern array is empty', decision };
  const roots = positions[0].kind === 'any_of' ? positions[0].values.slice() : [positions[0].value];
  return {
    rule: {
      decision,
      justification,
      pattern: positions,
      // Kept under the old name and the old meaning for the root position only.
      // The previous parser put every token from every position in here, which
      // is precisely the defect; the root alternatives are what callers actually
      // used it for.
      patterns: roots,
      severity: PREFIX_RULE_SEVERITY.get(decision),
      line: block.line,
    },
  };
}

function parseEnterprisePrefixRules(bundle) {
  const rules = [];
  const unsupported = [];
  for (const block of prefixRuleBlocks(enterpriseRequirements(bundle))) {
    const parsed = parsePrefixRuleBlock(block);
    if (parsed.rule) rules.push(parsed.rule);
    else unsupported.push({ line: parsed.line, reason: parsed.reason, decision: parsed.decision || null });
  }
  return { rules, unsupported, degraded: unsupported.length > 0 };
}

function enterprisePrefixRules(bundle) {
  return parseEnterprisePrefixRules(bundle).rules;
}

// "How much of the managed policy could this tool read?" Callers that print a
// verdict print this beside it, so a degraded parse is never silent.
function enterprisePrefixRuleHealth(bundle) {
  const parsed = parseEnterprisePrefixRules(bundle);
  return {
    total: parsed.rules.length + parsed.unsupported.length,
    supported: parsed.rules.length,
    unsupported: parsed.unsupported,
    degraded: parsed.degraded,
  };
}

function positionMatches(position, token, isRoot) {
  if (token === undefined) return false;
  const candidates = position.kind === 'any_of' ? position.values : [position.value];
  if (isRoot) {
    const root = normalizeRoot(token);
    return candidates.some((value) => normalizeRoot(value) === root);
  }
  // Exact past the root. Subcommands and flags are case-sensitive to the tools
  // that receive them (`git PUSH` is not `git push`), so folding case here would
  // manufacture a forbidden verdict for a command the rule does not cover.
  return candidates.includes(String(token));
}

function ruleMatches(rule, argv) {
  if (argv.length < rule.pattern.length) return false;
  for (let index = 0; index < rule.pattern.length; index += 1) {
    if (!positionMatches(rule.pattern[index], argv[index], index === 0)) return false;
  }
  return true;
}

// Every matching rule, most restrictive first, then longest pattern first. Codex
// resolves a conflict between rules toward the more restrictive decision, so the
// FIRST match in file order is the wrong answer to report whenever a narrower,
// harsher rule is written below a broad one — which is exactly how the real
// bundle is written.
function enterprisePolicyAssessment(bundle, argv) {
  const command = (Array.isArray(argv) ? argv : [argv]).map((value) => String(value == null ? '' : value));
  const parsed = parseEnterprisePrefixRules(bundle);
  const health = {
    total: parsed.rules.length + parsed.unsupported.length,
    supported: parsed.rules.length,
    unsupported: parsed.unsupported,
    degraded: parsed.degraded,
  };
  const empty = {
    match: null, matches: [], root: '', degraded: health.degraded, health,
    blindSpots: MANAGED_POLICY_BLIND_SPOTS.slice(),
  };
  if (!command.length || !command[0]) return empty;
  const root = normalizeRoot(command[0]);
  if (!root) return empty;
  const matches = parsed.rules
    .filter((rule) => ruleMatches(rule, command))
    .map((rule) => ({ ...rule, root }))
    .sort((a, b) => (b.severity - a.severity) || (b.pattern.length - a.pattern.length) || (a.line - b.line));
  return {
    match: matches[0] || null,
    matches,
    root,
    degraded: health.degraded,
    health,
    blindSpots: MANAGED_POLICY_BLIND_SPOTS.slice(),
  };
}

function enterpriseDecisionFor(bundle, argv) {
  const assessment = enterprisePolicyAssessment(bundle, argv);
  if (!assessment.match) return null;
  return { ...assessment.match, degraded: assessment.degraded };
}

// ── the rule files Codex actually loads ───────────────────────────────────────
//
// `codex execpolicy check -r/--rules <PATH>` is REPEATABLE, and Codex resolves a
// conflict between visible rule files toward the more restrictive decision. A
// file validated on its own therefore proves nothing about how it behaves beside
// its neighbours, and the diagnostics that name a cause were reading one file
// and speaking for all of them.
//
// This is the one definition of "the set", used by the validator before a write
// and by the "Why did this prompt?" explanation afterwards, so the two cannot
// disagree about what was checked.

const CODEX_RULE_EXTENSION = '.rules';

function codexRuleDirectories(home = os.homedir()) {
  return [path.join(home, '.codex', 'rules')];
}

// `substitute` stands the pending text IN PLACE OF a deployed file rather than
// beside it: validating the candidate as an extra file leaves the old copy
// visible too, and two files carrying the same prefix rule is not the state the
// write produces.
function codexRuleFileSet(options = {}) {
  const home = options.home || os.homedir();
  const directories = [
    ...codexRuleDirectories(home),
    ...(Array.isArray(options.directories) ? options.directories : []),
  ].map((directory) => path.resolve(directory));
  const failures = [];
  const files = [];
  for (const directory of [...new Set(directories)]) {
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      // A machine with no Codex has no rules directory; that is the normal case
      // and not a failure. Anything else is a directory we could not look at,
      // and a set that silently lost a member is the defect this exists to stop.
      if (error && error.code !== 'ENOENT') {
        failures.push({ path: directory, code: error.code || 'EUNKNOWN', message: String(error.message || error) });
      }
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(CODEX_RULE_EXTENSION)) {
        files.push(path.join(directory, entry.name));
      }
    }
  }
  const target = options.target ? path.resolve(options.target) : null;
  if (target && !files.some((file) => path.resolve(file) === target) && fs.existsSync(target)) {
    files.push(target);
  }
  const resolved = [...new Set(files.map((file) => path.resolve(file)))].sort();
  const substitute = options.substitute ? path.resolve(options.substitute) : null;
  const replaced = substitute && target
    ? resolved.map((file) => (file === target ? substitute : file))
    : substitute && !resolved.length ? [substitute] : resolved.slice();
  // The substitute must be in the set even when the file it replaces has never
  // been written: a first write has no deployed copy to stand in for, and
  // validating the neighbours without the candidate proves nothing about it.
  if (substitute && !replaced.includes(substitute)) replaced.push(substitute);
  return {
    files: resolved,
    effective: substitute ? [...new Set(replaced)] : resolved,
    directories: [...new Set(directories)],
    failures,
    // Local rule files are one input. Say so wherever the set is reported.
    blindSpots: [
      'Managed and system-scope Codex policy is not enumerated here: only rule ' +
      'files readable in the directories listed above were checked. Session ' +
      'approval state and sandbox restrictions are also outside this check.',
    ],
  };
}

function codexRulesArguments(files) {
  return (Array.isArray(files) ? files : []).flatMap((file) => ['--rules', String(file)]);
}

// CODEX_RULE_EXTENSION, MANAGED_POLICY_BLIND_SPOTS, codexRuleDirectories and
// parseEnterprisePrefixRules were exported when this parser was rewritten and never
// consumed from outside this module, including by tests. Unexported rather than
// deleted: every one of them is called internally, and MANAGED_POLICY_BLIND_SPOTS
// reaches the user through enterprisePolicyAssessment's verdict rather than directly.
// test/dead-exports.test.js is what caught them, on the merge.
module.exports = {
  CODEX_BUNDLE_CACHE,
  readEnterpriseBundle,
  enterpriseRequirements,
  allowedApprovalPolicies,
  allowedSandboxModes,
  enterprisePrefixRules,
  enterprisePrefixRuleHealth,
  enterprisePolicyAssessment,
  enterpriseDecisionFor,
  codexRuleFileSet,
  codexRulesArguments,
};
