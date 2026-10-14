'use strict';

// Read-only inspection of Codex's cached managed requirements, and enumeration
// of the rule files Codex actually loads. This module deliberately does not edit
// config.toml or offer an approval-policy toggle.

const fs = require('fs');
const path = require('path');
const { resolveCodexHome } = require('./codex-paths');

const CODEX_BUNDLE_CACHE = path.join(resolveCodexHome(), 'cloud-config-bundle-cache.json');

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
// disagree about what was checked. Given a `workspaceRoot` it adds the project
// folders Codex trusts there, which the write validator deliberately does not
// ask for: both reasons are under "project rule directories" below.

const CODEX_RULE_EXTENSION = '.rules';

function codexRuleDirectories(options = {}) {
  return [path.join(resolveCodexHome(options), 'rules')];
}

// `substitute` stands the pending text IN PLACE OF a deployed file rather than
// beside it: validating the candidate as an extra file leaves the old copy
// visible too, and two files carrying the same prefix rule is not the state the
// write produces.
//
// `projectTrust: 'cached'` is the extension host's door (2026-10-14): it never
// asks Codex, and a trust verdict not yet cached comes back as
// `projectPending: true` with the project folders left out and a blind-spot note
// saying so. refreshProjectTrust below settles it off the host thread. See
// "project rule directories" for why the synchronous ask must not run there.
function codexRuleFileSet(options = {}) {
  const project = projectRuleDirectories(options, resolveCodexHome(options), options.platform || process.platform);
  const directories = [
    ...codexRuleDirectories(options), ...project.directories,
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
  // ONE IDENTITY PER FILE, and on Windows that identity ignores case. The target
  // is a hard-coded lowercase name (`let` at vscode-extension/extension.js:1209#codexRulesPath;
  // `const` at bin/wildcard-perms:329-330#codexRulesPath) while readdirSync
  // returns whatever spelling is on disk, and the three comparisons below used
  // raw strings. Measured 2026-10-13 with an on-disk
  // `Permission-Wildcarding.rules` and the lowercase target plus a substitute:
  // `files` listed the one file under both spellings, the substitute replaced
  // only the target's, and `effective` validated the deployed copy BESIDE the
  // candidate, the exact state the note above this function rules out. A target
  // whose DIRECTORY was cased differently (`.CODEX`) did the same, and the
  // rule-store inventory, which walks `files`, listed the file and each of its
  // rules twice. Keyed the way src/codex-reviewed-plans.js:13#win32 and
  // src/codex-rule-store.js:17#win32 already key paths: resolved, lowercased on win32
  // only, so a case-sensitive POSIX filesystem keeps two spellings as the two
  // files they are. The first spelling seen, the on-disk one, is what is
  // reported. `platform` is injectable so that POSIX rule is testable here.
  // The keyed check before the push only saves a stat: the keyed Map would drop
  // that duplicate anyway, so reverting the check alone changes no output.
  const platform = options.platform || process.platform;
  const key = (file) => (platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));
  const target = options.target ? path.resolve(options.target) : null;
  if (target && !files.some((file) => key(file) === key(target)) && fs.existsSync(target)) {
    files.push(target);
  }
  const byKey = new Map();
  for (const file of files.map((entry) => path.resolve(entry))) {
    if (!byKey.has(key(file))) byKey.set(key(file), file);
  }
  const resolved = [...byKey.values()].sort();
  const substitute = options.substitute ? path.resolve(options.substitute) : null;
  const replaced = substitute && target
    ? resolved.map((file) => (key(file) === key(target) ? substitute : file))
    : substitute && !resolved.length ? [substitute] : resolved.slice();
  // The substitute must be in the set even when the file it replaces has never
  // been written: a first write has no deployed copy to stand in for, and
  // validating the neighbours without the candidate proves nothing about it.
  if (substitute && !replaced.includes(substitute)) replaced.push(substitute);
  return {
    files: resolved,
    effective: substitute ? [...new Set(replaced)] : resolved,
    directories: [...new Set(directories)],
    // Which members are a trusted project's rather than the user's, for the
    // rule-store inventory: it lists them read-only and never backs them up.
    projectDirectories: project.directories.slice(),
    // True only under `projectTrust: 'cached'` while Codex has not answered yet.
    projectPending: project.pending === true,
    failures,
    // Local rule files are one input. Say so wherever the set is reported.
    blindSpots: [
      'Managed and system-scope Codex policy is not enumerated here: only rule ' +
      'files readable in the directories listed above were checked. Session ' +
      'approval state and sandbox restrictions are also outside this check.',
      ...project.notes,
    ],
  };
}

function codexRulesArguments(files) {
  return (Array.isArray(files) ? files : []).flatMap((file) => ['--rules', String(file)]);
}

// ── project rule directories ──────────────────────────────────────────────────
//
// `<project>/.codex/rules` IS LOADED, BUT ONLY FOR A PROJECT CODEX TRUSTS, and the
// trust test has rules a TOML read gets wrong. Measured 2026-10-13 on codex-cli
// 0.161.0 in isolated profiles (temp HOME and CODEX_HOME, provider credentials
// stripped, a scripted loopback model issuing one `exec_command` with
// `sandbox_permissions: require_escalated`, every approval declined): a project
// rule allowing the probe suppressed the approval when the project was trusted
// and did not when it was untrusted or `trust_level = "untrusted"`; a trusted
// project with NO rule still prompted, so trust alone approves nothing. The
// same profiles established:
//
//   - `config/read` with `includeLayers` lists one `project` layer per existing
//     `.codex` folder from the project root down to the cwd (root, an
//     intermediate folder and the cwd were all listed), and an untrusted layer
//     carries `disabledReason` ("To load project-local config, hooks, and exec
//     policies, add <path> as a trusted project"). The enabled layers are
//     exactly the folders whose rules the session obeyed. CODEX_HOME is never
//     one, even when it sits at the repository root.
//   - The project root is the nearest ancestor carrying a `project_root_markers`
//     entry: `.git` by default, and a custom marker was honoured. A `.git`
//     directory that is not a repository (empty, or holding only a credentials
//     file) did not count. Inside a repository, trust on the cwd OR on the
//     repository root enabled the layers, and a linked worktree was trusted
//     through its main checkout as well as its own path. Outside one, a trusted
//     PARENT conferred nothing.
//   - Keys compare case-insensitively on Windows, drive letter and segment case
//     alike, but otherwise literally: forward slashes, a trailing separator and
//     an 8.3 short-name key for a long-name cwd were all NOT trusted, while the
//     long name for an 8.3 cwd was. Every TOML spelling counts: a
//     `[projects.'p']` or `[projects."p"]` header, a dotted key, an inline table.
//
// scripts/check-codex-project-rules-runtime.js re-runs those sessions against
// whatever Codex is installed, and fails if this module's answer differs from
// what the session obeyed or if the fallback below is ever WIDER than Codex.
//
// So Codex is asked, through the same isolated `config/read` worker the MCP
// review uses (readCodexConfigLayers in src/codex-mcp-config.js), and the answer
// is cached until config.toml's size or mtime changes or a candidate `.codex`
// folder appears or goes, because each ask starts an app-server: about one
// second here, measured. Only when that route fails (no reachable codex or
// node, or a reply without readable layers) is config.toml read directly, and
// that read is deliberately narrower than Codex: an exact `[projects.'<root>']`
// or `[projects."<root>"]` header with `trust_level = "trusted"` for the
// workspace root itself, or nothing. What it cannot decide is left OUT and said
// in `blindSpots`, because a rule reported as governing a session it does not
// govern is the confident wrong answer this module keeps refusing to give.
//
// THE WRITE VALIDATOR DOES NOT ASK FOR THIS, on purpose. Auto Learn writes the
// USER-scope file, which applies in every project, and `codex execpolicy check`
// fails the whole check on any unparseable `--rules` member and resolves a
// conflict toward the stricter decision. Both measured on 0.161.0: a broken
// neighbour exits 1 ("failed to parse policy"), and a neighbour's `forbidden`
// turns the user file's `allow` into `forbidden`. With one project's rules in the
// validation set, the same user-scope write would pass or fail depending on
// which workspace window ran it, and a malformed file Codex loads only inside
// that project would block user-scope maintenance everywhere. Project rules
// belong to the explanation and the inventory, which describe what a session in
// THIS workspace obeys, not to the check of a file that is not theirs.
//
// THE ASK NEVER RUNS ON THE EXTENSION HOST THREAD (2026-10-14). d5200f9 had the
// dashboard push and "Why did this prompt?" reach the ask synchronously, and the
// ask is a spawnSync of the worker with a 40 s ceiling. Measured on the v1.6.2
// tree with a stand-in codex in an isolated profile: a cold push blocked the host
// for 1,106 ms, a push after any config.toml touch for 980 ms, and a codex that
// never answers for 31,331 ms. Every extension in the window froze for that long,
// and a spawnSync child is out of reach of deactivate's kill. So the host asks
// for `projectTrust: 'cached'`, which reads the verdict and never spawns, and
// settles a miss with refreshProjectTrust: the same worker, launched with
// spawn, handed to the caller's `track` so deactivate can end it, bounded at
// PROJECT_TRUST_ASYNC_TIMEOUT_MS. The synchronous ask stays for the CLI and the
// Auto Learn worker thread, where blocking is the caller's own business.
//
// AND A `.codex` FOLDER WITH NO `rules` FOLDER IS NOT ASKED ABOUT. A layer can
// only add `<folder>/rules` to the set, so a `.codex` holding only config.toml or
// hooks cannot change the answer, and starting an app-server to find out was the
// whole cost of the ask for nothing. projectCandidates filters on it; a `rules`
// folder created later changes the candidate signature and is asked about then.
//
// CACHE SHAPE (2026-10-14). One entry per (which Codex, which profile, which
// workspace, platform); config.toml's size+mtime is checked ON the entry and a
// mismatch replaces it. It used to be part of the KEY, so every edit left the
// previous entry behind until LRU eviction: 100 edits held 32 entries, and each
// held the whole config.toml text (measured 630 KiB, every one carrying the MCP
// server token that file held). An entry now keeps only what the fallback reads:
// the parsed `[projects]` trust entries and whether `project_root_markers` is
// mentioned.

const PROJECT_TRUST_CACHE = new Map();
const PROJECT_TRUST_CACHE_LIMIT = 32;
// One refresh per (entry, config, candidate set) at a time; see refreshProjectTrust.
const PROJECT_TRUST_INFLIGHT = new Map();
// Bumped by abandonProjectTrustRefreshes(). A refresh that settles under an older
// epoch stores nothing: the extension calls it from deactivate, right after it
// killed the worker, so an answer that is only "the worker was killed" can never
// become the cached verdict a same-realm re-activate reads.
let projectTrustEpoch = 0;
// The whole budget of one read-only ask from the host, worker deadline and its
// app-server's kill included (src/codex-mcp-config.js readCodexConfigLayersAsync).
// The write path keeps its 25 s deadline; a cold read measured 1.1 s here.
// 25 s, not 10 (2026-10-14). 10 s was sized while the ask still held the extension
// host. It has run on a worker thread since 2d8d223, behind a pending card, so a
// longer budget blocks nothing. Too short a budget, though, turns a slow machine into
// a minute of the narrow fallback. In CI run 38555104195 (Node 20, windows-latest) the
// ask settled after about 11 s, and its stand-in codex never wrote its start mark.
// That reads as a timeout; it is inferred, not measured on the runner. The same test
// takes about 2.8 s on Node 20 here. It sits just
// under the worker's own 25 s clamp: the deadline is this less 3 s, leaving 3 s for
// the grace, the kill and the exit.
const PROJECT_TRUST_ASYNC_TIMEOUT_MS = 25000;
// A TIMEOUT IS NOT A VERDICT (2026-10-14). Every failed ask settled into the
// config.toml fallback, cached like an answer until config.toml or the candidate
// folders changed. For "Codex is not reachable", or a reply from Codex itself,
// that is right: the answer describes the installation or the config, and an
// edit or install re-asks. A timeout describes neither. A cold app-server could
// miss the 7 s the worker got under the old 10 s budget (one took 3.3 s in an
// isolated home in the v1.6.3 confirmation audit; the budget is 25 s now, above), and that one
// slow start then held the narrow fallback for the life of the window. A timed-out
// ask is still shown as the fallback, which is the honest answer for now, but
// only for this long: after it the read is a miss again, the next push is
// pending and asks once more. A codex that never answers therefore costs one
// ask per minute of pushes, not one per push.
const PROJECT_TRUST_RETRY_MS = 60000;
const timedOutAsk = (asked) => asked instanceof Error && /\btimed out\b/i.test(String(asked.message || asked));
const injectedRpcIds = new WeakMap();
let nextInjectedRpcId = 0;

const USER_SCOPE_ONLY_NOTE =
  'Project rule folders (<project>/.codex/rules, which Codex loads only for a ' +
  'project it trusts) are not part of this set: it holds the user-scope rules alone.';

const PROJECT_TRUST_PENDING_NOTE =
  'Project rule folders (<project>/.codex/rules) are still being checked: Codex is being ' +
  'asked which of them it trusts in this workspace, so only the user-scope rules are ' +
  'counted until it answers.';

function fileSignature(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    return error && error.code === 'ENOENT' ? 'absent' : `unreadable:${error && error.code}`;
  }
}

function directoryExists(file) {
  try { return fs.statSync(file).isDirectory(); } catch { return false; }
}

// A repository the way git itself accepts one: a `.git` FILE (a linked worktree
// or submodule pointer) or a `.git` directory holding HEAD. The second clause is
// not pedantry. The home directory of the development box this was measured on
// has a `.git` directory holding only a credentials file; counted as a marker,
// it would put every workspace under the home inside one "repository" and start
// an app-server for folders Codex never considers.
function repositoryMarker(dir) {
  const marker = path.join(dir, '.git');
  try {
    const stat = fs.statSync(marker);
    return stat.isFile() || (stat.isDirectory() && fs.existsSync(path.join(marker, 'HEAD')));
  } catch { return false; }
}

// The `.codex` folders a session whose cwd is `root` could load RULES from. This
// only decides whether Codex needs asking at all, so it errs WIDE: a custom
// `project_root_markers` (any spelling, any table) widens it to every ancestor.
// Too wide costs one cached app-server start; too narrow would hide rules. The
// `rules` test is not a narrowing of that: both verdicts below only ever add
// `<folder>/rules`, and a folder that does not exist contributes no file.
function projectCandidates(root, codexHome, wide, fold) {
  const chain = [];
  let repository = false;
  for (let dir = root; ;) {
    chain.push(dir);
    if (!wide && repositoryMarker(dir)) { repository = true; break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return (wide || repository ? chain : [root])
    .map((dir) => path.join(dir, '.codex'))
    .filter((folder) => fold(folder) !== fold(codexHome) && directoryExists(path.join(folder, 'rules')));
}

// Codex's answer, or null when the reply has a shape this cannot read, which
// sends the caller to the narrow fallback rather than to a guess.
function layersVerdict(response, userDirectory, fold) {
  const directories = [];
  const notes = [];
  for (const layer of response.layers) {
    if (layer?.name?.type !== 'project') continue;
    const folder = layer.name.dotCodexFolder;
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) return null;
    const rules = path.join(folder, 'rules');
    if (layer.disabledReason) {
      if (directoryExists(rules)) {
        notes.push(`${rules} is not loaded: Codex reports that project layer as disabled` +
          (/trusted project/i.test(String(layer.disabledReason)) ? ' because the project is not trusted' : '') +
          ', so its rules were not checked.');
      }
      continue;
    }
    if (fold(rules) !== fold(userDirectory)) directories.push(rules);
  }
  return { directories, notes };
}

// `[projects.'<path>']` and `[projects."<path>"]` headers with the trust_level
// under each. Any other way of writing a projects entry is flagged, never
// interpreted: `other` makes the fallback say it saw trust it did not read.
const PROJECT_HEADER = /^\s*\[\s*projects\s*\.\s*(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\s*\]\s*$/;
const TRUST_LEVEL = /^\s*trust_level\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*$/;

// A basic-string key, decoding only `\\` and `\"`, the two escapes a Windows
// path needs. Any other escape returns null and the entry is not read.
function basicStringKey(body) {
  let value = '';
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== '\\') { value += body[index]; continue; }
    const next = body[index + 1];
    if (next !== '\\' && next !== '"') return null;
    value += next;
    index += 1;
  }
  return value;
}

function projectTrustEntries(text) {
  const entries = [];
  let current = null;
  let topLevel = true;
  let other = false;
  let fence = '';
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    // A multi-line string's body is content, not keys: a `[projects.'x']` line
    // inside developer instructions must not become trust.
    if (fence) {
      if (raw.split(fence).length % 2 === 0) fence = '';
      continue;
    }
    const opened = ['"""', "'''"].find((mark) => raw.split(mark).length % 2 === 0);
    if (opened) { fence = opened; continue; }
    const line = stripTomlComments(raw);
    if (/^\s*\[/.test(line)) {
      topLevel = false;
      const header = PROJECT_HEADER.exec(line);
      const key = header ? (header[1] !== undefined ? header[1] : basicStringKey(header[2])) : null;
      if (key !== null) {
        current = { key, trust: [] };
        entries.push(current);
      } else {
        current = null;
        if (/^\s*\[\[?\s*["']?projects\b/.test(line)) other = true;
      }
      continue;
    }
    if (current) {
      const trust = TRUST_LEVEL.exec(line);
      if (trust) current.trust.push(trust[1] !== undefined ? trust[1] : trust[2]);
      else if (/^\s*trust_level\b/.test(line)) other = true;
    } else if (topLevel && /^\s*["']?projects["']?\s*[.=]/.test(line)) other = true;
  }
  // Round-tripped through JSON so every key is a FRESH string. A regex capture
  // or a split line can be a slice that pins its whole parent in memory, and the
  // parent here is config.toml, MCP tokens and all; the cache keeps this result,
  // so a slice would keep the text this shape exists to drop.
  return JSON.parse(JSON.stringify({ entries, other }));
}

// `trust` is projectTrustEntries' result for the config.toml the entry was read
// from: the fallback never needs the text itself.
function configVerdict(root, candidates, trust, reason, platform, fold) {
  const foldText = (value) => (platform === 'win32' ? String(value).toLowerCase() : String(value));
  const notes = [`Codex could not be asked which project folders it trusts (${String(reason).slice(0, 200)}), ` +
    'so config.toml was read directly, and more narrowly than Codex reads it.'];
  const directories = [];
  const own = path.join(root, '.codex');
  const ownRules = path.join(own, 'rules');
  const { entries, other } = trust;
  if (candidates.some((folder) => fold(folder) === fold(own))) {
    // Both spellings Codex was measured to accept for a cwd: the path as given,
    // and its canonical long-name form, which is also the one Codex's own
    // "add <path> as a trusted project" message names.
    const forms = new Set([foldText(root)]);
    try { forms.add(foldText(fs.realpathSync.native(root))); } catch {}
    const matches = entries.filter((entry) => forms.has(foldText(entry.key)));
    const levels = matches.flatMap((entry) => (entry.trust.length ? entry.trust : ['(unset)']));
    if (levels.length && levels.every((level) => level === 'trusted')) directories.push(ownRules);
    else if (directoryExists(ownRules)) {
      notes.push(levels.length
        ? `${ownRules} was not included: config.toml ${levels.some((level) => level === 'trusted')
          ? 'gives this folder conflicting trust entries' : 'does not mark this folder trusted'}.`
        : `${ownRules} was not included: config.toml has no [projects] entry naming this exact folder, ` +
          'and Codex can also trust a folder through its repository or worktree root, which this ' +
          'reading does not resolve.');
    }
  }
  const enclosing = candidates.filter((folder) => fold(folder) !== fold(own))
    .map((folder) => path.join(folder, 'rules')).filter(directoryExists);
  if (enclosing.length) {
    notes.push(`Rule folders Codex may also load from enclosing folders were not checked: ${enclosing.join(', ')}.`);
  }
  if (other) {
    notes.push('config.toml also declares projects in a form this reading does not interpret ' +
      '(a dotted key, an inline table or a [projects] table), so no trust was taken from it.');
  }
  return { directories, notes };
}

// Everything the sync ask, the cached read and the async refresh share: the
// cache entry for this (Codex, profile, workspace, platform), replaced when
// config.toml's signature moved, and the candidate folders as they are NOW.
// Cheap: a stat and, on a config change, one read; no spawn.
function projectTrustLookup(options, codexHome, platform) {
  const root = path.resolve(String(options.workspaceRoot));
  const fold = (file) => (platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));
  const configFile = path.join(codexHome, 'config.toml');
  const rpc = typeof options.rpc === 'function' ? options.rpc : null;
  if (rpc && !injectedRpcIds.has(rpc)) injectedRpcIds.set(rpc, ++nextInjectedRpcId);
  // Everything that can change the answer without changing config.toml is in
  // the key: which Codex (and which injected test route) was asked, and for
  // which profile, workspace and platform. config.toml itself is checked on the
  // entry (see "CACHE SHAPE" above), so an edit replaces the entry in place.
  const key = JSON.stringify([rpc ? injectedRpcIds.get(rpc) : 0, String(options.codexExecutable || 'codex'),
    String(options.nodeExecutable || 'node'), options.home == null ? null : path.resolve(String(options.home)),
    fold(codexHome), fold(root), platform]);
  const config = fileSignature(configFile);
  let entry = PROJECT_TRUST_CACHE.get(key);
  if (!entry || entry.config !== config) {
    let text = '';
    try { text = fs.readFileSync(configFile, 'utf8'); } catch {}
    entry = { config, wide: /project_root_markers/.test(text), trust: projectTrustEntries(text),
      signature: null, verdict: null, retryAt: null };
  }
  PROJECT_TRUST_CACHE.delete(key);
  PROJECT_TRUST_CACHE.set(key, entry);
  while (PROJECT_TRUST_CACHE.size > PROJECT_TRUST_CACHE_LIMIT) {
    PROJECT_TRUST_CACHE.delete(PROJECT_TRUST_CACHE.keys().next().value);
  }
  // Re-evaluated when the folder set changes even though config.toml did not: a
  // `.codex/rules` folder created after the first ask is otherwise invisible
  // until the next config edit, which can be never.
  const candidates = projectCandidates(root, codexHome, entry.wide, fold);
  const signature = JSON.stringify(candidates.map(fold));
  const ask = { home: options.home, codexHome, workspaceRoot: root,
    codexExecutable: options.codexExecutable || 'codex', nodeExecutable: options.nodeExecutable, rpc };
  // `options.now` is a test clock for PROJECT_TRUST_RETRY_MS; callers pass none.
  const now = typeof options.now === 'function' ? options.now : Date.now;
  return { key, entry, root, fold, platform, codexHome, candidates, signature, ask, now,
    fresh: entry.verdict !== null && entry.signature === signature
      && (entry.retryAt === null || now() < entry.retryAt) };
}

// What Codex said, read into a verdict, or the narrow config.toml fallback when
// it could not be asked or said something unreadable. `asked` is the reply or
// the error; the sync ask and the async refresh both end here, so the two can
// never disagree about the same reply.
function verdictFrom(state, asked) {
  let reason;
  if (asked instanceof Error) reason = String(asked.message || asked);
  else {
    const verdict = layersVerdict(asked, path.join(state.codexHome, 'rules'), state.fold);
    if (verdict) return verdict;
    reason = 'Codex returned project layers in a shape this tool cannot read';
  }
  return configVerdict(state.root, state.candidates, state.entry.trust, reason, state.platform, state.fold);
}

// Stores only into the entry that is still cached: a config edit while the ask
// ran replaced it, and an answer about the old config must not stand for the new.
// `asked` is what verdictFrom read the verdict from; a timeout stands only until
// PROJECT_TRUST_RETRY_MS has passed (see there).
function settleProjectTrust(state, verdict, asked) {
  if (PROJECT_TRUST_CACHE.get(state.key) !== state.entry) return;
  state.entry.verdict = verdict;
  state.entry.signature = state.signature;
  state.entry.retryAt = timedOutAsk(asked) ? state.now() + PROJECT_TRUST_RETRY_MS : null;
}

const asError = (error) => (error instanceof Error ? error : new Error(String(error)));

function projectRuleDirectories(options, codexHome, platform) {
  if (!options.workspaceRoot) return { directories: [], notes: [USER_SCOPE_ONLY_NOTE] };
  const state = projectTrustLookup(options, codexHome, platform);
  if (!state.fresh) {
    if (!state.candidates.length) settleProjectTrust(state, { directories: [], notes: [] });
    else if (options.projectTrust === 'cached') {
      // The host's door: nothing cached for this config and folder set, so the
      // project folders are left OUT (never guessed) and the set says why. The
      // caller settles it with refreshProjectTrust and asks again.
      return { directories: [], notes: [PROJECT_TRUST_PENDING_NOTE], pending: true };
    } else {
      let asked;
      try {
        // Required here, not at the top: the MCP module pulls in the policy
        // writer, and nothing that never passes a workspace root should load it.
        const { readCodexConfigLayers } = require('./codex-mcp-config');
        asked = readCodexConfigLayers(state.ask);
      } catch (error) { asked = asError(error); }
      settleProjectTrust(state, verdictFrom(state, asked), asked);
    }
  }
  // Settled above if it was not fresh: a synchronous ask cannot race the entry
  // being replaced, so settle never refuses on this path.
  const { verdict } = state.entry;
  return { directories: verdict.directories.slice(), notes: verdict.notes.slice() };
}

// Settle the trust verdict the cached read is missing, OFF the calling thread:
// the same worker as the synchronous ask, launched asynchronously, bounded at
// PROJECT_TRUST_ASYNC_TIMEOUT_MS, and handed to `options.track` (the extension's
// trackChild, so deactivate ends it). Resolves `true` when something landed that
// a fresh read should show, `false` when there was nothing to do or the refresh
// was abandoned. Never rejects. Concurrent calls for one entry, config and
// folder set share one worker. `offThread: true` spawns it from a thread (src/spawn-thread.js).
function refreshProjectTrust(options = {}) {
  try {
    if (!options.workspaceRoot) return Promise.resolve(false);
    const state = projectTrustLookup(options, resolveCodexHome(options), options.platform || process.platform);
    if (state.fresh) return Promise.resolve(false);
    if (!state.candidates.length) {
      settleProjectTrust(state, { directories: [], notes: [] });
      return Promise.resolve(true);
    }
    const flight = `${state.key}\0${state.entry.config}\0${state.signature}`;
    if (PROJECT_TRUST_INFLIGHT.has(flight)) return PROJECT_TRUST_INFLIGHT.get(flight);
    const epoch = projectTrustEpoch;
    const promise = Promise.resolve()
      .then(() => require('./codex-mcp-config').readCodexConfigLayersAsync({ ...state.ask,
        track: options.track, timeoutMs: PROJECT_TRUST_ASYNC_TIMEOUT_MS, offThread: options.offThread === true }))
      .then((response) => response, asError)
      .then((asked) => {
        if (epoch !== projectTrustEpoch) return false;
        settleProjectTrust(state, verdictFrom(state, asked), asked);
        // True even when the entry moved on meanwhile: the caller's next read is
        // then a miss again, and asks again, which is the right answer to a
        // config.toml that changed under the question.
        return true;
      })
      .catch(() => false)
      .finally(() => { if (PROJECT_TRUST_INFLIGHT.get(flight) === promise) PROJECT_TRUST_INFLIGHT.delete(flight); });
    PROJECT_TRUST_INFLIGHT.set(flight, promise);
    return promise;
  } catch {
    return Promise.resolve(false);
  }
}

// The extension's deactivate, right after it killed every tracked child: any
// refresh still in flight stores nothing when it settles (its answer would be
// "the worker was killed"), and the next activation starts its own. Verdicts
// already cached stay; nothing about them depended on the activation.
function abandonProjectTrustRefreshes() {
  projectTrustEpoch += 1;
  PROJECT_TRUST_INFLIGHT.clear();
}

// CODEX_RULE_EXTENSION, MANAGED_POLICY_BLIND_SPOTS, codexRuleDirectories and
// parseEnterprisePrefixRules were exported when this parser was rewritten and never
// consumed from outside this module, including by tests. Unexported rather than
// deleted: every one of them is called internally, and MANAGED_POLICY_BLIND_SPOTS
// reaches the user through enterprisePolicyAssessment's verdict rather than directly.
// test/dead-exports.test.js is what caught them, on the merge. CODEX_BUNDLE_CACHE
// followed on 2026-10-13 off that census's PENDING_REMOVAL list: its one use is the
// default argument of readEnterpriseBundle, which is how the profile-routing test
// reaches it.
module.exports = {
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
  // The extension host's two doors onto the trust lookup (2026-10-14); see
  // "THE ASK NEVER RUNS ON THE EXTENSION HOST THREAD" above.
  refreshProjectTrust,
  abandonProjectTrustRefreshes,
};
