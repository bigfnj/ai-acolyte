'use strict';

// Memory-index hygiene lint for the Claude Code file-memory system.
//
// MEMORY.md is loaded into every session, so it must stay thin: one-line hooks, with
// running status pushed into the per-fact file or the project repo. This module keeps
// that discipline honest *ambiently* — pure Node, no Python, no model, no Claude Code
// hook — so it ships in the VSIX and works under the managed policy. It watches every
// ~/.claude/projects/*/memory/MEMORY.md, shows a status-bar bloat gauge, and squiggles
// over-budget hook lines + broken index links in the editor. (Semantic recall is the
// separate CPU tool in this repo's memory/recall.py — deliberately not bundled here.)

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// The MEMORY.md guard's own rules, shared rather than restated (2026-10-19): the comment-defect
// scanner, the 140-line target the guard blocks growth past, and (2026-10-20) its 16-entry
// ceiling. The guard hook uses fixed budgets; this lint's window-scoped memory.* settings tune the
// gauge only. Found in `./src/` in a packaged extension and `../src/` in the repository, as
// autoLearnUi.js explains, by a resolve rather than a try/catch, so test/dead-exports.test.js can
// see which names this file uses.
const GUARD_MODULE = require.resolve('./memory-index-guard.js', { paths: [path.join(__dirname, 'src'), path.join(__dirname, '..', 'src')] });
const { BUDGETS: GUARD_BUDGETS, commentDefectList } = require(GUARD_MODULE);
const LINES_TARGET = GUARD_BUDGETS.lines;
const ENTRIES_CEILING = GUARD_BUDGETS.entries;

// recall.py's EXCLUDE (recall.py:233#EXCLUDE): the index is just hooks, so it is never a search
// target and never a gate source.
const MEMORY_INDEX = 'MEMORY.md';

// recall.py's gate markers (recall.py:268-269#GATE_BEGIN), and the pattern
// _compile_gates_text actually selects on -- recall.py's module-level `GATE_BLOCK`, built as
// `re.compile(re.escape(GATE_BEGIN) + r"(.*?)" + re.escape(GATE_END), re.DOTALL)` and shared
// with its --lint. BOTH markers are required, in order. Testing only for the opening one
// counted a gate source recall.py does not compile, and on the live corpus that is not
// hypothetical: one scope:global memory carries an opening marker, no closing marker, and a
// lone `<!-- gate -->` that is prose describing this very pipeline.
const GATE_BEGIN = '<!-- gate -->';
const GATE_END = '<!-- /gate -->';
const GATE_BLOCK = new RegExp(`${escapeRe(GATE_BEGIN)}([\\s\\S]*?)${escapeRe(GATE_END)}`);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A gate memory in either state the retire and restore verbs move it between, or null:
// recall.py's _gate_entry, `scope: global` or `scope: retired` in the frontmatter plus a PAIRED
// block, with gateAgents' reading of `agents:`. `state` is "active", "excluded" (scope: global,
// `agents:` unreadable, so left out for every agent) or "retired"; for a retired gate `agents`
// is who a restore returns it to. The ONE reading of scope and agents here, so the card's
// retired count and its gate count cannot disagree about a file (2026-10-14).
function gateEntryOf(raw) {
  const scope = frontmatter(raw, 'scope');
  if (scope !== 'global' && scope !== 'retired') return null;
  const m = GATE_BLOCK.exec(raw);
  if (!m) return null;
  const { agents, problem } = gateAgents(raw);
  const state = scope === 'retired' ? 'retired' : problem === null ? 'active' : 'excluded';
  return { scope, state, body: m[1].trim(), agents, problem };
}

// The gate a memory is, or null: recall.py's _gate. `scope: global` in the frontmatter plus a
// PAIRED block, with gateAgents' reading of `agents:`; `problem` set means the compiler leaves
// it out for every agent. One rule for the primary's gate count and for the other stores'
// census below, as recall.py shares one rule between its compiler and its --lint census.
function gateOf(raw) {
  const entry = gateEntryOf(raw);
  return entry && entry.scope === 'global' ? { body: entry.body, agents: entry.agents, problem: entry.problem } : null;
}

// The gate block a memory contributes to the compile, trimmed, or null. recall.py's
// _gate_body: a gate whose `agents:` cannot be read contributes nothing.
function gateBody(raw) {
  const gate = gateOf(raw);
  return gate && gate.problem === null ? gate.body : null;
}

// Python's whitespace, the one set str.isspace(), str.strip() and the `re` module's `\s` use
// for text: checked code point by code point under the toolbox Python 3.11.15 on 2026-10-14,
// and the list rampage measured. JavaScript's `\s` and trim() are a different set (they take
// U+FEFF and leave out U+001C..U+001F and U+0085), and with them this read a gate recall.py
// does not compile, or missed one it does: rampage measured it over generated frontmatter.
const PY_SPACE = String.fromCharCode(0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000);
const PY_WS = `[${PY_SPACE}]`;
const pyStrip = (text, chars = PY_SPACE) => {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start])) start += 1;
  while (end > start && chars.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
};
const pyLstrip = (text) => {
  let start = 0;
  while (start < text.length && PY_SPACE.includes(text[start])) start += 1;
  return text.slice(start);
};

// The text between a memory's `---` fences, or '': recall.py's _frontmatter_block, over the
// text as Python's text mode hands it over. Universal newlines turn `\r\n` and a lone `\r`
// into `\n` and nothing else, then a BOM and blank lines before the fence are skipped.
//
// Scoped rather than searched over the whole text for the reason recall.py records: this
// corpus contains memories that DOCUMENT gate syntax, so a whole-text match on
// `scope: global` compiles a gate nobody declared. A leading UTF-8 BOM and blank lines are
// tolerated because PowerShell 5.1's `Out-File -Encoding utf8` writes one, and a memory
// edited by a one-liner would otherwise drop out of the count with nothing reporting it.
function frontmatterBlock(text) {
  const unix = String(text).replace(/\r\n?/g, '\n');
  let start = 0;
  while (start < unix.length && (unix.charCodeAt(start) === 0xfeff || ' \t\n'.includes(unix[start]))) start += 1;
  const head = unix.slice(start);
  if (!head.startsWith('---')) return '';
  const end = head.indexOf('\n---', 3);
  return end === -1 ? '' : head.slice(3, end);
}

// One frontmatter scalar: recall.py's _fm, `^\s*key:\s*(.+)$` under re.MULTILINE, then strip,
// then double quotes, then single quotes. Python breaks lines at `\n` only, for `^`, `$` and
// `.` alike; JavaScript's m flag and `.` also break at `\r`, U+2028 and U+2029. So no m flag:
// `^` and `$` are spelled as a `\n` on either side, and `.` as "not `\n`".
function frontmatter(text, key) {
  const m = new RegExp(`(?:^|(?<=\\n))${PY_WS}*${key}:${PY_WS}*([^\\n]+)(?=\\n|$)`).exec(frontmatterBlock(text));
  return m ? pyStrip(pyStrip(pyStrip(m[1]), '"'), "'") : '';
}

// recall.py GATE_AGENTS: every agent a gate can name, in its section order.
const GATE_AGENTS = ['claude', 'codex'];

// A YAML value without its trailing comment: recall.py _uncomment.
function uncomment(value) {
  for (let i = 1; i < value.length; i += 1) {
    if (value[i] === '#' && PY_SPACE.includes(value[i - 1])) return value.slice(0, i);
  }
  return value;
}

// Which agents a gate memory is for, { agents, problem }: recall.py's _gate_agents, line for
// line, and held to it by test/recall-py.sh over generated frontmatter. Absent or empty means
// every agent; an unknown name, two `agents:` lines, or a value this cannot read is a
// `problem`, and the gate is left out for every agent rather than guessed at.
function gateAgents(text) {
  const lines = frontmatterBlock(text).split('\n');
  const isKey = (line) => {
    const rest = pyLstrip(line);
    return rest.startsWith('agents') && pyLstrip(rest.slice(6)).startsWith(':');
  };
  const found = lines.flatMap((line, i) => (isKey(line) ? [i] : []));
  if (!found.length) return { agents: [...GATE_AGENTS], problem: null };
  if (found.length > 1) return { agents: [], problem: 'more than one `agents:` line' };
  const line = lines[found[0]];
  const rest = pyLstrip(line);
  const indent = line.length - rest.length;
  let value = pyStrip(uncomment(pyLstrip(rest.slice(6)).slice(1)));
  let items;
  if (value) {
    if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
    items = value.split(',');
  } else {
    items = [];
    for (const below of lines.slice(found[0] + 1)) {
      const item = pyLstrip(below);
      if (!item || item.startsWith('#')) continue;
      const depth = below.length - item.length;
      if (depth >= indent && item[0] === '-' && (item.length === 1 || PY_SPACE.includes(item[1]))) {
        items.push(uncomment(item.slice(1)));
        continue;
      }
      if (depth > indent && !items.length) {
        return { agents: [], problem: 'an `agents:` value on the line below it that is not a `- name` list' };
      }
      break;
    }
  }
  const names = items.map((item) => pyStrip(pyStrip(pyStrip(pyStrip(item), '"'), "'"))).filter(Boolean);
  if (!names.length) return { agents: [...GATE_AGENTS], problem: null };
  const unknown = names.filter((name) => !GATE_AGENTS.includes(name.toLowerCase()));
  if (unknown.length) {
    return { agents: [], problem: '`agents:` names an agent this compiler does not know: ' + unknown.join(', ') };
  }
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return { agents: GATE_AGENTS.filter((agent) => wanted.has(agent)), problem: null };
}

// ── Open threads: recall.py's _thread, in JavaScript (2026-10-19) ─────────────────────
//
// What a memory is to `recall.py --threads-compile`, for the dashboard's count and for
// activation's "is there anything to compile" question. recall.py is the authority that
// compiles; test/threads-compile.sh holds this reading to it memory by memory, over generated
// frontmatter and bodies, and holds indexHealth to _index_health over generated indexes.
const THREAD_STATUSES = ['open', 'awaiting', 'blocked', 'deferred'];
const THREAD_CLOSED = ['done', 'closed', 'live', 'shelved', 'deleted', 'dropped', 'shipped'];
const STATUS_BEGIN = '<!-- status -->';
// THE COMMONMARK RULE, for status blocks. Twin: recall.py's _STATUS_MARK, _COMMONMARK_FENCE_OPEN
// and _COMMONMARK_FENCE_CLOSE under fullmatch. Not the guard's any-indent fences, which
// commentDefectList (src/memory-index-guard.js) applies to the index. A line here never holds a
// newline, and `[^\n]` stands for Python's `.`, which JavaScript's `.` is not
// (it also stops at a carriage return, U+2028 and U+2029, which a Python line can hold).
const STATUS_MARK = /^ {0,3}(<!-- \/?status -->)[ \t]*$/;
const COMMONMARK_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
const COMMONMARK_FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

// recall.py _status_of: { value, problem }. Both null when the memory declares no `status:`.
function statusOf(text) {
  const found = frontmatterBlock(text).split('\n').filter((line) => {
    const rest = pyLstrip(line);
    return rest.startsWith('status') && pyLstrip(rest.slice(6)).startsWith(':');
  });
  if (!found.length) return { value: null, problem: null };
  if (found.length > 1) return { value: null, problem: 'more than one `status:` line' };
  const value = uncomment(pyLstrip(pyLstrip(found[0]).slice(6)).slice(1));
  return { value: pyStrip(pyStrip(pyStrip(pyStrip(value), '"'), "'")), problem: null };
}

// recall.py _memory_body, over the text as Python's universal newlines hand it over.
function memoryBody(text) {
  const unix = String(text).replace(/\r\n?/g, '\n');
  let start = 0;
  while (start < unix.length && (unix.charCodeAt(start) === 0xfeff || ' \t\n'.includes(unix[start]))) start += 1;
  const head = unix.slice(start);
  if (!head.startsWith('---')) return unix;
  const end = head.indexOf('\n---', 3);
  if (end === -1) return '';
  const below = head.indexOf('\n', end + 4);
  return below === -1 ? '' : head.slice(below + 1);
}

// recall.py _status_block: the lines between the first paired markers outside fenced code, or null.
function statusBlock(text) {
  let start = null;
  let fence = null;
  const lines = memoryBody(text).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fence) {
      const shut = COMMONMARK_FENCE_CLOSE.exec(line);
      if (shut && shut[1][0] === fence.char && shut[1].length >= fence.length) fence = null;
      continue;
    }
    const open = COMMONMARK_FENCE_OPEN.exec(line);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], length: open[1].length };
      continue;
    }
    const mark = STATUS_MARK.exec(line);
    if (!mark) continue;
    if (mark[1] === STATUS_BEGIN) start = i;
    else if (start !== null) return lines.slice(start + 1, i).join('\n');
  }
  return null;
}

// recall.py _THREAD_STRIP (2026-10-20): the controls Python's split() keeps, and the bidi controls,
// removed before anything else. Code points, as recall.py writes them.
const span = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);
const THREAD_STRIP = new Set([...span(0x00, 0x09), ...span(0x0e, 0x1c), ...span(0x7f, 0x85),
  ...span(0x86, 0xa0), 0x061c, 0x200e, 0x200f, ...span(0x202a, 0x202f), ...span(0x2066, 0x206a)]);

// recall.py _thread_text: THREAD_STRIP removed, Python's str.split() whitespace collapsed, comment
// markers neutralised, a leading `#` escaped. Uncapped, as Python's is.
function threadText(raw) {
  const kept = Array.from(raw).filter((ch) => !THREAD_STRIP.has(ch.codePointAt(0))).join('');
  const text = kept.split(new RegExp(`${PY_WS}+`)).filter(Boolean).join(' ')
    .split('<!--').join('&lt;!--').split('-->').join('--&gt;');
  return text.startsWith('#') ? String.fromCharCode(92) + text : text;
}

// recall.py _thread: null for no `status:`, else { kind, status, text } with kind one of
// listed, closed, duplicate, unknown, no-block. `status` is lowercased except for an unknown
// value, which is kept as written; `text` is set for a listed thread only.
function threadOf(raw) {
  const { value, problem } = statusOf(raw);
  if (problem !== null) return { kind: 'duplicate', status: null, text: null, problem };
  if (value === null) return null;
  const status = value.toLowerCase();
  if (THREAD_CLOSED.includes(status)) return { kind: 'closed', status, text: null };
  if (!THREAD_STATUSES.includes(status)) return { kind: 'unknown', status: value, text: null };
  const block = statusBlock(raw);
  if (block === null) return { kind: 'no-block', status, text: null };
  return { kind: 'listed', status, text: threadText(block) };
}

// recall.py _index_health's three budgets (LINT_LINES_WARN, LINT_TOTAL_WARN, LINT_LINE_WARN), and
// its phrases, over a fastLint result: [] when MEMORY.md is within all three. Not the 16-entry
// ceiling, which is a soft attention target. `longestLine` is in code points, as Python counts.
// Taken from the guard's BUDGETS rather than restated (2026-10-20): the numbers were written out
// here a second time, beside the import they equal, and test/memory-guard-parity.test.js pins
// recall.py's constants to BUDGETS, so one source holds all three places together.
const INDEX_BUDGETS = Object.freeze({
  lines: GUARD_BUDGETS.lines, bytes: GUARD_BUDGETS.bytes, lineChars: GUARD_BUDGETS.lineChars,
});
function indexHealth(fast) {
  if (!fast) return [];
  const over = [];
  if (fast.lineCount > INDEX_BUDGETS.lines) over.push(`${fast.lineCount} lines (budget ${INDEX_BUDGETS.lines})`);
  if (fast.bytes > INDEX_BUDGETS.bytes) over.push(`${fast.bytes} bytes (budget ${INDEX_BUDGETS.bytes})`);
  if (fast.longestLine > INDEX_BUDGETS.lineChars) {
    over.push(`${fast.longestLine} characters on its longest line (budget ${INDEX_BUDGETS.lineChars})`);
  }
  return over;
}

// Backstop cadence for re-discovering the memory store. A file watcher can only
// report on a directory that exists when the watcher is made, so when the store
// MOVES every watcher dies at once and no surviving watcher can say so. Same
// watcher-plus-periodic-reconcile shape Auto Learn uses, for the same reason.
const RECONCILE_MS = 5 * 60 * 1000;

// `memory.dir` is read from USER settings only (machine-scoped, 2026-10-14, S2 of the final
// pre-tag audit). It is not only the store this lint reads: memoryReport() hands it to the
// recall rebuild and sync, and to `recall.py --gates-compile` as RECALL_MEMORY_DIR, whose
// output extension.js installs into the user's global CLAUDE.md and AGENTS.md. Read with get(),
// a repository's .vscode/settings.json chose that corpus, and one edit of any memory file then
// recompiled and installed its `scope: global` gate blocks as the user's standing orders in
// every project (reproduced in a sandbox). globalValue, as extension.js's
// codexExecutableSetting reads its key, so a workspace or folder value that reaches inspect() is
// still ignored. The budgets and `enabled` stay window-scoped: they shape what the lint shows.
function cfg() {
  const c = vscode.workspace.getConfiguration('permissionWildcarding');
  const pinned = typeof c.inspect === 'function' ? c.inspect('memory.dir')?.globalValue : undefined;
  return {
    enabled: c.get('memory.enabled') !== false,
    dir: (typeof pinned === 'string' ? pinned : '').trim(),
    lineBudget: Number(c.get('memory.lineBudget')) || 300,
    totalBudget: Number(c.get('memory.totalBudget')) || 12000,
    // Not a budget we chose: Claude Code loads the first 200 lines of MEMORY.md and
    // drops the rest without saying so. Settable only because the loader's cap could
    // move. See fastLint for why this is the axis that binds.
    maxLines: Number(c.get('memory.maxLines')) || 200,
  };
}

// Every dir that holds a MEMORY.md (explicit config dir, else auto-discovered).
//
// `memory.enabled` is deliberately NOT consulted here, and that is contractual rather
// than an oversight — see test/memory-lint-watchers.test.js, 'discoverDirs answers "which
// stores EXIST"'. This function answers "which stores exist on disk"; `memory.enabled`
// answers "is the LINT on". Its two non-lint callers are extension.js's memoryCardWatchers
// and gatesCorpusWatchers, and the *.md one is one of only two callers of compileGates —
// so honouring `enabled` here would switch automatic gate recompilation off whenever
// somebody hid the status-bar gauge, coupling two unrelated features through one key. That
// exact outcome (zero watchers, gate recompilation silently dead) is already on this repo's
// record from the pinned-`memory.dir` bug, which is why `memoryStoreDirs`
// (extension.js:3421-3422#memoryStoreDirs) overrides `dir` before it calls this.
// The lint half honours the key where it belongs: refresh() hides the gauge, clears
// the diagnostics and drops ITS OWN watchers at its `!conf.enabled` early return, and
// memoryCardData refuses to render the card. So the feature really is off; what stays alive
// is only the watching.
//
// Only `conf.dir` is read. `enabled`, `lineBudget`, `totalBudget` and `maxLines` are inert
// in every call. The parameter stays an object because extension.js passes a whole
// `memoryConf()` with `dir` overridden, and enumerating the memory.* keys in one place is
// the point of that call.
function discoverDirs(conf) {
  if (conf.dir) return fs.existsSync(path.join(conf.dir, 'MEMORY.md')) ? [conf.dir] : [];
  const out = [];
  let projects;
  try { projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const e of projects) {
    if (!e.isDirectory()) continue;
    const d = path.join(PROJECTS_DIR, e.name, 'memory');
    if (fs.existsSync(path.join(d, 'MEMORY.md'))) out.push(d);
  }
  return out;
}

function norm(s) {
  return s.trim().toLowerCase().replace(/-/g, '_');
}

// Fast lint of one dir's MEMORY.md: size + over-long lines + broken file links + broken comments.
// Cheap enough to run on every save (reads one file, no sibling scan).
//
// `names` is the dir's `.md` listing when the caller already has one (fullReport does),
// and answers the broken-link probes from memory instead of one existsSync per link.
// It is a HINT, never an override: a name the set does not carry still falls through to
// existsSync. That is not belt-and-braces, it is required for correctness on two axes —
// NTFS matches filenames case-insensitively while a Set does not, so `[x](Foo.md)` against
// a `foo.md` on disk would flip from resolved to broken; and a link can carry a path
// segment (`sub/x.md`), which a flat listing of this dir cannot answer at all. Resolving
// links are the common case, so the fallback costs a syscall only where the lint is about
// to report a fault anyway.
//
// `text` is MEMORY.md's body when the caller already holds it. fullReport does: MEMORY.md
// is one of the .md files its corpus loop reads, so without this the index — the one file
// this whole feature is about — was read twice per dashboard push. null means "read it",
// and an empty index is '' rather than null, so a store with an empty MEMORY.md still
// takes exactly one read.
function fastLint(dir, conf, names = null, text = null) {
  const known = names ? new Set(names) : null;
  const memPath = path.join(dir, 'MEMORY.md');
  if (text == null) {
    try { text = fs.readFileSync(memPath, 'utf8'); } catch { return null; }
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  const tokens = Math.round(bytes / 4);
  const lines = text.split(/\r?\n/);

  // Claude Code truncates MEMORY.md at 200 LINES or 25 KB, whichever comes first, and
  // says nothing when it does. Bytes were the only axis measured here, and they are not
  // the one that binds: this store sits at ~42% of the line cap against ~26% of the byte
  // cap, and it grows by roughly one line per project while bytes barely move. So a card
  // that watches only bytes reads green right up to the point where the tail of the index
  // stops being loaded.
  //
  // A trailing newline splits into a final empty element that is not a line. Dropping it
  // is what makes this agree with `wc -l`, and with what the loader counts.
  const lineCount = lines.length - (lines[lines.length - 1] === '' ? 1 : 0);
  // The longest physical line in code points, every CR out, for the open threads' INDEX budget
  // (indexHealth). The CRs come out as they do for the per-line check below and in the guard
  // (2026-10-20): a 300-character line holding one interior CR read as 301 here and nowhere else.
  // Array.from only for a line longer than the longest so far, so the common case costs nothing:
  // removing CRs and counting code points can only shorten a line, never lengthen it.
  let longestLine = 0;
  for (const ln of lines) {
    if (ln.length > longestLine) longestLine = Math.max(longestLine, Array.from(ln.replace(/\r/g, '')).length);
  }

  const over = [];
  const broken = [];
  // The resident "- " entries, the guard's measure (a line of the LF-or-CRLF split that starts
  // with "- "), and the line of the first one past its ceiling, which is where the warning goes.
  let entries = 0;
  let entryPastCeiling = null;
  const linkRe = /\]\(([^)]+\.md)(#[^)]*)?\)/g;
  lines.forEach((ln, i) => {
    if (ln.startsWith('- ')) {
      entries += 1;
      if (entries === ENTRIES_CEILING + 1) entryPastCeiling = { line: i, end: ln.length };
    }
    // EVERY line, in code points (2026-10-19), the guard's and recall.py's rule. This read only
    // "- " lines and measured UTF-16 units, so a 300-character heading passed and a line of 160
    // emoji read as 320. `end` is the UTF-16 length, which is what a Range column counts.
    const len = Array.from(ln.replace(/\r/g, '')).length;
    if (len > conf.lineBudget) {
      over.push({ line: i, len, end: ln.length, text: ln });
    }
    let m;
    linkRe.lastIndex = 0;
    while ((m = linkRe.exec(ln)) !== null) {
      if (known?.has(m[1])) continue;
      if (!fs.existsSync(path.join(dir, m[1]))) {
        broken.push({ line: i, col: m.index, target: m[1] });
      }
    }
  });
  return {
    dir, memPath, bytes, tokens, over, broken,
    totalOver: bytes > conf.totalBudget,
    lineCount,
    longestLine,
    linesOver: lineCount > conf.maxLines,
    // Below the loader's cap, the target the MEMORY.md guard holds growth to: past it the index
    // still loads whole, and every addition should now take a line out.
    linesTarget: LINES_TARGET,
    linesOverTarget: lineCount > LINES_TARGET,
    // The entry ceiling the guard and recall.py --lint hold the index to (2026-10-20). Past it
    // the index still loads; "one in, one out" is what the guard then enforces.
    entries,
    entriesCeiling: ENTRIES_CEILING,
    entriesOver: entries > ENTRIES_CEILING,
    entryPastCeiling,
    // A `<!--` inside an open comment, an orphan `-->`, a comment never closed: Claude Code
    // strips comments from the index, so each one leaks text into every session or hides it.
    comments: commentDefectList(text),
  };
}

// The dir that is "current": the configured one, else the store holding the MOST .md
// files, ties broken by MEMORY.md mtime. Shared by the status-bar gauge and the
// dashboard Memory card so both reflect the same file.
//
// COUNT, not mtime, because recall.py's _discover_memory_dir() picks by count and it is the
// authority: it owns the index, the lint and the compiled gates. The extension OVERRIDES that
// discovery on every spawn (search extension.js for RECALL_MEMORY_DIR) by pinning the value
// this function returns, so whenever the two rules disagreed the NON-authoritative one won in
// the product. They agree today only because one store happens to be both largest and newest;
// they diverge the moment a memory is saved from a session launched at a different working
// directory, which mints a new project slug. Five such slugs already exist here.
//
// The old rule made that flip actively dangerous: the *.md watcher in extension.js fires for
// EVERY discovered store and calls compileGates(), which compiles from the PRIMARY and installs
// standing orders into CLAUDE.md. One memory saved elsewhere could repoint the compiler.
//
// The single-dir short-circuit stays. An earlier version of this comment claimed removing it
// was what made the rule falsifiable; that was wrong and an audit falsified it by restoring the
// line and watching all 14 tests still pass. The two-store tests pass TWO dirs, so the
// short-circuit never fires for them. What made the rule falsifiable was writing those tests.
// The line is worth keeping: it returns the one-store case, which is most installs, to zero
// syscalls, and `[x].map(...).sort(...)[0].d` is `x` for every input, so it changes no answer.
//
// Residual, deliberate difference from Python: on an exact count tie recall.py takes the
// first os.listdir entry and this takes the newest MEMORY.md. Unobservable for anything the
// extension spawns, because the pin decides; visible only to a bare CLI run.
//
// Returns `{ dir, files }`: the winning store, and the `.md` listing the selection
// already had to take to count it. `files` is null when no listing was made — the
// no-store case, and the single-store short-circuit, which is most installs and is
// kept at zero syscalls. memoryReport() hands `files` on to fullReport so the primary
// dir is scanned once per report instead of twice.
function pickPrimary(dirs) {
  if (!dirs.length) return { dir: null, files: null };
  if (dirs.length === 1) return { dir: dirs[0], files: null };
  const best = dirs
    .map((d) => {
      const files = mdFiles(d);
      return { d, files, n: files ? files.length : 0, t: memoryMtime(d) };
    })
    .sort((a, b) => b.n - a.n || b.t - a.t)[0];
  return { dir: best.d, files: best.files };
}

// Just the dir, for the two callers that have nothing to do with the listing: refresh()'s
// gauge, and the two tests that pin the selection rule itself.
function pickPrimaryDir(dirs) {
  return pickPrimary(dirs).dir;
}

// Literally recall.py's expression: os.listdir filtered on .md, MEMORY.md INCLUDED. Do not
// reuse src/recall-index.js indexableMemories() here, which excludes MEMORY.md and so is a
// different number. It would order identically today, because discoverDirs only returns
// dirs that have a MEMORY.md, but "agrees by coincidence" is the bug being fixed.
// A zero here is never a real count. discoverDirs only returns a dir after confirming it holds
// a MEMORY.md, and this counts MEMORY.md too, so the true minimum is 1. Zero therefore always
// means readdirSync threw, and swallowing that silently scored a healthy 123-file store below a
// 7-file one -- reaching, through an fs error, exactly the mis-selection this rule exists to
// prevent. Demonstrated with an injected EMFILE. So it says so: a control that can run degraded
// must never do it in silence.
//
// It still scores 0 and still loses the comparison. Choosing well when a directory is
// unreadable is a real design question (mtime alone? keep the previous answer?) and is in
// BACKLOG.md; being loud about it is the part that was free.
//
// Returns the LIST rather than the count it is compared on, because the winner's list is
// exactly the listing fullReport would otherwise take a second readdirSync to get. null,
// not [], on a read failure: an empty dir is impossible here (discoverDirs only returns a
// dir once it has seen a MEMORY.md in it), so `[]` would be indistinguishable from the
// error, and threading it onward would hand fullReport a corpus of nothing as if that were
// the answer.
function mdFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch (err) {
    console.error(`ai-acolyte: cannot read memory store ${dir}, so it cannot win `
      + `primary selection —`, err);
    return null;
  }
}

function memoryMtime(dir) {
  try { return fs.statSync(path.join(dir, 'MEMORY.md')).mtimeMs; } catch { return 0; }
}

// Blank out fenced + inline code spans so example [[links]] written inside backticks
// (e.g. `[[...]]`) aren't reported as unresolved wiki-links.
function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/``[^`]*``/g, ' ')
    .replace(/`[^`]*`/g, ' ');
}

// Full report: fast lint + unresolved [[wikilinks]] across the whole dir (report-only —
// forward-links to not-yet-written memories are legitimate, so they never become squiggles).
// `known` is pickPrimary()'s listing of the same dir when the caller has one. The scan is
// taken here only when it is absent, so a two-store install lists the primary once per
// report instead of twice. A single-store install short-circuits selection before it lists
// anything, so it arrives here with null and the scan below is its first and only one.
function fullReport(dir, conf, known = null) {
  let files = known;
  if (files == null) {
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { files = []; }
  }
  const valid = new Set();
  let all = '';
  // MEMORY.md is a .md file in this dir, so the loop below reads it like any other — and
  // fastLint then read it a SECOND time for the gauge. Its body is kept here and handed
  // down instead. The cost of getting this wrong is not the one read: the dashboard pushes
  // a report on every refresh, and this is the file the whole feature is about.
  let indexText = null;
  // How many memories the gates compiler could actually take. Counted HERE
  // because this loop already reads every body, so it costs nothing extra, and
  // because the alternative was a UI that offers "Compile gates" on a corpus
  // with nothing to compile — a modal, a compile and a warning toast to learn
  // what a disabled button could have said.
  //
  // The rule mirrors recall.py's _compile_gates_text: selection is on `scope`
  // (NOT type) plus the presence of a gate block. Kept deliberately literal so
  // the two are easy to compare; recall.py stays the authority that actually
  // compiles, and this is only ever used to decide whether to offer the action.
  //
  // "Literal" is the whole point, and it was three ways short of it. Measured on the live
  // corpus this counted 17 where recall.py compiles 16. All three divergences are the same
  // class -- a test that is WIDER than the one the compiler makes -- so a gate the compiler
  // would silently skip still lit the button:
  //   1. the gate block needs its CLOSING marker too (that is the one that diverged here),
  //   2. `scope:` is a frontmatter key, not a line anywhere in the file, and
  //   3. MEMORY.md is excluded, exactly as recall.py:1466#EXCLUDE excludes it.
  let gateSources = 0;
  // The text of each of those blocks, which the other-store census (otherStoreGates) needs to
  // tell a gate this store already installs from one it does not. Free for the same reason.
  const gateBodies = [];
  // Gate memories the compiler leaves out for every agent, because their `agents:` cannot be
  // read (recall.py _gate_agents), as { file, problem }: the gates card names them, since a
  // standing order that loads nowhere is otherwise visible only in `recall.py --lint`.
  const gateExcluded = [];
  // Retired gate memories (`scope: retired`, retired from the gates panel or `--gates retire`),
  // as { file, agents, problem }: the card's "N retired". This report's store is the one the
  // gates panel lists and edits, because the extension pins it as RECALL_MEMORY_DIR for every
  // gate step, so the count describes the same memories the panel shows. Read by gateEntryOf,
  // the reading the gate count above uses, so the two cannot disagree about a file.
  const gateRetired = [];
  // Memories that declare a `status:` at all, and those `recall.py --threads-compile` lists as
  // open threads (threadOf, recall.py's _thread): the Claude memory card's open-threads line, and
  // activation's question whether a compile could have anything to say. The index is excluded,
  // as recall.py excludes it.
  let threadDeclared = 0;
  let threadListed = 0;
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    if (f === MEMORY_INDEX) indexText = raw;
    all += '\n' + raw;
    valid.add(norm(f.slice(0, -3)));
    const nm = raw.slice(0, 400).match(/^\s*name:\s*(.+)$/m);
    if (nm) valid.add(norm(nm[1].trim().replace(/^["']|["']$/g, '')));
    const thread = f !== MEMORY_INDEX ? threadOf(raw) : null;
    if (thread) threadDeclared += 1;
    if (thread?.kind === 'listed') threadListed += 1;
    const gate = f !== MEMORY_INDEX ? gateEntryOf(raw) : null;
    if (gate && gate.state === 'retired') gateRetired.push({ file: f, agents: gate.agents, problem: gate.problem });
    else if (gate && gate.state === 'excluded') gateExcluded.push({ file: f, problem: gate.problem });
    else if (gate) {
      gateSources += 1;
      gateBodies.push(gate.body);
    }
  }
  // recall.py's order (sorted by code point, its compile order), whatever order the listing came in.
  gateRetired.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  // AFTER the corpus pass, not before it, so `indexText` and `files` are both available:
  // the listing answers the broken-link probes that were one existsSync each, and the body
  // saves the second read of MEMORY.md. The order costs one thing and it is worth stating
  // — when MEMORY.md is the file that cannot be read, this returns null having already
  // read the corpus for nothing. That is the EISDIR / permissions path, it ends in an
  // error message either way, and it is not the path that runs every five minutes.
  const fast = fastLint(dir, conf, files, indexText);
  if (!fast) return null;
  const unresolved = [...new Set(
    [...stripCode(all).matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]).filter((l) => !valid.has(norm(l)))
  )].sort();
  return { ...fast, fileCount: files.length, unresolved, gateSources, gateBodies, gateExcluded, gateRetired,
    threadDeclared, threadListed };
}

// ── Gates in the OTHER memory stores: reported, never compiled ────────────────────
//
// The maintainer's decision (2026-10-14), the dashboard half of recall.py's --lint census
// (recall.py _other_store_gates). Only one store compiles: memory.dir when the user sets it,
// else the store with the most memory files, and extension.js pins that store as
// RECALL_MEMORY_DIR for every compile. A `scope: global` gate in any other store used to be
// ignored in silence. It is still not compiled, because a second store must not be able to
// install a standing order without anyone choosing it; the gates card says how many there are.
//
// `primaryDir` is the compile store (memoryReport().dir) and `primaryBodies` the gate texts
// it compiles (its report's gateBodies). A gate whose text the compile store already has is
// installed, so a store copied rather than moved is not reported for it. Every
// ~/.claude/projects/*/memory directory is a candidate, with or without a MEMORY.md, because
// recall.py accepts either. Folder names only, never paths.
//
// The dashboard asks on every push, so the answer is held for CENSUS_MAX_AGE_MS for the same
// compile store and gate texts, and a census that does run reads a file only when its
// (mtime, size) changed. Measured in one process on the development box (2026-10-14,
// indicative, not the record's fresh-process protocol): 4 other stores of 50 files each cost
// 207 ms cold and 12.5 ms min / 15.7 ms p50 warm, which is one stat per file; far too much
// to pay on the extension host thread per push. With the window, a push inside it costs no
// fs call at all, and the line is at most a minute behind an edit in another store. On a
// one-store install a census costs one listing of ~/.claude/projects and nothing else.
const CENSUS_MAX_AGE_MS = 60 * 1000;
const otherGateMemo = new Map();   // file -> { mtimeMs, size, body }
let lastCensus = null;             // { key, at, result }

function samePath(a, b) {
  const key = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return key(a) === key(b);
}

const copyCensus = (result) => ({ count: result.count, stores: result.stores.map((store) => ({ ...store })),
  unreadable: [...result.unreadable] });

function otherStoreGates(primaryDir, primaryBodies = [], { maxAgeMs = CENSUS_MAX_AGE_MS, now = Date.now } = {}) {
  const key = JSON.stringify([primaryDir ? path.resolve(primaryDir) : null, primaryBodies]);
  if (lastCensus && lastCensus.key === key && now() - lastCensus.at < maxAgeMs) return copyCensus(lastCensus.result);
  const result = takeCensus(primaryDir, primaryBodies);
  lastCensus = { key, at: now(), result };
  return copyCensus(result);
}

function takeCensus(primaryDir, primaryBodies) {
  const known = new Set(primaryBodies);
  const stores = [];
  const unreadable = [];
  const seen = new Set();
  let projects;
  try { projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); }
  catch { return { count: 0, stores, unreadable }; }
  for (const entry of projects) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, entry.name, 'memory');
    if (primaryDir && samePath(dir, primaryDir)) continue;
    let names;
    try { names = fs.readdirSync(dir); }
    catch (err) {
      // No memory dir under this project is the common case, not a fault.
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') unreadable.push(entry.name);
      continue;
    }
    let count = 0;
    for (const name of names) {
      if (!name.endsWith('.md') || name === MEMORY_INDEX) continue;
      const file = path.join(dir, name);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      seen.add(file);
      let hit = otherGateMemo.get(file);
      if (!hit || hit.mtimeMs !== stat.mtimeMs || hit.size !== stat.size) {
        let raw;
        try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
        hit = { mtimeMs: stat.mtimeMs, size: stat.size, body: gateBody(raw) };
        otherGateMemo.set(file, hit);
      }
      if (hit.body !== null && !known.has(hit.body)) count += 1;
    }
    if (count) stores.push({ name: entry.name, count });
  }
  for (const file of otherGateMemo.keys()) if (!seen.has(file)) otherGateMemo.delete(file);
  return { count: stores.reduce((sum, store) => sum + store.count, 0), stores, unreadable };
}

class MemoryLint {
  constructor() {
    this.status = null;
    this.diags = null;
    this.channel = null;
    this.watchers = new Map();
    this.debounce = null;
    this.timer = null;
    // Subscribers notified on every refresh(); see onReconcile().
    this.reconcilers = new Set();
    // The ExtensionContext, kept so reconfigure() can build the enabled half
    // after activation. Only ever read; never disposed from here.
    this.context = null;
    // Set once the subscriptions are disposed, so a callback that was already
    // in flight cannot act on a torn-down instance. See refresh().
    this.disposed = false;
  }

  activate(context) {
    // Registered BEFORE the enabled check, and unconditionally. package.json
    // declares `permission-wildcarding.lintMemory` with no `when` clause and
    // `contributes.menus.commandPalette` is null, so the palette entry exists
    // whatever this setting says. Registering it only on the enabled path left
    // the command's one discoverable entry point raising "command not found".
    // showReport() answers for the disabled case itself.
    context.subscriptions.push(
      vscode.commands.registerCommand('permission-wildcarding.lintMemory', () => this.showReport())
    );

    // Retained so reconfigure() can build the rest later. Everything below the
    // enabled check is built once at activation or never, and `memory.enabled`
    // is a Settings-UI toggle a user can flip at any time.
    this.context = context;

    // The backstop is armed here, ABOVE the enabled check, for the same class of reason
    // the command registration is. Every other caller of refresh() — the save, open and
    // active-editor listeners — lives in initialize(), which the enabled check below
    // skips; with the timer down there too, a window that started with
    // `memory.enabled: false` ran refresh() exactly never for its whole life.
    //
    // refresh() is what runs notifyReconcile(), and extension.js deliberately hangs BOTH
    // of its memory-store watcher sets off that hook rather than arming a third timer,
    // on the stated grounds that this instance re-discovers those directories every five
    // minutes. That justification was only true on the enabled path. With the lint off,
    // those two sets got their one build at activation and were never reconciled again:
    // a store that appeared later went unwatched — and with it automatic gate
    // recompilation, since the gates corpus watcher is one of only two callers of
    // compileGates — and a store that went away left a live watcher on a dead directory
    // until deactivate().
    //
    // Armed in activate() and nowhere else, so it cannot be double-armed: reconfigure()
    // builds the skipped half through initialize(), which no longer touches the timer,
    // and activate() runs once per instance. initialize()'s `if (this.diags) return;` is
    // what used to carry that guarantee.
    this.disposed = false;
    // reconfigure(), not refresh(): a tick has to be able to BUILD. extension.js's
    // configuration listener is itself conditional on
    // `typeof vscode.workspace.onDidChangeConfiguration === 'function'`, so on a host
    // that lacks it this timer is the ONLY thing that ever notices a false -> true flip
    // — and refresh() past the enabled check dereferences `this.diags` unguarded, which
    // on a never-initialized instance is a TypeError, not a no-op. reconfigure()
    // initialises first when the flip has happened, and initialize()'s already-built
    // guard makes the ordinary enabled tick a plain refresh().
    this.timer = setInterval(() => this.reconfigure(), RECONCILE_MS);
    if (typeof this.timer?.unref === 'function') this.timer.unref();
    // The disposer moves up with the timer it clears, or a disabled-at-activation window
    // leaks a live interval past deactivate(). It also now sets `disposed` BEFORE the
    // subscriptions it guards are torn down rather than after, so an already-queued
    // callback cannot land on half-disposed objects.
    //
    // The debounce timer belongs here too. It used to be armed by schedule()
    // and cleared by nothing: a MEMORY.md write within 300 ms of a reload left
    // it live, and it then fired refresh() AFTER every subscription was
    // disposed — clearing a disposed DiagnosticCollection, hiding a disposed
    // StatusBarItem, and calling syncWatchers(), which creates a fresh watcher
    // per discovered dir into a map nothing will ever drain again. That is the
    // same shape as the leak this file is held up elsewhere as the model for.
    context.subscriptions.push({
      dispose: () => {
        this.disposed = true;
        clearInterval(this.timer);
        this.timer = null;
        clearTimeout(this.debounce);
        this.debounce = null;
      },
    });

    if (!cfg().enabled) return;
    this.initialize(context);
  }

  // The half activate() skips when the lint is disabled. Separate so flipping
  // memory.enabled false -> true can build it without a window reload: before
  // this existed, extension.js's config listener refreshed the dashboard CARD
  // and nothing else, so the card showed live memory data while the linter
  // itself was inert — the UI asserting a feature was on when it was off.
  initialize(context) {
    if (this.diags) return;   // already built

    this.diags = vscode.languages.createDiagnosticCollection('claude-memory');
    this.channel = vscode.window.createOutputChannel('Claude Memory Lint');
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.status.command = 'permission-wildcarding.lintMemory';
    context.subscriptions.push(this.diags, this.channel, this.status);

    // NOTE: the command is registered ONCE, above the enabled check. A second
    // registration used to sit here, and moving the first one above that check
    // left both — which VS Code answers by THROWING on the duplicate id. With
    // memory.enabled at its default of true, activate() therefore threw right
    // here, extension.js's try/catch logged it to the console, and everything
    // below never ran: no reconcile timer, no watcher disposer, no initial
    // refresh. The status-bar gauge and the diagnostics simply never appeared.
    // The test that was supposed to cover the change only drove the DISABLED
    // path, where this line is unreachable, so it passed while the normal
    // configuration was broken.

    // External writes (an agent editing MEMORY.md outside the editor) + in-editor saves/opens.
    // The per-dir watchers are (re)built from discovery inside refresh(), not once here:
    // Claude Code derives the project slug from the working directory, so renaming a
    // working root moves the whole store to a new slug. Watchers bound to the old dir then
    // fire never again, and a gauge that only repaints on those events would sit frozen on
    // stale numbers indefinitely — reporting a budget for a file that no longer exists.
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((d) => { if (this.isMemory(d)) this.refresh(); }),
      vscode.workspace.onDidOpenTextDocument((d) => { if (this.isMemory(d)) this.refresh(); }),
      vscode.window.onDidChangeActiveTextEditor((e) => { if (e && this.isMemory(e.document)) this.refresh(); }),
      { dispose: () => this.disposeWatchers() }
    );

    // The backstop that covers a move — a move leaves no live watcher to report it — is
    // armed in activate(), not here. See the note there: it has to run on the disabled
    // path too, because it is the only thing driving extension.js's two watcher sets.

    this.refresh();
  }

  // Called when permissionWildcarding.memory.* changes, and on every tick of the
  // 5-minute backstop armed in activate().
  //
  // false -> true has to BUILD what activate() skipped; true -> false is
  // already handled by refresh(), which hides the gauge, clears the diagnostics
  // and drops the watchers. Both directions used to need a window reload.
  //
  // Reachable with nothing built at all, since the backstop now ticks on the disabled
  // path: `cfg().enabled` is false there, so refresh() takes its early return, where
  // `this.status?.hide()` and `this.diags?.clear()` are optional-chained and
  // disposeWatchers() iterates an empty Map. Nothing below that branch runs, which is
  // what keeps the unguarded `this.diags.clear()` further down out of reach.
  reconfigure() {
    // The instance outlives its subscriptions on a teardown; rebuilding into a
    // disposed context would leak a watcher per discovered dir into a map
    // nothing will drain again.
    if (this.disposed) return;
    if (cfg().enabled && this.context) this.initialize(this.context);
    this.refresh();
  }

  // Keep one watcher per discovered dir: add watchers for dirs that appeared, drop the
  // ones whose dir went away. Called from refresh(), so the watcher set never outlives
  // the discovery it came from.
  syncWatchers(dirs) {
    const wanted = new Set(dirs);
    for (const [dir, watcher] of this.watchers) {
      if (wanted.has(dir)) continue;
      try { watcher.dispose(); } catch { /* already gone with the extension host */ }
      this.watchers.delete(dir);
    }
    for (const dir of wanted) {
      if (this.watchers.has(dir)) continue;
      const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), 'MEMORY.md')
      );
      w.onDidChange(() => this.schedule());
      w.onDidCreate(() => this.schedule());
      w.onDidDelete(() => this.schedule());
      this.watchers.set(dir, w);
    }
  }

  disposeWatchers() {
    for (const [, watcher] of this.watchers) {
      try { watcher.dispose(); } catch { /* nothing left to release */ }
    }
    this.watchers.clear();
  }

  // Run `fn` whenever this instance re-discovers the memory stores. Returns a Disposable.
  //
  // extension.js owns two MORE watcher sets over the same directories -- the dashboard
  // card's MEMORY.md watcher and the gates corpus *.md watcher -- and neither had a
  // reconcile, so a store that appeared later went unwatched until a window reload and one
  // that disappeared left a dead watcher until deactivate(). Rather than arm a third timer
  // over directories this instance is already re-discovering, they hang off this hook:
  // refresh() runs on the 5-minute backstop, on every MEMORY.md save or open, on every
  // activation of one in the editor, and 300 ms after every external write.
  //
  // A subscriber re-runs its OWN discovery on purpose. `memory.dir` answers "which store do
  // I LINT"; those watchers ask "which stores EXIST", and handing this instance's dirs over
  // would conflate the two -- the exact conflation that once built zero watchers and
  // silently disabled automatic gate recompilation.
  onReconcile(fn) {
    this.reconcilers.add(fn);
    return { dispose: () => this.reconcilers.delete(fn) };
  }

  notifyReconcile() {
    for (const fn of this.reconcilers) {
      try {
        fn();
      } catch (err) {
        console.error('ai-acolyte: a memory reconcile subscriber failed —', err);
      }
    }
  }

  isMemory(doc) {
    return doc && path.basename(doc.fileName) === 'MEMORY.md'
      && doc.fileName.replace(/\\/g, '/').includes('/.claude/projects/');
  }

  schedule() {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.refresh(), 300);
  }

  // The dir the status-bar gauge reflects (see pickPrimaryDir).
  primaryDir(dirs) {
    return pickPrimaryDir(dirs);
  }

  refresh() {
    // Belt to the cleared-timer brace. Clearing the timers stops a NEW callback
    // from being scheduled; it cannot recall one that already fired and is
    // sitting in the microtask queue. Everything below touches objects VS Code
    // has disposed, and `this.diags.clear()` is not even optional-chained.
    if (this.disposed) return;
    // Above the enabled check, not below it. A subscriber's watcher set does not honour
    // memory.enabled -- discoverDirs reads only conf.dir -- so a notify that stopped at the
    // disabled early return would freeze those sets for as long as the lint was off, while
    // this instance's own watchers were being dropped.
    this.notifyReconcile();
    const conf = cfg();
    // Optional-chained on purpose, and it is load-bearing rather than defensive: the
    // backstop now ticks on a window where memory.enabled was false at activation, so
    // this line runs with `status` and `diags` never created. disposeWatchers() over the
    // empty Map is a no-op for the same reason.
    if (!conf.enabled) { this.status?.hide(); this.diags?.clear(); this.disposeWatchers(); return; }
    const dirs = discoverDirs(conf);
    this.syncWatchers(dirs);

    // Diagnostics for every discovered MEMORY.md (squiggles show when the file is open).
    //
    // The result is kept, not discarded: the primary is one of `dirs`, so the gauge below
    // used to re-run fastLint over a file this loop had just read — a second readFileSync
    // of MEMORY.md and a second existsSync per index link, on a function that runs every
    // five minutes, on every MEMORY.md save, on every editor activation of one, and 300 ms
    // after every external write.
    this.diags.clear();
    const lints = new Map();
    for (const dir of dirs) {
      const r = fastLint(dir, conf);
      if (!r) continue;
      lints.set(dir, r);
      this.diags.set(vscode.Uri.file(r.memPath), this.toDiagnostics(r, conf));
    }

    const primary = this.primaryDir(dirs);
    // `lints` only holds the dirs fastLint could read, so a primary whose MEMORY.md threw
    // is absent here and lands on the same hide() the second call's null used to reach.
    const r = primary ? lints.get(primary) : null;
    if (!r) { this.status.hide(); return; }
    const issues = r.over.length + r.broken.length + r.comments.length;
    const tok = r.tokens >= 1000 ? (r.tokens / 1000).toFixed(1) + 'k' : String(r.tokens);
    // Past the cap names the cap; below it, past the 140-line target names the target.
    this.status.text = `$(book) mem: ${tok} tok`
      + (r.linesOver ? ` · ${r.lineCount}/${conf.maxLines} lines`
        : r.linesOverTarget ? ` · ${r.lineCount} lines, over the ${r.linesTarget}-line target` : '')
      + (r.entriesOver ? ` · ${r.entries}/${r.entriesCeiling} entries` : '')
      + (issues ? ` · ${issues} to fix` : '');
    this.status.tooltip =
      `MEMORY.md: ${r.bytes} bytes (~${r.tokens} tokens/session, budget ${conf.totalBudget / 4 | 0})\n` +
      `${r.lineCount} of ${conf.maxLines} lines — Claude Code loads the first ${conf.maxLines} and drops the rest; `
        + `the target is ${r.linesTarget}\n` +
      `${r.entries} resident "- " entries, ceiling ${r.entriesCeiling}\n` +
      `${r.over.length} over-budget line(s), ${r.broken.length} broken index link(s), `
        + `${r.comments.length} broken HTML comment(s)\n` +
      `${path.dirname(r.memPath).replace(os.homedir(), '~')}\nClick for the full report.`;
    // linesOver joins totalOver here rather than the count: neither has a line to point
    // at, and both are worse than anything that does. Past the target is a warning too: the
    // index still loads, and the next addition should take a line out. Past the entry ceiling
    // likewise (2026-10-20): a state, so it is named in the text and not counted "to fix".
    this.status.backgroundColor = (issues || r.totalOver || r.linesOver || r.linesOverTarget || r.entriesOver)
      ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.status.show();
  }

  toDiagnostics(r, conf) {
    const out = [];
    for (const o of r.over) {
      const d = new vscode.Diagnostic(
        new vscode.Range(o.line, 0, o.line, o.end),
        `Index line is ${o.len} chars (budget ${conf.lineBudget}). Move the running detail into ` +
        `the memory file or the project repo and leave a one-line hook.`,
        vscode.DiagnosticSeverity.Warning
      );
      d.source = 'claude-memory';
      out.push(d);
    }
    // One warning for the entry ceiling, on the first entry past it: the index has no single
    // line at fault, and one squiggle per surplus entry would read as that many faults.
    if (r.entryPastCeiling) {
      const at = r.entryPastCeiling;
      const d = new vscode.Diagnostic(new vscode.Range(at.line, 0, at.line, at.end),
        `The index holds ${r.entries} resident "- " entries, past the ${r.entriesCeiling}-entry ceiling `
        + 'the MEMORY.md guard and recall.py --lint hold it to; this is the first one past it. Take an '
        + 'entry out for each one you add, and move detail into the memory files.',
        vscode.DiagnosticSeverity.Warning);
      d.source = 'claude-memory';
      out.push(d);
    }
    const said = {
      nested: '`<!--` inside a comment that is already open: the first `-->` closes both, and the text up to the next `-->` is loaded into every session.',
      orphan: '`-->` with no comment open: it is shown as text in every session.',
      unclosed: '`<!--` never closed: everything after it is hidden from every session.',
    };
    for (const c of r.comments) {
      const width = c.kind === 'orphan' ? 3 : 4;
      const d = new vscode.Diagnostic(new vscode.Range(c.line, c.column, c.line, c.column + width),
        `Broken HTML comment in the index. ${said[c.kind]}`, vscode.DiagnosticSeverity.Warning);
      d.source = 'claude-memory';
      out.push(d);
    }
    for (const b of r.broken) {
      const d = new vscode.Diagnostic(
        new vscode.Range(b.line, b.col, b.line, b.col + b.target.length + 4),
        `Index links to a missing file: ${b.target}`,
        vscode.DiagnosticSeverity.Warning
      );
      d.source = 'claude-memory';
      out.push(d);
    }
    return out;
  }

  showReport() {
    const conf = cfg();
    // Reachable with the feature off, because the command is now always
    // registered. Say so plainly instead of dereferencing this.channel, which
    // activate() never created on that path.
    if (!conf.enabled) {
      vscode.window.showInformationMessage(
        'ai-acolyte: memory lint is off — set permissionWildcarding.memory.enabled to true.'
      );
      return;
    }
    const dirs = discoverDirs(conf);
    const { dir, files } = pickPrimary(dirs);
    if (!dir) {
      vscode.window.showInformationMessage('ai-acolyte: no MEMORY.md found under ~/.claude/projects/*/memory.');
      return;
    }
    const r = fullReport(dir, conf, files);
    // The same guard refresh() has at its own fastLint call. fullReport returns null
    // whenever fastLint does, and fastLint returns null on any readFileSync throw --
    // MEMORY.md existing as a DIRECTORY is enough, because discoverDirs only tests
    // existsSync and the read then fails EISDIR. A permissions error or a Windows sharing
    // violation reaches it the same way. This is a palette command, so the answer is to say
    // which file could not be read, not to throw into the extension host log where nobody
    // who clicked the gauge will look.
    if (!r) {
      vscode.window.showErrorMessage(
        `ai-acolyte: ${path.join(dir, MEMORY_INDEX)} exists but could not be read `
        + '(a directory of that name, a permissions error, or a sharing violation).'
      );
      return;
    }
    const ch = this.channel;
    ch.clear();
    ch.appendLine(`Memory lint — ${r.memPath.replace(os.homedir(), '~')}`);
    ch.appendLine(`  ${r.bytes} bytes (~${r.tokens} tokens loaded every session), target < ${conf.totalBudget}`);
    if (r.totalOver) ch.appendLine(`  ! index is ${r.bytes - conf.totalBudget} bytes over budget`);
    ch.appendLine(`  ${r.lineCount} lines of ${conf.maxLines}`
      + ` (Claude Code loads the first ${conf.maxLines} and drops the rest in silence)`);
    if (r.linesOver) {
      ch.appendLine(`  ! ${r.lineCount - conf.maxLines} line(s) past the cap`
        + ` — everything after line ${conf.maxLines} is NOT being loaded into sessions`);
    } else if (r.linesOverTarget) {
      ch.appendLine(`  ! ${r.lineCount - r.linesTarget} line(s) past the ${r.linesTarget}-line target:`
        + ' still loaded, but every addition should now take a line out');
    }
    ch.appendLine(`  ${r.entries} resident index entries, ceiling ${r.entriesCeiling}`);
    if (r.entriesOver) {
      ch.appendLine(`  ! ${r.entries - r.entriesCeiling} entries past the ceiling: take one out for each one you add`);
    }
    ch.appendLine(`  ${r.fileCount} memory files in the dir`);
    ch.appendLine('');
    if (r.over.length) {
      ch.appendLine(`${r.over.length} index line(s) over ${conf.lineBudget} chars — leave a hook, move detail out:`);
      for (const o of [...r.over].sort((a, b) => b.len - a.len)) {
        ch.appendLine(`  ${String(o.len).padStart(4)} ch  L${o.line + 1}  ${o.text.slice(o.text.startsWith('- ') ? 2 : 0, 72)}...`);
      }
      ch.appendLine('');
    }
    if (r.comments.length) {
      ch.appendLine('broken HTML comments (Claude Code strips comments, so these leak text into sessions or hide it):');
      const kinds = { nested: '<!-- inside an open comment', orphan: '--> with no comment open', unclosed: '<!-- never closed' };
      for (const c of r.comments) ch.appendLine(`  L${c.line + 1}  ${kinds[c.kind]}`);
      ch.appendLine('');
    }
    if (r.broken.length) {
      ch.appendLine('index links to MISSING files:');
      for (const b of r.broken) ch.appendLine(`  L${b.line + 1}  ${b.target}`);
      ch.appendLine('');
    }
    if (r.unresolved.length) {
      ch.appendLine('unresolved [[links]] (typo, or a forward-link to a memory not written yet):');
      for (const l of r.unresolved) ch.appendLine(`  [[${l}]]`);
      ch.appendLine('');
    }
    // "all index links resolve" was printed directly beneath a list of links that do not
    // resolve, because the verdict only tests over + broken. The unresolved ones are
    // report-only and correctly excluded from the verdict; the sentence just has to stop
    // claiming otherwise when there are any.
    // The comments joined the verdict with their check (2026-10-19), and the sentence names them,
    // so it claims exactly what it tests.
    if (!r.over.length && !r.broken.length && !r.comments.length) {
      ch.appendLine(r.unresolved.length
        ? `clean: every index line within budget, every index link resolves, every comment closes. `
          + `The ${r.unresolved.length} [[link]](s) above are forward-links, not faults.`
        : 'clean: every index line within budget, all index links resolve, every comment closes.');
    }
    ch.show(true);
    this.refresh();
  }
}

// Convenience for the dashboard Memory card: the full report for the current memory
// dir, plus the resolved config. Returns { conf, dir, report } (dir/report null if
// there is no MEMORY.md to look at). Pure Node — no python, no model.
function memoryReport() {
  const conf = cfg();
  // pickPrimary, not pickPrimaryDir: the selection already listed the winner's .md files
  // whenever it had to compare two stores, and fullReport's own scan is the same call
  // against the same dir. See pickPrimary.
  const { dir, files } = pickPrimary(discoverDirs(conf));
  return { conf, dir, report: dir ? fullReport(dir, conf, files) : null };
}

// The store memoryReport() reports, chosen the same way and without reading it (2026-10-20). The
// extension's recall.py spawns pin it as RECALL_MEMORY_DIR, and the open threads' corpus watcher
// compares an event's store with it; each took only `.dir` from memoryReport(), which reads every
// file in the store (171 files, 24-29 ms warm, on the development box), on paths that run unattended for every *.md event
// burst and every compile.
function memoryStoreDir() {
  return pickPrimary(discoverDirs(cfg())).dir;
}

// `fullReport` is deliberately NOT exported: its only callers are showReport() and
// memoryReport(), both in this file, and a dead export entry is a standing invitation to
// import a function no consumer has ever exercised. The function stays; the entry goes.
// `pickPrimaryDir` looks similar and is NOT the same case -- it has no production importer
// either, but test/memory-lint-watchers.test.js calls it directly, and those calls are the
// mutation-killing assertions for the store-selection rule. `fastLint` was the same until
// 2026-10-20, when extension.js began measuring MEMORY.md with it (indexEventMayChange);
// test/memory-line-cap.test.js still calls it for the line cap.
module.exports = { MemoryLint, cfg, fastLint, discoverDirs, pickPrimaryDir, memoryReport, otherStoreGates, gateOf, gateEntryOf,
  threadOf, indexHealth, memoryStoreDir };
