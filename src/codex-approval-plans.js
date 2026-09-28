'use strict';

// Read-only proposals. Callers must re-read the source, resolve a selected id
// against a fresh plan, enforce removal suppression, and validate the effective
// target policy under the store lock before writing anything.
const path = require('node:path');
const crypto = require('node:crypto');
const { extractInvocations, isAutoSafeCandidate } = require('./auto-learn');
const { parseCodexRules, patternsOverlap } = require('./codex-rule-inventory');
const { CODEX_BEGIN_MARKER } = require('./policy-exporters');

const END_MARKER = CODEX_BEGIN_MARKER.replace('BEGIN ', 'END ');
const MAX_ALTERNATIVES = 256;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const markerPattern = (marker) => new RegExp('^' + marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ \\t]*\\r?$', 'gm');

function absolutePath(value) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value)) {
    throw new TypeError('Codex proposal source and workspace paths must be absolute');
  }
  return path.resolve(value);
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sourceFile(options) {
  const file = absolutePath(options.path);
  const text = options.text;
  const source = { path: file, hash: typeof text === 'string' ? hash(Buffer.from(text, 'utf8')) : null };
  const result = { supported: false, source, plans: [], skipped: [] };
  if (typeof text !== 'string' || Buffer.from(text, 'utf8').toString('utf8') !== text) {
    return { ...result, reason: 'Codex proposals require lossless UTF-8 source text' };
  }
  const parsed = parseCodexRules(text);
  if (!parsed.supported) return { ...result, reason: parsed.reason };
  const begins = [...text.matchAll(markerPattern(CODEX_BEGIN_MARKER))];
  const ends = [...text.matchAll(markerPattern(END_MARKER))];
  const begin = begins.length === 1 ? begins[0].index : -1;
  const end = ends.length === 1 ? ends[0].index : -1;
  if ((begins.length || ends.length) &&
      (!(begins.length === 1 && ends.length === 1 && end > begin) ||
       parsed.rules.some((rule) => [...begins, ...ends].some((marker) =>
         marker.index > rule.start && marker.index < rule.end)))) {
    return { ...result, reason: 'Generated Codex block markers are ambiguous or cross a declaration' };
  }
  return { ...result, supported: true, rules: parsed.rules.map((rule) => ({ ...rule,
    origin: begin >= 0 && rule.start > begin && rule.end < end ? 'generated' : 'authored' })) };
}

function sourceRule(source, text, rule) {
  return { ...source, start: rule.start, end: rule.end, text: text.slice(rule.start, rule.end),
    pattern: rule.pattern, decision: rule.decision, origin: rule.origin };
}

function expandPattern(pattern) {
  let argv = [[]];
  for (const position of pattern) {
    const alternatives = Array.isArray(position) ? [...new Set(position)] : [position];
    if (argv.length * alternatives.length > MAX_ALTERNATIVES) return null;
    argv = argv.flatMap((prefix) => alternatives.map((token) => [...prefix, token]));
  }
  return argv;
}

function classifyLiteral(argv) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(argv[0])) {
    return { reason: 'Path-specific, dynamic or non-bare executables are not portable' };
  }
  if (argv.some((token) => /[\\/$%~\x00-\x20\x7f]/.test(token) || token === '.' || token === '..')) {
    return { reason: 'Contextual paths, environment references or whitespace arguments are not portable' };
  }
  // This string is never executed. Exact argv round-tripping prevents shell
  // parsing, wrapper removal or quote interpretation from changing the policy.
  const command = [argv[0], ...argv.slice(1).map((token) => "'" + token.replace(/'/g, "'\"'\"'") + "'")].join(' ');
  const invocations = extractInvocations('Bash', command, { shell: 'bash' });
  if (invocations.length !== 1 || !same(invocations[0].argv, argv) ||
      !same(invocations[0].prefix, argv.slice(0, invocations[0].prefix.length))) {
    return { reason: 'The literal argv cannot be classified without changing its spelling or order' };
  }
  const invocation = invocations[0];
  // Without tool-specific argument semantics, a positional suffix or a flag
  // value may name a project resource. Keep those records visible but skip them.
  if (argv.slice(invocation.prefix.length).some((token) => !/^--?[A-Za-z0-9][A-Za-z0-9_-]*$/.test(token))) {
    return { reason: 'Positional suffixes and value-bearing flags need project-specific review' };
  }
  return { invocation, autoSafe: isAutoSafeCandidate(invocation) };
}

function analyze(rule) {
  const alternatives = expandPattern(rule.pattern);
  if (!alternatives) return { reason: `More than ${MAX_ALTERNATIVES} literal argv alternatives require manual review` };
  const classified = alternatives.map(classifyLiteral);
  const refused = classified.find((entry) => entry.reason);
  return refused || { alternatives, invocations: classified.map((entry) => entry.invocation),
    autoSafe: classified.every((entry) => entry.autoSafe) };
}

function declaration(pattern, decision) {
  return `prefix_rule(pattern = ${JSON.stringify(pattern)}, decision = ${JSON.stringify(decision)})`;
}

function coversArgv(pattern, argv) {
  return pattern.length <= argv.length && pattern.every((position, index) =>
    (Array.isArray(position) ? position : [position]).includes(argv[index]));
}

function proposal(kind, source, target, autoSafe, reviewReason) {
  return { id: hash(JSON.stringify([kind, source, target])), kind, source, target,
    preserveSource: true, reviewRequired: true, autoApply: false, autoSafe, reviewReason };
}

/** Offer only shorter deterministic auto-safe prefixes from stored allow rules. */
function planStoredCodexApprovals(options = {}) {
  const parsed = sourceFile(options);
  if (!parsed.supported) return parsed;
  const { rules, ...result } = parsed;
  for (const rule of rules) {
    const source = sourceRule(result.source, options.text, rule);
    const skip = (reason) => result.skipped.push({ source, reason });
    if (rule.origin === 'generated') { skip('Generated declarations remain owned by Auto Learn; they are not stored-approval widening inputs'); continue; }
    if (rule.decision !== 'allow') { skip('Restrictive decisions are preserved and never widened'); continue; }
    const analyzed = analyze(rule);
    if (analyzed.reason) { skip(analyzed.reason); continue; }
    if (!analyzed.autoSafe) { skip('The existing classifier does not prove every alternative is auto-safe'); continue; }
    const length = analyzed.invocations[0].prefix.length;
    if (analyzed.invocations.some((entry) => entry.prefix.length !== length)) {
      skip('Alternatives have different reusable prefix lengths'); continue;
    }
    if (length >= rule.pattern.length) { skip('The stored declaration already has a reusable prefix'); continue; }
    const pattern = rule.pattern.slice(0, length);
    if (rules.some((entry) => entry.decision !== 'allow' && patternsOverlap(pattern, entry.pattern))) {
      skip('A prompt or forbidden declaration overlaps the proposed wider prefix'); continue;
    }
    if (expandPattern(pattern).every((argv) => rules.some((entry) =>
      entry.decision === 'allow' && coversArgv(entry.pattern, argv)))) {
      skip('An existing allow declaration already covers the proposed prefix'); continue;
    }
    const target = { pattern, decision: 'allow', text: declaration(pattern, 'allow') };
    if (result.plans.some((entry) => same(entry.target.pattern, pattern))) {
      skip('Another source declaration already proposes this exact prefix'); continue;
    }
    result.plans.push(proposal('stored-widening', source, target, true,
      'Review the shorter auto-safe argv prefix; the original declaration and its inline tests stay unchanged'));
  }
  return result;
}

/** Copy exact portable authored declarations from one project-local rule file. */
function planProjectCodexRules(options = {}) {
  const workspace = absolutePath(options.workspaceRoot);
  const file = absolutePath(options.path);
  if (!samePath(path.dirname(file), path.join(workspace, '.codex', 'rules')) || path.extname(file) !== '.rules') {
    return { supported: false, source: { path: file, hash: typeof options.text === 'string' ? hash(Buffer.from(options.text, 'utf8')) : null },
      plans: [], skipped: [], reason: 'Project imports require a direct .codex/rules/*.rules source in the selected workspace' };
  }
  const parsed = sourceFile(options);
  if (!parsed.supported) return parsed;
  const { rules, ...result } = parsed;
  for (const rule of rules) {
    const source = sourceRule(result.source, options.text, rule);
    const skip = (reason) => result.skipped.push({ source, reason });
    if (rule.origin === 'generated') { skip('Generated project declarations are not authored policy and cannot be imported as user-owned rules'); continue; }
    const analyzed = analyze(rule);
    if (analyzed.reason) { skip(analyzed.reason); continue; }
    const autoSafe = rule.decision === 'allow' && analyzed.autoSafe;
    const reviewReason = rule.decision !== 'allow'
      ? 'Review this exact restrictive declaration in user scope; it will affect other workspaces'
      : autoSafe ? 'Review this exact authored allow declaration in user scope; it will affect other workspaces'
        : 'This allow is not auto-safe; explicit review is required for its exact argv prefix in user scope';
    result.plans.push(proposal('project-import', source,
      { pattern: rule.pattern, decision: rule.decision, text: source.text }, autoSafe, reviewReason));
  }
  return result;
}

module.exports = { planStoredCodexApprovals, planProjectCodexRules };
