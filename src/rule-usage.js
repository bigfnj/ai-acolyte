'use strict';

// RULE USAGE: how often each allow rule in ~/.claude/settings.json covered a call, counted over
// the Claude history this machine still holds. The Saved permissions card shows the totals and
// offers the rules with no use found for review. Built 2026-10-16, after AgentFlow's "approved
// without asking" audit (desktop-ai-companion, modules/AgentFlow/BlockedDetector.cs), whose rule
// matcher and command splitter are ports of this repository's own.
//
// A FULL PASS OVER ALL HISTORY, AGAINST THE CURRENT RULES, NOT A COUNTER IN THE SCAN. Auto Learn's
// state is partitioned by the open workspace and filters observations to its folder
// (autoLearnConfig, workspaceRoot), while the allow list is global. A counter kept there would
// see one project's calls, and a rule used every day in another project would read as unused:
// the one wrong answer this feature must not give, because its answer is "consider deleting
// this". A pass also judges the rules as they are NOW, so a rule the wildcarding pass folded
// yesterday is credited with the calls it would have covered, and needs no first-seen date.
// MEASURED 2026-10-16 on the development box: 893 transcripts, 1,880,002,028 bytes, 82,257 calls
// back to 2026-08-07, read in 7.8 s. Naive matching of 239,100 command segments against ~254
// rules each took 29.9 s, hence the index below.
//
// WHAT COUNTS. A finished Claude call (a result arrived, success or failure). It credits every
// allow rule that covers one of its probes, at most once per call. A probe that a deny or ask rule
// covers, the user's own or the managed policy's, credits nothing, because the prompt or refusal
// decided that call and not the allow rule (Claude evaluates deny, then ask, then allow). A
// compound command's segments are judged one at a time, and a rule that covers ANY segment is
// credited, even when another segment prompted: "used" means the rule matched something, which
// is the conservative direction for a list whose zeroes are offered for deletion.
//
// WHAT IS NOT SEEN, said on the card. Sessions that keep no transcript (`claude -p
// --no-session-persistence`, an ephemeral SDK run) and history Claude has already cleaned up.
// Codex calls are not counted at all: Codex obeys its own rules files, not this list.
//
// NOTHING BUT COUNTS IS STORED. Results are keyed by a hash of the normalized rule, so the cache
// file holds no rule text, command or path, and a rule is matched back to its count by hashing
// the live list.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { coversPermission, readPolicy } = require('./managed-policy');
const { normalizeRule, claudeAllowCandidates } = require('./permission-match');
const { splitCommandSegments } = require('./auto-learn');

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// The file tools AI Acolyte observes (src/tool-learn.js FILE_TOOLS). Their observations carry no
// path by design (no path ever leaves the parser), so only a bare tool rule (`Edit`) can be
// credited; a rule with a path specifier is NOT TRACKED, never "unused".
const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Read']);
const RULE_SHAPE = /^([A-Za-z_][\w-]*)\(([\s\S]*)\)$/;
const MCP_TOOL = /^mcp__[A-Za-z0-9_.-]+/;

function ruleKey(rule) {
  const digest = crypto.createHash('sha256').update(normalizeRule(String(rule)), 'utf8').digest('hex');
  return `rule-sha256:${digest.slice(0, 24)}`;
}

// The allow list's identity, so the card can tell a count of this list from a count of an older
// one. Order-free: a reordered list is the same list.
function allowFingerprint(allow) {
  const keys = [...new Set((Array.isArray(allow) ? allow : []).map(ruleKey))].sort();
  return crypto.createHash('sha256').update(keys.join('\n'), 'utf8').digest('hex').slice(0, 24);
}

function ruleTool(rule) {
  const text = String(rule).trim();
  if (text.startsWith('mcp__')) return 'mcp';
  const shaped = RULE_SHAPE.exec(text);
  if (shaped) return shaped[1];
  return /^[A-Za-z_][\w-]*$/.test(text) ? text : null;
}

// Can a call ever credit this rule? Only for tools AI Acolyte observes, and only in a shape the
// observation can be matched against. Everything else is NOT TRACKED, and the card never calls
// an untracked rule unused.
function trackedRule(rule) {
  const tool = ruleTool(rule);
  if (!tool) return false;
  if (SHELL_TOOLS.has(tool) || tool === 'mcp' || tool === 'WebSearch') return true;
  if (tool === 'WebFetch') {
    const shaped = RULE_SHAPE.exec(String(rule).trim());
    return !shaped || /^domain:/.test(shaped[2]);
  }
  if (FILE_TOOLS.has(tool)) return !RULE_SHAPE.test(String(rule).trim());
  return false;
}

function hostOf(origin) {
  try { return new URL(String(origin)).hostname.toLowerCase() || null; } catch { return null; }
}

// The permission strings Claude Code would test one call against, or [] when the call cannot be
// judged. Shell commands are split the way this repository splits them everywhere
// (splitCommandSegments, which AgentFlow diff-tests against its port).
function probesFor(observation) {
  const tool = String(observation?.tool || '');
  const command = typeof observation?.command === 'string' ? observation.command : '';
  if (SHELL_TOOLS.has(tool)) {
    if (!command.trim()) return [];
    return splitCommandSegments(command, tool === 'Bash' ? 'bash' : 'powershell')
      .map((segment) => String(segment).trim()).filter(Boolean)
      .map((segment) => `${tool}(${segment})`);
  }
  if (MCP_TOOL.test(tool)) return [tool];
  if (tool === 'WebSearch') return ['WebSearch'];
  if (tool === 'WebFetch') {
    const host = hostOf(command);
    return host ? [`WebFetch(domain:${host})`] : [];
  }
  if (FILE_TOOLS.has(tool)) return [tool];
  return [];
}

// The first word of a shell rule's or probe's argument, lowercased: the bucket key. Lowercasing
// only ever widens a bucket, and coversPermission decides every answer, so the index can add work
// but never change one.
function firstWord(argument) {
  return (/^\s*(\S+)/.exec(String(argument)) || [, ''])[1].toLowerCase();
}

// Rules grouped so a probe is tested against the few that could match it, never all of them.
//
// A MISSED MATCH IS THE ONE ERROR THAT MATTERS: it reads as "no use found" and offers a rule
// that is in use for deletion. So the index only ever narrows by facts that coversPermission also
// requires (the tool, and for a shell rule with a literal first word, that word), and a probe is
// looked up under the first word of EVERY text Claude Code tries a rule against: the probe
// itself, its stripped form (claudeAllowCandidates: safe variable assignments and wrappers such
// as `timeout 5` removed), and each of those after a leading `xargs`. A rule whose first word is
// a glob, empty, or that is a bare tool name, goes in the per-tool fallback and is tested every
// time. test/rule-usage.test.js holds the index to a full scan on every probe of its corpus.
function createRuleIndex(rules) {
  const shell = new Map();
  const fallback = new Map();
  const mcp = [];
  const byTool = new Map();
  const push = (map, key, rule) => { if (map.has(key)) map.get(key).push(rule); else map.set(key, [rule]); };
  for (const rule of rules) {
    const tool = ruleTool(rule);
    if (!tool) continue;
    if (tool === 'mcp') { mcp.push(rule); continue; }
    if (SHELL_TOOLS.has(tool)) {
      const shaped = RULE_SHAPE.exec(normalizeRule(String(rule).trim()));
      const word = shaped ? firstWord(shaped[2]) : '';
      if (!shaped || !word || /[*?]/.test(word)) push(fallback, tool, rule);
      else push(shell, `${tool}\u0000${word}`, rule);
      continue;
    }
    push(byTool, tool, rule);
  }
  const lookupWords = (probe) => {
    const words = new Set();
    for (const candidate of claudeAllowCandidates(probe)) {
      const shaped = RULE_SHAPE.exec(candidate);
      if (!shaped) continue;
      words.add(firstWord(shaped[2]));
      const xargs = /^\s*xargs\s+([\s\S]*)$/.exec(shaped[2]);
      if (xargs) words.add(firstWord(xargs[1]));
    }
    return words;
  };
  function candidates(probe) {
    const tool = ruleTool(probe);
    if (!tool) return [];
    if (tool === 'mcp') return mcp;
    if (SHELL_TOOLS.has(tool)) {
      const out = [...(fallback.get(tool) || [])];
      for (const word of lookupWords(probe)) out.push(...(shell.get(`${tool}\u0000${word}`) || []));
      return out;
    }
    return byTool.get(tool) || [];
  }
  return {
    // Every rule that covers the probe, each once.
    covering(probe) {
      const found = [];
      for (const rule of new Set(candidates(probe))) if (coversPermission(rule, probe)) found.push(rule);
      return found;
    },
    covers(probe) {
      for (const rule of candidates(probe)) if (coversPermission(rule, probe)) return true;
      return false;
    },
  };
}

// The allow rules one finished call credits. `blocking` is an index of every deny and ask rule
// in force (the user's and the managed policy's). A file-tool call carries no path to test them
// against, so for it the managed verdict the parser recorded (`managedRule`, set only when a
// managed deny or ask matched the path) is the block.
function creditsFor(observation, allowIndex, blockingIndex) {
  const credited = new Set();
  if (FILE_TOOLS.has(String(observation?.tool || '')) && observation.managedRule) return credited;
  for (const probe of probesFor(observation)) {
    if (blockingIndex.covers(probe)) continue;
    for (const rule of allowIndex.covering(probe)) credited.add(rule);
  }
  return credited;
}

function finished(observation) {
  return observation?.status === 'success' || observation?.status === 'failed';
}

// One full pass. `scanner` is scanHistoryFiles; `files` the transcripts to read. Each file is read
// on its own, with the scanner's ordinary per-scan ingest cap, and read again from the returned
// cursor until it is consumed, so a huge transcript costs a bounded buffer at a time and is still
// read to its end (the managed-hits rebuild reads one capped pass and stops). A call can come
// back in more than one slice (an append re-reads an overlap), so calls are deduped per file by
// observation id, and a call is counted once it has finished.
function analyzeRuleUsage(options) {
  const allow = (Array.isArray(options.allow) ? options.allow : []).filter((rule) => typeof rule === 'string');
  const tracked = [...new Set(allow.filter(trackedRule))];
  const allowIndex = createRuleIndex(tracked);
  const blockingIndex = createRuleIndex([
    ...(options.deny || []), ...(options.ask || []),
    ...(options.managedDeny || []), ...(options.managedAsk || []),
  ].filter((rule) => typeof rule === 'string'));
  const scanner = options.scanner;
  const counts = new Map(tracked.map((rule) => [rule, { uses: 0, lastUsedAt: null }]));
  let since = null;
  let calls = 0;
  let errors = 0;
  let unreadable = 0;
  const maxPasses = Number.isFinite(options.maxPasses) ? options.maxPasses : 10000;
  for (const file of options.files || []) {
    const seen = new Set();
    let cursors = {};
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const result = scanner({
        roots: [{ path: file, source: 'claude' }], cursors,
        ...(Number.isFinite(options.ingestBytes) ? { ingestBytes: options.ingestBytes } : {}),
      });
      cursors = result.cursors || {};
      for (const observation of result.observations || []) {
        if (observation.source !== 'claude' || !finished(observation) || seen.has(observation.id)) continue;
        seen.add(observation.id);
        calls += 1;
        const at = typeof observation.timestamp === 'string' ? observation.timestamp : null;
        if (at && (!since || at < since)) since = at;
        for (const rule of creditsFor(observation, allowIndex, blockingIndex)) {
          const record = counts.get(rule);
          record.uses += 1;
          if (at && (!record.lastUsedAt || at > record.lastUsedAt)) record.lastUsedAt = at;
        }
      }
      const entry = (result.files || []).find((item) => item.scope !== 'root') || {};
      if (entry.mode === 'error') { errors += 1; break; }
      if (entry.mode === 'unreadable') unreadable += 1;
      if (entry.mode !== 'partial') break;
    }
  }
  const rules = {};
  for (const [rule, record] of counts) rules[ruleKey(rule)] = record;
  return {
    version: 1,
    computedAt: options.now || new Date().toISOString(),
    since, files: (options.files || []).length, calls, errors, unreadable,
    allowFingerprint: allowFingerprint(allow),
    rules,
  };
}

// The pass the worker runs (src/auto-learn-worker.js, operation `ruleUsage`): the live settings
// and managed policy, every Claude transcript, one result. A settings.json that cannot be read
// throws, because counting against no rules would report every rule as uncounted. An unreadable
// managed policy does not: its deny and ask rules are left out, which can only credit MORE calls
// (never offer a used rule for deletion), and the result says it ran without them.
function countRuleUsage(options = {}) {
  const home = options.home || os.homedir();
  const settingsPath = options.settingsPath || path.join(home, '.claude', 'settings.json');
  const projectsDir = options.projectsDir || path.join(home, '.claude', 'projects');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));
  const permissions = settings && typeof settings.permissions === 'object' && settings.permissions ? settings.permissions : {};
  const strings = (list) => (Array.isArray(list) ? list.filter((rule) => typeof rule === 'string') : []);
  const policy = readPolicy({ home, policyPath: options.policyPath });
  const { scanHistoryFiles, listTranscriptFiles } = require('./history-adapters');
  const files = listTranscriptFiles({ claudeRoots: [projectsDir] }).map((entry) => entry.path);
  return {
    ...analyzeRuleUsage({
      allow: strings(permissions.allow), deny: strings(permissions.deny), ask: strings(permissions.ask),
      managedDeny: policy.raw.deny, managedAsk: policy.raw.ask,
      files, scanner: options.scanner || scanHistoryFiles, now: options.now,
      ...(Number.isFinite(options.ingestBytes) ? { ingestBytes: options.ingestBytes } : {}),
    }),
    managedPolicy: policy.unreadable ? 'unreadable' : policy.present ? 'present' : 'absent',
  };
}

// Days with no use before the card calls it out. A rule with no use found at all is listed
// whatever its age; this is the threshold for "not used lately", shown in the hover only.
const STALE_DAYS = 30;

// What the card says, from a saved result and the live allow list. Pure, so the push can call it.
//   used       tracked rules with at least one use
//   noUse      tracked rules the result counted and found no use for
//   untracked  rules no call can credit (src above: trackedRule)
//   notCounted tracked rules added since the result was computed
function summarizeRuleUsage(allow, saved, { now = Date.now() } = {}) {
  const list = [...new Set((Array.isArray(allow) ? allow : []).filter((rule) => typeof rule === 'string'))];
  const empty = { counted: false, used: 0, noUse: 0, untracked: 0, notCounted: 0, total: list.length };
  if (!saved || typeof saved !== 'object' || !saved.rules || typeof saved.rules !== 'object') return empty;
  let used = 0; let noUse = 0; let untracked = 0; let notCounted = 0; let notLately = 0;
  const top = [];
  const noUseRules = [];
  const cutoff = now - STALE_DAYS * 86400000;
  for (const rule of list) {
    if (!trackedRule(rule)) { untracked += 1; continue; }
    const record = saved.rules[ruleKey(rule)];
    if (!record || !Number.isFinite(record.uses)) { notCounted += 1; continue; }
    if (record.uses > 0) {
      used += 1;
      top.push({ rule, uses: record.uses });
      const last = Date.parse(record.lastUsedAt);
      if (Number.isFinite(last) && last < cutoff) notLately += 1;
    } else {
      noUse += 1;
      noUseRules.push(rule);
    }
  }
  top.sort((a, b) => b.uses - a.uses || a.rule.localeCompare(b.rule));
  return {
    counted: true, used, noUse, untracked, notCounted, notLately, total: list.length,
    computedAt: typeof saved.computedAt === 'string' ? saved.computedAt : null,
    since: typeof saved.since === 'string' ? saved.since : null,
    calls: Number.isFinite(saved.calls) ? saved.calls : 0,
    errors: Number.isFinite(saved.errors) ? saved.errors : 0,
    current: saved.allowFingerprint === allowFingerprint(list),
    top: top.slice(0, 5),
    noUseRules: noUseRules.sort(),
  };
}

// The usage count of each rule in `allow`, for the picker's descriptions, or null for a rule the
// saved result does not cover.
function usesOf(rule, saved) {
  const record = saved?.rules?.[ruleKey(rule)];
  return record && Number.isFinite(record.uses) ? record.uses : null;
}

// The cache file, beside Auto Learn's state files (~/.claude/wildcarding/).
function ruleUsagePath(home) {
  return path.join(home, '.claude', 'wildcarding', 'rule-usage.json');
}

// The pass on its own thread, as `{ promise, terminate }`, the way src/claude-strip-model.js runs
// its check. NOT on Auto Learn's worker queue, for two measured reasons: the pass takes ~10 s and
// would hold every scan, apply and undo behind it, and that runner drains each job to its end at
// teardown because a manager job may be between two policy writes. This pass writes nothing (the
// extension stores the result), so a teardown can end it at once.
const TASK = 'aiAcolyteRuleUsage';
function countOffThread(options) {
  const { Worker } = require('node:worker_threads');
  let worker = null;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    worker = new Worker(__filename, { workerData: { [TASK]: options } });
    worker.once('message', (message) => (message && message.result
      ? settle(resolve, message.result) : settle(reject, new Error(String(message?.error || 'no answer')))));
    worker.once('error', (error) => settle(reject, error));
    worker.once('exit', (code) => settle(reject, new Error(`the rule-usage thread exited ${code} without an answer`)));
  });
  return { promise, terminate: () => { try { worker?.terminate(); } catch { /* already gone */ } } };
}

// The thread's half.
const { isMainThread, workerData } = require('node:worker_threads');
if (!isMainThread && workerData && workerData[TASK]) {
  const { parentPort } = require('node:worker_threads');
  let message;
  try { message = { result: countRuleUsage(workerData[TASK]) }; }
  catch (error) { message = { error: String((error && error.message) || error) }; }
  parentPort.postMessage(message);
}

module.exports = {
  ruleKey, allowFingerprint, trackedRule, probesFor, createRuleIndex, creditsFor,
  analyzeRuleUsage, countRuleUsage, countOffThread, summarizeRuleUsage, usesOf, ruleUsagePath,
};
