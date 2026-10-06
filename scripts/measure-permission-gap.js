'use strict';

// How much friction could a rules-based PermissionRequest hook remove? Read-only
// measurement over the real Claude Code transcripts and Codex rollouts.
//
// Every recorded call is run through the SAME decide() the hook ships
// (src/permission-request.js), against the rules on disk now, so a figure here
// describes the hook and not a second predictor that happens to resemble it.
//
// What a transcript cannot say, stated up front because it decides how every
// number below may be read: NEITHER PRODUCT RECORDS AN APPROVED DIALOG. A
// declined one leaves `toolDenialKind` (Claude) or "rejected by user" (Codex);
// an approved one looks exactly like a call no dialog was needed for. So the
// prompts-seen counts are LOWER BOUNDS built from what is visible, and the hook
// itself, in observe mode, is the only instrument that counts them directly.
//
// Output is counts, enumerated labels and host names. Command text, arguments,
// paths and result bodies are read to evaluate a call and never printed.
//
//   node scripts/measure-permission-gap.js [--home <dir>] [--json]

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadClaudeRules, loadCodexRules, decide } = require('../src/permission-request');
const { extractNestedShellCommands } = require('../src/history-adapters');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function* jsonlFiles(root, pattern) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && pattern.test(entry.name)) yield full;
    }
  }
}

function* records(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* a torn line is not a record */ }
  }
}

const bump = (object, key, by = 1) => { object[key] = (object[key] || 0) + by; };
const nested = (object, key) => (object[key] || (object[key] = {}));

// ── Claude ────────────────────────────────────────────────────────────────────

// Which denial kinds prove a dialog was on screen. `user-rejected` is the
// person pressing No. The others are a rule, the auto-mode classifier or an
// interruption, none of which shows a PermissionRequest dialog. A kind not
// named here is reported as itself, never folded into a bucket.
const DIALOG_DENIALS = new Set(['user-rejected']);
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
const PROMPTING_MODES = new Set(['default', 'acceptEdits', 'plan']);

// An ask rule for THIS tool matching the whole command or one segment, with no
// case fold and no cross-tool probe. The hook's own matching is deliberately
// wider than this; counting dialogs with it would overstate them.
function exactAsk(tool, input, loaded) {
  if (!COMMAND_TOOLS.has(tool) || !input || typeof input.command !== 'string') return false;
  const { coversPermission } = require('../src/managed-policy');
  const { splitCommandSegments } = require('../src/auto-learn');
  const texts = [input.command.trim(), ...splitCommandSegments(input.command, tool === 'Bash' ? 'bash' : 'powershell')
    .map((value) => value.trim())];
  return loaded.rules.ask.some((entry) => texts.some((text) => coversPermission(entry.rule, `${tool}(${text})`)));
}

// A subagent writes its own transcript under <session>/subagents/ with no mode
// record of its own, and inherits the session's mode. The session's mode at the
// call's timestamp is therefore attributed to it, and labelled as inherited.
function sessionModeTimelines(root) {
  const timelines = new Map();
  for (const file of jsonlFiles(root, /\.jsonl$/)) {
    if (/[\\/]subagents[\\/]/.test(file)) continue;
    const id = path.basename(file, '.jsonl');
    const points = [];
    for (const record of records(file)) {
      if (typeof record.permissionMode === 'string' && record.permissionMode && typeof record.timestamp === 'string') {
        points.push([record.timestamp, record.permissionMode]);
      }
    }
    points.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    timelines.set(id, points);
  }
  return timelines;
}

function inheritedMode(timelines, file, timestamp) {
  const match = /[\\/]([0-9a-f-]{36})[\\/]subagents[\\/]/i.exec(file);
  const points = match && timelines.get(match[1]);
  if (!points || !points.length) return null;
  let mode = points[0][1];
  for (const [ts, value] of points) { if (typeof timestamp === 'string' && ts <= timestamp) mode = value; else break; }
  return mode;
}

function measureClaude(home) {
  const root = path.join(home, '.claude', 'projects');
  const ruleCache = new Map();
  const rulesFor = (cwd) => {
    const key = String(cwd || '').toLowerCase();
    if (!ruleCache.has(key)) ruleCache.set(key, loadClaudeRules({ home, cwd, stopAt: home }));
    return ruleCache.get(key);
  };
  const timelines = sessionModeTimelines(root);
  const hosts = {};
  let files = 0;
  for (const file of jsonlFiles(root, /\.jsonl$/)) {
    files += 1;
    const subagent = /[\\/]subagents[\\/]/.test(file);
    let mode = null;
    let cwd = null;
    let host = 'unknown';
    const started = new Map();
    for (const record of records(file)) {
      if (typeof record.permissionMode === 'string' && record.permissionMode) mode = record.permissionMode;
      if (typeof record.cwd === 'string' && record.cwd) cwd = record.cwd;
      if (typeof record.entrypoint === 'string' && record.entrypoint) host = record.entrypoint;
      const content = record.message && Array.isArray(record.message.content) ? record.message.content : [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_use') {
          const inherited = !mode && subagent ? inheritedMode(timelines, file, record.timestamp) : null;
          started.set(block.id, { tool: block.name, input: block.input, cwd, host,
            mode: mode || inherited || 'unknown', modeSource: mode ? 'recorded' : inherited ? 'inherited' : 'unknown' });
        } else if (block.type === 'tool_result') {
          const call = started.get(block.tool_use_id);
          if (!call) continue;
          started.delete(block.tool_use_id);
          const outcome = record.toolDenialKind ? String(record.toolDenialKind) : 'executed';
          const event = { hook_event_name: 'PermissionRequest', tool_name: call.tool, tool_input: call.input,
            cwd: call.cwd, permission_mode: call.mode };
          const loaded = rulesFor(call.cwd);
          const result = decide('claude', event, loaded);
          const h = hosts[call.host] || (hosts[call.host] = { calls: 0, shellCalls: 0, modes: {}, modeSources: {},
            outcomes: {}, verdictByOutcome: {}, reasonByOutcome: {}, structure: {},
            visibleDialogs: 0, visibleDialogsApproved: 0, askDialogsApproved: 0, declinedDialogs: 0,
            declinedWithAllowVerdict: 0, declinedWithAllowVerdictGates: {},
            likelyDialogsPromptingModes: 0, likelyDialogsHookWouldApprove: 0,
            wouldApprove: 0, wouldApproveByOutcome: {}, wouldApproveInDefault: 0 });
          h.calls += 1;
          if (COMMAND_TOOLS.has(call.tool)) h.shellCalls += 1;
          bump(h.modes, call.mode);
          bump(h.modeSources, call.modeSource);
          bump(h.outcomes, outcome);
          bump(nested(h.verdictByOutcome, outcome), result.verdict);
          bump(nested(h.reasonByOutcome, outcome), result.reason);
          for (const code of result.structure || []) bump(h.structure, code);
          // VISIBLE dialogs: an exact ask rule matched (ask prompts in every
          // mode, auto included), or the person declined one.
          const ask = exactAsk(call.tool, call.input, loaded);
          const declined = DIALOG_DENIALS.has(outcome);
          if (ask || declined) {
            h.visibleDialogs += 1;
            if (result.decision === 'allow') h.visibleDialogsApproved += 1;
          }
          if (ask && outcome === 'executed') h.askDialogsApproved += 1;
          if (declined) {
            h.declinedDialogs += 1;
            // The class a rules-only hook exists for: the product asked even
            // though an allow rule matches. Here, the person said no.
            if (result.verdict === 'allow') {
              h.declinedWithAllowVerdict += 1;
              bump(h.declinedWithAllowVerdictGates, result.reason);
            }
          }
          // LIKELY dialogs, the invisible approved ones: a shell call that ran,
          // in a mode that prompts on a rule miss, with no allow rule. An upper
          // estimate (built-in read-only commands and acceptEdits' filesystem
          // set run unprompted too). The hook abstains on every one of them by
          // construction, which is the point of counting them.
          if (outcome === 'executed' && COMMAND_TOOLS.has(call.tool) && PROMPTING_MODES.has(call.mode)
              && result.verdict === 'none') {
            h.likelyDialogsPromptingModes += 1;
            if (result.decision === 'allow') h.likelyDialogsHookWouldApprove += 1;
          }
          if (result.decision === 'allow') {
            h.wouldApprove += 1;
            bump(h.wouldApproveByOutcome, outcome);
          }
          // The same call as if the session had been in default mode, so the
          // permission-mode gate is visible separately from the rules.
          if (result.reason === 'permission-mode') {
            const again = decide('claude', { ...event, permission_mode: 'default' }, loaded);
            if (again.decision === 'allow') h.wouldApproveInDefault += 1;
          } else if (result.decision === 'allow') h.wouldApproveInDefault += 1;
        }
      }
    }
  }
  const unreadable = [...ruleCache.values()].filter((loaded) => loaded.unreadable.length).length;
  return { files, ruleSets: ruleCache.size, ruleSetsUnreadable: unreadable, hosts };
}

// ── Codex ─────────────────────────────────────────────────────────────────────

const ESCALATION = /require_escalated|with_escalated_permissions\s*:\s*true|request_permissions/;
const REJECTED = /\bcommand rejected by user\b|\buser rejected\b/i;

function measureCodex(home) {
  const root = path.join(home, '.codex', 'sessions');
  const loaded = loadCodexRules({ home, codexHome: path.join(home, '.codex') });
  const hosts = {};
  let files = 0;
  for (const file of jsonlFiles(root, /^rollout-.*\.jsonl$/)) {
    files += 1;
    let host = 'unknown';
    let policy = 'unknown';
    const flagged = new Map();
    for (const record of records(file)) {
      const payload = record.payload || {};
      if (record.type === 'session_meta' && typeof payload.originator === 'string') host = payload.originator;
      if (record.type === 'turn_context' && typeof payload.approval_policy === 'string') policy = payload.approval_policy;
      const h = hosts[host] || (hosts[host] = { rollouts: new Set(), execCalls: 0, nestedCommands: 0,
        approvalPolicies: {}, escalationCalls: 0, escalationCommands: 0, verdicts: {}, reasons: {},
        wouldApprove: 0, rejected: 0 });
      h.rollouts.add(file);
      if (record.type === 'turn_context') bump(h.approvalPolicies, policy);
      if (record.type === 'response_item' && payload.type === 'custom_tool_call' && payload.name === 'exec') {
        const input = String(payload.input || '');
        const commands = extractNestedShellCommands(input);
        h.execCalls += 1;
        h.nestedCommands += commands.length;
        if (!ESCALATION.test(input)) continue;
        h.escalationCalls += 1;
        flagged.set(payload.call_id, true);
        for (const command of commands) {
          h.escalationCommands += 1;
          const result = decide('codex', { hook_event_name: 'PermissionRequest', tool_name: 'Bash',
            tool_input: { command: typeof command === 'string' ? command : command.command }, permission_mode: 'default' }, loaded);
          bump(h.verdicts, result.verdict);
          bump(h.reasons, result.reason);
          if (result.decision === 'allow') h.wouldApprove += 1;
        }
      }
      if (record.type === 'response_item' && payload.type === 'custom_tool_call_output' && flagged.has(payload.call_id)) {
        const text = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output || '');
        if (REJECTED.test(text)) h.rejected += 1;
        flagged.delete(payload.call_id);
      }
    }
  }
  for (const h of Object.values(hosts)) h.rollouts = h.rollouts.size;
  return { files, rules: loaded.rules.length, unreadable: loaded.unreadable, hosts };
}

function main() {
  const home = path.resolve(option('--home', os.homedir()));
  const report = { measuredAt: new Date().toISOString(), claude: measureClaude(home), codex: measureCodex(home) };
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const out = [];
  const list = (object) => Object.entries(object || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || '-';
  out.push(`Claude: ${report.claude.files} transcripts, ${report.claude.ruleSets} rule sets (${report.claude.ruleSetsUnreadable} unreadable)`);
  for (const [host, h] of Object.entries(report.claude.hosts).sort((a, b) => b[1].calls - a[1].calls)) {
    out.push('', `  ${host}: ${h.calls} calls (${h.shellCalls} Bash/PowerShell)`, `    modes: ${list(h.modes)} [${list(h.modeSources)}]`,
      `    outcomes: ${list(h.outcomes)}`,
      `    VISIBLE dialogs (exact ask rule matched, or declined): ${h.visibleDialogs}; hook approves ${h.visibleDialogsApproved}`,
      `      ask-rule dialogs the person approved: ${h.askDialogsApproved}; dialogs declined: ${h.declinedDialogs}`,
      `      declined although an allow rule matches: ${h.declinedWithAllowVerdict} (gates: ${list(h.declinedWithAllowVerdictGates)})`,
      `    LIKELY approved dialogs (shell, ran, prompting mode, no allow rule): ${h.likelyDialogsPromptingModes}; hook approves ${h.likelyDialogsHookWouldApprove}`,
      `    calls the hook would approve IF a dialog had appeared, as recorded: ${h.wouldApprove} (${list(h.wouldApproveByOutcome)})`,
      `      the same if every session were default mode: ${h.wouldApproveInDefault}`);
    for (const [outcome, verdicts] of Object.entries(h.verdictByOutcome)) out.push(`    verdicts | ${outcome}: ${list(verdicts)}`);
    for (const [outcome, reasons] of Object.entries(h.reasonByOutcome)) out.push(`    reasons  | ${outcome}: ${list(reasons)}`);
    out.push(`    structure codes on allow verdicts: ${list(h.structure)}`);
  }
  out.push('', `Codex: ${report.codex.files} rollouts, ${report.codex.rules} local rules${report.codex.unreadable.length ? `, UNREADABLE: ${report.codex.unreadable.join(', ')}` : ''}`);
  for (const [host, h] of Object.entries(report.codex.hosts)) {
    out.push('', `  ${host}: ${h.rollouts} rollouts, ${h.execCalls} exec calls, ${h.nestedCommands} nested shell commands`,
      `    approval policies per turn: ${list(h.approvalPolicies)}`,
      `    calls requesting escalation or permissions: ${h.escalationCalls} (${h.escalationCommands} commands), declined by the person: ${h.rejected}`,
      `    verdicts on those commands: ${list(h.verdicts)}`, `    reasons: ${list(h.reasons)}`,
      `    hook would approve: ${h.wouldApprove}`);
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

if (require.main === module) main();

module.exports = { measureClaude, measureCodex };
