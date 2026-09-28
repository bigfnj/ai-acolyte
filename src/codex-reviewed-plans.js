'use strict';

// Read-only, snapshot-bound reviewed writes. The store owns locking, effective
// execpolicy validation, the durable intent, the final write and backup capture.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { planStoredCodexApprovals, planProjectCodexRules } = require('./codex-approval-plans');
const { patternsOverlap } = require('./codex-rule-inventory');
const { CODEX_BEGIN_MARKER } = require('./policy-exporters');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const normalized = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const signature = (value) => hash(JSON.stringify(value));
const END_MARKER = CODEX_BEGIN_MARKER.replace('BEGIN ', 'END ');
const markerPattern = (marker) => new RegExp('^' + marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ \\t]*\\r?$', 'm');

function absolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
  return path.resolve(value);
}

// Prefix coverage without expanding grouped alternatives. A declaration covers
// the whole target only when it covers every alternative on every prefix axis.
function covers(cover, target) {
  return cover.length <= target.length && cover.every((position, index) => {
    const allowed = Array.isArray(position) ? position : [position];
    return (Array.isArray(target[index]) ? target[index] : [target[index]]).every((token) => allowed.includes(token));
  });
}

function ordinaryParents(file, includeLeaf = false) {
  const resolved = path.resolve(file);
  const root = path.parse(resolved).root;
  const parts = path.relative(root, includeLeaf ? resolved : path.dirname(resolved)).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Linked or non-directory policy parent is unsupported: ${current}`);
  }
  return true;
}

function createCodexReviewedPlans({ codexHome, target, workspaceRoot, snapshot, suppressed }) {
  codexHome = absolute(codexHome, 'codexHome');
  workspaceRoot = workspaceRoot == null ? null : absolute(workspaceRoot, 'workspaceRoot');
  target = absolute(target, 'target');
  if (typeof snapshot !== 'function' || typeof suppressed !== 'function') throw new TypeError('snapshot and suppressed callbacks are required');
  const destination = path.join(codexHome, 'rules', 'ai-acolyte-reviewed.rules');
  const userDirectory = path.join(codexHome, 'rules');
  const projectDirectory = workspaceRoot ? path.join(workspaceRoot, '.codex', 'rules') : null;

  function readFile(file, scopes) {
    const record = { path: file, scopes: [...scopes].sort(), exists: false, hash: hash(Buffer.alloc(0)), supported: false };
    try {
      const parentsExist = ordinaryParents(file);
      let stat;
      if (parentsExist) {
        try { stat = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      record.exists = Boolean(stat);
      if (stat) record.stat = { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino,
        type: stat.isSymbolicLink() ? 'link' : stat.isFile() ? 'file' : 'other' };
      if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error('Policy input must be an ordinary file');
      const before = snapshot(file);
      if (!before || typeof before.exists !== 'boolean' || !Buffer.isBuffer(before.content) ||
          before.hash !== hash(before.content) || before.exists !== Boolean(stat)) {
        throw new Error('Policy snapshot changed or returned an invalid content hash');
      }
      ordinaryParents(file);
      let after;
      try { after = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (Boolean(after) !== Boolean(stat) || (after && (!after.isFile() || after.isSymbolicLink() ||
          after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino))) {
        throw new Error('Policy input changed while being read');
      }
      record.exists = before.exists; record.hash = before.hash;
      const text = before.content.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(before.content)) throw new Error('Policy input is not lossless UTF-8');
      const stored = planStoredCodexApprovals({ path: file, text });
      if (!stored.supported) throw new Error(stored.reason);
      const sources = [...stored.plans.map((entry) => entry.source), ...stored.skipped.map((entry) => entry.source)]
        .sort((a, b) => a.start - b.start);
      record.supported = true;
      return { record, before, text, sources, stored,
        generated: markerPattern(CODEX_BEGIN_MARKER).test(text) || markerPattern(END_MARKER).test(text) };
    } catch (error) {
      record.reason = String(error.message || error);
      return { record, sources: [] };
    }
  }

  function collect() {
    const candidates = new Map();
    const directories = [];
    const add = (file, scope) => {
      const key = normalized(file);
      if (!candidates.has(key)) candidates.set(key, { path: path.resolve(file), scopes: new Set() });
      candidates.get(key).scopes.add(scope);
    };
    for (const [directory, scope] of [[userDirectory, 'user'], ...(projectDirectory ? [[projectDirectory, 'project']] : [])]) {
      const record = { path: directory, scope, exists: false, supported: true, entries: [] };
      try {
        if (ordinaryParents(directory, true)) {
          record.exists = true;
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (!entry.name.toLowerCase().endsWith('.rules')) continue;
            record.entries.push({ name: entry.name, type: entry.isSymbolicLink() ? 'link' : entry.isFile() ? 'file' : 'other' });
            add(path.join(directory, entry.name), scope);
          }
          record.entries.sort((a, b) => compare(a.name, b.name));
        }
      } catch (error) { record.supported = false; record.reason = String(error.message || error); }
      directories.push(record);
    }
    add(target, 'user'); add(destination, 'user');
    const files = [...candidates.values()].sort((a, b) => compare(normalized(a.path), normalized(b.path)))
      .map((entry) => readFile(entry.path, entry.scopes));
    const visible = { directories, files: files.map((entry) => entry.record) };
    return { files, directories, visible, digest: signature(visible) };
  }

  function build(kind) {
    if (!['stored-widening', 'project-import'].includes(kind)) throw new Error('Unknown reviewed Codex proposal kind');
    const current = collect();
    const dest = current.files.find((entry) => normalized(entry.record.path) === normalized(destination));
    const result = { kind, destination, files: current.visible.files.concat(current.directories.filter((entry) => !entry.supported)
      .map((entry) => ({ path: entry.path, scopes: [entry.scope], supported: false, reason: entry.reason }))), plans: [], skipped: [] };
    if (kind === 'project-import' && !workspaceRoot) {
      result.reason = 'Select a workspace before importing project-local Codex rules';
      return { result, current, dest };
    }
    if (!dest?.record.supported || dest.generated) {
      result.reason = dest?.record.reason || 'Reviewed destination contains generated ownership; reconcile it before appending reviewed rules';
      return { result, current, dest };
    }
    const unsafeVisible = current.files.find((entry) => !entry.record.supported) || current.directories.find((entry) => !entry.supported);
    const userRules = current.files.filter((entry) => entry.record.scopes.includes('user')).flatMap((entry) => entry.sources);
    const projectFiles = current.files.filter((entry) => entry.record.scopes.includes('project') && entry.record.supported)
      .map((entry) => ({ ...entry, project: planProjectCodexRules({ workspaceRoot, path: entry.record.path, text: entry.text }) }));
    const projectConstraints = projectFiles.flatMap((entry) => entry.sources.filter((source) => source.decision !== 'allow')
      .map((source) => ({ source, portable: entry.project.supported && entry.project.plans.some((plan) =>
        plan.source.start === source.start && plan.source.end === source.end), reason: entry.project.reason ||
          entry.project.skipped.find((item) => item.source.start === source.start)?.reason })));
    const candidates = kind === 'stored-widening'
      ? current.files.filter((entry) => entry.record.scopes.includes('user') && entry.record.supported)
        .flatMap((entry) => { result.skipped.push(...entry.stored.skipped); return entry.stored.plans; })
      : projectFiles.flatMap((entry) => {
        result.skipped.push(...entry.project.skipped);
        if (!entry.project.supported) result.skipped.push({ source: { path: entry.record.path, hash: entry.record.hash }, reason: entry.project.reason });
        return entry.project.plans;
      });
    const equivalent = (rule) => userRules.some((entry) => entry.decision === rule.decision && covers(entry.pattern, rule.pattern));
    for (const candidate of candidates) {
      const reject = (reason) => result.skipped.push({ source: candidate.source, reason });
      const dependencies = [];
      if (candidate.target.decision === 'allow') {
        if (unsafeVisible) { reject('A visible user or project policy input is unreadable or unsupported; an allow cannot be proposed safely'); continue; }
        if (suppressed(candidate.target.pattern)) { reject('This allow overlaps an intentional Codex removal'); continue; }
        if (kind === 'stored-widening' && userRules.some((rule) => rule.decision !== 'allow' && patternsOverlap(rule.pattern, candidate.target.pattern))) {
          reject('A restrictive user rule in the visible file set overlaps this wider allow'); continue;
        }
        if (kind === 'project-import') {
          const reached = [candidate.target.pattern];
          const taken = new Set();
          let refused;
          for (let index = 0; index < reached.length && !refused; index += 1) {
            for (const constraint of projectConstraints) {
              const key = `${normalized(constraint.source.path)}:${constraint.source.start}:${constraint.source.end}`;
              if (taken.has(key) || !patternsOverlap(reached[index], constraint.source.pattern)) continue;
              taken.add(key);
              if (!constraint.portable || constraint.source.origin === 'generated') {
                refused = 'An overlapping project restriction is generated or nonportable and cannot be bundled safely'; break;
              }
              dependencies.push(constraint.source); reached.push(constraint.source.pattern);
            }
          }
          if (refused) { reject(refused); continue; }
          if (dependencies.some((entry) => covers(entry.pattern, candidate.target.pattern))) {
            reject('A bundled restriction covers this allow completely; review the restrictive declaration separately'); continue;
          }
        }
      }
      if (equivalent(candidate.target)) { reject('An equivalent or broader user declaration already covers this proposal'); continue; }
      dependencies.sort((a, b) => compare(normalized(a.path), normalized(b.path)) || a.start - b.start);
      const declarations = [...dependencies, { ...candidate.target, path: candidate.source.path, start: candidate.source.start, end: candidate.source.end }];
      const additions = [];
      for (const entry of declarations) {
        if (equivalent(entry) || additions.some((prior) => prior.decision === entry.decision && same(prior.pattern, entry.pattern))) continue;
        additions.push({ pattern: entry.pattern, decision: entry.decision, text: entry.text });
      }
      const checks = declarations.filter((entry, index) => !declarations.slice(0, index)
        .some((prior) => prior.decision === entry.decision && same(prior.pattern, entry.pattern)))
        .map(({ pattern, decision }) => ({ pattern, decision }));
      const plan = { ...candidate, destination, dependencies, additions, checks,
        destinationSnapshot: { exists: dest.before.exists, hash: dest.before.hash },
        visibleSignature: current.digest, visibleFiles: current.visible.files };
      plan.id = signature([candidate.kind, candidate.source, candidate.target, dependencies, additions, checks,
        plan.destinationSnapshot, current.digest]);
      result.plans.push(plan);
    }
    return { result, current, dest };
  }

  function inventory(kind) { return build(kind).result; }

  function prepare({ kind, id } = {}) {
    if (typeof id !== 'string' || !id) throw new Error('A reviewed Codex proposal id is required');
    const { result, dest } = build(kind);
    const plan = result.plans.find((entry) => entry.id === id);
    if (!plan) throw new Error('Selected Codex proposal is stale or unavailable; review the current inventory again');
    const newline = dest.text.includes('\r\n') ? '\r\n' : '\n';
    const separator = dest.text && !/[\r\n]$/.test(dest.text) ? newline : '';
    const appended = plan.additions.map((entry) => entry.text).join(newline) + newline;
    const content = Buffer.concat([dest.before.content, Buffer.from(separator + appended, 'utf8')]);
    return { plan, path: destination, before: dest.before, content, checks: plan.checks,
      verify() {
        const fresh = build(kind).result;
        if (!fresh.plans.some((entry) => entry.id === id)) throw new Error('Reviewed Codex proposal changed before writing; review the current files again');
        return true;
      } };
  }

  return { inventory, prepare };
}

module.exports = { createCodexReviewedPlans };
