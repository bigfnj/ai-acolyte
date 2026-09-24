'use strict';

// Strict, one-way cleanup for high-water backups polluted by the retired MAX
// feature. This module never creates permissions. Callers must hold the shared
// policy lock so a normal backup union cannot race the purge.

const fs = require('fs');
const path = require('path');

function parseBackupText(text) {
  let value;
  try { value = JSON.parse(text); }
  catch { return null; }
  if (Array.isArray(value)) {
    return { value, allow: value, deny: [], legacyArray: true };
  }
  if (!value || typeof value !== 'object') return null;
  const allow = value.allow === undefined ? [] : value.allow;
  const deny = value.deny === undefined ? [] : value.deny;
  if (!Array.isArray(allow) || !Array.isArray(deny)) return null;
  return { value, allow, deny, legacyArray: false };
}

function cleanedValue(parsed, removals) {
  const drop = new Set(removals);
  const allow = parsed.allow.filter((entry) => !drop.has(entry));
  if (parsed.legacyArray) return allow;
  return { ...parsed.value, allow };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pathKey(file) {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function purgeLegacyBackupCopies(files, removals, options = {}) {
  const fsImpl = options.fs ?? fs;
  const writeFile = options.writeFile ?? ((target, content) => {
    // Lazy to keep the pure parser usable without loading the larger permission
    // engine and to avoid a module cycle in injected tests.
    require('./permissions').writeFileAtomicSync(target, content);
  });
  const targets = [];
  const seen = new Set();
  for (const file of Array.isArray(files) ? files : []) {
    if (typeof file !== 'string' || !file) continue;
    const key = pathKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(file);
  }

  const drop = [...new Set((Array.isArray(removals) ? removals : [])
    .filter((entry) => typeof entry === 'string'))];
  const reports = [];

  for (const file of targets) {
    let beforeText;
    try { beforeText = fsImpl.readFileSync(file, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        reports.push({ file, ok: true, changed: false, absent: true });
      } else {
        reports.push({ file, ok: false, changed: false, error: `read:${error.message}` });
      }
      continue;
    }

    const parsed = parseBackupText(beforeText);
    if (!parsed) {
      reports.push({ file, ok: false, changed: false, error: 'invalid-backup' });
      continue;
    }
    const next = cleanedValue(parsed, drop);
    const changed = !sameValue(parsed.value, next);

    try {
      if (changed) writeFile(file, JSON.stringify(next, null, 2) + '\n');
      const verifiedText = fsImpl.readFileSync(file, 'utf8');
      const verified = parseBackupText(verifiedText);
      if (!verified || !sameValue(verified.value, next)) {
        reports.push({ file, ok: false, changed, error: 'verification-mismatch' });
        continue;
      }
      reports.push({ file, ok: true, changed, absent: false });
    } catch (error) {
      reports.push({ file, ok: false, changed, error: `write:${error.message}` });
    }
  }

  return {
    ok: reports.every((report) => report.ok),
    changed: reports.some((report) => report.changed),
    reports,
    failures: reports.filter((report) => !report.ok),
  };
}

module.exports = {
  parseBackupText,
  purgeLegacyBackupCopies,
};
