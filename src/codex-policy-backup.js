'use strict';

// Pure high-water catalog and restore planning. The owning store must lock,
// reject pending removals, validate effective policy, reconcile current claims,
// and journal all file writes. Historical records never confer claimant identity.
const path = require('node:path');
const crypto = require('node:crypto');
const { parseCodexRules, patternsOverlap } = require('./codex-rule-inventory');
const { CODEX_BEGIN_MARKER } = require('./policy-exporters');

const VERSION = 1;
const END_MARKER = CODEX_BEGIN_MARKER.replace('BEGIN ', 'END ');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const markerPattern = (marker) => new RegExp('^' + marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ \\t]*\\r?$', 'gm');

function normalizedPath(value) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value)) {
    throw new TypeError('Codex backup scope and file paths must be absolute');
  }
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function canonicalPattern(pattern) {
  patternsOverlap(pattern, pattern); // Reject malformed patterns, never guess.
  return pattern.map((position) => Array.isArray(position)
    ? [...new Set(position)].sort() : position);
}

function patternIdentity(pattern) {
  return JSON.stringify(canonicalPattern(pattern));
}

function ruleId(file, rule) {
  return hash(JSON.stringify([file, rule.managed, canonicalPattern(rule.pattern), rule.decision]));
}

function ruleRecord(file, text, rule, managed) {
  const record = { pattern: canonicalPattern(rule.pattern), decision: rule.decision, text, managed };
  return { id: ruleId(file, record), ...record };
}

function literalFile(text) {
  if (typeof text !== 'string' || Buffer.from(text, 'utf8').toString('utf8') !== text) {
    return { supported: false, rules: [], reason: 'Codex backup requires lossless UTF-8 text' };
  }
  const parsed = parseCodexRules(text);
  if (!parsed.supported) return parsed;
  const begins = [...text.matchAll(markerPattern(CODEX_BEGIN_MARKER))];
  const ends = [...text.matchAll(markerPattern(END_MARKER))];
  const begin = begins.length === 1 ? begins[0].index : -1;
  const end = ends.length === 1 ? ends[0].index : -1;
  if ((begins.length || ends.length) &&
      (!(begins.length === 1 && ends.length === 1 && end > begin) ||
        parsed.rules.some((rule) => [...begins, ...ends].some((marker) =>
          marker.index > rule.start && marker.index < rule.end)))) {
    return { supported: false, rules: [], reason: 'Generated Codex block markers are ambiguous or cross a declaration' };
  }
  return { supported: true, rules: parsed.rules.map((rule) => ({ ...rule,
    managed: begin >= 0 && rule.start > begin && rule.end < end })) };
}

function checkedCatalog(catalog, scope) {
  if (catalog == null) return { version: VERSION, scope, files: [] };
  if (!object(catalog) || catalog.version !== VERSION || catalog.scope !== scope || !Array.isArray(catalog.files)) {
    throw new Error('Cannot use malformed, unsupported or differently scoped Codex policy backup');
  }
  const seenFiles = new Set();
  const files = catalog.files.map((entry) => {
    if (!object(entry) || typeof entry.path !== 'string' || !Array.isArray(entry.rules) ||
        normalizedPath(entry.path) !== entry.path || seenFiles.has(entry.path)) {
      throw new Error('Cannot use malformed or duplicate Codex backup file records');
    }
    seenFiles.add(entry.path);
    const seenRules = new Set();
    const rules = entry.rules.map((record) => {
      if (!object(record) || typeof record.managed !== 'boolean' || typeof record.text !== 'string') {
        throw new Error('Cannot use malformed Codex backup declarations');
      }
      const parsed = literalFile(record.text);
      const declaration = parsed.rules[0];
      if (!parsed.supported || parsed.rules.length !== 1 || declaration.start !== 0 ||
          declaration.end !== record.text.length || declaration.decision !== record.decision ||
          patternIdentity(declaration.pattern) !== patternIdentity(record.pattern)) {
        throw new Error('Cannot use malformed or inconsistent Codex backup declarations');
      }
      const checked = ruleRecord(entry.path, record.text, declaration, record.managed);
      if (record.id !== checked.id || seenRules.has(checked.id)) {
        throw new Error('Cannot use changed identities or duplicate Codex backup declarations');
      }
      seenRules.add(checked.id);
      return checked;
    });
    return { path: entry.path, rules };
  });
  return { version: VERSION, scope, files };
}

/** Retain observed literal declarations, without pruning prior observations. */
function retainCodexPolicy(catalog, options = {}) {
  const scope = normalizedPath(options.scope);
  const file = normalizedPath(options.path);
  const current = checkedCatalog(catalog, scope);
  const parsed = literalFile(options.text);
  if (!parsed.supported) return { supported: false, reason: parsed.reason,
    catalog: current, addedCount: 0, changed: false };
  let entry = current.files.find((item) => item.path === file);
  const records = parsed.rules.map((rule) => ruleRecord(file,
    options.text.slice(rule.start, rule.end), rule, rule.managed));
  const additions = records.filter((record, index) =>
    !entry?.rules.some((prior) => prior.id === record.id) &&
    records.findIndex((other) => other.id === record.id) === index);
  if (additions.length) {
    if (!entry) {
      entry = { path: file, rules: [] };
      current.files.push(entry);
    }
    entry.rules.push(...additions);
    entry.rules.sort((a, b) => a.id.localeCompare(b.id));
    current.files.sort((a, b) => a.path.localeCompare(b.path));
  }
  return { supported: true, catalog: current, addedCount: additions.length, changed: additions.length > 0 };
}

/**
 * Plan only the requested original file. An omitted selectedIds previews all
 * retained declarations; a write caller must use the ids the user reviewed.
 * managed:true identifies provenance, not authority to restore old claimants.
 */
function planCodexPolicyRestore(catalog, options = {}) {
  const scope = normalizedPath(options.scope);
  const file = normalizedPath(options.path);
  const saved = checkedCatalog(catalog, scope);
  if (typeof options.exists !== 'boolean' || typeof options.expectedExists !== 'boolean' ||
      typeof options.text !== 'string' || (!options.exists && options.text !== '') ||
      typeof options.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(options.expectedHash)) {
    throw new Error('Codex restore needs current text, existence and the reviewed file hash/existence');
  }
  const beforeHash = hash(Buffer.from(options.text, 'utf8'));
  if (options.exists !== options.expectedExists || beforeHash !== options.expectedHash) {
    throw new Error('Codex restore selection is stale: file bytes or existence changed');
  }
  if (!Array.isArray(options.suppressedPatterns)) throw new Error('Codex restore needs the current removal-suppression patterns');
  for (const pattern of options.suppressedPatterns) canonicalPattern(pattern);
  const retained = saved.files.find((entry) => entry.path === file)?.rules || [];
  let selected = retained;
  if (options.selectedIds !== undefined) {
    if (!Array.isArray(options.selectedIds) || options.selectedIds.some((id) => typeof id !== 'string') ||
        new Set(options.selectedIds).size !== options.selectedIds.length) {
      throw new Error('Codex restore selection must contain unique retained declaration ids');
    }
    selected = options.selectedIds.map((id) => {
      const record = retained.find((rule) => rule.id === id);
      if (!record) throw new Error('Codex restore selection is stale or belongs to another file');
      return record;
    });
  }
  const plan = { supported: true, path: file, exists: options.exists, beforeHash,
    restore: [], present: [], suppressed: [], conflicts: [] };
  const parsed = literalFile(options.text);
  if (!parsed.supported) return { ...plan, supported: false, reason: parsed.reason };
  for (const record of selected) {
    const samePattern = parsed.rules.filter((rule) =>
      patternIdentity(rule.pattern) === patternIdentity(record.pattern));
    if (samePattern.some((rule) => rule.decision === record.decision && rule.managed === record.managed)) {
      plan.present.push(record);
    } else if (record.decision === 'allow' && options.suppressedPatterns.some((removed) =>
      patternsOverlap(record.pattern, removed))) {
      plan.suppressed.push({ ...record, reason: 'An explicit removal overlaps this saved allow prefix' });
    } else if (samePattern.length) {
      plan.conflicts.push({ ...record, reason: samePattern.some((rule) => rule.decision !== record.decision)
        ? 'The current declaration has a different decision'
        : 'The current declaration has different generated ownership' });
    } else plan.restore.push(record);
  }
  return plan;
}

module.exports = { retainCodexPolicy, planCodexPolicyRestore };
