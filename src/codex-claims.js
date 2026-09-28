'use strict';

// Shared ownership for this tool's generated Codex block. Workspace evidence
// remains separate; this registry only retains the deterministic rules each
// writer already granted. It is not a general Starlark parser or a restore log.
const { CODEX_BEGIN_MARKER, removeGeneratedCodexRules, renderCodexRules,
  validateCodexRulesText } = require('./policy-exporters');
const { parseCodexRules, removeRuleSpans } = require('./codex-rule-inventory');

const VERSION = 1;
const END_MARKER = CODEX_BEGIN_MARKER.replace('BEGIN ', 'END ');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (text) => String(text).replace(/\r\n/g, '\n').trim();
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function managedBody(text) {
  const removed = removeGeneratedCodexRules(text);
  if (!removed.changed) {
    if (removed.reason === 'no generated block') return null;
    throw new Error(`Cannot read shared Codex policy: ${removed.reason}`);
  }
  const begin = new RegExp('^' + escape(CODEX_BEGIN_MARKER) + '[ \\t]*\\r?$', 'm').exec(text);
  const end = new RegExp('^' + escape(END_MARKER) + '[ \\t]*\\r?$', 'm').exec(text);
  return canonical(text.slice(begin.index + begin[0].length, end.index));
}

function checkedText(text, label) {
  if (typeof text !== 'string') throw new Error(`Cannot use malformed Codex policy claims: ${label} is not text`);
  const validation = validateCodexRulesText(text);
  if (!validation.valid) throw new Error(`Cannot use unsupported Codex policy claims: ${label}: ${validation.errors.join('; ')}`);
  return canonical(text);
}

function readCodexClaims(before, target) {
  if (!before.exists) return null;
  let raw;
  try { raw = JSON.parse(before.content.toString('utf8').replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error(`Cannot parse Codex policy claims: ${error.message}`); }
  if (!object(raw) || raw.version !== VERSION || raw.target !== target || !object(raw.claimants)) {
    throw new Error(`Cannot use malformed or unsupported Codex policy claims for ${target}`);
  }
  const result = { version: VERSION, target, baseline: checkedText(raw.baseline, 'legacy baseline'), claimants: {} };
  for (const [id, text] of Object.entries(raw.claimants)) {
    if (!/^state-sha256:[a-f0-9]{24}$/.test(id)) throw new Error('Cannot use malformed Codex policy claimant id');
    const checked = checkedText(text, id);
    if (!/\bprefix_rule\s*\(/.test(checked)) throw new Error('Cannot use empty Codex policy claim');
    result.claimants[id] = checked;
  }
  return result;
}

function generatedFrom(claims) {
  const parts = [...new Set([claims.baseline, ...Object.keys(claims.claimants).sort()
    .map((id) => claims.claimants[id])].filter(Boolean))];
  return parts.length ? parts.join('\n\n') + '\n' : renderCodexRules([]);
}

function updateCodexClaims(claims, target, claimant, generated, existing) {
  const body = managedBody(existing);
  if (claims) {
    // A manual removal or an older writer must not be mistaken for a missing
    // grant that this registry is authorized to bring back.
    if (body !== canonical(generatedFrom(claims))) throw new Error(
      'Refusing to update shared Codex policy because its generated block changed outside the recorded claims.',
    );
  } else {
    // An existing block predates shared ownership. Its writer is unknown, even
    // when its rules happen to equal this workspace's evidence. Keep it intact.
    claims = { version: VERSION, target, baseline: checkedText(body || '', 'existing generated block'), claimants: {} };
  }
  const next = { ...claims, claimants: { ...claims.claimants } };
  const text = checkedText(generated, claimant);
  if (/\bprefix_rule\s*\(/.test(text)) next.claimants[claimant] = text;
  else delete next.claimants[claimant];
  return { claims: next, generated: generatedFrom(next) };
}

function renderCodexClaims(claims) {
  const claimants = Object.fromEntries(Object.keys(claims.claimants).sort().map((id) => [id, claims.claimants[id]]));
  return JSON.stringify({ version: VERSION, target: claims.target, baseline: claims.baseline, claimants }, null, 2) + '\n';
}

// Remove an explicitly selected managed declaration from every owner of that
// declaration. Other workspaces keep their unrelated claims. This function
// only handles our generated block; arbitrary user rules use their exact spans.
function pruneCodexClaims(claims, target, existing, selected) {
  const body = managedBody(existing);
  if (claims && body !== canonical(generatedFrom(claims))) throw new Error(
    'Refusing removal because the generated Codex block differs from its shared claims.',
  );
  const current = claims || { version: VERSION, target, baseline: checkedText(body || '', 'existing generated block'), claimants: {} };
  const identity = ({ start, end, ...rule }) => JSON.stringify(rule);
  const selectedIds = new Set(selected.map(identity));
  const prune = (text) => {
    const parsed = parseCodexRules(text);
    if (!parsed.supported) throw new Error(`Cannot prune shared Codex claims: ${parsed.reason}`);
    return canonical(removeRuleSpans(text, parsed.rules.filter((rule) => selectedIds.has(identity(rule)))));
  };
  const next = { ...current, baseline: prune(current.baseline), claimants: {} };
  for (const [id, text] of Object.entries(current.claimants)) {
    const remaining = prune(text);
    if (parseCodexRules(remaining).rules.length) next.claimants[id] = remaining;
  }
  return { claims: next, generated: generatedFrom(next) };
}

// Reconcile an explicitly reviewed restore against the live generated body.
// Deleted declarations lose their old claimant membership; restored declarations
// become an unowned baseline. The caller owns removal-suppression checks, current
// file/selection checks, effective-policy validation and the write transaction.
function restoreCodexClaims(claims, target, existing, restoredTexts) {
  if (typeof existing !== 'string' || Buffer.from(existing, 'utf8').toString('utf8') !== existing) {
    throw new Error('Cannot restore shared Codex policy from non-text or lossy UTF-8 content');
  }
  const parsedFile = parseCodexRules(existing);
  if (!parsedFile.supported) throw new Error(`Cannot restore shared Codex policy: ${parsedFile.reason}`);
  const body = managedBody(existing);
  const markers = [CODEX_BEGIN_MARKER, END_MARKER].flatMap((marker) =>
    [...existing.matchAll(new RegExp('^' + escape(marker) + '[ \\t]*\\r?$', 'gm'))]);
  if (parsedFile.rules.some((rule) => markers.some((marker) => marker.index > rule.start && marker.index < rule.end))) {
    throw new Error('Cannot restore shared Codex policy: generated markers cross a declaration');
  }
  const current = claims == null ? { version: VERSION, target, baseline: '', claimants: {} }
    : readCodexClaims({ exists: true, content: Buffer.from(JSON.stringify(claims)) }, target);
  const live = checkedText(body || '', 'live generated block');
  const parsedLive = parseCodexRules(live);
  if (!parsedLive.supported) throw new Error(`Cannot restore shared Codex policy: ${parsedLive.reason}`);
  const identity = (text, rule) => canonical(text.slice(rule.start, rule.end));
  const liveIds = new Set(parsedLive.rules.map((rule) => identity(live, rule)));
  const claimedIds = new Set();
  const next = { version: VERSION, target, baseline: '', claimants: {} };
  for (const [id, text] of Object.entries(current.claimants)) {
    const parsed = parseCodexRules(text);
    if (!parsed.supported) throw new Error(`Cannot restore shared Codex claims: ${parsed.reason}`);
    const kept = parsed.rules.filter((rule) => liveIds.has(identity(text, rule)));
    if (!kept.length) continue;
    kept.forEach((rule) => claimedIds.add(identity(text, rule)));
    next.claimants[id] = canonical(removeRuleSpans(text, parsed.rules.filter((rule) => !liveIds.has(identity(text, rule)))));
  }
  // Keep every live declaration not demonstrably owned by an existing claimant.
  // Old baseline declarations missing from the live body must not return here.
  next.baseline = canonical(removeRuleSpans(live, parsedLive.rules.filter((rule) => claimedIds.has(identity(live, rule)))));
  if (!Array.isArray(restoredTexts)) throw new Error('Codex restored declarations must be an array');
  for (const text of restoredTexts) {
    const checked = checkedText(text, 'selected restore');
    const parsed = parseCodexRules(text);
    if (!parsed.supported || parsed.rules.length !== 1 || parsed.rules[0].start !== 0 || parsed.rules[0].end !== text.length) {
      throw new Error('Codex restored declarations must each contain exactly one complete literal rule');
    }
    if (liveIds.has(checked)) continue;
    next.baseline = [next.baseline, checked].filter(Boolean).join('\n\n');
    liveIds.add(checked);
  }
  return { claims: next, generated: generatedFrom(next) };
}

module.exports = { readCodexClaims, updateCodexClaims, renderCodexClaims, pruneCodexClaims, restoreCodexClaims };
