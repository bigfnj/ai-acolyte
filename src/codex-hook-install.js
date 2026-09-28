'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveCodexHome } = require('./codex-paths');
const { createPolicyLock } = require('./policy-lock');
const { writeFileAtomicSync } = require('./permissions');
const { inspectCodexStopHook, mergeCodexStopHook } = require('./codex-hook-config');

function readHooks(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('hooks.json must be an ordinary file');
  const bytes = fs.readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('hooks.json must contain valid UTF-8');
  return text;
}

function inspectCodexHook(options = {}) {
  const file = path.join(resolveCodexHome(options), 'hooks.json');
  try { return { ...inspectCodexStopHook(readHooks(file), options), path: file }; }
  catch (error) { return { ...inspectCodexStopHook(null, { ...options, readError: error }), path: file }; }
}

function setCodexHook(enabled, options = {}) {
  const codexHome = resolveCodexHome(options);
  const file = path.join(codexHome, 'hooks.json');
  const home = options.home === undefined ? os.homedir() : path.resolve(options.home);
  const scope = process.platform === 'win32' ? codexHome.toLowerCase() : codexHome;
  const id = crypto.createHash('sha256').update(scope).digest('hex').slice(0, 16);
  const backupPath = path.join(home, '.ai-acolyte', 'backups', `codex-hooks.${id}.pre-change.json`);
  return createPolicyLock({ lockPath: `${file}.ai-acolyte.lock` }).locked(() => {
    const before = readHooks(file);
    const result = mergeCodexStopHook(before, enabled, options);
    if (!result.changed) return { ...result, path: file, backupPath: null };
    if (before !== null) {
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      writeFileAtomicSync(backupPath, before);
    }
    if (options.beforeWrite) options.beforeWrite(file);
    if (readHooks(file) !== before) throw new Error('Codex hooks changed during configuration; retry after reviewing the current file');
    writeFileAtomicSync(file, result.text);
    if (readHooks(file) !== result.text) throw new Error('Codex hooks did not retain the requested configuration');
    return { ...result, path: file, backupPath: before === null ? null : backupPath };
  });
}

module.exports = { inspectCodexHook, setCodexHook };
