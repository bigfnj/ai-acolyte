'use strict';

// Codex 0.145 flushes the current shell result before Stop, but not before a
// synchronous PostToolUse callback. Read authoritative history at turn end;
// neither raw hook output nor the fact that a hook fired establishes success.
//
// WHAT CODEX DOES WITH THIS PROCESS'S EXIT, read from the 0.161.0 source
// (codex-rs/hooks/src/events/stop.rs, `parse_completed`, tag rust-v0.161.0) on
// 2026-10-13, which is the Codex installed on the development box:
//   exit 0, `{}` or nothing   Completed. Nothing is shown.
//   exit 0, `systemMessage`   Completed, and the text is surfaced as a WARNING
//                             entry on the hook run.
//   exit 2                    BLOCKED: stderr becomes a continuation prompt and
//                             the model runs ANOTHER turn. Never exit 2 here; a
//                             learner that cannot finish its scan must not make
//                             the agent keep working.
//   any other non-zero        Failed. The run carries one entry, "hook exited
//                             with code N". stderr is read ONLY for exit 2, so
//                             the reason written below reaches a person running
//                             this script by hand, not the Codex user.
// The stdout object is parsed with `deny_unknown_fields`: a key outside
// continue / stopReason / suppressOutput / systemMessage / decision / reason
// fails the run as "invalid stop hook JSON output". So `systemMessage` is the
// only channel for saying something without failing, and nothing else is
// ever added to the output.
//
// WHICH EXIT EACH OUTCOME GETS (2026-10-13). Until then a scan that lost
// evidence exited 1, and by the table above its reason went to stderr, which
// Codex never reads for exit 1: every such failure reached the Codex user as
// "hook exited with code 1" and nothing else. Now:
//   exit 0, `{}`              clean scan, or another file still catching up.
//   exit 0, systemMessage     this turn's own rollout was deferred; OR the scan
//                             could not read something (read errors, a stretch
//                             stepped over, nothing listable, the learning lock
//                             held by another scan). The warning says what, with
//                             no path in it, so the reason finally reaches the
//                             person it is about.
//   exit 1                    the hook itself is broken: input that is not a
//                             Codex Stop payload (malformed, over 1 MiB, wrong
//                             event, cwd not an existing absolute directory), or
//                             an exception nothing here anticipated. Kept
//                             non-zero on purpose. A visible "Failed" is the
//                             one signal that separates "the hook ran and found
//                             a problem in the history" from "the hook cannot
//                             run", and a person debugging the second case runs
//                             the script by hand and reads stderr.
//   exit 2                    never.
const fs = require('node:fs');
const path = require('node:path');
const { POLICY_LOCK_CODE } = require('./policy-lock');

// The payload's path and the walker's are two spellings until proven one. Codex
// writes both `\\?\C:\...` and plain forms of a rollout path into its own state
// rows on Windows (seen in one table 2026-10-13), and a temp or profile folder
// can be reached through an 8.3 short name. `realpathSync.native` folds all of
// it: measured 2026-10-13 on Node 24.19.0, Windows, the short-name spelling, an
// upper-cased copy and the `\\?\`-prefixed upper-cased copy of one file all
// resolved to the same long, correctly cased path. A file that will not resolve
// falls back to `path.resolve`, which can only cost a match, never invent one.
function fileKey(file) {
  let resolved;
  try { resolved = fs.realpathSync.native(String(file)); } catch { resolved = path.resolve(String(file)); }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// Whether THIS turn's rollout is one the ingest budget deferred. The payload
// names it (`transcript_path`, nullable in Codex's StopCommandInput), and the
// scanner's per-file list says which files stopped early, so the answer is a
// lookup rather than an inference. A path that matches nothing -- no
// transcript, an ephemeral session, a rollout outside the configured roots --
// is "not deferred", and the cost of being wrong that way is a message not
// shown, never a failure.
function currentTranscriptDeferral(transcriptPath, files) {
  if (typeof transcriptPath !== 'string' || !transcriptPath || !path.isAbsolute(transcriptPath)) return null;
  const wanted = fileKey(transcriptPath);
  const entry = files.find((item) => item && item.mode === 'partial' && typeof item.path === 'string'
    && fileKey(item.path) === wanted);
  if (!entry) return null;
  const left = Number(entry.size) - Number(entry.consumedEnd);
  return { remainingBytes: Number.isFinite(left) && left > 0 ? left : 0 };
}

// Same rounding as the extension's catch-up phrase (vscode-extension/extension.js
// `catchUp`), so the two surfaces never disagree about how much is left.
function megabytes(bytes) {
  const mb = bytes / 1048576;
  return mb < 0.1 ? '<0.1' : mb < 10 ? mb.toFixed(1) : String(Math.round(mb));
}

// The error code of a Node system error, read from the front of its message
// ("EACCES: permission denied, open 'C:\\...'"). The code is the useful part of
// the reason, and the rest of the message carries the full path, which must not
// reach the Codex UI. Anything without a code is just "error".
function errorCode(entry) {
  const match = /^([A-Z][A-Z0-9_]{2,}):/.exec(String(entry?.error || ''));
  return match ? match[1] : 'error';
}
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const codes = (entries) => [...new Set(entries.map(errorCode))].sort().join(', ');

// What a scan that lost evidence tells the Codex user. Built from the scanner's
// per-file list when the hook has it, and from the manager's counts when it
// does not (a manager supplied by a caller may never call the scanner). Folder
// names are basenames only (`sessions`, `archived_sessions`, a date folder):
// directory names at most, never a path, because a path carries the user name.
function lostEvidenceMessage(scan, files) {
  const fileErrors = files.filter((item) => item && item.mode === 'error' && item.scope !== 'root');
  const rootErrors = files.filter((item) => item && item.mode === 'error' && item.scope === 'root');
  const unreadable = Number(scan.unreadable) || 0;
  const parts = [];
  if (scan.blindScan === true) {
    parts.push('any Codex history: no transcript could be listed' +
      (rootErrors.length ? ` (${codes(rootErrors)})` : '') + ', so this scan learned nothing and kept its saved positions');
  } else {
    if (fileErrors.length) parts.push(`${plural(fileErrors.length, 'transcript', 'transcripts')} (${codes(fileErrors)}); ` +
      'the next scan retries them');
    if (rootErrors.length) {
      const names = [...new Set(rootErrors.map((item) => path.basename(String(item.path || '')) || 'history'))].sort();
      parts.push(`${plural(rootErrors.length, 'history folder', 'history folders')} (${names.join(', ')}: ${codes(rootErrors)})`);
    }
    if (!fileErrors.length && !rootErrors.length && Number(scan.errors) > 0) {
      parts.push(plural(Number(scan.errors), 'history file or folder', 'history files or folders'));
    }
  }
  if (unreadable > 0) {
    parts.push(`${plural(unreadable, 'stretch', 'stretches')} of transcript with no line break inside 256 MiB, ` +
      'skipped for good');
  }
  return `AI Acolyte: Codex learning could not read ${parts.join('; ')}.`;
}

function runCodexStopHook(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.hook_event_name !== 'Stop') {
    throw new Error('Expected a Codex Stop hook event');
  }
  if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) {
    throw new Error('Codex Stop hook cwd must be an absolute directory');
  }
  const workspaceRoot = path.resolve(input.cwd);
  if (!fs.statSync(workspaceRoot).isDirectory()) throw new Error('Codex Stop hook cwd must be an existing directory');
  const createManager = options.createManager || require('./auto-learn-manager').createAutoLearnManager;
  const settings = { workspaceRoot, claudeRoots: [], claudeSettingsPath: null,
    // The manager's legacy alias fallback treats a top-level null as absent.
    // Carry the explicit disabled value through both paths.
    paths: { claudeSettings: null } };
  for (const key of ['home', 'codexHome']) if (options[key] !== undefined) settings[key] = options[key];
  // The manager reduces the scanner's per-file list to counts. The deferral
  // check needs the list, so the scanner the manager would have used anyway is
  // wrapped -- same function, same request, result passed through untouched --
  // and the list is kept on the way past. `options.historyScanner` exists for
  // tests that need a small ingest budget without a 64 MiB fixture.
  const scanner = typeof options.historyScanner === 'function'
    ? options.historyScanner : require('./history-adapters').scanHistoryFiles;
  let files = [];
  settings.historyScanner = (request) => {
    const result = scanner(request);
    files = Array.isArray(result?.files) ? result.files : [];
    return result;
  };
  const manager = createManager(settings);
  let scan;
  try { scan = manager.scan(); } catch (error) {
    // The one exception that is an expected condition rather than a broken hook:
    // the shared Auto Learn lock is held, by the editor's own worker or by a
    // Stop in another Codex window finishing at the same moment. The lock is
    // taken before anything is read (policy-lock `locked`), so no cursor moved
    // and the next scan learns this turn. Exiting 1 for it would put a "Failed"
    // over a scan that lost nothing, the defect 0d266fd removed for deferrals.
    if (error?.code !== POLICY_LOCK_CODE) throw error;
    return { ok: false, error: 'Codex history scan skipped: the Auto Learn lock is held by another scan',
      scan: null, deferred: null, output: { systemMessage: 'AI Acolyte: Codex learning could not read history ' +
        'this turn: another AI Acolyte scan was running. Nothing was lost; the next scan learns this turn.' } };
  }
  // WHAT FAILS THE HOOK, AND WHAT DOES NOT.
  //
  // `partial` used to be here, and it is the one count that is not a failure.
  // It means exactly one thing (history-adapters sets it in one place): the
  // per-file per-scan ingest budget stopped the read at a record boundary, the
  // cursor was saved there, and the next scan continues. That is progress.
  // Failing on it made every Stop fail while any transcript over 64 MiB was
  // still catching up -- three Stops for the 170 MB archived rollout on the
  // development box once `archived_sessions/` became a default root
  // (2026-10-13) -- and each one showed the Codex user an unexplained "hook
  // exited with code 1" over a scan that lost nothing.
  //
  // What still fails, because each one is evidence LOST rather than deferred:
  //   errors       a file or a root could not be read this scan.
  //   unreadable   a stretch with no record boundary in the 256 MiB hard
  //                maximum was stepped over. The cursor moved past it, so no
  //                later scan will ever read those bytes; this scan is the
  //                only one that can say so, and it fails once per stretch,
  //                not on every Stop.
  //   blindScan    nothing at all could be enumerated, so the cursor map was
  //                kept rather than trusted.
  // "Fails" means `ok: false` and a warning, not a non-zero exit: see WHICH
  // EXIT EACH OUTCOME GETS at the top of this file. `ok` describes the scan;
  // the exit code describes whether the hook could run at all.
  //
  // A deferral of the CURRENT turn's own rollout is the one worth telling the
  // user about: the commands this turn just ran are in the unread tail, so they
  // are not learned yet. Said as a warning on a completed run, never a failure.
  // Any other file's deferral is silent catch-up, as it is in the extension.
  const deferred = currentTranscriptDeferral(input.transcript_path, files);
  const deferral = deferred
    ? 'session\'s transcript is larger than one scan reads, so the commands ' +
      `from this turn are not learned yet (${megabytes(deferred.remainingBytes)} MB left). ` +
      'The next scan continues where this one stopped'
    : null;
  const unreadable = Number(scan.unreadable) || 0;
  if (scan.errors > 0 || unreadable > 0 || scan.blindScan === true) {
    // One systemMessage only, so a turn that lost evidence AND had its own
    // rollout deferred says both, loss first. "nothing failed" would then be
    // false, so the deferral half ends without it.
    return { ok: false, error: `Codex history scan incomplete (${scan.errors || 0} errors, ` +
      `${unreadable} unreadable stretches${scan.blindScan === true ? ', nothing could be listed' : ''})`, scan, deferred,
    output: { systemMessage: lostEvidenceMessage(scan, files) + (deferral ? ` This ${deferral}.` : '') } };
  }
  return { ok: true, scan, deferred, output: deferral ? { systemMessage: `AI Acolyte: this ${deferral}; nothing failed.` } : {} };
}

// Importing this module never reads stdin, scans history or writes policy.
if (require.main === module) {
  const chunks = [];
  let bytes = 0;
  let rejected = false;
  const fail = (error) => {
    if (rejected) return;
    rejected = true;
    process.stderr.write(`AI Acolyte Codex Stop hook: ${error.message || error}\n`);
    // 1, never 2: see the exit table at the top of this file.
    process.exitCode = 1;
  };
  process.stdin.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) { fail(new Error('hook input exceeds 1 MiB')); return; }
    if (!rejected) chunks.push(chunk);
  });
  process.stdin.on('error', fail);
  process.stdin.on('end', () => {
    if (rejected) return;
    try {
      const result = runCodexStopHook(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      // `ok: false` is NOT rethrown. It used to be, which turned every scan
      // that lost evidence into exit 1 and so into a reason Codex never shows;
      // the run's own warning is printed instead and the hook exits 0. A result
      // with no output object is the one thing that cannot happen, and it is
      // treated as the broken hook it would be.
      if (!result || typeof result.output !== 'object' || result.output === null) throw new Error(result?.error || 'no hook output');
      // No blocking, continuation request or model context: `{}`, or one
      // `systemMessage` warning (deferral of this turn, or what could not be read).
      process.stdout.write(JSON.stringify(result.output) + '\n');
    } catch (error) { fail(error); }
  });
}

module.exports = { runCodexStopHook };
