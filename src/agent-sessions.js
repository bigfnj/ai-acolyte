'use strict';

// AGENT SESSIONS: the Claude and Codex sessions that wrote a transcript in the last fifteen
// minutes, for the dashboard's Agent sessions card (2026-10-16, after AgentFlow's status card in
// desktop-ai-companion). Read from the transcript files alone, so it sees a session wherever it
// runs (the VS Code panel, the CLI, the desktop apps) and needs nothing switched on.
//
// WHAT A TRANSCRIPT CAN SAY, AND WHAT IT CANNOT. It names the agent, the app (Claude's
// `entrypoint`, Codex's `session_meta.originator`), the folder the session works in, the
// permission mode (Claude's `permissionMode`, Codex's `turn_context.approval_policy`) and when
// the session last did something: a Claude transcript's modification time, a Codex rollout's last
// record time (codexCandidates says why). It cannot say whether a panel is
// working at this moment or is waiting on a permission prompt: that is the panel's own state,
// which an extension cannot read (Claude Code publishes no command for it, measured on 2.1.301),
// and inferring "waiting" from a stalled call is right about 0.4% of the time outside Claude's
// default mode (AgentFlow's measurement, BlockedDetector.cs). So the card says when, never why.
//
// FOLDER NAMES ONLY. No path, command or prompt leaves this module: `project` is the last segment
// of the session's working folder. Nothing here is persisted.

const fs = require('fs');
const path = require('path');

const WINDOW_MS = 15 * 60 * 1000;
// A subagent is counted as active when its own transcript was written this recently.
const SUBAGENT_ACTIVE_MS = 2 * 60 * 1000;
const TAIL_BYTES = 256 * 1024;
// Codex's head record carries the whole system prompt: 22,095 bytes on 0.153.4 (codexHeadSeed
// in history-adapters.js), so the head read goes forward to the first newline, capped.
const HEAD_MAX_BYTES = 1024 * 1024;
const LIMIT = 20;

// The app a transcript names, from an allowlist: an unlisted value names nothing, rather than
// letting a new build's spelling reach the card unreviewed. Measured values: Claude
// `claude-vscode`, `cli`, `claude-desktop`; Codex `codex_vscode`, `Codex Desktop`, `codex_exec`
// (AgentFlow's AgentHosts table, and this box on 2026-10-16). Codex's `source` is not used: the
// desktop app writes `source: "vscode"`.
const CLAUDE_APPS = new Map([
  ['claude-vscode', 'VS Code'], ['cli', 'CLI'], ['claude-desktop', 'Claude desktop'],
  ['sdk-cli', 'SDK'], ['sdk-ts', 'SDK'], ['sdk-py', 'SDK'],
]);
const CODEX_APPS = new Map([
  ['codex_vscode', 'VS Code'], ['Codex Desktop', 'Codex desktop'], ['codex_exec', 'exec'],
  ['codex_cli_rs', 'CLI'],
]);
const CLAUDE_MODES = new Map([
  ['default', 'default'], ['acceptEdits', 'accept edits'], ['plan', 'plan'], ['auto', 'auto'],
  ['bypassPermissions', 'bypass'], ['dontAsk', "don't ask"],
]);
const CODEX_POLICY = /^[a-z][a-z-]{0,23}$/;

function readRange(file, start, length) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(Math.max(0, length));
    const count = length > 0 ? fs.readSync(descriptor, buffer, 0, length, start) : 0;
    return buffer.subarray(0, count);
  } finally {
    try { fs.closeSync(descriptor); } catch { /* the read already happened or failed */ }
  }
}

// How far back a reader may go for a field the end of the file does not carry. Claude writes
// `permissionMode` on the user's prompt records, and a session working through long tool output
// can go well past one TAIL_BYTES window without one (measured on this session, 2026-10-16).
const BACK_MAX_BYTES = 4 * 1024 * 1024;

// Every complete record from the end of the file backwards, newest first, in TAIL_BYTES chunks,
// at most `maxBytes` back. Split on the newline BYTE and decoded a line at a time, so a chunk
// boundary inside a multi-byte character cannot corrupt a record. A line cut by the floor is
// dropped, and one still being written at the end fails to parse and is skipped.
function* recordsFromEnd(file, size, maxBytes = TAIL_BYTES) {
  const floor = Math.max(0, size - maxBytes);
  let end = size;
  let carry = Buffer.alloc(0);
  while (end > floor) {
    const start = Math.max(floor, end - TAIL_BYTES);
    const buffer = carry.length ? Buffer.concat([readRange(file, start, end - start), carry]) : readRange(file, start, end - start);
    end = start;
    let from = 0;
    if (start > 0) {
      const newline = buffer.indexOf(10);
      if (newline === -1) { carry = buffer; continue; }
      carry = buffer.subarray(0, newline);
      from = newline + 1;
    } else carry = Buffer.alloc(0);
    const lines = [];
    for (let at = from; at <= buffer.length;) {
      const next = buffer.indexOf(10, at);
      const stop = next === -1 ? buffer.length : next;
      if (stop > at) lines.push(buffer.subarray(at, stop));
      at = stop + 1;
    }
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try { yield JSON.parse(lines[index].toString('utf8')); } catch { /* a line still being written */ }
    }
  }
}

function headRecord(file, size) {
  let carry = Buffer.alloc(0);
  for (let at = 0; at < Math.min(size, HEAD_MAX_BYTES); at += 64 * 1024) {
    const chunk = readRange(file, at, Math.min(64 * 1024, size - at));
    if (!chunk.length) break;
    carry = Buffer.concat([carry, chunk]);
    const newline = carry.indexOf(10);
    if (newline !== -1) {
      try { return JSON.parse(carry.subarray(0, newline).toString('utf8')); } catch { return null; }
    }
  }
  return null;
}

function folderName(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return null;
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

function claudeMeta(file, size) {
  const meta = { app: null, project: null, mode: null };
  for (const record of recordsFromEnd(file, size, BACK_MAX_BYTES)) {
    if (meta.app === null && typeof record.entrypoint === 'string') meta.app = CLAUDE_APPS.get(record.entrypoint) || 'other';
    if (meta.project === null && typeof record.cwd === 'string') meta.project = folderName(record.cwd);
    if (meta.mode === null && typeof record.permissionMode === 'string') {
      meta.mode = CLAUDE_MODES.get(record.permissionMode) || 'other';
    }
    if (meta.app !== null && meta.project !== null && meta.mode !== null) break;
  }
  return meta;
}

// A Codex thread that is not a session of its own (measured 2026-10-20 on 0.162.0-alpha.17.2 and
// 0.163.0-alpha.10.2, this box): its head's `source` is `{subagent: ...}`. A multi-agent session's
// workers carry `{subagent: {thread_spawn: {parent_thread_id}}}` and count toward that session;
// the approval reviewer writes a short `{subagent: {other: "guardian"}}` thread per request (52 of
// one day's 65 rollouts), and the card listed those as the sessions while the real ones were missing.
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function codexMeta(file, size) {
  const meta = { app: null, project: null, mode: null, lastRecordMs: null, subagent: false, parent: null };
  const head = headRecord(file, size);
  if (head && head.type === 'session_meta' && head.payload && typeof head.payload === 'object') {
    if (typeof head.payload.originator === 'string') meta.app = CODEX_APPS.get(head.payload.originator) || 'other';
    meta.project = folderName(head.payload.cwd);
    const source = head.payload.source;
    if (source && typeof source === 'object' && source.subagent) {
      meta.subagent = true;
      const parent = source.subagent.thread_spawn?.parent_thread_id;
      if (typeof parent === 'string' && THREAD_ID.test(parent)) meta.parent = parent.toLowerCase();
    }
  }
  for (const record of recordsFromEnd(file, size, BACK_MAX_BYTES)) {
    if (meta.lastRecordMs === null && typeof record?.timestamp === 'string') {
      const at = Date.parse(record.timestamp);
      if (Number.isFinite(at)) meta.lastRecordMs = at;
    }
    const policy = record?.type === 'turn_context' ? record.payload?.approval_policy : undefined;
    if (meta.mode === null && typeof policy === 'string') meta.mode = CODEX_POLICY.test(policy) ? policy : 'other';
    if (meta.mode !== null && meta.lastRecordMs !== null) break;
  }
  return meta;
}

async function entries(dir) {
  try { return await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
}

async function mtime(file) {
  try {
    const stat = await fs.promises.stat(file);
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size } : null;
  } catch { return null; }
}

// Claude: `<projects>/<slug>/<session>.jsonl`, with its subagents at
// `<projects>/<slug>/<session>/subagents/*.jsonl`. A subagent's activity is its parent session's.
async function claudeCandidates(root, since, now) {
  const found = new Map();
  for (const slug of await entries(root)) {
    if (!slug.isDirectory()) continue;
    const dir = path.join(root, slug.name);
    for (const entry of await entries(dir)) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const stat = await mtime(path.join(dir, entry.name));
        if (!stat) continue;
        const id = entry.name.slice(0, -'.jsonl'.length);
        const record = found.get(id) || { id, file: null, size: 0, lastActiveMs: 0, subagents: 0 };
        record.file = path.join(dir, entry.name);
        record.size = stat.size;
        record.lastActiveMs = Math.max(record.lastActiveMs, stat.mtimeMs);
        found.set(id, record);
      } else if (entry.isDirectory()) {
        const subagents = path.join(dir, entry.name, 'subagents');
        for (const sub of await entries(subagents)) {
          if (!sub.isFile() || !sub.name.endsWith('.jsonl')) continue;
          const stat = await mtime(path.join(subagents, sub.name));
          if (!stat || stat.mtimeMs < since) continue;
          const record = found.get(entry.name) || { id: entry.name, file: null, size: 0, lastActiveMs: 0, subagents: 0 };
          record.lastActiveMs = Math.max(record.lastActiveMs, stat.mtimeMs);
          if (now - stat.mtimeMs <= SUBAGENT_ACTIVE_MS) record.subagents += 1;
          found.set(entry.name, record);
        }
      }
    }
  }
  return [...found.values()].filter((record) => record.lastActiveMs >= since);
}

// Codex: every plain rollout under `sessions/` (a session keeps writing into the date folder it
// started in, so a long one is not in today's). A compressed `.jsonl.zst` is idle by definition.
//
// NOT BY ITS MODIFICATION TIME ALONE (2026-10-20). On this box Codex 0.162/0.163 appends to a
// rollout without moving its mtime: four sessions writing that minute all read the minute they
// started, while their change time matched their last record to the second. So a file is a
// candidate when either time is in the window, and the caller takes its activity from the last
// record's own `timestamp` (codexMeta), falling back to the mtime only when no record carries one.
async function codexCandidates(root, since) {
  const out = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of await entries(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { pending.push(full); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const stat = await mtime(full);
      if (!stat || Math.max(stat.mtimeMs, stat.ctimeMs || 0) < since) continue;
      const id = (/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(entry.name) || [])[1] || entry.name;
      out.push({ id, file: full, size: stat.size, mtimeMs: stat.mtimeMs, lastActiveMs: stat.mtimeMs, subagents: 0 });
    }
  }
  return out;
}

// The sessions active in the window, newest first, at most LIMIT. `cache` (a Map the caller keeps)
// holds each file's metadata by path, re-read only when the file grew.
async function discoverSessions(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const since = now - (Number.isFinite(options.windowMs) ? options.windowMs : WINDOW_MS);
  const cache = options.cache instanceof Map ? options.cache : new Map();
  const sessions = [];
  const seen = new Set();
  const metaFor = (record, read) => {
    let meta = { app: null, project: null, mode: null };
    if (record.file) {
      seen.add(record.file);
      const hit = cache.get(record.file);
      if (hit && hit.size === record.size) meta = hit.meta;
      else {
        try { meta = read(record.file, record.size); } catch { /* unreadable now; the next look retries */ }
        // A field this read did not reach keeps the value an earlier read found: the mode does not
        // vanish because the last 4 MB happened to hold no prompt.
        if (hit) for (const key of ['app', 'project', 'mode', 'lastRecordMs']) {
          if (meta[key] === null && hit.meta[key] !== undefined) meta = { ...meta, [key]: hit.meta[key] };
        }
        cache.set(record.file, { size: record.size, meta });
      }
    }
    return meta;
  };
  const push = (agent, record, meta) => sessions.push({
    agent, id: String(record.id).slice(0, 8), app: meta.app, project: meta.project, mode: meta.mode,
    lastActiveAt: Math.round(record.lastActiveMs), subagents: record.subagents,
  });
  if (options.claudeRoot) {
    for (const record of await claudeCandidates(options.claudeRoot, since, now)) push('claude', record, metaFor(record, claudeMeta));
  }
  if (options.codexRoot) {
    const rows = [];
    for (const candidate of await codexCandidates(options.codexRoot, since)) {
      const meta = metaFor(candidate, codexMeta);
      const lastActiveMs = Number.isFinite(meta.lastRecordMs) ? Math.min(meta.lastRecordMs, now) : candidate.mtimeMs;
      if (lastActiveMs >= since) rows.push({ record: { ...candidate, lastActiveMs }, meta });
    }
    // A spawned worker counts toward the session that spawned it, as a Claude subagent does; one
    // whose session is not in the window is listed on its own, so active work is never hidden. A
    // guardian review is never a session.
    const sessionsById = new Map(rows.filter((row) => !row.meta.subagent).map((row) => [String(row.record.id).toLowerCase(), row]));
    const listed = [...sessionsById.values()];
    for (const row of rows) {
      if (!row.meta.subagent) continue;
      const parent = row.meta.parent ? sessionsById.get(row.meta.parent) : null;
      if (parent) {
        parent.record.lastActiveMs = Math.max(parent.record.lastActiveMs, row.record.lastActiveMs);
        if (now - row.record.lastActiveMs <= SUBAGENT_ACTIVE_MS) parent.record.subagents += 1;
      } else if (row.meta.parent) listed.push(row);
    }
    for (const row of listed) push('codex', row.record, row.meta);
  }
  // A session that left the window leaves the cache with it, so the cache never outgrows the
  // window's handful of files.
  for (const key of [...cache.keys()]) if (!seen.has(key)) cache.delete(key);
  sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.id.localeCompare(b.id));
  return sessions.slice(0, LIMIT);
}

// What the card shows as changed: the sessions, their state, and the minute each was last active,
// so a push follows a real change at most once a minute rather than on every transcript write.
function sessionsSignature(sessions) {
  return JSON.stringify((sessions || []).map((s) => [s.agent, s.id, s.app, s.project, s.mode, s.subagents,
    Math.floor(s.lastActiveAt / 60000)]));
}

module.exports = { discoverSessions, sessionsSignature, WINDOW_MS };
