'use strict';

// Explicit removals outlive workspace evidence and ordinary Auto Learn Undo.
// A durable intent precedes all policy writes. Recovery only accepts the exact
// before/after bytes recorded by that intent; concurrent edits are never erased.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { codexRuleFileSet } = require('./codex-policy');
const { parseCodexRules, removeRuleSpans, patternsOverlap } = require('./codex-rule-inventory');
const { readCodexClaims, renderCodexClaims, pruneCodexClaims, restoreCodexClaims } = require('./codex-claims');
const { retainCodexPolicy, planCodexPolicyRestore } = require('./codex-policy-backup');
const { CODEX_BEGIN_MARKER, mergeGeneratedCodexRules } = require('./policy-exporters');
const { createCodexReviewedPlans } = require('./codex-reviewed-plans');

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const normalized = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const END_MARKER = CODEX_BEGIN_MARKER.replace('BEGIN ', 'END ');
const markerPattern = (marker) => new RegExp('^' + marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ \\t]*\\r?$', 'gm');

function createCodexRuleStore({ codexHome, target, workspaceRoot, claimsPath, storePath, backupPath, snapshot, atomicWrite, afterWrite, validate, assertExternalReady = () => {} }) {
  const scope = normalized(codexHome);
  const rulesDir = normalized(path.join(codexHome, 'rules'));
  const validPath = (file) => typeof file === 'string' && (normalized(file) === normalized(target) ||
    normalized(file) === normalized(claimsPath) ||
    (normalized(path.dirname(file)) === rulesDir && path.extname(file).toLowerCase() === '.rules'));
  function read() {
    const current = snapshot(storePath);
    if (!current.exists) return { version: 1, scope, patterns: [], pending: null };
    let raw;
    try { raw = JSON.parse(current.content.toString('utf8')); }
    catch (error) { throw new Error(`Cannot read Codex removal record: ${error.message}`); }
    if (!object(raw) || raw.version !== 1 || raw.scope !== scope || !Array.isArray(raw.patterns)) {
      throw new Error('Cannot use malformed or unsupported Codex removal record.');
    }
    try { for (const pattern of raw.patterns) patternsOverlap(pattern, pattern); }
    catch { throw new Error('Cannot use malformed Codex removal patterns.'); }
    if (raw.pending !== null) {
      const count = raw.pending?.kind === 'restore' ? raw.pending.restoredCount :
        raw.pending?.kind === 'approval' ? raw.pending.addedCount : raw.pending?.removedCount;
      if (!object(raw.pending) || ![undefined, 'restore', 'approval'].includes(raw.pending.kind) || !Number.isInteger(count) ||
          count < 1 || !Array.isArray(raw.pending.changes) || !raw.pending.changes.length) {
        throw new Error('Cannot use malformed pending Codex removal.');
      }
      const seen = new Set();
      for (const change of raw.pending.changes) {
        if (!object(change) || !validPath(change.path) || seen.has(normalized(change.path)) ||
            !/^[a-f0-9]{64}$/.test(change.beforeHash) || typeof change.existed !== 'boolean' ||
            typeof change.before !== 'string' || hash(Buffer.from(change.before, 'base64')) !== change.beforeHash ||
            typeof change.after !== 'string' || !/^[a-f0-9]{64}$/.test(change.afterHash) ||
            hash(Buffer.from(change.after, 'base64')) !== change.afterHash) {
          throw new Error('Cannot use malformed pending Codex removal change.');
        }
        seen.add(normalized(change.path));
      }
    }
    return raw;
  }
  const save = (record) => atomicWrite(storePath, JSON.stringify(record, null, 2) + '\n');
  const suppressed = (pattern, record = read()) => Array.isArray(pattern) && pattern.length > 0 &&
    record.patterns.some((removed) => patternsOverlap(pattern, removed));
  function assertReady(record = read(), options = {}) {
    if (record.pending?.kind === 'restore') throw new Error('Finish the interrupted Codex restore in Restore Codex rules before changing Codex policy.');
    if (record.pending?.kind === 'approval') throw new Error('Finish the interrupted Codex reviewed change in Review Codex approvals before changing Codex policy.');
    if (record.pending) throw new Error('Finish the interrupted Codex removal in Show Codex rules before changing Codex policy.');
    if (!options.allowMcpPending) assertExternalReady();
    return record;
  }
  function inventory() {
    const record = read();
    const set = codexRuleFileSet({ codexHome, target });
    const files = [];
    const rules = [];
    for (const file of set.files) {
      let before;
      try {
        if (!fs.lstatSync(file).isFile()) throw new Error('Linked or non-regular files are read-only.');
        before = snapshot(file);
        const text = before.content.toString('utf8');
        if (!Buffer.from(text).equals(before.content)) throw new Error('File is not lossless UTF-8.');
        const parsed = parseCodexRules(text);
        const begins = [...text.matchAll(markerPattern(CODEX_BEGIN_MARKER))];
        const ends = [...text.matchAll(markerPattern(END_MARKER))];
        const begin = begins.length === 1 ? begins[0].index : -1;
        const end = ends.length === 1 ? ends[0].index : -1;
        const ambiguous = (begins.length || ends.length) &&
          (!(begins.length === 1 && ends.length === 1 && end > begin) ||
            parsed.rules.some((rule) => [...begins, ...ends].some((marker) =>
              marker.index > rule.start && marker.index < rule.end)));
        files.push({ path: file, fileHash: before.hash, supported: parsed.supported && !ambiguous,
          reason: ambiguous ? 'Generated block markers are ambiguous; reconcile the file before removing rules.' : parsed.reason });
        if (!parsed.supported || ambiguous) continue;
        for (const rule of parsed.rules) {
          const owned = begin >= 0 && end > begin &&
            rule.start > begin && rule.end < end;
          const foreignManaged = owned && normalized(file) !== normalized(target);
          rules.push({ ...rule, id: hash(`${normalized(file)}\n${before.hash}\n${rule.start}:${rule.end}`),
            path: file, fileHash: before.hash, owned,
            removable: rule.decision === 'allow' && !record.pending && !foreignManaged,
            reason: record.pending ? 'An interrupted Codex policy change needs to finish first.' :
              foreignManaged ? 'Open the Codex rule target that owns this generated block to remove it.' :
              rule.decision === 'allow' ? undefined : 'Only allow rules can be removed here.' });
        }
      } catch (error) {
        files.push({ path: file, fileHash: before?.hash, supported: false, reason: error.message });
      }
    }
    for (const failure of set.failures) files.push({ path: failure.path, supported: false, reason: failure.message });
    return { files, rules, suppressionCount: record.patterns.length,
      pendingRemoval: Boolean(record.pending && !record.pending.kind), pendingRestore: record.pending?.kind === 'restore',
      pendingApproval: record.pending?.kind === 'approval',
      blindSpots: [...set.blindSpots,
        'Removal suppression applies to current Auto Learn builds using this Codex home. Older builds do not read it.',
        'Other matching rules can still allow a command. Restart active Codex sessions after changing rules.'] };
  }
  function finish(record) {
    assertExternalReady();
    const pending = record.pending;
    const operation = pending.kind === 'restore' ? 'restore' : pending.kind === 'approval' ? 'approval' : 'removal';
    // Preflight all files before touching any of them, including recovery.
    for (const change of pending.changes) {
      const current = snapshot(change.path);
      if (!(current.exists && current.hash === change.afterHash) &&
          !(current.exists === change.existed && current.hash === change.beforeHash)) {
        throw new Error(`Cannot finish Codex ${operation} because this file changed: ${change.path}. The recovery record is retained.`);
      }
    }
    for (const [index, change] of pending.changes.entries()) {
      const current = snapshot(change.path);
      if (current.exists && current.hash === change.afterHash) continue;
      if (current.exists !== change.existed || current.hash !== change.beforeHash) throw new Error(
        `Cannot finish Codex ${operation} because this file changed: ${change.path}. The recovery record is retained.`);
      atomicWrite(change.path, Buffer.from(change.after, 'base64'));
      if (afterWrite) afterWrite({ kind: 'codex-' + operation, path: change.path, index, afterHash: change.afterHash });
    }
    save({ ...record, pending: null, [operation === 'restore' ? 'lastRestore' : operation === 'approval' ? 'lastApproval' : 'lastRemoval']: pending });
    return { changed: true, ...(operation === 'restore' ? { restoredCount: pending.restoredCount } :
      operation === 'approval' ? { addedCount: pending.addedCount } : { removedCount: pending.removedCount }),
      paths: pending.changes.filter((change) => normalized(change.path) !== normalized(claimsPath)).map((change) => change.path),
      suppressedCount: record.patterns.length };
  }
  function remove(request = {}) {
    const record = read();
    if (request.resume === true) {
      if (record.pending?.kind === 'restore') throw new Error('Use Restore Codex rules to finish the interrupted restore.');
      if (record.pending?.kind === 'approval') throw new Error('Use Review Codex approvals to finish the interrupted reviewed change.');
      if (!record.pending) return { changed: false, removedCount: 0, paths: [], suppressedCount: record.patterns.length };
      return finish(record);
    }
    assertReady(record);
    if (!Array.isArray(request.rules) || request.rules.length !== 1) throw new Error('Select exactly one Codex allow rule to remove.');
    const selected = request.rules[0];
    const found = inventory().rules.find((rule) => rule.id === selected?.id &&
      rule.path === selected.path && rule.fileHash === selected.fileHash);
    if (!found?.removable) throw new Error('Codex rule selection is stale or read-only. Open the inventory again.');
    const before = snapshot(found.path);
    if (before.hash !== found.fileHash) throw new Error('Codex rule file changed after selection.');
    const text = before.content.toString('utf8');
    const parsed = parseCodexRules(text);
    const declaration = parsed.rules.find((rule) => rule.start === found.start && rule.end === found.end);
    let content = removeRuleSpans(text, [declaration]);
    const changes = [];
    if (found.owned) {
      const claimsBefore = snapshot(claimsPath);
      const next = pruneCodexClaims(readCodexClaims(claimsBefore, normalized(target)),
        normalized(target), text, [declaration]);
      content = mergeGeneratedCodexRules(text, next.generated);
      changes.push({ path: claimsPath, before: claimsBefore, content: Buffer.from(renderCodexClaims(next.claims)) });
    }
    changes.unshift({ path: found.path, before, content: Buffer.from(content) });
    validate(found.path, content);
    for (const change of changes) {
      const current = snapshot(change.path);
      if (current.exists !== change.before.exists || current.hash !== change.before.hash) throw new Error(
        `Codex policy changed while preparing removal: ${change.path}`);
    }
    const patterns = record.patterns.slice();
    if (!patterns.some((pattern) => JSON.stringify(pattern) === JSON.stringify(found.pattern))) patterns.push(found.pattern);
    const intent = { ...record, patterns, pending: { removedCount: 1, changes: changes.map((change) => ({
      path: change.path, existed: change.before.exists, beforeHash: change.before.hash,
      before: change.before.content.toString('base64'),
      after: change.content.toString('base64'), afterHash: hash(change.content),
    })) } };
    save(intent);
    return finish(intent);
  }
  function readBackup() {
    const before = snapshot(backupPath);
    if (!before.exists) return { version: 1, scope, files: [] };
    let catalog;
    try { catalog = JSON.parse(before.content.toString('utf8')); }
    catch (error) { throw new Error(`Cannot read Codex policy backup: ${error.message}`); }
    // The pure helper validates every saved declaration, not just the selected one.
    retainCodexPolicy(catalog, { scope, path: target, text: '' });
    return catalog;
  }
  function backup() {
    const record = read();
    if (record.pending) return { changed: false, pending: true, issues: [] };
    let catalog = readBackup();
    let changed = false;
    let addedCount = 0;
    const current = inventory();
    const issues = current.files.filter((file) => !file.supported).map(({ path, reason }) => ({ path, reason }));
    for (const file of current.files.filter((entry) => entry.supported)) {
      const before = snapshot(file.path);
      if (!before.exists || before.hash !== file.fileHash) throw new Error(`Codex rule file changed while backing up: ${file.path}`);
      const result = retainCodexPolicy(catalog, { scope, path: file.path, text: before.content.toString('utf8') });
      if (!result.supported) { issues.push({ path: file.path, reason: result.reason }); continue; }
      catalog = result.catalog;
      changed ||= result.changed;
      addedCount += result.addedCount;
    }
    if (changed) atomicWrite(backupPath, JSON.stringify(catalog, null, 2) + '\n');
    return { changed, addedCount, path: backupPath, issues };
  }
  function restoreInventory() {
    const record = read();
    const catalog = readBackup();
    const files = [];
    for (const saved of catalog.files) {
      if (!validPath(saved.path) || normalized(saved.path) === normalized(claimsPath)) {
        files.push({ path: saved.path, supported: false, reason: 'Select the original Codex home and rule target to restore this file.', restore: [] });
        continue;
      }
      try {
        if (fs.existsSync(saved.path) && !fs.lstatSync(saved.path).isFile()) throw new Error('Linked or non-regular files are read-only.');
        const before = snapshot(saved.path);
        const text = before.content.toString('utf8');
        if (!Buffer.from(text).equals(before.content)) throw new Error('File is not lossless UTF-8.');
        const plan = planCodexPolicyRestore(catalog, { scope, path: saved.path, text,
          exists: before.exists, expectedExists: before.exists, expectedHash: before.hash, suppressedPatterns: record.patterns });
        if (normalized(saved.path) !== normalized(target) && plan.restore.some((rule) => rule.managed)) {
          plan.conflicts.push(...plan.restore.filter((rule) => rule.managed).map((rule) => ({ ...rule, reason: 'Select the original generated rule target to restore this rule.' })));
          plan.restore = plan.restore.filter((rule) => !rule.managed);
        }
        if (plan.restore.some((rule) => rule.managed)) {
          try {
            restoreCodexClaims(readCodexClaims(snapshot(claimsPath), normalized(target)), normalized(target), text,
              plan.restore.filter((rule) => rule.managed).map((rule) => rule.text));
          } catch (error) {
            plan.conflicts.push(...plan.restore.filter((rule) => rule.managed).map((rule) => ({ ...rule, reason: error.message })));
            plan.restore = plan.restore.filter((rule) => !rule.managed);
          }
        }
        files.push(plan);
      } catch (error) { files.push({ path: saved.path, supported: false, reason: error.message, restore: [] }); }
    }
    return { files, backupPath, pendingRestore: record.pending?.kind === 'restore',
      pendingRemoval: Boolean(record.pending && !record.pending.kind), pendingApproval: record.pending?.kind === 'approval' };
  }
  function restore(request = {}) {
    const record = read();
    if (request.resume === true) {
      if (!record.pending) return { changed: false, restoredCount: 0, paths: [] };
      if (record.pending.kind === 'approval') throw new Error('Use Review Codex approvals to finish the interrupted reviewed change.');
      if (record.pending.kind !== 'restore') throw new Error('Finish the interrupted removal in Show Codex rules first.');
      return finish(record);
    }
    assertReady(record);
    const file = restoreInventory().files.find((entry) => entry.path === request.path && entry.supported &&
      entry.beforeHash === request.expectedHash && entry.exists === request.expectedExists);
    if (!file || !Array.isArray(request.ids) || !request.ids.length || new Set(request.ids).size !== request.ids.length ||
        request.ids.some((id) => !file.restore.some((rule) => rule.id === id))) {
      throw new Error('Codex restore selection is stale or read-only. Open Restore Codex rules again.');
    }
    const selected = file.restore.filter((rule) => request.ids.includes(rule.id));
    const before = snapshot(file.path);
    if (before.exists !== file.exists || before.hash !== file.beforeHash) throw new Error('Codex rule file changed after restore selection.');
    let content = before.content.toString('utf8');
    const changes = [];
    const managed = selected.filter((rule) => rule.managed);
    if (managed.length) {
      const claimsBefore = snapshot(claimsPath);
      const next = restoreCodexClaims(readCodexClaims(claimsBefore, normalized(target)), normalized(target), content, managed.map((rule) => rule.text));
      content = mergeGeneratedCodexRules(content, next.generated);
      changes.push({ path: claimsPath, before: claimsBefore, content: Buffer.from(renderCodexClaims(next.claims)) });
    }
    const external = selected.filter((rule) => !rule.managed);
    if (external.length) content += (content && !content.endsWith('\n') ? '\n' : '') + external.map((rule) => rule.text).join('\n') + '\n';
    changes.unshift({ path: file.path, before, content: Buffer.from(content) });
    validate(file.path, content);
    for (const change of changes) {
      const current = snapshot(change.path);
      if (current.exists !== change.before.exists || current.hash !== change.before.hash) throw new Error(`Codex policy changed while preparing restore: ${change.path}`);
    }
    const intent = { ...record, pending: { kind: 'restore', restoredCount: selected.length, changes: changes.map((change) => ({
      path: change.path, existed: change.before.exists, beforeHash: change.before.hash,
      before: change.before.content.toString('base64'), after: change.content.toString('base64'), afterHash: hash(change.content),
    })) } };
    save(intent);
    return finish(intent);
  }
  function reviewedPlans(record) {
    return createCodexReviewedPlans({ codexHome, target, workspaceRoot, snapshot,
      suppressed: (pattern) => suppressed(pattern, record) });
  }
  function approvalInventory(kind = 'stored-widening') {
    const record = read();
    const view = reviewedPlans(record).inventory(kind);
    return { ...view, plans: record.pending ? [] : view.plans,
      pendingApproval: record.pending?.kind === 'approval',
      pendingRemoval: Boolean(record.pending && !record.pending.kind),
      pendingRestore: record.pending?.kind === 'restore',
      ...(record.pending ? { reason: 'Finish the interrupted Codex policy change before reviewing another proposal.' } : {}) };
  }
  function approve(request = {}) {
    const record = read();
    if (request.resume === true) {
      if (!record.pending) return { changed: false, addedCount: 0, paths: [] };
      if (record.pending.kind !== 'approval') { assertReady(record); }
      const result = finish(record);
      backup();
      return result;
    }
    assertReady(record);
    const prepared = reviewedPlans(record).prepare(request);
    validate(prepared.path, prepared.content.toString('utf8'), prepared.checks);
    prepared.verify();
    const content = Buffer.isBuffer(prepared.content) ? prepared.content : Buffer.from(prepared.content);
    const intent = { ...record, pending: { kind: 'approval', addedCount: prepared.plan.additions.length,
      source: { path: prepared.plan.source.path, hash: prepared.plan.source.hash }, proposalKind: request.kind, changes: [{
        path: prepared.path, existed: prepared.before.exists, beforeHash: prepared.before.hash,
        before: prepared.before.content.toString('base64'), after: content.toString('base64'), afterHash: hash(content),
      }] } };
    save(intent);
    const result = finish(intent);
    backup();
    return result;
  }
  return { read, suppressed, assertReady, inventory, remove, backup, restoreInventory, restore, approvalInventory, approve };
}

module.exports = { createCodexRuleStore };
