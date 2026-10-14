'use strict';

const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const https  = require('https');
const { execFile } = require('child_process');
const { createAutoLearnWorkerRunner } = require('./autoLearnWorkerRunner');

// Share core logic with the hook variant — permissions.js is copied into
// src/ by scripts/package.mjs so both modes stay in sync from a single source.
const {
  processAllowList, writeFileAtomicSync,
} = require('./src/permissions');
const { createAutoLearnManager } = require('./src/auto-learn-manager');
const { resolveCodexHome } = require('./src/codex-paths');
const {
  createPolicyLock, POLICY_LOCK_CODE, POLICY_LOCK_PATH, POLICY_LOCK_BUSY_MESSAGE,
} = require('./src/policy-lock');
const {
  readEnterpriseBundle, allowedApprovalPolicies, enterprisePolicyAssessment,
  codexRuleFileSet, refreshProjectTrust, abandonProjectTrustRefreshes,
} = require('./src/codex-policy');
const {
  CODEX_CONFIG, LEGACY_CLAUDE_STATE_FILE, LEGACY_CODEX_STATE_FILE,
  legacyClaudeMaxStatus, removeLegacyClaudeMax,
  legacyCodexMaxStatus, removeLegacyCodexMax, removeLegacyApproveScript,
  removeLegacyStateFile, legacyGeneratedAllowFromState, withoutLegacyGeneratedBackup,
} = require('./src/legacy-max-cleanup');
const { purgeLegacyBackupCopies } = require('./src/legacy-backup-cleanup');
const {
  managedSettingsPaths, policySignalPaths, policyLimitsPath, policyRestrictions, assessPolicy,
} = require('./src/policy-guard');
const { extractInvocations, candidateKey } = require('./src/auto-learn');
const { commandLaunch, endProcessTree } = require('./src/exec-resolve');
const { dashboardCodexVersion, abandonCodexVersionProbes } = require('./src/codex-version');
const { recallIndexCount, recallIndexStatus } = require('./src/recall-index');
const { codexFeatureStatus, createCodexFeaturesUi } = require('./codexFeaturesUi');
const { CodexMemoryLint } = require('./codexMemoryLint');
const { createCodexMemoryGatesUi } = require('./codexMemoryGatesUi');
const { createPermissionActions } = require('./permissionActions');
const { readCodexPermissionSummary, deadShellApprovals, overBroadShellGrants } = require('./src/permission-summary');
const { drainLocalSettings, localSettingsPath, LOCAL_RELATIVE } = require('./src/local-settings');
const { guidanceStatusAll, setGuidanceAll } = require('./src/agent-guidance');
const { gatesStatusAll, setGatesAll, readCompiled, compiledPath } = require('./src/agent-gates');
const {
  applicationSummary, backupPruneSuffix, candidatePendingTargets, claudeDecisionExplanation,
  claudePermissionDecision, codexCheckVariants, codexExecpolicyArgs, codexRestartSuffix,
  codexInventoryItems, codexInventoryDetail, codexRemovalExplanation, codexRemovalNote,
  derivedGuidanceItems, derivedGuidanceSummary,
  isCandidateComplete, managedBlockedDetail, managedBlockedNote, managedPromptExplanation,
  policyTargetLabel, reviewableCandidates, selectionsNeedingConfirmation,
  uniqueTargets,
} = require('./autoLearnUi');

// Ambient memory-index hygiene lint (self-contained; pure Node, no Python/model/hook).
// memoryReport() also backs the dashboard Memory card (stats only, still pure Node).
// cfg is aliased: `cfg` is already a local name in six places in this file, and a
// module-scope binding shadowed by six locals meaning something else is a footgun.
const { MemoryLint, memoryReport, discoverDirs, cfg: memoryConf } = require('./memoryLint');

const SETTINGS      = path.join(os.homedir(), '.claude', 'settings.json');
const BACKUP_DIR    = path.join(os.homedir(), '.claude', 'backups');
const LATEST_BACKUP = path.join(BACKUP_DIR, 'allow-list.latest.json');
// The primary backup above lives INSIDE the directory it exists to survive the
// reset of, which is fine for the failure it was written for (an org policy
// rewriting settings.json in place) and useless for the one observed
// 2026-09-09, when every directory under ~/.claude was recreated — `backups/`
// went with it, and the allow list came back only because this extension was
// still running and held it in memory. So mirror off-tree, outside ~/.claude.
// Default is homedir-derived to stay portable (and hermetic under a mocked
// home); point the setting at another volume to survive more than a reset.
const MIRROR_BACKUP_DEFAULT = path.join(os.homedir(), '.permission-wildcarding', 'allow-list.latest.json');
const PROJECTS_DIR  = path.join(os.homedir(), '.claude', 'projects');
const CODEX_HOME_DIR = resolveCodexHome();
const CODEX_SESSIONS_DIR = path.join(CODEX_HOME_DIR, 'sessions');
// Codex WORKSPACE scope is withdrawn; see the note in autoLearnConfig() and
// docs/codex-compatibility.md. Held as a constant because the dashboard card,
// the scope warning and the settings description must all say the same thing.
const WORKSPACE_SCOPE_WITHDRAWN_NOTE =
  'Codex workspace scope is withdrawn: its trust model could not be stated, because VS Code ' +
  'workspace trust, this setting and Codex\'s own project trust are three different decisions ' +
  'and only the last one governs whether Codex loads a workspace rule file. Codex rule export ' +
  'is OFF while this setting says "workspace". Set it to "user" or "off". To remove rules an ' +
  'older release wrote into a repository, run: wildcard-perms --codex-workspace-rules remove';
// Auto Learn, this wildcarding pass, the legacy cleanup, and the CLI bypass
// toggle are all writers of one settings.json. They take the same lock
// (POLICY_LOCK_PATH, defined once in src/policy-lock.js) so none can land
// between another's writes.

let debounceTimer = null;
// One channel for the extension's lifetime, disposed with it. Three sites used
// to create one PER INVOCATION and never dispose it, and one of those is a
// palette command with no call limit, so the Output dropdown filled with
// duplicate "Acolyte" entries and each retained its backing
// document. memoryLint.js already had the right pattern: create in activate,
// register as a subscription.
let outputChannel = null;
let recallSyncTimer = null;  // the deferred staleness check, so deactivate can cancel it
let policyLock = null;      // shared with Auto Learn; created on first write
let lockedRetries = 0;      // consecutive deferrals while Auto Learn holds it
let dashboard = null;        // WildcardingViewProvider instance
let lastRun = null;          // timestamp of the last write we made
let memBounce = null;        // debounce for MEMORY.md-driven dashboard refreshes
let gatesBounce = null;      // debounce for corpus-driven gate recompiles
let recallRebuildAt = 0;     // timestamp of the last auto-rebuild (cooldown gate)
let autoLearnBounce = null;  // debounce for Claude/Codex transcript writes
let autoLearnTimer = null;   // periodic reconciliation timer
let autoLearnBusy = false;
let autoLearnLastError = null;
let autoLearnFailureCount = 0;
let autoLearnNextRetryAt = 0;
let autoLearnManager = null;
let autoLearnManagerKey = '';
let autoLearnCardCache = null;  // { key, data }; key includes the state file stamp
let autoLearnWorkerRunner = null;
let policyBounce = null;        // debounce for policy-signal / settings-change guard runs
let localDrainBounce = null;    // debounce for settings.local.json writes
let localDrainRetries = 0;      // consecutive deferrals while settings.json was unreadable
let dashboardBounce = null;     // debounce for dashboard pushes (see refresh())

// ── deactivation ──────────────────────────────────────────────────────────────
// Set by deactivate(), cleared by activate(). Clearing a timer stops a spawn
// STARTING; it says nothing about work already in flight, and deactivate had no
// way to ask. Every async continuation below that would touch the dashboard,
// spawn a child or write a file checks this one flag instead of each growing its
// own cancellation story.
//
// The worst case was the gate compile: its callback chains into ensureGates() →
// setGatesAll(), so a compile that started before a reload rewrote the user's
// CLAUDE.md / AGENTS.md from a torn-down extension host.
// The memory linter instance. Module-scoped so onDidChangeConfiguration can
// reach it; see the memory branch of the listener.
let memoryLint = null;
let codexMemoryLint = null;
let codexMemoryReport = null;
let codexMemoryGatesUi = null;
let codexFeatureUi = null;
let deactivated = false;
// Bumped by every activate(). deactivate() captures it before awaiting the Auto
// Learn drain so a continuation that resumes after a same-realm re-activate can
// tell it is no longer the current generation. See the tail of deactivate().
let activationGeneration = 0;

// The children themselves. execFile returns a ChildProcess and not one of the
// four call sites retained it, so deactivate could only ever hope they were
// finished — including the 180s recall rebuilds.
const liveChildren = new Set();

function trackChild(child) {
  if (!child || typeof child.on !== 'function') return child;
  liveChildren.add(child);
  const forget = () => liveChildren.delete(child);
  // Both, because a spawn failure emits 'error' and never 'close'.
  child.on('close', forget);
  child.on('error', forget);
  return child;
}

// The whole TREE under each child, not the child alone (2026-10-14). On Windows
// child.kill() ends one PID, and the children here are routinely not the program
// that matters: an npm `codex.cmd` runs as cmd.exe -> node, and the Codex trust
// worker is node -> (cmd.exe ->) codex. Measured: deactivate's child.kill() on a
// trust worker whose stand-in codex never answered left that codex running,
// orphaned, after the extension was gone. endProcessTree (src/exec-resolve.js)
// runs taskkill /T /F, then child.kill(); on POSIX it signals the group of a child
// that leads one (the trust worker, spawned detached for this). Returns a promise
// for the reaping, which deactivate awaits, bounded, after dropping its retainers.
function killLiveChildren() {
  const reaped = [...liveChildren].map((child) => endProcessTree(child));
  liveChildren.clear();
  return Promise.all(reaped);
}

// ── settings.json helpers ─────────────────────────────────────────────────────
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch {
    return null; // missing or mid-write
  }
}

// The state constants, the "why is there no value" read, and the rebasing writer
// all moved to src/settings-write.js so the CLI — whose hook is the highest-
// frequency writer of this file — uses the same one instead of a naive spread.
// Re-exported as locals; SETTINGS_ABSENT, read nowhere in this file, dropped 2026-10-14.
const {
  createSettingsWriter,
  SETTINGS_PRESENT, SETTINGS_UNREADABLE, SETTINGS_UNREADABLE_CODE,
} = require('./src/settings-write');

// backupPolicy is INJECTED rather than imported by the writer: it reaches
// vscode.workspace.getConfiguration for the off-tree mirror path, and src/ has to
// stay loadable from a bare Node process. Declared lazily because backupPolicy is
// defined below this point.
const settingsWriter = createSettingsWriter({
  settingsPath: SETTINGS,
  onWrite: (allow, deny) => backupPolicy(allow, deny),
});

const readSettingsState = () => settingsWriter.readSettingsState();
const writeAllow = (settings, allow, denyAdditions) =>
  settingsWriter.writeAllow(settings, allow, denyAdditions);

// ── policy backup / restore ─────────────────────────────────────────────────────
// A managed-settings refresh (e.g. an org policy with allowManagedHooksOnly) can
// reset settings.json and wipe accumulated wildcards. This keeps a copy of the
// allow list *and* the deny list in ~/.claude/backups so a reset is recoverable.
//
// Both halves matter. deny is the safety boundary bypass mode and auto-safe
// defer to, so restoring allow alone would hand back every permission with
// the killswitch still off, which is strictly worse than not restoring at all.
//
// It's a high-water mark: the backup only grows. A reset that *shrinks* the live
// lists never clobbers a fuller backup, so restore always has the complete set.
// For deny that direction is also the fail-closed one: a rule deliberately
// deleted can reappear on an explicit restore, which is noisy but never unsafe.
//
// On-disk shape is { allow, deny }. A bare array is the pre-1.12 allow-only
// backup and is still read, so an existing file upgrades in place on first write.
//
// Read late rather than at module load: a settings change must not need a window reload to
// take effect, and a config read at require time runs before the mocked workspace exists in
// tests. USER settings only (machine-scoped, F7, 2026-10-14): a workspace must not choose where
// the allow and deny lists are copied. Unset or blank is the default; `~` is expanded.
function mirrorBackupPath() {
  let configured;
  try {
    configured = vscode.workspace.getConfiguration('permissionWildcarding')
      .inspect('backupMirrorPath')?.globalValue ?? ''; // as codexExecutableSetting reads its key
  } catch { configured = ''; }
  if (typeof configured !== 'string' || !configured.trim()) return MIRROR_BACKUP_DEFAULT;
  const raw = configured.trim();
  if (!raw.startsWith('~')) return raw;
  const rest = raw.slice(1).replace(/^[\\/]+/, '');
  // `~`, `~/` and `~\` name the home DIRECTORY, and path.join(home, '') is that
  // directory. This setting names a FILE, so the mirror write then failed EISDIR
  // into writeBackupCopies' best-effort catch and the off-tree copy silently
  // stopped existing — the one copy that survives losing all of ~/.claude, which
  // is not hypothetical here (2026-09-09). Every other `~`-prefixed value was
  // already handled; this was the one that resolved to a directory.
  if (!rest) {
    warnOnce(`ai-acolyte: backupMirrorPath "${raw}" is the home directory, not a `
      + `file — using the default ${MIRROR_BACKUP_DEFAULT}`);
    return MIRROR_BACKUP_DEFAULT;
  }
  return path.join(os.homedir(), rest);
}

// console.error is the house channel for "this ran degraded", but this one is on
// the path of every policy write, so saying it on every write would be noise the
// user learns to scroll past. Once per distinct message, per activation.
const warnedOnce = new Set();

function warnOnce(message) {
  if (warnedOnce.has(message)) return;
  warnedOnce.add(message);
  console.error(message);
}

function readOneBackup(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
  if (Array.isArray(raw)) return { allow: raw, deny: [] };
  if (!raw || typeof raw !== 'object') return null;
  return {
    allow: Array.isArray(raw.allow) ? raw.allow : [],
    deny: Array.isArray(raw.deny) ? raw.deny : [],
  };
}

// Primary first, mirror only as a FALLBACK — deliberately not a union. Unioning
// the two copies would resurrect a deliberate prune whenever one of them lagged,
// which is the single failure `forgetFromBackup` exists to prevent. The mirror
// therefore only speaks when the primary is gone or unparseable, which is
// exactly the recovery case it was added for.
function readBackupRaw() {
  return readOneBackup(LATEST_BACKUP) ?? readOneBackup(mirrorBackupPath());
}

// While a migration snapshot remains, never offer its exactly-known generated
// MAX entries to the policy guard or manual restore. The physical copies are
// retained until a confirmed cleanup verifies both writes, so a failed purge
// cannot destroy the only ownership record and a stale backup cannot resurrect
// the retired grants in the meantime.
function readBackup() {
  return withoutLegacyGeneratedBackup(readBackupRaw());
}

// Atomic per file via temp + rename. The mirror is best-effort and written
// second: it must never cost the primary write, which is the copy every other
// code path reads first.
function writeBackupCopies(payload) {
  // writeFileAtomicSync, not a hand-rolled `target + '.tmp'`. That shared name
  // is exactly the collision src/permissions.js:30-31#Unique exists to prevent —
  // "Unique per-writer temp name so the hook and the VS Code extension (or two
  // extension hosts) never collide on one shared *.wc.tmp" — and this file has
  // seen four extension copies running at once. Two hosts racing on one .tmp can
  // rename a half-written file into place, and because both copies used the same
  // scheme one race corrupted the primary AND the mirror together: readBackup()
  // then fails to parse both, `previous` collapses to empty, and the high-water
  // mark silently resets to whatever the live list happens to be at that
  // instant. If that instant is mid-policy-wipe, the only recovery data for the
  // 2026-09-09 class of event is destroyed by the thing meant to preserve it.
  const write = (target) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomicSync(target, payload);
  };
  // Attempted independently rather than in sequence. The mirror's whole purpose
  // is surviving the loss of the primary's directory, so a primary failure is
  // the case where the mirror matters most — it must not be skipped by it.
  let primaryError;
  try { write(LATEST_BACKUP); } catch (error) { primaryError = error; }
  try { write(mirrorBackupPath()); } catch { /* off-tree copy is best-effort */ }
  // Rethrown for the caller's own best-effort catch, so behaviour on a failed
  // primary write is unchanged from before the mirror existed.
  if (primaryError) throw primaryError;
}

function backupPolicy(allow, deny) {
  try {
    const nextAllow = Array.isArray(allow) ? allow : [];
    const nextDeny = Array.isArray(deny) ? deny : [];
    if (!nextAllow.length && !nextDeny.length) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const previous = readBackupRaw() ?? { allow: [], deny: [] };
    // Union rather than comparing only lengths: a same-sized settings refresh
    // can replace one wildcard with another and must not silently drop either.
    const merged = {
      allow: [...new Set([...previous.allow, ...nextAllow])],
      deny: [...new Set([...previous.deny, ...nextDeny])],
    };
    if (JSON.stringify(previous) === JSON.stringify(merged)) return;
    writeBackupCopies(JSON.stringify(merged, null, 2) + '\n');
  } catch { /* best-effort — never block the main write */ }
}

function backupCount() {
  const backup = readBackup();
  return backup ? backup.allow.length + backup.deny.length : 0;
}

// The one way an entry leaves the high-water mark: the user said to remove it.
// Without this the backup would resurrect every deliberate prune, and the policy
// guard would read the user's own edit as damage.
//
// TWO LISTS, NAMED SEPARATELY, and the signature is the fix rather than a tidy-up.
// This took `(permissions, kind = 'both')`, both call sites passed one argument,
// and the caller that used `kind` went with MAX — so the parameter was dead and
// 'both' was the only behaviour anyone got. Not cosmetic: the managed-policy
// continuation handed it `[...missing.allow, ...missing.deny]` as one flat list
// and 'both' then stripped every string in it from BOTH lists, so a permission
// that was missing from the live ALLOW list and also sat in the backup's DENY
// list was silently forgotten from deny as well. Losing a killswitch entry from
// the only copy of it is the unrecoverable direction.
//
// A `kind` flag would have fixed that and left the same shape of mistake one
// typo away. Taking the two lists by name cannot be got wrong, and it is one
// write rather than two.
function forgetFromBackup({ allow = [], deny = [] } = {}) {
  const dropAllow = new Set(Array.isArray(allow) ? allow : [allow]);
  const dropDeny = new Set(Array.isArray(deny) ? deny : [deny]);
  const backup = readBackupRaw();
  if (!backup) return;
  const next = {
    allow: backup.allow.filter((entry) => !dropAllow.has(entry)),
    deny: backup.deny.filter((entry) => !dropDeny.has(entry)),
  };
  if (next.allow.length === backup.allow.length && next.deny.length === backup.deny.length) return;
  try {
    // Both copies, or the next restore reads the mirror and hands the pruned
    // entry straight back.
    writeBackupCopies(JSON.stringify(next, null, 2) + '\n');
  } catch { /* best-effort — never block the removal itself */ }
}

// ── policy guard ────────────────────────────────────────────────────────────────
// The point of the backup is the day managed policy lands. Two different things
// happen to prior approvals then, and only one is recoverable:
//
//   missing  — the refresh reset settings.json. The backup has them; re-assert.
//   shadowed — managed deny/ask outranks a user allow entry. Nothing user-side
//              beats that, so it is reported and never re-written. Fighting it
//              is exactly how this becomes a write loop against the policy.
//
// Only `missing` triggers a write, and only when there is something to restore,
// so a policy change that took nothing away produces no write at all.
function readManagedSettings() {
  for (const candidate of managedSettingsPaths()) {
    try { return { path: candidate, settings: JSON.parse(fs.readFileSync(candidate, 'utf8')) }; }
    catch { /* absent or mid-write — try the next location */ }
  }
  return null;
}

function readPolicyLimits() {
  try { return JSON.parse(fs.readFileSync(policyLimitsPath(), 'utf8')); }
  catch { return null; }
}

// Triggered by a policy signal *and* by any settings.json change, because the
// signal that matters is "approvals stopped being there", not "a policy file
// changed". On a console-managed org there may be no managed-settings.json at
// all — restrictions are configured server-side and only ever surface locally as
// ~/.claude/policy-limits.json, or as effects with no local artefact whatsoever.
// Watching for the admin-dropped file alone is how a guard watches nothing.
function onManagedPolicyChanged() {
  const backup = readBackup();
  if (!backup) return;
  const liveState = readSettingsState();
  // Say nothing when the file could not be read. The next settings write or policy
  // event brings us straight back here, and by then it parses; guessing in the
  // meantime means guessing "all of it went missing", against a file that is
  // usually intact and mid-write.
  if (liveState.state === SETTINGS_UNREADABLE) return;
  const managed = readManagedSettings();
  const live = liveState.settings;
  const assessment = assessPolicy({
    live, backup, managed: managed?.settings, limits: readPolicyLimits(),
  });
  if (!assessment.restorable && !assessment.shadowed.length) return;

  // Only a bulk loss is repaired without asking. Removing one entry is an
  // instruction (the ✕ prune already forgets it from the backup); losing most of
  // the list is damage.
  if (!assessment.bulkLoss && assessment.restorable) {
    // Small loss: an instruction, not damage — so ask rather than auto-restore.
    // "Forget them" drops the entries from the high-water backup, which is the
    // fix for a stale backup nagging forever about entries the user pruned by
    // editing settings.json directly (the ✕ button forgets; a hand edit can't).
    const stale = [...assessment.missing.allow, ...assessment.missing.deny];
    vscode.window.showWarningMessage(
      `ai-acolyte: ${assessment.restorable} saved ${assessment.restorable === 1 ? 'entry is' : 'entries are'} missing from settings.json.`,
      'Re-assert them', 'Forget them'
    ).then((choice) => {
      // An awaited dialog resumes wherever the host happens to be, and teardown
      // is one of the places it happens to be: the notification outlives
      // deactivate(), both arms below write, and the flag is the only thing that
      // can tell them the host they belong to has gone. `restoreFromBackup`
      // merges the whole backup into settings.json and `forgetFromBackup`
      // rewrites the only copy of the high-water mark.
      if (deactivated) return;
      if (choice === 'Re-assert them') restoreFromBackup();
      else if (choice === 'Forget them') {
        // The two lists stay apart all the way down. `stale` is still the flat
        // union, but only because the count in the message below is a total.
        forgetFromBackup({ allow: assessment.missing.allow, deny: assessment.missing.deny });
        vscode.window.setStatusBarMessage(
          `$(check) ai-acolyte: forgot ${stale.length} stale ${stale.length === 1 ? 'entry' : 'entries'} from the backup`, 4000);
        dashboard?.refresh();
      }
    });
    return;
  }

  const notes = [];
  let restored = null;
  if (assessment.bulkLoss) {
    // One notification per event: the restore reports back instead of raising its
    // own toast, so the count below is what the write actually changed on disk. A
    // restore that turns out to be a no-op says nothing at all, which is the
    // second line of defence against announcing a loss that never happened.
    restored = restoreFromBackup({ announce: false });
    if (restored) {
      const count = restored.addedAllow + restored.addedDeny;
      notes.push(`re-asserted ${count} ${count === 1 ? 'entry' : 'entries'} that went missing`);
    }
  }
  if (assessment.shadowed.length) {
    // These cannot be recovered, only explained — say so rather than implying
    // the restore covered them.
    notes.push(
      `${assessment.shadowed.length} now overridden by managed rules (cannot be restored — managed policy outranks your allow list)`
    );
  }
  if (!notes.length) return;

  vscode.window.showWarningMessage(
    `ai-acolyte: policy change detected — ${notes.join('; ')}.`,
    'Show detail'
  ).then((choice) => {
    if (choice !== 'Show detail') return;
    const channel = sharedChannel({ fresh: true });
    if (!channel) return;   // the host went while this notification was up
    // Name the source honestly. On a console-managed org there is often no
    // managed-settings.json at all, and saying "managed policy: undefined" would
    // be worse than saying where the signal actually came from.
    channel.appendLine(`Managed settings file: ${managed ? managed.path : 'none on disk'}`);
    channel.appendLine(`Server-delivered restrictions (${policyLimitsPath()}):`);
    channel.appendLine(assessment.restrictions.length
      ? assessment.restrictions.map((name) => `  ${name}: not allowed`).join('\n')
      : '  none recorded');
    channel.appendLine('');
    channel.appendLine(`Re-asserted: ${restored ? restored.addedAllow + restored.addedDeny : 0} entries`);
    if (assessment.shadowed.length) {
      channel.appendLine('');
      channel.appendLine('Overridden by managed policy (not recoverable):');
      for (const entry of assessment.shadowed) {
        channel.appendLine(`  ${entry.permission} — managed ${entry.decision}: ${entry.rule}`);
      }
    }
    channel.show(true);
  });
}

// Watcher events arrive in bursts, and this pass draws a much larger conclusion
// from them than the wildcarding pass does, so it gets the same treatment: settle
// first, then look once. Measured on this machine, a single Claude Code start
// re-saved policy-limits.json four times in 40 seconds while settings.json was
// being rewritten in place, and each of those fired the guard immediately.
const POLICY_CHECK_DEBOUNCE_MS = 1500;

// The `deactivated` check belongs in the SCHEDULER, not only in the callback.
// deactivate() sets the flag and clears these timers, and then AWAITS the Auto
// Learn drain — which by deliberate decision has no deadline. Every file watcher
// is still live across that await, and a settings.json or policy-limits.json
// event arriving in it called straight through to here and re-armed a timer that
// had just been cleared. 400-1500 ms later runWildcarding() took the policy lock
// and wrote ~/.claude/settings.json, drainLocal() wrote that AND the project's
// settings.local.json, and onManagedPolicyChanged() could reach
// restoreFromBackup() — all from a torn-down extension host. drainLocal's own
// retry path re-schedules up to 20 times, which can stretch that window to a
// minute.
//
// Refusing to arm is strictly better than checking inside the callback: it also
// stops the timer existing, so nothing is left for a later teardown to clear.
function schedulePolicyCheck(delay = POLICY_CHECK_DEBOUNCE_MS) {
  if (deactivated) return;
  clearTimeout(policyBounce);
  policyBounce = setTimeout(() => {
    try { onManagedPolicyChanged(); } catch { /* a watcher must never surface a stack */ }
  }, delay);
}

// Merge the backup into the current allow and deny lists, then generalize/prune
// the allow half. Used to recover after a policy wipe — a superset merge, so it
// never removes anything.
//
// Returns what the write changed, or null when nothing was written. `announce:
// false` hands the reporting to the caller so one event cannot raise two toasts.
function restoreFromBackup(options = {}) {
  const announce = options.announce !== false;
  const backup = readBackup();
  if (!backup) {
    // Name both, or a user whose ~/.claude was reset is told the only copy is
    // missing while the off-tree one sits there unmentioned.
    vscode.window.showWarningMessage('ai-acolyte: no backup found at '
      + `${LATEST_BACKUP} or ${mirrorBackupPath()}`);
    return null;
  }
  if (!backup.allow.length && !backup.deny.length) {
    vscode.window.showWarningMessage('ai-acolyte: backup is empty — nothing to restore');
    return null;
  }

  const liveState = readSettingsState();
  // Restoring "over" a file we cannot parse would compare the backup against an
  // allow list we never read, so every entry looks missing and the merge has no
  // live half to preserve. An absent file is different: there is nothing to lose.
  if (liveState.state === SETTINGS_UNREADABLE) {
    vscode.window.showWarningMessage(
      `ai-acolyte: ${SETTINGS} could not be parsed — not restoring over it. ` +
      'Fix the file (or close whatever is writing it) and run Restore again.'
    );
    return null;
  }
  const settings = liveState.settings ?? {};
  const current  = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
  const currentDeny = Array.isArray(settings.permissions?.deny) ? settings.permissions.deny : [];
  // Cleanup removes only entries proved to belong to the retired feature from
  // the backup itself. A blanket-looking grant is otherwise user policy and
  // must survive restore.
  const merged   = processAllowList([...new Set([...current, ...backup.allow])]);
  const missingDeny = backup.deny.filter((rule) => !currentDeny.includes(rule));

  if (JSON.stringify(current) === JSON.stringify(merged) && !missingDeny.length) {
    if (announce) {
      vscode.window.setStatusBarMessage('$(history) ai-acolyte: policy already matches backup', 4000);
    }
    dashboard?.refresh();
    return null;
  }

  let written = null;
  try {
    // One atomic write carries both halves, so there is no window in which the
    // allow list is restored while its boundary is still missing.
    written = writeAllow(settings, merged, missingDeny);
    lastRun = Date.now();
    if (announce) {
      // Plain text: notification bodies do not expand codicons, so a `$(history)`
      // here reaches the user verbatim. The status-bar calls keep theirs, where
      // the substitution does happen.
      vscode.window.showInformationMessage(
        `ai-acolyte: restored from backup — +${written.addedAllow} allow ` +
        `(${written.allow.length} ${written.allow.length === 1 ? 'entry' : 'entries'} now active)` +
        (written.addedDeny
          ? `, +${written.addedDeny} deny ${written.addedDeny === 1 ? 'rule' : 'rules'}`
          : '')
      );
    }
  } catch (err) {
    vscode.window.showErrorMessage(`ai-acolyte: restore failed — ${err.message}`);
  }
  dashboard?.refresh();
  return written;
}

// ── memory card: recall (CPU LLM) status + vector-cache rebuild ─────────────────
// The dashboard Memory card surfaces what the lint doesn't: the state of recall.py's
// CPU embedder (bge-small ONNX) and the vector cache. Detection is a passive
// filesystem probe — no python is spawned until you click "Rebuild recall index".

// The toolbox venv python that carries onnxruntime + numpy (recall.py re-execs into it).
function toolboxPython() {
  const base = process.env.CODEX_TOOLBOX
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DevToolbox');
  return path.join(base, 'python', '.venv', 'Scripts', 'python.exe');
}

// Absolute path to recall.py, resolved in order:
//   1. the configured override (memory.recallScript), from USER settings only: machine-scoped (F7)
//   2. the copy bundled into the VSIX by scripts/package.mjs — the normal case for an
//      installed extension, and why a fresh install no longer needs a checkout at all
//   3. the dev layout — vscode-extension/ sits next to memory/ (running from the repo, e.g. F5)
// and nowhere else. Never an open workspace folder, so no repository can supply the script
// the extension runs: why is at the end of the function. A checkout anywhere else is named
// through the setting, which only the user tier can set.
//
// Empty string when none resolve — the rebuild button then guides the user to set it, while
// the passive status probe keeps working regardless.
function recallScriptPath() {
  const c = vscode.workspace.getConfiguration('permissionWildcarding').inspect?.('memory.recallScript')?.globalValue;
  if (typeof c === 'string' && c.trim() && fs.existsSync(c.trim())) return c.trim();

  const hit = (p) => (p && fs.existsSync(p) ? p : '');

  const bundled = hit(path.join(__dirname, 'memory', 'recall.py'));
  if (bundled) return bundled;

  const dev = hit(path.join(__dirname, '..', 'memory', 'recall.py'));
  if (dev) return dev;

  // Nothing after these two (2026-10-14, G1). Three legs used to follow, probing each open
  // workspace folder as the repo root, a projects/ dir and a .claude/ root, and then a fourth,
  // ~/.claude/projects/permission-wildcarding: the project's pre-rename name. They ran only
  // with the bundled copy missing, and then a repository's own memory/recall.py was the script
  // the extension ran, the hole F7 closed for the setting left open one layer down. The
  // caller's own "not found" path covers the rest: it offers the setting, at the user tier.
  // test/recall-script-path.test.js holds it shut, and holds the VSIX to shipping the copy.

  return '';
}

// Stable home for the 32MB model, deliberately outside both the extension dir and any
// checkout: the extension dir is replaced on every upgrade (which would mean a
// re-download per version), and a checkout can be deleted or sit in a synced OneDrive
// folder. The ~/.claude/wildcarding state dir remains stable across upgrades.
const RECALL_MODEL_HOME = path.join(os.homedir(), '.claude', 'wildcarding', 'models');
const RECALL_MODEL_FILE = 'bge-small.onnx';
const RECALL_VOCAB_FILE = 'bge-small.vocab.txt';

// Every dir that could already hold the model, most stable first. These are read
// probes: an existing copy anywhere here is used as-is and never re-downloaded.
function recallModelCandidates() {
  const script = recallScriptPath();
  return [
    process.env.RECALL_MODEL_DIR,
    RECALL_MODEL_HOME,
    script ? path.join(path.dirname(script), 'models') : '',
    path.join(__dirname, 'memory', 'models'),
    path.join(__dirname, '..', 'memory', 'models'),
    // No absolute path here, ever: this list used to end with the author's own working root.
  ].filter(Boolean);
}

// Where a *usable* bge-small lives — mirrors recall.py's own search order, and requires
// the vocab beside the model, because recall.py's Bge loads the vocab from whichever dir
// it resolved the model in. A model-only dir would resolve here and then fail at embed
// time, so it is skipped in favour of a complete one.
function recallModelDir() {
  for (const dir of recallModelCandidates()) {
    if (fs.existsSync(path.join(dir, RECALL_MODEL_FILE)) &&
        fs.existsSync(path.join(dir, RECALL_VOCAB_FILE))) return dir;
  }
  return '';
}

function codexRecallOptions() {
  const modelDir = recallModelDir();
  const recallScript = recallScriptPath();
  return { pythonExecutable: toolboxPython(),
    ...(modelDir ? { modelPath: path.join(modelDir, RECALL_MODEL_FILE) } : {}),
    ...(recallScript ? { recallScript } : {}) };
}

// A vocab to seed the model home from. Small and git-tracked, so the bundled copy is
// always available even on a machine that has never held the model.
function recallVocabSource() {
  for (const dir of recallModelCandidates()) {
    const candidate = path.join(dir, RECALL_VOCAB_FILE);
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

// Passive probe: is the CPU embedder ready to run? Green needs both the model asset
// and the venv that carries onnxruntime. Never runs python.
function recallStatus() {
  const py = toolboxPython();
  const modelDir = recallModelDir();
  const venv = fs.existsSync(py);
  const model = !!modelDir;
  const state = venv && model ? 'ready' : (!model ? 'model-missing' : 'venv-missing');
  return { py, modelDir, venv, model, state };
}

// Fetch the CPU recall model on demand into RECALL_MODEL_HOME: the same bge-small-en-v1.5 int8 ONNX asset (~32MB) that
// memory/recall.py loads. Gitignored and kept out of the VSIX (only the vocab is committed and bundled) because 32MB per release would be re-downloaded on every upgrade.
const RECALL_MODEL_URL = 'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx';
const RECALL_MODEL_MIN_BYTES = 5 * 1024 * 1024; // sanity floor — a bad URL/auth wall serves a small HTML page, not the binary

// Source is Xenova/bge-small-en-v1.5 on Hugging Face (a public repo, no token), whose /resolve/ URLs always 302 to a CDN
// host, so this follows redirects itself (Node's https doesn't). It returns the HANDLE, not the req, because every hop
// builds a fresh req: a Cancel aimed at the one the caller was handed destroyed a socket that had already finished
// redirecting while the 32MB body ran to completion, and between a 3xx and the next hop there is no live req at all.
function httpsGetFollow(url, onResponse, redirectsLeft = 5, handle = { req: null, cancelled: false, destroy(err) { handle.cancelled = true; handle.req?.destroy(err); } }) {
  const req = handle.req = https.get(url, { headers: { 'User-Agent': 'permission-wildcarding' } }, (res) => {
    const loc = res.headers.location;
    if (loc && res.statusCode >= 300 && res.statusCode < 400) {
      res.resume(); // drain so the socket can be reused
      if (redirectsLeft <= 0) { onResponse(null, new Error('too many redirects')); return; }
      if (!handle.cancelled) httpsGetFollow(new URL(loc, url).toString(), onResponse, redirectsLeft - 1, handle);
      return;
    }
    onResponse(res, null);
  });
  req.on('error', (err) => onResponse(null, err));
  req.setTimeout(30000, () => req.destroy(new Error('timed out')));
  return handle;
}

// Every in-flight model download, the way `liveChildren` holds every in-flight
// execFile child. It needs its own set because it is not one: `liveChildren`
// holds ChildProcess handles, and a 32MB https transfer is a request handle, a
// response stream and a write stream, all three of them closure-local. That made
// it the single in-flight job deactivate() could not cancel — the reload killed
// four python children and then let a 32MB download run to completion and
// renameSync into ~/.claude from a torn-down host.
const liveTransfers = new Set();

function abortLiveTransfers() {
  for (const transfer of [...liveTransfers]) {
    try { transfer.destroy(new Error('extension deactivated')); } catch { /* already gone */ }
  }
  liveTransfers.clear();
}

// The rename codes a momentary holder produces, and how long the publish step
// waits one out. On Windows a rename is refused while anything holds a handle
// in its way, and Defender and the indexer open a file milliseconds after it is
// written; a 32MB file closed a moment ago is exactly what they open. Measured
// 2026-10-13 on the development box (Node 24.19.0): a holder with the .tmp open
// and not sharing delete makes this rename fail EBUSY, and the same rename
// lands once it lets go (held 400 ms: 16 refusals at 20 ms spacing, then it
// landed); an open handle on an existing destination makes it fail EPERM
// (597b4f7). Every other writer here already retried its rename
// (writeFileAtomicSync, atomicWrite, strictWrite). This one failed the whole
// download on the first refusal and threw the 32MB away with it.
// Ten attempts, 20, 40, ... 180 ms apart: 0.9 s at most, the budget those use.
const { RETRYABLE_RENAME_CODES: MODEL_RENAME_HELD } = require('./src/permissions'); // the one shared set, ETXTBSY included (2026-10-14)
const MODEL_RENAME_ATTEMPTS = 10;

// Since 7e43af2 a download writes `<dest>.<pid>.<12hex>.tmp`. deactivate() unlinks an
// in-flight one, but a host KILLED outright (a crash, a kill -9, the machine losing power)
// cannot, so its partial stays under a name no later download reuses, forever; and a build
// before 7e43af2 wrote a fixed `bge-small.onnx.tmp` that nothing cleans either. At the start
// of each download, sweep those: any `<dest>.*.tmp` (the per-writer scheme and the legacy
// fixed name both begin `bge-small.onnx.` and end `.tmp`) whose mtime is older than
// MODEL_TMP_STALE_MS, except the name THIS download is about to write. A NEWER temp is left
// alone — RECALL_MODEL_HOME is one directory for every window, so a fresh one may be another
// window's live transfer, the very file a blind sweep would destroy (the reason 7e43af2 added
// none). A day is generous past any real transfer: each https hop times out at 30 s and a
// ~32MB body finishes in minutes even on a slow link, so a tmp a day old is abandoned, never
// in flight. Best-effort: a directory that cannot be listed, or a file another process removes
// first, is not a reason to fail the download. Measured 2026-10-13.
const MODEL_TMP_STALE_MS = 24 * 60 * 60 * 1000;
function sweepStaleModelTemps(modelDir, ownTmp, now = Date.now()) {
  const prefix = `${RECALL_MODEL_FILE}.`;
  let entries;
  try { entries = fs.readdirSync(modelDir); } catch { return; }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const full = path.join(modelDir, name);
    if (full === ownTmp) continue;                 // our own in-flight download, never ours to sweep
    try {
      if (now - fs.statSync(full).mtimeMs > MODEL_TMP_STALE_MS) fs.unlinkSync(full);
    } catch { /* vanished under us, or unreadable: leave it */ }
  }
}

// Downloads to a temp file beside `<dest>` and renames on success so a cancelled/failed
// run never leaves a half-written bge-small.onnx that would falsely read as "model present".
function downloadRecallModel() {
  const modelDir = RECALL_MODEL_HOME;
  const dest = path.join(modelDir, RECALL_MODEL_FILE);
  // Unique per download, `<dest>.<pid>.<random>.tmp`, the scheme every other writer here
  // uses (src/permissions.js writeFileAtomicSync, the manager's atomicWrite). Until
  // 2026-10-13 it was the fixed `<dest>.tmp`, and RECALL_MODEL_HOME is one directory for
  // every VS Code window (and for two downloads in one window, which rebuildRecall does
  // not prevent): two downloads at once opened one file for writing twice, and the first
  // to fail unlinked the other's partial file, so its publish renamed nothing or a file
  // both had written into. Cleanup is unchanged: `fail` unlinks this download's own name,
  // and nothing else. A download killed with its host (not deactivated, which unlinks) leaves
  // its partial under a name no later download reuses; a day later the next download reaps it
  // (sweepStaleModelTemps above), so the per-writer name no longer trades the fixed name's
  // self-overwrite for an unbounded pile of abandoned partials.
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  // Which activation owns this download (2026-10-14). `deactivated` alone is not
  // enough after a FAST same-realm re-activate: activate() clears it, so a retry
  // timer armed by the old host (MODEL_RENAME_HELD) that fires afterwards sees a
  // live host. Measured with the lifecycle harness: the rename was still stopped,
  // but only by the transfer's `cancelled` flag that deactivate's abort sets, and
  // the failure toast ("download failed — cancelled") landed in the successor's
  // window. publish and fail now both ask whether this activation is still the
  // current one, so neither depends on the transfer having been registered when
  // the host went. Read here, before any await, like every other generation check.
  const generation = activationGeneration;
  const vocabSource = recallVocabSource();
  const vocabTarget = path.join(modelDir, RECALL_VOCAB_FILE);

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ai-acolyte: downloading recall model (bge-small, ~32MB)…', cancellable: true },
    (progress, token) => new Promise((resolve) => {
      // The same guard every execFile callback carries, and the only one of the
      // extension's long jobs that did not have it. Refusing to START is
      // strictly better than cancelling later: nothing opens a socket, nothing
      // writes a .tmp, and there is nothing for teardown to clean up.
      if (deactivated) { resolve(false); return; }
      fs.mkdirSync(modelDir, { recursive: true });
      // Reap partials abandoned by an earlier killed host (sweepStaleModelTemps above); never
      // this download's own name, and never one young enough to be a live transfer.
      sweepStaleModelTemps(modelDir, tmp);

      // Seed the vocab first: the model cannot load without it, and failing before a
      // 32MB transfer is friendlier than failing after one.
      if (!fs.existsSync(vocabTarget)) {
        if (!vocabSource) {
          vscode.window.showErrorMessage(
            `ai-acolyte: ${RECALL_VOCAB_FILE} not found — cannot set up the recall model.`);
          resolve(false); return;
        }
        try { fs.copyFileSync(vocabSource, vocabTarget); }
        catch (err) {
          vscode.window.showErrorMessage(
            `ai-acolyte: could not copy ${RECALL_VOCAB_FILE} — ${err.message}`);
          resolve(false); return;
        }
      }

      const out = fs.createWriteStream(tmp);
      let received = 0, total = 0, reported = 0, transfer = null;   // the redirect-following handle, not one request
      // ONE settlement, whichever of the nine call sites gets here first: the
      // eight `fail` calls and publish's success. Five `fail` calls are in the
      // transfer, across four independent channels (the follower's callback,
      // for its error and a non-200; the response stream; the short-file check
      // in the write stream's close callback; the write stream's error), and
      // three are in the publish step, which runs in that close callback or a
      // retry timer (teardown, a Cancel between attempts, and a rename error that
      // is not retried or has run out of attempts). One destroyed socket fires several of
      // them. Unguarded that showed the user two error toasts for one failure,
      // unlinked the .tmp twice, and called resolve() on an already-settled
      // promise, which is silent and hides the double-report. Recounted
      // 2026-10-13: this said six and five. It left out the rename step's own
      // two exits from the day it was written (05d5bc4 had seven `fail` calls
      // and the success), and b4271f3 added the Cancel check between attempts.
      let settled = false;

      const claim = () => {
        if (settled) return false;
        settled = true;
        if (transfer) liveTransfers.delete(transfer);
        return true;
      };

      const fail = (err) => {
        if (!claim()) return;
        // Silent when the host is going down: a toast raised from a torn-down
        // extension either lands on the successor's window or on nothing, and
        // "the download you did not cancel failed" is not a thing to tell
        // somebody who just reloaded. The cleanup still runs. A predecessor's
        // download is silent in the successor's window for the same reason.
        if (!deactivated && generation === activationGeneration) {
          vscode.window.showErrorMessage(`ai-acolyte: recall model download failed — ${err.message || err}`);
        }
        // Unlink INSIDE close()'s callback and resolve only after it: close() is async, so
        // unlinking beside it raced the open handle, which on Windows is a swallowed EPERM.
        out.close(() => { try { fs.unlinkSync(tmp); } catch { /* already gone */ } resolve(false); });
      };

      // The publish step: the one rename that makes the model real, retried
      // while a holder refuses it (MODEL_RENAME_HELD has why and the numbers).
      // On TIMERS, not Atomics.wait: this runs on the extension-host thread, and
      // a synchronous wait there freezes every extension in the window, which is
      // why writeFileAtomicSync's own comment counts its wait as a cost. Still
      // never an in-place write: the destination is absent or a whole file, and
      // when the attempts run out it fails exactly as a single refusal did, the
      // .tmp unlinked by `fail`. No re-read of the destination between attempts,
      // which strictWrite needs because its target is someone's AGENTS.md: this
      // one is the extension's own copy of a public asset in its own model
      // home, and this rename is its only writer.
      //
      // What a wait must not outlast is the download itself. So every attempt
      // first re-checks what can have ended it meanwhile: another channel
      // already settled it (its cleanup is unlinking the .tmp, and a rename now
      // would publish a file whose failure was already reported), the host was
      // torn down, or, on a retry, the user pressed Cancel. A Cancel does not
      // reach `fail` by itself at this point: the request has finished, and
      // destroying a finished request emits nothing, so the handle's sticky
      // `cancelled` flag is read instead.
      const publish = (attempt) => {
        if (settled) return;
        // A reload that landed during the transfer must not be finished off
        // by its own completion. This is the last moment before the file
        // becomes real, and renaming it here would publish a model into
        // ~/.claude on behalf of a host that no longer exists, including one a
        // fast re-activate has already replaced (`generation` above).
        if (deactivated || generation !== activationGeneration) { fail(new Error('extension deactivated')); return; }
        if (attempt > 1 && transfer?.cancelled) { fail(new Error('cancelled')); return; }
        // try/catch, because this runs inside out.close()'s callback or a timer
        // — long after the Promise executor returned. A throw here is not a
        // rejection, it is an UNCAUGHT exception, and the promise it was
        // supposed to settle stays pending, so the progress notification
        // spins for the life of the window. EXDEV (tmp and dest on
        // different volumes, which RECALL_MODEL_DIR can arrange) and EPERM
        // from an antivirus scanner both reach it.
        try { fs.renameSync(tmp, dest); }
        catch (renameError) {
          if (MODEL_RENAME_HELD.has(renameError.code) && attempt < MODEL_RENAME_ATTEMPTS) {
            setTimeout(publish, 20 * attempt, attempt + 1);
            return;
          }
          fail(renameError); return;
        }
        if (!claim()) return;
        resolve(true);
      };

      token.onCancellationRequested(() => transfer?.destroy(new Error('cancelled')));

      transfer = httpsGetFollow(RECALL_MODEL_URL, (res, err) => {
        if (err) { fail(err); return; }
        if (res.statusCode !== 200) { res.resume(); fail(new Error(`HTTP ${res.statusCode}`)); return; }
        total = Number(res.headers['content-length'] || 0);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total) {
            const pct = Math.floor((received / total) * 100);
            if (pct > reported) { progress.report({ increment: pct - reported }); reported = pct; }
          }
        });
        res.on('error', fail);
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            if (received < RECALL_MODEL_MIN_BYTES) { fail(new Error(`only received ${received} bytes — expected a ~32MB file`)); return; }
            publish(1);
          });
        });
        out.on('error', fail);
      });
      // AFTER the call, and only if nothing has settled yet: httpsGetFollow can
      // report a synchronous failure through its callback before it returns, and
      // registering a handle that is already dead would leave teardown
      // destroying it a second time.
      if (!settled) liveTransfers.add(transfer);
    })
  );
}

// The one action the card owns: force a full re-embed of the memory dir. Spawns the
// venv python directly (so recall.py doesn't need to re-exec) with the model + corpus
// pinned via env, so the cache and the card's stats always agree on the same dir.
async function rebuildRecall() {
  const { dir } = memoryReport();
  if (!dir) {
    vscode.window.showInformationMessage('ai-acolyte: no MEMORY.md found to index.');
    return;
  }
  const script = recallScriptPath();
  if (!script) {
    vscode.window.showWarningMessage(
      'ai-acolyte: recall.py not found. Set its path so the card can rebuild the index.',
      'Set recall.py path…'
    ).then((c) => { if (c === 'Set recall.py path…') setRecallPath(); });
    return;
  }
  let st = recallStatus();
  if (!st.venv) {
    vscode.window.showWarningMessage(`ai-acolyte: DevToolbox venv python not found at ${st.py} — cannot rebuild the recall index.`);
    return;
  }
  if (!st.model) {
    const choice = await vscode.window.showWarningMessage(
      'ai-acolyte: the CPU recall model (bge-small-en-v1.5, ~32MB) isn\'t installed yet. Download it from Hugging Face now?',
      'Download', 'Cancel'
    );
    if (choice !== 'Download') return;
    const ok = await downloadRecallModel();
    if (!ok) return;
    st = recallStatus();
    if (!st.model) {
      vscode.window.showErrorMessage(
        `ai-acolyte: model download reported success but ${RECALL_MODEL_FILE} still was not detected — check ${RECALL_MODEL_HOME}.`);
      return;
    }
  }

  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ai-acolyte: rebuilding recall index…' },
    () => new Promise((resolve) => {
      const env = { ...process.env, RECALL_MODEL_DIR: st.modelDir, RECALL_MEMORY_DIR: dir, RECALL_REEXEC: '1' };
      trackChild(execFile(st.py, [script, '--rebuild'], { env, timeout: 180000 }, (err, _stdout, stderr) => {
        // A 180s rebuild easily outlives a reload, and deactivate kills it — so
        // the error this reports would be the teardown's own SIGTERM.
        if (deactivated) { resolve(); return; }
        if (err) {
          vscode.window.showErrorMessage(`ai-acolyte: recall rebuild failed — ${(stderr || err.message || '').trim().slice(0, 300)}`);
        } else {
          const n = recallIndexCount(dir);
          vscode.window.showInformationMessage(`ai-acolyte: recall index rebuilt${n != null ? ` — ${n} memories embedded` : ''}.`);
        }
        dashboard?.refresh();
        resolve();
      }));
    })
  );
}

// Silent background sync: no progress modal, no prompts, no downloads. Fires only when
// the script + venv + model are already present, the cache is genuinely behind the
// corpus, and the cooldown (15 min) has expired.
//
// Runs recall.py WITHOUT --rebuild, i.e. its incremental build_or_update: entries for
// deleted files are dropped, only changed files are re-embedded, and the ONNX session is
// not even constructed when there is nothing to do. --rebuild is force=True and belongs
// to the button, where the user asked for a full re-embed; on this path it re-embedded
// the entire corpus every tick — and because staleness was a count comparison against a
// file set that included MEMORY.md (which recall.py never embeds), every tick was 'stale'.
const RECALL_AUTO_COOLDOWN_MS = 15 * 60 * 1000;
function autoSyncRecallIfStale() {
  try {
    // Checked before the spawn, not only in the callback: a child started after
    // teardown is one killLiveChildren() has already been past.
    if (deactivated) return;
    if (Date.now() - recallRebuildAt < RECALL_AUTO_COOLDOWN_MS) return;
    const { dir } = memoryReport();
    if (!dir) return;
    const script = recallScriptPath();
    const st = recallStatus();
    // Only sync when everything is already in place — no downloads, no prompts.
    if (!script || !st.venv || !st.model) return;
    if (!recallIndexStatus(dir).stale) return; // cache already matches the corpus
    recallRebuildAt = Date.now();
    const env = { ...process.env, RECALL_MODEL_DIR: st.modelDir, RECALL_MEMORY_DIR: dir, RECALL_REEXEC: '1' };
    trackChild(execFile(st.py, [script, '--list'], { env, timeout: 180000 }, (err, _stdout, stderr) => {
      if (deactivated) return;
      if (!err) {
        const n = recallIndexCount(dir);
        vscode.window.setStatusBarMessage(
          `$(book) Recall index synced${n != null ? ` — ${n} memories embedded` : ''}`, 5000
        );
      } else {
        console.error('ai-acolyte: auto recall sync failed —', (stderr || err.message || '').trim().slice(0, 300));
      }
      dashboard?.refresh();
    }));
  } catch (err) {
    // Best-effort, but never silent. Three reachable throwers sit inside this try --
    // memoryReport(), recallStatus() and cfg() -- and recording nothing meant the recall
    // index could stop syncing for the life of the window with no trace anywhere.
    // It also recurs: the startup timer (extension.js:2666#recallSyncTimer) is one-shot, but
    // memBounce re-enters here on every MEMORY.md write, so a deterministic throw fires again
    // on every trigger and a broken run logged identically to a working one.
    console.error('ai-acolyte: auto recall sync could not run —', err);
  }
}

async function setRecallPath() {
  const val = await vscode.window.showInputBox({
    title: 'ai-acolyte: path to recall.py',
    prompt: "Absolute path to an ai-acolyte checkout's memory/recall.py (saved to user settings)",
    value: recallScriptPath(),
    ignoreFocusOut: true,
  });
  if (val && val.trim()) {
    await vscode.workspace.getConfiguration('permissionWildcarding')
      .update('memory.recallScript', val.trim(), vscode.ConfigurationTarget.Global);
    dashboard?.refresh();
  }
}

// The Memory card's data payload (pure Node). null when there's no MEMORY.md at all.
//
// `report` is optional and defaults to a fresh call, so the ~35 non-dashboard
// callers are unaffected. _push() passes one in because gatesCardData needs a
// single integer out of the same object, and computing it twice cost roughly
// 3-5 ms and 25-35 fs syscalls per refresh.
//
// A RANGE on purpose, not the constant "2.93 ms and 25 syscalls" this comment
// used to carry. The cost is a function of how many files the memory corpus
// holds, so it drifts upward as the corpus grows: the 2.93 ms / 25-syscall
// reading (12 readFileSync + 11 existsSync + 2 readdirSync per call) was
// re-measured the same day at min 5.00 ms / p50 5.23 ms and 35 syscalls
// (17 readFileSync + 16 existsSync + 2 readdirSync). Neither number is wrong;
// both are snapshots of a moving corpus, and quoting either as a constant is
// what made the first one read as a fact. Re-measure before citing a figure.
function memoryCardData(precomputed = null) {
  let out = null;
  try {
    const { conf, dir, report } = precomputed || memoryReport();
    // `conf.enabled` is honoured here, not just discovered — but NOT for the reason
    // this comment carried until 2026-09-25. It said memoryLint.activate() "returns
    // early when memory.enabled is false and so never registers
    // `permission-wildcarding.lintMemory`", so the card's link posted a command that
    // did not exist and VS Code answered "command not found". That justification
    // outlived its truth: memoryLint.js:352-360#activate registers the command UNCONDITIONALLY,
    // above the enabled check, showReport() answers for the disabled case itself
    // (memoryLint.js:651-655#conf.enabled), and test/memory-lint-watchers.test.js:422#lintMemory
    // pins it there. The stated failure mode has not been reachable since.
    //
    // The gate is still correct, for the reason that outlasted it. With the lint off
    // memoryLint clears its diagnostics and disposes its watchers
    // (memoryLint.js:580#disposeWatchers) and refresh() never runs again, so nothing maintains what
    // this card draws. Rendering it would show a token count, an issue list and an
    // index status frozen at whatever the last enabled tick left behind — live-looking
    // data from an inert linter, which is worse than no card. Same key, two
    // components, and they have to agree about whether the feature is on.
    if (conf.enabled !== false && dir && report) {
      const st = recallStatus();
      // embedded/indexable both exclude MEMORY.md, so a complete cache reads N of N
      // rather than looking one short forever.
      const recall = recallIndexStatus(dir);
      out = {
        dir: dir.replace(os.homedir(), '~'),
        tokens: report.tokens,
        budgetTokens: Math.round(conf.totalBudget / 4),
        overBudget: report.bytes > conf.totalBudget,
        // The cap that actually binds, and the only one the loader enforces by itself.
        lines: report.lineCount,
        maxLines: conf.maxLines,
        linesOver: report.linesOver,
        files: report.fileCount,
        indexable: recall.indexable,
        embedded: recall.embedded,
        stale: recall.stale,
        over: report.over.length,
        broken: report.broken.length,
        unresolved: report.unresolved.length,
        llm: st.state,
        // `modelDir` and `canRebuild` were here until 2026-10-14 and the webview read
        // neither. `canRebuild` was the costly one: recallScriptPath() probes the
        // configured path and the candidate recall.py locations with fs checks, on
        // every push. Rebuild decides for itself when clicked (rebuildRecall).
      };
    }
  } catch { /* memory card is optional — never break the dashboard */ }
  return out;
}

// `autoLearn.codexExecutable`, from the USER tier only (2026-10-14).
//
// This value is a program the extension RUNS, with no prompt: `--version` on a
// dashboard push (src/codex-version.js), `app-server` for the project-trust ask,
// `execpolicy check` for Auto Learn and "Why did this prompt?". Window-scoped, as
// it was, a repository's .vscode/settings.json could point it at a binary inside
// the repository, and opening the folder ran it. VS Code's own gate does not cover
// that: the manifest declares no `untrustedWorkspaces` capability, and the Workspace
// Trust guide says an extension that declares nothing "will be treated as not
// supporting Workspace Trust", so this extension is disabled in Restricted Mode and
// never runs in an untrusted folder at all (checked against
// code.visualstudio.com/api/extension-guides/workspace-trust, 2026-10-14). But
// trusting a folder is routinely done to read it, and trust is a statement about
// the editor, not about every binary path the folder names.
//
// So the key is `"scope": "machine"` in the manifest, which the contribution-points
// reference defines as settable "only in user settings or only in remote
// settings", and it is read here from inspect().globalValue, so a workspace or
// folder value is ignored even if one reaches inspect(): the same rule
// autoLearnWorkerTimeoutMs applies to the worker deadline, for the same reason.
// The CLI keeps its explicit --codex-executable flag.
function codexExecutableSetting(cfg) {
  const value = typeof cfg.inspect === 'function' ? cfg.inspect('autoLearn.codexExecutable')?.globalValue : undefined;
  return typeof value === 'string' && value ? value : 'codex';
}

// ── activation ────────────────────────────────────────────────────────────────
// Cross-agent Auto Learn keeps transcript text in memory only. Persistent state
// contains normalized prefixes, counters, reason labels, hashes, and cursors.
function autoLearnConfig() {
  const cfg = vscode.workspace.getConfiguration('permissionWildcarding');
  const mode = cfg.get('autoLearn.mode', 'recommend');
  const codexScope = cfg.get('autoLearn.codexScope', 'user');
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let codexRulesPath = path.join(CODEX_HOME_DIR, 'rules', 'permission-wildcarding.rules');
  let scopeWarning = '';
  if (codexScope === 'off') codexRulesPath = null;
  else if (codexScope === 'workspace') {
    // WITHDRAWN. Not silently upgraded to user scope either: a setting that
    // asked for a rules file inside the repository must not start writing one
    // into the home directory instead. Codex export is simply off until the
    // setting is changed, and the card says why.
    //
    // Three different trust notions were in play and none of them was the one
    // that decides: `vscode.workspace.isTrusted` says the EDITOR may run code
    // from this folder, the CLI flag asked nothing at all, and Codex's own
    // project trust is what actually governs whether a workspace rule file is
    // loaded. The value stays accepted so an existing settings.json reaches this
    // explanation rather than a schema error.
    codexRulesPath = null;
    scopeWarning = WORKSPACE_SCOPE_WITHDRAWN_NOTE;
  }
  return {
    enabled: cfg.get('autoLearn.enabled', true),
    mode: ['observe', 'recommend', 'auto-safe'].includes(mode) ? mode : 'recommend',
    threshold: Math.max(1, Math.floor(cfg.get('autoLearn.successThreshold', 3))),
    intervalMinutes: Math.max(1, Number(cfg.get('autoLearn.intervalMinutes', 5)) || 5),
    debounceSeconds: Math.max(1, Number(cfg.get('autoLearn.debounceSeconds', 20)) || 20),
    codexScope,
    codexRulesPath,
    codexExecutable: codexExecutableSetting(cfg),
    scopeWarning,
    // Evidence/state is still partitioned and cwd-filtered by the open
    // workspace. That is independent of scope: it decides which observations
    // count, not where a rule is written, and user-scope export has always used
    // it. The trusted-workspace rule ROOT is gone with the capability it served,
    // and test/codex-workspace-scope.test.js fails the build if either of its
    // two symbols comes back into the packaged extension.
    workspaceRoot,
  };
}

function autoLearnManagerOptions(cfg = autoLearnConfig()) {
  return {
    // One spelling per key: the `homeDir` / `successThreshold` duplicates were
    // removed 2026-10-13 (they shadowed the manager's fallback legs). Guarded by
    // test/codex-inventory-ui.test.js, which rejects a key the manager never reads.
    home: os.homedir(), codexHome: CODEX_HOME_DIR, mode: cfg.mode,
    threshold: cfg.threshold,
    codexRulesPath: cfg.codexRulesPath, codexExecutable: cfg.codexExecutable,
    workspaceRoot: cfg.workspaceRoot,
    // No `codexHistory` here, on purpose. It pinned the Codex root to
    // `sessions/` alone and overrode the manager's default, which also reads
    // `archived_sessions/`: archiving a thread MOVES its rollout there (measured
    // 2026-10-13), so the pin dropped every archived thread's calls from the
    // corpus. Both folders hang off CODEX_HOME_DIR, which the manager already
    // gets as `codexHome` above and which is in the cache key below.
    paths: {
      claudeHistory: PROJECTS_DIR,
      claudeSettings: SETTINGS,
      codexRules: cfg.codexRulesPath,
    },
  };
}

function getAutoLearnManager() {
  const cfg = autoLearnConfig();
  const key = JSON.stringify({
    home: os.homedir(), codexHome: CODEX_HOME_DIR, mode: cfg.mode, threshold: cfg.threshold,
    codexRulesPath: cfg.codexRulesPath, codexExecutable: cfg.codexExecutable,
    workspaceRoot: cfg.workspaceRoot,
  });
  if (autoLearnManager && key === autoLearnManagerKey) return autoLearnManager;
  autoLearnManager = createAutoLearnManager(autoLearnManagerOptions(cfg));
  autoLearnManagerKey = key;
  return autoLearnManager;
}

function invalidateAutoLearnManager() {
  autoLearnManager = null;
  autoLearnManagerKey = '';
  autoLearnCardCache = null;
}

// The worker is spawned by PATH, so the Module._load redirect a test installs
// cannot reach it: `./src/` exists only in a packaged extension, where
// scripts/package.mjs copies repo-root src/ next to this file, and is generated
// and gitignored in the repository. Same split requireShared() handles in
// autoLearnUi.js. Without the fallback a scan dies with MODULE_NOT_FOUND on any
// fresh checkout, which is CI (npm test runs before packaging) and anyone
// debugging the extension from source.
function autoLearnWorkerPath() {
  const packaged = path.join(__dirname, 'src', 'auto-learn-worker.js');
  if (fs.existsSync(packaged)) return packaged;
  const repository = path.join(__dirname, '..', 'src', 'auto-learn-worker.js');
  return fs.existsSync(repository) ? repository : packaged;
}

// The worker deadline from `autoLearn.workerTimeoutSeconds`, in ms, or undefined.
// Before 2026-10-13 only PERMISSION_WILDCARDING_WORKER_TIMEOUT_MS could set it.
//
// UNDEFINED UNLESS THE USER SET IT, which is why this reads inspect() and not
// get(): get() returns the manifest default (300) whether or not anyone chose
// it, and a number here outranks the env var in the runner, so an untouched
// setting would silently cancel an env override that already works.
//
// globalValue ONLY. The key is machine-scoped so that a cloned repository's
// .vscode/settings.json cannot set it to 0 and leave a wedged worker holding
// teardown open; VS Code ignores a machine setting at workspace scope, and
// reading only the user tier here keeps that true even if an inspect() result
// carried one. Anything that is not a finite number >= 0 counts as unset: an
// invalid value keeps the deadline rather than switching it off.
function autoLearnWorkerTimeoutMs() {
  const config = vscode.workspace.getConfiguration('permissionWildcarding');
  if (typeof config.inspect !== 'function') return undefined;
  const seconds = config.inspect('autoLearn.workerTimeoutSeconds')?.globalValue;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

function getAutoLearnWorkerRunner() {
  if (!autoLearnWorkerRunner) {
    autoLearnWorkerRunner = createAutoLearnWorkerRunner({
      workerPath: autoLearnWorkerPath(),
      optionsProvider: () => autoLearnManagerOptions(),
      // The function itself, re-read by the runner on every operation: the
      // runner outlives every configuration change, so a number would be frozen.
      timeoutMs: autoLearnWorkerTimeoutMs,
      onMutation: () => invalidateAutoLearnManager(),
    });
  }
  return autoLearnWorkerRunner;
}

function runAutoLearnWorker(operation, ...args) {
  // The `deactivated` check has to live HERE, not in the runner. deactivate()
  // nulls `autoLearnWorkerRunner` so a same-realm re-activate can get a working
  // one — which means a late call arriving after teardown finds an empty slot,
  // and getAutoLearnWorkerRunner() cheerfully builds a FRESH runner with
  // `deactivating: false`. Its own guard cannot see the teardown that already
  // happened. So the caller that used to be refused forever ("Auto Learn is
  // deactivating") would instead start a real Worker post-teardown and let it
  // write settings.json, the claims registry and the Codex rules file.
  //
  // Rejecting rather than resolving: every caller treats this as an operation
  // that either produced a result or failed, and a silent success would be read
  // as "the scan found nothing".
  if (deactivated) {
    return Promise.reject(new Error('Auto Learn is deactivating'));
  }
  return getAutoLearnWorkerRunner().run(operation, ...args);
}

// Both of these used to carry a second leg: status -> getStatus, listCandidates ->
// getCandidates. Neither could ever run. The alternative name was an ALIAS on the
// same object src/auto-learn-manager.js returns, so it was present exactly when the
// first name was and absent exactly when it was not, and the `typeof` test above it
// decided nothing. Removed 2026-09-25, together with the aliases themselves; the
// manager now refuses to carry two names for one function and a test says so.
//
// The `?.` and the {} are NOT the same thing and stay: getAutoLearnManager() is nulled
// for the whole of deactivate() (extension.js:5359#autoLearnManager), so a refresh
// racing a teardown really can arrive here with nothing.
function managerStatus(manager) {
  return typeof manager?.status === 'function' ? manager.status() : {};
}

// The shape normalisation below is a different question and is load-bearing: a
// worker result arrives as `{ candidates: [...] }` while a direct call returns the
// array itself.
function managerCandidates(manager, options) {
  const value = typeof manager?.listCandidates === 'function'
    ? manager.listCandidates(options) : [];
  return Array.isArray(value) ? value : (Array.isArray(value?.candidates) ? value.candidates : []);
}

function countAutoLearnCandidates(candidates, status = {}, requiredTargets = ['claude'], mode = 'recommend', settings = null) {
  const pending = candidates.filter((candidate) =>
    !isCandidateComplete(candidate, status, requiredTargets));
  if (mode === 'observe') {
    return { total: candidates.length, safe: 0, review: 0, covered: 0, observe: pending.length, applied: candidates.length - pending.length };
  }
  const reviewable = reviewableCandidates(candidates, status, requiredTargets, settings);
  return {
    total: candidates.length,
    safe: pending.filter((candidate) => candidate.autoSafe || candidate.disposition === 'auto-safe').length,
    review: reviewable.candidates.length,
    covered: reviewable.covered.length,
    observe: pending.filter((candidate) => candidate.disposition === 'observe').length,
    applied: candidates.length - pending.length,
  };
}

function autoLearnStateStamp(manager) {
  try {
    const stat = fs.statSync(manager?.paths?.state);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch { return 'absent'; }
}

// One overview() call, which answers status and candidates from a single state
// read. There was a second leg here for a manager WITHOUT overview(), building
// the pair from status() and listCandidates(). It could not run: the manager is
// always createAutoLearnManager()'s, whose export list carries overview, and no
// harness in test/ replaces the manager module. Removed 2026-10-14 (finding 9).
// A manager that somehow lacked it now throws, which autoLearnCardData already
// catches and reports on the card, rather than quietly reading state twice.
function autoLearnEvidence(cfg) {
  const manager = getAutoLearnManager();
  const key = `${autoLearnManagerKey}|${autoLearnStateStamp(manager)}`;
  if (autoLearnCardCache?.key === key) return autoLearnCardCache.data;
  const view = manager.overview();
  const data = {
    status: view?.status || {},
    candidates: Array.isArray(view?.candidates) ? view.candidates : [],
  };
  autoLearnCardCache = { key, data };
  return data;
}

// What the last scan could not read, taken from the manager's persisted
// `lastScanStats` rather than from a scan() return value — so it survives a
// window reload and is answerable on any refresh, not only in the seconds after
// a scan.
//
// `autoLearnLastError` is a DIFFERENT thing: it is the message of an exception
// that escaped, i.e. a scan that never returned. These are the failures of a scan
// that DID return, reporting that part of the corpus was unreadable, and they
// were visible nowhere in the UI while `bin/wildcard-perms --learn scan` printed
// every one of them. That is the exact shape of the defect that sat unnoticed for
// eight days (src/auto-learn-manager.js:2774-2776#errors: "`errors` was computed here
// all along and then not returned, so a file that failed every scan for eight
// days was invisible"). Surfacing it in the CLI and not in the panel most users
// live in only moves where it hides.
function autoLearnScanHealth(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const count = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  return {
    files: count(stats.files),
    observations: count(stats.observations),
    errors: count(stats.errors),
    partial: count(stats.partial),
    unmatchedResults: count(stats.unmatchedResults),
    // One number, because the four prune counters are one housekeeping fact from
    // the card's point of view and four stats tiles it does not have room for.
    pruned: count(stats.prunedObservations) + count(stats.prunedCursors)
      + count(stats.prunedCandidates) + count(stats.prunedGrants),
    // NOT part of that sum, and the reason it is its own field: the other four say
    // housekeeping ran. This one says housekeeping could not finish. The observation
    // cap evicts whole below-threshold families once they alone exceed it, but never
    // one carrying a human decision (src/auto-learn-manager.js:1008-1048#CEILING), so
    // that residue can still hold the map past its limit (until 2026-09-25 the whole
    // protected set could). This is the only number that says it happened, and
    // it had no reader at all: computed, persisted in lastScanStats, printed by the
    // CLI, and never once shown in the panel.
    retainedObservations: count(stats.retainedObservations),
    // "The cursor map was preserved because nothing was enumerated." Distinct
    // from `errors`, which says a root failed but not that the scan was therefore
    // unable to look at anything — and indistinguishable, on the numbers alone,
    // from an ordinary quiet scan.
    blindScan: stats.blindScan === true,
    // "The Codex rollout directory this scan read may no longer be where Codex
    // writes." A migrated backend leaves `~/.codex/sessions` frozen, and a scan
    // of a frozen directory reports exactly the numbers a quiet week reports.
    // `codexHistoryInspected: 'partial'` is the other half: the comparison could
    // not be made, which is not an answer of `false`. `'unavailable'` is a
    // different statement again — the probe needs `node:sqlite` and the host
    // cannot load it. VS Code 1.141.1 (Node 24.21.0) loads it; hosts within the
    // ^1.80 engine floor may not, so the `unavailable` tier stays (measured
    // 2026-10-13). It is passed through UNCHANGED rather than folded into
    // 'partial', because scanTrouble treats only the latter as trouble.
    codexHistoryStale: stats.codexHistoryStale === true,
    codexHistoryInspected: stats.codexHistoryInspected || 'skipped',
    // What `stale` is made of, so the card can say WHICH divergence it saw. The
    // fixed sentence it replaced ("history store has moved") was wrong about the
    // one case anyone actually hit: four archived threads, nothing moved.
    codexHistoryFindings: stats.codexHistoryFindings && typeof stats.codexHistoryFindings === 'object'
      ? stats.codexHistoryFindings : null,
    // Three, because it is a hover title and not a report; the output channel
    // gets every one.
    codexHistoryReasons: (Array.isArray(stats.codexHistoryReasons) ? stats.codexHistoryReasons : []).slice(0, 3),
    // Budget deferral is catch-up and is drawn as such, beside the count of what
    // is left. A skipped unreadable stretch is the lost-bytes case, and trouble.
    deferredBytes: count(stats.deferredBytes),
    unreadable: count(stats.unreadable),
  };
}

function autoLearnCardData() {
  const cfg = autoLearnConfig();
  let status = {};
  let candidates = [];
  try {
    ({ status, candidates } = autoLearnEvidence(cfg));
  } catch (error) {
    autoLearnLastError = error.message;
  }
  return {
    enabled: cfg.enabled, mode: cfg.mode, threshold: cfg.threshold,
    codexScope: cfg.codexScope, scopeWarning: cfg.scopeWarning,
    busy: autoLearnBusy, error: autoLearnLastError,
    // No `lastScanAt` / `lastApplyAt` since 2026-10-14 (finding 9). Each carried a
    // second leg (`|| status.lastScan`, `|| status.lastApplicationAt`) that could
    // never decide anything, because the manager's status sets both spellings
    // from the same value; and the webview read neither field at all, so the
    // census in test/dashboard-view.test.js now holds this card to the same rule
    // as the payload: every field posted has a reader. `canUndo` lost the same
    // kind of leg: status.canUndo IS Boolean(state.lastApplication).
    counts: countAutoLearnCandidates(
      candidates, status, cfg.codexRulesPath ? ['claude', 'codex'] : ['claude'], cfg.mode, readSettings(),
    ),
    scan: autoLearnScanHealth(status.lastScanStats),
    codexEvidence: status.codexEvidence || null,
    canUndo: status.canUndo === true,
  };
}

function autoLearnApplicationMessage(summary, verb = 'applied') {
  const count = summary?.appliedCount || 0;
  const targets = uniqueTargets(summary?.changedTargets);
  const housekeeping = backupPruneSuffix(summary);
  if (!targets.length) {
    return (count
      ? `Auto Learn recorded ${count} already-covered command ${count === 1 ? 'family' : 'families'}; no policy file changed.`
      : 'Auto Learn did not change a policy file.') + housekeeping;
  }
  const scope = policyTargetLabel(targets);
  if (!count) {
    return `Auto Learn reconciled ${scope} policy.` + codexRestartSuffix(targets) + housekeeping;
  }
  return `Auto Learn ${verb} ${count} command ${count === 1 ? 'family' : 'families'} in ${scope}.` +
    codexRestartSuffix(targets) + housekeeping;
}

async function runAutoLearnScan(manual = false, suppressApplicationNotice = false) {
  // Which activation owns this scan. Read BEFORE the first await, for the same
  // reason deactivate() reads it before its drain: everything after the await is
  // racing a possible re-activate. See the `finally` at the bottom of this function.
  const generation = activationGeneration;
  const cfg = autoLearnConfig();
  if (!cfg.enabled && !manual) return null;
  if (!manual && Date.now() < autoLearnNextRetryAt) return null;
  if (autoLearnBusy) {
    if (manual) vscode.window.setStatusBarMessage('$(sync~spin) Auto Learn scan already running', 3000);
    return null;
  }
  autoLearnBusy = true;
  autoLearnLastError = null;
  dashboard?.refresh();
  if (manual) vscode.window.setStatusBarMessage('$(sync~spin) Auto Learn: scanning Claude + Codex history…', 4000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    const result = await runAutoLearnWorker('scan', { mode: cfg.mode, threshold: cfg.threshold });
    autoLearnFailureCount = 0;
    autoLearnNextRetryAt = 0;
    logScanTrouble(result);
    const manager = getAutoLearnManager();
    const status = managerStatus(manager);
    const counts = countAutoLearnCandidates(
      managerCandidates(manager), status, cfg.codexRulesPath ? ['claude', 'codex'] : ['claude'], cfg.mode,
      readSettings(),
    );
    const summary = applicationSummary(result);
    const applied = summary.appliedCount;
    if (manual) {
      let message = `Auto Learn: ${counts.safe} safe, ${counts.review} review, ${counts.observe} still observing`;
      if (applied && summary.changedTargets.length) {
        message += `; auto-applied ${applied} in ${policyTargetLabel(summary.changedTargets)}`;
      } else if (applied) {
        message += `; recorded ${applied} already-covered ${applied === 1 ? 'family' : 'families'}`;
      } else if (summary.changedTargets.length) {
        message += `; reconciled ${policyTargetLabel(summary.changedTargets)} policy`;
      }
      vscode.window.showInformationMessage(
        message + '.' + codexRestartSuffix(summary.changedTargets) + backupPruneSuffix(summary)
      );
    } else if ((applied || summary.changedTargets.length) && !suppressApplicationNotice) {
      vscode.window.showInformationMessage(autoLearnApplicationMessage(summary, 'safely applied'));
    }
    return result;
  } catch (error) {
    autoLearnLastError = error.message;
    if (!manual) {
      autoLearnFailureCount += 1;
      // Retry transient failures, without hammering a deterministic bad history
      // record on every watcher event. A successful scan resets this backoff.
      const delayMinutes = Math.min(60, 2 ** Math.min(autoLearnFailureCount - 1, 6));
      autoLearnNextRetryAt = Date.now() + delayMinutes * 60 * 1000;
    }
    if (manual) vscode.window.showErrorMessage(`Auto Learn scan failed: ${error.message}`);
    else console.error('ai-acolyte: Auto Learn scan failed —', error);
    return null;
  } finally {
    // Only if this scan still owns the latch. deactivate() guards its own clear the
    // same way (extension.js:5389#autoLearnBusy) and that guard was UNFALSIFIABLE until
    // this one existed — deleting it left the suite green, because this line cleared the
    // latch for it on every path. Both halves are needed and the pair is one rule.
    //
    // The hole: two scans really can overlap, because activate() releases the latch
    // unconditionally so that a wedged predecessor cannot strand it (extension.js:2454#autoLearnBusy).
    // One boolean cannot track two, so whichever settles FIRST used to clear it, and a
    // predecessor settling after a re-activate opened "already running" for a scan
    // that was still running. A second worker was then dispatched against it.
    if (generation === activationGeneration) autoLearnBusy = false;
    dashboard?.refresh();
  }
}

async function applyAutoLearnSafe() {
  const cfg = autoLearnConfig();
  if (!cfg.enabled) {
    vscode.window.showWarningMessage('Auto Learn is disabled in settings. Enable it before applying policy.');
    return;
  }
  if (cfg.mode === 'observe') {
    vscode.window.showWarningMessage('Auto Learn is in observe mode. Switch to recommend or auto-safe before applying policy.');
    return;
  }
  const scanResult = await runAutoLearnScan(false, true);
  if (scanResult === null) return;
  const scanSummary = applicationSummary(scanResult);
  try {
    const result = await runAutoLearnWorker('apply', { includeReviewed: false });
    const summary = applicationSummary(scanResult, result);
    const count = summary.appliedCount;
    if (!count && !summary.changedTargets.length) {
      vscode.window.showInformationMessage('Auto Learn: no unapplied safe candidates meet the threshold.');
    }
    else vscode.window.showInformationMessage(autoLearnApplicationMessage(summary, 'applied'));
  } catch (error) {
    autoLearnLastError = error.message;
    if (scanSummary.appliedCount || scanSummary.changedTargets.length) {
      vscode.window.showInformationMessage(
        autoLearnApplicationMessage(scanSummary, 'safely applied during the prerequisite scan')
      );
    }
    vscode.window.showErrorMessage(`Auto Learn apply failed after scanning: ${error.message}`);
  }
  dashboard?.refresh();
}

async function reviewAutoLearnCandidates() {
  const cfg = autoLearnConfig();
  if (!cfg.enabled) {
    vscode.window.showWarningMessage('Auto Learn is disabled in settings. Enable it before reviewing candidates.');
    return;
  }
  if (cfg.mode === 'observe') {
    vscode.window.showWarningMessage('Auto Learn is in observe mode. Switch to recommend to review candidates.');
    return;
  }
  const scanResult = await runAutoLearnScan(false, true);
  if (scanResult === null) return;
  const scanSummary = applicationSummary(scanResult);
  const notifyScanApplication = () => {
    if (scanSummary.appliedCount || scanSummary.changedTargets.length) {
      vscode.window.showInformationMessage(
        autoLearnApplicationMessage(scanSummary, 'safely applied during the review scan')
      );
    }
  };
  const manager = getAutoLearnManager();
  const status = managerStatus(manager);
  const requiredTargets = cfg.codexRulesPath ? ['claude', 'codex'] : ['claude'];
  const settingsNow = readSettings();
  const allCandidates = managerCandidates(manager);
  const removalNote = codexRemovalNote(allCandidates);
  const { covered, candidates } = reviewableCandidates(
    allCandidates, status, requiredTargets, settingsNow,
  );
  const coveredNote = covered.length
    ? ` (${covered.length} already covered by existing allow rules — hidden)`
    : '';
  // A family a managed ask covers is withheld from this list, because no rule
  // written from here can stop its prompt. Withholding it silently was the
  // whole problem: the prompts kept arriving with nothing in Review to explain
  // them, and a grant already in settings.json looked like it had just failed.
  // The wording lives in autoLearnUi.js, where it is under test.
  const managed = status.managed || {};
  const blockedCount = (managed.inertFamilies || []).length;
  const blockedNote = managedBlockedNote(managed);
  const showBlockedDetail = () => {
    const channel = sharedChannel({ fresh: true });
    if (!channel) return;   // the host went while this notification was up
    for (const line of managedBlockedDetail(managed)) channel.appendLine(line);
    channel.show(true);
  };
  if (!candidates.length) {
    if (scanSummary.appliedCount || scanSummary.changedTargets.length) notifyScanApplication();
    else if (blockedCount || managed.degraded) {
      vscode.window.showInformationMessage(
        `Auto Learn: no candidates are ready for review${coveredNote}${blockedNote}${removalNote}.`,
        'Show blocked'
      ).then((choice) => { if (choice === 'Show blocked') showBlockedDetail(); });
    } else {
      vscode.window.showInformationMessage(
        `Auto Learn: no candidates are ready for review${coveredNote}${removalNote}.`
      );
    }
    return;
  }
  // A deny or ask rule beats a user allow entry, and managed policy can supply
  // either. Say so up front rather than letting a granted family keep prompting.
  const overrideOf = (candidate) => {
    if (!candidate.claudePermission) return null;
    const { decision } = claudePermissionDecision(settingsNow, candidate.claudePermission);
    return decision === 'deny' || decision === 'ask' ? decision : null;
  };
  const picks = await vscode.window.showQuickPick(candidates.map((candidate) => ({
    label: `${candidate.claudePermission || candidate.prefix?.join(' ') || candidate.key} [pending: ${policyTargetLabel(candidatePendingTargets(candidate, status, requiredTargets))}]`,
    description: `${candidate.counts?.success ?? candidate.successfulRuns ?? 0} successes · ${candidate.risk}`,
    detail: [overrideOf(candidate) ? `policy ${overrideOf(candidate)} overrides this grant` : null,
      codexRemovalExplanation(candidate),
      candidate.autoSafe ? 'safe' : 'manual review',
      (candidate.sources || []).join(' + '), (candidate.reasons || []).join(', ')]
      .filter(Boolean).join(' · '),
    candidate,
  })), {
    canPickMany: true,
    ignoreFocusOut: true,
    title: `Auto Learn candidates${coveredNote}${blockedNote}${removalNote}`,
    placeHolder: 'Select command families to add to Claude permissions and validated Codex rules',
  });
  if (!picks?.length) { notifyScanApplication(); return; }
  // Confirm on risk and policy override, not on auto-safe eligibility — see
  // selectionsNeedingConfirmation in autoLearnUi.js for why.
  const notable = selectionsNeedingConfirmation(
    picks.map((pick) => pick.candidate), overrideOf,
  );
  if (notable.length) {
    const named = notable.slice(0, 6).map((entry) => {
      const label = entry.candidate.claudePermission ||
        entry.candidate.prefix?.join(' ') || entry.candidate.key;
      return entry.override
        ? `  ${label} — ${entry.candidate.risk}, but policy ${entry.override} overrides this grant`
        : `  ${label} — ${entry.candidate.risk}`;
    });
    const more = notable.length - named.length;
    const answer = await vscode.window.showWarningMessage(
      `Grant ${picks.length} command ${picks.length === 1 ? 'family' : 'families'}?`,
      {
        modal: true,
        detail: [
          `${notable.length} of them ${notable.length === 1 ? 'is' : 'are'} not plain read-only:`,
          '',
          ...named,
          ...(more > 0 ? [`  …and ${more} more`] : []),
          '',
          'permissions.deny and managed policy still win.',
        ].join('\n'),
      },
      'Grant'
    );
    if (answer !== 'Grant') { notifyScanApplication(); return; }
  }
  try {
    const expectedFingerprints = Object.fromEntries(
      picks.map((pick) => [pick.candidate.key, pick.candidate.fingerprint]),
    );
    const result = await runAutoLearnWorker('apply', {
      keys: picks.map((pick) => pick.candidate.key),
      includeReviewed: true,
      expectedFingerprints,
    });
    const summary = applicationSummary(scanResult, result);
    vscode.window.showInformationMessage(summary.appliedCount || summary.changedTargets.length
      ? autoLearnApplicationMessage(summary, 'applied after review')
      : 'Auto Learn: the selected candidates were already covered or structurally ineligible.');
  } catch (error) {
    autoLearnLastError = error.message;
    notifyScanApplication();
    vscode.window.showErrorMessage(`Auto Learn reviewed selection was not applied: ${error.message}`);
  }
  dashboard?.refresh();
}

async function undoAutoLearn() {
  try {
    const result = await runAutoLearnWorker('undo');
    if (result?.changed === false || result?.undone === false) {
      vscode.window.showInformationMessage(result?.reason || 'Auto Learn: nothing to undo.');
    } else {
      const targets = uniqueTargets(result?.restoredTargets);
      vscode.window.showInformationMessage(
        `Auto Learn restored ${policyTargetLabel(targets)} from before its last application.` +
        codexRestartSuffix(targets) + backupPruneSuffix(result)
      );
    }
  } catch (error) {
    autoLearnLastError = error.message;
    vscode.window.showErrorMessage(`Auto Learn undo stopped: ${error.message}`);
  }
  dashboard?.refresh();
}

async function cycleAutoLearnMode() {
  const order = ['observe', 'recommend', 'auto-safe'];
  const cfg = autoLearnConfig();
  const next = order[(order.indexOf(cfg.mode) + 1) % order.length];
  if (next === 'auto-safe') {
    const answer = await vscode.window.showWarningMessage(
      `Turn on Auto Learn auto-safe mode? Only deterministic read-only families with ${cfg.threshold}+ successful runs are eligible; every other risk class stays review-only.`,
      { modal: true }, 'Enable auto-safe'
    );
    if (answer !== 'Enable auto-safe') return;
  }
  await vscode.workspace.getConfiguration('permissionWildcarding')
    .update('autoLearn.mode', next, (() => {
      const inspected = vscode.workspace.getConfiguration('permissionWildcarding').inspect('autoLearn.mode');
      if (inspected?.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder;
      if (inspected?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
      return vscode.ConfigurationTarget.Global;
    })());
  invalidateAutoLearnManager();
  vscode.window.showInformationMessage(`Auto Learn mode: ${next}.`);
  scheduleAutoLearn(50);
  dashboard?.refresh();
}

function execFileCaptured(executable, args) {
  // Same PATHEXT asymmetry the Auto Learn validator hits: a bare name that a
  // PATH check finds can still be unlaunchable when it resolves to a shim.
  const launch = commandLaunch(executable, args);
  return new Promise((resolve, reject) => {
    trackChild(execFile(launch.file, launch.args, {
      windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, ...launch.options,
    }, (error, stdout, stderr) => {
      if (error) {
        error.detail = String(stderr || stdout || error.message).trim();
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    }));
  });
}

// The one spelling of "which rule set this window describes", for the dashboard
// count, its trust refresh and "Why did this prompt?". One function, because the
// trust cache is keyed on these fields: a push and a refresh that spelled them
// differently would settle one entry and keep reading the other.
function codexRuleSetOptions(cfg) {
  return { home: os.homedir(), codexHome: CODEX_HOME_DIR, target: cfg.codexRulesPath || null,
    workspaceRoot: cfg.workspaceRoot, codexExecutable: cfg.codexExecutable };
}

// One definition of "the set Codex evaluates", shared with the pre-write validator
// (src/codex-policy.js), so "Why did this prompt?" cannot name a cause the write never
// checked. The workspace root adds the trusted project folders, which that check omits.
//
// ASYNC since 2026-10-14. It was a synchronous codexRuleFileSet, which on a trust
// cache miss spawnSync'd `codex app-server` on the extension host with a 40 s
// ceiling (src/codex-policy.js, "THE ASK NEVER RUNS ON THE EXTENSION HOST THREAD").
// The trust verdict is now settled off-thread and awaited, and the set is read
// from the cache. If the refresh could not settle it (torn down mid-ask), the set
// says the project folders are still being checked rather than guessing them.
async function codexRuleFileSetFor(cfg) {
  const options = codexRuleSetOptions(cfg);
  await refreshProjectTrust({ ...options, track: trackChild });
  return codexRuleFileSet({ ...options, projectTrust: 'cached' });
}

// The dashboard's half: one refresh at a time, and a push when it lands, so a
// cold panel shows the project rules a second later without waiting for some
// unrelated event. Bounded by construction: a refresh that lands makes the next
// read fresh, so the push it causes finds nothing pending and starts nothing.
// The generation check keeps a predecessor's late answer from pushing to, or
// clearing the latch of, a same-realm successor.
let projectTrustRefreshing = false;
// A late continuation's push, for this activation only.
const settledFor = (generation) => () => {
  if (!deactivated && generation === activationGeneration) dashboard?.refresh();
};
function refreshProjectTrustForDashboard(cfg) {
  if (projectTrustRefreshing || deactivated) return;
  projectTrustRefreshing = true;
  const generation = activationGeneration;
  refreshProjectTrust({ ...codexRuleSetOptions(cfg), track: trackChild }).then((landed) => {
    if (generation !== activationGeneration) return;
    projectTrustRefreshing = false;
    if (landed) dashboard?.refresh();
  });
}

// `codexRuleFiles(cfg)` used to sit here, returning `.files` off the set above.
// Its one caller was rewritten to take the whole set -- it needs `effective` and
// `blindSpots` as well -- and the helper was left behind with no callers at all.
// Removed rather than kept as a convenience: a narrowing accessor onto a
// diagnostic that is about to answer a question about the WHOLE visible rule set
// is the wrong shape to offer the next caller.

function learnedCandidateExplanation(invocation, learned, target, threshold) {
  const label = invocation.prefix?.join(' ') || candidateKey(invocation);
  if (!learned) return `${label}: no correlated history evidence has been learned yet.`;
  const success = learned.counts?.success ?? learned.successfulRuns ?? 0;
  const failed = learned.counts?.failed ?? learned.failedRuns ?? 0;
  if (target === 'codex' && learned.codexSuppressed) {
    return `${label}: ${success} successful, ${failed} failed; ${codexRemovalExplanation(learned)}`;
  }
  const pending = candidatePendingTargets(learned, {}, [target]);
  const state = learned.autoSafe ? 'auto-safe'
    : learned.disposition === 'review' ? 'review required' : `observing until ${threshold} successes`;
  return `${label}: ${success} successful, ${failed} failed; ${state}` +
    (pending.length ? `; pending for ${pending.join(' + ')}` : '; already applied or ineligible for this target') + '.';
}

function execpolicyOutputSummary(output) {
  const text = String(output || '').trim();
  try {
    const parsed = JSON.parse(text);
    const decision = parsed.decision || 'no decision (prompt/default policy)';
    const matches = Array.isArray(parsed.matchedRules) ? parsed.matchedRules.length : 0;
    return `decision: ${decision}; matched rules: ${matches}\n${JSON.stringify(parsed, null, 2)}`;
  } catch {
    return text || 'No output returned.';
  }
}

function windowsPowerShellExecutable() {
  const root = process.env.SystemRoot || process.env.WINDIR;
  if (!root) return null;
  const executable = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(executable) ? executable : null;
}

// Reachable whatever Review is showing. The detail used to hang off the
// "no candidates" toast, which is the one situation where nobody is being
// prompted: a busy list is exactly when you want to know which prompts cannot be
// fixed, and that was the case with no route to the answer.
function showAutoLearnBlocked() {
  let managed;
  try { managed = managerStatus(getAutoLearnManager()).managed; }
  catch (error) {
    vscode.window.showErrorMessage(`Auto Learn could not read its state: ${error.message}`);
    return;
  }
  const blocked = (managed && managed.inertFamilies) || [];
  if (!managed || (managed.policy === 'absent' && !blocked.length)) {
    vscode.window.showInformationMessage(
      'Auto Learn: no managed policy is present, so nothing is blocked by one.');
    return;
  }
  if (!managed.degraded && !blocked.length && !(managed.deadAllowEntries || []).length) {
    vscode.window.showInformationMessage(
      'Auto Learn: no command family is blocked by your managed policy.');
    return;
  }
  const channel = sharedChannel({ fresh: true });
  if (!channel) return;   // the host went while this command was awaiting
  for (const line of managedBlockedDetail(managed)) channel.appendLine(line);
  channel.show(true);
}

// The one lever left for a managed rule no grant can beat. Deliberately a
// per-item decision rather than a single "apply all" button: this writes a
// standing instruction into the user's own CLAUDE.md, and a bulk write leaves
// every line in that file indistinguishable from every other, which is the
// state a hand-maintained gates block is already in.
async function showDerivedGuidance() {
  let review;
  try { review = getAutoLearnManager().derivedReview(); }
  catch (error) {
    vscode.window.showErrorMessage(`Derived guidance could not be computed: ${error.message}`);
    return;
  }
  const items = derivedGuidanceItems(review);
  if (!items.length) {
    // Not an error, and usually the good outcome. Say which it is.
    vscode.window.showInformationMessage(`Derived guidance: ${derivedGuidanceSummary(review)}`);
    return;
  }
  const pick = await vscode.window.showQuickPick(items, {
    title: `Derived guidance — ${derivedGuidanceSummary(review)}`,
    placeHolder: 'Review advice based on managed policy and observed activity',
    matchOnDetail: true,
  });
  if (!pick || deactivated) return;

  // Quick-pick detail is truncated. Show the complete standing instruction at
  // the decision point so accepting it means reviewing the text being written.
  const action = await vscode.window.showInformationMessage(pick.label, {
    modal: true, detail: `${pick.detail}\n\nCurrently ${pick.state}. Accept installs this instruction; Decline removes it and stops offering it; Reset removes it and makes it undecided.`,
  }, 'Accept', 'Decline', 'Reset');
  if (!['Accept', 'Decline', 'Reset'].includes(action)) return;
  const decision = { value: action.toLowerCase() };
  // THE SHARPEST OF THE SIX, because the usual retainer check does not help here.
  // deactivate() nulls `autoLearnManager`, and getAutoLearnManager() BUILDS A NEW
  // ONE when the slot is empty — so a continuation arriving after teardown does
  // not find a dead manager and give up, it constructs a live one against a dead
  // host and writes the user's CLAUDE.md through it. Two awaited QuickPicks
  // upstream make that a wide window. Same class as the defect recorded on
  // ensureGuidance, where flipping guidance.enabled after teardown rewrote
  // CLAUDE.md from 1802 bytes to 24.
  if (deactivated) return;

  try {
    const result = getAutoLearnManager().decideDerived(pick.id, decision.value);
    const wrote = (result.targets || []).filter((target) => target.changed);
    const failed = (result.targets || []).filter((target) => target.error);
    if (failed.length) {
      vscode.window.showWarningMessage(
        `Derived guidance ${decision.value}: ${failed.map((t) => t.error).join('; ')}`);
      return;
    }
    vscode.window.showInformationMessage(wrote.length
      ? `Derived guidance ${decision.value}: updated ${wrote.map((t) => t.agent).join(', ')}. ` +
        'Loaded from the next session on.'
      : `Derived guidance ${decision.value}: recorded, no instruction file needed changing.`);
  } catch (error) {
    vscode.window.showErrorMessage(`Derived guidance ${decision.value} failed: ${error.message}`);
  }
}

async function explainAutoLearnPrompt() {
  const agentPick = await vscode.window.showQuickPick([
    { label: 'Claude Code', value: 'claude', description: 'Evaluate deny, ask, and allow precedence' },
    { label: 'Codex', value: 'codex', description: 'Run codex execpolicy check against visible rules' },
  ], { title: 'Which agent showed the approval prompt?' });
  if (!agentPick) return;

  const shell = await vscode.window.showQuickPick(['PowerShell', 'Bash'], {
    title: 'Which shell syntax should Auto Learn parse?',
  });
  if (!shell) return;
  const command = await vscode.window.showInputBox({
    title: `Why did ${agentPick.label} prompt?`,
    prompt: 'Paste the shell command. It is analyzed in memory and is not saved.',
    ignoreFocusOut: true,
  });
  if (!command) return;

  const invocations = extractInvocations(shell, command, { source: 'manual' });
  if (!invocations.length) {
    vscode.window.showInformationMessage('Auto Learn could not derive a stable command family from that shell expression.');
    return;
  }

  const cfg = autoLearnConfig();
  let candidates = new Map();
  try {
    candidates = new Map(managerCandidates(getAutoLearnManager())
      .map((candidate) => [candidate.key, candidate]));
  } catch { /* Policy analysis still works if learner state is temporarily unavailable. */ }

  if (agentPick.value === 'claude') {
    const settings = readSettings() || {};
    const details = invocations.map((invocation) => {
      const exact = `${shell}(${invocation.command || command})`;
      const learned = candidates.get(candidateKey(invocation));
      const assessment = claudePermissionDecision(settings, exact);
      let explanation = claudeDecisionExplanation(assessment);
      // Name the managed rule rather than gesturing at "org policy". A managed
      // ask is the single most likely reason a command whose allow entry matches
      // is still prompting, and it is knowable from the cached policy, so
      // pointing at the server-side capability list below was naming the wrong
      // cause: those restrictions have nothing to do with a command prompt.
      let managedNote = null;
      try { managedNote = managedPromptExplanation(getAutoLearnManager().explainManaged(exact)); }
      catch { /* Policy analysis is best-effort; the precedence answer still stands. */ }
      if (managedNote) explanation += `\n${managedNote}`;
      else if (assessment.decision === 'allow') {
        explanation += ' If Claude still prompted, org policy is the remaining explanation — see below.';
      }
      return `${exact}\n${explanation}\nLearner: ${learnedCandidateExplanation(
        invocation, learned, 'claude', cfg.threshold,
      )}`;
    });
    // Name the org policy explicitly. Saying "check managed policy" is useless
    // advice on a console-managed org, where there is no managed-settings.json to
    // check: restrictions are configured server-side and only their cached
    // effects are visible locally. An unqualified "ALLOW" here is exactly the
    // wrong answer to give someone whose org is prompting them.
    const restrictions = policyRestrictions(readPolicyLimits());
    const orgNote = restrictions.length
      ? `\n\nYour organization applies server-side restrictions (${policyLimitsPath()}):\n` +
        restrictions.map((name) => `  ${name}: not allowed`).join('\n') +
        '\nThese are configured in the org console, not in any local settings file, so the ' +
        'verdict above reflects your user settings only.'
      : '\n\nNo server-delivered org restrictions were found locally, but a console-managed org ' +
        'can still apply policy that leaves no local trace.';
    vscode.window.showInformationMessage('Claude permission analysis', {
      modal: true,
      detail: `Precedence: managed/org policy > deny > ask > allow > session default.\n\n${details.join('\n\n')}${orgNote}`,
    });
    return;
  }

  // The enterprise bundle outranks every user rule, so check it first. Reporting
  // "no local rule allows this" for a command the org forces a prompt on names
  // the wrong cause, and the fix it implies (write a rule) cannot work.
  const bundle = readEnterpriseBundle();
  const assessments = invocations
    .map((invocation) => ({ invocation, assessment: enterprisePolicyAssessment(bundle, invocation.argv) }));
  const enterprise = assessments.filter((entry) => entry.assessment.match);
  // A block the parser could not read is named on every managed verdict, match
  // or no match. "No managed rule governs this" is a claim about the whole
  // policy, and a parser that skipped a rule is not entitled to make it.
  const managedDegraded = assessments
    .flatMap((entry) => entry.assessment.health.unsupported)
    .map((entry) => `  requirements.toml line ${entry.line}: ${entry.reason}`);
  const degradedNote = managedDegraded.length
    ? '\n\nDEGRADED: this tool could not parse every managed prefix rule, so the verdict above ' +
      'is incomplete and a rule it skipped may be the real cause:\n' +
      [...new Set(managedDegraded)].join('\n')
    : '';
  if (enterprise.length) {
    const allowed = allowedApprovalPolicies(bundle);
    vscode.window.showInformationMessage('Codex enterprise policy', {
      modal: true,
      detail: [
        'Your organization\'s Codex policy governs this command directly, and it outranks any ' +
        'rule Auto Learn can write:',
        '',
        // The MOST RESTRICTIVE match, which is the one Codex applies. Reporting
        // the first rule in file order answered `gh repo delete` with the broad
        // `gh` prompt rule while the narrow forbidden rule below it was the real
        // decision.
        ...enterprise.map((entry) =>
          `  ${entry.assessment.match.root} — decision "${entry.assessment.match.decision}"\n` +
          `    ${entry.assessment.match.justification}` +
          (entry.assessment.matches.length > 1
            ? `\n    (${entry.assessment.matches.length} managed rules match; the most restrictive is shown)`
            : '')),
        '',
        allowed
          ? `Approval policy is also capped: the org allows only [${allowed.join(', ')}].`
          : 'No approval-policy cap was found.',
        '',
        'A user rule cannot override this. The prompt is the policy working as configured.',
        ...(assessments[0]?.assessment.blindSpots || []),
      ].join('\n') + degradedNote,
    });
    return;
  }

  const ruleSet = await codexRuleFileSetFor(cfg);
  // The await can outlive the host: deactivate kills the trust worker, and a
  // modal raised after that lands on the successor's window or on nothing.
  if (deactivated) return;
  const rules = ruleSet.files;
  const unreadable = ruleSet.failures.length
    ? `\n\nDEGRADED: ${ruleSet.failures.map((f) => `${f.path} (${f.code})`).join(', ')} could not be ` +
      'listed, so a rule file may have been missed.'
    : '';
  if (!rules.length) {
    vscode.window.showInformationMessage('Codex execpolicy analysis', {
      modal: true,
      detail: 'No enterprise rule governs this command, and no user-scope or trusted-project ' +
        '.rules files are currently visible, so Codex has no local prefix rule to allow it. ' +
        ruleSet.blindSpots.join(' ') + unreadable + degradedNote,
    });
    return;
  }

  const variants = [];
  for (let index = 0; index < invocations.length; index += 1) {
    variants.push(...codexCheckVariants(
      shell,
      index === 0 ? command : invocations[index].command,
      invocations[index],
      index === 0 ? windowsPowerShellExecutable() : null,
    ));
  }
  const uniqueVariants = [...new Map(variants.map((item) => [JSON.stringify(item.argv), item])).values()];
  try {
    const checks = [];
    for (const variant of uniqueVariants) {
      const result = await execFileCaptured(
        cfg.codexExecutable, codexExecpolicyArgs(rules, variant.argv),
      );
      checks.push(`${variant.label}: ${JSON.stringify(variant.argv)}\n${execpolicyOutputSummary(result.stdout)}`);
    }
    const learned = invocations.map((invocation) => learnedCandidateExplanation(
      invocation, candidates.get(candidateKey(invocation)), 'codex', cfg.threshold,
    ));
    vscode.window.showInformationMessage('Codex execpolicy analysis', {
      modal: true,
      // Every rule file, passed to one `codex execpolicy check` as repeated
      // `--rules`. Checking them one at a time, or checking only ours, answers a
      // question Codex never asks: it evaluates the whole visible set and
      // resolves a conflict toward the MORE RESTRICTIVE decision, so an `allow`
      // proved in isolation can be a `forbidden` in situ.
      detail: `Rules checked together (${rules.length}):\n${rules.map((file) => `- ${file.replace(os.homedir(), '~')}`).join('\n')}` +
        `\n\n${checks.join('\n\n')}\n\nLearner:\n${learned.join('\n')}` +
        `\n\n${ruleSet.blindSpots.join(' ')}` + unreadable + degradedNote,
    });
  } catch (error) {
    // The rejection may be our own teardown: deactivate kills the child, which
    // surfaces here as a failed check the user never caused.
    if (deactivated) return;
    vscode.window.showErrorMessage(
      `Codex execpolicy check failed without changing rules: ${error.detail || error.message}`
    );
  }
}

// A bare call is a watcher-driven reactive scan: coalesce a burst of transcript
// writes and scan once activity settles, using the configurable debounce (the
// thing that felt too frequent at its old 1.2s). Explicit-delay callers are
// deliberate quick refreshes after a specific action and pass their own value.
// Guarded like schedule/scheduleLocalDrain/schedulePolicyCheck. These two were
// missed by that pass, and the Auto Learn transcript watcher is the highest-
// frequency trigger in the extension — Claude Code appends to those files
// constantly, including during a reload. Measured after deactivate() resolved:
// one watcher event took active Timeouts 0 -> 1, and one
// onDidChangeConfiguration for permissionWildcarding.autoLearn took it to 2, one
// of which is a fresh 5-minute setInterval that nothing will ever clear. Each
// tick then bumps autoLearnFailureCount and autoLearnNextRetryAt, driving the
// backoff to its 60-minute ceiling — so a same-realm re-activate inherits a
// silently dead Auto Learn.
function scheduleAutoLearn(delay) {
  if (deactivated) return;
  if (delay == null) delay = autoLearnConfig().debounceSeconds * 1000;
  clearTimeout(autoLearnBounce);
  autoLearnBounce = setTimeout(() => runAutoLearnScan(false), delay);
}

function resetAutoLearnTimer() {
  // Before the clear as well as the arm: a torn-down host must not leave a
  // 5-minute interval behind, and must not clear a SUCCESSOR's either.
  if (deactivated) return;
  clearInterval(autoLearnTimer);
  const cfg = autoLearnConfig();
  if (!cfg.enabled) return;
  autoLearnTimer = setInterval(() => runAutoLearnScan(false), cfg.intervalMinutes * 60 * 1000);
}

function registerAutoLearnWatchers(context) {
  for (const [base, pattern] of [
    [path.join(os.homedir(), '.claude'), 'projects/**/*.jsonl'],
    [CODEX_HOME_DIR, 'sessions/**/*.jsonl'],
    // Flat, no date folders: archiving moves a rollout here (2026-10-13), and
    // the scan reads it, so a move is a change worth a scan.
    [CODEX_HOME_DIR, 'archived_sessions/*.jsonl'],
  ]) {
    try {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(base), pattern)
      );
      watcher.onDidChange(() => scheduleAutoLearn());
      watcher.onDidCreate(() => scheduleAutoLearn());
      watcher.onDidDelete(() => scheduleAutoLearn());
      context.subscriptions.push(watcher);
    } catch (error) {
      console.error('ai-acolyte: Auto Learn watcher failed —', error);
    }
  }
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration('permissionWildcarding.autoLearn')) return;
    invalidateAutoLearnManager();
    resetAutoLearnTimer();
    scheduleAutoLearn(100);
    dashboard?.refresh();
  }));
  resetAutoLearnTimer();
}

// Watch each workspace folder's .claude/settings.local.json — the file Claude
// Code actually writes an "always approve" into. This is the loop that was
// missing: the approval lands locally, its portable form is promoted to user
// scope, and no other project ever prompts for that command again.
function registerLocalWatchers(context) {
  const watchers = [];
  const attach = () => {
    while (watchers.length) { try { watchers.pop().dispose(); } catch { /* already gone */ } }
    for (const folder of vscode.workspace.workspaceFolders || []) {
      try {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(folder, LOCAL_RELATIVE.split(path.sep).join('/'))
        );
        watcher.onDidChange(() => scheduleLocalDrain());
        watcher.onDidCreate(() => scheduleLocalDrain());
        watchers.push(watcher);
      } catch (error) {
        console.error('ai-acolyte: local-settings watcher failed —', error);
      }
    }
  };
  // ONE subscription that drains the live list, rather than one per watcher.
  // Each watcher used to be pushed into both `watchers` and
  // `context.subscriptions`, and `attach()` drains only the former. Since
  // `attach()` re-runs on every workspace-folder change and
  // `context.subscriptions` is append-only until deactivate, every folder
  // change left another set of already-disposed watchers pinned there for the
  // life of the window. memoryLint.js keeps its watchers in a Map it prunes
  // itself and never hands them to `context.subscriptions`, for this reason.
  context.subscriptions.push({
    dispose: () => {
      while (watchers.length) { try { watchers.pop().dispose(); } catch { /* already gone */ } }
    },
  });
  attach();
  // A folder added mid-session brings its own local approvals with it. Both
  // subscriptions are feature-tested rather than assumed: an unexpected host
  // missing one must cost the drain its liveness, never activation.
  if (typeof vscode.workspace.onDidChangeWorkspaceFolders === 'function') {
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      attach();
      scheduleLocalDrain(1200);
    }));
  }
  if (typeof vscode.workspace.onDidChangeConfiguration === 'function') {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('permissionWildcarding.localDrain')) scheduleLocalDrain(200);
      if (event.affectsConfiguration('permissionWildcarding.guidance')) ensureGuidance(true);
      // gates and memory.* had no listener at all, so flipping either in the
      // Settings UI did nothing until a window reload — and memoryLint reads
      // memory.enabled once at activation, so its four keys were picked up only
      // by the 5-minute reconcile or a save event.
      if (event.affectsConfiguration('permissionWildcarding.gates')) ensureGates(true);
      if (event.affectsConfiguration('permissionWildcarding.memory')) {
        // BOTH, and in this order. Refreshing only the dashboard was worse than
        // refreshing nothing: memoryCardData() re-reads the configuration and
        // the corpus on every call, so the card went live while the linter
        // stayed exactly as activate() left it — no gauge and no diagnostics on
        // a false -> true flip, and a stale gauge on true -> false. The card
        // then asserted a feature was on when it was off.
        memoryLint?.reconfigure();
        codexMemoryLint?.reconfigure();
        dashboard?.refresh();
      }
    }));
  }
  // No second drain disposer here. There used to be one, byte-identical to the
  // one registered above and closing over the same `watchers` array, so whichever
  // ran first emptied the list and the other was a no-op over an empty array
  // forever — two entries in context.subscriptions that could only ever do one
  // thing between them. Removing the DUPLICATE is not the same as removing the
  // drain: the one above is registered before attach() and is the one under test.
}

// The panel has room for a phrase and a three-reason hover title. The full
// reasons -- which say which folders were compared and why the verdict is what
// it is -- had nowhere to go, so a user looking at "scan degraded" could not find
// out what to do about it. One line per reason, to the shared channel.
//
// Only when the set CHANGES. A scan runs every few minutes and on every
// transcript write, and a persisting condition would otherwise append the same
// lines for as long as the window is open. The manager writes reasons with
// directory names only, so nothing here is a path it did not already persist.
//
// Never allowed to throw into the scan: the channel API is absent from some test
// hosts, and a logging failure must not turn a scan that returned into one the
// card reports as failed.
//
// THE SET IS OF KINDS, NOT OF LINES (2026-10-14). The signature was the joined
// text, counts included, so "3 files could not be read" and then "4 files could
// not be read" were two sets, and a corpus whose unreadable count moved by one
// file per scan appended a line per scan: the very flood the dedupe is for. Each
// line now carries a kind (its text with every number replaced), and only a
// change in kinds logs again. The counts in the channel are the first sighting's;
// the card shows the current ones.
//
// AND THE HISTORY NOTES ARE LOGGED TOO, as notes. `codexHistoryNotes` (migrations
// recorded, archived threads with no transcript, a degraded or unavailable
// cross-check) were computed by every scan and reached only the CLI's JSON; the
// panel's hover shows reasons alone. They are information, not trouble, so they
// carry their own label and are never what makes the card say "degraded".
let lastScanTroubleLog = '';
function logScanTrouble(result) {
  try {
    if (!result || typeof result !== 'object') return;
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const lines = [];
    const add = (label, text) => lines.push({ label, text, kind: `${label}\0${String(text).replace(/\d+/g, '#')}` });
    const trouble = (text) => add('Auto Learn scan', text);
    if (result.blindScan) trouble('nothing was enumerated, so the cursor map was preserved');
    for (const reason of Array.isArray(result.codexHistoryReasons) ? result.codexHistoryReasons : []) {
      trouble(`Codex history: ${reason}`);
    }
    if (result.codexHistoryInspected === 'partial') trouble('the Codex history-store check ran degraded');
    if (result.errors) trouble(`${plural(result.errors, 'file', 'files')} could not be read`);
    if (result.unreadable) {
      trouble(`${plural(result.unreadable, 'file', 'files')} had an unreadable stretch that was skipped`);
    }
    if (result.retainedObservations) {
      trouble(`${plural(result.retainedObservations, 'observation hash', 'observation hashes')} held over the cap`);
    }
    if (result.unmatchedResults) {
      trouble(`${plural(result.unmatchedResults, 'result', 'results')} could not be matched to a call`);
    }
    for (const note of Array.isArray(result.codexHistoryNotes) ? result.codexHistoryNotes : []) {
      add('Auto Learn scan note', `Codex history: ${note}`);
    }
    const signature = lines.map((line) => line.kind).join('\n');
    if (signature === lastScanTroubleLog) return;
    lastScanTroubleLog = signature;
    if (!lines.length) return;
    const channel = sharedChannel();
    if (!channel) return;
    const stamp = new Date().toISOString();
    for (const line of lines) channel.appendLine(`[${stamp}] ${line.label}: ${line.text}`);
  } catch (error) {
    console.error('ai-acolyte: could not log Auto Learn scan trouble —', error);
  }
}

// Created on first use and disposed with the extension. Lazy rather than built
// in activate, because the mocked-vscode activation test does not stub every
// window API and a channel nobody opened costs nothing.
// Null after teardown, never a fresh channel. deactivate() disposes this one and
// nulls the slot, so a "Show detail" action clicked from a notification that
// outlived the host used to create a SECOND channel that nothing would ever
// dispose — the same empty-slot-means-build-a-new-one shape as
// getAutoLearnManager and getAutoLearnWorkerRunner, and the reason both of those
// carry a `deactivated` check at the caller.
//
// Returning null rather than a no-op stub: all three call sites write several
// lines and then `show()`, and a stub would let them believe they had rendered a
// report nobody can read. Each one checks, which is three lines against one
// silently discarded document.
function sharedChannel({ fresh = false } = {}) {
  if (deactivated) return null;
  if (!outputChannel) outputChannel = vscode.window.createOutputChannel('Acolyte');
  // Every consumer writes a SELF-CONTAINED report and none of them had a way to
  // start a clean one. Collapsing N channels into one fixed the disposal leak
  // and traded it for an unbounded document: these are palette and notification
  // actions with no call limit, so "Show blocked" ten times printed ten reports
  // with no separator, oldest first, and the reader had to scroll to find the
  // one they just asked for. The old test asserted the channel COUNT and
  // nothing about its content, which is why this survived the fix.
  if (fresh) outputChannel.clear();
  return outputChannel;
}

function activate(context) {
  // The module can outlive a deactivate (an extension disable/enable, or an
  // upgrade, re-activates in the same realm), so the teardown flag has to be
  // released here or the second activation is muted for its whole lifetime.
  deactivated = false;
  activationGeneration += 1;
  // A re-activate logs to a fresh channel, so current trouble is not "seen" yet.
  lastScanTroubleLog = '';
  // A predecessor's trust refresh was abandoned by its deactivate and will never
  // release this latch (its continuation checks the generation), so release it.
  projectTrustRefreshing = false;
  // The busy latch, released unconditionally here. deactivate() only clears it
  // when it is still the current generation — correctly, because a successor's
  // in-flight scan must not have its latch cleared by a predecessor's
  // continuation. But that leaves the mirror-image hole: if the predecessor's
  // scan never settled, its `finally` never ran, so the latch it set is still
  // true and its continuation is now forbidden from clearing it. Every later
  // scan then short-circuits as "already running" and returns null, for the life
  // of the window, and only a manual click ever surfaces the message.
  //
  // Reachable whenever a worker wedges and a re-activate follows — and an
  // extension upgrade IS a re-activate. Clearing it here is unconditionally safe
  // because activate() runs synchronously up to scheduleAutoLearn's 750 ms
  // timer, so at this instant no successor scan can exist to own the latch.
  autoLearnBusy = false;
  // And the runner slot, for the same reason and with a worse symptom. It is
  // nulled at the END of deactivate(), after the awaited drain, deliberately —
  // nothing may shorten that drain. But when the drain never completes, the
  // slot keeps the predecessor's runner, whose `deactivating` flag is sticky and
  // whose public API has no reset. getAutoLearnWorkerRunner() only builds one
  // when the slot is empty, so the successor inherits the dead instance and
  // every Auto Learn operation fails with "Auto Learn is deactivating".
  //
  // Measured: with a wedged worker and a re-activate, the busy-latch fix above
  // is not enough on its own — the successor's scan gets that error instead, so
  // this is a second stranded slot, not the same one.
  //
  // Dropping the reference here does not disturb the pending drain: deactivate()
  // already read the old runner and is awaiting a promise that holds it, so it
  // still terminates its own worker. The successor simply builds its own.
  autoLearnWorkerRunner = null;
  // warnOnce promises "once per activation", and the Set outlives deactivate, so
  // until 2026-10-13 a re-activate stayed silent about a warning already given.
  warnedOnce.clear();
  // Watch settings.json for any change (Claude Code approval, manual edit, etc.).
  // RelativePattern (not a plain string) — plain strings only watch files inside
  // opened workspace folders, but ~/.claude/settings.json usually isn't one.
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.dirname(SETTINGS)), path.basename(SETTINGS))
  );
  // Loss is checked on every settings change, not only on a policy-file event:
  // server-delivered org policy can remove approvals with no local file to watch.
  const onSettingsChanged = () => { schedule(); schedulePolicyCheck(); };
  watcher.onDidChange(onSettingsChanged);
  watcher.onDidCreate(onSettingsChanged);
  context.subscriptions.push(watcher);

  // Watch for managed policy arriving or changing. This is the case the backup
  // exists for, so it is checked once at startup and on every subsequent change
  // rather than only when the user happens to click Restore.
  for (const managedPath of policySignalPaths()) {
    try {
      const managedWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(path.dirname(managedPath)), path.basename(managedPath))
      );
      managedWatcher.onDidChange(() => schedulePolicyCheck());
      managedWatcher.onDidCreate(() => schedulePolicyCheck());
      context.subscriptions.push(managedWatcher);
    } catch { /* an unwatchable system path must never block activation */ }
  }
  // Catch a policy that landed while VS Code was closed. Not debounced: this one
  // is a single shot rather than a burst, and if settings.json happens to be
  // mid-write right now the read guard makes it a no-op instead of a false alarm.
  try { onManagedPolicyChanged(); } catch { /* never block activation */ }

  // The compiled gates file. Whoever recompiles (the CLI, or the SessionStart hook) only
  // writes this file; watching it is what turns a corpus edit into an installed block
  // without waiting for the next activation. ensureGates is a no-op when already current.
  try {
    const gatesFile = compiledPath();
    const gatesWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(gatesFile)), path.basename(gatesFile))
    );
    gatesWatcher.onDidChange(() => ensureGates());
    gatesWatcher.onDidCreate(() => ensureGates());
    gatesWatcher.onDidDelete(() => dashboard?.refresh());
    context.subscriptions.push(gatesWatcher);
  } catch { /* never block activation */ }

  // Sidebar dashboard (Activity Bar → webview).
  dashboard = new WildcardingViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(WildcardingViewProvider.viewId, dashboard)
  );
  const codexRulesWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(CODEX_HOME_DIR), 'rules/*.rules')
  );
  const refreshPermissionCounts = () => { if (!deactivated) dashboard?.refresh(); };
  codexRulesWatcher.onDidChange(refreshPermissionCounts);
  codexRulesWatcher.onDidCreate(refreshPermissionCounts);
  codexRulesWatcher.onDidDelete(refreshPermissionCounts);
  context.subscriptions.push(codexRulesWatcher);

  // Claude-only compatibility command; the dashboard action coordinates both agents.
  context.subscriptions.push(
    vscode.commands.registerCommand('permission-wildcarding.runNow', () => runWildcarding(true))
  );

  // Restore prunes from the backup after a wipe — palette / title-bar / dashboard.
  context.subscriptions.push(
    vscode.commands.registerCommand('permission-wildcarding.restoreBackup', () => restoreFromBackup())
  );

  // The full wildcard list with a filter box, for when the capped sidebar list
  // is not the right shape — reachable from the palette and from the sidebar's
  // "and N more" affordance.
  context.subscriptions.push(
    vscode.commands.registerCommand('permission-wildcarding.showWildcards', () => showWildcardPicker()),
    vscode.commands.registerCommand('permission-wildcarding.showCodexRules', () => showCodexRulePicker()),
    vscode.commands.registerCommand('permission-wildcarding.restoreCodexRules', () => showCodexRestorePicker())
  );

  // Keep the legacy command id as an alias; Auto Learn is the only history scanner.
  context.subscriptions.push(
    vscode.commands.registerCommand('permission-wildcarding.scanHistory', () => runAutoLearnScan(true)),
    vscode.commands.registerCommand('permission-wildcarding.autoLearnScan', () => runAutoLearnScan(true)),
    vscode.commands.registerCommand('permission-wildcarding.autoLearnReview', () => reviewAutoLearnCandidates()),
    vscode.commands.registerCommand('permission-wildcarding.autoLearnApplySafe', () => applyAutoLearnSafe()),
    vscode.commands.registerCommand('permission-wildcarding.autoLearnUndo', () => undoAutoLearn()),
    vscode.commands.registerCommand('permission-wildcarding.autoLearnCycleMode', () => cycleAutoLearnMode()),
    vscode.commands.registerCommand('permission-wildcarding.autoLearnWhy', () => explainAutoLearnPrompt()),
    vscode.commands.registerCommand('permission-wildcarding.autoLearnShowBlocked', () => showAutoLearnBlocked()),
    vscode.commands.registerCommand('permission-wildcarding.derivedGuidance', () => showDerivedGuidance())
  );

  // Rebuild the recall (CPU bge-small) vector cache from the Memory card.
  const codexFeatures = createCodexFeaturesUi(vscode, {
    profileOptions: { home: os.homedir(), codexHome: CODEX_HOME_DIR },
    readMemory: (query) => query ? runAutoLearnWorker('codexMemorySearch', { query, recallOptions: codexRecallOptions() })
      : runAutoLearnWorker('codexMemory'),
    rebuildMemory: () => runAutoLearnWorker('rebuildCodexMemory', { recallOptions: codexRecallOptions() }),
    runRules: (operation, request) => runAutoLearnWorker(operation, request),
    refresh: () => dashboard?.refresh(),
  });
  codexFeatureUi = codexFeatures;
  const permissionActions = createPermissionActions({
    runClaude: () => runWildcarding(true),
    reviewCodex: () => codexFeatures.reviewRules('stored-widening'),
    isActive: () => !deactivated,
  });
  context.subscriptions.push(permissionActions,
    vscode.commands.registerCommand('permission-wildcarding.optimizePermissions', async () => {
      try { await permissionActions.optimize(); }
      catch (error) {
        if (!deactivated) vscode.window.showErrorMessage(`AI Acolyte: permission optimization failed: ${error.message}`);
      }
    }),
    vscode.commands.registerCommand('permission-wildcarding.viewPermissions', (selection) => showSavedPermissionPicker(selection)),
    vscode.commands.registerCommand('permission-wildcarding.restorePermissions', () =>
      choosePermissionAgent('Restore permissions', restoreFromBackup, showCodexRestorePicker)),
    vscode.commands.registerCommand('permission-wildcarding.importPermissions', () =>
      choosePermissionAgent('Import project permissions', () => drainLocal(true), () => codexFeatures.reviewRules('project-import')))
  );
  codexMemoryGatesUi = createCodexMemoryGatesUi(vscode, {
    codexHome: CODEX_HOME_DIR,
    run: (operation, request) => runAutoLearnWorker(operation, request),
    refresh: () => { if (!deactivated) dashboard?.refresh(); },
  });
  context.subscriptions.push(codexMemoryGatesUi,
    vscode.commands.registerCommand('permission-wildcarding.codexMemoryGates', () => codexMemoryGatesUi?.review()));
  codexMemoryGatesUi.activate();
  context.subscriptions.push(codexFeatures,
    vscode.commands.registerCommand('permission-wildcarding.codexHook', () => codexFeatures.configureHook()),
    vscode.commands.registerCommand('permission-wildcarding.searchCodexMemory', () => codexFeatures.searchMemory()),
    vscode.commands.registerCommand('permission-wildcarding.rebuildCodexMemory', () => codexFeatures.rebuildMemoryIndex()),
    vscode.commands.registerCommand('permission-wildcarding.inspectCodexMemory', () => codexFeatures.inspectMemory()),
    vscode.commands.registerCommand('permission-wildcarding.reviewCodexApprovals', () => codexFeatures.reviewRules('stored-widening')),
    vscode.commands.registerCommand('permission-wildcarding.reviewCodexMcp', () => codexFeatures.reviewMcp()),
    vscode.commands.registerCommand('permission-wildcarding.importCodexRules', () => codexFeatures.reviewRules('project-import'))
  );
  try {
    const nativeLint = new CodexMemoryLint(vscode, {
      codexHome: CODEX_HOME_DIR,
      readMemory: () => runAutoLearnWorker('codexMemory'),
      enabled: () => memoryConf().enabled !== false,
      onRefresh: (report) => {
        if (deactivated || codexMemoryLint !== nativeLint) return;
        codexMemoryReport = report;
        dashboard?.refresh();
      },
    });
    codexMemoryLint = nativeLint;
    context.subscriptions.push(nativeLint);
    nativeLint.activate();
  } catch (error) {
    codexMemoryReport = { error: `Native Codex memory diagnostics could not start: ${error.message}` };
    console.error('AI Acolyte:', codexMemoryReport.error);
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('permission-wildcarding.rebuildRecall', () => rebuildRecall())
  );

  // Compatibility-only command ids from releases that exposed MAX. They are
  // deliberately absent from package.json and can only remove legacy state.
  context.subscriptions.push(
    vscode.commands.registerCommand('permission-wildcarding.toggleMax', () => offerLegacyCleanup({ explicit: true })),
    vscode.commands.registerCommand('permission-wildcarding.toggleCodexMax', () => offerLegacyCleanup({ explicit: true }))
  );

  // Project-local approvals → user scope, and the shell-style block that stops
  // the un-generalizable approvals being created in the first place.
  context.subscriptions.push(
    vscode.commands.registerCommand('permission-wildcarding.drainLocal', () => drainLocal(true)),
    vscode.commands.registerCommand('permission-wildcarding.toggleGuidance', () => toggleGuidance()),
    vscode.commands.registerCommand('permission-wildcarding.toggleGates', () => toggleGates())
  );
  try {
    registerLocalWatchers(context);
  } catch (err) {
    console.error('ai-acolyte: local-settings watchers failed —', err);
  }

  // Process once on activation to catch anything missed while VS Code was closed.
  runWildcarding();
  // Same for approvals that landed in a project's settings.local.json, and for
  // the guidance block — an upgrade refreshes stale wording, and neither writes
  // anything when the state is already right.
  drainLocal();
  offerLegacyCleanup({ explicit: false });
  ensureGuidance();
  // Gates too. Install-only: this never spawns python, so a corpus edit reaches the block
  // through the compiled file that the CLI or the SessionStart hook last wrote.
  ensureGates();
  startAutoLearn(context);
  // Sync the recall index on startup when the model is present and the cache is behind
  // the corpus. Deferred 10 s so the extension host settles first.
  recallSyncTimer = setTimeout(autoSyncRecallIfStale, 10000);

  // Memory-index hygiene lint: status-bar bloat gauge + editor squiggles on over-budget
  // hook lines / broken index links. Isolated so a failure here never breaks wildcarding.
  try {
    // Module-scoped, not block-local: the configuration listener needs a handle
    // on it. Without one it could only refresh the dashboard card, which is how
    // the card ended up reporting live memory data for a linter that was off.
    memoryLint = new MemoryLint();
    memoryLint.activate(context);
    // The two watcher sets below reconcile on the LINTER's cadence rather than a third
    // timer of their own: it already re-discovers these same directories every 5 minutes,
    // on every MEMORY.md save or open, and 300 ms after every external write. Only the
    // 5-minute backstop is unconditional — the save/open/write half lives on the linter's
    // enabled path — which is why memoryLint.activate() arms that timer ABOVE its
    // `memory.enabled` check. It used to arm it inside initialize(), below that check, so
    // with the lint switched off these two sets got the one initial build below and were
    // never reconciled again for the life of the window. Registering
    // the subscriber before the initial build is harmless -- the build below is
    // unconditional -- and keeping it inside this try means a linter that failed to
    // activate cannot take the initial build down with it.
    context.subscriptions.push(memoryLint.onReconcile(() => reconcileMemoryWatchers()));
  } catch (err) {
    console.error('ai-acolyte: memory lint failed to activate —', err);
  }

  // The initial build of both memory-store watcher sets. Every later rebuild comes through
  // the reconcile subscriber above.
  try {
    reconcileMemoryWatchers();
    // ONE disposer for both sets, not one subscription per watcher. The sets churn as
    // stores come and go, and pushing each watcher would grow context.subscriptions for the
    // life of the window with entries that reconcileMemoryWatchers has already disposed --
    // the same leak shape the folder-change watchers were fixed for.
    context.subscriptions.push({ dispose: () => disposeMemoryWatchers() });
  } catch (err) {
    console.error('ai-acolyte: memory-store watchers failed —', err);
  }
}

// ── the two memory-store watcher sets this file owns ──────────────────────────
// Keyed by store directory so they can be RECONCILED rather than built once at activation.
// memoryLint.js documents this hazard in its own header and solves it for its own set with
// syncWatchers() plus a periodic re-discovery; these two never got that fix, and they are
// the ones wired to the gate compiler. Claude Code derives the project slug from the
// working directory, so a session launched from a different root mints a new store: it went
// unwatched until a window reload, and a store that went away left a dead watcher until
// deactivate().
const memoryCardWatchers = new Map();    // dir -> MEMORY.md watcher, keeps the Memory card live
const gatesCorpusWatchers = new Map();   // dir -> *.md watcher, triggers the gate recompile

// Every store on disk, read from the LIVE configuration on each call -- which is half of
// what makes a reconcile a reconcile, since memory.* can change at runtime.
//
// memoryConf(), not a hand-built literal, so the memory.* keys are enumerated in exactly one
// place. But `dir: ''` is restored ON PURPOSE, and it is not the staleness the first version
// of this comment blamed: discoverDirs reads ONLY conf.dir, so the missing `maxLines` in the
// old literal could not produce any behaviour at all.
//
// The real reason to override it: memory.dir answers "which store do I LINT", and these
// watchers ask "which stores exist". Passing the pin through conflated them, and
// discoverDirs returns [] for a configured dir with no MEMORY.md (a typo, or a store not
// written to yet). Both loops then ran zero times, built zero watchers, and logged nothing --
// silently disabling automatic gate recompilation, since the *.md watcher is one of only two
// callers of compileGates.
function memoryStoreDirs() {
  const watchConf = { ...memoryConf(), dir: '' };
  return discoverDirs(watchConf);
}

// Keep the dashboard's Memory card live as MEMORY.md changes (an agent editing it outside
// the editor still fires this). Best-effort — the card also refreshes on panel visibility
// and after a rebuild, so a watcher failure is non-fatal.
function memoryCardBump() {
  clearTimeout(memBounce);
  memBounce = setTimeout(() => { dashboard?.refresh(); autoSyncRecallIfStale(); }, 350);
}

// Recompile the gates when the corpus that produced them changes.
//
// A SessionStart hook would be the obvious home for this and it does not work under a
// managed policy. Enforcement of `allowManagedHooksOnly` is PER EVENT: a user hook runs
// only on an event the managed policy itself defines. Measured on a box whose policy
// defines PostToolUse and nothing else — a user PostToolUse canary fired 4 times out of 4,
// while a real session start and a /clear both left the compiled file untouched.
//
// A memory file changing is the better trigger regardless. It is the actual cause, it
// fires once per edit instead of once per session, and the extension is not a hook, so no
// policy can switch it off. Gated on the block already being installed, so this never
// spawns python for anyone who has not opted in.
function gatesCorpusBump(uri) {
  // The index carries hooks, never gate blocks, and it changes far more often.
  if (uri && path.basename(uri.fsPath) === 'MEMORY.md') return;
  if (!gatesEnabled()) return;
  try {
    if (!gatesStatusAll().some((state) => state.on)) return;
  } catch { return; }
  clearTimeout(gatesBounce);
  // Long debounce on purpose: editing a memory tends to save several times, and each
  // compile is a python spawn.
  gatesBounce = setTimeout(() => {
    compileGates({ quiet: true }).then((ok) => { if (ok) ensureGates(); });
  }, 2000);
}

// Add watchers for dirs that appeared, drop the ones whose dir went away. memoryLint.js's
// syncWatchers, applied to a second and third set.
function syncWatcherSet(watchers, dirs, glob, handler) {
  for (const [dir, watcher] of watchers) {
    if (dirs.has(dir)) continue;
    try { watcher.dispose(); } catch { /* already gone with the extension host */ }
    watchers.delete(dir);
  }
  for (const dir of dirs) {
    if (watchers.has(dir)) continue;
    const w = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dir), glob)
    );
    w.onDidChange(handler); w.onDidCreate(handler); w.onDidDelete(handler);
    watchers.set(dir, w);
  }
}

function reconcileMemoryWatchers() {
  // Every path in here can land after teardown: the linter's own debounce and 5-minute
  // interval both survive deactivate() until VS Code drains the subscriptions, and a
  // rebuild then creates watchers into maps nothing will drain again.
  if (deactivated) return;
  // ONE discovery for both sets. Two would double the readdir/existsSync cost of every
  // reconcile and could hand the two sets different answers if a store appeared between them.
  const dirs = new Set(memoryStoreDirs());
  syncWatcherSet(memoryCardWatchers, dirs, 'MEMORY.md', memoryCardBump);
  syncWatcherSet(gatesCorpusWatchers, dirs, '*.md', gatesCorpusBump);
}

function disposeMemoryWatchers() {
  for (const watchers of [memoryCardWatchers, gatesCorpusWatchers]) {
    for (const [, watcher] of watchers) {
      try { watcher.dispose(); } catch { /* nothing left to release */ }
    }
    watchers.clear();
  }
}

// Learn on startup, on either agent's JSONL appends, and periodically to
// reconcile events missed while the extension host was suspended.
// This sits immediately after activate() so all dashboard state already exists.
function startAutoLearn(context) {
  registerAutoLearnWatchers(context);
  scheduleAutoLearn(750);
}

function readCodexConfigState() {
  try { return { readable: true, exists: true, text: fs.readFileSync(CODEX_CONFIG, 'utf8') }; }
  catch (error) {
    if (error?.code === 'ENOENT') return { readable: true, exists: false, text: '' };
    return { readable: false, exists: true, text: null, error };
  }
}

function readCodexConfigText() {
  const state = readCodexConfigState();
  return state.readable ? state.text : null;
}

async function offerLegacyCleanup({ explicit = false } = {}) {
  if (deactivated) return;
  const settingsState = readSettingsState();
  const codexState = readCodexConfigState();
  if (settingsState.state === SETTINGS_UNREADABLE || !codexState.readable) {
    if (explicit) {
      const unreadable = [
        settingsState.state === SETTINGS_UNREADABLE ? 'Claude settings.json' : null,
        !codexState.readable ? 'Codex config.toml' : null,
      ].filter(Boolean).join(' and ');
      vscode.window.showWarningMessage(
        `ai-acolyte: ${unreadable} could not be read safely; legacy cleanup left every artifact unchanged.`
      );
    }
    return;
  }
  const claude = legacyClaudeMaxStatus(settingsState.settings ?? {});
  const codex = legacyCodexMaxStatus(codexState.text);

  // Blanket-looking grants and approval_policy="never" are valid user choices
  // on their own. An exact old hook is current ownership evidence; either
  // snapshot can be stale after MAX was turned off. The review names the exact
  // proposed delta before a second, modal confirmation.
  const shouldOffer = explicit
    ? claude.present || codex.present || claude.snapshotExists || codex.snapshotExists
    : claude.candidate;
  if (!shouldOffer) {
    if (explicit) {
      vscode.window.showInformationMessage(
        'ai-acolyte: no owned legacy MAX configuration was found. The feature cannot be enabled.'
      );
    }
    return;
  }

  const review = 'Review legacy cleanup';
  const choice = await vscode.window.showWarningMessage(
    'permission-wildcarding found configuration shaped like the retired MAX feature. ' +
    'Old snapshot files can outlive the feature, so no permission is changed automatically.',
    review,
    'Keep unchanged'
  );
  if (choice !== review || deactivated) return;

  const found = [];
  if (claude.present) {
    found.push(`Claude: generated grants proposed for removal: ` +
      `${claude.generatedAllow.length ? claude.generatedAllow.join(', ') : 'none'}; ` +
      `owned approve hook ${claude.hook ? 'found' : 'not found'}, ` +
      `valid restore snapshot ${claude.snapshotValid ? 'found' : 'not found'}.`);
  } else if (claude.snapshotExists) {
    found.push('Claude: no active legacy layer found; the saved snapshot will be used only to purge retired grants from verified backup copies.');
  }
  if (codex.present) {
    found.push(`Codex: approval_policy="never" found; valid restore snapshot ` +
      `${codex.snapshotValid ? 'found' : 'not found'}; proposed restore ` +
      `${codex.snapshotValid ? codex.savedApproval ?? 'unset' : 'unavailable'}.`);
  } else if (codex.snapshotExists) {
    found.push('Codex: no active legacy value found; the stale snapshot can be removed without changing config.toml.');
  }
  const remove = 'Remove legacy configuration';
  const confirmed = await vscode.window.showWarningMessage(
    'Remove legacy MAX configuration?', {
      modal: true,
      detail: found.join('\n') +
        '\n\nSnapshots can outlive MAX-off. Review the values above: an identical grant or "never" ' +
        'chosen later by you is indistinguishable from the retired feature. Cleanup preserves ' +
        'all other permissions and hooks and refuses invalid restore data. Restart the affected agent after cleanup.',
    }, remove
  );
  if (confirmed !== remove || deactivated) return;
  await cleanupLegacyMaxConfiguration();
}

async function cleanupLegacyMaxConfiguration() {
  if (deactivated) return;
  const notes = [];
  const warnings = [];

  try {
    let claudeResult = null;
    let backupResult = null;
    const retiredBackupEntries = legacyGeneratedAllowFromState();
    getPolicyLock().locked(() => {
      ({ result: claudeResult } = settingsWriter.writeTransform((latest) =>
        removeLegacyClaudeMax(latest, { confirmAmbiguous: true })));
      // The settings writer maintains a high-water backup as part of its write,
      // so purge only after that transform and under the same cross-process
      // lock. Each physical copy is edited and verified independently.
      backupResult = purgeLegacyBackupCopies(
        [LATEST_BACKUP, mirrorBackupPath()],
        retiredBackupEntries,
      );
    });
    const verifiedState = readSettingsState();
    const verifiedClaude = verifiedState.state === SETTINGS_UNREADABLE
      ? null : legacyClaudeMaxStatus(verifiedState.settings ?? {});
    if (!verifiedClaude || verifiedClaude.present) {
      warnings.push('Claude cleanup could not verify that all legacy configuration was removed; artifacts were retained');
    } else if (claudeResult?.changed) {
      notes.push('Claude settings restored');
    }
    if (!backupResult?.ok) {
      const failed = (backupResult?.failures ?? []).map((entry) => entry.file).join(', ');
      warnings.push(`legacy backup cleanup could not verify every copy${failed ? ` (${failed})` : ''}; the migration snapshot was retained`);
    } else if (backupResult.changed) {
      notes.push('legacy backup copies cleaned');
    }
    if (verifiedClaude && !verifiedClaude.present
      && claudeResult?.canRemoveArtifacts && backupResult?.ok) {
      const script = removeLegacyApproveScript();
      removeLegacyStateFile(LEGACY_CLAUDE_STATE_FILE);
      if (script.reason === 'ownership-ambiguous') warnings.push('approve-all.js was not removed because its contents are not owned by this extension');
    }
    warnings.push(...(claudeResult?.warnings ?? []));
  } catch (error) {
    warnings.push(`Claude cleanup failed: ${error.message}`);
  }

  try {
    const before = readCodexConfigText();
    if (before !== null) {
      const codexResult = removeLegacyCodexMax(before, { confirmAmbiguous: true });
      if (codexResult.changed) {
        const current = readCodexConfigText();
        if (current !== before) throw new Error('config.toml changed during cleanup; nothing was written');
        writeFileAtomicSync(CODEX_CONFIG, codexResult.text);
        const verified = fs.readFileSync(CODEX_CONFIG, 'utf8');
        if (verified !== codexResult.text || legacyCodexMaxStatus(verified).present) {
          throw new Error('config.toml verification failed');
        }
        removeLegacyStateFile(LEGACY_CODEX_STATE_FILE);
        notes.push(`Codex approval policy restored to ${codexResult.restoredTo ?? 'its default'}`);
      }
      warnings.push(...codexResult.warnings);
    }
  } catch (error) {
    warnings.push(`Codex cleanup failed: ${error.message}`);
  }

  dashboard?.refresh();
  if (notes.length) {
    vscode.window.showInformationMessage(
      `ai-acolyte: legacy cleanup complete. ${notes.join('; ')}. Restart the affected agent.`
    );
  }
  if (warnings.length) {
    vscode.window.showWarningMessage(
      `ai-acolyte: legacy cleanup left items unchanged. ${[...new Set(warnings)].join('; ')}.`
    );
  }
  if (!notes.length && !warnings.length) {
    vscode.window.showInformationMessage('ai-acolyte: no legacy configuration needed a change.');
  }
}


function getPolicyLock() {
  if (!policyLock) policyLock = createPolicyLock({ lockPath: POLICY_LOCK_PATH });
  return policyLock;
}

function schedule(delay = 400) {
  // See schedulePolicyCheck: a watcher event during deactivate's awaited drain
  // re-armed this and wrote settings.json after teardown.
  if (deactivated) return;
  clearTimeout(debounceTimer);
  // 400ms debounce — Claude Code may write settings.json in several rapid bursts.
  debounceTimer = setTimeout(() => runWildcarding(), delay);
}

// `wildcardingHint(after)` used to sit here, handing the push an { allow,
// optimized } pair so it could skip a second processAllowList over the list this
// pass had just computed. The push only needed that pass for `pendingWildcard`,
// the "Wildcard Now" badge, and that field lost its last reader in the webview at
// ee46cf5. Removed 2026-10-14 with the field, the push's own pass, the provider's
// `hint` slot and `sameList`: the push now runs no wildcarding pass at all, so
// there is nothing left for a hint to save (test/dashboard-view.test.js, "one
// push per burst, and the push never runs the wildcarding pass").

// Generalize + prune the allow list. `manual` = invoked via the button/command
// (surface a status message even when nothing changed).
function runWildcarding(manual = false) {
  // Already optimal: the ~95% case. Factored out because it is now reachable from
  // two places — the unlocked probe below, and the post-lock path when somebody
  // else generalized the list while we were waiting.
  //
  // backupPolicy runs HERE, on the unchanged path, and that is load-bearing. It is
  // the only thing that rebuilds a DELETED backup, which is not hypothetical: on
  // 2026-09-09 every directory under ~/.claude was recreated and this path is what
  // restored the mirror. It self-short-circuits when the union is unchanged, so it
  // costs a backup read, not a write. deny rides along because this is the path
  // that runs on every settings change, so it is where a deny rule added by hand
  // first reaches the backup.
  const reportAlreadyOptimal = (list, deny) => {
    backupPolicy(list, deny);
    if (manual) vscode.window.setStatusBarMessage('$(shield) ai-acolyte: Claude permissions already optimal', 4000);
    dashboard?.refresh();
  };

  // ── the unlocked probe ──────────────────────────────────────────────────────
  //
  // The read and the pass used to happen INSIDE the lock, so every settings.json
  // change paid a full lock cycle just to discover there was nothing to do. Same
  // mistake, and the same fix, as bin/wildcard-perms:463-472#NEGATIVE — this read is a
  // NEGATIVE TEST ONLY, which is what makes it safe unlocked. If the list is
  // already a fixed point we write nothing, so a stale read costs nothing. The
  // moment it differs, everything authoritative is redone inside the lock.
  //
  // The lock cycle is 3.4-3.7 ms of file operations (46% of it a single
  // fsyncSync), but milliseconds are the smaller half of the argument. The real
  // win is CONTENTION. Auto Learn is on by default, scans every 5 minutes plus a
  // 20-second debounce on the highest-frequency watcher in this extension, and its
  // scan() holds this same lock across the ENTIRE transcript corpus read. The
  // 20-deep `lockedRetries` budget with a 1500 ms backoff below — up to ~30
  // seconds of deferral — is evidence that this race was observed, not predicted.
  // On the unchanged path the pass can now no longer lose it at all.
  //
  // And the lock never protected this read from the file's highest-frequency
  // writer anyway: Claude Code does not take it.
  const settings = readSettings();
  if (!settings) {
    // Reset here too. Before the probe moved out of the lock, this path ran
    // AFTER the lock cycle and so reached the reset below; now it returns first.
    // I claimed in the commit that the budget "is now also reset on the early
    // return" — true for the already-optimal return, not for this one, which is
    // an absent or mid-write settings.json.
    lockedRetries = 0;
    dashboard?.refresh();
    return;
  }
  const before = settings?.permissions?.allow ?? [];
  const after = processAllowList(before);

  if (JSON.stringify(before) === JSON.stringify(after)) {
    // Reset here too. The budget used to be cleared only after a completed lock
    // cycle, and an early return that never reaches the lock would otherwise
    // strand it — leaving a window of contention permanently spent.
    lockedRetries = 0;
    reportAlreadyOptimal(after, settings?.permissions?.deny);
    return;
  }

  // ── a write is due, so now take the lock ────────────────────────────────────
  //
  // The probe's snapshot is DISCARDED and everything recomputed from a read taken
  // inside the lock. This is not defensive tidiness, it is required:
  // `writeAllow` replays a delta computed against the CALLER's snapshot, and its
  // own note (src/settings-write.js:173-179#NOTE) names this caller — "WRONG for one
  // whose whole output is a function of the list it read … Such a caller must
  // re-read and recompute first, so `settings` IS `latest` and this degenerates
  // to identity."
  //
  // Until now this function satisfied that precondition only BY ACCIDENT, because
  // its read happened to sit inside the lock. Handing writeAllow the probe's
  // snapshot instead would let another writer add or restore an entry between
  // the probe and this write, then replay a stale removal over that newer state.
  //
  // So the changed path now runs the pass twice. That is the correct trade: it is
  // the ~5% case, it already pays for an atomic write, and 3.2 ms of recompute
  // buys back the only guarantee that makes the delta replay sound.
  let locked;
  let lockedBefore;
  let lockedAfter;
  // What the write REPORTS, as opposed to what this function intended. See the
  // report block below: `writeAllow` rebases onto its own fresh read, so its
  // counts are the only honest ones and there is one more read between the
  // locked snapshot and the bytes on disk than `lockedBefore` can see.
  let written = null;
  try {
    getPolicyLock().locked(() => {
      locked = readSettings();
      if (!locked) return;
      lockedBefore = locked?.permissions?.allow ?? [];
      lockedAfter = processAllowList(lockedBefore);
      if (JSON.stringify(lockedBefore) === JSON.stringify(lockedAfter)) return;
      written = writeAllow(locked, lockedAfter);
      lastRun = Date.now();
    });
  } catch (err) {
    if (err?.code === POLICY_LOCK_CODE) {
      // Auto Learn is mid-scan or mid-apply. Its write fires the watcher again,
      // so a bounded retry keeps the list converging without spinning.
      if (lockedRetries < 20) { lockedRetries += 1; schedule(1500); }
      dashboard?.refresh();
      return;
    }
    vscode.window.showErrorMessage(`ai-acolyte: write failed — ${err.message}`);
    dashboard?.refresh();
    return;
  }
  lockedRetries = 0;
  if (!locked) { dashboard?.refresh(); return; }

  // Reported from the LOCKED read, not the probe, because that is what the write
  // actually rebased onto. Reachable when another writer generalized the list
  // between the probe and the lock — and it also still guards the watcher loop
  // (our own write re-fires the watcher; the second pass short-circuits at the
  // probe above).
  if (JSON.stringify(lockedBefore) === JSON.stringify(lockedAfter)) {
    reportAlreadyOptimal(lockedAfter, locked?.permissions?.deny);
    return;
  }

  {
    // THE COUNTS COME FROM THE WRITE. `addedAllow` and `removedAllow` are
    // measured inside writeAllow against the read it actually rebased onto, and
    // the note beside them says in as many words that a caller computing a
    // removal count from its own pre-write snapshot is doing the thing the
    // measurement exists to replace. `removedAllow` was added to retire exactly
    // this call site and the call site was never switched over.
    //
    // `lockedBefore` is one read too early to be honest even inside the lock:
    // Claude Code does not take our policy lock, so it can land a settings write
    // between our locked read and writeAllow's own re-read, and every number
    // below was then describing a list that no longer existed. The already-
    // optimal short-circuit above still compares the locked pair, because that
    // question is "did OUR pass have anything to do", not "what landed".
    //
    // The NAMES are still derived from the locked pair, and deliberately: the
    // write returns counts, not lists, and the detail pane is a description of
    // what this pass generalized rather than a claim about the file. The numbers
    // are the part a reader acts on and the part that was wrong.
    const addedList = lockedAfter.filter(p => !lockedBefore.includes(p));
    const added = written ? written.addedAllow : 0;
    const removed = written ? written.removedAllow : 0;
    const total = written ? written.allow.length : lockedAfter.length;
    if (added || removed) {
      vscode.window.showInformationMessage(
        `ai-acolyte: wildcarded ${added} permission${added !== 1 ? 's' : ''}, pruned ${removed} — ${total} total`,
        { detail: addedList.map(p => `→ ${p}`).join('\n') }
      );
      vscode.window.setStatusBarMessage(
        `$(shield) ai-acolyte: +${added} -${removed} → ${total} entries`,
        5000
      );
    }
  }

  dashboard?.refresh();
}

// ── project-local approvals ─────────────────────────────────────────────────────
// Claude Code persists an "always approve" into the *project's*
// .claude/settings.local.json, so that is where approvals actually pile up — and
// nothing here used to read it. Promote the portable ones to user scope, where
// one entry covers every project, then drop the local entries user scope now
// covers. src/local-settings.js owns the rules; this owns the VS Code wiring.

function localDrainEnabled() {
  return vscode.workspace.getConfiguration('permissionWildcarding').get('localDrain.enabled', true);
}

// The folders whose .claude/settings.local.json this window looks at: one file per
// open workspace folder, at its root and never beneath it, because
// localSettingsPath is a single non-recursive join. ONE copy, read by both the
// drain and the dashboard card. Until 2026-10-13 localCardData carried its own
// duplicate of this filter, and the duplicate had already drifted: it lacked the
// trust gate below, so an untrusted window showed dry-run numbers for a file the
// drain refused to touch.
//
// Recursive discovery of nested settings.local.json files was considered and
// declined, 2026-10-13. A nested clone's approvals were granted for that clone, and
// promoting them into user scope from a parent window is the same trust problem the
// gate below exists for. A Claude session running in a subfolder is covered anyway:
// the CLI hook drains each session's own cwd on every tool call
// (bin/wildcard-perms:507-516#hookCwd, `hookCwd(input)`).
//
// A folder on another file system (a virtual workspace, or a non-file scheme mixed
// into a multi-root workspace) has an fsPath that names no file on this disk, so
// reading it would report, and draining it would rewrite, whatever local file sits
// at the same path. The same `uri.scheme` test codexMemoryLint.js:51#uri.scheme applies. A
// folder with no scheme at all is kept, as there.
function localRoots() {
  return (vscode.workspace.workspaceFolders || [])
    .filter((folder) => !folder.uri.scheme || folder.uri.scheme === 'file')
    .map((folder) => folder.uri.fsPath)
    .filter((root) => fs.existsSync(localSettingsPath(root)));
}

// Writing into a workspace's .claude/ changes that project's files, so an
// untrusted window reads but never writes — the same line the Codex
// workspace-scope rule writer draws.
function drainableRoots() {
  if (!vscode.workspace.isTrusted) return [];
  return localRoots();
}

function drainOneWorkspace(root, dryRun = false) {
  return drainLocalSettings({
    workspaceRoot: root,
    readUserSettings: readSettings,
    // The extension's own merge: rebase onto the newest settings.json and refresh
    // the high-water backup, so a promoted entry is protected by the policy guard
    // exactly like an approval the wildcarding pass generalized.
    applyUserAllow: (entries) => {
      const settings = readSettings() ?? {};
      const existing = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
      writeAllow(settings, processAllowList([...new Set([...existing, ...entries])]));
    },
    dryRun,
  });
}

// Drain every open workspace folder. `manual` surfaces a message even when there
// was nothing to do, so the button always answers.
function drainLocal(manual = false) {
  if (!manual && !localDrainEnabled()) return;
  const roots = drainableRoots();
  if (!roots.length) {
    if (manual) {
      vscode.window.setStatusBarMessage(
        vscode.workspace.isTrusted
          ? '$(shield) ai-acolyte: no .claude/settings.local.json in this workspace'
          : '$(shield) ai-acolyte: workspace is not trusted — local drain skipped',
        5000);
    }
    return;
  }

  const reports = [];
  try {
    getPolicyLock().locked(() => {
      for (const root of roots) reports.push(drainOneWorkspace(root));
    });
  } catch (err) {
    if (err?.code === POLICY_LOCK_CODE) {
      // Auto Learn holds the lock; its write fires the settings watcher and we
      // come back through here. Only a manual click deserves a message.
      if (manual) vscode.window.setStatusBarMessage(`$(shield) ai-acolyte: ${POLICY_LOCK_BUSY_MESSAGE}`, 5000);
      return;
    }
    if (err?.code === SETTINGS_UNREADABLE_CODE) {
      // settings.json is mid-write. Promoting a project-local entry can wait; the
      // entries stay in settings.local.json until a later pass picks them up, so a
      // retry is enough and a startup toast about a transient is not. Bounded,
      // because a file that stays unparseable is a different problem and retrying
      // it every three seconds forever would not be the fix for it.
      if (localDrainRetries < 20) { localDrainRetries += 1; scheduleLocalDrain(3000); }
      if (manual) {
        vscode.window.setStatusBarMessage(
          '$(shield) ai-acolyte: settings.json is mid-write — retrying the drain shortly', 5000);
      }
      return;
    }
    vscode.window.showErrorMessage(`ai-acolyte: local drain failed — ${err.message}`);
    return;
  }
  localDrainRetries = 0;

  if (reports.some((report) => report.blocked === 'legacy-blanket')) {
    if (manual) {
      vscode.window.showWarningMessage(
        'ai-acolyte: legacy Bash(*) and PowerShell(*) grants cover every ' +
        'project-local entry, so draining could empty that file. Remove the legacy ' +
        'configuration first.');
    }
    dashboard?.refresh();
    return;
  }

  const promoted = reports.flatMap((report) => report.promoted);
  const pruned = reports.reduce((sum, report) => sum + report.pruned.length, 0);
  if (promoted.length || pruned) {
    lastRun = Date.now();
    vscode.window.showInformationMessage(
      `ai-acolyte: promoted ${promoted.length} project-local approval${promoted.length !== 1 ? 's' : ''} ` +
      `to user scope, pruned ${pruned} now-redundant local ${pruned === 1 ? 'entry' : 'entries'}`,
      { detail: promoted.map((p) => `→ ${p}`).join('\n') }
    );
  } else if (manual) {
    const kept = reports.reduce((sum, report) => sum + report.kept, 0);
    vscode.window.setStatusBarMessage(
      `$(shield) ai-acolyte: nothing to promote — ${kept} local ` +
      `${kept === 1 ? 'entry is' : 'entries are'} project-specific`, 5000);
  }
  dashboard?.refresh();
}

function scheduleLocalDrain(delay = 900) {
  // See schedulePolicyCheck. This one also self-reschedules on contention, up
  // to 20 times, so an unguarded arm could keep writing for about a minute.
  if (deactivated) return;
  clearTimeout(localDrainBounce);
  localDrainBounce = setTimeout(() => drainLocal(), delay);
}

// Dashboard numbers come from a dry run over each folder, so the card shows what
// a click would actually do rather than a raw entry count.
//
// The folders are localRoots(), the list drainableRoots() gates, so the card cannot
// name a file the drain would skip. An untrusted window still lists its files,
// because naming what is being left alone is a read, but it runs no dry run:
// promote, prune and kept are null and the card shows dashes. Before 2026-10-13 it
// computed all three anyway, so an untrusted window read "Project-local approvals:
// N to drain" over a Drain button that could never act on them.
//
// `files` is every file inspected, home-relative, one per root. With two or more
// folders the payload used to carry only the bare LOCAL_RELATIVE constant, so the
// subtitle read "2 folders · .claude\settings.local.json" and named no file at all.
function localCardData() {
  const roots = localRoots();
  if (!roots.length) return null;
  const trusted = vscode.workspace.isTrusted;
  let promote = null; let prune = null; let kept = null; let blocked = false;
  if (trusted) {
    promote = 0; prune = 0; kept = 0;
    for (const root of roots) {
      const report = drainOneWorkspace(root, true);
      if (report.blocked) { blocked = true; kept += report.kept; continue; }
      promote += report.promote.length;
      prune += report.prune.length;
      kept += report.kept;
    }
  }
  // No `folders` (the card counts `files`) and no `lastRun` since 2026-10-14: the
  // webview read neither, and `lastRun` was the only reader of a module-level
  // `localDrainAt` stamp that every changing drain kept writing.
  return {
    files: roots.map((root) => localSettingsPath(root).replace(os.homedir(), '~')),
    promote, prune, kept, blocked,
    trusted,
    enabled: localDrainEnabled(),
  };
}

// ── agent guidance ──────────────────────────────────────────────────────────────
// The one class of friction no generalizer can fix after the fact: a compound
// command is stored verbatim when approved, so it never matches a second command.
// The fix is upstream, in the agent's instructions — and the agent cannot install
// it itself, because editing its own permission surface is what a classifier
// stops. So the extension writes it, into ~/.claude/CLAUDE.md.

function guidanceEnabled() {
  return vscode.workspace.getConfiguration('permissionWildcarding').get('guidance.enabled', true);
}

// Keep CLAUDE.md in step with the setting on activation, and refresh a block
// written by an older version. Silent when already correct: this runs on every
// activation and must not rewrite the user's instruction file for nothing.
function ensureGuidance(announce = false) {
  // The same gate ensureGates has, and for the same reason: this writes the
  // user's CLAUDE.md and ~/.codex/AGENTS.md, and it is reached from the
  // configuration listener, which stays live until VS Code disposes the
  // subscriptions — i.e. after deactivate() resolves. Measured: flipping
  // guidance.enabled after teardown rewrote CLAUDE.md from 1802 bytes to 24.
  // Its twin was guarded in the lifecycle pass and this one was missed.
  if (deactivated) return;
  try {
    const want = guidanceEnabled();
    const states = guidanceStatusAll().filter((state) => state.readable);
    if (!states.length) return;
    // Nothing to do when every installed agent already matches the setting — and
    // when it is on, already has the current wording.
    if (states.every((state) => state.on === want &&
        (want ? state.current : !state.shadowedPaths?.length))) return;
    const changed = setGuidanceAll(want).filter((result) => result.changed);
    if (!changed.length) return;
    if (announce || want) {
      vscode.window.setStatusBarMessage(
        `$(shield) ai-acolyte: shell-style guidance ${want ? 'added to' : 'removed from'} ` +
        changed.map((result) => result.agent).join(' + '),
        6000);
    }
    dashboard?.refresh();
  } catch (err) {
    console.error('ai-acolyte: guidance write failed —', err);
  }
}

async function toggleGuidance() {
  const config = vscode.workspace.getConfiguration('permissionWildcarding');
  const states = guidanceStatusAll();
  // Off only when it is on everywhere it can be AND already the shipped wording. A
  // half-installed or stale state (a new agent appeared, a file was hand-edited, or a
  // release changed the text) should complete or refresh, not undo — which also means the
  // dashboard finally has a refresh path instead of only remove.
  const next = !(states.length && states.every((state) => state.on && state.current));

  // Removal is the only direction that costs something: every compound command starts
  // prompting again. The control lives on a dashboard people open just to read status, so
  // a modal makes a stray click harmless. Adding needs no confirmation, being the
  // recoverable direction.
  if (!next) {
    const files = states.map((state) => state.path.replace(os.homedir(), '~')).join(', ');
    const choice = await vscode.window.showWarningMessage(
      'Remove shell-style guidance?',
      {
        modal: true,
        detail: `Deletes the managed block from ${files}. Future sessions will no longer receive `
          + 'this shell-style guidance. Your own text is left untouched and a backup is written '
          + 'first, and you can re-add it any time.',
      },
      'Remove');
    if (choice !== 'Remove') return;
  }

  // Persist the intent as well as the file, or the next activation would undo it.
  try {
    await config.update('guidance.enabled', next, vscode.ConfigurationTarget.Global);
  } catch (err) {
    vscode.window.showErrorMessage(`ai-acolyte: ${err.message}`);
    return;
  }

  // ensureGuidance got this guard and its twin did not. Both call setGuidanceAll,
  // both write ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md, and this one does it
  // after a modal and a config update — two awaits, either of which can span a
  // teardown. The measurement in ensureGuidance's note applies verbatim: flipping
  // guidance off after teardown rewrote CLAUDE.md from 1802 bytes to 24.
  //
  // AFTER the config update, deliberately. The setting is the user's stated
  // intent and recording it is not a write into their instruction files; the next
  // activation's ensureGuidance is what makes the file agree with it.
  if (deactivated) return;

  const results = setGuidanceAll(next);
  const failed = results.filter((result) => result.error);
  if (failed.length) {
    vscode.window.showErrorMessage(
      `ai-acolyte: ${failed.map((result) => `${result.agent}: ${result.error}`).join('; ')}`);
  } else {
    vscode.window.showInformationMessage(
      `ai-acolyte: shell-style guidance ${next ? 'ON' : 'OFF'} — ` +
      results.map((result) => result.path.replace(os.homedir(), '~')).join(', ') +
      (next ? ' (applies from each agent’s next session)' : ''));
  }
  dashboard?.refresh();
}

function guidanceCardData() {
  try {
    const states = guidanceStatusAll();
    if (!states.length) return null;
    return {
      on: states.every((state) => state.on),
      partial: states.some((state) => state.on) && !states.every((state) => state.on),
      current: states.every((state) => !state.on || state.current),
      readable: states.some((state) => state.readable),
      agents: states.filter((state) => state.on).map((state) => state.agent),
      targets: states.map((state) => state.agent),
      errors: states.filter((state) => state.error).map((state) => state.agent + ': ' + state.error),
      path: states.map((state) => state.path.replace(os.homedir(), '~')).join(', '),
    };
  } catch {
    return null;
  }
}

// ── memory gates ────────────────────────────────────────────────────────────────
// The guidance block above carries wording that ships in this repo. This one carries the
// user's own standing orders: `recall.py --gates-compile` lifts the `<!-- gate -->` section
// out of every memory marked `scope: global` and writes them to ~/.claude/gates.generated.md,
// which this block installs verbatim.
//
// Why a resident block rather than leaving them in the memory index: the index is a list of
// one-line hooks, so the enforceable half of a rule sits in a file that only loads if a
// recall happens to surface it. That works for reference material and fails for standing
// orders, because you cannot recall a rule you are already breaking — nothing triggers the
// lookup. Policy has to be resident; facts do not.
//
// Installing is a file read, so it runs on activation. COMPILING spawns python, so it stays
// an explicit action the card offers when there is nothing compiled yet.

function gatesEnabled() {
  return vscode.workspace.getConfiguration('permissionWildcarding').get('gates.enabled', true);
}

// How many gates the compiled file holds. Counts the bullets the compiler emits rather than
// parsing it, so a hand-mangled file reads as 0 instead of throwing.
// The running extension's version, for the dashboard's status line — so "which
// build am I looking at" is answerable without opening the Extensions view. This
// is the question that costs real time when a fix is in the repo but the VSIX was
// never reinstalled, which has happened repeatedly.
//
// Memoized rather than read per push: a version cannot change while the process
// runs, and the whole point of the change above it is to stop doing avoidable fs
// work on that path. `./package.json` resolves in BOTH layouts — beside
// extension.js in the repo, and beside it again inside the packaged VSIX — and the
// catch means a missing or unreadable manifest degrades to no badge rather than
// to a broken dashboard.
let extensionVersionMemo;
function extensionVersion() {
  if (extensionVersionMemo === undefined) {
    try { extensionVersionMemo = require('./package.json').version || ''; }
    catch { extensionVersionMemo = ''; }
  }
  return extensionVersionMemo;
}

// Read the count out of the header recall.py already writes, not out of the prose.
//
// This was `text.match(/^- \*\*/gm)`, which assumes every gate opens with a bold
// lead-in. That was true of the pre-2026-09-09 corpus and of nothing since, so
// with five gates installed the card read "0 active" — a number that flatly
// contradicted the ON state beside it. recall.py's _compile_gates_text emits
// "## Standing gates (N memories, managed)", which is the authoritative count and
// is independent of how any gate happens to be worded.
//
// Same defect, same day, in scripts/verify-release.ps1, which reported
// "0 gate(s)" for the same file. Fixed there first; this is the product half.
function compiledGateCount() {
  try {
    const text = readCompiled();
    if (!text) return 0;
    const header = text.match(/##\s+Standing gates\s+\((\d+)\s+memor/);
    if (header) return Number(header[1]);
    // Fall back to counting top-level bullets rather than to zero: an older
    // compiled file with no header still has gates in it.
    return (text.match(/^-\s/gm) || []).length;
  } catch {
    return 0;
  }
}

// Compiling needs python but NOT the embedding model: --gates-compile only reads frontmatter
// and lifts marker-fenced text, so the model precondition that gates a recall rebuild does
// not apply. Resolves false when it could not run, having already told the user why.
// `quiet` is for the corpus watcher below: a background recompile that fails must not throw
// a modal at someone who was only editing a note, so it reports to the console instead.
function compileGates({ quiet = false } = {}) {
  const warn = (msg, action) => {
    if (quiet) { console.error('ai-acolyte: ' + msg); return; }
    if (action) {
      vscode.window.showWarningMessage('ai-acolyte: ' + msg, action)
        .then((c) => { if (c === action) setRecallPath(); });
    } else {
      vscode.window.showWarningMessage('ai-acolyte: ' + msg);
    }
  };
  // Nothing here may start after teardown: the callback chains into a write of
  // the user's instruction files.
  if (deactivated) return Promise.resolve(false);
  const script = recallScriptPath();
  if (!script) {
    warn('recall.py not found, so gates cannot be compiled.', 'Set recall.py path…');
    return Promise.resolve(false);
  }
  const st = recallStatus();
  if (!st.venv) {
    warn(`DevToolbox venv python not found at ${st.py} — cannot compile gates.`);
    return Promise.resolve(false);
  }
  const { dir } = memoryReport();
  return new Promise((resolve) => {
    const env = { ...process.env, RECALL_REEXEC: '1', ...(dir ? { RECALL_MEMORY_DIR: dir } : {}) };
    trackChild(execFile(st.py, [script, '--gates-compile'], { env, timeout: 60000 }, (err, _out, stderr) => {
      // Resolve false rather than true, so no caller chains into a policy write
      // on the strength of a compile the teardown just cancelled.
      if (deactivated) { resolve(false); return; }
      if (err) {
        const detail = (stderr || err.message || '').trim().slice(0, 300);
        if (quiet) console.error('ai-acolyte: gate compile failed —', detail);
        else vscode.window.showErrorMessage(`ai-acolyte: gate compile failed — ${detail}`);
        resolve(false);
        return;
      }
      resolve(true);
    }));
  });
}

// Keep the instruction files in step with the setting on activation, and refresh a block
// whose corpus has changed. Silent when already correct, because this runs on every
// activation and must not rewrite the user's instruction file for nothing.
function ensureGates(announce = false) {
  try {
    // The last gate before setGatesAll(). Reached from the compiled-file watcher
    // and from the compile callback, both of which can land after deactivate —
    // and this writes the user's CLAUDE.md / AGENTS.md.
    if (deactivated) return;
    const want = gatesEnabled();
    const states = gatesStatusAll().filter((state) => state.readable);
    if (!states.length) return;
    // Never install without a compile. setGatesAll refuses anyway, and reporting success
    // here would leave the card claiming ON while enforcing nothing.
    if (want && !states.some((state) => state.compiled)) return;
    if (states.every((state) => state.on === want &&
        (want ? state.current : !state.shadowedPaths?.length))) return;
    const changed = setGatesAll(want).filter((result) => result.changed);
    if (!changed.length) return;
    if (announce || want) {
      vscode.window.setStatusBarMessage(
        `$(law) ai-acolyte: memory gates ${want ? 'added to' : 'removed from'} ` +
        changed.map((result) => result.agent).join(' + '),
        6000);
    }
    dashboard?.refresh();
  } catch (err) {
    console.error('ai-acolyte: gates write failed —', err);
  }
}

async function toggleGates() {
  const config = vscode.workspace.getConfiguration('permissionWildcarding');
  let states = gatesStatusAll();
  // Same rule as guidance: a stale or half-installed state should refresh or complete
  // rather than undo, so `off` only happens from a fully installed, current block.
  const next = !(states.length && states.every((state) => state.on && state.current));

  if (next && !states.some((state) => state.compiled)) {
    const choice = await vscode.window.showWarningMessage(
      'No gates compiled yet.',
      {
        modal: true,
        detail: 'Memory gates are built from your own memory files: each one marked '
          + '`scope: global` with a <!-- gate --> block holding its resident lines. Compile '
          + 'them first and the managed block gets installed from the result.',
      },
      'Compile now');
    if (choice !== 'Compile now') return;
    if (!await compileGates()) return;
    states = gatesStatusAll();
    if (!states.some((state) => state.compiled)) {
      vscode.window.showWarningMessage(
        'ai-acolyte: nothing to install — no memory carries a <!-- gate --> block '
        + 'with `scope: global`.');
      dashboard?.refresh();
      return;
    }
  }

  if (!next) {
    const files = states.map((state) => state.path.replace(os.homedir(), '~')).join(', ');
    const choice = await vscode.window.showWarningMessage(
      'Remove memory gates?',
      {
        modal: true,
        detail: `Deletes the managed block from ${files}. Your standing orders stop being `
          + 'loaded every session, so they apply only when a recall happens to surface them. '
          + 'The memory files themselves are untouched and a backup is written first.',
      },
      'Remove');
    if (choice !== 'Remove') return;
  }

  try {
    await config.update('gates.enabled', next, vscode.ConfigurationTarget.Global);
  } catch (err) {
    vscode.window.showErrorMessage(`ai-acolyte: ${err.message}`);
    return;
  }

  // The same guard toggleGuidance takes, for the same reason and against the same
  // two files. This path has up to four awaits in front of it — a compile prompt,
  // the compile itself, a modal, the config update — so its window is the widest
  // of the three.
  if (deactivated) return;

  const results = setGatesAll(next);
  const failed = results.filter((result) => result.error);
  if (failed.length) {
    vscode.window.showErrorMessage(
      `ai-acolyte: ${failed.map((result) => `${result.agent}: ${result.error}`).join('; ')}`);
  } else {
    vscode.window.showInformationMessage(
      `ai-acolyte: memory gates ${next ? 'ON' : 'OFF'} — ` +
      results.map((result) => result.path.replace(os.homedir(), '~')).join(', ') +
      (next ? ' (applies from each agent’s next session)' : ''));
  }
  dashboard?.refresh();
}

// `precomputed` is the same optional memoryReport() result memoryCardData takes —
// this card needs exactly one integer out of it, `report.gateSources`, which the
// memory card's call already computed. Defaults to a fresh call so the other
// callers are unaffected.
function gatesCardData(precomputed = null) {
  try {
    const states = gatesStatusAll();
    if (!states.length) return null;
    return {
      on: states.every((state) => state.on),
      partial: states.some((state) => state.on) && !states.every((state) => state.on),
      current: states.every((state) => !state.on || state.current),
      readable: states.some((state) => state.readable),
      compiled: states.some((state) => state.compiled),
      count: compiledGateCount(),
      // Whether compiling could produce anything at all, so the card can decline
      // to offer an action that cannot succeed. Undefined when the memory report
      // is unavailable, which renderGates treats as "unknown, so still offer it"
      // rather than as zero.
      //
      // The try/catch is load-bearing and stays even with a value passed in: the
      // distinction between `undefined` ("unknown, still offer") and `0`
      // ("decline") is the card's whole contract, and a precomputed
      // `{ report: null }` yields undefined through `?.` naturally. What must NOT
      // happen is a throw escaping to the outer catch below, which returns null
      // and loses the entire card rather than one field.
      gateSources: (() => {
        try { return (precomputed || memoryReport()).report?.gateSources; } catch { return undefined; }
      })(),
      agents: states.filter((state) => state.on).map((state) => state.agent),
      targets: states.map((state) => state.agent),
      errors: states.filter((state) => state.error).map((state) => state.agent + ': ' + state.error),
      path: states.map((state) => state.path.replace(os.homedir(), '~')).join(', '),
    };
  } catch {
    return null;
  }
}

// One removal path, shared by the dashboard's ✕ and the QuickPick below, so the
// two can never diverge on the ordering that makes a prune stick.
function removeAllowEntry(perm) {
  if (!perm) return false;
  const settings = readSettings();
  if (!settings) return false;
  const allow = (settings.permissions?.allow ?? []).filter((p) => p !== perm);
  try {
    // Settings FIRST, backup second. The prune does have to leave the high-water
    // mark — otherwise the entry returns on the next restore and the policy guard
    // reports it as missing forever — but doing that first meant betting the
    // backup on a write that routinely fails: writeAllow throws
    // SETTINGS_UNREADABLE_CODE whenever it lands inside one of the in-place
    // rewrites Claude Code performs on every approval, /model and /effort. The
    // entry then stayed live in settings.json while its only copy was gone from
    // the backup, so a later wipe could not bring it back — the one unrecoverable
    // outcome, traded for a recoverable one (a stale backup entry the guard
    // offers to re-assert or forget).
    writeAllow(settings, allow);
    // ALLOW only. This function removes an allow entry and nothing else, so a
    // deny rule that happens to spell the same permission must survive it.
    forgetFromBackup({ allow: [perm] });
    lastRun = Date.now();
    vscode.window.setStatusBarMessage(`$(shield) ai-acolyte: removed ${perm}`, 4000);
    return true;
  } catch (err) {
    vscode.window.showErrorMessage(`ai-acolyte: remove failed — ${err.message}`);
    return false;
  }
}

// The whole wildcard list, with a filter box. The sidebar shows the first dozen
// and defers here, because the list is longest exactly when the tool is working:
// 404 of 423 entries on the machine this was built for, the longest 137
// characters, wrapping to three lines in a 320px column. A QuickPick is the
// right shape — full window width, fuzzy filter, keyboard-first — and it is
// already this extension's idiom for Review, derived guidance and the agent
// pickers.
async function showWildcardPicker() {
  const settings = readSettings();
  if (!settings) {
    vscode.window.showWarningMessage(
      'ai-acolyte: settings.json is missing or unreadable.');
    return;
  }
  const allow = Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
  // The dashboard's own classification, so the sidebar count and the picker
  // count can never disagree.
  const wildcards = allow.filter((p) => p.includes('*')).sort();
  if (!wildcards.length) {
    vscode.window.showInformationMessage(
      'ai-acolyte: no wildcard entries yet — approve some commands first.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    wildcards.map((permission) => ({
      label: permission,
      // The tool name, so typing "powershell" narrows to that half of the list.
      description: (/^([A-Za-z]+)\(/.exec(permission) || [, 'other'])[1],
    })),
    {
      title: `Tracked wildcards (${wildcards.length} of ${allow.length} allow entries)`,
      placeHolder: 'Filter by command or tool — pick one to remove it',
      matchOnDescription: true,
    });
  if (!pick) return;
  await confirmClaudePermissionRemoval(pick.label);
}

async function confirmClaudePermissionRemoval(permission) {
  // Confirmed, unlike the sidebar's hover-revealed ✕, because Enter on a
  // filtered list is easy to mis-hit and this is NOT recoverable: the prune
  // deliberately drops the entry from the high-water-mark backup too, so
  // "Restore prunes from backup" will not bring it back.
  const choice = await vscode.window.showWarningMessage(
    permission.includes('*') ? 'Remove this wildcard?' : 'Remove this Claude permission?',
    {
      modal: true,
      detail: `${permission}\n\nIt is dropped from settings.json and from the backup, so a `
        + 'later restore will not reinstate it. Claude Code will prompt again for commands '
        + 'this covered.',
    },
    'Remove');
  if (choice !== 'Remove') return;
  // Two awaited dialogs in front of a write to settings.json AND to the
  // high-water backup, and the comment above says in as many words that the pair
  // is not recoverable. A prune that lands after teardown is the same write with
  // nobody left to report it.
  if (deactivated) return;
  if (removeAllowEntry(permission)) dashboard?.refresh();
}

async function showCodexRestorePicker() {
  try {
    const inventory = await runAutoLearnWorker('codexRestoreInventory');
    if (deactivated) return;
    if (inventory.pendingApproval) {
      await vscode.window.showInformationMessage('Finish the interrupted reviewed change in Review Codex approvals first.');
      return;
    }
    if (inventory.pendingRemoval) {
      await vscode.window.showInformationMessage('Finish the interrupted removal in Show Codex rules before restoring rules.');
      return;
    }
    let request;
    if (inventory.pendingRestore) {
      const choice = await vscode.window.showWarningMessage('Finish interrupted Codex restore?',
        { modal: true, detail: 'Finish the restore you already confirmed. Changed files are preserved and will need review. Restart Codex after restoring rules.' }, 'Finish restore');
      if (choice !== 'Finish restore' || deactivated) return;
      request = { resume: true };
    } else {
      const rows = inventory.files.flatMap((file) => [
        ...(file.restore || []).map((rule) => ({ label: JSON.stringify(rule.pattern),
          description: `Codex · ${rule.decision} · missing rule`, detail: file.path, file, rule })),
        ...(!file.supported ? [{ label: file.path, description: 'Read-only', detail: file.reason }] : []),
        ...(file.suppressed || []).map((rule) => ({ label: JSON.stringify(rule.pattern), description: 'Excluded by an intentional removal', detail: file.path })),
        ...(file.conflicts || []).map((rule) => ({ label: JSON.stringify(rule.pattern), description: 'Changed rule needs review', detail: rule.reason })),
      ]);
      if (!rows.length) {
        await vscode.window.showInformationMessage('No missing Codex rules to restore.', { modal: true,
          detail: `Saved rules: ${inventory.backupPath}\nRules are saved during Auto Learn scans, grants, and inventory views.` });
        return;
      }
      const pick = await vscode.window.showQuickPick(rows, { title: 'Restore Codex rules',
        placeHolder: 'Choose a missing rule to restore; excluded or changed rules are read-only', matchOnDescription: true, matchOnDetail: true });
      if (!pick || deactivated) return;
      if (!pick.rule || !pick.file?.supported) {
        await vscode.window.showInformationMessage(pick.description, { modal: true, detail: pick.detail });
        return;
      }
      const choice = await vscode.window.showWarningMessage('Restore this Codex rule?', { modal: true,
        detail: `Prefix: ${JSON.stringify(pick.rule.pattern)}\nDecision: ${pick.rule.decision}\nFile: ${pick.file.path}\n\nThis adds the missing declaration while preserving current rules. Restart Codex to load it.` }, 'Restore');
      if (choice !== 'Restore' || deactivated) return;
      request = { path: pick.file.path, expectedHash: pick.file.beforeHash, expectedExists: pick.file.exists, ids: [pick.rule.id] };
    }
    const result = await runAutoLearnWorker('restoreCodexRules', request);
    if (deactivated) return;
    if (!result.changed || !Number.isInteger(result.restoredCount) || result.restoredCount < 1) {
      vscode.window.showWarningMessage('ai-acolyte: no Codex rule was restored. Open Restore Codex rules again to refresh it.');
      return;
    }
    vscode.window.showInformationMessage(`ai-acolyte: restored ${result.restoredCount} Codex rule${result.restoredCount === 1 ? '' : 's'}. Restart Codex to load the changed rules.`);
    dashboard?.refresh();
  } catch (error) {
    vscode.window.showErrorMessage(`ai-acolyte: Codex restore failed: ${error.message}`);
  }
}

// The Saved permissions card's two read-only diagnostic lines each open the shared
// picker filtered to their own entries: `{ filter: 'dead' }` (one-off shell approvals)
// and `{ filter: 'over-broad' }` (wildcards keyed on shell grammar, added 2026-10-13).
// One table, so the two views cannot drift in how they read the list, skip Codex or
// confirm a removal; only the entry set and the wording differ.
const SAVED_PERMISSION_FILTERS = Object.freeze({
  dead: Object.freeze({
    entries: (allow) => deadShellApprovals(allow).entries,
    description: 'Claude · allow · one-off script',
    title: 'Saved permissions · one-off shell approvals',
    placeHolder: 'Exact approvals that cover at most their own text; choose one to inspect or remove',
    empty: 'AI Acolyte: no one-off shell approvals are saved now.',
  }),
  'over-broad': Object.freeze({
    entries: (allow) => overBroadShellGrants(allow).entries,
    description: 'Claude · allow · over-broad grant',
    title: 'Saved permissions · over-broad wildcard grants',
    placeHolder: 'Wildcards keyed on shell grammar, which match more than the command they came from; choose one to inspect or remove',
    empty: 'AI Acolyte: no over-broad wildcard grants are saved now.',
  }),
});

async function showSavedPermissionPicker(selection) {
  try {
    const settings = readSettingsState();
    const allow = Array.isArray(settings.settings?.permissions?.allow)
      ? settings.settings.permissions.allow.filter((entry) => typeof entry === 'string') : [];
    // The set is recomputed from THIS read, not carried from the push that drew the line:
    // the list can change while the panel is open, and a row offered for removal must be
    // one that is on disk now. Both diagnostics are memoized on the list, so an unchanged
    // list costs nothing here. Codex is skipped for a filtered view: both diagnostics are
    // about Claude's saved shell entries and have nothing to say about prefix rules.
    // Removal is the ordinary per-entry confirmation below; nothing is removed in bulk.
    // An own-property lookup, so a `filter` of `toString` or `__proto__` is no view.
    const view = Object.prototype.hasOwnProperty.call(SAVED_PERMISSION_FILTERS, selection?.filter)
      ? SAVED_PERMISSION_FILTERS[selection.filter] : null;
    const only = view ? new Set(view.entries(allow)) : null;
    const items = allow.filter((permission) => !only || only.has(permission)).sort().map((permission) => ({
      label: permission, description: view ? view.description : 'Claude · allow', agent: 'claude',
    }));
    const permissions = settings.settings?.permissions;
    const claudeComplete = settings.state !== SETTINGS_UNREADABLE
      && (permissions === undefined || (permissions !== null && typeof permissions === 'object' && !Array.isArray(permissions)))
      && ['allow', 'ask', 'deny'].every((key) => permissions?.[key] === undefined
        || (Array.isArray(permissions[key]) && permissions[key].every((entry) => typeof entry === 'string')));
    if (!claudeComplete) items.push({
      label: 'Claude permissions unavailable', description: 'Claude · read-only',
      detail: 'Claude settings.json could not be fully read as permission lists. Known entries are shown; check the file and reload this list.', unavailable: true,
    });
    let inventory;
    if (!view) try {
      inventory = await runAutoLearnWorker('codexInventory');
      if (inventory.pendingApproval) items.push({
        label: 'Codex change needs attention', description: 'Codex · read-only',
        detail: 'Finish the interrupted reviewed change in Review Codex approvals first.', unavailable: true,
      });
      else items.push(...codexInventoryItems(inventory, (file) => file.replace(os.homedir(), '~'))
        .map((item) => ({ ...item, agent: 'codex' })));
    } catch (error) {
      items.push({ label: 'Codex permissions unavailable', description: 'Codex · read-only',
        detail: String(error.message || error), unavailable: true });
    }
    if (deactivated) return;
    // The list was cleared (or edited) after the dashboard drew its line. An empty
    // QuickPick reads as "the filter failed", so say what is true instead.
    if (view && !items.length) {
      vscode.window.showInformationMessage(view.empty);
      return;
    }
    // A sidebar row is a read-only hint. Re-read the inventory before reviewing
    // it so ownership, pending changes and the removal hash are current.
    let pick = selection?.agent === 'codex' && items.find((item) => item.rule
      && item.rule.path === selection.path && item.rule.start === selection.start
      && JSON.stringify(item.rule.pattern) === JSON.stringify(selection.pattern));
    if (!pick) pick = await vscode.window.showQuickPick(items, view ? {
      title: view.title, placeHolder: view.placeHolder,
      matchOnDescription: true, matchOnDetail: true,
    } : {
      title: 'Saved permissions · Claude + Codex',
      placeHolder: 'Filter by command, agent or file; choose an entry to inspect or remove',
      matchOnDescription: true, matchOnDetail: true,
    });
    if (!pick || deactivated) return;
    if (pick.unavailable) {
      await vscode.window.showInformationMessage(pick.label, { modal: true, detail: pick.detail });
    } else if (pick.agent === 'claude') {
      await confirmClaudePermissionRemoval(pick.label);
    } else {
      await inspectCodexPermission(pick, inventory);
    }
  } catch (error) {
    if (!deactivated) vscode.window.showErrorMessage(`AI Acolyte: saved permissions could not be updated: ${error.message}`);
  }
}

async function showCodexRulePicker() {
  try {
    const inventory = await runAutoLearnWorker('codexInventory');
    if (deactivated) return;
    if (inventory.pendingApproval) {
      await vscode.window.showInformationMessage('Finish the interrupted reviewed change in Review Codex approvals first.');
      return;
    }
    const displayPath = (file) => file.replace(os.homedir(), '~');
    const pick = await vscode.window.showQuickPick(codexInventoryItems(inventory, displayPath), {
      title: 'Codex rules',
      placeHolder: 'Filter by prefix or file; choose a rule to inspect or remove',
      matchOnDescription: true, matchOnDetail: true,
    });
    if (!pick || deactivated) return;
    await inspectCodexPermission(pick, inventory);
  } catch (error) {
    if (!deactivated) vscode.window.showErrorMessage(`ai-acolyte: Codex rules could not be updated: ${error.message}`);
  }
}

async function inspectCodexPermission(pick, inventory) {
    const detail = codexInventoryDetail(pick, inventory, (file) => file.replace(os.homedir(), '~'));
    if (!pick.removable && !pick.resume) {
      await vscode.window.showInformationMessage(pick.about ? 'About this Codex inventory' : 'Codex rule (read-only)',
        { modal: true, detail });
      return;
    }
    const action = pick.resume ? 'Finish removal' : 'Remove';
    const choice = await vscode.window.showWarningMessage(pick.resume ? 'Finish interrupted Codex removal?' : 'Remove this Codex allow rule?',
      { modal: true, detail }, action);
    if (choice !== action || deactivated) return;
    // The file hash and declaration id belong to the displayed inventory. The
    // worker rejects either changing while the picker or confirmation was open.
    const request = pick.resume ? { resume: true } : { rules: [{
      id: pick.rule.id, path: pick.rule.path, fileHash: pick.rule.fileHash,
    }] };
    const result = await runAutoLearnWorker('removeCodexRules', request);
    if (deactivated) return;
    if (!result.changed || !Number.isFinite(result.removedCount) || result.removedCount < 1) {
      vscode.window.showWarningMessage('ai-acolyte: no Codex rule was removed. Open the inventory again to refresh it.');
      return;
    }
    vscode.window.showInformationMessage(
      `ai-acolyte: removed ${result.removedCount} Codex allow rule${result.removedCount === 1 ? '' : 's'}. ` +
      'Current Auto Learn builds will not re-add overlapping prefixes. Restart Codex; active sessions may cache rules.');
    dashboard?.refresh();
}

// ── dashboard (Activity Bar webview) ────────────────────────────────────────────

async function choosePermissionAgent(title, claude, codex) {
  const pick = await vscode.window.showQuickPick([
    { label: 'Claude Code', description: 'Claude settings and saved permissions', agent: 'claude' },
    { label: 'Codex', description: 'Native command-prefix rules', agent: 'codex' },
  ], { title, placeHolder: 'Choose the permissions to manage' });
  if (deactivated || !pick) return;
  if (pick.agent === 'claude') return claude();
  if (pick.agent === 'codex') return codex();
}

// Short enough to read as instant, long enough to collapse a watcher pair. The
// other bounces in this file are 200ms–2s because they debounce *work*; this one
// debounces a render, so it is sized to the burst and nothing more.
const DASHBOARD_BOUNCE_MS = 60;

class WildcardingViewProvider {
  static viewId = 'permissionWildcarding.dashboard';

  constructor(context) {
    this.context = context;
    this.view = null;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this._html(view.webview);

    view.webview.onDidReceiveMessage((msg) => {
      switch (msg?.type) {
        case 'optimizePermissions': vscode.commands.executeCommand('permission-wildcarding.optimizePermissions'); break;
        case 'viewPermissions': vscode.commands.executeCommand('permission-wildcarding.viewPermissions', msg.selection); break;
        case 'restorePermissions': vscode.commands.executeCommand('permission-wildcarding.restorePermissions'); break;
        case 'importPermissions': vscode.commands.executeCommand('permission-wildcarding.importPermissions'); break;
        case 'autoLearnScan': vscode.commands.executeCommand('permission-wildcarding.autoLearnScan'); break;
        case 'autoLearnReview': vscode.commands.executeCommand('permission-wildcarding.autoLearnReview'); break;
        case 'autoLearnUndo': vscode.commands.executeCommand('permission-wildcarding.autoLearnUndo'); break;
        case 'autoLearnWhy': vscode.commands.executeCommand('permission-wildcarding.autoLearnWhy'); break;
        case 'rebuildRecall': vscode.commands.executeCommand('permission-wildcarding.rebuildRecall'); break;
        case 'lintMemory':   vscode.commands.executeCommand('permission-wildcarding.lintMemory'); break;
        case 'drainLocal':   vscode.commands.executeCommand('permission-wildcarding.drainLocal'); break;
        case 'toggleGuidance': vscode.commands.executeCommand('permission-wildcarding.toggleGuidance'); break;
        case 'toggleGates': vscode.commands.executeCommand('permission-wildcarding.toggleGates'); break;
        // No 'showWildcards' arm since 2026-10-14: the webview lost its only sender at
        // c09daab (the shared Saved permissions picker replaced that button), and the
        // two synthetic test rows posting it directly were all that kept it alive. The
        // palette command is untouched. test/dashboard-view.test.js now checks the
        // reverse direction too: every arm here needs a postMessage of its type in the
        // webview script, so a sender removed without its route fails.
        case 'codexHook': vscode.commands.executeCommand('permission-wildcarding.codexHook'); break;
        case 'reviewCodexMcp': vscode.commands.executeCommand('permission-wildcarding.reviewCodexMcp'); break;
        case 'searchCodexMemory': vscode.commands.executeCommand('permission-wildcarding.searchCodexMemory'); break;
        case 'rebuildCodexMemory': vscode.commands.executeCommand('permission-wildcarding.rebuildCodexMemory'); break;
        case 'codexMemoryGates': vscode.commands.executeCommand('permission-wildcarding.codexMemoryGates'); break;
        case 'inspectCodexMemory': vscode.commands.executeCommand('permission-wildcarding.inspectCodexMemory'); break;
        case 'refresh':      this.refresh(); break;
        case 'remove':       this._remove(msg.value); break;
      }
    });

    // The view is disposed every time it is hidden — package.json declares it
    // without retainContextWhenHidden — and re-resolved on show. Without this,
    // `this.view` kept pointing at the disposed one, and `refresh()` guards only
    // on `!this.view`: every dashboard?.refresh() call site (there are dozens,
    // several of them file-watcher callbacks) would run the entire synchronous
    // work-up first — processAllowList, a MEMORY.md read per discovered store, a
    // dry-run drain per workspace folder — and only then throw on postMessage.
    // From a watcher callback that surfaces as an unhandled extension-host
    // error, and the wasted work repeated on every background event for as long
    // as the sidebar stayed collapsed.
    //
    // Identity-checked before nulling: a hide/show race can resolve the next
    // view before the previous one's disposal is delivered, and clearing
    // unconditionally would drop the live view instead of the dead one.
    view.onDidDispose(() => { if (this.view === view) this.view = null; });

    view.onDidChangeVisibility(() => { if (view.visible) this.refresh(); });
    this.refresh();
  }

  // Ask for a push. Debounced like every other handler in this file (memBounce,
  // gatesBounce, policyBounce, localDrainBounce, autoLearnBounce): this was the
  // one that ran straight through, and it has ~35 call sites — several of them
  // watcher pairs (onDidChange + onDidCreate, or a delete beside a create) that
  // fire together, each paying for a full work-up (the push ran a quadratic
  // processAllowList until 2026-10-14; see the note where wildcardingHint was).
  refresh() {
    // Before the timer, not inside it: nothing to push means nothing to schedule,
    // and this is the guard that keeps a collapsed sidebar (the view is disposed
    // on hide) from doing the whole work-up on every background event.
    if (!this.view) return;
    clearTimeout(dashboardBounce);
    dashboardBounce = setTimeout(() => this._push(), DASHBOARD_BOUNCE_MS);
  }

  // Push current state to the webview.
  _push() {
    // The one place a torn-down extension could still reach the dashboard: every
    // refresh() call site funnels through here.
    //
    // `visible` as well as `!this.view`, and the two cover different states. The
    // view is DISPOSED when hidden — the manifest declares it without
    // retainContextWhenHidden — and onDidDispose nulls `this.view`, so the
    // `!this.view` half already covers a closed sidebar. What it does not cover is
    // the view being collapsed within a showing container, where it stays alive
    // and merely turns invisible, and the window between a hide and its disposal
    // event being delivered. In both, the full synchronous work-up ran and posted
    // to a webview whose content had already been torn down.
    //
    // No dirty flag is needed: resolveWebviewView already installs
    // `onDidChangeVisibility(() => { if (view.visible) this.refresh(); })`, so
    // becoming visible re-pushes with fresh state.
    //
    // Scope note, because an audit oversold this one: it is NOT worth ~22 ms x 50
    // sites, because the dominant collapsed-sidebar case was already handled. It
    // is worth the one line as robustness.
    // `!== false`, not `!`. A view object with no `visible` member at all — an
    // older host, or a test double written before this guard existed — reads as
    // `undefined`, which is falsy, so `!this.view.visible` treats it as
    // permanently hidden and the dashboard silently never renders. That also
    // defeats fakeView()'s stated contract that a new dependency on the real
    // WebviewView API surfaces as a TypeError rather than a silent pass:
    // reading a missing property is not a TypeError. Only an explicit `false`
    // means hidden.
    if (deactivated || !this.view || this.view.visible === false) return;
    // ONE read of settings.json per push, not two. This used to be `readSettings()` — a
    // readFileSync plus a JSON.parse — with `readSettingsState()` taking the same file
    // again for the three-state pill, eleven lines below the note explaining that
    // memoryReport() was hoisted out of this very function to stop it being computed
    // twice. readSettingsState() returns the parsed object beside the state, so reading
    // both off one call REMOVES a read rather than adding one; the same idiom is already
    // used by onManagedPolicyChanged and restoreFromBackup. Not an optimisation to defend
    // with a number — it is a deleted duplicate — and it also closes the window where
    // the two reads disagreed because Claude Code rewrote the file between them.
    //
    // The try/catch is the one that used to wrap the settingsState read alone, and it
    // still yields 'unreadable' on a throw. `settings` then stays null, which is what
    // readSettings() returned on any failure, so the work-up below is unchanged.
    // Mapping every non-present state to null matches it too: absent hands back `{}`
    // and a JSON array or scalar hands back null, and all three uses below
    // The remaining settings read (`settings?.permissions?.allow`) is
    // optional-chained and Array-guarded, so `{}`, `null` and a non-object all
    // read the same.
    let settingsState;
    let settings = null;
    try {
      const liveState = readSettingsState();
      settingsState = liveState.state;
      if (liveState.state === SETTINGS_PRESENT) settings = liveState.settings;
    } catch { settingsState = SETTINGS_UNREADABLE; }
    const allow = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow.filter((entry) => typeof entry === 'string') : [];
    const permissions = settings?.permissions;
    const validPermissionsContainer = permissions === undefined || (permissions !== null && typeof permissions === 'object' && !Array.isArray(permissions));
    const claudePermissionsComplete = settingsState !== SETTINGS_UNREADABLE && validPermissionsContainer && ['allow', 'ask', 'deny'].every((key) => {
      const entries = settings?.permissions?.[key];
      return entries === undefined || (Array.isArray(entries) && entries.every((entry) => typeof entry === 'string'));
    });
    // Counts trusted project rules too, from the CACHED trust verdict only: this
    // read never spawns (2026-10-14). Measured on v1.6.2, where it asked Codex
    // synchronously: a cold push blocked the host 1,106 ms, one after a config.toml
    // touch 980 ms, and one against a codex that never answers 31,331 ms. A miss now
    // posts the user-scope count marked `pending`, starts one off-thread refresh,
    // and the refresh's own push brings the project rules in.
    const codexSummaryConfig = autoLearnConfig();
    const codexPermissions = readCodexPermissionSummary({ ...codexRuleSetOptions(codexSummaryConfig),
      projectTrust: 'cached' });
    if (codexPermissions.pending) refreshProjectTrustForDashboard(codexSummaryConfig);
    // Saved shell approvals that are one-off scripts (src/permission-summary.js says what
    // counts and why). Off the SAME `allow` this push already read, per the note above:
    // a second readSettings() here would bring back the duplicate read it removed.
    // Memoized on the list, so a push over an unchanged list does no classification.
    // Read-only, and a diagnostic: if it ever throws, the card loses one line, not the
    // whole dashboard.
    let deadApprovals = { count: 0, total: 0, byReason: {} };
    try {
      const dead = deadShellApprovals(allow);
      deadApprovals = { count: dead.count, total: dead.total, byReason: dead.byReason };
    } catch { /* keep the empty shape: the line simply does not render */ }
    // Its sibling (2026-10-13): saved WILDCARD grants keyed on shell grammar rather than
    // a command, which match more than intended. Same single read, same memo, same
    // failure rule; each diagnostic fails alone.
    let overBroadGrants = { count: 0, total: 0, byReason: {} };
    try {
      const broad = overBroadShellGrants(allow);
      overBroadGrants = { count: broad.count, total: broad.total, byReason: broad.byReason };
    } catch { /* keep the empty shape: the line simply does not render */ }
    // A count, not the list. The payload used to carry `wildcards`, every wildcard
    // entry sorted, on every push, and the webview never read it: the only reader
    // is the Claude total's hover title, which wants this number. `pendingWildcard`
    // (a processAllowList pass, quadratic, ~57 ms on a 423-entry list) went the same
    // way on 2026-10-14; its badge left the webview at ee46cf5.
    const wildcardCount = allow.filter((p) => p.includes('*')).length;
    // The live wildcarding pass watches Claude's settings.json; Auto Learn also
    // reads Codex history (regardless of codexScope, which only gates rule writes).
    // Name Codex in the status card whenever both are true, so the flagship line
    // isn't Claude-only for a cross-agent tool.
    const autoLearn = autoLearnCardData();
    const codexWatching = !!autoLearn.enabled && fs.existsSync(CODEX_SESSIONS_DIR);
    // One memory report for the whole push, hoisted for the same reason autoLearn
    // above it is: two cards need it and it is not cheap. memoryCardData consumes
    // conf plus six report fields; gatesCardData needs the single integer
    // report.gateSources, which this call has already computed. Saves roughly
    // 3-5 ms and 25-35 fs syscalls per refresh — a range because the cost scales
    // with the memory corpus; see the note on memoryCardData.
    //
    // On a throw, fall back to the SHAPE both builders already read as "no card"
    // rather than to null. Passing null would make each builder take its
    // fresh-call default and throw again — three calls on the error path instead
    // of the two we started with. This shape is also exactly what every test stub
    // for memoryReport returns, so the failure path is the path already covered.
    let memory;
    // settingsState is read at the top of this function, off the same
    // readSettingsState() call that supplies `settings`. See the note there.
    try { memory = memoryReport(); }
    catch { memory = { conf: {}, dir: null, report: null }; }
    this.view.webview.postMessage({
      type: 'data',
      // Three states, not existsSync. A corrupt or mid-write settings.json EXISTS, so the
      // pill read a green "Active" while every writer was throwing SETTINGS_UNREADABLE.
      // readSettingsState was built for exactly this distinction. The boolean `active`
      // that sat beside it was dropped 2026-10-14: the webview reads settingsState (and
      // claudePermissionsComplete) and nothing read `active`, so its one test asserted a
      // field no pixel depended on. That test now asserts the rendered status instead.
      settingsState,
      settingsPath: SETTINGS.replace(os.homedir(), '~'),
      version: extensionVersion(),
      codexWatching,
      total: allow.length,
      claudePermissionsComplete,
      codexPermissions,
      savedPermissions: [
        ...allow.map((permission) => ({ agent: 'claude', label: permission, value: permission })),
        ...codexPermissions.allowRules.map((rule) => ({ agent: 'codex', label: JSON.stringify(rule.pattern), ...rule })),
      ],
      deadApprovals,
      overBroadGrants,
      wildcardCount,
      specificCount: allow.length - wildcardCount,
      backupCount: backupCount(),
      lastRun,
      autoLearn,
      memory: memoryCardData(memory),
      codexMemory: {
        ...codexFeatureStatus({ home: os.homedir(), codexHome: CODEX_HOME_DIR }),
        lintEnabled: memoryConf().enabled !== false,
        issues: codexMemoryReport?.diagnostics?.length || 0,
        error: codexMemoryReport?.error || codexMemoryReport?.watchError || null,
        gates: codexMemoryGatesUi?.status(),
        // Which codex-cli the configured executable is, against the tested
        // window. INFORMATION ONLY (src/codex-version.js): cached per binary,
        // probed in the background, never a reason for a warning badge. No
        // Codex home, no probe: a Claude-only machine gets no Codex line and
        // spawns nothing.
        // `onSettled` (2026-10-14): the probe this push started asks for one push
        // when it has an answer, so a quiet window does not show a blank line until
        // something unrelated refreshes it. Generation-checked, like every late
        // continuation here, so a predecessor's probe cannot push to a successor.
        cli: fs.existsSync(CODEX_HOME_DIR) ? dashboardCodexVersion({ executable: codexSummaryConfig.codexExecutable,
          track: trackChild, onSettled: settledFor(activationGeneration) }) : null,
      },
      local: localCardData(),
      guidance: guidanceCardData(),
      gates: gatesCardData(memory),
    });
  }

  // Remove a single permission entry (the per-row prune button).
  _remove(perm) {
    removeAllowEntry(perm);
    this.refresh();
  }

  _html(webview) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         padding: 10px 12px; font-size: 13px; }
  .card { background: var(--vscode-editorWidget-background, rgba(127,127,127,0.08));
          border: 1px solid var(--vscode-widget-border, transparent);
          border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; }
  .status { display: flex; align-items: center; gap: 8px; font-weight: 600; }
  /* Quiet and pushed to the right, so it answers "which build am I looking at"
     without competing with the state it sits beside. */
  .ver { margin-left: auto; font-weight: 400; font-size: 11px;
         color: var(--vscode-descriptionForeground); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-charts-green, #3fb950);
         box-shadow: 0 0 6px var(--vscode-charts-green, #3fb950); flex: 0 0 auto; }
  .dot.idle { background: var(--vscode-charts-yellow, #d29922); box-shadow: 0 0 6px var(--vscode-charts-yellow, #d29922); }
  .dot.on { background: var(--vscode-charts-red, #f85149); box-shadow: 0 0 6px var(--vscode-charts-red, #f85149); }
  .dot.blocked { background: var(--vscode-charts-red, #f85149); box-shadow: 0 0 6px var(--vscode-charts-red, #f85149); }
  button.managed-action { width: 100%; padding: 7px; border-radius: 5px; cursor: pointer; margin-top: 8px;
          font-size: 12px; font-weight: 600;
          border: 1px solid var(--vscode-button-border, var(--vscode-widget-border, transparent));
          background: var(--vscode-button-secondaryBackground, transparent);
          color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
  button.managed-action.on { background: var(--vscode-charts-red, #f85149); color: #fff; border-color: transparent; }
  /* Guidance ON is the resting state. Quiet the remove action so it does not
     read as the card's primary call to action. */
  button.managed-action.managed, button.managed-action.managed.on {
    background: transparent; color: var(--vscode-descriptionForeground);
    border-color: var(--vscode-panel-border); font-weight: 400;
  }
  button.managed-action.managed:hover:not(:disabled) {
    color: var(--vscode-foreground); border-color: var(--vscode-focusBorder);
  }
  button.managed-action:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
  button.managed-action.on:hover { filter: brightness(1.1); }
  button.managed-action:disabled { opacity: 0.5; cursor: not-allowed; }
  button.managed-action:disabled:hover { background: var(--vscode-button-secondaryBackground, transparent); filter: none; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .sub { margin-top: 4px; }
  .stats { display: flex; gap: 10px; }
  .stat { flex: 1; text-align: center; }
  .stat .n { font-size: 22px; font-weight: 700; line-height: 1.1; }
  .stat .l { font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
             color: var(--vscode-descriptionForeground); }
  button.run { width: 100%; padding: 7px; border: none; border-radius: 5px; cursor: pointer;
          font-size: 13px; font-weight: 600; margin-bottom: 6px;
          background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.run:hover { background: var(--vscode-button-hoverBackground); }
  button.restore { width: 100%; padding: 6px; border-radius: 5px; cursor: pointer;
          font-size: 12px; margin-bottom: 12px;
          border: 1px solid var(--vscode-button-border, var(--vscode-widget-border, transparent));
          background: var(--vscode-button-secondaryBackground, transparent);
          color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
  button.restore:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
  .listhead { display: flex; justify-content: space-between; align-items: baseline;
              margin: 2px 2px 6px; cursor: pointer; user-select: none; }
  .listhead:hover .h { color: var(--vscode-textLink-foreground); }
  .listhead .h { font-weight: 600; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 4px; }
  li:hover { background: var(--vscode-list-hoverBackground); }
  li code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
            flex: 1 1 auto; min-width: 0; word-break: break-all; }
  li .agent { flex: 0 0 auto; font-size: 10px; color: var(--vscode-descriptionForeground);
              border: 1px solid var(--vscode-widget-border, #555); border-radius: 3px; padding: 1px 4px; }
  li .inspect { flex: 0 0 auto; border: none; background: transparent; cursor: pointer;
                color: var(--vscode-textLink-foreground); padding: 2px 5px; }
  li .x { flex: 0 0 auto; cursor: pointer; border: none; background: transparent;
          color: var(--vscode-descriptionForeground); font-size: 14px; line-height: 1;
          padding: 2px 5px; border-radius: 4px; visibility: hidden; }
  li:hover .x { visibility: visible; }
  li .x:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-errorForeground); }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 6px; }
  li.more { color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 11px;
            padding: 6px; }
  li.more:hover { text-decoration: underline; }
  #memDir { word-break: break-all; }
  .memissues { margin: 8px 2px 6px; font-size: 11px; }
  .memlink { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  .memlink:hover { text-decoration: underline; }
  /* The one-off approvals line: muted like a note, not tinted like a warning, because
     a false positive would invite deleting an approval that still works. A button so
     it is reachable by keyboard; [hidden] restated because display:block beats the
     attribute. */
  button.deadnote { display: block; width: 100%; margin: 2px 2px 8px; padding: 0; border: none;
                    background: transparent; text-align: left; cursor: pointer; font: inherit;
                    font-size: 11px; color: var(--vscode-descriptionForeground); }
  button.deadnote:hover { color: var(--vscode-textLink-foreground); text-decoration: underline; }
  button.deadnote:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  button.deadnote[hidden] { display: none; }
  .buttonrow { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; }
  .buttonrow button { margin: 0; }

  /* ── layout: one hero, everything else a stateful row ──────────────────────
     Exactly one card keeps card chrome, and every secondary feature becomes a
     single collapsed row whose
     CURRENT STATE is on the right-hand side — the point being that you never
     expand a row just to find out where it stands. */
  .hero { background: var(--vscode-editorWidget-background, rgba(127,127,127,0.08));
          border: 1px solid var(--vscode-widget-border, transparent);
          border-radius: 6px; padding: 12px; margin-bottom: 4px; }
  .heronum { text-align: center; font-size: 30px; font-weight: 700; line-height: 1.05;
             margin: 10px 0 2px; }
  .heronum small { font-size: 13px; font-weight: 400; color: var(--vscode-descriptionForeground); }
  .herosub { text-align: center; font-size: 11px; color: var(--vscode-descriptionForeground);
             margin-bottom: 12px; }
  .hero button.run { margin-bottom: 0; }

  .row { border-top: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.25)); }
  .row:last-of-type { border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.25)); }
  .rowhead { display: flex; align-items: center; gap: 8px; padding: 8px 2px;
             cursor: pointer; user-select: none; }
  button.rowhead { width: 100%; border: none; background: transparent;
                   color: inherit; font: inherit; text-align: left; }
  button.rowhead:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .rowhead:hover .rowname { color: var(--vscode-textLink-foreground); }
  /* An identity glyph, not a status colour. The state itself is the text on the
     right, so a collapsed row never communicates by hue alone — which the eleven
     glowing dots this replaces did, on a red/green axis. */
  .glyph { flex: 0 0 auto; width: 1.1em; text-align: center; font-size: 11px;
           color: var(--vscode-descriptionForeground); }
  .chev { flex: 0 0 auto; width: .8em; font-size: 9px; color: var(--vscode-descriptionForeground); }
  .rowname { font-weight: 600; flex: 1 1 auto; }
  .rowstate { flex: 0 0 auto; font-size: 11px; color: var(--vscode-descriptionForeground);
              text-align: right; }
  .rowstate.warn { color: var(--vscode-charts-yellow, #d29922); }
  .rowstate.hot  { color: var(--vscode-charts-red, #f85149); font-weight: 600; }
  .rowbody { padding: 0 2px 10px 2.1em; }
  .rowbody[hidden] { display: none; }
  #bodyPermissionTools:not([hidden]) { display: grid; gap: 6px; }
  #bodyPermissionTools button.restore { margin: 0; }
  /* The card markup inside a row keeps its ids and its JS untouched, and simply
     stops drawing itself as a card. */
  .row .card { background: none; border: none; border-radius: 0; padding: 0; margin: 0 0 8px; }
  .row .card:last-child { margin-bottom: 0; }
  /* The glow was 6px on every one of eleven dots. Kept as a plain 8px pip. */
  .dot { box-shadow: none; width: 8px; height: 8px; }
  .row .status { font-weight: 400; font-size: 12px; }
  #autoLearnCard > .status { display: none; }
</style>
</head>
<body>
  <div class="hero">
    <div class="status"><span id="dot" class="dot"></span><span id="statusText">Permissions</span><span id="version" class="ver"></span></div>
    <div class="muted sub" id="watching">watching settings.json</div>

    <div class="heronum"><span id="total">–</span> <small>saved allow rules</small></div>
    <div class="herosub">
      <span id="claudeTotal">–</span> Claude · <span id="codexTotal">–</span> Codex
    </div>
    <div class="muted" id="permissionCoverage"></div>

    <button class="run" id="runNow" title="Optimize Claude permissions, then review wider Codex command prefixes">⟳  Optimize permissions</button>
    <div class="muted sub">Claude wildcards + reviewed Codex prefixes</div>
    <div class="muted sub" id="lastRun"></div>
    <div class="muted" id="backup"></div>
  </div>

  <section class="row">
    <button type="button" class="rowhead" id="permissionToolsToggle" data-row="permissionTools"
            aria-controls="bodyPermissionTools" aria-expanded="false">
      <span class="chev" aria-hidden="true">▸</span><span class="glyph" aria-hidden="true">⚙</span>
      <span class="rowname">Permission tools</span>
    </button>
    <div class="rowbody" id="bodyPermissionTools" hidden>
      <button class="restore" id="permissionsView">View / remove permissions…</button>
      <button class="restore" id="permissionsRestore">Restore permissions…</button>
      <button class="restore" id="permissionsImport">Import project permissions…</button>
      <button class="restore" id="codexHook">Configure Codex after-turn learning…</button>
      <button class="restore" id="reviewCodexMcp">Review Codex MCP approvals…</button>
    </div>
  </section>

  <section class="row">
    <div class="rowhead" data-row="autoLearn">
      <span class="chev">▸</span><span class="glyph">✳</span>
      <span class="rowname">Auto Learn</span><span class="rowstate" id="stAutoLearn"></span>
    </div>
    <div class="rowbody" id="bodyAutoLearn" hidden>
      <div class="card" id="autoLearnCard">
        <div class="status"><span id="aldot" class="dot idle"></span><span id="altext">Auto Learn</span></div>
        <div class="muted sub" id="alsub">loading cross-agent history state…</div>
        <div class="stats" style="margin-top:8px">
          <div class="stat"><div class="n" id="alsafe">–</div><div class="l">safe</div></div>
          <div class="stat"><div class="n" id="alreview">–</div><div class="l">review</div></div>
          <div class="stat"><div class="n" id="alobserve">–</div><div class="l">observing</div></div>
        </div>
        <div class="memissues" id="alScanHealth"></div>
        <div class="buttonrow">
          <button class="restore" id="alScan">Scan now</button>
          <button class="restore" id="alReview">Review</button>
          <button class="restore" id="alUndo">Undo</button>
          <button class="restore" id="alWhy">Why prompt?</button>
        </div>
      </div>
    </div>
  </section>

  <section class="row" id="localCard" style="display:none">
    <div class="rowhead" data-row="local">
      <span class="chev">▸</span><span class="glyph">▤</span>
      <span class="rowname">Project-local</span><span class="rowstate" id="stLocal"></span>
    </div>
    <div class="rowbody" id="bodyLocal" hidden>
    <div class="card">
    <div class="status"><span id="locdot" class="dot idle"></span><span id="loctext">Project-local approvals</span></div>
    <div class="muted sub" id="locsub"></div>
    <div class="stats" style="margin-top:8px">
      <div class="stat"><div class="n" id="locpromote">–</div><div class="l">promote</div></div>
      <div class="stat"><div class="n" id="locprune">–</div><div class="l">redundant</div></div>
      <div class="stat"><div class="n" id="lockept">–</div><div class="l">project-only</div></div>
    </div>
    <button class="restore" id="drainLocal" title="Promote portable local approvals to user scope, then drop the ones user scope covers">⤴  Drain into user scope</button>
    </div>
    </div>
  </section>

  <section class="row" id="guidanceCard" style="display:none">
    <div class="rowhead" data-row="guidance">
      <span class="chev">▸</span><span class="glyph">▣</span>
      <span class="rowname">Shell-style guidance</span><span class="rowstate" id="stGuidance"></span>
    </div>
    <div class="rowbody" id="bodyGuidance" hidden>
      <div class="card">
        <div class="status"><span id="gddot" class="dot idle"></span><span id="gdtext">Shell-style guidance</span></div>
        <div class="muted sub" id="gdsub"></div>
        <button class="managed-action" id="guidanceBtn">Add to ~/.claude/CLAUDE.md</button>
      </div>
    </div>
  </section>

  <section class="row" id="gatesCard" style="display:none">
    <div class="rowhead" data-row="gates">
      <span class="chev">▸</span><span class="glyph">▣</span>
      <span class="rowname">Memory gates</span><span class="rowstate" id="stGates"></span>
    </div>
    <div class="rowbody" id="bodyGates" hidden>
      <div class="card">
        <div class="status"><span id="mgdot" class="dot idle"></span><span id="mgtext">Memory gates</span></div>
        <div class="muted sub" id="mgsub"></div>
        <button class="managed-action" id="gatesBtn">Compile and add</button>
      </div>
    </div>
  </section>

  <section class="row" id="codexMemoryCard">
    <div class="rowhead" data-row="codexMemory">
      <span class="chev">▸</span><span class="glyph">◈</span>
      <span class="rowname">Codex memory</span><span class="rowstate" id="stCodexMemory"></span>
    </div>
    <div class="rowbody" id="bodyCodexMemory" hidden>
      <div class="card">
        <div class="muted sub" id="codexMemoryDir"></div>
        <div class="muted sub" id="codexMemoryStatus"></div>
        <button class="restore" id="searchCodexMemory">Search native memory…</button>
        <button class="restore" id="rebuildCodexMemory">Rebuild Codex recall index…</button>
        <button class="restore" id="inspectCodexMemory">Inspect memory sources…</button>
        <div class="muted sub" id="codexMemoryGatesStatus"></div>
        <button class="managed-action" id="codexMemoryGates">Review native memory gates…</button>
        <div class="muted sub" id="codexCliVersion"></div>
      </div>
    </div>
  </section>

  <section class="row" id="memCard" style="display:none">
    <div class="rowhead" data-row="memory">
      <span class="chev">▸</span><span class="glyph">◈</span>
      <span class="rowname">Memory</span><span class="rowstate" id="stMemory"></span>
    </div>
    <div class="rowbody" id="bodyMemory" hidden>
      <div class="card">
        <div class="status"><span id="llmDot" class="dot idle"></span><span id="llmText">CPU LLM</span></div>
        <div class="muted sub" id="memDir"></div>
        <div class="stats" style="margin-top:8px">
          <div class="stat"><div class="n" id="memTok">–</div><div class="l">tok/session</div></div>
          <div class="stat"><div class="n" id="memFiles">–</div><div class="l">files</div></div>
          <div class="stat"><div class="n" id="memEmb">–</div><div class="l">embedded</div></div>
          <div class="stat"><div class="n" id="memLines">–</div><div class="l" id="memLinesLabel">lines</div></div>
        </div>
        <div class="memissues" id="memIssues"></div>
        <button class="restore" id="rebuild" title="Force a full CPU re-embed of the memory dir (recall.py --rebuild)">⟳  Rebuild recall index</button>
      </div>
    </div>
  </section>

  <section class="row">
    <div class="rowhead" data-row="list" title="Click to collapse / expand">
      <span class="chev">▸</span><span class="glyph">✱</span>
      <span class="rowname">Saved permissions</span><span class="rowstate" id="wcount"></span>
    </div>
    <div class="rowbody" id="bodyList" hidden>
      <button type="button" class="deadnote" id="deadApprovals" hidden></button>
      <button type="button" class="deadnote" id="overBroadGrants" hidden></button>
      <ul id="list"></ul>
    </div>
  </section>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  // Which disclosure rows are open, persisted across reloads. Everything starts
  // CLOSED deliberately: the collapsed summary on the right of each row already
  // answers "where does this stand?", so opening a row is for acting on it, not
  // for reading it. That is the whole reason the summaries exist.
  // Enough to see the shape of the list without it becoming the panel.
  const LIST_CAP = 12;

  const st = vscode.getState() || {};
  const openRows = new Set(Array.isArray(st.open) ? st.open : []);
  const bodyFor = (key) => $('body' + key.charAt(0).toUpperCase() + key.slice(1));

  function applyRows() {
    for (const head of document.querySelectorAll('.rowhead')) {
      const key = head.dataset.row;
      if (!key) continue;
      const isOpen = openRows.has(key);
      const body = bodyFor(key);
      if (body) body.hidden = !isOpen;
      if (head.hasAttribute('aria-expanded')) head.setAttribute('aria-expanded', String(isOpen));
      const chev = head.querySelector('.chev');
      if (chev) chev.textContent = isOpen ? '▾' : '▸';
    }
  }

  for (const head of document.querySelectorAll('.rowhead')) {
    head.addEventListener('click', () => {
      const key = head.dataset.row;
      if (!key) return;
      if (openRows.has(key)) openRows.delete(key); else openRows.add(key);
      vscode.setState({ open: [...openRows] });
      applyRows();
    });
  }

  // The collapsed state of every row. Each is a short phrase, never a bare
  // colour: eleven glowing red/green dots used to be the only signal, which is
  // unreadable for the ~8% of men with a red-green deficiency and ambiguous for
  // everyone else ('is yellow bad?'). The hot/warn tones tint a phrase that is
  // already legible on its own.
  function setState(id, text, tone) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.className = 'rowstate' + (tone ? ' ' + tone : '');
  }

  function renderRowStates(d) {
    const a = d.autoLearn || {};
    const counts = a.counts || {};
    if (!a.enabled) setState('stAutoLearn', 'disabled');
    else if (a.busy) setState('stAutoLearn', 'scanning…');
    else if (a.error) setState('stAutoLearn', 'error', 'hot');
    else {
      // BOTH, not one or the other. Trouble used to sit ABOVE the counts in this
      // chain, on the argument that "3 to review" over a scan that could not read
      // the corpus asserts a number it cannot support. The argument is right and
      // the remedy was wrong: suppressing the count does not make the reader
      // better informed, it makes the one actionable thing on the row disappear
      // — and while a trouble condition was permanent, it disappeared
      // permanently, with no way for the user to get it back.
      //
      // The caveat is what the reader needed, so the caveat is APPENDED. The
      // count keeps its place and 'scan degraded' qualifies it, which is the
      // honest form of the same warning and the form the card body already used.
      //
      // No backtick anywhere in this comment, for the reason stated in
      // scanTrouble below: this whole block lives inside the webview template
      // literal and one backtick would end the string.
      const degraded = scanTrouble(a.scan).length ? 'scan degraded' : '';
      const headline = counts.review ? counts.review + ' to review'
        : counts.safe ? counts.safe + ' safe to apply'
          : degraded ? '' : String(a.mode || 'recommend');
      const text = [headline, degraded].filter(Boolean).join(' · ');
      setState('stAutoLearn', text, (degraded || counts.review || counts.safe) ? 'warn' : null);
    }

    const g = d.guidance || {};
    setState('stGuidance', g.partial ? 'partially installed'
      : !g.on ? 'not installed' : (g.current ? 'on' : 'older wording'),
      g.partial || (g.on && !g.current) ? 'warn' : null);

    const gt = d.gates || {};
    setState('stGates', !gt.compiled ? 'nothing compiled'
      : gt.partial ? gt.count + ' partially installed'
        : !gt.on ? gt.count + ' waiting'
          : (gt.current ? gt.count + ' active' : 'stale — refresh'),
      !gt.compiled ? null : (!gt.on || !gt.current ? 'warn' : null));

    const m = d.memory || {};
    // NOT + m.unresolved. An unresolved [[link]] is report-only by design: memoryLint.js's
    // fullReport says so, and the memory convention treats a [[name]] with no file yet as a
    // forward-link worth writing rather than an error. Counting it here made the badge read
    // "3 to fix" while the card body said "index clean, all links resolve" in the same view,
    // over a Rebuild button that cannot clear it because there is nothing to clear. Every
    // other consumer -- status bar, output channel, card body -- counts over + broken.
    const issues = (m.over || 0) + (m.broken || 0);
    // linesOver and overBudget are whole-file conditions with no line to point at, so they
    // do not inflate the "to fix" count. They must still colour the row: a truncated index
    // is worse than anything the count can hold, and reading green through it is the
    // failure this card already had once.
    const capped = !!(m.linesOver || m.overBudget);
    setState('stMemory',
      (m.tokens != null ? fmtK(m.tokens) + ' tok' : 'no index')
        + (m.linesOver ? ' · ' + m.lines + '/' + (m.maxLines || 200) + ' lines' : '')
        + (issues ? ' · ' + issues + ' to fix' : ''),
      (issues || capped) ? 'warn' : null);

    // promote/prune are counts, not arrays, and 'pending' is defined the same way
    // renderLocal defines it, so the row and the card can never disagree.
    const l = d.local || {};
    const pending = (l.promote || 0) + (l.prune || 0);
    if (l.blocked) setState('stLocal', 'retired MAX state active', 'warn');
    else if (!l.trusted) setState('stLocal', 'workspace not trusted');
    else if (pending) setState('stLocal', pending + ' to drain', 'warn');
    else setState('stLocal', 'drained');

    const complete = d.claudePermissionsComplete !== false && d.settingsState !== 'unreadable'
      && codexCounted(d.codexPermissions);
    const known = (d.savedPermissions || []).length;
    // No tone for the one-off count: it is a note, not a warning (see oneOffApprovals).
    const oneOff = oneOffApprovals(d);
    setState('wcount', (complete ? known + ' total' : (known ? known + '+' : '?') + ' known')
      + (oneOff ? ' · ' + oneOff + ' one-off' : ''));
  }

  // The Codex count is whole only when every file was read AND the trusted-project folders
  // have been settled. While Codex is still being asked which project folders it trusts
  // (codexPermissions.pending, 2026-10-14), the user-scope count is a lower bound ('N+'), and
  // the Saved permissions list says so rather than "No saved permissions yet" (F4). The status
  // pill keeps reading .complete alone: a check in progress is not a read that failed.
  function codexCounted(codex) {
    return !!codex && codex.complete === true && codex.pending !== true;
  }

  // Shared by the Saved permissions badge above and the line in its body below, the way
  // scanTrouble is shared by the Auto Learn badge and card, so the two can never
  // disagree. Only a positive whole count renders; zero, absent and malformed all mean
  // there is nothing to say. Deliberately muted everywhere: the count is a heuristic
  // over stored text, and a tinted warning would push a user to delete approvals, some
  // of which may still be doing exactly what they want.
  function oneOffApprovals(d) {
    const dead = d && d.deadApprovals;
    const count = dead ? Number(dead.count) : 0;
    return Number.isInteger(count) && count > 0 ? count : 0;
  }

  // Read-only. The click opens the ordinary saved-permissions picker filtered to these
  // entries, where each removal is still confirmed one at a time; there is no bulk
  // removal, on purpose.
  let oneOffShown = 0;
  function renderDeadApprovals(d) {
    const el = $('deadApprovals');
    oneOffShown = oneOffApprovals(d);
    el.hidden = !oneOffShown;
    el.textContent = oneOffShown
      ? oneOffShown + ' saved shell approval' + (oneOffShown === 1 ? ' is a one-off script' : 's are one-off scripts')
        + ' that will prompt again on any variation — review'
      : '';
    const by = (d && d.deadApprovals && d.deadApprovals.byReason) || {};
    el.title = oneOffShown
      ? 'Exact Bash or PowerShell approvals that start with something other than a command, or chain'
        + ' several. Claude Code stores them verbatim, so each covers at most its own text and the next'
        + ' variation prompts again. Nothing is removed automatically. '
        + Object.keys(by).sort().map((key) => key + ': ' + by[key]).join(' · ')
      : '';
  }

  // The sibling line (2026-10-13): saved WILDCARD grants whose head is shell grammar
  // (a keyword, an expansion, the PowerShell call operator) rather than a command, so
  // they match more than the approval they came from. Same rules as the line above:
  // only a positive whole count renders, muted, and the click opens the shared picker
  // filtered to these entries with per-entry removal. It does not add to the badge; the
  // one-off count there is the established signal and a second suffix would crowd it.
  let overBroadShown = 0;
  function overBroadGrantCount(d) {
    const broad = d && d.overBroadGrants;
    const count = broad ? Number(broad.count) : 0;
    return Number.isInteger(count) && count > 0 ? count : 0;
  }
  function renderOverBroadGrants(d) {
    const el = $('overBroadGrants');
    overBroadShown = overBroadGrantCount(d);
    el.hidden = !overBroadShown;
    el.textContent = overBroadShown
      ? overBroadShown + ' saved wildcard grant' + (overBroadShown === 1
        ? ' names shell grammar rather than a command and matches'
        : 's name shell grammar rather than a command and match') + ' more than intended — review'
      : '';
    const by = (d && d.overBroadGrants && d.overBroadGrants.byReason) || {};
    el.title = overBroadShown
      ? 'Wildcard Bash or PowerShell grants keyed on a shell keyword, an expansion or an operator'
        + ' instead of a program, such as Bash(for *) or Bash(export *). Each matches every line that'
        + ' starts that way, whatever it runs. Nothing is removed automatically. '
        + Object.keys(by).sort().map((key) => key + ': ' + by[key]).join(' · ')
      : '';
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 5)   return 'last wildcarded: just now';
    if (s < 60)  return 'last wildcarded: ' + s + 's ago';
    if (s < 3600) return 'last wildcarded: ' + Math.round(s/60) + 'm ago';
    return 'last wildcarded: ' + Math.round(s/3600) + 'h ago';
  }

  function renderAutoLearn(a) {
    a = a || {};
    const counts = a.counts || {};
    const active = !!a.enabled;
    $('aldot').className = 'dot' + (active && !a.error ? '' : ' idle');
    const alMode = String(a.mode || 'recommend').toLowerCase();
    // 'recommend' is the default and the usual state — show it unlabeled; only name
    // the mode when it's the less-common observe / auto-safe.
    $('altext').textContent = 'Auto Learn' + (alMode === 'recommend' ? '' : ': ' + alMode.toUpperCase());
    const notes = [active ? 'Claude + Codex history' : 'disabled', 'threshold ' + (a.threshold || 3), 'Codex ' + (a.codexScope || 'user')];
    if (counts.covered) notes.push(counts.covered + ' already covered');
    if (a.busy) notes.unshift('scanning…');
    if (a.scopeWarning) notes.push(a.scopeWarning);
    if (a.codexEvidence?.pending) {
      notes.push('rebuilding older Codex evidence' + (a.codexEvidence.remainingFiles
        ? ': ' + a.codexEvidence.remainingFiles + ' transcripts still need a complete read'
        : a.codexEvidence.reasons?.includes('history-unavailable') ? ': history is unavailable' : ''));
    }
    if (a.codexEvidence?.uncertainCandidates) {
      notes.push(a.codexEvidence.quarantinedRuns + ' older runs excluded from new approvals because their source cannot be verified');
    }
    if (a.codexEvidence?.untimedFailureRuns) {
      notes.push(a.codexEvidence.untimedFailureRuns + ' failed Codex runs could not be dated during rebuild; existing approvals retained');
    }
    if (a.error) notes.push('error: ' + a.error);
    $('alsub').textContent = notes.join(' · ');
    $('alsafe').textContent = counts.safe || 0;
    $('alreview').textContent = counts.review || 0;
    $('alobserve').textContent = counts.observe || 0;
    $('alUndo').disabled = !a.canUndo || !!a.busy;
    for (const id of ['alScan', 'alWhy']) $(id).disabled = !!a.busy;
    $('alReview').disabled = !active || !!a.busy || a.mode === 'observe';
    $('alReview').textContent = (counts.review > 0) ? 'Review (' + counts.review + ')' : 'Review';

    // What the last scan could not read. Never collapsed into a.error, which is
    // the message of an exception that ESCAPED — a scan that returned while
    // failing to read half the corpus sets that to null and used to leave the
    // card reading perfectly healthy.
    const health = $('alScanHealth');
    const s = a.scan;
    if (!s) { health.textContent = ''; health.className = 'memissues'; health.title = ''; return; }
    const trouble = scanTrouble(s);
    // The persisted Codex reasons, on hover. The line itself has room for a
    // phrase; the reason says which folders were compared and why. Empty when
    // there are none, so a cleared condition does not leave a stale tooltip.
    health.title = (s.codexHistoryReasons || []).join(' · ');
    if (trouble.length) {
      health.className = 'memissues';
      health.style.color = 'var(--vscode-charts-yellow, #d29922)';
      health.textContent = '⚠ last scan: ' + trouble.join(' · ') + catchUp(s);
    } else {
      health.className = 'memissues muted';
      health.style.color = '';
      health.textContent = '✓ last scan read ' + s.files + ' file' + (s.files === 1 ? '' : 's')
        + ' cleanly' + (s.pruned ? ' · ' + s.pruned + ' pruned' : '') + catchUp(s);
    }
  }

  // A file the per-scan ingest budget deferred is CATCH-UP: the cursor stopped
  // on a record boundary and the next scan continues from it. It used to be a
  // trouble entry, "N partly read", which put "scan degraded" on the row for
  // every scan it took a big transcript to catch up -- three, for the 170 MB
  // archived rollout measured 2026-10-13 -- over a scan that lost nothing. So
  // it is said beside the verdict, in both branches, and never as the verdict.
  function catchUp(s) {
    if (!s.partial) return '';
    let left = '';
    if (s.deferredBytes) {
      const mb = s.deferredBytes / 1048576;
      left = ' (' + (mb < 0.1 ? '<0.1' : mb < 10 ? mb.toFixed(1) : String(Math.round(mb))) + ' MB left)';
    }
    return ' · catching up on ' + s.partial + ' large transcript' + (s.partial === 1 ? '' : 's') + left;
  }

  // What the stale verdict is made of, from the counts the probe persisted.
  // The fixed sentence it replaced, "Codex history store has moved", was wrong
  // about the one case anyone hit: four archived threads, nothing moved. The
  // fallback is for a state file written before the counts existed, and it is
  // the phrase the old sentence ended with, so a stale verdict is never silent.
  function codexStalePhrase(s) {
    const f = s.codexHistoryFindings || {};
    const count = (n, one, many) => n + ' ' + (n === 1 ? one : many);
    const parts = [];
    if (f.orphans) parts.push(count(f.orphans, 'Codex thread', 'Codex threads') + ' with no transcript');
    if (f.relocated) {
      parts.push(count(f.relocated, 'Codex transcript', 'Codex transcripts') + ' outside the scanned folders');
    }
    if (f.projectionAhead) {
      parts.push('Codex store ahead of ' + count(f.projectionAhead, 'transcript', 'transcripts'));
    }
    if (f.emptyRollouts) parts.push('Codex rollout folders empty beside a populated store');
    return parts.length ? parts.join(' · ') : 'Codex rollout directory is stale';
  }

  // Shared by the card body and the collapsed row badge, so the two can never
  // disagree the way the memory card's badge and body once did.
  function scanTrouble(s) {
    if (!s) return [];
    const trouble = [];
    // First: it subsumes the rest. "Nothing was enumerated" is not the same
    // statement as "a root errored", and on the numbers alone it is
    // indistinguishable from an ordinary quiet scan.
    if (s.blindScan) trouble.push('nothing enumerated — cursor map preserved');
    // Second, for the same reason: a scan of a directory Codex has stopped
    // writing to looks healthy on every other number here.
    if (s.codexHistoryStale) trouble.push(codexStalePhrase(s));
    // 'partial' ONLY, and 'unavailable' deliberately absent. That state means the
    // probe cannot run on this runtime at all: readThreadStoreIds needs
    // node:sqlite, and on a host that cannot load it this branch used to fire on
    // every scan, for ever. VS Code 1.141.1 (Node 24.21.0) loads it; hosts within
    // the ^1.80 engine floor may not, so the unavailable tier stays (measured
    // 2026-10-13). A check that is inapplicable is not a degraded check, and
    // reporting it as one cost the user the actionable count in the row badge
    // above. The half that is real, codexHistoryStale, is computed from the
    // session index against the rollout folders without sqlite and still fires
    // on the line above.
    //
    // No backtick in this comment on purpose, same as the one further down: this
    // function lives inside the webview template literal.
    else if (s.codexHistoryInspected === 'partial') trouble.push('Codex history-store check ran degraded');
    if (s.errors) trouble.push(s.errors + ' unreadable file' + (s.errors === 1 ? '' : 's'));
    // Bytes that had no record boundary at all and were STEPPED OVER, so they
    // are lost to the evidence rather than deferred. Unlike partial, this is.
    if (s.unreadable) {
      trouble.push(s.unreadable + ' file' + (s.unreadable === 1 ? '' : 's') + ' with an unreadable stretch skipped');
    }
    // "The evidence cap is over its limit and cannot get back under it." Distinct
    // from the pruned count, which is what came OUT: this is what would not go. No
    // backtick in this comment on purpose - it lives inside the webview template
    // literal, and one would end the string.
    if (s.retainedObservations) {
      trouble.push(s.retainedObservations + ' observation hash'
        + (s.retainedObservations === 1 ? '' : 'es') + ' held over the cap');
    }
    // No partial entry: a budget deferral is catch-up and is drawn beside the
    // verdict by catchUp above, never as trouble.
    if (s.unmatchedResults) {
      trouble.push(s.unmatchedResults + ' unmatched result' + (s.unmatchedResults === 1 ? '' : 's'));
    }
    return trouble;
  }

  function fmtK(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  function renderMemory(m) {
    const card = $('memCard');
    if (!m) { card.style.display = 'none'; return; }
    card.style.display = '';

    const ready = m.llm === 'ready';
    $('llmDot').className = 'dot' + (ready ? '' : ' idle');
    $('llmText').textContent = ready
      ? 'CPU LLM: ready (bge-small, 384-dim)'
      : (m.llm === 'model-missing' ? 'CPU LLM: model not found' : 'CPU LLM: venv not found');
    $('llmText').style.fontWeight = '600';
    $('memDir').textContent = m.dir;

    $('memTok').textContent = fmtK(m.tokens);
    $('memTok').title = 'budget ' + fmtK(m.budgetTokens) + ' tok/session';
    if (m.overBudget) $('memTok').style.color = 'var(--vscode-charts-red, #f85149)';
    else $('memTok').style.color = '';
    $('memFiles').textContent = m.files;
    $('memFiles').title = m.indexable == null
      ? 'markdown files in the memory dir'
      : m.indexable + ' indexable + MEMORY.md (the index itself is never embedded)';
    $('memEmb').textContent = m.embedded == null ? '–' : m.embedded;
    $('memEmb').title = m.embedded == null
      ? 'recall cache not built yet — click Rebuild'
      : m.embedded + ' of ' + (m.indexable == null ? '?' : m.indexable) + ' indexable memories embedded'
        + (m.stale ? ' — cache is behind the files' : '');
    $('memEmb').style.color = m.stale ? 'var(--vscode-charts-yellow, #d29922)' : '';

    // Shown even when it is fine, because this is the axis that grows: roughly a line per
    // project, against a cap the loader enforces silently. Bytes barely move by comparison,
    // so a card that only watched bytes could read green until the tail stopped loading.
    const maxLines = m.maxLines || 200;
    $('memLines').textContent = m.lines == null ? '–' : m.lines;
    $('memLinesLabel').textContent = 'of ' + maxLines + ' lines';
    $('memLines').title = m.lines == null
      ? 'line count unavailable'
      : m.lines + ' of ' + maxLines + ' lines used. Claude Code loads the first ' + maxLines
        + ' and drops the rest without saying so.';
    $('memLines').style.color = m.linesOver
      ? 'var(--vscode-charts-red, #f85149)'
      : (m.lines != null && m.lines >= maxLines * 0.9
        ? 'var(--vscode-charts-yellow, #d29922)' : '');

    const issues = [];
    if (m.linesOver) issues.push(m.lines + '/' + maxLines + ' lines, past the cap');
    if (m.over)   issues.push(m.over + ' over budget');
    if (m.broken) issues.push(m.broken + ' broken link' + (m.broken !== 1 ? 's' : ''));
    const el = $('memIssues');
    el.innerHTML = '';
    if (issues.length) {
      el.className = 'memissues';
      const a = document.createElement('a');
      a.className = 'memlink';
      a.textContent = '⚠ ' + issues.join(' · ') + ' — open report';
      a.addEventListener('click', (e) => { e.preventDefault(); vscode.postMessage({ type: 'lintMemory' }); });
      el.appendChild(a);
    } else if (m.unresolved) {
      // Not a warning and not "to fix": a [[link]] with no file yet is a forward-link. Say so
      // plainly rather than claiming "all links resolve", which was false whenever this was
      // non-zero, and make it openable so the names are one click away.
      el.className = 'memissues muted';
      const a = document.createElement('a');
      a.className = 'memlink';
      a.textContent = '✓ index clean · ' + m.unresolved + ' forward-link'
        + (m.unresolved !== 1 ? 's' : '') + ' not written yet — open report';
      a.addEventListener('click', (e) => { e.preventDefault(); vscode.postMessage({ type: 'lintMemory' }); });
      el.appendChild(a);
    } else {
      el.className = 'memissues muted';
      el.textContent = '✓ index clean, all links resolve';
    }
  }

  function renderCodexMemory(m) {
    m = m || {};
    // Every count on this card read plural: a real store showed "1 issues" (2026-10-13).
    const files = m.files || 0;
    setState('stCodexMemory', m.state === 'absent' ? 'no files yet'
      : files + ' file' + (files === 1 ? '' : 's') + (m.state === 'unreadable' ? ' · partly unreadable' : '')
        + (m.issues ? ' · ' + m.issues + ' issue' + (m.issues === 1 ? '' : 's') : '') + (m.error ? ' · diagnostics unavailable' : ''),
      m.state === 'unreadable' || m.issues || m.error ? 'warn' : null);
    $('codexMemoryDir').textContent = m.root || '';
    $('codexMemoryStatus').textContent = m.error || (m.lintEnabled === false ? 'Native diagnostics are disabled. ' : '')
      + 'Codex feature enablement is not inferred. Search reads the current files.';
    var g = m.gates || {};
    $('codexMemoryGatesStatus').textContent = g.error || g.watchError || (g.on
      ? 'Native memory gates: ' + (g.count == null ? '?' : g.count) + ' section' + (g.count === 1 ? '' : 's') + '; ' + (g.current ? 'current' : 'update pending') + '.'
      : 'Native memory gates are off. Only explicitly marked global sections can be installed.');
    // The configured codex-cli against the tested window. Information only,
    // whatever the version says: the line keeps its muted class and the row
    // state above never reads it (src/codex-version.js, 2026-10-13).
    var cli = m.cli || null;
    var cliLine = $('codexCliVersion');
    cliLine.textContent = cli && cli.note ? cli.note : '';
    cliLine.title = cli && cli.tested ? 'Tested Codex versions: ' + cli.tested.join(', ') : '';
  }

  function renderLocal(l) {
    const card = $('localCard');
    if (!l) { card.style.display = 'none'; return; }
    card.style.display = '';
    // Null counts mean no dry run ran, which is an untrusted window. A 0 there would
    // claim the file was checked and found clean, so each renders as the dash the
    // markup starts with, and the headline says the approvals were not counted.
    const counted = l.promote != null;
    const pending = (l.promote || 0) + (l.prune || 0);
    const count = (n) => (n == null ? '–' : n);
    $('locdot').className = 'dot' + (pending && l.trusted && !l.blocked ? '' : ' idle');
    $('loctext').textContent = l.blocked
      ? 'Project-local approvals - retired MAX state active'
      : (!counted ? 'Project-local approvals: not counted'
        : (pending ? 'Project-local approvals: ' + pending + ' to drain' : 'Project-local approvals: drained'));
    $('loctext').style.fontWeight = '600';
    // One folder names its file outright. Two or more name the count, and every
    // path goes in the tooltip, on one line. The tooltip also says what the card
    // cannot list: the CLI hook drains the folder each Claude session runs in,
    // which is how a subfolder file can be drained while this card shows nothing.
    const files = l.files || [];
    const where = files.length > 1 ? files.length + ' folders' : (files[0] || '');
    $('locsub').textContent = l.blocked
      ? 'A retired auto-approve hook, or grants it generated, is still in user scope. Remove the legacy configuration before draining.'
      : (!l.trusted ? 'workspace not trusted — read-only · ' + where
        : where + (l.enabled ? '' : ' · auto-drain off'));
    $('locsub').title = files.join(' · ')
      + ' · with the CLI hook installed, the folder each Claude session runs in is drained too';
    $('locpromote').textContent = count(l.promote);
    $('locprune').textContent = count(l.prune);
    $('lockept').textContent = count(l.kept);
    $('locpromote').title = 'portable command families that would move to user scope';
    $('locprune').title = 'local entries user scope already grants';
    $('lockept').title = 'entries only this project can justify (script blobs, absolute paths, MCP tools)';
    $('drainLocal').disabled = !l.trusted || !!l.blocked || pending === 0;
    // Uncounted is not "nothing": the label stays the markup default, disabled.
    $('drainLocal').textContent = !counted ? '⤴  Drain into user scope'
      : (pending ? '⤴  Drain ' + pending + ' into user scope' : '⤴  Nothing to drain');
  }

  function renderGuidance(g) {
    const card = $('guidanceCard');
    if (!g) { card.style.display = 'none'; return; }
    card.style.display = '';
    $('gddot').className = 'dot' + (g.on && g.current ? '' : ' idle');
    const state = g.on ? (g.current ? 'ON' : 'ON (older wording)') : (g.partial ? 'PARTIAL' : 'OFF');
    $('gdtext').textContent = 'Shell-style guidance: ' + state
      + (g.agents.length ? ' — ' + g.agents.join(' + ') : '');
    $('gdtext').style.fontWeight = '600';
    $('gdsub').textContent = g.on || g.partial
      ? 'simple commands make approvals easier to reuse · ' + g.path
      : 'teach ' + g.targets.join(' + ') + ' to write reusable command invocations';
    if (g.errors?.length) $('gdsub').textContent += ' · ' + g.errors.join(' · ');
    const btn = $('guidanceBtn');
    btn.disabled = !g.readable;
    btn.classList.toggle('on', !!g.on);
    // Installed-and-current is the resting state, so the button goes quiet and the ellipsis
    // announces the confirm dialog. Stale wording gets the honest label instead, now that
    // toggling a stale block refreshes it rather than tearing it out.
    btn.classList.toggle('managed', !!g.on && !!g.current);
    btn.textContent = g.on
      ? (g.current ? 'Remove guidance…' : 'Refresh wording')
      : 'Add to ' + g.targets.join(' + ') + ' instructions';
  }

  function renderGates(g) {
    const card = $('gatesCard');
    if (!g) { card.style.display = 'none'; return; }
    card.style.display = '';
    $('mgdot').className = 'dot' + (g.on && g.current ? '' : ' idle');
    const state = !g.compiled ? 'nothing compiled'
      : g.on ? (g.current ? 'ON' : 'ON (corpus changed)')
        : (g.partial ? 'PARTIAL' : 'OFF');
    $('mgtext').textContent = 'Memory gates: ' + state
      + (g.on && g.count ? ' — ' + g.count + ' gate' + (g.count === 1 ? '' : 's') : '');
    $('mgtext').style.fontWeight = '600';
    $('mgsub').textContent = !g.compiled
      ? 'no memory carries a scope:global gate block yet'
      : g.on || g.partial
        ? 'your standing orders, resident every session · ' + g.path
        : g.count + ' compiled gate' + (g.count === 1 ? '' : 's') + ' waiting to be installed';
    if (g.errors?.length) $('mgsub').textContent += ' · ' + g.errors.join(' · ');
    const btn = $('gatesBtn');
    // Nothing compiled AND no memory the compiler could take: offering "Compile
    // gates" here spent a modal, a compile and a warning toast to end up saying
    // "nothing to install". Say it on the button instead. gateSources is only
    // trusted when it is a number — undefined means the memory report was
    // unavailable, and an unknown count must still offer the action.
    const noSources = g.gateSources === 0;
    btn.disabled = !g.readable || (!g.compiled && noSources);
    btn.classList.toggle('on', !!g.on);
    // Same treatment as guidance: installed-and-current is the resting state, so the button
    // stops shouting and the ellipsis warns that a confirm follows.
    btn.classList.toggle('managed', !!g.on && !!g.current);
    btn.textContent = !g.compiled ? (noSources ? 'No gates to compile' : 'Compile gates')
      : g.on ? (g.current ? 'Remove gates…' : 'Refresh from memory')
        : 'Add to ' + g.targets.join(' + ') + ' instructions';
  }

  function render(d) {
    const countsComplete = d.claudePermissionsComplete !== false && d.settingsState !== 'unreadable'
      && d.codexPermissions?.complete === true;
    $('dot').className = 'dot' + (countsComplete ? '' : ' idle');
    $('statusText').textContent = countsComplete ? 'Permissions' : 'Permissions · count incomplete';
    // Empty string when the manifest could not be read, which renders as nothing
    // rather than as 'v' or 'undefined'.
    $('version').textContent = d.version ? 'v' + d.version : '';
    $('watching').textContent = 'watching ' + d.settingsPath + (d.codexWatching ? ' + Codex history' : '');
    renderAutoLearn(d.autoLearn);
    renderLocal(d.local);
    renderGuidance(d.guidance);
    renderGates(d.gates);
    renderMemory(d.memory);
    renderCodexMemory(d.codexMemory);
    $('lastRun').textContent = d.lastRun ? 'Claude ' + timeAgo(d.lastRun) : '';
    $('backup').textContent = d.backupCount
      ? 'Claude backup: ' + d.backupCount + ' entries saved'
      : 'Claude backup: none yet';
    const codex = d.codexPermissions || { allow: 0, complete: false, issues: [] };
    const claudeComplete = d.claudePermissionsComplete !== false && d.settingsState !== 'unreadable';
    const countText = (count, complete) => complete ? String(count) : count ? count + '+' : '?';
    $('claudeTotal').textContent = countText(d.total, claudeComplete);
    $('codexTotal').textContent = countText(codex.allow, codexCounted(codex));
    $('total').textContent = countText(d.total + codex.allow, claudeComplete && codexCounted(codex));
    $('total').title = 'Saved Claude allow entries plus local Codex shell allow declarations; not a count of commands or effective access.';
    $('claudeTotal').title = d.wildcardCount + ' wildcards; ' + d.specificCount + ' specific entries';
    $('codexTotal').title = (codex.prompt || 0) + ' prompt and ' + (codex.forbidden || 0)
      + ' forbidden declarations are excluded. MCP, project, managed and session approvals are outside this count.';
    $('permissionCoverage').textContent = [
      !claudeComplete ? 'Claude count incomplete.' : '',
      !codex.complete ? 'Codex count incomplete.' : '',
      codex.pending ? 'Checking which project rule folders Codex trusts…' : '',
    ].filter(Boolean).join(' ');
    $('permissionCoverage').title = (codex.issues || []).map((issue) => issue.reason).join(' · ');
    const list = $('list');
    list.innerHTML = '';
    const saved = d.savedPermissions || [];
    if (!saved.length && countsComplete && codexCounted(codex)) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No saved permissions yet: approve some commands, or click Optimize permissions.';
      list.appendChild(li);
    } else {
      // Alternate agents so either remains visible when the other has hundreds
      // of entries. Keep short Claude command families first in the preview.
      const simple = (entry) => /^[A-Za-z]+\\([A-Za-z][\\w.-]*[ :]\\*\\)$/.test(entry.label);
      const claude = saved.filter((entry) => entry.agent === 'claude').sort((a, b) =>
        Number(simple(b)) - Number(simple(a)) || a.label.localeCompare(b.label));
      const codexRows = saved.filter((entry) => entry.agent === 'codex').sort((a, b) => a.label.localeCompare(b.label));
      const preview = [];
      for (let i = 0; preview.length < LIST_CAP && i < Math.max(claude.length, codexRows.length); i++) {
        if (claude[i]) preview.push(claude[i]);
        if (codexRows[i] && preview.length < LIST_CAP) preview.push(codexRows[i]);
      }
      for (const entry of preview) {
        const li = document.createElement('li');
        const code = document.createElement('code');
        code.textContent = entry.label;
        const agent = document.createElement('span');
        agent.className = 'agent'; agent.textContent = entry.agent === 'codex' ? 'Codex' : 'Claude';
        const x = document.createElement('button');
        if (entry.agent === 'codex') {
          li.title = entry.path;
          x.className = 'inspect'; x.textContent = '…'; x.title = 'Inspect or remove this Codex rule';
          x.addEventListener('click', () => vscode.postMessage({ type: 'viewPermissions',
            selection: { agent: 'codex', path: entry.path, pattern: entry.pattern, start: entry.start } }));
        } else {
          x.className = 'x'; x.textContent = '✕'; x.title = 'Remove this Claude permission';
          x.addEventListener('click', () => vscode.postMessage({ type: 'remove', value: entry.value }));
        }
        li.appendChild(code); li.appendChild(agent); li.appendChild(x);
        list.appendChild(li);
      }
      const hidden = saved.length - preview.length;
      if (hidden > 0) {
        const li = document.createElement('li');
        li.className = 'more';
        li.title = 'Open the full list with a filter box';
        li.textContent = 'and ' + hidden + ' more - search all ' + saved.length + ' →';
        li.addEventListener('click', () => vscode.postMessage({ type: 'viewPermissions' }));
        list.appendChild(li);
      }
    }
    if (!countsComplete || !codexCounted(codex)) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = countsComplete ? 'Codex project rules not listed yet: checking which project rule folders Codex trusts.' : 'Saved permissions incomplete. Open View / remove permissions for details.';
      list.appendChild(li);
    }
    renderDeadApprovals(d);
    renderOverBroadGrants(d);
    applyRows();
    renderRowStates(d);
  }

  $('runNow').addEventListener('click', () => vscode.postMessage({ type: 'optimizePermissions' }));
  $('alScan').addEventListener('click', () => vscode.postMessage({ type: 'autoLearnScan' }));
  $('alReview').addEventListener('click', () => vscode.postMessage({ type: 'autoLearnReview' }));
  $('alUndo').addEventListener('click', () => vscode.postMessage({ type: 'autoLearnUndo' }));
  $('alWhy').addEventListener('click', () => vscode.postMessage({ type: 'autoLearnWhy' }));
  $('permissionsView').addEventListener('click', () => vscode.postMessage({ type: 'viewPermissions' }));
  $('deadApprovals').addEventListener('click', () => {
    if (oneOffShown) vscode.postMessage({ type: 'viewPermissions', selection: { filter: 'dead' } });
  });
  $('overBroadGrants').addEventListener('click', () => {
    if (overBroadShown) vscode.postMessage({ type: 'viewPermissions', selection: { filter: 'over-broad' } });
  });
  $('permissionsRestore').addEventListener('click', () => vscode.postMessage({ type: 'restorePermissions' }));
  $('permissionsImport').addEventListener('click', () => vscode.postMessage({ type: 'importPermissions' }));
  $('codexHook').addEventListener('click', () => vscode.postMessage({ type: 'codexHook' }));
  $('reviewCodexMcp').addEventListener('click', () => vscode.postMessage({ type: 'reviewCodexMcp' }));
  $('searchCodexMemory').addEventListener('click', () => vscode.postMessage({ type: 'searchCodexMemory' }));
  $('rebuildCodexMemory').addEventListener('click', () => vscode.postMessage({ type: 'rebuildCodexMemory' }));
  $('codexMemoryGates').addEventListener('click', () => vscode.postMessage({ type: 'codexMemoryGates' }));
  $('inspectCodexMemory').addEventListener('click', () => vscode.postMessage({ type: 'inspectCodexMemory' }));
  $('rebuild').addEventListener('click', () => vscode.postMessage({ type: 'rebuildRecall' }));
  $('drainLocal').addEventListener('click', () => vscode.postMessage({ type: 'drainLocal' }));
  $('guidanceBtn').addEventListener('click', () => vscode.postMessage({ type: 'toggleGuidance' }));
  $('gatesBtn').addEventListener('click', () => vscode.postMessage({ type: 'toggleGates' }));
  window.addEventListener('message', (e) => { if (e.data?.type === 'data') render(e.data); });
  applyRows();
  vscode.postMessage({ type: 'refresh' });
</script>
</body>
</html>`;
  }
}

async function deactivate() {
  const generation = activationGeneration;
  // First, before anything is awaited: everything below this line is racing the
  // continuations it is trying to stop.
  deactivated = true;
  codexFeatureUi?.dispose();
  codexFeatureUi = null;
  codexMemoryLint?.dispose();
  codexMemoryGatesUi?.dispose();
  codexMemoryGatesUi = null;
  codexMemoryLint = null;
  codexMemoryReport = null;
  clearTimeout(debounceTimer);
  clearTimeout(policyBounce);
  clearTimeout(localDrainBounce);
  clearTimeout(memBounce);
  clearTimeout(autoLearnBounce);
  clearInterval(autoLearnTimer);
  // These two were missed. `gatesBounce` spawns Python from its callback, and
  // the recall timeout's handle was never captured at all, so both could fire
  // against a torn-down extension after a reload or an upgrade.
  clearTimeout(gatesBounce);
  clearTimeout(recallSyncTimer);
  clearTimeout(dashboardBounce);
  // A cleared timer only stops a spawn that had not started. These four had, and
  // nothing retained them, so a reload left up to a 180s python child running
  // against a torn-down host — and the gate compile's callback wrote policy.
  // Started here, before anything is awaited; awaited (bounded) below, after the
  // retainers are dropped, so a slow taskkill never holds a slot a successor needs.
  const reaped = killLiveChildren();
  // The trust worker among those children was just killed, and its refresh will
  // settle with "the worker failed". Abandoned, so that answer is never cached as
  // the verdict a same-realm re-activate reads (src/codex-policy.js).
  abandonProjectTrustRefreshes();
  // The same for a Codex version probe the kill just ended: abandoned, so it is not
  // cached as a 60 s "timed out" that a same-realm re-activate would show first.
  abandonCodexVersionProbes();
  // The fifth in-flight job, and the one this pair of calls used to miss: the
  // 32MB recall-model download is not a ChildProcess, so `liveChildren` never
  // held it and nothing here could stop it. It ran to completion and renamed a
  // model into ~/.claude on behalf of a host that had already gone.
  abortLiveTransfers();
  if (outputChannel) { try { outputChannel.dispose(); } catch { /* already gone */ } }
  outputChannel = null;
  // The retainers, dropped BEFORE the await, not after.
  //
  // These hold real memory across a same-realm re-activate (an extension
  // disable/enable, or an upgrade), unlike the timer handles above — which are
  // already cleared, and holding a dead handle costs nothing:
  //
  //   dashboard    the webview provider, and through it the whole ExtensionContext
  //   memoryLint   the same, via this.context, which reconfigure() needs
  //   autoLearnManager / autoLearnCardCache   parsed history state, the largest
  //                thing this extension ever builds
  //
  // They were originally nulled at the END of this function, after the drain, and
  // that was a real defect. The drain below has no deadline by deliberate
  // decision, so if the host's deactivate timeout expires and a same-realm
  // activate() runs during it, this continuation resumes and nulls slots the
  // SUCCESSOR has already populated. Measured: 0 pushes reached the successor's
  // live webview through `dashboard?.refresh()` while calling refresh() on the
  // instance directly still produced one — the panel rendered and its buttons
  // worked, and all ~35 refresh call sites were a permanent no-op for the life of
  // the window. `memoryLint = null` did the same to reconfigure(), which is
  // verbatim the defect reconfigure() was added to fix.
  //
  // None of them needs the drain to finish, so nothing is lost by dropping them
  // here.
  dashboard = null;
  memoryLint = null;
  autoLearnManager = null;
  autoLearnManagerKey = null;
  autoLearnCardCache = null;

  // The drain is STARTED here, synchronously, exactly where it always was: a
  // same-realm activate() can run during the first await below, and it decides
  // whether to drop a stranded runner by whether this one is already deactivating.
  // Awaiting anything before this call let the successor keep the runner the old
  // teardown then drained (test/extension-lifecycle-async.test.js, "a re-activate
  // during the drain keeps its own dashboard and memory lint").
  const drained = autoLearnWorkerRunner ? autoLearnWorkerRunner.deactivate() : null;
  // The tree kills started above. Bounded: taskkill has its own 5 s ceiling, and a
  // teardown must not wait longer than that on a process that refuses to die.
  await Promise.race([reaped, new Promise((resolve) => setTimeout(resolve, 6000).unref?.())]);
  if (drained) await drained;
  // This one DOES have to come after the drain, so nothing shortens it.
  // `deactivating` inside the runner is sticky and its public API has no reset,
  // while getAutoLearnWorkerRunner() only builds one when the slot is empty — so
  // a retained instance made every Auto Learn op after a same-realm re-activate
  // reject "Auto Learn is deactivating", permanently. Nulling it is correct
  // whether or not a successor exists -- EXCEPT that it now can. activate()
  // drops a stranded runner itself, precisely so a wedged drain cannot leave the
  // successor with a dead one, so by the time this continuation resumes the slot
  // may hold the SUCCESSOR's live runner. Nulling that without deactivating it
  // leaks a worker thread per occurrence. Same generation test as the busy latch
  // below: only clear the slot if it is still ours.
  if (generation === activationGeneration) autoLearnWorkerRunner = null;
  // The busy latch is different: a successor's in-flight scan can legitimately
  // hold it, so only clear it if no re-activate happened while we awaited.
  // `activate()` bumps the generation, which is the cheapest way to tell.
  if (generation === activationGeneration) autoLearnBusy = false;
}

module.exports = { activate, deactivate };
