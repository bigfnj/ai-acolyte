'use strict';

// Install, remove and inspect the PermissionRequest hook entries, and nothing
// else. Claude's goes through the settings writer's compare-and-swap transform;
// Codex's goes into hooks.json under the same lock, backup and stale-byte
// recheck as the after-turn Stop hook (src/codex-hook-install.js).
//
// Ownership is the EXACT handler this module writes. A handler that merely looks
// like ours (same script, different node, an old checkout path) is reported and
// left alone, because the retired MAX cleanup learned that a near match is not
// proof of authorship. Configuration never confers trust: Codex skips a
// non-managed hook until the person reviews this exact definition in /hooks.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');

const EVENT = 'PermissionRequest';
const CLAUDE_MATCHER = 'Bash|PowerShell';
const CODEX_MATCHER = 'Bash';
// Seconds. A hung hook holds the dialog until this, then the product cancels
// it and shows the normal prompt, so it is a ceiling on the cost, not a risk.
const TIMEOUT_SECONDS = 10;
const CODEX_STATUS_MESSAGE = 'AI Acolyte: checking saved permission rules';
const DEFAULT_SCRIPT = path.join(__dirname, '..', 'bin', 'wildcard-perms');

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const posixQuote = (text) => "'" + text.replace(/'/g, "'\"'\"'") + "'";
const windowsQuote = (text) => "'" + text.replace(/'/g, "''") + "'";

function checkedScript(scriptPath) {
  const script = scriptPath === undefined ? DEFAULT_SCRIPT : scriptPath;
  if (typeof script !== 'string' || !path.isAbsolute(script) || /[\u0000-\u001f\u007f"]/.test(script)) {
    throw new Error('the hook script must be an absolute path without quotes or control characters');
  }
  return path.resolve(script);
}

// The same spelling install.ps1 registers for the PostToolUse hook: forward
// slashes on Windows, because Claude Code may run the command under Git Bash or
// PowerShell and both read them.
function claudeHookCommand(options = {}) {
  const script = checkedScript(options.scriptPath);
  const platform = options.platform || process.platform;
  const inner = platform === 'win32' ? script.replace(/\\/g, '/') : script;
  return `node "${inner}" --permission-request claude`;
}

function claudeHandler(options) {
  return { type: 'command', command: claudeHookCommand(options), timeout: TIMEOUT_SECONDS };
}

function codexDefinition(options = {}) {
  const script = checkedScript(options.scriptPath);
  return { matcher: CODEX_MATCHER, hooks: [{ type: 'command',
    command: `${posixQuote('node')} ${posixQuote(script)} ${posixQuote('--permission-request')} ${posixQuote('codex')}`,
    commandWindows: `& ${windowsQuote('node')} ${windowsQuote(script)} ${windowsQuote('--permission-request')} ${windowsQuote('codex')}`,
    timeout: TIMEOUT_SECONDS, statusMessage: CODEX_STATUS_MESSAGE }] };
}

// A handler that names this tool's hook verb but is not byte-for-byte ours.
function looksLikeOurs(handler, product) {
  const text = `${handler.command || ''} ${handler.commandWindows || ''}`;
  return /wildcard-perms/.test(text) && new RegExp(`--permission-request['"]?\\s+['"]?${product}\\b`).test(text);
}

// Shared by both products: find our handler in an event's group list, refusing
// any shape that cannot be inspected safely.
function inspectGroups(groups, expected, product) {
  if (groups === undefined) return { status: 'missing', count: 0 };
  if (!Array.isArray(groups)) return { status: 'unsupported', reason: `hooks.${EVENT} is not an array` };
  let count = 0;
  for (const group of groups) {
    if (!object(group) || !Array.isArray(group.hooks) || group.hooks.some((handler) => !object(handler))) {
      return { status: 'unsupported', reason: `a hooks.${EVENT} group is malformed` };
    }
    for (const handler of group.hooks) {
      if (isDeepStrictEqual(handler, expected)) { count += 1; continue; }
      if (looksLikeOurs(handler, product)) {
        return { status: 'changed-definition',
          reason: `an AI Acolyte ${EVENT} hook with a different definition is present; remove or review it by hand` };
      }
    }
  }
  if (count > 1) return { status: 'changed-definition', reason: 'more than one AI Acolyte hook makes ownership ambiguous' };
  return { status: count ? 'configured' : 'missing', count };
}

// Remove exactly our handler. A group this writer created is dropped once
// empty; a group carrying anything else survives with its other contents.
function withoutHandler(groups, expected, matcher) {
  return groups.flatMap((group) => {
    const hooks = group.hooks.filter((handler) => !isDeepStrictEqual(handler, expected));
    if (hooks.length === group.hooks.length) return [group];
    const ours = group.matcher === matcher && Object.keys(group).every((key) => key === 'matcher' || key === 'hooks');
    return hooks.length || !ours ? [{ ...group, hooks }] : [];
  });
}

// ── Claude ────────────────────────────────────────────────────────────────────

// Pure: the transform handed to writeTransform, which writes `settings` only
// when `changed` is true and only if the file did not move underneath it.
function planClaudeHook(settings, enabled, options = {}) {
  const expected = claudeHandler(options);
  const hooks = settings.hooks;
  if (hooks !== undefined && !object(hooks)) throw new Error('settings.json `hooks` is not an object; nothing was changed');
  const before = inspectGroups(hooks?.[EVENT], expected, 'claude');
  if (before.status === 'unsupported' || before.status === 'changed-definition') {
    throw new Error(`refusing to change the ${EVENT} hook: ${before.reason}`);
  }
  if ((before.status === 'configured') === enabled) return { changed: false, settings, status: before.status };
  const next = { ...settings, hooks: { ...(hooks || {}) } };
  if (enabled) {
    next.hooks[EVENT] = [...(next.hooks[EVENT] || []), { matcher: CLAUDE_MATCHER, hooks: [expected] }];
  } else {
    const remaining = withoutHandler(next.hooks[EVENT], expected, CLAUDE_MATCHER);
    if (remaining.length) next.hooks[EVENT] = remaining;
    else delete next.hooks[EVENT];
    if (!Object.keys(next.hooks).length) delete next.hooks;
  }
  return { changed: true, settings: next, status: enabled ? 'configured' : 'missing' };
}

function claudeSettingsPath(options = {}) {
  const home = path.resolve(options.home === undefined ? os.homedir() : options.home);
  return path.join(home, '.claude', 'settings.json');
}

// The shared policy lock, derived from the home in use rather than from the
// module-level constant, so a test home locks its own file.
function claudeLockPath(options = {}) {
  const home = path.resolve(options.home === undefined ? os.homedir() : options.home);
  return path.join(home, '.claude', 'wildcarding', 'auto-learn-policy.lock');
}

// What a managed policy says about this event. Its own declaration, not an
// observation: per-event enforcement has changed across policy versions, so the
// observe-mode log is what settles whether the hook runs in each app.
function managedHookVerdict(options = {}) {
  const { readPolicy, hookEventAllowed } = require('./managed-policy');
  const policy = readPolicy({ home: options.home });
  if (!policy.present) return { managed: false, dropped: false, unreadable: Boolean(policy.unreadable) };
  return { managed: true, dropped: !hookEventAllowed(policy, EVENT), unreadable: false };
}

function inspectClaudePermissionHook(options = {}) {
  const { readSettingsState } = require('./settings-write');
  const file = claudeSettingsPath(options);
  const state = readSettingsState(file);
  const base = { product: 'claude', path: file, command: claudeHookCommand(options), policy: managedHookVerdict(options) };
  if (state.state === 'unreadable') return { ...base, status: 'unreadable', configured: false, writable: false };
  const hooks = state.settings.hooks;
  if (hooks !== undefined && !object(hooks)) {
    return { ...base, status: 'unsupported', configured: false, writable: false, reason: '`hooks` is not an object' };
  }
  const found = inspectGroups(hooks?.[EVENT], claudeHandler(options), 'claude');
  return { ...base, status: found.status, configured: found.status === 'configured',
    writable: found.status === 'configured' || found.status === 'missing', reason: found.reason };
}

function setClaudePermissionHook(enabled, options = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  const { createSettingsWriter } = require('./settings-write');
  const { createPolicyLock } = require('./policy-lock');
  const settingsPath = claudeSettingsPath(options);
  fs.mkdirSync(path.dirname(claudeLockPath(options)), { recursive: true });
  let outcome;
  createPolicyLock({ lockPath: claudeLockPath(options) }).locked(() => {
    const writer = createSettingsWriter({ settingsPath });
    if (options.beforeWrite) options.beforeWrite(settingsPath);
    outcome = writer.writeTransform((latest) => planClaudeHook(latest, enabled, options));
  });
  const after = inspectClaudePermissionHook(options);
  if (after.configured !== enabled) throw new Error('settings.json did not retain the requested hook state');
  return { ...after, changed: Boolean(outcome && outcome.wrote) };
}

// ── Codex ─────────────────────────────────────────────────────────────────────

function readHooksFile(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('hooks.json must be an ordinary file');
  const bytes = fs.readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('hooks.json must contain valid UTF-8');
  return text;
}

function planCodexHook(text, enabled, options = {}) {
  const definition = codexDefinition(options);
  const expected = definition.hooks[0];
  let data = {};
  if (text !== null && text !== undefined) {
    try { data = JSON.parse(text); }
    catch (error) { throw new Error(`refusing to change Codex hooks: cannot parse hooks.json (${error.message})`); }
  }
  if (!object(data) || (data.hooks !== undefined && !object(data.hooks))) {
    throw new Error('refusing to change Codex hooks: hooks.json must hold an object with an object `hooks`');
  }
  const before = inspectGroups(data.hooks?.[EVENT], expected, 'codex');
  if (before.status === 'unsupported' || before.status === 'changed-definition') {
    throw new Error(`refusing to change Codex hooks: ${before.reason}`);
  }
  if ((before.status === 'configured') === enabled) return { changed: false, text, status: before.status };
  if (enabled) {
    if (!data.hooks) data.hooks = {};
    data.hooks[EVENT] = [...(data.hooks[EVENT] || []), definition];
  } else {
    const remaining = withoutHandler(data.hooks[EVENT], expected, CODEX_MATCHER);
    if (remaining.length) data.hooks[EVENT] = remaining;
    else delete data.hooks[EVENT];
    if (!Object.keys(data.hooks).length) delete data.hooks;
  }
  const newline = typeof text === 'string' && text.includes('\r\n') ? '\r\n' : '\n';
  return { changed: true, status: enabled ? 'configured' : 'missing',
    text: JSON.stringify(data, null, 2).replace(/\n/g, newline) + newline };
}

function codexHooksPath(options = {}) {
  const { resolveCodexHome } = require('./codex-paths');
  return path.join(resolveCodexHome(options), 'hooks.json');
}

function inspectCodexPermissionHook(options = {}) {
  const file = codexHooksPath(options);
  const base = { product: 'codex', path: file, trust: 'not-verified', reviewRequired: true,
    definition: codexDefinition(options) };
  let text;
  try { text = readHooksFile(file); }
  catch (error) { return { ...base, status: 'unreadable', configured: false, writable: false, reason: error.message }; }
  let data = {};
  if (text !== null) {
    try { data = JSON.parse(text); }
    catch { return { ...base, status: 'unsupported', configured: false, writable: false, reason: 'cannot parse hooks.json' }; }
  }
  if (!object(data) || (data.hooks !== undefined && !object(data.hooks))) {
    return { ...base, status: 'unsupported', configured: false, writable: false, reason: 'hooks.json shape' };
  }
  const found = inspectGroups(data.hooks?.[EVENT], base.definition.hooks[0], 'codex');
  return { ...base, status: found.status, configured: found.status === 'configured',
    writable: found.status === 'configured' || found.status === 'missing', reason: found.reason };
}

function setCodexPermissionHook(enabled, options = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  const { resolveCodexHome } = require('./codex-paths');
  const { createPolicyLock } = require('./policy-lock');
  const { writeFileAtomicSync } = require('./permissions');
  const codexHome = resolveCodexHome(options);
  const file = path.join(codexHome, 'hooks.json');
  const home = path.resolve(options.home === undefined ? os.homedir() : options.home);
  const scope = process.platform === 'win32' ? codexHome.toLowerCase() : codexHome;
  const id = crypto.createHash('sha256').update(scope).digest('hex').slice(0, 16);
  const backupPath = path.join(home, '.ai-acolyte', 'backups', `codex-hooks.${id}.pre-permission-request.json`);
  let backup = null;
  let changed = false;
  createPolicyLock({ lockPath: `${file}.ai-acolyte.lock` }).locked(() => {
    const before = readHooksFile(file);
    const plan = planCodexHook(before, enabled, options);
    if (!plan.changed) return;
    if (before !== null) {
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      writeFileAtomicSync(backupPath, before);
      backup = backupPath;
    }
    if (options.beforeWrite) options.beforeWrite(file);
    if (readHooksFile(file) !== before) throw new Error('Codex hooks changed during configuration; retry after reviewing the current file');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomicSync(file, plan.text);
    if (readHooksFile(file) !== plan.text) throw new Error('Codex hooks did not retain the requested configuration');
    changed = true;
  });
  return { ...inspectCodexPermissionHook(options), changed, backupPath: backup };
}

module.exports = {
  claudeHookCommand, planClaudeHook, planCodexHook,
  inspectClaudePermissionHook, setClaudePermissionHook,
  inspectCodexPermissionHook, setCodexPermissionHook,
};
