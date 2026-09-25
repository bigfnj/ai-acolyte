'use strict';

// Stateful orchestration for cross-agent Auto Learn. Transcript text is handed
// to the pure analyzers and is never written here. Durable state contains only
// normalized metadata, counters, hashed observation ids, and file cursors.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  aggregateObservations, isAutoSafeCandidate, COMPLEX_REASONS,
  normalizeCandidateKey, normalizePermissionSpelling, preferredPermissionSpelling,
  preferredPrefixSpelling,
} = require('./auto-learn');
const { isCoveredBy } = require('./permissions');
const { scanHistoryFiles, codexHistoryStoreState } = require('./history-adapters');
const { createPolicyLock } = require('./policy-lock');
const { commandLaunch } = require('./exec-resolve');
const { codexRuleFileSet, codexRulesArguments } = require('./codex-policy');
const {
  readPolicy, assessPermission, overridingRule, coversPermission, defaultPolicyPath,
} = require('./managed-policy');
const {
  deriveMitigations, derivedStatus, setDerivedGuidance,
  DEFAULT_THRESHOLD, DEFAULT_LIMIT,
} = require('./derived-guidance');
const {
  renderCodexRules, validateCodexRulesText, renderClaudePermissions, mergeClaudeAllow,
  mergeGeneratedCodexRules,
} = require('./policy-exporters');

const VERSION = 1;
// The oldest on-disk version this code can still make sense of. A state written
// below it is reset rather than read, which is the reset mechanism that did not
// exist: `VERSION` was write-only, so bumping it did nothing at all and the one
// time a reset was wanted (the Codex `session` fix) the change had to be
// designed around its absence.
const MIN_SUPPORTED_VERSION = 1;
// fromVersion -> (raw) => raw, applied in order until the file reads as
// `VERSION`. EMPTY TODAY, and that is the honest state of it: there has only
// ever been one version, so there is no migration to register and no test can
// reach the loop body. What the mechanism buys is that the NEXT bump has a
// place to put its migration and a defined behaviour when none exists, instead
// of the field being inert.
const STATE_MIGRATIONS = new Map();
// A state file's declared version, or `VERSION` when it says nothing. Every
// file this tool has ever written carries `version: 1`, so an absent version
// means a hand-written or foreign file rather than an older one, and treating
// it as current keeps that readable instead of wiping it.
function declaredVersion(raw, version = VERSION) {
  const value = object(raw) ? raw.version : undefined;
  return Number.isInteger(value) ? value : version;
}
// Returns the raw state brought up to the ladder's current version, or null
// when it cannot be. Null means reset: a state older than the oldest supported
// version, or one whose chain has a step nobody wrote, is not partially
// readable.
//
// THE LADDER IS A PARAMETER, and that is the whole reason this function is
// shaped this way. With `VERSION` and `MIN_SUPPORTED_VERSION` both 1 and
// `STATE_MIGRATIONS` empty, the floor check below CANNOT CHANGE AN OUTCOME:
// every `from` it rejects is also a `from` the `while` rejects on the next
// line for want of a migration step, so mutating it to `if (false)` leaves the
// suite green and the guard is decoration. Two doors, one reachable.
//
// Deleting the floor was the other option and is the worse one: the mechanism
// is here for the NEXT version bump, and the case the two doors stop agreeing
// about is precisely the one a bump creates -- a ladder that HAS a migration
// for a version below the floor, where the missing-step door is wide open and
// only the floor refuses. Injecting the ladder makes that case reachable now,
// so the guard is tested before the bump that needs it rather than after.
//
// `VERSION` itself is deliberately not injectable through `createAutoLearnManager`:
// bumping it with an empty `STATE_MIGRATIONS` would reset every user's state
// file, so it stays a module constant and only this pure function takes an
// override.
function migrateStateTo(raw, ladder = {}) {
  const version = Number.isInteger(ladder.version) ? ladder.version : VERSION;
  const minSupported = Number.isInteger(ladder.minSupported)
    ? ladder.minSupported : MIN_SUPPORTED_VERSION;
  const migrations = ladder.migrations instanceof Map ? ladder.migrations : STATE_MIGRATIONS;
  let from = declaredVersion(raw, version);
  if (from > version) return raw;
  if (from < minSupported) return null;
  let current = raw;
  while (from < version) {
    const step = migrations.get(from);
    if (!step) return null;
    current = step(current);
    if (!object(current)) return null;
    from += 1;
  }
  return current;
}
function migrateState(raw) {
  return migrateStateTo(raw);
}
const MODES = new Set(['observe', 'recommend', 'auto-safe']);
const CLAUDE_CLAIMS_VERSION = 1;
const OUTCOMES = new Set(['success', 'failed', 'unknown']);
const RISK_RANK = new Map([
  ['read-only', 0], ['unknown', 1], ['complex', 2], ['write', 3],
  ['shell', 4], ['network', 5], ['credential', 6], ['admin', 7], ['destructive', 8],
]);
// One spelling of the control-character class, so the three sites that reject
// them cannot drift apart.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const RETRY_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY', 'ETXTBSY']);

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function hash(value) { return crypto.createHash('sha256').update(value ?? Buffer.alloc(0)).digest('hex'); }
function clean(value, length = 256) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length)
    : '';
}
function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback;
}
function configuredPath(home, value, fallback) {
  const chosen = value === undefined ? fallback : value;
  if (chosen === null || chosen === false || chosen === '') return null;
  let result = String(chosen);
  if (result === '~') result = home;
  else if (/^~[\\/]/.test(result)) result = path.join(home, result.slice(2));
  return path.resolve(result);
}
function configuredRoots(home, value, fallback) {
  const chosen = value === undefined ? fallback : value;
  return (Array.isArray(chosen) ? chosen : [chosen])
    .filter((item) => item !== null && item !== false && item !== undefined && item !== '')
    .map((item) => configuredPath(home, item, null));
}

function normalizedPath(value) {
  const result = path.resolve(String(value || '')).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? result.toLowerCase() : result;
}
function within(root, value) {
  if (!root || !value) return false;
  const base = normalizedPath(root);
  const child = normalizedPath(value);
  const relative = path.relative(base, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function candidateFingerprint(item) {
  return hash(Buffer.from(JSON.stringify({
    key: item.key, prefix: item.prefix, claudePermission: item.claudePermission,
    // A family that gained a second spelling gained a second allow entry, so a
    // review approved before that happened is a review of a different grant.
    permissions: item.permissions,
    risk: item.risk, baseAutoSafe: item.baseAutoSafe, complex: item.complex,
    reasons: item.reasons, sources: item.sources, counts: item.counts,
  }), 'utf8'));
}
// Policy/state writes fail closed if the atomic rename cannot complete.
function atomicWrite(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    let offset = 0;
    while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try { fs.chmodSync(temp, fs.statSync(target).mode); } catch {}
    let last;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { fs.renameSync(temp, target); return; }
      catch (error) {
        last = error;
        if (!RETRY_RENAME.has(error.code)) break;
        sleep(20 * (attempt + 1));
      }
    }
    throw last;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temp); } catch {}
  }
}

function snapshot(target) {
  try {
    const content = fs.readFileSync(target);
    return { exists: true, content, hash: hash(content) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const content = Buffer.alloc(0);
    return { exists: false, content, hash: hash(content) };
  }
}
function unchanged(target, before) {
  const current = snapshot(target);
  return current.exists === before.exists && current.hash === before.hash;
}
function validPrefix(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return null;
  if (value.some((token) => typeof token !== 'string' || !token || token.length > 256 ||
    CONTROL_CHARACTERS.test(token))) return null;
  return value.slice();
}
function counts(value) {
  const result = {};
  for (const name of OUTCOMES) result[name] = Math.max(0, Number(value?.[name]) || 0);
  result.total = result.success + result.failed + result.unknown;
  return result;
}
function refresh(candidate, threshold) {
  candidate.threshold = threshold;
  candidate.counts.total = candidate.counts.success + candidate.counts.failed + candidate.counts.unknown;
  candidate.successfulRuns = candidate.counts.success;
  candidate.failedRuns = candidate.counts.failed;
  candidate.unknownRuns = candidate.counts.unknown;
  candidate.sourceCount = candidate.sources.length;
  candidate.meetsThreshold = candidate.counts.success >= threshold;
  candidate.autoSafe = isAutoSafeCandidate(candidate);
  candidate.disposition = candidate.autoSafe ? 'auto-safe' : candidate.meetsThreshold ? 'review' : 'observe';
  return candidate;
}
// Every spelling of this family's permission that was actually observed. A
// family whose permission is null has none: a real conflict must not smuggle a
// rule back in through this list, and the filter is what stops it.
function permissionSpellings(value, base) {
  if (!base) return [];
  const identity = normalizePermissionSpelling(base);
  const all = [base, ...(Array.isArray(value) ? value : [])]
    .map((item) => clean(item, 768))
    .filter((item) => item && normalizePermissionSpelling(item) === identity);
  return [...new Set(all)].sort();
}
function candidate(value, threshold) {
  if (!object(value)) return null;
  const kind = value.kind === 'tool' ? 'tool' : 'shell';
  // A state written before the `.exe` spellings were unified holds the two
  // halves of a family under two keys. Normalizing on the way in migrates them
  // onto one key; `sanitizeState` merges the pair rather than letting the later
  // one win, so no counted run is dropped by the rename. Tool families keep
  // their keys verbatim: `mcp:` and `webfetch:` specifiers are not executables.
  const key = kind === 'shell'
    ? normalizeCandidateKey(clean(value.key, 512)) : clean(value.key, 512);
  const prefix = validPrefix(value.prefix);
  if (!key || !prefix) return null;
  const claudePermission = clean(value.claudePermission, 768) || null;
  const reasons = [...new Set((Array.isArray(value.reasons) ? value.reasons : [])
    .map((item) => clean(item, 80)).filter(Boolean))].sort();
  return refresh({
    key, tool: clean(value.tool, 64), shell: clean(value.shell, 32),
    kind,
    root: clean(value.root, 256) || prefix[0], prefix,
    claudePermission,
    permissions: permissionSpellings(value.permissions, claudePermission),
    risk: RISK_RANK.has(value.risk) ? value.risk : 'unknown',
    baseAutoSafe: value.baseAutoSafe === true,
    // Re-derived, not read back. The flag is OR-merged across observations and
    // so can only ever ratchet on; a state written while a chained link counted
    // as complexity holds it for families whose reasons never justified it, and
    // no amount of later clean evidence would clear it.
    complex: reasons.some((reason) => COMPLEX_REASONS.has(reason)),
    reasons,
    sources: [...new Set((Array.isArray(value.sources) ? value.sources : [])
      .map((item) => clean(item, 32)).filter(Boolean))].sort(),
    counts: counts(value.counts),
  }, threshold);
}
function applied(value) {
  const result = { claude: [], codex: [] };
  for (const kind of Object.keys(result)) result[kind] = [...new Set(
    (Array.isArray(value?.[kind]) ? value[kind] : []).map((key) => clean(key, 512)).filter(Boolean),
  )].sort();
  return result;
}
function codexTargets(value) {
  const result = {};
  if (!object(value)) return result;
  for (const [id, record] of Object.entries(value)) {
    if (!/^[a-f0-9]{16}$/.test(id) || !object(record)) continue;
    result[id] = {
      applied: [...new Set((Array.isArray(record.applied) ? record.applied : [])
        .map((key) => clean(key, 512)).filter(Boolean))].sort(),
      reviewed: [...new Set((Array.isArray(record.reviewed) ? record.reviewed : [])
        .map((key) => clean(key, 512)).filter(Boolean))].sort(),
    };
  }
  return result;
}
// The key here is a PERMISSION, not a candidate key -- `applyUnlocked` re-keys
// the map by permission because one family can carry more than one spelling --
// so it has to be cleaned to a permission's length. It used to be cleaned to
// 512, the candidate-key length, while the value beside it kept 768: a
// permission longer than 512 characters was stored under a TRUNCATED key, and
// two permissions sharing a 512-character prefix collapsed onto that one key,
// so the second silently replaced the first and its grant was dropped from the
// claims registry and from what `undo()` restores.
//
// 512 is still right for `applied`, `reviewed` and `codexTargets`, whose keys
// really are candidate keys (`candidate()` cleans those to 512 as well). This
// map is the odd one out, and matching the value's own limit is what makes the
// key a lossless spelling of it.
function managedClaude(value) {
  const result = {};
  if (!object(value)) return result;
  for (const [key, permission] of Object.entries(value)) {
    const safeKey = clean(key, 768);
    const safePermission = clean(permission, 768);
    if (safeKey && safePermission) result[safeKey] = safePermission;
  }
  return result;
}
function emptyClaudeClaims() {
  return { version: CLAUDE_CLAIMS_VERSION, permissions: {} };
}
function parseClaudeClaims(before, target) {
  if (!before.exists) return emptyClaudeClaims();
  let raw;
  try { raw = JSON.parse(before.content.toString('utf8').replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error(`Cannot parse Claude policy claims: ${error.message}`); }
  if (!object(raw) || raw.version !== CLAUDE_CLAIMS_VERSION || !object(raw.permissions)) {
    throw new Error(`Cannot use malformed Claude policy claims registry: ${target}`);
  }
  const result = emptyClaudeClaims();
  for (const [permission, record] of Object.entries(raw.permissions)) {
    if (!permission || permission.length > 768 || CONTROL_CHARACTERS.test(permission) ||
        !object(record) || typeof record.managed !== 'boolean' || !Array.isArray(record.claimants)) {
      throw new Error(`Cannot use malformed Claude policy claims registry: ${target}`);
    }
    const claimants = [...new Set(record.claimants)].sort();
    if (!claimants.length || claimants.some((id) =>
      typeof id !== 'string' || !/^state-sha256:[a-f0-9]{24}$/.test(id))) {
      throw new Error(`Cannot use malformed Claude policy claims registry: ${target}`);
    }
    // `coveredBy` is optional and absent from every registry written before it
    // existed, so a missing one is valid; a present one is held to the same
    // shape as a permission string.
    const covered = record.coveredBy;
    if (covered !== undefined && (typeof covered !== 'string' || !covered ||
      covered.length > 768 || CONTROL_CHARACTERS.test(covered))) {
      throw new Error(`Cannot use malformed Claude policy claims registry: ${target}`);
    }
    result.permissions[permission] = {
      managed: record.managed, claimants,
      ...(covered === undefined ? {} : { coveredBy: covered }),
    };
  }
  return result;
}
function renderClaudeClaims(value) {
  const permissions = {};
  for (const permission of Object.keys(value.permissions).sort()) {
    const record = value.permissions[permission];
    permissions[permission] = {
      managed: record.managed === true,
      ...(typeof record.coveredBy === 'string' && record.coveredBy
        ? { coveredBy: record.coveredBy } : {}),
      claimants: [...new Set(record.claimants)].sort(),
    };
  }
  return JSON.stringify({ version: CLAUDE_CLAIMS_VERSION, permissions }, null, 2) + '\n';
}
// `coveredBy` is how the registry stops claiming a permission the allow list no
// longer holds. After an apply, the wildcarding pass prunes any new entry a
// broader existing rule already covers -- measured 2026-09-03, 12 entries
// written and 8 pruned -- and the registry went on claiming all 12.
//
// Of the two candidate fixes, RECORDING THE COVERING PARENT is the one taken.
// Reconciling claims against the file instead cannot tell "pruned because a
// parent covers it" from "the user deleted it", and dropping the claim in the
// second case silently releases a grant another workspace still holds. Naming
// the parent keeps the claim, puts the reason in the registry file where a
// human can check it, and is the half of the answer that survives the parent
// later being removed.
//
// A covered permission is also not `managed` by this claimant: the entry is not
// in the file, so releasing the claim must not pretend to remove it.
function updateClaudeClaims(claims, claimantId, permissions, current, legacyManaged, coveredBy) {
  const covered = coveredBy instanceof Map ? coveredBy : new Map();
  for (const record of Object.values(claims.permissions)) {
    record.claimants = record.claimants.filter((id) => id !== claimantId);
  }
  for (const permission of permissions) {
    let record = claims.permissions[permission];
    const parent = covered.get(permission) || null;
    if (!record) {
      record = {
        managed: legacyManaged.has(permission) || !current.includes(permission),
        claimants: [],
      };
      claims.permissions[permission] = record;
    }
    if (parent) {
      record.coveredBy = parent;
      record.managed = false;
    } else delete record.coveredBy;
    if (!record.claimants.includes(claimantId)) record.claimants.push(claimantId);
    record.claimants.sort();
  }
  for (const [permission, record] of Object.entries(claims.permissions)) {
    if (record.claimants.length) continue;
    if (record.managed) current = current.filter((rule) => rule !== permission);
    delete claims.permissions[permission];
  }
  return current;
}
function grantSnapshot(state) {
  return {
    applied: applied(state.applied), reviewed: applied(state.reviewed),
    codexTargets: codexTargets(state.codexTargets), managedClaude: managedClaude(state.managedClaude),
  };
}
function restoreGrants(state, grants) {
  state.applied = applied(grants?.applied);
  state.reviewed = applied(grants?.reviewed);
  state.codexTargets = codexTargets(grants?.codexTargets);
  state.managedClaude = managedClaude(grants?.managedClaude);
}
// Which derived mitigations a human has ruled on. `declined` is not the absence
// of `accepted`: without it a rejected mitigation would be re-offered on every
// scan forever, which is how a review list trains its reader to ignore it.
const DERIVED_ID = /^[a-z0-9-]{1,64}$/;
function derivedGuidance(value) {
  const list = (input) => [...new Set((Array.isArray(input) ? input : [])
    .map((item) => clean(item, 64))
    .filter((item) => item && DERIVED_ID.test(item)))].sort();
  const accepted = list(object(value) ? value.accepted : []);
  const declined = list(object(value) ? value.declined : [])
    // One decision per id. Accept wins, because it is the state that has already
    // been written into a file and a contradiction must not silently un-write it.
    .filter((item) => !accepted.includes(item));
  return { accepted, declined };
}
// True when `rebuildManagedHits` already accounted for this call. Compared as
// ISO-8601 strings, which sort lexicographically, so no date parsing is needed.
//
// A call with NO timestamp counts as already accounted for. That direction is
// deliberate: this number is written verbatim into a human's instruction file as
// the justification for a standing rule, so inflating it is the worse failure,
// and a rebuild followed by a scan is the recommended bootstrap rather than an
// edge case. Real transcripts carry timestamps on every record, so the practical
// cost is nil, and no watermark at all means nothing is skipped.
function countedByRebuild(state, observation) {
  const through = state.managedHitsAt;
  if (!through) return false;
  const stamp = typeof observation?.timestamp === 'string' ? observation.timestamp : '';
  return !stamp || stamp <= through;
}
// How many times each managed rule actually cost a prompt. The KEY is a managed
// rule string, which is org policy: no path, argument or prompt text is
// involved, which is what lets this be persisted at all. The decision (ask vs
// deny) is deliberately NOT stored, because the policy is a client-refreshed
// cache and a decision cached here could contradict the live file; it is
// resolved at report time instead.
//
// Capped because this is a new dimension in a long-lived file. A managed policy
// carries a few dozen rules, so the limit is generous and hitting it means a
// bug rather than a workload.
const MANAGED_HITS_LIMIT = 200;
function managedHits(value) {
  if (!object(value)) return {};
  const entries = [];
  for (const [rule, record] of Object.entries(value)) {
    const text = clean(rule, 200);
    if (!text || !object(record)) continue;
    const hits = Math.max(0, Math.floor(Number(record.hits) || 0));
    if (!hits) continue;
    const tools = Array.isArray(record.tools)
      ? [...new Set(record.tools.map((item) => clean(item, 48)).filter(Boolean))].sort().slice(0, 12)
      : [];
    entries.push([text, { hits, tools }]);
  }
  entries.sort((a, b) => b[1].hits - a[1].hits || a[0].localeCompare(b[0]));
  const result = {};
  for (const [rule, record] of entries.slice(0, MANAGED_HITS_LIMIT)) result[rule] = record;
  return result;
}
function cursor(value) {
  if (!object(value)) return null;
  const result = {};
  for (const name of ['size', 'offset', 'mtimeMs', 'ino', 'headLength', 'tailStart', 'tailLength']) {
    if (Number.isFinite(value[name]) && value[name] >= 0) result[name] = value[name];
  }
  for (const name of ['source', 'headHash', 'tailHash']) {
    const text = clean(value[name], name === 'source' ? 32 : 128);
    if (text) result[name] = text;
  }
  return Number.isFinite(result.size) ? result : null;
}

// A family that was evicted by the candidate cap, and how many runs it had when
// it went. This is the whole reason the cap is safe to have: a candidate is the
// only record that a family was ever observed, so eviction keeps the key and
// the run total and drops only the derived fields, which re-derive from one
// fresh observation. Roughly 30 bytes against a candidate's ~390.
//
// The key is a family name (`powershell:git status`), which is the same class
// of data the candidate map already holds; no path, argument or prompt text is
// involved. Capped in turn, cheapest-first, so this cannot become the unbounded
// structure it exists to bound.
const PRUNED_CANDIDATES_LIMIT = 2000;
function prunedCandidates(value) {
  if (!object(value)) return {};
  const entries = [];
  for (const [key, runs] of Object.entries(value)) {
    const name = clean(key, 512);
    const total = Math.max(0, Math.floor(Number(runs) || 0));
    if (name) entries.push([name, total]);
  }
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const result = {};
  for (const [key, runs] of entries.slice(0, PRUNED_CANDIDATES_LIMIT)) result[key] = runs;
  return result;
}
function emptyState(mode, threshold) {
  return {
    version: VERSION, sourceVersion: VERSION,
    mode, threshold, candidates: {}, observationHashes: {}, cursors: {},
    applied: { claude: [], codex: [] }, reviewed: { claude: [], codex: [] },
    codexTargets: {}, managedClaude: {}, managedHits: {}, managedHitsAt: null,
    derivedGuidance: { accepted: [], declined: [] },
    prunedCandidates: {},
    lastScanAt: null, lastScanStats: null,
    lastApplication: null,
  };
}
function lastApplication(value) {
  if (!object(value) || !Array.isArray(value.targets)) return null;
  const targets = value.targets.map((item) => {
    if (!object(item) || !['claude', 'claude-claims', 'codex'].includes(item.kind)) return null;
    const beforeHash = /^[a-f0-9]{64}$/.test(item.beforeHash || '') ? item.beforeHash : null;
    const afterHash = /^[a-f0-9]{64}$/.test(item.afterHash || '') ? item.afterHash : null;
    if (!item.path || !item.backupPath || !beforeHash || !afterHash) return null;
    return {
      kind: item.kind, path: path.resolve(item.path), backupPath: path.resolve(item.backupPath),
      beforeHash, afterHash, existed: item.existed === true,
    };
  }).filter(Boolean);
  return targets.length ? {
    at: clean(value.at, 64) || null, targets,
    grantsBefore: {
      applied: applied(value.grantsBefore?.applied || value.appliedBefore),
      reviewed: applied(value.grantsBefore?.reviewed),
      codexTargets: codexTargets(value.grantsBefore?.codexTargets),
      managedClaude: managedClaude(value.grantsBefore?.managedClaude),
    },
    grantsAfter: {
      applied: applied(value.grantsAfter?.applied || value.appliedAfter),
      reviewed: applied(value.grantsAfter?.reviewed),
      codexTargets: codexTargets(value.grantsAfter?.codexTargets),
      managedClaude: managedClaude(value.grantsAfter?.managedClaude),
    },
  } : null;
}
function sanitizeState(input, mode, threshold) {
  const state = emptyState(mode, threshold);
  if (!object(input)) return state;
  // `version` was written and never read, so the field could not do the one
  // thing a version field is for. Now it decides: a state below the supported
  // floor, or one whose migration chain has a missing step, is reset rather
  // than half-read, and a state from a NEWER copy of the tool is still readable
  // but is remembered as newer so `save()` can refuse to write over it.
  const raw = migrateState(input);
  if (!object(raw)) return state;
  state.sourceVersion = declaredVersion(raw);
  state.mode = MODES.has(raw.mode) ? raw.mode : mode;
  state.threshold = positive(raw.threshold, threshold);
  if (object(raw.candidates)) for (const value of Object.values(raw.candidates)) {
    const item = candidate(value, state.threshold);
    if (!item) continue;
    // Two keys can normalize onto one family (the `.exe` migration). Merging
    // rather than overwriting is what stops the rename discarding the counts of
    // whichever half happened to be read second.
    const prior = state.candidates[item.key];
    state.candidates[item.key] = prior ? mergeStoredCandidates(prior, item, state.threshold) : item;
  }
  if (object(raw.observationHashes)) for (const [id, value] of Object.entries(raw.observationHashes)) {
    if (!/^[a-f0-9]{64}$/.test(id) || !object(value)) continue;
    const stored = clean(value.key, 512);
    if (!stored) continue;
    // Follow the family if its key was migrated, so the dedupe entry keeps
    // working. Only when the migrated family actually exists: a blind rewrite
    // could point a hash at a family that was never there, and losing a hash
    // costs a re-count of bytes a cursor has already consumed.
    const migrated = normalizeCandidateKey(stored);
    const key = (state.candidates[stored] || !state.candidates[migrated]) ? stored : migrated;
    state.observationHashes[id] = {
      key, outcome: OUTCOMES.has(value.outcome) ? value.outcome : 'unknown',
      source: clean(value.source, 32) || 'unknown',
    };
  }
  if (object(raw.cursors)) for (const [file, value] of Object.entries(raw.cursors)) {
    const safe = cursor(value);
    const id = /^path-sha256:[a-f0-9]{24}$/.test(file)
      ? file : `path-sha256:${hash(Buffer.from(normalizedPath(file), 'utf8')).slice(0, 24)}`;
    if (safe) state.cursors[id] = safe;
  }
  state.applied = applied(raw.applied);
  state.reviewed = applied(raw.reviewed);
  state.codexTargets = codexTargets(raw.codexTargets);
  state.managedClaude = managedClaude(raw.managedClaude);
  state.managedHits = managedHits(raw.managedHits);
  state.managedHitsAt = clean(raw.managedHitsAt, 64) || null;
  state.derivedGuidance = derivedGuidance(raw.derivedGuidance);
  state.prunedCandidates = prunedCandidates(raw.prunedCandidates);
  state.lastScanAt = clean(raw.lastScanAt, 64) || null;
  state.lastScanStats = scanStats(raw.lastScanStats);
  state.lastApplication = lastApplication(raw.lastApplication);
  return state;
}
// The writer used to write five fields and this reader rebuilt three, so
// `prunedObservations` vanished on reload: a value the scan reported and the
// state file held, dropped by the whitelist that was supposed to reject junk.
// Every field the scan reports is listed here, and `blindScan` among them,
// because "the cursor map was preserved because nothing was enumerated" is the
// one thing a consumer tuning retry backoff cannot infer from the error count.
function scanStats(value) {
  if (!object(value)) return null;
  const count = (name) => Math.max(0, Number(value[name]) || 0);
  return {
    files: count('files'), observations: count('observations'), errors: count('errors'),
    // Files the scan deliberately stopped short on, and results whose call it
    // could not reach. Both are normal in small numbers and both are evidence
    // of a problem when they persist, which is why they are counted rather
    // than inferred from the absence of something else.
    partial: count('partial'), unmatchedResults: count('unmatchedResults'),
    prunedObservations: count('prunedObservations'),
    // Dedupe entries the cap could not evict because their families are still
    // below the success threshold, so the map is over its limit. Normal at
    // zero, and the one number that says the observation cap is running
    // degraded -- a cap that quietly stops capping is the failure this repo
    // keeps finding, so it reports rather than hides.
    retainedObservations: count('retainedObservations'),
    prunedCursors: count('prunedCursors'),
    prunedCandidates: count('prunedCandidates'),
    prunedGrants: count('prunedGrants'),
    blindScan: value.blindScan === true,
    // "The Codex rollout directory this scan read may no longer be where Codex
    // writes." Persisted with the rest of the scan stats, because a stale
    // directory is exactly as invisible as a blind scan and the numbers beside
    // it look healthy either way. `codexHistoryInspected` is the honesty half:
    // `partial` means the comparison could not be made, which is not the same
    // answer as `false`.
    codexHistoryStale: value.codexHistoryStale === true,
    codexHistoryInspected: ['exact', 'partial', 'skipped'].includes(value.codexHistoryInspected)
      ? value.codexHistoryInspected : 'skipped',
    codexHistoryReasons: Array.isArray(value.codexHistoryReasons)
      ? value.codexHistoryReasons.slice(0, 8).map((entry) => clean(entry, 400)).filter(Boolean) : [],
    codexHistoryNotes: Array.isArray(value.codexHistoryNotes)
      ? value.codexHistoryNotes.slice(0, 8).map((entry) => clean(entry, 400)).filter(Boolean) : [],
  };
}
function persistentState(state) {
  const candidates = {};
  for (const key of Object.keys(state.candidates).sort()) {
    const item = state.candidates[key];
    candidates[key] = {
      key, tool: item.tool, kind: item.kind, shell: item.shell, root: item.root,
      prefix: item.prefix.slice(),
      claudePermission: item.claudePermission,
      permissions: item.permissions.slice(),
      risk: item.risk, baseAutoSafe: item.baseAutoSafe,
      complex: item.complex, reasons: item.reasons.slice(), sources: item.sources.slice(),
      counts: { ...item.counts },
    };
  }
  return {
    version: VERSION, mode: state.mode, threshold: state.threshold, candidates,
    observationHashes: state.observationHashes, cursors: state.cursors,
    applied: applied(state.applied), reviewed: applied(state.reviewed),
    codexTargets: codexTargets(state.codexTargets), managedClaude: managedClaude(state.managedClaude),
    managedHits: managedHits(state.managedHits), managedHitsAt: state.managedHitsAt,
    derivedGuidance: derivedGuidance(state.derivedGuidance),
    prunedCandidates: prunedCandidates(state.prunedCandidates),
    lastScanAt: state.lastScanAt, lastScanStats: scanStats(state.lastScanStats),
    lastApplication: state.lastApplication,
  };
}
function maxRisk(left, right) {
  const a = RISK_RANK.has(left) ? left : 'unknown';
  const b = RISK_RANK.has(right) ? right : 'unknown';
  return RISK_RANK.get(b) > RISK_RANK.get(a) ? b : a;
}
function mergeCandidate(existing, fresh, threshold) {
  if (!existing) {
    const created = candidate(fresh, threshold);
    if (!created) return null;
    created.counts = { success: 0, failed: 0, unknown: 0, total: 0 };
    return refresh(created, threshold);
  }
  existing.risk = maxRisk(existing.risk, fresh.risk);
  existing.baseAutoSafe = existing.baseAutoSafe && fresh.baseAutoSafe;
  existing.complex = existing.complex || fresh.complex;
  if (existing.claudePermission !== fresh.claudePermission) {
    // `git` and `git.exe` are two spellings of one grant, not a conflict. Any
    // other disagreement still nulls the permission, as it always has.
    existing.claudePermission =
      preferredPermissionSpelling(existing.claudePermission, fresh.claudePermission);
  }
  existing.permissions = permissionSpellings(
    [...(existing.permissions || []), ...(fresh.permissions || [])], existing.claudePermission,
  );
  const mergedPrefix = preferredPrefixSpelling(existing.prefix, fresh.prefix);
  if (mergedPrefix) existing.prefix = mergedPrefix;
  else {
    existing.complex = true;
    existing.baseAutoSafe = false;
    existing.reasons.push('prefix-conflict');
  }
  existing.reasons = [...new Set([...existing.reasons, ...fresh.reasons])].sort();
  existing.sources = [...new Set([...existing.sources, ...fresh.sources])].sort();
  return refresh(existing, threshold);
}
// Two STORED candidates that now share one key, which only happens when a key
// migration folds them together. Unlike `mergeCandidate` the counts add up:
// both sides are already-counted evidence with their own observation hashes, so
// discarding either would lose runs that nothing can re-derive.
function mergeStoredCandidates(left, right, threshold) {
  const winner = left.counts.total >= right.counts.total ? left : right;
  const other = winner === left ? right : left;
  winner.risk = maxRisk(winner.risk, other.risk);
  winner.baseAutoSafe = winner.baseAutoSafe && other.baseAutoSafe;
  winner.claudePermission =
    preferredPermissionSpelling(winner.claudePermission, other.claudePermission);
  winner.permissions = permissionSpellings(
    [...winner.permissions, ...other.permissions], winner.claudePermission,
  );
  const mergedPrefix = preferredPrefixSpelling(winner.prefix, other.prefix);
  if (mergedPrefix) winner.prefix = mergedPrefix;
  winner.reasons = [...new Set([...winner.reasons, ...other.reasons])].sort();
  winner.sources = [...new Set([...winner.sources, ...other.sources])].sort();
  winner.complex = winner.reasons.some((reason) => COMPLEX_REASONS.has(reason));
  for (const name of OUTCOMES) winner.counts[name] += other.counts[name];
  return refresh(winner, threshold);
}
function observedOutcome(item) {
  if (item.counts?.success === 1) return 'success';
  if (item.counts?.failed === 1) return 'failed';
  return 'unknown';
}
function changeOutcome(item, before, after) {
  if (before === 'failed' && after !== 'failed') return false;
  if (OUTCOMES.has(before)) item.counts[before] = Math.max(0, item.counts[before] - 1);
  if (OUTCOMES.has(after)) item.counts[after] += 1;
  return before !== after;
}
// Observation hashes only exist to stop a re-read of the same bytes counting
// twice. Cursors mean that re-read is rare and recent, so the index is capped
// and trimmed oldest first. Insertion order is preserved through JSON, and an
// entry whose family is gone can never dedupe anything again.
//
// WHAT "OLDEST FIRST" ALONE GOT WRONG. This cap and the cursor cap evict in the
// SAME direction: the oldest transcript's observations went into this map
// first, and that same transcript carries the oldest `mtimeMs`, so the cursor
// `pruneCursors` drops is precisely the one whose dedupe entries have already
// been trimmed from here. `pruneCursors` justified itself with "the re-read is
// deduped by `observationHashes`, so it cannot inflate a count", and for the
// files it evicts that was false. A cursor-less file takes `mode: 'full'`
// (`safeContinuation` returns false with no prior), a full read emits every
// observation in the file wholesale (`src/history-adapters.js:1500`), and each
// one whose hash is gone is counted again -- into `counts.success`, which is
// what `isAutoSafeCandidate` gates an automatic allow-list write on. Measured
// on the live state file 2026-09-22: observationHashes 20,000 of 20,000 with
// `prunedObservations` non-zero every tick, so the trimming half of this was
// already running; only the cursor half was still below its cap.
//
// THE REPAIR IS TO STOP TRIMMING THE HASHES THAT CAN STILL CHANGE A DECISION. A
// family that has not yet reached the success threshold is the only kind a
// re-read can PROMOTE: every other input to `isAutoSafeCandidate` is a static
// property of the command, `counts.failed` only ever grows (`changeOutcome`
// refuses to clear a failure), and a family already at the threshold is already
// in Review or already applied, so counting its runs again cannot move it
// anywhere it is not already. Those entries are held whatever their age.
// Everything else is trimmed oldest first exactly as before, and in a real
// corpus that is the bulk of the map: the protected families are the long tail
// carrying one or two runs each.
//
// WHAT THIS DOES NOT FIX, said here rather than left to be discovered. A family
// already over the threshold can still have its DISPLAYED run total inflated by
// a re-read, and RAISING `threshold` after the fact re-opens the gap for
// families that cleared the old bar and have since had their hashes trimmed.
// Both are reporting errors, not policy writes.
//
// The protected set is not itself bounded, so a very high threshold can hold
// more entries than the cap allows. That is the deliberate trade -- dropping
// them is the inflation this exists to stop -- and the overflow is REPORTED as
// `retainedObservations` on every scan rather than absorbed in silence.
function pruneObservationHashes(state, limit) {
  const entries = Object.entries(state.observationHashes);
  const live = entries.filter(([, value]) => state.candidates[value.key]);
  // Read from the state rather than from the candidate: `scan()` has just
  // refreshed every candidate against `state.threshold`, and a stored
  // `candidate.threshold` from a run with a different setting would make two
  // entries of the same family disagree about whether they are protected.
  const threshold = positive(state.threshold, 3);
  const decisive = ([, value]) => state.candidates[value.key].counts.success < threshold;
  let kept = live;
  let overCap = 0;
  if (limit > 0 && live.length > limit) {
    const held = live.filter(decisive);
    const trimmable = live.filter((entry) => !decisive(entry));
    const room = Math.max(0, limit - held.length);
    const survivors = new Set(trimmable.slice(Math.max(0, trimmable.length - room))
      .map(([id]) => id));
    kept = live.filter((entry) => decisive(entry) || survivors.has(entry[0]));
    overCap = Math.max(0, kept.length - limit);
  }
  if (kept.length === entries.length) return { pruned: 0, overCap };
  state.observationHashes = Object.fromEntries(kept);
  return { pruned: entries.length - kept.length, overCap };
}
// Cursors used to be pruned only as a side effect of `scan()` replacing the map
// wholesale. The blind-scan guard suspends that replacement, and it fires for a
// legitimately emptied root as well as for an unreadable one, so in that case
// nothing pruned them at all and the file could only grow.
//
// Existence-based pruning is not available there: a cursor is keyed by a
// SHA-256 of its path, so there is no path left to stat, and a blind scan by
// definition enumerated nothing to compare against. What IS available is a cap.
// A cursor is a pure cache: losing one costs a single re-read of that file, and
// a re-read is deduped by `observationHashes`, which is what makes evicting
// without evidence safe here and not safe for candidates.
//
// THAT DEDUPE ARGUMENT USED TO BE FALSE FOR EXACTLY THESE FILES, and it is the
// other half of this cap rather than a detail of the other one. Both caps
// evicted oldest-first, so the cursor dropped here was the one whose hashes
// `pruneObservationHashes` had already dropped, and the full re-read that
// followed re-counted every success in the file. It holds now because that
// function no longer trims a hash whose family is still below the success
// threshold -- the only families a re-count can promote. The narrower claim,
// which is the one to rely on: evicting a cursor can cost I/O and can inflate
// the reported run total of a family that has ALREADY cleared the threshold; it
// can no longer push a family across one. See the note there for the residue.
//
// Eviction is by `mtimeMs`, oldest transcript first, because the oldest
// transcript is the one least likely to be appended to again and therefore the
// cheapest cursor to have to rebuild. Ties break on the key so the result is
// deterministic.
const CURSOR_LIMIT = 5000;
function pruneCursors(state, limit) {
  const entries = Object.entries(state.cursors);
  if (!(limit > 0) || entries.length <= limit) return 0;
  const ranked = entries.slice().sort((a, b) =>
    (b[1].mtimeMs || 0) - (a[1].mtimeMs || 0) || a[0].localeCompare(b[0]));
  state.cursors = Object.fromEntries(ranked.slice(0, limit));
  return entries.length - limit;
}

// `state.candidates` was the one persisted structure with no cap and no
// eviction, on axes that grow without bound: one entry per domain ever fetched,
// one per MCP server-and-action.
//
// Evidence is not thrown away, in two senses. Nothing that carries a DECISION
// or has reached the bar is evictable at all -- applied, reviewed, auto-safe or
// at-threshold -- so the cap can only ever reach families still below the
// success threshold. And what is evicted leaves a tombstone in
// `prunedCandidates` recording the family name and its run total, so "this
// family was observed, N times" survives even though the derived fields do not.
// The tombstone count is reported by `status()`, so it is not a field written
// and read by nobody.
//
// The tombstone is a record, not a seed: a family observed again starts a fresh
// candidate from zero. Re-counting from an old total would double-count,
// because `pruneObservationHashes` drops the hashes of a family that is gone.
const CANDIDATE_LIMIT = 1000;
// Policy backups were the one structure in this directory with no bound at all.
// `backup()` writes a uniquely named `.bak` per changed target per apply, and
// `undo()` reads only the most recent application's set, so every earlier file
// is unreachable by any code path in the repo -- no reader, no pruner, no
// deleter. Measured on the machine this was found on: 44 files, 562 KB, about
// 1.2 a day, in the one directory where `managedHits` (200), `prunedCandidates`
// (2000), `candidates` (1000), `cursors` (5000) and `observationHashes` (20000)
// are all explicitly capped.
//
// 200 files is roughly five months at that rate and a couple of megabytes. A
// FILE count rather than a byte budget, because how big a settings.json is is
// not this module's business, and a count is the thing a reader can check
// against `ls`.
const BACKUP_LIMIT = 200;
// The names `backup()` writes, and nothing else. `setDerivedGuidance` writes
// `<name>.pre-derived` into the SAME directory, so a pruner that swept it by
// age would eventually delete the pre-derived copy of the user's CLAUDE.md.
// Anchored on the kinds `lastApplication` accepts, so a file this module did
// not write cannot match by accident.
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-(?:claude|claude-claims|codex)-[0-9a-f]{8}\.bak$/;
function pruneCandidates(state, limit, protectedKeys) {
  const keys = Object.keys(state.candidates);
  if (!(limit > 0) || keys.length <= limit) return 0;
  const evictable = keys.filter((key) => {
    const item = state.candidates[key];
    if (protectedKeys.has(key)) return false;
    return !item.autoSafe && !item.meetsThreshold;
  });
  // Cheapest evidence first: fewest runs, then the key, so two scans of the
  // same state evict the same families.
  evictable.sort((a, b) =>
    state.candidates[a].counts.total - state.candidates[b].counts.total || a.localeCompare(b));
  const excess = Math.min(evictable.length, keys.length - limit);
  for (const key of evictable.slice(0, excess)) {
    const runs = state.candidates[key].counts.total;
    state.prunedCandidates[key] = Math.max(state.prunedCandidates[key] || 0, runs);
    delete state.candidates[key];
  }
  state.prunedCandidates = prunedCandidates(state.prunedCandidates);
  return excess;
}

// The same reconciliation `pruneObservationHashes` does, for the grant lists. A
// key whose candidate `sanitizeState` dropped sat in `applied.claude` and
// `reviewed.claude` forever, and the v1.4.0 crash fix guarded the read rather
// than removing the orphan.
//
// No provenance is discarded by this that an apply does not discard already:
// `applyUnlocked`'s retention filter drops exactly these keys from `nextClaude`
// on every non-observe apply, and an orphan contributes no permission to the
// claims registry either way, because the permission is rendered FROM the
// candidate. This only makes the state agree with that sooner, and makes
// `--learn status` stop listing a grant whose family no longer exists.
function pruneGrantKeys(state) {
  let removed = 0;
  const keep = (list) => {
    const next = list.filter((key) => state.candidates[key]);
    removed += list.length - next.length;
    return next;
  };
  for (const kind of ['claude', 'codex']) {
    state.applied[kind] = keep(state.applied[kind]);
    state.reviewed[kind] = keep(state.reviewed[kind]);
  }
  for (const record of Object.values(state.codexTargets)) {
    record.applied = keep(record.applied);
    record.reviewed = keep(record.reviewed);
  }
  return removed;
}

function observationHash(observation, key) {
  const identity = observation?.id || JSON.stringify([
    observation?.source, observation?.tool, observation?.callId, observation?.command,
  ]);
  return hash(Buffer.from(`${identity}\0${key}`, 'utf8'));
}
function applyArguments(value, additional) {
  if (Array.isArray(value)) return { ...(object(additional) ? additional : {}), keys: value };
  return object(value) ? { ...value } : object(additional) ? { ...additional } : {};
}
// Every message that reports a Codex verdict has to say which files produced it
// and what it could not see. A verdict that names one file when several were
// evaluated points the reader at the wrong file, and a verdict that stays silent
// about managed and system policy claims to have checked more than it did.
function ruleSetDescription(ruleSet, temp, targetPath) {
  const checked = (ruleSet?.effective || []).map((file) => (file === temp ? `${targetPath} (pending)` : file));
  if (!checked.length) return '';
  const failures = (ruleSet?.failures || [])
    .map((failure) => `${failure.path} (${failure.code})`);
  return `\nRule files evaluated together: ${checked.join(', ')}.` +
    (failures.length ? `\nRule directories that could not be listed: ${failures.join(', ')}.` : '') +
    (ruleSet?.blindSpots?.length ? `\n${ruleSet.blindSpots.join(' ')}` : '');
}
function defaultCodexValidator(text, context) {
  fs.mkdirSync(path.dirname(context.path), { recursive: true });
  const temp = path.join(path.dirname(context.path),
    `.permission-wildcarding-validate.${process.pid}.${crypto.randomBytes(6).toString('hex')}.rules`);
  // INSIDE the try, not above it. `writeFileSync` opens the file and then
  // writes, so a failure part way through -- ENOSPC, a quota stop, an
  // interrupted write -- leaves the temp on disk with the throw escaping over
  // the `finally` that exists to remove it. The file is created with `wx`, so
  // the orphan also makes the NEXT validation with the same pid and random
  // suffix fail EEXIST. `atomicWrite` in this file and `writeFileAtomicSync`
  // in permissions.js have the same shape; this was the third copy of it.
  //
  // The `finally` tolerates the file never existing, which is the other half of
  // moving the write in: an `unlinkSync` of a path that was never created is
  // ENOENT and is already swallowed.
  try {
    fs.writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const command = Array.isArray(context.command) && context.command.length
      ? context.command.map(String) : ['__claude_wildcarding_validation__'];
    // THE EFFECTIVE SET, NOT THE ONE FILE.
    //
    // `-r/--rules` is repeatable ("Paths to execpolicy rule files to evaluate"),
    // and Codex resolves a conflict between visible rule files toward the MORE
    // RESTRICTIVE decision. Checking the candidate alone therefore answers a
    // question nobody asked: whether the file parses and allows the prefix in an
    // empty world. A neighbouring `.rules` file that forbids the same prefix
    // makes the deployed answer `forbidden` while this check still said `allow`.
    //
    // The temp file stands IN PLACE OF the file being replaced, never beside it.
    // Adding it as an extra leaves the old copy visible too, which is a state no
    // write ever produces and which would let a stale duplicate mask a conflict.
    const ruleSet = context.ruleSet || codexRuleFileSet({
      home: context.home, target: context.path, substitute: temp,
    });
    const rulesArgs = codexRulesArguments(
      ruleSet.effective && ruleSet.effective.length ? ruleSet.effective : [temp],
    );
    // Fails closed on purpose: no reachable codex means no validation, and an
    // unvalidated rules file must never be written.
    const executable = context.codexExecutable || 'codex';
    const launch = commandLaunch(executable,
      ['execpolicy', 'check', ...rulesArgs, '--', ...command]);
    // Name the way out. This surfaces in the dashboard's Auto Learn card, where
    // an error with no remedy reads as the feature being broken; the setting has
    // existed all along and nothing said so. An explicit path is honoured
    // directly, batch shim included.
    //
    // Raised from two places because the two platforms fail differently: on
    // Windows resolution has to succeed before spawn is even attempted, while
    // on POSIX the name is handed to spawn and comes back ENOENT. Same advice
    // either way, so the message is built once.
    const notFound = new Error(
      `codex executable not found: ${executable}. Looked on PATH and in the standard ` +
      'npm locations. Point at it with the permissionWildcarding.autoLearn.codexExecutable ' +
      'setting, or --codex-executable on the CLI, e.g. ' +
      '/usr/local/bin/codex, or C:/Users/<you>/AppData/Roaming/npm/codex.cmd',
    );
    if (process.platform === 'win32' && !launch.resolved) throw notFound;
    const result = spawnSync(launch.file, launch.args,
      { encoding: 'utf8', windowsHide: true, timeout: 30000, ...launch.options });
    if (result.error) throw result.error.code === 'ENOENT' ? notFound : result.error;
    // Name the neighbours. A rejection or a non-allow decision is now an answer
    // about the whole visible set, so reporting only the generated file sends
    // the reader to the wrong file when another one is the harsher voice.
    const checked = ruleSetDescription(ruleSet, temp, context.path);
    if (result.status !== 0) throw new Error(
      `codex execpolicy check rejected generated rules: ${clean(result.stderr || result.stdout || `exit ${result.status}`, 500)}${checked}`,
    );
    let parsed = {};
    try { parsed = JSON.parse(result.stdout); } catch {}
    const decision = parsed.decision || parsed.result?.decision || parsed.effective_decision;
    if (context.command && decision !== 'allow') throw new Error(
      `codex execpolicy check did not allow generated prefix: ${command.join(' ')}${checked}`,
    );
    return {
      valid: true,
      decision: context.command ? decision : undefined,
      ruleFiles: ruleSet.files.slice(),
      checkedFiles: (ruleSet.effective || []).map((file) => (file === temp ? context.path : file)),
      ruleSetFailures: ruleSet.failures || [],
      blindSpots: ruleSet.blindSpots || [],
    };
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}
function createAutoLearnManager(options = {}) {
  const aliases = object(options.paths) ? options.paths : {};
  const home = path.resolve(options.home || options.homeDir || os.homedir());
  const configuredMode = MODES.has(options.mode) ? options.mode : 'recommend';
  const configuredThreshold = positive(options.threshold ?? options.successThreshold, 3);
  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : null;
  const userDataDir = path.join(home, '.claude', 'wildcarding');
  const workspaceId = workspaceRoot ? hash(Buffer.from(normalizedPath(workspaceRoot), 'utf8')).slice(0, 16) : null;
  const defaultStatePath = path.join(userDataDir,
    workspaceId ? `auto-learn-state.${workspaceId}.json` : 'auto-learn-state.json');
  const requestedStatePath = configuredPath(home, options.statePath ?? aliases.state, defaultStatePath);
  const statePath = within(userDataDir, requestedStatePath) ? requestedStatePath : defaultStatePath;
  const claudeClaimsPath = path.join(userDataDir, 'claude-policy-claims.json');
  const claudeClaimantId = `state-sha256:${hash(Buffer.from(normalizedPath(statePath), 'utf8')).slice(0, 24)}`;

  const requestedLockPath = configuredPath(home, options.lockPath ?? aliases.lock,
    path.join(userDataDir, 'auto-learn-policy.lock'));
  const lockPath = within(userDataDir, requestedLockPath)
    ? requestedLockPath : path.join(userDataDir, 'auto-learn-policy.lock');
  const requestedBackupDir = configuredPath(home, options.backupDir ?? aliases.backups,
    path.join(userDataDir, 'backups'));
  const backupDir = within(userDataDir, requestedBackupDir)
    ? requestedBackupDir : path.join(userDataDir, 'backups');
  const claudeSettingsPath = configuredPath(home,
    options.claudeSettingsPath ?? aliases.claudeSettings, path.join(home, '.claude', 'settings.json'));
  const explicitCodex = Object.prototype.hasOwnProperty.call(options, 'codexRulesPath') ||
    Object.prototype.hasOwnProperty.call(aliases, 'codexRules');
  const codexValue = Object.prototype.hasOwnProperty.call(options, 'codexRulesPath')
    ? options.codexRulesPath : aliases.codexRules;
  const codexRulesPath = configuredPath(home, explicitCodex ? codexValue : undefined,
    path.join(home, '.codex', 'rules', 'permission-wildcarding.rules'));
  const codexTargetId = codexRulesPath
    ? hash(Buffer.from(normalizedPath(codexRulesPath), 'utf8')).slice(0, 16) : null;
  const claudeRoots = configuredRoots(home,
    options.claudeRoots ?? options.claudeHistoryPath ?? aliases.claudeHistory,
    [path.join(home, '.claude', 'projects')]);
  const codexRoots = configuredRoots(home,
    options.codexRoots ?? options.codexHistoryPath ?? aliases.codexHistory,
    [path.join(home, '.codex', 'sessions')]);
  const historyScanner = typeof options.historyScanner === 'function' ? options.historyScanner : scanHistoryFiles;
  // Injectable for the fixtures that have to make the two stores disagree, and
  // resolved per codex root rather than once from `home`, because a test points
  // the root somewhere else and a detector that ignored that would be checking
  // the developer's real `~/.codex` while the fixture sat unread.
  const historyStoreProbe = typeof options.codexHistoryStore === 'function'
    ? options.codexHistoryStore : codexHistoryStoreState;
  const RANK = { exact: 0, partial: 1, skipped: 2 };
  function codexHistoryStore() {
    const roots = codexRoots.length ? codexRoots : [path.join(home, '.codex', 'sessions')];
    let stale = false;
    let inspected = 'exact';
    const reasons = [];
    const notes = [];
    for (const root of roots) {
      const state = historyStoreProbe({
        home, sessionsDir: root, codexHome: path.dirname(root),
      }) || {};
      if (state.stale) stale = true;
      // Worst wins. One root inspected exactly does not redeem another that
      // could not be read: the answer for the corpus is only as good as its
      // weakest member, and rounding that up is the reporting failure this
      // detector exists to prevent.
      if ((RANK[state.inspected] ?? 2) > RANK[inspected]) inspected = state.inspected || 'skipped';
      for (const reason of state.reasons || []) if (!reasons.includes(reason)) reasons.push(reason);
      for (const note of state.notes || []) if (!notes.includes(note)) notes.push(note);
    }
    return { stale, inspected, reasons, notes };
  }
  const codexValidator = typeof options.codexValidator === 'function' ? options.codexValidator
    : typeof options.validateCodexRules === 'function' ? options.validateCodexRules : defaultCodexValidator;
  const codexExecutable = options.codexExecutable || 'codex';
  const afterPolicyWrite = typeof options.testHooks?.afterPolicyWrite === 'function'
    ? options.testHooks.afterPolicyWrite : null;
  const lockStaleMs = Number.isFinite(options.lockStaleMs) ? Math.max(0, options.lockStaleMs) : 10 * 60 * 1000;
  const observationHashLimit = Number.isFinite(options.observationHashLimit)
    ? Math.max(0, Math.floor(options.observationHashLimit)) : 20000;
  const cursorLimit = Number.isFinite(options.cursorLimit)
    ? Math.max(0, Math.floor(options.cursorLimit)) : CURSOR_LIMIT;
  const candidateLimit = Number.isFinite(options.candidateLimit)
    ? Math.max(0, Math.floor(options.candidateLimit)) : CANDIDATE_LIMIT;
  const backupLimit = Number.isFinite(options.backupLimit)
    ? Math.max(0, Math.floor(options.backupLimit)) : BACKUP_LIMIT;
  // Cached, because the policy is a client-refreshed cache and re-reading it per
  // candidate would only add I/O to a listing — but keyed on a cheap stat rather
  // than held for the manager's lifetime. Nothing watches the policy file, and
  // the extension keeps one manager across policy changes, so a lifetime cache
  // made `status()` keep reporting the pre-change verdict until some unrelated
  // event happened to rebuild the manager. A stat per call is the smallest thing
  // that fixes that without reparsing.
  //
  // `absent` is a real key rather than a miss: a machine with no
  // managed-settings.json is the normal console-managed case, and a policy that
  // appears later has to invalidate too.
  let policyCache;
  let policyStamp;
  const policyFingerprint = () => {
    try {
      const stat = fs.statSync(options.managedPolicyPath || defaultPolicyPath(home));
      return `${stat.mtimeMs}:${stat.size}`;
    } catch { return 'absent'; }
  };
  const managedPolicy = () => {
    // An injected policy is the caller's own object, not a file. Never stat it
    // and never re-read it, or a test that passes a literal would find its
    // policy replaced by whatever this machine happens to have.
    if (options.managedPolicy !== undefined) return options.managedPolicy;
    // Stamp BEFORE reading. If the file changes mid-read the stored stamp is the
    // pre-change one, so the next call re-reads — one wasted read, rather than
    // caching content under a stamp that says it is current.
    const stamp = policyFingerprint();
    if (policyCache !== undefined && stamp === policyStamp) return policyCache;
    policyStamp = stamp;
    policyCache = readPolicy({ home, policyPath: options.managedPolicyPath });
    return policyCache;
  };
  // Turns a file path into the managed rule that governs it, for the scanner to
  // record. The scanner calls this while the path is still in hand and keeps
  // only the returned rule, so no path reaches an observation or the state file.
  // Paths are normalized to forward slashes because a managed glob is written
  // that way and a Windows path would never match one.
  const probeMatcher = () => {
    const policy = managedPolicy();
    if (!policy || !policy.present) return undefined;
    const deny = Array.isArray(policy.raw?.deny) ? policy.raw.deny : [];
    const ask = Array.isArray(policy.raw?.ask) ? policy.raw.ask : [];
    if (!deny.length && !ask.length) return undefined;
    return (tool, filePath) => {
      const probe = `${tool}(${String(filePath).replace(/\\/g, '/')})`;
      return deny.find((rule) => coversPermission(rule, probe))
        || ask.find((rule) => coversPermission(rule, probe))
        || null;
    };
  };
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  const now = () => {
    const value = clock();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  };

  function load() {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot read Auto Learn state: ${error.message}`);
    }
    const state = sanitizeState(raw, configuredMode, configuredThreshold);
    if (codexTargetId) {
      if (!state.codexTargets[codexTargetId]) state.codexTargets[codexTargetId] =
        Object.keys(state.codexTargets).length === 0
          ? { applied: state.applied.codex.slice(), reviewed: state.reviewed.codex.slice() }
          : { applied: [], reviewed: [] };
      state.applied.codex = state.codexTargets[codexTargetId].applied.slice();
      state.reviewed.codex = state.codexTargets[codexTargetId].reviewed.slice();
    } else {
      state.applied.codex = [];
      state.reviewed.codex = [];
    }
    for (const item of Object.values(state.candidates)) refresh(item, state.threshold);
    return state;
  }
  // Refuses to write over a state file a NEWER copy of the tool wrote.
  //
  // `persistentState` serializes a whitelist of known keys, which is right for
  // rejecting junk and wrong for coexisting with a newer build: an older copy
  // round-trips the file and writes it back WITHOUT the fields it has never
  // heard of. That is not hypothetical -- three extension versions were
  // installed at once on a real machine, each with its own watcher and timer
  // against one state file, and `managedHits` was emptied twice within minutes
  // of being populated. The advisory lock does not help, because every writer
  // is individually correct and takes the lock properly.
  //
  // Carrying unknown keys through instead was the other candidate fix and is
  // the weaker one: it preserves a field's BYTES without preserving its
  // meaning, so a field whose shape changed is carried forward wrong, and it
  // reinstates exactly the junk the whitelist exists to reject. Refusing is
  // strict, loud, and would have named the multi-install problem the first time
  // it happened instead of leaving a table that emptied itself.
  //
  // The version read is the one this process loaded. A newer copy that writes
  // between our load and our save is what the lock serializes, and the next
  // load refuses.
  function save(state) {
    if (Number.isInteger(state.sourceVersion) && state.sourceVersion > VERSION) {
      throw new Error(
        `Refusing to write Auto Learn state version ${VERSION} over version ` +
        `${state.sourceVersion}: ${statePath} was written by a newer copy of this tool, ` +
        'and saving would drop the fields this copy does not know about. ' +
        'Upgrade or uninstall the older install.',
      );
    }
    atomicWrite(statePath, JSON.stringify(persistentState(state), null, 2) + '\n');
  }
  // Shared with the extension wildcarding pass so the two writers of
  // settings.json cannot interleave, and so a wildcarding rewrite cannot land
  // between the settings write and the claims write of one application.
  const { locked } = createPolicyLock({ lockPath, staleMs: lockStaleMs, now });
  // `policy` is a PARAMETER rather than a `managedPolicy()` call, because this
  // runs once per candidate and `managedPolicy()` stats the policy file to
  // check its cache stamp: 36.2 us each, so a listing did N stats where one
  // would do. The verdict cannot change within a single listing anyway.
  function clone(item, known, policy) {
    const to = [
      ...(known.claude.has(item.key) ? ['claude'] : []),
      ...(known.codex.has(item.key) ? ['codex'] : []),
    ];
    // Managed settings outrank user settings and evaluate ask before allow, so
    // a family a managed ask covers cannot be granted here: writing the rule
    // changes nothing and the prompt survives. Withhold the proposal rather
    // than offer work that cannot pay off. Policy is never consulted to WIDEN
    // eligibility, only to withhold it.
    const policyVerdict = assessPermission(policy, item.claudePermission);
    const eligibleTargets = [
      ...(claudeSettingsPath && policyVerdict !== 'inert' && claudeEligible(item, true) ? ['claude'] : []),
      ...(codexRulesPath && codexEligible(item, true) ? ['codex'] : []),
    ];
    return {
      ...item, prefix: item.prefix.slice(), reasons: item.reasons.slice(),
      sources: item.sources.slice(), permissions: item.permissions.slice(),
      counts: { ...item.counts },
      fingerprint: candidateFingerprint(item), eligibleTargets,
      policy: policyVerdict,
      pendingTargets: eligibleTargets.filter((target) => !to.includes(target)),
      applied: to.length > 0, appliedTo: to,
    };
  }
  function listCandidates(query = {}) {
    return candidatesFrom(load(), query);
  }
  function candidatesFrom(state, query = {}) {    const known = { claude: new Set(state.applied.claude), codex: new Set(state.applied.codex) };
    const policy = managedPolicy();
    let result = Object.values(state.candidates).map((item) => clone(item, known, policy));
    if (query.autoSafe === true) result = result.filter((item) => item.autoSafe);
    if (query.pending === true) result = result.filter((item) => item.pendingTargets.length > 0);
    if (query.disposition) {
      const allowed = new Set(Array.isArray(query.disposition) ? query.disposition : [query.disposition]);
      result = result.filter((item) => allowed.has(item.disposition));
    }
    return result.sort((a, b) => a.key.localeCompare(b.key));
  }
  // Entries already sitting in the user's allow list that a managed rule
  // overrides. Reported, never removed: this policy file is a client-refreshed
  // CACHE, and deleting a live grant because a stale copy calls it dead is the
  // same error with the sign flipped. The module may withhold a proposal, never
  // widen or revoke one.
  function deadAllowEntries(policy) {
    if (!claudeSettingsPath) return [];
    const now = snapshot(claudeSettingsPath);
    if (!now.exists) return [];
    let settings;
    try { settings = JSON.parse(now.content.toString('utf8').replace(/^\uFEFF/, '')); }
    catch { return []; }
    if (!object(settings)) return [];
    const allow = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
    const seen = new Set();
    const dead = [];
    for (const entry of allow) {
      if (typeof entry !== 'string' || seen.has(entry)) continue;
      seen.add(entry);
      const override = overridingRule(policy, entry);
      if (override) dead.push({ permission: entry, ...override });
    }
    return dead.sort((a, b) => a.permission.localeCompare(b.permission));
  }
  // The verdict was computed for every candidate and read by nothing, so a
  // family a managed ask blocks just vanished from Review while its prompts
  // kept arriving, and a grant already written into settings looked like it had
  // simply failed. Naming the rule that cannot be beaten is the only useful
  // thing left to say about such a family, so say it.
  function managedSummary(all, hits) {
    const policy = managedPolicy();
    const state = policy.unreadable ? 'unreadable' : (policy.present ? 'present' : 'absent');
    // Degraded must never read as clean. With no usable policy there is no
    // verdict to report, so the counts are null rather than a confident zero.
    if (state !== 'present') return {
      policy: state, path: policy.path, degraded: state === 'unreadable',
      error: policy.error || null, verdicts: null, inertFamilies: [], deadAllowEntries: [],
      costliestRules: [],
    };
    const verdicts = { inert: 0, partial: 0, redundant: 0, effective: 0, unknown: 0 };
    const inertFamilies = [];
    for (const item of all) {
      if (!item.claudePermission) continue;
      const verdict = assessPermission(policy, item.claudePermission);
      verdicts[verdict] = (verdicts[verdict] || 0) + 1;
      if (verdict === 'inert') inertFamilies.push({
        key: item.key, permission: item.claudePermission, runs: item.counts?.success ?? 0,
        ...(overridingRule(policy, item.claudePermission) || {}),
      });
    }
    inertFamilies.sort((a, b) => b.runs - a.runs || a.key.localeCompare(b.key));
    // What the prompts actually cost, ranked by managed rule. Two sources,
    // because the two halves of the friction surface are shaped differently: a
    // shell family renders a permission that can be assessed, so its evidence
    // is the family's own run count, while a file tool renders no permission by
    // design and its evidence arrives as a per-rule hit count from the scan.
    // Without this the report could name a blocked family but never say which
    // rule was expensive, which is the only question a policy owner can act on.
    const costs = new Map();
    // `clean` on the way in, for the same reason the hit table applies it on the
    // way in. The two suppliers disagreed: a managed-hits key has been through
    // `clean(rule, 200)` since it was recorded, while the inert-family side
    // arrives as the raw string from `~/.claude/remote-settings.json`, and that
    // string is interpolated into the user's CLAUDE.md by `derived-guidance`.
    // Sanitising at the interpolation (`cleanRule` there) makes the block safe;
    // sanitising here as well is what makes the two suppliers agree, so a rule
    // that reaches this table by both routes cannot land as two entries whose
    // prompt counts each understate the real cost.
    const addCost = (rule, runs, tools) => {
      const text = clean(rule, 200);
      if (!text || !(runs > 0)) return;
      const entry = costs.get(text) || { rule: text, prompts: 0, tools: [] };
      entry.prompts += runs;
      for (const tool of (Array.isArray(tools) ? tools : [tools])) {
        if (tool && !entry.tools.includes(tool)) entry.tools.push(tool);
      }
      costs.set(text, entry);
    };
    for (const family of inertFamilies) {
      addCost(family.rule, family.runs, family.permission?.split('(')[0]);
    }
    for (const [rule, record] of Object.entries(object(hits) ? hits : {})) {
      addCost(rule, record.hits, record.tools);
    }
    // A hit-table key has been through `clean`, which collapses whitespace runs
    // and truncates at 200 characters, so comparing it to the raw policy string
    // could never match for a long or oddly spaced rule and the entry was
    // reported as an `ask`. Deny is the stricter fact and it ends up quoted
    // verbatim in a standing instruction, so put both sides through the same
    // transform before deciding.
    const denySet = new Set((policy.raw?.deny || []).map((item) => clean(item, 200)));
    const costliestRules = [...costs.values()]
      .map((entry) => ({
        ...entry, tools: entry.tools.filter(Boolean).sort(),
        decision: denySet.has(clean(entry.rule, 200)) ? 'deny' : 'ask',
      }))
      .sort((a, b) => b.prompts - a.prompts || a.rule.localeCompare(b.rule));
    return {
      policy: state, path: policy.path, degraded: false, error: null,
      verdicts, inertFamilies, deadAllowEntries: deadAllowEntries(policy),
      costliestRules,
    };
  }
  // Why a single pasted command is still prompting. "Your allow rule matches, so
  // this should not have prompted" is the wrong answer whenever a managed ask
  // covers the command, and it is the answer the caller would otherwise give,
  // because a user allow entry really does match. Reading the policy is the only
  // way to name the actual cause.
  function explainManaged(permission) {
    const policy = managedPolicy();
    return {
      policy: policy.unreadable ? 'unreadable' : (policy.present ? 'present' : 'absent'),
      degraded: Boolean(policy.unreadable),
      verdict: assessPermission(policy, permission),
      override: overridingRule(policy, permission),
    };
  }
  // What the managed report implies the agent should do differently, plus what a
  // human has already ruled on. Read-only: deriving is separate from installing
  // so a mitigation can be shown and refused.
  // Derived uncapped, then capped only where it matters. The cap exists to
  // limit how much advice is OFFERED, not to evict advice a human already
  // accepted: applying it first meant a fourth costlier rule appearing silently
  // uninstalled an accepted mitigation whose own rule was still far above
  // threshold, which nothing in the module documented.
  function derivedFor(state, request = {}) {
    const current = statusFrom(state);
    const all = deriveMitigations(current.managed.costliestRules, {
      threshold: request.threshold, limit: Number.MAX_SAFE_INTEGER,
    });
    const limit = Number.isFinite(request.limit) ? Math.max(0, request.limit) : DEFAULT_LIMIT;
    const accepted = state.derivedGuidance.accepted;
    const declined = state.derivedGuidance.declined;
    const decided = new Set([...accepted, ...declined]);
    const pending = all.filter((item) => !decided.has(item.id)).slice(0, limit);
    const pendingIds = new Set(pending.map((item) => item.id));
    return {
      managed: current.managed, all, pending, limit,
      threshold: Number.isFinite(request.threshold) ? request.threshold : DEFAULT_THRESHOLD,
      // What a reader should see: everything ruled on, plus what is on offer.
      visible: all.filter((item) => decided.has(item.id) || pendingIds.has(item.id)),
    };
  }
  function derivedReview(request = {}) {
    const state = load();
    const derived = derivedFor(state, request);
    return {
      threshold: derived.threshold, limit: derived.limit,
      policy: derived.managed.policy, degraded: Boolean(derived.managed.degraded),
      mitigations: derived.visible,
      pending: derived.pending,
      accepted: state.derivedGuidance.accepted.slice(),
      declined: state.derivedGuidance.declined.slice(),
      targets: derivedStatus({ home }),
    };
  }

  // Record one decision and bring the instruction files in line with it. The
  // write is a full reconcile rather than an append, so declining something
  // previously accepted removes it, and a mitigation whose evidence has since
  // fallen below the threshold is removed even if it is still accepted.
  function decideDerived(id, decision, request = {}) {
    return locked(() => {
      // Validated before any truncation. `clean` would cut an over-long id down
      // to a legal length and accept it, recording a decision for an id that
      // cannot exist instead of telling the caller they got it wrong.
      const key = typeof id === 'string' ? id.trim() : '';
      if (!DERIVED_ID.test(key)) throw new Error(`Invalid derived mitigation id: ${id}`);
      if (!['accept', 'decline', 'reset'].includes(decision)) {
        throw new Error(`Invalid decision: ${decision}`);
      }
      const state = load();
      const accepted = new Set(state.derivedGuidance.accepted);
      const declined = new Set(state.derivedGuidance.declined);
      accepted.delete(key);
      declined.delete(key);
      if (decision === 'accept') accepted.add(key);
      if (decision === 'decline') declined.add(key);
      state.derivedGuidance = derivedGuidance({
        accepted: [...accepted], declined: [...declined],
      });
      save(state);
      const derived = derivedFor(state, request);
      const result = {
        id: key, decision,
        accepted: state.derivedGuidance.accepted.slice(),
        declined: state.derivedGuidance.declined.slice(),
      };
      // Without a usable policy there is no derivation, and reconciling against
      // an empty one does not "install nothing", it DELETES every accepted
      // block from the user's own instruction file. The decision is still
      // recorded; only the write is withheld, so a transient policy read
      // failure costs nothing and is repaired by the next decide. Absence is
      // withheld too: `readPolicy` documents that a machine with no managed
      // policy proves nothing, and this module may withhold but never destroy.
      if (derived.managed.policy !== 'present') {
        return {
          ...result, targets: [],
          blocked: derived.managed.degraded ? 'managed-policy-unreadable' : 'managed-policy-absent',
        };
      }
      return {
        ...result,
        targets: setDerivedGuidance(derived.all, state.derivedGuidance.accepted,
          { home, backupDir }),
      };
    });
  }
  function status() {
    return statusFrom(load());
  }
  function statusFrom(state) {    const all = Object.values(state.candidates);
    const appliedKeys = [...new Set([...state.applied.claude, ...state.applied.codex])].sort();
    return {
      version: VERSION, mode: state.mode, threshold: state.threshold,
      lastScanAt: state.lastScanAt, lastScan: state.lastScanAt,
      lastScanStats: state.lastScanStats,
      lastApplyAt: state.lastApplication?.at || null,
      lastApplicationAt: state.lastApplication?.at || null,
      lastApplication: state.lastApplication ? { at: state.lastApplication.at } : null,
      canUndo: Boolean(state.lastApplication), candidateCount: all.length,
      // Families the candidate cap has evicted. Reported rather than merely
      // stored, so "this family was observed and then dropped" is answerable.
      prunedCandidateCount: Object.keys(state.prunedCandidates).length,
      counts: {
        total: all.length, safe: all.filter((item) => item.autoSafe).length,
        review: all.filter((item) => item.disposition === 'review').length,
        observe: all.filter((item) => item.disposition === 'observe').length,
      },
      applied: applied(state.applied), appliedKeys,
      managed: managedSummary(all, state.managedHits),
      paths: {
        state: statePath, claudeSettings: claudeSettingsPath,
        claudeClaims: claudeClaimsPath, codexRules: codexRulesPath,
      },
    };
  }
  // The dashboard needs both halves on every render; one load answers both.
  function overview(query = {}) {
    const state = load();
    return { status: statusFrom(state), candidates: candidatesFrom(state, query) };
  }
  function setMode(mode, threshold) {
    if (!MODES.has(mode)) throw new Error(`Invalid Auto Learn mode: ${mode}`);
    return locked(() => {
      const state = load();
      const next = threshold === undefined ? state.threshold : positive(threshold, 0);
      if (!next) throw new Error('Auto Learn threshold must be a positive integer');
      const changed = state.mode !== mode || state.threshold !== next;
      state.mode = mode;
      state.threshold = next;
      for (const item of Object.values(state.candidates)) refresh(item, next);
      if (changed || !fs.existsSync(statePath)) save(state);
      return { mode, threshold: next, changed };
    });
  }
  function validateCodex(generated, merged, prefixes) {
    const internal = validateCodexRulesText(generated);
    if (!internal.valid) throw new Error(
      `Generated Codex rules failed internal validation: ${internal.errors.join('; ')}`,
    );
    const commands = prefixes.length ? prefixes : [null];
    for (const command of commands) {
      const result = codexValidator(merged, {
        path: codexRulesPath, codexExecutable, internal, home,
        command: command ? command.slice() : null,
      });
      if (result?.then) throw new Error('Codex validator must be synchronous');
      if (result === false || result?.valid === false) throw new Error(
        `codex execpolicy check rejected generated rules${result?.error ? `: ${clean(result.error, 500)}` : ''}`,
      );
      if (command && result !== true && (!object(result) || result.decision !== 'allow')) throw new Error(
        `codex execpolicy check did not allow generated prefix: ${command.join(' ')}`,
      );
    }
  }
  const claudeEligible = (item, reviewed) =>
    renderClaudePermissions([item], { includeReviewed: reviewed }).length > 0;
  // Rendering a prefix_rule is not the same as being allowed to write one. The
  // merge step refuses text this validator rejects (a bare `curl`, `python` or
  // `git` prefix, a broad PowerShell form), and an application is atomic, so
  // offering such a candidate as eligible meant one unwritable row failed the
  // whole batch and applied nothing. Eligibility asks the writer's question.
  const codexEligible = (item, reviewed) => {
    const text = renderCodexRules([item], { includeReviewed: reviewed });
    if (!/\bprefix_rule\s*\(/.test(text)) return false;
    return validateCodexRulesText(text).valid === true;
  };
  function backup(kind, target, before, time) {
    const backupPath = path.join(backupDir,
      `${time.replace(/[:.]/g, '-')}-${kind}-${crypto.randomBytes(4).toString('hex')}.bak`);
    atomicWrite(backupPath, before.content);
    return {
      kind, path: target, backupPath, beforeHash: before.hash, afterHash: null,
      existed: before.exists,
    };
  }
  // Keeps the newest `backupLimit` `.bak` files, plus every backup the state
  // still names, whatever its age.
  //
  // The second half is what keeps `undo()` correct. Undo restores from
  // `lastApplication.targets[].backupPath` and refuses outright when one is
  // missing or altered, so a pruner going by age alone would eventually delete
  // the files that make the last apply reversible -- and with a limit of 0 it
  // would do it on the very first apply. Protecting by NAME rather than by
  // position is deliberate: the recorded paths are absolute and always inside
  // this directory, and comparing basenames cannot be defeated by a separator
  // or a case difference on Windows.
  //
  // Names sort chronologically on their own, because `backup()` builds them
  // from an ISO timestamp with `:` and `.` rewritten to `-`, which is fixed
  // width. No stat per file, and no dependence on an mtime that a copy, a
  // restore or a backup tool can rewrite.
  //
  // Failures are counted rather than thrown. By the time this runs the policy
  // has already been written and the state saved; turning a locked or
  // read-only `.bak` into a failed apply would be a strictly worse outcome
  // than leaving the file. The count is returned so a degraded run says so
  // instead of reporting a clean prune.
  function pruneBackups(keepPaths) {
    let names;
    try { names = fs.readdirSync(backupDir); }
    catch { return { removed: 0, kept: 0, failed: 0 }; }
    const keep = new Set((Array.isArray(keepPaths) ? keepPaths : [])
      .map((item) => path.basename(String(item || ''))).filter(Boolean));
    const mine = names.filter((name) => BACKUP_NAME.test(name)).sort();
    const excess = Math.max(0, mine.length - backupLimit);
    let removed = 0;
    let failed = 0;
    for (const name of mine.slice(0, excess)) {
      if (keep.has(name)) continue;
      try { fs.unlinkSync(path.join(backupDir, name)); removed += 1; }
      catch (error) { if (error.code !== 'ENOENT') failed += 1; }
    }
    return { removed, kept: mine.length - removed, failed };
  }
  function rollback(written) {
    const conflicts = [];
    for (const change of written.slice().reverse()) try {
      const current = snapshot(change.path);
      if (!current.exists || current.hash !== change.afterHash) {
        conflicts.push(change.path);
        continue;
      }
      if (change.before.exists) atomicWrite(change.path, change.before.content);
      else fs.unlinkSync(change.path);
    } catch { conflicts.push(change.path); }
    return conflicts;
  }

  // The user's own deny entries, read from the same file the grant is written
  // to. An unreadable or malformed settings.json yields none rather than
  // throwing: the apply below parses it again and reports the parse failure
  // properly, and withholding every grant because a reader could not run would
  // be a worse answer than the one this is protecting against.
  function readUserDeny() {
    if (!claudeSettingsPath) return [];
    const now = snapshot(claudeSettingsPath);
    if (!now.exists) return [];
    let settings;
    try { settings = JSON.parse(now.content.toString('utf8').replace(/^\uFEFF/, '')); }
    catch { return []; }
    if (!object(settings)) return [];
    const deny = settings.permissions?.deny;
    return Array.isArray(deny) ? deny.filter((rule) => typeof rule === 'string' && rule.trim()) : [];
  }

  function applyUnlocked(state, request = {}) {
    if (state.mode === 'observe') return {
      changed: false, appliedCount: 0, applied: { claude: [], codex: [] },
      reason: 'Auto Learn observe mode records evidence only.',
    };
    const includeReviewed = request.includeReviewed === true;
    const keys = Array.isArray(request.keys)
      ? [...new Set(request.keys.map((key) => clean(key, 512)).filter(Boolean))] : null;
    if (includeReviewed && !keys?.length) {
      throw new Error('includeReviewed requires an explicit non-empty candidate key selection');
    }
    if (keys) {
      const missing = keys.filter((key) => !state.candidates[key]);
      if (missing.length) throw new Error(`Unknown Auto Learn candidate key(s): ${missing.join(', ')}`);
      if (includeReviewed && keys.some((key) => !state.candidates[key].meetsThreshold)) {
        throw new Error('Reviewed candidates must meet the configured success threshold');
      }
      if (includeReviewed && !object(request.expectedFingerprints)) {
        throw new Error('Reviewed application requires candidate fingerprints');
      }
      if (object(request.expectedFingerprints)) for (const key of keys) {
        const expected = clean(request.expectedFingerprints[key], 64);
        if (!expected || expected !== candidateFingerprint(state.candidates[key])) {
          throw new Error(`Auto Learn candidate changed after review: ${key}`);
        }
      }
    }
    const selected = (keys || Object.keys(state.candidates)).map((key) => state.candidates[key])
      .filter(Boolean).filter((item) => includeReviewed || item.autoSafe);
    const targets = Array.isArray(request.targets) ? new Set(request.targets) : null;
    const useClaude = Boolean(claudeSettingsPath) && request.claude !== false &&
      (!targets || targets.has('claude'));
    const useCodex = Boolean(codexRulesPath) && request.codex !== false &&
      (!targets || targets.has('codex'));
    const beforeGrants = grantSnapshot(state);
    const oldClaude = state.applied.claude.slice();
    const oldReviewedClaude = new Set(state.reviewed.claude);
    // The `?.` on the left proves the candidate can be absent, and the right
    // side then passed the same value in unguarded, so `--learn apply` died
    // with a raw TypeError out of policy-exporters rather than doing anything.
    // Reachable because `sanitizeState` drops a candidate whose `key` or
    // `prefix` fails validation while `applied()` keeps every key verbatim and
    // never cross-references the candidates, so one bad persisted entry whose
    // key sits in both `applied.claude` and `reviewed.claude` is enough. This
    // ran on EVERY non-observe apply, `includeReviewed` or not.
    //
    // A key with no candidate is treated as not-retainable, which is what the
    // Codex sibling below already does by way of `normalizePrefix`'s guard.
    // Pruning the orphaned keys instead would discard claims-registry
    // provenance, so that stays recorded. See docs/engineering-record.md.
    let nextClaude = useClaude
      ? oldClaude.filter((key) => state.candidates[key] && (state.candidates[key].autoSafe ||
        (oldReviewedClaude.has(key) && claudeEligible(state.candidates[key], true))))
      : oldClaude.slice();
    let nextReviewedClaude = useClaude
      ? state.reviewed.claude.filter((key) => nextClaude.includes(key))
      : state.reviewed.claude.slice();
    const record = codexTargetId
      ? (state.codexTargets[codexTargetId] || { applied: [], reviewed: [] })
      : { applied: [], reviewed: [] };
    const oldCodex = record.applied.slice();
    const oldReviewedCodex = new Set(record.reviewed);
    let nextCodex = useCodex
      ? oldCodex.filter((key) => state.candidates[key]?.autoSafe ||
        (oldReviewedCodex.has(key) && codexEligible(state.candidates[key], true)))
      : oldCodex.slice();
    let nextReviewedCodex = useCodex
      ? record.reviewed.filter((key) => nextCodex.includes(key))
      : record.reviewed.slice();
    const newly = { claude: [], codex: [] };
    // A managed ask or deny outranks anything written here, so a grant for an
    // inert family lands and the prompt survives. `clone` has withheld such a
    // family from the review list for releases, and the docs said it was
    // withheld, but the WRITE path never consulted policy at all: neither
    // auto-safe `scan` nor `--learn apply` goes through `clone`. So the listing
    // said `eligibleTargets: []` and settings.json got the entry anyway.
    //
    // Three deliberate limits:
    //
    //   - `inert` ONLY. `unknown` is what every permission returns on a machine
    //     with no managed policy, so blocking on it would refuse every write
    //     anywhere unmanaged. `partial` means part of the grant does work.
    //   - NEW grants only. The retention filter above is left alone on purpose:
    //     revoking a live grant because a client-refreshed policy copy calls it
    //     inert is the same error as deleting a dead allow entry, which this
    //     project refuses to do on exactly those grounds.
    //   - Reported, never silent. Applying nothing to a family a human accepted
    //     in Review, with no reason given, is how a report starts lying.
    const withheld = [];
    // Read once for the whole application, not twice per item: `managedPolicy()`
    // stats the policy file on every call to validate its cache stamp, and the
    // verdict must not change halfway through one application regardless.
    const policy = useClaude ? managedPolicy() : null;
    // The user's OWN deny list, which this path never consulted. Deny beats
    // allow, so writing an entry a user deny already blocks produces a dead
    // entry and a report that says it was applied. `planPromotions` in
    // `local-settings.js` has checked `userDeny` and withheld all along; this is
    // the same check on the other writer, and the same class of bug the `inert`
    // gate above was added to fix. Read once per application, for the reason
    // given above.
    const userDeny = useClaude ? readUserDeny() : [];
    if (useClaude) for (const item of selected) {
      if (!claudeEligible(item, includeReviewed)) continue;
      if (assessPermission(policy, item.claudePermission) === 'inert') {
        withheld.push({
          key: item.key, permission: item.claudePermission,
          ...(overridingRule(policy, item.claudePermission) || {}),
        });
        continue;
      }
      const denied = userDeny.find((rule) => coversPermission(rule, item.claudePermission));
      if (denied) {
        withheld.push({
          key: item.key, permission: item.claudePermission,
          decision: 'deny', rule: denied, source: 'user-deny',
        });
        continue;
      }
      if (!nextClaude.includes(item.key)) newly.claude.push(item.key);
      nextClaude.push(item.key);
      if (includeReviewed) nextReviewedClaude.push(item.key);
    }
    if (useCodex) for (const item of selected) {
      if (!codexEligible(item, includeReviewed)) continue;
      if (!nextCodex.includes(item.key)) newly.codex.push(item.key);
      nextCodex.push(item.key);
      if (includeReviewed) nextReviewedCodex.push(item.key);
    }
    nextClaude = [...new Set(nextClaude)].sort();
    nextReviewedClaude = [...new Set(nextReviewedClaude)].filter((key) => nextClaude.includes(key)).sort();
    nextCodex = [...new Set(nextCodex)].sort();
    nextReviewedCodex = [...new Set(nextReviewedCodex)].filter((key) => nextCodex.includes(key)).sort();

    const changes = [];
    let nextManagedClaude = managedClaude(state.managedClaude);
    if (useClaude) {
      const before = snapshot(claudeSettingsPath);
      let settings = {};
      if (before.exists && before.content.length) try {
        settings = JSON.parse(before.content.toString('utf8').replace(/^\uFEFF/, ''));
      } catch (error) { throw new Error(`Cannot parse Claude settings: ${error.message}`); }
      if (!object(settings)) throw new Error('Claude settings must be a JSON object');
      let current = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow.slice() : [];
      const items = nextClaude.map((key) => state.candidates[key]).filter(Boolean);
      // A list per key, not one permission. A family that observed both `git`
      // and `git.exe` renders two entries, and taking only the first would
      // write one of them and claim neither the other nor the runs behind it.
      const permissionsByKey = new Map();
      for (const item of items) {
        const rendered = renderClaudePermissions([item], { includeReviewed: true });
        if (rendered.length) permissionsByKey.set(item.key, rendered);
      }

      const claimsBefore = snapshot(claudeClaimsPath);
      const claims = parseClaudeClaims(claimsBefore, claudeClaimsPath);
      const desiredPermissions = [...new Set([].concat(...permissionsByKey.values()))];
      const legacyManaged = new Set(Object.values(nextManagedClaude));
      // Which desired entries a broader rule ALREADY IN THE FILE covers. These
      // are the ones the wildcarding pass prunes right after an apply, so
      // writing them again is churn and claiming them is a claim on something
      // the file does not hold. Recorded on the claim instead; see
      // `updateClaudeClaims`.
      const coveredBy = new Map();
      for (const permission of desiredPermissions) {
        if (current.includes(permission)) continue;
        const parent = current.find((entry) =>
          typeof entry === 'string' && isCoveredBy(permission, entry));
        if (parent) coveredBy.set(permission, parent);
      }
      current = updateClaudeClaims(
        claims, claudeClaimantId, desiredPermissions, current, legacyManaged, coveredBy,
      );
      const allow = mergeClaudeAllow(current, items, { includeReviewed: true })
        .filter((entry) => !coveredBy.has(entry));
      // Keyed by PERMISSION rather than by candidate key, because a key can now
      // carry more than one. Nothing reads these keys -- both consumers take
      // `Object.values` -- so the map stays a set of permissions by another
      // name, and an older state keyed by candidate key still reads correctly.
      nextManagedClaude = {};
      for (const permission of desiredPermissions) {
        if (claims.permissions[permission]?.managed) nextManagedClaude[permission] = permission;
      }

      const updated = {
        ...settings,
        permissions: { ...(object(settings.permissions) ? settings.permissions : {}), allow },
      };
      const content = Buffer.from(JSON.stringify(updated, null, 2) + '\n');
      if (!before.exists || !content.equals(before.content)) {
        changes.push({ kind: 'claude', path: claudeSettingsPath, before, content });
      }
      const claimsContent = Buffer.from(renderClaudeClaims(claims));
      if ((claimsBefore.exists || Object.keys(claims.permissions).length) &&
          (!claimsBefore.exists || !claimsContent.equals(claimsBefore.content))) {
        changes.push({
          kind: 'claude-claims', path: claudeClaimsPath, before: claimsBefore,
          content: claimsContent,
        });
      }
    }
    if (useCodex && (nextCodex.length || fs.existsSync(codexRulesPath))) {
      const before = snapshot(codexRulesPath);
      const items = nextCodex.map((key) => state.candidates[key]).filter(Boolean);
      const generated = renderCodexRules(items, { includeReviewed: true });
      const merged = mergeGeneratedCodexRules(before.exists ? before.content.toString('utf8') : '', generated);
      const content = Buffer.from(merged);
      if (!before.exists || !content.equals(before.content)) {
        validateCodex(generated, merged, items.map((item) => item.prefix));
        changes.push({ kind: 'codex', path: codexRulesPath, before, content });
      }
    }
    for (const change of changes) if (!unchanged(change.path, change.before)) {
      throw new Error(`Policy changed while Auto Learn was preparing it: ${change.path}`);
    }
    const time = now();
    const backups = changes.map((change) => backup(change.kind, change.path, change.before, time));
    const written = [];
    try {
      for (let index = 0; index < changes.length; index += 1) {
        const change = changes[index];
        if (!unchanged(change.path, change.before)) {
          throw new Error(`Policy changed before Auto Learn could write it: ${change.path}`);
        }
        atomicWrite(change.path, change.content);
        change.afterHash = hash(change.content);
        backups[index].afterHash = change.afterHash;
        written.push(change);
        if (afterPolicyWrite) afterPolicyWrite({
          kind: change.kind, path: change.path, index, afterHash: change.afterHash,
        });
      }
      state.applied.claude = nextClaude;
      state.reviewed.claude = nextReviewedClaude;
      state.managedClaude = nextManagedClaude;
      if (codexTargetId) state.codexTargets[codexTargetId] = {
        applied: nextCodex, reviewed: nextReviewedCodex,
      };
      state.applied.codex = nextCodex;
      state.reviewed.codex = nextReviewedCodex;
      if (changes.length) state.lastApplication = {
        at: time, targets: backups, grantsBefore: beforeGrants,
        grantsAfter: grantSnapshot(state),
      };
      save(state);
    } catch (error) {
      const conflicts = rollback(written);
      if (conflicts.length) error.rollbackConflicts = conflicts;
      throw error;
    }
    // After the save, so the protected set is the application this apply just
    // recorded. Pruning earlier would protect the PREVIOUS application's
    // backups, and a rollback would then leave that application un-undoable
    // having deleted its files for a write that never landed.
    const backupsPruned = pruneBackups((state.lastApplication?.targets || [])
      .map((target) => target.backupPath));
    const appliedKeys = [...new Set([...newly.claude, ...newly.codex])].sort();
    const changedTargets = [...new Set(changes.map((item) =>
      item.kind === 'claude-claims' ? 'claude' : item.kind))];
    return {
      changed: changes.length > 0, changedTargets,
      applied: newly, appliedKeys, appliedCount: appliedKeys.length,
      // Reported on every apply, not only when something was removed: a prune
      // that could not delete a file is the case worth seeing, and a field that
      // only appears on the interesting run is a field nobody notices.
      backupsPruned: backupsPruned.removed, backupsKept: backupsPruned.kept,
      backupsUnremovable: backupsPruned.failed,
      skippedCount: Math.max(0, (keys || Object.keys(state.candidates)).length - selected.length),
      // Each entry names the managed rule that beat it, because a verdict alone
      // sends the reader hunting through a few hundred managed entries.
      withheldByPolicy: withheld.sort((a, b) => a.key.localeCompare(b.key)),
      at: changes.length ? time : null,
    };
  }
  function applyPolicy(value, additional) {
    const request = applyArguments(value, additional);
    return locked(() => applyUnlocked(load(), request));
  }
  function applyClaude(value, additional) {
    const request = applyArguments(value, additional);
    request.targets = ['claude'];
    return locked(() => applyUnlocked(load(), request));
  }
  function applyCodex(value, additional) {
    const request = applyArguments(value, additional);
    request.targets = ['codex'];
    return locked(() => applyUnlocked(load(), request));
  }

  // Derives the whole hit table from the whole corpus in one pass.
  //
  // A normal scan only sees what its cursors have not already consumed, so on
  // any machine that has been running a while the table would start empty and
  // the number actually worth acting on would take weeks to reappear. That is
  // the same "no evidence at install time" problem that makes a static block
  // the wrong answer, so the fix is an explicit one-time pass rather than
  // waiting. Cursors are passed empty to force a full read and the returned
  // ones are DISCARDED, so this neither advances nor rewinds a scan; candidates
  // and observation hashes are untouched for the same reason. Dedupe is per
  // pass, by observation id, which makes repeated runs idempotent.
  function rebuildManagedHits() {
    return locked(() => {
      const state = load();
      const matcher = probeMatcher();
      const policy = managedPolicy();
      // An unreadable policy is not a policy with no rules. Clearing the table
      // here said `degraded: true` and then mutated as if clean, which is the
      // rule this file enforces elsewhere inverted: the managed file is a
      // client-rewritten cache, so catching it mid-write once was enough to
      // destroy a full-corpus derivation. Absence IS positive evidence, because
      // `readPolicy` distinguishes ENOENT from a parse failure on purpose, so
      // that case still clears rather than keeping counts for rules that are
      // provably gone.
      if (policy.unreadable) {
        const kept = Object.keys(state.managedHits).length;
        return {
          policy: 'unreadable', degraded: true, blocked: 'managed-policy-unreadable',
          rules: kept, prompts: Object.values(state.managedHits)
            .reduce((total, item) => total + item.hits, 0),
          files: 0,
        };
      }
      if (!matcher) {
        state.managedHits = {};
        state.managedHitsAt = null;
        save(state);
        return {
          policy: policy.present ? 'present' : 'absent',
          degraded: false, rules: 0, prompts: 0, files: 0,
        };
      }
      const result = historyScanner({
        cursors: {}, claudeRoots, codexRoots, probeMatcher: matcher,
      });
      const seen = new Set();
      const hits = {};
      let watermark = '';
      for (const observation of result.observations || []) {
        if (workspaceRoot && !within(workspaceRoot, observation.cwd)) continue;
        const rule = clean(observation.managedRule, 200);
        if (!rule || seen.has(observation.id)) continue;
        seen.add(observation.id);
        const record = hits[rule] || { hits: 0, tools: [] };
        record.hits += 1;
        const tool = clean(observation.tool, 48);
        if (tool && !record.tools.includes(tool)) record.tools.push(tool);
        hits[rule] = record;
        // The newest call this pass accounted for. A scan must not count the
        // same call again: the scan's own dedupe is the observation hash, which
        // a rebuild deliberately does not touch, so on a state with no hashes
        // yet (a fresh install, which is exactly when this command is
        // recommended) a rebuild followed by a scan doubled the entire corpus,
        // and the doubled number is what gets written into a human's
        // instruction file as the justification for a standing rule.
        const stamp = clean(observation.timestamp, 64);
        if (stamp && stamp > watermark) watermark = stamp;
      }
      state.managedHits = managedHits(hits);
      state.managedHitsAt = watermark || now();
      save(state);
      return {
        policy: 'present', degraded: false,
        rules: Object.keys(state.managedHits).length,
        prompts: Object.values(state.managedHits).reduce((total, item) => total + item.hits, 0),
        files: Array.isArray(result.files) ? result.files.length : 0,
        countedThrough: state.managedHitsAt,
      };
    });
  }
  function scan(request = {}) {
    return locked(() => {
      const state = load();
      if (request.mode !== undefined) {
        if (!MODES.has(request.mode)) throw new Error(`Invalid Auto Learn mode: ${request.mode}`);
        state.mode = request.mode;
      }
      if (request.threshold !== undefined) {
        const next = positive(request.threshold, 0);
        if (!next) throw new Error('Auto Learn threshold must be a positive integer');
        state.threshold = next;
      }
      const result = historyScanner({
        cursors: state.cursors, claudeRoots, codexRoots,
        overlapBytes: request.overlapBytes, platform: request.platform,
        probeMatcher: probeMatcher(),
      });
      if (!result || !Array.isArray(result.observations) || !object(result.cursors)) {
        throw new Error('History scanner returned an invalid result');
      }
      let newObservations = 0;
      let updatedObservations = 0;
      let acceptedObservations = 0;
      for (const observation of result.observations) {
        if (workspaceRoot && !within(workspaceRoot, observation.cwd)) continue;
        let accepted = false;
        for (const fresh of aggregateObservations([observation], { threshold: 1 })) {
          const id = observationHash(observation, fresh.key);
          const previous = state.observationHashes[id];
          const next = observedOutcome(fresh);
          // An unanswered call is not execution evidence. It is neither persisted
          // nor allowed to create a candidate; a later correlated result can add it.
          if (next === 'unknown') continue;
          const item = mergeCandidate(state.candidates[fresh.key], fresh, state.threshold);
          if (!item) continue;
          state.candidates[fresh.key] = item;
          const source = fresh.sources[0] || clean(observation.source, 32) || 'unknown';
          if (!previous) {
            changeOutcome(item, null, next);
            state.observationHashes[id] = { key: fresh.key, outcome: next, source };
            newObservations += 1;
            // Counted once, on first sight, keyed off the same hash that stops
            // a re-scan from double-counting the candidate itself. The
            // watermark is the second guard, for the one case the hash cannot
            // cover: a rebuild counts straight from the corpus without writing
            // hashes, so anything it already accounted for must not be counted
            // again here.
            if (observation.managedRule && !countedByRebuild(state, observation)) {
              const rule = clean(observation.managedRule, 200);
              if (rule) {
                const record = state.managedHits[rule] || { hits: 0, tools: [] };
                record.hits += 1;
                const tool = clean(observation.tool, 48);
                if (tool && !record.tools.includes(tool)) record.tools.push(tool);
                state.managedHits[rule] = record;
              }
            }
          } else if (previous.key === fresh.key && previous.outcome !== next &&
              changeOutcome(item, previous.outcome, next)) {
            state.observationHashes[id] = { key: fresh.key, outcome: next, source };
            updatedObservations += 1;
          }
          if (!item.sources.includes(source)) item.sources.push(source);
          item.sources.sort();
          refresh(item, state.threshold);
          accepted = true;
        }
        if (accepted) acceptedObservations += 1;
      }
      for (const item of Object.values(state.candidates)) refresh(item, state.threshold);
      // Candidates first, because evicting one orphans its grant keys and its
      // observation hashes, and both of the passes that reconcile those run
      // after it. A grant key is evidence of a human decision, so a family that
      // holds one is never evictable in the first place.
      const grantedKeys = new Set([
        ...state.applied.claude, ...state.applied.codex,
        ...state.reviewed.claude, ...state.reviewed.codex,
        ...Object.values(state.codexTargets).flatMap((record) =>
          [...record.applied, ...record.reviewed]),
      ]);
      const prunedCandidateCount = pruneCandidates(state, candidateLimit, grantedKeys);
      const prunedGrants = pruneGrantKeys(state);
      const observationPrune = pruneObservationHashes(state, observationHashLimit);
      const prunedObservations = observationPrune.pruned;
      const retainedObservations = observationPrune.overCap;
      // A scan that enumerated NO FILES AT ALL does not get to speak for the
      // cursor map. `findJsonlFiles` cannot read a root it has no access to --
      // EACCES from antivirus, a disconnected profile share -- and it reports
      // that per directory rather than throwing, so the whole result comes back
      // empty. Replacing the map from that discarded every byte offset the
      // corpus had earned, and the next scan then re-read and re-counted every
      // transcript, while `lastScanStats` said {files:0, observations:0,
      // errors:0}: indistinguishable from "nothing to do".
      //
      // The guard is on the FILE LIST being empty, NOT on the cursor map being
      // empty. A scan that did enumerate files and still returned no cursor
      // dropped it on purpose -- a rewritten file whose read then failed must
      // lose its cursor, because it points at bytes that no longer exist -- and
      // reinstating that would resume from the wrong offset and silently skip
      // real calls. See the per-file catch in `scanHistoryFiles`.
      const scannedFiles = Array.isArray(result.files) ? result.files : [];
      // Root-walk failures are excluded, because a directory we could not
      // enumerate is not a file we looked at. They arrive through the same
      // `files[]` error channel — added so an unreadable root raises the error
      // count instead of looking like an empty corpus — and that made
      // `scannedFiles.length === 0` FALSE in exactly the scenario this guard
      // exists for. The two changes shipped in the same commit and the second
      // defeated the first: an EACCES or disconnected-share root still wiped
      // every cursor, so the next scan re-read and re-counted the whole corpus
      // and inflated the counts.success that gates auto-safe apply.
      const observedFiles = scannedFiles.filter((entry) => entry?.scope !== 'root');
      const blindScan = observedFiles.length === 0 && Object.keys(state.cursors).length > 0;
      if (!blindScan) {
        state.cursors = {};
        for (const [file, value] of Object.entries(result.cursors)) {
          const safe = cursor(value);
          const id = /^path-sha256:[a-f0-9]{24}$/.test(file)
            ? file : `path-sha256:${hash(Buffer.from(normalizedPath(file), 'utf8')).slice(0, 24)}`;
          if (safe) state.cursors[id] = safe;
        }
      }
      // Enforce the cap on the way out, so one scan cannot leave the file
      // holding more rules than the normalizer would accept reading it back.
      state.managedHits = managedHits(state.managedHits);
      // Last, because it has to run against the map this scan just decided on,
      // whether that is the replaced one or the preserved one. The preserved
      // case is the one that matters: it is the only path on which nothing else
      // prunes a cursor at all.
      const prunedCursorCount = pruneCursors(state, cursorLimit);
      // Asked on every scan, not once at construction: a migration lands between
      // ticks, and a detector that answered at startup would keep reporting the
      // pre-migration verdict for as long as the process lived. Same reason the
      // managed-policy cache here is keyed on a stat rather than held.
      //
      // Never allowed to fail a scan. The whole point is to add a signal to an
      // otherwise healthy-looking result; taking the result down with it would
      // be a worse outcome than the blindness it reports.
      let codexHistory = { stale: false, inspected: 'skipped', reasons: [], notes: [] };
      try { codexHistory = codexHistoryStore({ home, codexRoots }); }
      catch (error) {
        codexHistory = {
          stale: false, inspected: 'partial', reasons: [],
          notes: [`The Codex history-store check threw (${clean(error?.message || error, 200)}), so staleness is unknown.`],
        };
      }
      state.lastScanAt = now();
      state.lastScanStats = {
        files: Array.isArray(result.files) ? result.files.length : Object.keys(state.cursors).length,
        observations: acceptedObservations,
        errors: Array.isArray(result.files) ? result.files.filter((item) => item.mode === 'error').length : 0,
        partial: Array.isArray(result.files)
          ? result.files.filter((item) => item.mode === 'partial').length : 0,
        unmatchedResults: Array.isArray(result.files)
          ? result.files.reduce((total, item) => total + (Number(item.unmatchedResults) || 0), 0) : 0,
        prunedObservations,
        retainedObservations,
        prunedCursors: prunedCursorCount,
        prunedCandidates: prunedCandidateCount,
        prunedGrants,
        // "The cursor map was preserved because nothing was enumerated." The
        // error count already says a root failed; it does not say the scan was
        // therefore unable to look at anything, and a consumer tuning retry
        // backoff had to infer that from two numbers that also describe an
        // ordinary quiet scan. The signal is in the data -- walk failures carry
        // `scope: 'root'` -- so this only surfaces it.
        blindScan,
        codexHistoryStale: codexHistory.stale === true,
        codexHistoryInspected: codexHistory.inspected,
        codexHistoryReasons: codexHistory.reasons,
        codexHistoryNotes: codexHistory.notes,
      };
      save(state);
      const application = state.mode === 'auto-safe'
        ? applyUnlocked(state, { includeReviewed: false }) : null;
      return {
        scannedAt: state.lastScanAt, files: state.lastScanStats.files,
        observations: acceptedObservations, newObservations, updatedObservations,
        // `errors` was computed here all along and then not returned, so a file
        // that failed every scan for eight days was invisible to the CLI, the
        // dashboard and anything else that only ever sees this object.
        errors: state.lastScanStats.errors,
        partial: state.lastScanStats.partial,
        unmatchedResults: state.lastScanStats.unmatchedResults,
        prunedObservations, retainedObservations,
        prunedCursors: prunedCursorCount, prunedCandidates: prunedCandidateCount, prunedGrants,
        blindScan,
        codexHistoryStale: state.lastScanStats.codexHistoryStale,
        codexHistoryInspected: state.lastScanStats.codexHistoryInspected,
        codexHistoryReasons: state.lastScanStats.codexHistoryReasons,
        codexHistoryNotes: state.lastScanStats.codexHistoryNotes,
        candidates: Object.keys(state.candidates).length, application, apply: application,
      };
    });
  }

  // Undo releases this claimant's grants instead of restoring a file byte for
  // byte. Claude Code, the wildcarding pass and other workspaces all write the
  // same settings.json, so an unrelated edit must not make Undo unavailable,
  // and releasing a claim must never revoke a permission another claimant still
  // holds. Returns null when the current policy cannot be read.
  function releaseClaudeGrants(application) {
    const now = snapshot(claudeSettingsPath);
    if (!now.exists) return null;
    let settings;
    try { settings = JSON.parse(now.content.toString('utf8').replace(/^\uFEFF/, '')); }
    catch { return null; }
    if (!object(settings)) return null;
    const permissions = object(settings.permissions) ? settings.permissions : {};
    const allow = Array.isArray(permissions.allow) ? permissions.allow.slice() : [];
    const claims = parseClaudeClaims(snapshot(claudeClaimsPath), claudeClaimsPath);
    const restored = [...new Set(Object.values(application.grantsBefore?.managedClaude || {}))];
    const legacyManaged = new Set(Object.values(application.grantsAfter?.managedClaude || {}));
    const next = updateClaudeClaims(claims, claudeClaimantId, restored, allow, legacyManaged);
    return {
      claude: Buffer.from(JSON.stringify({
        ...settings, permissions: { ...permissions, allow: next },
      }, null, 2) + '\n'),
      'claude-claims': Buffer.from(renderClaudeClaims(claims)),
      solo: Object.keys(claims.permissions).length === 0,
    };
  }
  function undo() {
    return locked(() => {
      const state = load();
      const application = state.lastApplication;
      if (!application) return {
        changed: false, undone: false, reason: 'No Auto Learn application is available to undo.',
      };
      const restores = [];
      let released;
      for (const target of application.targets) {
        const current = snapshot(target.path);
        const before = snapshot(target.backupPath);
        if (!before.exists || before.hash !== target.beforeHash) throw new Error(
          `Refusing to undo because the Auto Learn backup is missing or changed: ${target.backupPath}`,
        );
        // An untouched target is restored exactly. A moved one is reconciled,
        // except the Codex rules file, which nothing else is expected to write.
        const untouched = current.exists && current.hash === target.afterHash;
        let content = before.content;
        let remove = untouched && !target.existed;
        if (target.kind === 'codex') {
          if (!untouched) throw new Error(
            `Refusing to undo because the policy changed after Auto Learn wrote it: ${target.path}`,
          );
        } else {
          if (released === undefined) released = releaseClaudeGrants(application);
          if (!released) throw new Error(
            `Refusing to undo because the policy could not be read: ${target.path}`,
          );
          content = released[target.kind];
          remove = released.solo && !target.existed;
        }
        restores.push({ target, current, before, content, untouched, remove });
      }
      const restored = [];
      try {
        for (const item of restores) {
          if (item.remove) {
            if (item.current.exists) fs.unlinkSync(item.target.path);
          } else atomicWrite(item.target.path, item.content);
          item.restored = snapshot(item.target.path);
          restored.push(item);
        }
        restoreGrants(state, application.grantsBefore);
        if (codexTargetId && state.codexTargets[codexTargetId]) {
          state.applied.codex = state.codexTargets[codexTargetId].applied.slice();
          state.reviewed.codex = state.codexTargets[codexTargetId].reviewed.slice();
        }
        state.lastApplication = null;
        save(state);
      } catch (error) {
        const conflicts = [];
        for (const item of restored.slice().reverse()) try {
          const current = snapshot(item.target.path);
          if (current.exists !== item.restored.exists || current.hash !== item.restored.hash) {
            conflicts.push(item.target.path);
            continue;
          }
          atomicWrite(item.target.path, item.current.content);
        } catch { conflicts.push(item.target.path); }
        if (conflicts.length) error.rollbackConflicts = conflicts;
        throw error;
      }
      return {
        changed: true, undone: true,
        restoredTargets: [...new Set(restores.map((item) =>
          item.target.kind === 'claude-claims' ? 'claude' : item.target.kind))],
      };
    });
  }

  return {
    paths: {
      home, state: statePath, lock: lockPath, backups: backupDir,
      claudeHistory: claudeRoots.slice(), codexHistory: codexRoots.slice(),
      claudeSettings: claudeSettingsPath, claudeClaims: claudeClaimsPath,
      codexRules: codexRulesPath,
    },
    scan, status, getStatus: status, overview, explainManaged, rebuildManagedHits,
    // The one definition of "which rule files does Codex see", shared with the
    // validator so the diagnostic and the write can never disagree about what
    // was evaluated. Callers print `blindSpots` beside the verdict.
    codexRuleSet: () => codexRuleFileSet({ home, target: codexRulesPath }),
    derivedReview, decideDerived,
    // `list` was a third alias of the same function with no consumer anywhere,
    // production or test. `getCandidates` is NOT one of those: it is the
    // fallback leg the extension takes at vscode-extension/extension.js:1032
    // when `listCandidates` is absent, so it stays.
    listCandidates, getCandidates: listCandidates,
    setMode, apply: applyPolicy, applyClaude, applyCodex, undo,
  };
}

// `migrateStateTo` is test-only, not dead: the version floor it carries is
// unreachable with this module's own one-rung ladder, and driving it with an
// injected ladder is the only way any input can make that check fail. See the
// note above the function.
module.exports = { createAutoLearnManager, migrateStateTo };
