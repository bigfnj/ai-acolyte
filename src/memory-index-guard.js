'use strict';

// The MEMORY.md index guard: a Claude Code PreToolUse hook that refuses an edit after which the
// always-loaded memory index ENDS past a budget AND is worse on that measure than before.
//
// Claude Code loads the first 200 lines (or 25 KB) of each project's
// `<config>/projects/<slug>/memory/MEMORY.md` into every session and strips its HTML
// comments. A real index grew to 157 lines one hook at a time, each addition reasonable on
// its own, and a header comment carrying a second `<!--` leaked its tail into every session.
// The lint (vscode-extension/memoryLint.js, memory/recall.py --lint) reports both after the
// fact; this stops the write that causes them.
//
// THE RULE. A write is blocked only when some measure ENDS over its budget AND is worse than
// it was before the write, judged per measure. That includes a first crossing (140 lines to
// 141). Deleting whole lines can only lower a line count, a byte count, the longest line and
// the entry count, so compaction by deletion gets through even from an index far past every
// budget, with one deliberate exception: a deletion that breaks an HTML comment (its `<!--`
// line or its `-->` line alone) or a code fence (an opener that kept a `<!--` from being a
// comment) creates a comment defect, and is refused because the comment's body would leak
// into context. An edit that is not a whole-line deletion can shrink the file and still be
// refused: joining two lines into one past 300 characters makes the longest line worse. The
// entry budget is what makes "one in, one out" a rule rather than advice.
//
// SELF-CONTAINED ON PURPOSE. The installer copies this file to
// `<home>/.claude/wildcarding/memory-index-guard.js` and the hook runs that copy, outside the
// repository and outside the versioned extension directory. It may therefore require Node
// built-ins only, and only `fs` and `path`: a sibling require would resolve in the repo and
// fail in the copy. test/memory-index-guard.test.js parses every require call in this file,
// comments included.
//
// BUMP GUARD_REVISION WITH EVERY CHANGE TO THIS FILE. The installer refreshes the copy only
// when the packaged revision is higher than the copy's (a byte comparison would flip-flop
// between a CRLF development tree and an LF build), and test/memory-index-guard.test.js pins
// the line-ending-normalised sha of this file to the revision, so an edit without a bump fails.
//
// FAIL OPEN. Any error, any payload it cannot read, any edit it cannot reproduce exactly:
// exit 0 and let the write through. Exit 2, which Claude Code turns into a refusal shown to
// the model, happens only for a confirmed violation.

const fs = require('fs');
const path = require('path');

const GUARD_REVISION = 4;

// Shared with the lint: memory/recall.py LINT_LINES_WARN, LINT_TOTAL_WARN, LINT_LINE_WARN and
// LINT_ENTRY_WARN, and the extension's memory.totalBudget / memory.lineBudget defaults. A test
// pins all three places together. The extension's window-scoped settings tune its editor gauge
// only; the hook always uses these.
const BUDGETS = Object.freeze({ lines: 140, bytes: 12000, lineChars: 300, entries: 16, commentDefects: 0 });
const STDIN_CAP = 8 * 1024 * 1024;
const INDEX_NAME = 'MEMORY.md';
const TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const ALLOW = Object.freeze({ code: 0, stderr: '' });

// ── measuring ────────────────────────────────────────────────────────────────

// Lines as memoryLint's fastLint counts them, which is how `wc -l` and the loader count them:
// split at LF or CRLF, and a trailing newline is not one more (empty) line.
function splitLines(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Code points, not UTF-16 units: an astral emoji is one character to a reader and to
// Python's len(), and two to String.prototype.length.
function codePoints(line) {
  let count = 0;
  for (const _ of line) count += 1;
  return count;
}

function measure(text) {
  const value = typeof text === 'string' ? text : '';
  const lines = splitLines(value);
  let lineChars = 0;
  let entries = 0;
  for (const line of lines) {
    const width = codePoints(line.replace(/\r/g, ''));
    if (width > lineChars) lineChars = width;
    if (line.startsWith('- ')) entries += 1;
  }
  return {
    lines: lines.length,
    bytes: Buffer.byteLength(value, 'utf8'),
    lineChars,
    entries,
    commentDefects: commentDefects(value),
  };
}

// HTML comment defects, the three ways a comment in the index goes wrong:
//
//   a `<!--` opened while a comment is already open   the first `-->` closes BOTH, so the
//                                                      text between it and the second `-->`
//                                                      leaks into every session (the defect
//                                                      that leaked a real index's header)
//   an orphan `-->`                                    shown as text
//   a `<!--` still open at the end of the file         hides everything after it
//
// Markers inside fenced code blocks and inline code spans are examples, not comments, so
// they are skipped. Inside an open comment nothing is code: a comment ends at the first
// `-->` whatever backticks surround it. Fences allow spaces and tabs before them, never `\s`,
// whose set differs between JavaScript and Python, so recall.py's port reads the same fences.
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

// Each defect as { line, column, kind }, zero-based, kind 'nested' | 'orphan' | 'unclosed'
// (an unclosed one is reported where its `<!--` opened). The editor lint squiggles these; the
// guard and recall.py --lint count them.
function commentDefectList(text) {
  const lines = String(typeof text === 'string' ? text : '').split(/\r?\n/);
  const defects = [];
  let open = null;
  let fence = null;
  lines.forEach((line, row) => {
    if (!open) {
      if (fence) {
        const close = FENCE_CLOSE.exec(line);
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
        return;
      }
      const opener = FENCE_OPEN.exec(line);
      if (opener) { fence = opener[1]; return; }
    }
    let i = 0;
    while (i < line.length) {
      if (open) {
        const close = line.indexOf('-->', i);
        const reopen = line.indexOf('<!--', i);
        if (reopen !== -1 && (close === -1 || reopen < close)) {
          defects.push({ line: row, column: reopen, kind: 'nested' });
          i = reopen + 4;
          continue;
        }
        if (close === -1) break;
        open = null;
        i = close + 3;
        continue;
      }
      if (line[i] === '`') {
        let run = 1;
        while (line[i + run] === '`') run += 1;
        const ticks = '`'.repeat(run);
        let end = line.indexOf(ticks, i + run);
        // A closing run must be exactly as long as the opening one.
        while (end !== -1 && line[end + run] === '`') {
          let skip = run;
          while (line[end + skip] === '`') skip += 1;
          end = line.indexOf(ticks, end + skip);
        }
        i = end === -1 ? i + run : end + run;
        continue;
      }
      if (line.startsWith('<!--', i)) { open = { line: row, column: i }; i += 4; continue; }
      if (line.startsWith('-->', i)) { defects.push({ line: row, column: i, kind: 'orphan' }); i += 3; continue; }
      i += 1;
    }
  });
  if (open) defects.push({ ...open, kind: 'unclosed' });
  return defects;
}

function commentDefects(text) {
  return commentDefectList(text).length;
}

// ── reproducing the edit ─────────────────────────────────────────────────────

// One Edit, as Claude Code applies it: the old string must occur, exactly once unless
// replace_all is set. Not found, or ambiguous, returns null, and null means FAIL OPEN: the
// guard cannot know what the file would become, and Claude Code will refuse the edit itself.
// A CRLF file edited with LF strings is retried with the strings converted, because the tool
// matches across that difference. Never String.prototype.replace, which reads `$&` and `$1`
// in the replacement as patterns.
function applyOne(text, edit) {
  if (!edit || typeof edit !== 'object') return null;
  const oldString = edit.old_string;
  const newString = edit.new_string;
  if (typeof oldString !== 'string' || typeof newString !== 'string') return null;
  if (oldString === '') return text === '' ? newString : null;
  let from = oldString;
  let to = newString;
  let count = text.split(from).length - 1;
  if (count === 0) {
    const crlf = oldString.replace(/\r?\n/g, '\r\n');
    if (crlf !== oldString) {
      from = crlf;
      to = newString.replace(/\r?\n/g, '\r\n');
      count = text.split(from).length - 1;
    }
  }
  if (count === 0) return null;
  if (edit.replace_all === true) return text.split(from).join(to);
  if (count > 1) return null;
  const at = text.indexOf(from);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

// The text the file would hold after the tool call, or null when that cannot be known.
// MultiEdit is the legacy tool: its edits apply in order, each to the previous one's result.
function applyEdit(current, toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const text = typeof current === 'string' ? current : '';
  if (toolName === 'Write') return typeof toolInput.content === 'string' ? toolInput.content : null;
  if (toolName === 'Edit') return applyOne(text, toolInput);
  if (toolName === 'MultiEdit') {
    if (!Array.isArray(toolInput.edits) || !toolInput.edits.length) return null;
    let next = text;
    for (const edit of toolInput.edits) {
      next = applyOne(next, edit);
      if (next === null) return null;
    }
    return next;
  }
  return null;
}

// ── the verdict ──────────────────────────────────────────────────────────────

// `before` and `after` are texts or measure() results. Per measure: blocked only when it ends
// over its budget AND is worse than it was.
function verdict(before, after) {
  const was = typeof before === 'string' ? measure(before) : before;
  const now = typeof after === 'string' ? measure(after) : after;
  const reasons = [];
  for (const metric of Object.keys(BUDGETS)) {
    const budget = BUDGETS[metric];
    if (now[metric] > budget && now[metric] > was[metric]) {
      reasons.push({ metric, before: was[metric], after: now[metric], budget });
    }
  }
  return { block: reasons.length > 0, reasons };
}

const LABELS = {
  lines: 'lines',
  bytes: 'bytes',
  lineChars: 'longest line',
  entries: '"- " entries',
  commentDefects: 'broken comments',
};
const DEFECT_KINDS = { nested: '<!-- inside a comment', orphan: 'orphan -->', unclosed: 'unclosed <!--' };

// Under 600 characters with all five measures failing and a comment located: Claude Code hands
// stderr to the model, and the fix has to survive being read in one pass. The advice follows
// the reasons: compaction for a size measure, the whole comment for a comment defect, whose
// first defect is located when the text the edit would leave is given.
function blockMessage(reasons, afterText) {
  const found = reasons.map((reason) => {
    let where = '';
    if (reason.metric === 'commentDefects' && typeof afterText === 'string') {
      const first = commentDefectList(afterText)[0];
      if (first) where = `; first: ${DEFECT_KINDS[first.kind]}, line ${first.line + 1}`;
    }
    return `${LABELS[reason.metric]} ${reason.after} (budget ${reason.budget}, was ${reason.before}${where})`;
  }).join('; ');
  const advice = [];
  if (reasons.some((reason) => reason.metric !== 'commentDefects')) advice.push('Move detail and status to the memory file.');
  if (reasons.some((reason) => reason.metric === 'commentDefects')) advice.push('Close or remove the whole comment.');
  return 'AI Acolyte MEMORY.md guard blocked this edit: the index would end past a budget and worse than '
    + `before: ${found}. ${advice.join(' ')} Deleting whole lines passes unless it breaks a comment or `
    + 'fence. The user can turn it off: `wildcard-perms --memory-guard off` or the AI Acolyte command '
    + '"Toggle MEMORY.md guard".\n';
}

// ── which file is the index ──────────────────────────────────────────────────

// os.homedir() without requiring os: USERPROFILE on Windows and HOME elsewhere, which is the
// order libuv's uv_os_homedir reads them in.
function homeDirectory(env, platform) {
  const value = platform === 'win32' ? (env.USERPROFILE || env.HOME) : env.HOME;
  return typeof value === 'string' && value && path.isAbsolute(value) ? value : null;
}

function configDirectory(env, platform) {
  if (typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR) return path.resolve(env.CLAUDE_CONFIG_DIR);
  const home = homeDirectory(env, platform);
  return home ? path.join(home, '.claude') : null;
}

function comparable(value, platform) {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return platform === 'win32' ? resolved.replace(/\//g, '\\').toLowerCase() : resolved;
}

// The `autoMemoryDirectory` value in <config>/settings.json, absolute or `~`-prefixed, or
// null. Read only once the basename has already matched, so an edit to any other file never
// costs this read.
function autoMemoryDirectory(config, env, platform, readFile) {
  if (!config) return null;
  let settings;
  try { settings = JSON.parse(String(readFile(path.join(config, 'settings.json'))).replace(/^\uFEFF/, '')); }
  catch { return null; }
  const value = settings && typeof settings === 'object' ? settings.autoMemoryDirectory : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  let target = value.trim();
  if (target === '~' || target.startsWith('~/') || target.startsWith('~\\')) {
    const home = homeDirectory(env, platform);
    if (!home) return null;
    target = path.join(home, target.slice(1));
  }
  return path.isAbsolute(target) ? target : null;
}

// A name as the file system reads it. On Windows a name is matched without case, so `memory.md`
// opens the index itself. Trailing dots and spaces are NOT folded (revision 4): Win32 drops them,
// but Node reads a Win32 path through its `\\?\` form, which keeps them, so `MEMORY.md.` would
// read as missing and be judged against an empty index. Claude Code itself asks a person before
// writing such a path. Like the other aliases (an 8.3 short name, a `::$DATA` stream, a `\\?\`
// or UNC spelling, a junction), they are not resolved here and fail open, as
// docs/engineering-record.md records.
function nameOf(name, platform) {
  return platform === 'win32' ? name.toLowerCase() : name;
}

// Basename first, `MEMORY.md` as the file system reads that name, so every other file in the
// session exits here with no read at all. Then the parent must be
// `<config>/projects/<slug>/memory`, or the configured autoMemoryDirectory.
function isIndexPath(filePath, { env = process.env, platform = process.platform, readFile } = {}) {
  if (typeof filePath !== 'string' || !filePath) return false;
  if (nameOf(path.basename(filePath), platform) !== nameOf(INDEX_NAME, platform)) return false;
  const parent = path.dirname(path.resolve(filePath));
  const config = configDirectory(env, platform);
  if (config) {
    const memoryName = nameOf(path.basename(parent), platform);
    const projects = path.dirname(path.dirname(parent));
    if (memoryName === 'memory' && comparable(projects, platform) === comparable(path.join(config, 'projects'), platform)) {
      return true;
    }
  }
  const custom = autoMemoryDirectory(config, env, platform, readFile || ((file) => fs.readFileSync(file, 'utf8')));
  return custom !== null && comparable(parent, platform) === comparable(custom, platform);
}

// ── the hook ─────────────────────────────────────────────────────────────────

// The whole decision for one PreToolUse payload, with its file reads injectable so a test can
// count them. Returns { code, stderr }; every failure is ALLOW.
function decide(input, options = {}) {
  try {
    const env = options.env || process.env;
    const platform = options.platform || process.platform;
    const readFile = options.readFile || ((file) => fs.readFileSync(file, 'utf8'));
    let event;
    try { event = JSON.parse(input); } catch { return ALLOW; }
    if (!event || typeof event !== 'object') return ALLOW;
    const toolInput = event.tool_input;
    if (!TOOLS.has(event.tool_name) || !toolInput || typeof toolInput !== 'object') return ALLOW;
    if (!isIndexPath(toolInput.file_path, { env, platform, readFile })) return ALLOW;
    let current;
    try { current = String(readFile(toolInput.file_path)); }
    catch (error) {
      if (!error || error.code !== 'ENOENT') return ALLOW;
      current = '';
    }
    const next = applyEdit(current, event.tool_name, toolInput);
    if (next === null) return ALLOW;
    const result = verdict(current, next);
    return result.block ? { code: 2, stderr: blockMessage(result.reasons, next) } : ALLOW;
  } catch {
    return ALLOW;
  }
}

// stdin, synchronously and bounded, drained to EOF so the writer is never left blocked. Over
// the cap returns null (fail open) rather than a truncated prefix.
function readStdin(cap = STDIN_CAP) {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const kept = [];
  let total = 0;
  let over = false;
  for (;;) {
    let read;
    try { read = fs.readSync(0, buffer, 0, buffer.length, null); }
    catch (error) {
      if (error && error.code === 'EAGAIN') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        continue;
      }
      break;
    }
    if (read === 0) break;
    total += read;
    if (total > cap) { over = true; kept.length = 0; continue; }
    kept.push(Buffer.from(buffer.subarray(0, read)));
  }
  return over ? null : Buffer.concat(kept).toString('utf8');
}

module.exports = {
  GUARD_REVISION, BUDGETS,
  measure, commentDefects, commentDefectList, applyEdit, verdict, decide, isIndexPath, blockMessage,
};

if (require.main === module) {
  let outcome = ALLOW;
  try {
    const input = readStdin();
    if (input !== null) outcome = decide(input);
  } catch {
    outcome = ALLOW;
  }
  if (outcome.code === 2) {
    try { process.stderr.write(outcome.stderr); } catch { outcome = ALLOW; }
  }
  process.exitCode = outcome.code;
}
