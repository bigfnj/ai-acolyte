'use strict';

// Prunes the real-editor drive's earlier run directories.
//
// scripts/drive-vscode.js keeps each run's isolated VS Code profile and logs in os.tmpdir() on
// purpose, and prints the path, so a failed run can be inspected. Nothing removed them: on
// 2026-10-20 this box's %TEMP% held 112, 3.00 GB in 23,938 files, on C:, its only SSD. So at
// the start of a run drive-vscode.js calls pruneDriveDirs, which keeps the DRIVE_KEEP most
// recent earlier directories (by modification time) and removes the rest. The environment
// variable ACOLYTE_DRIVE_KEEP overrides DRIVE_KEEP with a whole number; 0 keeps none.
//
// What it removes, and nothing else: an entry directly inside the root whose name is
// DRIVE_PREFIX followed by the six letters and digits mkdtemp appends, and which lstat says is
// a directory. A symlink or junction of that name is left alone, never followed (lstat reports
// a junction as a link, not a directory), and so is every other name. Inside a directory it
// removes, fs.rmSync unlinks a link rather than following it (measured for a junction on Node
// 24.16.0), and the size walk never goes through one. A directory it cannot remove is a
// warning, and the run goes on; it prints how many it removed and how much that freed either way.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DRIVE_PREFIX = 'acolyte-vscode-drive-';
const DRIVE_KEEP = 3;
const KEEP_ENV = 'ACOLYTE_DRIVE_KEEP';
const RUN_NAME = new RegExp(`^${DRIVE_PREFIX}[A-Za-z0-9]{6}$`);

function keepFrom(env) {
  const raw = env[KEEP_ENV];
  if (raw === undefined || raw === '') return DRIVE_KEEP;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${KEEP_ENV} must be a whole number of earlier drive directories to keep, not ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

// The bytes of the files in a tree. A dirent for a symlink or junction is neither a directory
// nor a file, so the walk never goes through one and never counts what it points at.
function treeBytes(dir) {
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) { try { bytes += fs.lstatSync(child).size; } catch { /* gone */ } }
    }
  }
  return bytes;
}

const formatBytes = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`);

function pruneDriveDirs({ root = os.tmpdir(), env = process.env, log = console } = {}) {
  const keep = keepFrom(env);
  const runs = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!RUN_NAME.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    let stat;
    try { stat = fs.lstatSync(dir); } catch { continue; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    runs.push({ dir, mtimeMs: stat.mtimeMs });
  }
  runs.sort((a, b) => b.mtimeMs - a.mtimeMs || a.dir.localeCompare(b.dir));
  const kept = runs.slice(0, keep).map((run) => run.dir);
  let removed = 0;
  let freedBytes = 0;
  const failed = [];
  for (const { dir } of runs.slice(keep)) {
    const bytes = treeBytes(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
      freedBytes += bytes;
    } catch (error) {
      // Whatever went before the failure is freed all the same.
      freedBytes += bytes - (fs.existsSync(dir) ? treeBytes(dir) : 0);
      failed.push({ dir, code: error.code || error.message });
      log.warn(`warning: could not remove the earlier drive directory ${dir} (${error.code || error.message}); left in place`);
    }
  }
  log.log(`Pruned ${removed} earlier drive ${removed === 1 ? 'directory' : 'directories'} from ${root}, `
    + `freeing ${formatBytes(freedBytes)}; kept the ${kept.length} most recent (${KEEP_ENV}=${keep})`
    + `${failed.length ? `; ${failed.length} could not be removed` : ''}.`);
  return { kept, removed, freedBytes, failed };
}

module.exports = { DRIVE_PREFIX, pruneDriveDirs };
