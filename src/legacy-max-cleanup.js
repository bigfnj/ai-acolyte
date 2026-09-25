'use strict';

// One-way upgrade cleanup for installations that enabled the removed MAX
// feature. Nothing in this module can create a blanket grant, approve hook, or
// Codex approval-policy override.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LEGACY_CLAUDE_STATE_FILE = path.join(os.homedir(), '.claude', 'backups', 'wildcarding-max.json');
const LEGACY_CODEX_STATE_FILE = path.join(os.homedir(), '.claude', 'backups', 'wildcarding-codex-max.json');
const LEGACY_APPROVE_SCRIPT = path.join(os.homedir(), '.claude', 'wildcarding', 'approve-all.js');
const CODEX_CONFIG = path.join(os.homedir(), '.codex', 'config.toml');

const LEGACY_ALLOW_CORE = ['Bash(*)', 'PowerShell(*)', 'Read(*)', 'Edit', 'Write', 'WebFetch(*)', 'WebSearch'];
const LEGACY_ALLOW_MARKERS = ['Bash(*)', 'PowerShell(*)'];
const LEGACY_APPROVE_MARKER = 'approve-all';
// SHA-256 of the exact approve-all.js bytes written by the last release that
// offered MAX. Keeping only the digest means the retired auto-approve program
// is not shipped inside the replacement cleanup module.
const LEGACY_SCRIPT_SHA256 = 'd9f7e435e4b0c0878820f7991c446b857385d9f0d404f7ee307655a5d6cbe8c4';
const TOP_LEVEL_TABLE = /^[ \t]*\[/;
const APPROVAL_LINE = /^[ \t]*approval_policy[ \t]*=/;

function readJsonState(file, valid) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { exists: true, valid: Boolean(valid(value)), value };
  } catch (error) {
    return { exists: error?.code !== 'ENOENT', valid: false, value: {} };
  }
}

function readClaudeState(file = LEGACY_CLAUDE_STATE_FILE) {
  return readJsonState(file, (value) => value && typeof value === 'object'
    && Array.isArray(value.allowSnapshot)
    && value.allowSnapshot.every((entry) => typeof entry === 'string'));
}

function readCodexState(file = LEGACY_CODEX_STATE_FILE) {
  return readJsonState(file, (value) => value && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, 'priorApproval')
    && (value.priorApproval === null || typeof value.priorApproval === 'string'));
}

function detectMcpServers(allow) {
  const servers = new Set();
  for (const entry of Array.isArray(allow) ? allow : []) {
    const match = /^mcp__(.+?)__/.exec(entry);
    if (match) servers.add(match[1]);
  }
  return [...servers];
}

function legacyAllowActive(settings) {
  const allow = settings?.permissions?.allow;
  return Array.isArray(allow) && LEGACY_ALLOW_MARKERS.every((marker) => allow.includes(marker));
}

// Exact allow-list additions made by the retired implementation for a given
// pre-MAX snapshot. Core entries already present belonged to the user. MCP
// blankets were generated only for servers represented in that snapshot; a
// blanket for a server introduced later is therefore not ours to remove.
function legacyGeneratedAllow(allowSnapshot) {
  const snapshot = Array.isArray(allowSnapshot) ? allowSnapshot : [];
  const prior = new Set(snapshot);
  const generated = LEGACY_ALLOW_CORE.filter((entry) => !prior.has(entry));
  for (const server of detectMcpServers(snapshot)) {
    const blanket = `mcp__${server}__*`;
    if (!prior.has(blanket)) generated.push(blanket);
  }
  return generated;
}

function legacyGeneratedAllowFromState(statePath = LEGACY_CLAUDE_STATE_FILE) {
  const state = readClaudeState(statePath);
  return state.valid ? legacyGeneratedAllow(state.value.allowSnapshot) : [];
}

function withoutLegacyGeneratedBackup(backup, statePath = LEGACY_CLAUDE_STATE_FILE) {
  if (!backup || !Array.isArray(backup.allow) || !Array.isArray(backup.deny)) return backup;
  const drop = new Set(legacyGeneratedAllowFromState(statePath));
  if (!drop.size) return backup;
  return {
    allow: backup.allow.filter((entry) => !drop.has(entry)),
    deny: [...backup.deny],
  };
}

function legacyApproveCommandFor(scriptPath = LEGACY_APPROVE_SCRIPT, platform = process.platform) {
  const inner = platform === 'win32'
    ? String(scriptPath).replace(/\\/g, '/')
    : String(scriptPath).replace(/[\\"$`]/g, (character) => `\\${character}`);
  return `node "${inner}"`;
}

function hookCommands(settings) {
  const entries = settings?.hooks?.PreToolUse;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => Array.isArray(entry?.hooks) ? entry.hooks : [])
    .map((hook) => hook?.command)
    .filter((command) => typeof command === 'string');
}

function legacyApproveHookActive(settings, options = {}) {
  const expected = legacyApproveCommandFor(
    options.scriptPath ?? LEGACY_APPROVE_SCRIPT,
    options.platform ?? process.platform,
  );
  return hookCommands(settings).some((command) => command === expected);
}

function legacyApproveHookLike(settings) {
  return hookCommands(settings).some((command) => command.includes(LEGACY_APPROVE_MARKER));
}

function legacyClaudeMaxStatus(settings, options = {}) {
  const statePath = options.statePath ?? LEGACY_CLAUDE_STATE_FILE;
  const snapshot = readClaudeState(statePath);
  const current = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
  const generated = snapshot.valid
    ? legacyGeneratedAllow(snapshot.value.allowSnapshot).filter((entry) => current.includes(entry))
    : [];
  const allow = legacyAllowActive(settings);
  const hook = legacyApproveHookActive(settings, options);
  const hookLike = legacyApproveHookLike(settings);
  return {
    present: generated.length > 0 || allow || hook || hookLike,
    allow,
    generatedAllow: generated,
    hook,
    hookLike,
    snapshotExists: snapshot.exists,
    snapshotValid: snapshot.valid,
    // Only the exact generated hook is current ownership evidence. A snapshot
    // can outlive MAX-off, so snapshot + matching permissions is reviewable but
    // never grounds an automatic cleanup by itself.
    candidate: hook,
    ambiguous: (generated.length > 0 && !hook) || (allow && !hook) || (hookLike && !hook),
  };
}

function withAllow(settings, allow) {
  return { ...settings, permissions: { ...(settings?.permissions ?? {}), allow } };
}

function withMode(settings, mode) {
  const permissions = { ...(settings?.permissions ?? {}) };
  if (mode === null || mode === undefined) delete permissions.defaultMode;
  else permissions.defaultMode = mode;
  return { ...settings, permissions };
}

function removeLegacyApproveHook(settings, options = {}) {
  if (!legacyApproveHookActive(settings, options)) return { changed: false, settings };
  const expected = legacyApproveCommandFor(
    options.scriptPath ?? LEGACY_APPROVE_SCRIPT,
    options.platform ?? process.platform,
  );
  const hooks = { ...(settings?.hooks ?? {}) };
  const pre = (Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [])
    .flatMap((entry) => {
      // A future hook shape, a malformed entry, or a foreign scalar is not ours
      // to repair. Preserve it byte-for-byte in the object graph.
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) return [entry];
      const remaining = entry.hooks.filter((hook) => hook?.command !== expected);
      return remaining.length ? [{ ...entry, hooks: remaining }] : [];
    });
  if (pre.length) hooks.PreToolUse = pre;
  else delete hooks.PreToolUse;
  return { changed: true, settings: { ...settings, hooks } };
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function removeLegacyClaudeMax(settings, options = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const statePath = options.statePath ?? LEGACY_CLAUDE_STATE_FILE;
  const state = readClaudeState(statePath);
  const before = legacyClaudeMaxStatus(source, options);
  if (!before.present) {
    return {
      changed: false,
      settings: source,
      ...before,
      removedAllow: [],
      warnings: [],
      canRemoveArtifacts: state.valid,
    };
  }

  let next = source;
  let changed = false;
  const warnings = [];
  let removedAllow = [];

  // The hook can be the only surviving layer after a partial/manual edit. Its
  // valid snapshot still has to restore specific grants that the blanket pass
  // pruned, even when every generated blanket has already disappeared.
  if (before.hook || before.allow || before.generatedAllow.length) {
    // A hook with the exact command the old release generated is strong
    // ownership evidence. A valid snapshot without that hook is only a
    // candidate because old releases retained snapshots after MAX was off.
    const mayRestore = state.valid && (before.hook || options.confirmAmbiguous === true);
    if (!mayRestore) {
      warnings.push(state.exists
        ? 'legacy-allow-ownership-ambiguous'
        : 'legacy-allow-snapshot-missing');
    } else {
      const current = Array.isArray(source?.permissions?.allow) ? source.permissions.allow : [];
      const snapshot = state.value.allowSnapshot;
      const generated = new Set(legacyGeneratedAllow(snapshot));

      const kept = current.filter((entry) => !generated.has(entry));
      const restored = [...new Set([...snapshot, ...kept])];
      removedAllow = current.filter((entry) => !restored.includes(entry));
      if (!arraysEqual(current, restored)) {
        next = withAllow(next, restored);
        changed = true;
      }

      // MAX changed exactly one mode transition: auto -> default. Restoring a
      // null, bypass, or arbitrary saved value would apply a state MAX never
      // changed and can erase a later user choice.
      const restoreMode = state.value.defaultMode === 'auto'
        && next?.permissions?.defaultMode === 'default';
      if (restoreMode) {
        next = withMode(next, state.value.defaultMode);
        changed = true;
      }
    }
  }

  const hookResult = removeLegacyApproveHook(next, options);
  if (hookResult.changed) {
    next = hookResult.settings;
    changed = true;
  } else if (before.hookLike && !before.hook) {
    warnings.push('legacy-hook-ownership-ambiguous');
  }

  const after = legacyClaudeMaxStatus(next, options);
  return {
    changed,
    settings: next,
    ...after,
    removedAllow,
    warnings: [...new Set(warnings)],
    canRemoveArtifacts: !after.present && state.valid,
  };
}

function topLevelBound(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (TOP_LEVEL_TABLE.test(lines[index])) return index;
  }
  return lines.length;
}

function findApprovalLine(lines) {
  const bound = topLevelBound(lines);
  for (let index = 0; index < bound; index += 1) {
    if (APPROVAL_LINE.test(lines[index])) return index;
  }
  return -1;
}

function approvalScalar(line) {
  const match = /^[ \t]*approval_policy[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)')[ \t]*(?:#.*)?$/.exec(line);
  return match ? (match[1] ?? match[2] ?? '').trim() : null;
}

function legacyCodexMaxStatus(text, options = {}) {
  const statePath = options.statePath ?? LEGACY_CODEX_STATE_FILE;
  const lines = String(text || '').split(/\r?\n/);
  const at = findApprovalLine(lines);
  const approval = at === -1 ? null : approvalScalar(lines[at]);
  const state = readCodexState(statePath);
  const present = approval === 'never';
  return {
    present,
    approval,
    snapshotExists: state.exists,
    snapshotValid: state.valid,
    savedApproval: state.valid ? state.value.priorApproval : undefined,
    candidate: present && state.valid,
    ambiguous: present && !state.valid,
  };
}

function removeLegacyCodexMax(text, options = {}) {
  const source = String(text || '');
  const statePath = options.statePath ?? LEGACY_CODEX_STATE_FILE;
  const state = readCodexState(statePath);
  const before = legacyCodexMaxStatus(source, { statePath });
  if (!before.present) {
    return { changed: false, text: source, ...before, restoredTo: null, warnings: [] };
  }
  if (!state.valid || options.confirmAmbiguous !== true) {
    return {
      changed: false,
      text: source,
      ...before,
      restoredTo: null,
      warnings: [state.valid ? 'legacy-codex-ownership-confirmation-required' : 'legacy-codex-snapshot-missing'],
    };
  }

  const eol = /\r\n/.test(source) ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const at = findApprovalLine(lines);
  const prior = state.value.priorApproval;
  const warnings = [];
  let restoredTo = null;

  if (prior === 'on-request') {
    lines[at] = 'approval_policy = "on-request"';
    restoredTo = 'on-request';
  } else {
    lines.splice(at, 1);
    if (prior !== null) warnings.push(`legacy-prior-approval-not-restored:${String(prior)}`);
  }

  return {
    changed: true,
    text: lines.join(eol),
    present: false,
    approval: restoredTo,
    snapshotExists: true,
    snapshotValid: true,
    candidate: false,
    ambiguous: false,
    restoredTo,
    warnings,
  };
}

function removeLegacyApproveScript(scriptPath = LEGACY_APPROVE_SCRIPT) {
  let source;
  try { source = fs.readFileSync(scriptPath, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return { removed: false, reason: 'absent' };
    throw error;
  }
  const digest = crypto.createHash('sha256').update(source).digest('hex');
  if (digest !== LEGACY_SCRIPT_SHA256) {
    return { removed: false, reason: 'ownership-ambiguous' };
  }
  fs.unlinkSync(scriptPath);
  return { removed: true, reason: null };
}

function removeLegacyStateFile(statePath) {
  try {
    fs.unlinkSync(statePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

// Eight helpers of the retired MAX feature came off this list on 2026-09-25 and
// stayed in the file — LEGACY_ALLOW_MARKERS, LEGACY_APPROVE_MARKER,
// LEGACY_APPROVE_SCRIPT, detectMcpServers, legacyAllowActive,
// legacyApproveHookActive, legacyApproveHookLike and topLevelBound. Each is
// called only from inside this module, and each is already falsifiable through
// the surface that remains: breaking them one at a time killed between one and
// four tests apiece, so no coverage left with the export.
module.exports = {
  CODEX_CONFIG,
  LEGACY_CLAUDE_STATE_FILE,
  LEGACY_CODEX_STATE_FILE,
  LEGACY_ALLOW_CORE,
  legacyGeneratedAllow,
  legacyGeneratedAllowFromState,
  withoutLegacyGeneratedBackup,
  legacyApproveCommandFor,
  legacyClaudeMaxStatus,
  removeLegacyClaudeMax,
  legacyCodexMaxStatus,
  removeLegacyCodexMax,
  removeLegacyApproveScript,
  removeLegacyStateFile,
};
