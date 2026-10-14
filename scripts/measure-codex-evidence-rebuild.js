'use strict';

// MEASURE A CODEX EVIDENCE REBUILD ON A COPY OF REAL HISTORY (2026-10-13).
//
//   node scripts/measure-codex-evidence-rebuild.js [--state <auto-learn-state file name>]...
//     [--max-scans <n>] [--keep]
//
// Raising CODEX_EVIDENCE_REVISION (src/auto-learn-manager.js) makes every Auto Learn
// state re-read its Codex history once. This measures what that does to a real
// corpus without touching it. It copies, into a fresh private temp tree, the Codex
// history the manager reads (sessions/, archived_sessions/, session_index.jsonl,
// thread_history_1.sqlite and state_5.sqlite with their -wal/-shm) and each chosen
// state file. It then points this process's HOME, USERPROFILE and CODEX_HOME at the
// copy BEFORE any product module loads, and drives a manager on the copy until the
// rebuild completes. It reports numbers only: scans to complete, observations
// re-read, Codex count totals before and after, and whether any Claude count, Claude
// hash, cursor or grant moved. The real files are only ever read; each chosen
// state file's sha256 is compared before and after, and the copy is deleted at the
// end unless --keep is given.
//
// A workspace-scoped state (auto-learn-state.<id>.json) counts only observations
// under its workspace root, so the root is recovered by hashing the way the manager
// names the file: session cwds from the copied rollouts and their ancestors, then a
// bounded walk of the home directory (directory names only, depth 4). A state whose
// root cannot be found is reported and skipped, never run unscoped. Claude history
// is not copied (claudeRoots: []), so no Claude evidence can arrive and any Claude
// count that moves is the migration's doing. One consequence, recorded rather than
// hidden: a scan AFTER the rebuild, on a copy with no Claude history, drops the
// Claude cursors, so the Claude cursor check is made on the scan that completes it.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// `--subject <dir>` loads src/auto-learn-manager.js from another tree, e.g. the
// previous release's, so the same copy can be caught up WITHOUT a rebuild. That is
// the control the numbers need: a state last scanned weeks ago also reads the
// history written since, and only the difference between the two runs' families
// is the parser corrections. Families are reported by an 8-hex hash of their key,
// so two runs compare without either naming a command.
const args = process.argv.slice(2);
const values = (name) => args.flatMap((value, index) => (args[index - 1] === name ? [value] : []));
const usage = 'usage: measure-codex-evidence-rebuild.js [--state <name>]... [--max-scans <n>] [--subject <dir>] [--keep]';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--keep') continue;
  assert.ok(['--state', '--max-scans', '--subject'].includes(args[i]) && args[i + 1], usage);
  i += 1;
}
const maxScans = Number(values('--max-scans')[0] || 100);
const subject = path.resolve(values('--subject')[0] || path.join(__dirname, '..'));
const realHome = os.homedir();
const realCodex = path.join(realHome, '.codex');
const realStates = path.join(realHome, '.claude', 'wildcarding');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const workspaceId = (dir) => crypto.createHash('sha256')
  .update(Buffer.from(path.resolve(dir).replace(/[\\/]+$/, '').toLowerCase(), 'utf8')).digest('hex').slice(0, 16);

const chosen = values('--state').length ? values('--state')
  : fs.readdirSync(realStates).filter((name) => /^auto-learn-state(\.[a-f0-9]{16})?\.json$/.test(name));
for (const name of chosen) assert.match(name, /^auto-learn-state(\.[a-f0-9]{16})?\.json$/, `not a state file name: ${name}`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-evidence-rebuild-'));
const home = path.join(root, 'home');
const codexHome = path.join(home, '.codex');
const report = { measuredAt: new Date().toISOString(), copied: {}, states: [] };
try {
  // THE COPY. Read-only towards the real home: every operation below that names it
  // is a read (cpSync / copyFileSync source, readdirSync, readFileSync, statSync).
  fs.mkdirSync(codexHome, { recursive: true });
  for (const dir of ['sessions', 'archived_sessions']) {
    if (fs.existsSync(path.join(realCodex, dir))) fs.cpSync(path.join(realCodex, dir), path.join(codexHome, dir), { recursive: true });
  }
  for (const file of ['session_index.jsonl', 'thread_history_1.sqlite', 'thread_history_1.sqlite-wal', 'thread_history_1.sqlite-shm',
    'state_5.sqlite', 'state_5.sqlite-wal', 'state_5.sqlite-shm']) {
    if (fs.existsSync(path.join(realCodex, file))) fs.copyFileSync(path.join(realCodex, file), path.join(codexHome, file));
  }
  const rollouts = [];
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file); else if (entry.name.endsWith('.jsonl')) rollouts.push(file);
  } };
  for (const dir of ['sessions', 'archived_sessions']) if (fs.existsSync(path.join(codexHome, dir))) walk(path.join(codexHome, dir));
  report.copied = { rollouts: rollouts.length, bytes: rollouts.reduce((sum, file) => sum + fs.statSync(file).size, 0) };

  // Workspace roots by id, from the copy's session cwds first, then the home walk.
  const roots = new Map();
  const consider = (dir) => { const id = workspaceId(dir); if (!roots.has(id)) roots.set(id, dir); };
  for (const file of rollouts) {
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(65536);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    const head = buffer.subarray(0, bytes).toString('utf8').split('\n', 4);
    for (const line of head) {
      try {
        const record = JSON.parse(line);
        if (record.type !== 'session_meta' || typeof record.payload?.cwd !== 'string') continue;
        for (let dir = record.payload.cwd, i = 0; i < 8; i++) { consider(dir); const up = path.dirname(dir); if (up === dir) break; dir = up; }
      } catch { /* not a JSON head line */ }
    }
  }
  const skip = new Set(['node_modules', '.git', 'AppData', '.cache', '.npm', '__pycache__', '.venv']);
  const homeWalk = (dir, depth) => {
    consider(dir);
    if (depth >= 4) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) if (entry.isDirectory() && !skip.has(entry.name)) homeWalk(path.join(dir, entry.name), depth + 1);
  };
  homeWalk(realHome, 0);

  // From here the process sees only the copy.
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.CODEX_HOME = codexHome;
  assert.equal(os.homedir(), home, 'the home must be the copy before product modules load');
  const { createAutoLearnManager } = require(path.join(subject, 'src', 'auto-learn-manager'));
  report.subject = subject === path.join(__dirname, '..') ? 'this checkout' : 'another tree (--subject)';
  fs.mkdirSync(path.join(home, '.claude', 'wildcarding'), { recursive: true });

  for (const name of chosen) {
    const original = path.join(realStates, name);
    const originalHash = sha(original);
    const id = /^auto-learn-state\.([a-f0-9]{16})\.json$/.exec(name)?.[1] || null;
    const workspaceRoot = id ? roots.get(id) : null;
    const entry = { state: name, scoped: !!id };
    report.states.push(entry);
    if (id && !workspaceRoot) { entry.skipped = 'workspace root not found'; continue; }
    const copy = path.join(home, '.claude', 'wildcarding', name);
    fs.copyFileSync(original, copy);
    const read = () => JSON.parse(fs.readFileSync(copy, 'utf8').replace(/^\uFEFF/, ''));
    const before = read();
    entry.before = { version: before.version, revision: before.codexEvidenceRevision ?? null, mode: before.mode };
    const options = { home, codexHome, statePath: copy, claudeRoots: [], ...(workspaceRoot ? { workspaceRoot } : {}) };
    const manager = createAutoLearnManager(options);
    const loaded = manager.status().codexEvidence;
    entry.onLoad = { revision: loaded.revision, pending: loaded.pending, remainingFiles: loaded.remainingFiles };
    entry.scans = [];
    let last = null;
    while (entry.scans.length < maxScans) {
      last = manager.scan();
      entry.scans.push({ newObservations: last.newObservations, updatedObservations: last.updatedObservations ?? 0,
        pending: last.codexEvidence.pending, remainingFiles: last.codexEvidence.remainingFiles,
        deferredBytes: last.deferredBytes ?? null, applied: last.application != null });
      // Complete means no rebuild pending AND nothing deferred: a large rollout is
      // read across several scans by the per-file ingest budget, rebuild or not.
      if (!last.codexEvidence.pending && !last.deferredBytes) break;
    }
    const after = read();
    entry.scansToComplete = last && !last.codexEvidence.pending && !last.deferredBytes ? entry.scans.length : null;
    entry.scansToClearPending = (() => { const at = entry.scans.findIndex((scan) => !scan.pending); return at < 0 ? null : at + 1; })();
    // Codex: totals before and after, by outcome, and how many families moved.
    const codexCounts = (state) => {
      const total = { success: 0, failed: 0, unknown: 0, total: 0 };
      let families = 0;
      for (const item of Object.values(state.candidates)) {
        const codex = item.sourceCounts?.codex;
        if (!codex || !codex.total) continue;
        families += 1;
        for (const key of Object.keys(total)) total[key] += codex[key] || 0;
      }
      return { families, ...total };
    };
    const hashes = (state, source) => Object.values(state.observationHashes).filter((value) => value.source === source).length;
    entry.codex = { before: { ...codexCounts(before), hashes: hashes(before, 'codex') }, after: { ...codexCounts(after), hashes: hashes(after, 'codex') } };
    const familyCounts = (state) => Object.fromEntries(Object.values(state.candidates)
      .filter((item) => item.sourceCounts?.codex?.total).map((item) => [item.key, JSON.stringify(item.sourceCounts.codex)]));
    const [b, a] = [familyCounts(before), familyCounts(after)];
    entry.codex.familiesChanged = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((key) => b[key] !== a[key]).length;
    entry.codex.familiesAppeared = Object.keys(a).filter((key) => !(key in b)).length;
    entry.codex.familiesEmptied = Object.keys(b).filter((key) => !(key in a)).length;
    // Per family, after: [success, failed, unknown], keyed by a hash of the key.
    entry.codex.vectors = Object.fromEntries(Object.values(after.candidates).filter((item) => item.sourceCounts?.codex?.total)
      .map((item) => [crypto.createHash('sha256').update(item.key).digest('hex').slice(0, 8),
        [item.sourceCounts.codex.success, item.sourceCounts.codex.failed, item.sourceCounts.codex.unknown]]));
    // Claude and policy: nothing may move.
    const claudeLedger = (state) => JSON.stringify(Object.fromEntries(Object.values(state.candidates)
      .map((item) => [item.key, item.sourceCounts?.claude || null]).filter(([, value]) => value).sort()));
    const claudeHashes = (state) => JSON.stringify(Object.entries(state.observationHashes).filter(([, value]) => value.source === 'claude').sort());
    const claudeCursors = (state) => JSON.stringify(Object.entries(state.cursors).filter(([, value]) => value.source === 'claude').sort());
    entry.claude = {
      families: Object.values(after.candidates).filter((item) => item.sourceCounts?.claude?.total).length,
      hashesBefore: hashes(before, 'claude'),
      hashes: hashes(after, 'claude'),
      // A dedupe hash leaves only to the observation-hash cap, never a count; any
      // that left this run are listed so the cap's share is visible.
      hashesEvicted: Object.keys(before.observationHashes).filter((id) => before.observationHashes[id].source === 'claude' && !after.observationHashes[id]).length,
      countsUnchanged: claudeLedger(before) === claudeLedger(after),
      hashesUnchanged: claudeHashes(before) === claudeHashes(after),
      cursorsUnchanged: claudeCursors(before) === claudeCursors(after),
    };
    const same = (field) => JSON.stringify(before[field] ?? null) === JSON.stringify(after[field] ?? null);
    entry.grants = { appliedClaude: after.applied.claude.length, appliedCodex: after.applied.codex.length,
      unchanged: Object.fromEntries(['applied', 'reviewed', 'codexTargets', 'lastApplication', 'managedClaude'].map((field) => [field, same(field)])),
      // The copy's Codex rules file lives under the copy's home, a different target
      // id from the real one, so the manager registers it, empty. What matters is
      // that every target the state already had is exactly as it was.
      codexTargets: { before: Object.keys(before.codexTargets || {}).length, after: Object.keys(after.codexTargets || {}).length,
        existingUnchanged: Object.entries(before.codexTargets || {}).every(([id, value]) => JSON.stringify(after.codexTargets?.[id]) === JSON.stringify(value)),
        addedNonEmpty: Object.entries(after.codexTargets || {}).filter(([id, value]) => !(id in (before.codexTargets || {}))
          && (value.applied.length || value.reviewed.length)).length },
      preserved: { before: Object.keys(before.preservedEvidenceGrants || {}).length, after: Object.keys(after.preservedEvidenceGrants || {}).length,
        // Each preserved grant's failure baseline beside its family's failures now.
        baselines: Object.entries(after.preservedEvidenceGrants || {}).map(([key, value]) => ({
          before: before.preservedEvidenceGrants?.[key]?.failureCountAtRebuild ?? null, after: value.failureCountAtRebuild,
          familyFailedBefore: before.candidates[key]?.counts?.failed ?? null, familyFailedAfter: after.candidates[key]?.counts?.failed ?? null })) } };
    entry.legacyArchive = { before: Object.keys(before.legacyCodexEvidence || {}).length, after: Object.keys(after.legacyCodexEvidence || {}).length };
    // Once: a fresh load starts nothing, and one more scan re-counts nothing.
    const again = createAutoLearnManager(options);
    const reloaded = again.status().codexEvidence;
    const extra = again.scan();
    entry.afterwards = { reloadPending: reloaded.pending, revision: reloaded.revision, nextScanNewObservations: extra.newObservations,
      rebuildStartedAtUnchanged: read().codexEvidenceRebuildStartedAt === after.codexEvidenceRebuildStartedAt };
    entry.originalUntouched = sha(original) === originalHash;
  }
} finally {
  if (!args.includes('--keep')) fs.rmSync(root, { recursive: true, force: true });
  report.copyRemoved = !fs.existsSync(root);
}
console.log(JSON.stringify(report, null, 1));
