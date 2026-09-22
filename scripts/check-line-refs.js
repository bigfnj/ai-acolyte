#!/usr/bin/env node
'use strict';

// Resolve every `file:line` reference this repo writes about itself.
//
// The repo documents its own internals by line number, in BACKLOG.md and in code
// comments. Line numbers rot on the next edit: BACKLOG.md's own dead-code audit
// records "~60 stale file:line refs", and two written during a single change were
// wrong within hours. This walks every tracked `.md` file and every comment in
// tracked source, pulls each reference out with the claim the surrounding prose
// makes about it, and checks the claim against the line the reference points at.
//
// A reference is only judged when a checkable ANCHOR can be recovered from the
// prose — a backticked code span, a quoted string, or a bare identifier. Without
// one the reference is reported UNVERIFIABLE rather than guessed at, because a
// wrong correction is worse than a stale reference.
//
// Verdicts, in descending order of how much you should trust them:
//
//   BROKEN        the file does not exist, or the line is past its end. Objective,
//                 no heuristics. This is the half test/line-refs.test.js asserts.
//   OK / NEAR     a distinctive anchor sits at (or within 3 lines of) the cited
//                 line. NEAR is not worth rewriting; churning a working reference
//                 is how a correction pass introduces the error it came to remove.
//   STALE         a CANDIDATE, not a proof. Every distinctive anchor lives
//                 somewhere else in the file. Read both ends before rewriting:
//                 the checker picks a neighbouring symbol often enough that some
//                 STALE rows are correct references.
//   UNVERIFIABLE  the prose makes a descriptive claim with no literal string to
//                 match against. Reported rather than guessed at.
//
// Usage:
//   node scripts/check-line-refs.js            human-readable report
//   node scripts/check-line-refs.js --detail   also show the cited and candidate lines
//   node scripts/check-line-refs.js --json     machine-readable
//   node scripts/check-line-refs.js --quiet    only the counts
//
// Exit 1 only when something is BROKEN. STALE does not fail the run, because a
// verdict that is right most of the time is a report, not a gate.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// How far a reference may miss and still be considered to point at the right
// thing. Three lines covers "the prose cites the body, the anchor is the
// signature" without hiding the real drift this repo sees, which runs to tens of
// lines at a time.
const TOLERANCE = 3;

// `src/foo.js:12`, `bin/wildcard-perms:253-254`, `recall.py:73`.  line-refs:ignore
// The extension-less spelling is enumerated rather than matched as a wildcard so
// that ordinary prose like "ratio 3:1" can never register as a reference.
const EXTLESS = ['wildcard-perms', 'recall\\.py'];
const REF_RE = new RegExp(
  '(?<![\\w/.-])((?:[A-Za-z0-9_.-]+/)*(?:[A-Za-z0-9_.-]+\\.(?:js|mjs|cjs|ps1|sh|md|json|py|yml|yaml)|' +
    EXTLESS.join('|') +
    ')):(\\d+)(?:\\s*-\\s*(\\d+))?(?![\\w/.-])',
  'g'
);

const REF_RE_TEST = new RegExp(REF_RE.source);

// The same pattern plus the backticks a reference is normally written inside.
//
// judge() strips references out of the prose before hunting for an anchor, so that
// "permissions.js" inside a reference cannot serve as its own anchor. Stripping the
// token ALONE left the pair that wrapped it: `src/foo.js:12` collapsed to a backtick,  line-refs:ignore
// a space and a backtick, which is under the 3-character floor for a code span. The
// scanner therefore skipped it and paired that leftover backtick with the OPENING
// backtick of the next real anchor, so every code span after a backticked reference
// shifted by one and the anchor that mattered was never extracted at all.
//
// The cost was false STALE and UNVERIFIABLE verdicts on references that were correct.
// Two agents hit it independently, on different files, during one correction pass:
// `src/history-adapters.js:959` queues `entry.isSymbolicLink()` children reported STALE
// on the anchor "point", and it only resolved when the symbol was moved AHEAD of the
// citation. Writing the anchor first was a workaround for this bug, not a convention.
//
// The optional backticks sit OUTSIDE REF_RE's own lookaround, which still sees the
// backtick as the neighbouring character and still passes, so the token match is
// unchanged. A reference written without backticks is unaffected.
const REF_STRIP_RE = new RegExp('`?' + REF_RE.source + '`?', 'g');

// Remove every file:line token, and the code span it was written in, from `text`.
function stripRefs(text) {
  return String(text).replace(REF_STRIP_RE, ' ');
}

// A line carrying this marker has its references skipped.
//
// Needed because documentation ABOUT the reference format contains references
// that point at nothing on purpose. An example that is deliberately dangling:
//   `src/foo.js:12`   line-refs:ignore
// This file tripped its own test the moment it became tracked,
// which is a fair demonstration that the marker has to be explicit: silently
// exempting this file by name would exempt its real references too, and there
// are several.
const IGNORE_MARKER = 'line-refs:ignore';

const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ps1', '.sh']);
const EXTLESS_SOURCE = new Set(['wildcard-perms', 'smoke', 'install', 'uninstall']);

function tracked() {
  return execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

const fileCache = new Map();
function linesOf(rel) {
  if (fileCache.has(rel)) return fileCache.get(rel);
  let lines = null;
  try {
    lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/);
  } catch {
    lines = null;
  }
  fileCache.set(rel, lines);
  return lines;
}

// ---------------------------------------------------------------------------
// Target resolution.
//
// References are written three ways. Format illustrations, not claims:
//   repo-relative                     `src/permissions.js:31`     line-refs:ignore
//   basename beside the referrer      `permission-match.js:79`    line-refs:ignore
//   basename of a file elsewhere      `uninstall.ps1:28`          line-refs:ignore
// Try them in that order; a basename that matches more than one tracked path is
// AMBIGUOUS and never guessed.
// ---------------------------------------------------------------------------
function buildIndex(trackedFiles) {
  const byPath = new Set(trackedFiles);
  const byBase = new Map();
  for (const f of trackedFiles) {
    const b = path.posix.basename(f);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(f);
  }
  return { byPath, byBase };
}

function resolveTarget(index, ref, fromFile) {
  if (index.byPath.has(ref)) return { rel: ref };
  const fromDir = path.posix.dirname(fromFile);
  const sibling = path.posix.normalize(path.posix.join(fromDir, ref));
  if (index.byPath.has(sibling)) return { rel: sibling };
  const base = path.posix.basename(ref);
  const hits = index.byBase.get(base) || [];
  // A reference written with directories ("scripts/verify-installers.ps1") must
  // match on the suffix, not just the basename.
  const narrowed = ref.includes('/') ? hits.filter((h) => h.endsWith('/' + ref) || h === ref) : hits;
  const pool = narrowed.length ? narrowed : hits;
  if (pool.length === 1) return { rel: pool[0] };
  if (pool.length > 1) return { ambiguous: pool };
  return { missing: true };
}

// ---------------------------------------------------------------------------
// Anchor extraction.
//
// The "claim" is whatever the prose asserts lives at that line. In practice it is
// a backticked span, a double-quoted phrase, or a CamelCase/snake_case identifier
// sitting beside the reference. Collect candidates from the enclosing unit — a
// markdown bullet or paragraph, or a run of comment lines — on BOTH sides of the
// reference, since tables put the symbol before the path and prose puts it after.
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'its', 'it', 'is', 'are', 'was',
  'were', 'not', 'but', 'all', 'one', 'two', 'has', 'have', 'had', 'can', 'only', 'now', 'new',
  'see', 'via', 'per', 'at', 'in', 'on', 'of', 'to', 'a', 'an', 'as', 'by', 'or', 'so', 'no',
  'js', 'ms', 'md', 'ps1', 'sh', 'json', 'true', 'false', 'null', 'line', 'lines', 'file',
  'files', 'test', 'tests', 'code', 'comment', 'same', 'both', 'each', 'every', 'never', 'here'
]);

// Prose wraps; anchors do not. A quoted claim or a backticked span routinely
// straddles two lines of BACKLOG.md or two lines of a `//` comment block, and a
// line-at-a-time regex silently fails to see it, falls through to a weaker
// anchor, and reports a correct reference as stale. Flatten the context to one
// line first, stripping list markers and comment leaders.
function flatten(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l, i) =>
      i === 0
        ? l
        : l.replace(/^\s*(?:\/\/+|#+|\*)?\s*/, '').replace(/^(?:[-*+]|\d+\.)\s+/, '')
    )
    .join(' ')
    .replace(/[ \t]+/g, ' ');
}

function anchorsFrom(text) {
  const out = [];
  const seen = new Set();
  const push = (raw, kind) => {
    const v = String(raw).trim();
    if (!v || v.length < 3) return;
    const key = kind + '\u0000' + v;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text: v, kind });
  };
  // Backticked code spans. These are the strongest signal.
  for (const m of text.matchAll(/`([^`\n]{3,120})`/g)) push(m[1], 'code');
  // Double-quoted phrases (markdown prose uses straight quotes here).
  for (const m of text.matchAll(/"([^"\n]{3,160})"/g)) push(m[1], 'quote');
  // Bare identifiers, but only shapes prose cannot produce by accident:
  // camelCase, SCREAMING_CASE, snake_case, or a name written with a call paren.
  // A plain capitalised word ("Learn", "Codex", "Neither") is excluded — it is
  // usually just a sentence start, and treating it as an anchor was the single
  // largest source of false STALE verdicts while this script was being built.
  for (const m of text.matchAll(/(?<![`\w.$])([A-Za-z_][A-Za-z0-9_]{2,})(\s*\()?/g)) {
    const w = m[1];
    if (STOPWORDS.has(w.toLowerCase())) continue;
    const camel = /[a-z][A-Z]/.test(w);
    const screaming = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(w);
    const snake = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(w);
    const called = Boolean(m[2]);
    if (camel || screaming || snake || called) push(w, 'ident');
  }
  return out;
}

// Only an anchor that could not plausibly match by accident is allowed to decide
// a verdict. Everything else downgrades the reference to UNVERIFIABLE, which is
// the honest answer: a wrong correction is worse than a stale reference.
function isStrong(anchor, hitCount) {
  const t = norm(anchor.text);
  if (hitCount === 0) return false;
  if (anchor.kind === 'ident') return t.length >= 5 && hitCount <= 6;
  return t.length >= 8 && hitCount <= 8;
}

// Markdown emphasis and line wrapping mean an anchor can be spelled `foo\nbar` in
// the doc and `foo bar` in the code. Compare on a whitespace-collapsed, emphasis-
// stripped form.
function norm(s) {
  return s
    .replace(/\*\*/g, '')
    .replace(/\\([`*_])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function anchorMatches(anchor, haystack) {
  const a = norm(anchor.text);
  const h = norm(haystack);
  // An identifier must match on word boundaries and NOTHING else. A plain
  // substring test made `normalizeRule` match inside `normalizeRuleUncached`,
  // which inflated its hit count past the distinctiveness cap and silently
  // demoted the one correct anchor on the line, handing the verdict to a weaker
  // one. That turned a good reference into a STALE report.
  if (anchor.kind === 'ident') {
    return new RegExp('(?<![\\w$])' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w$])').test(h);
  }
  if (a.length >= 3 && h.includes(a)) return true;
  // An anchor quoted from prose often carries trailing punctuation or an ellipsis
  // that the source does not. Fall back to the longest run of source-looking text.
  if (anchor.kind === 'quote' || anchor.kind === 'code') {
    const head = a.split(/\s*(?:…|\.\.\.)\s*/)[0].trim();
    if (head.length >= 8 && h.includes(head)) return true;
  }
  return false;
}

function findAnchor(anchor, lines) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (anchorMatches(anchor, lines[i])) hits.push(i + 1);
  }
  if (hits.length) return hits;
  // The target wraps too: a claim quoted as one phrase can span two or three
  // lines of the file it describes. Report the line the match starts on.
  for (const width of [2, 3]) {
    for (let i = 0; i + width <= lines.length; i++) {
      const window = lines
        .slice(i, i + width)
        .map((l, k) => (k === 0 ? l : l.replace(/^\s*(?:\/\/+|#+|\*)?\s*/, '')))
        .join(' ');
      if (anchorMatches(anchor, window)) hits.push(i + 1);
    }
    if (hits.length) return hits;
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Context units.
// ---------------------------------------------------------------------------

// The claim about a reference is almost always on the reference's OWN line, or
// wrapped onto the next line or two of the same bullet. Pooling a whole bullet or
// a whole code block mixes claims: a five-row table of `NAME  path:line` handed
// every row's symbol to every row's path, and each row then read as stale against
// a neighbour's symbol. Scope tight first, widen only if the tight scope yields
// nothing checkable.
// One line can carry several references. The house style here looks like
//   "(`a.js:12`), CLI gates (`:489`), and `decideDerived` (`b.js:921`)"   line-refs:ignore
// Pooling the line's
// anchors hands every symbol to every path, so each reference gets only the text
// between its neighbours: from the end of the previous reference to the start of
// the next one. The last reference on the line also gets the wrapped
// continuation, since that is where a long quote finishes.
function sliceForRef(line, matches, i, continuation) {
  const prevEnd = i > 0 ? matches[i - 1].index + matches[i - 1][0].length : 0;
  const nextStart = i + 1 < matches.length ? matches[i + 1].index : line.length;
  const own = line.slice(prevEnd, nextStart);
  return i === matches.length - 1 && continuation ? own + '\n' + continuation : own;
}

// The wrapped remainder of the unit after `idx`, without the line itself.
function continuationAfter(lines, idx) {
  const out = [];
  for (let i = idx + 1; i < Math.min(lines.length, idx + 3); i++) {
    const l = lines[i];
    if (!l.trim()) break;
    if (/^\s*[-*+] |^\s*\d+\.\s|^#{1,6}\s|^\s*```/.test(l)) break;
    // A continuation line that carries its own reference belongs to that one.
    // Uses a non-global clone: testing the shared /g regex would leave lastIndex
    // advanced, and the caller's matchAll clones that value and skips matches.
    if (REF_RE_TEST.test(l)) break;
    out.push(l);
  }
  return out.join('\n');
}

// For markdown: the bullet or paragraph containing the line, capped so a long
// section cannot drag in an unrelated symbol.
function mdUnit(lines, idx) {
  let start = idx;
  while (start > 0) {
    const prev = lines[start - 1];
    if (!prev.trim()) break;
    if (/^\s*[-*+] |^\s*\d+\.\s/.test(prev) && /^\s*[-*+] |^\s*\d+\.\s/.test(lines[start])) break;
    if (/^#{1,6}\s/.test(prev)) break;
    start--;
    if (idx - start >= 4) break;
  }
  let end = idx;
  while (end < lines.length - 1) {
    const next = lines[end + 1];
    if (!next.trim()) break;
    if (/^\s*[-*+] |^\s*\d+\.\s/.test(next)) break;
    if (/^#{1,6}\s/.test(next)) break;
    end++;
    if (end - idx >= 4) break;
  }
  return lines.slice(start, end + 1).join('\n');
}

// For source: the contiguous run of comment lines around the reference. Only
// comment text is scanned, so a ref inside a string literal or real code is
// ignored by the caller.
function commentRuns(rel, lines) {
  const ext = path.extname(rel);
  const hashStyle = ext === '.ps1' || ext === '.sh' || ext === '.yml' || ext === '.yaml' || ext === '.py';
  const isComment = (l) => {
    const t = l.trim();
    if (hashStyle) return t.startsWith('#');
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
  };
  const runs = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    if (isComment(lines[i])) {
      if (!cur) cur = { start: i + 1, lines: [] };
      cur.lines.push(lines[i]);
    } else if (cur) {
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);
  return runs;
}

function looksLikeSource(rel) {
  const ext = path.extname(rel);
  if (SOURCE_EXT.has(ext)) return true;
  return EXTLESS_SOURCE.has(path.posix.basename(rel));
}

// ---------------------------------------------------------------------------

function collectRefs(trackedFiles) {
  const refs = [];
  for (const rel of trackedFiles) {
    const lines = linesOf(rel);
    if (!lines) continue;
    const ext = path.extname(rel);
    if (ext === '.md') {
      lines.forEach((line, i) => {
        const matches = line.includes(IGNORE_MARKER) ? [] : [...line.matchAll(REF_RE)];
        const continuation = continuationAfter(lines, i);
        matches.forEach((m, k) => {
          refs.push({
            source: rel,
            sourceLine: i + 1,
            kind: 'doc',
            target: m[1],
            start: Number(m[2]),
            end: m[3] ? Number(m[3]) : Number(m[2]),
            raw: m[0],
            context: sliceForRef(line, matches, k, continuation),
            wideContext: mdUnit(lines, i)
          });
        });
      });
    } else if (looksLikeSource(rel)) {
      for (const run of commentRuns(rel, lines)) {
        const text = run.lines.join('\n');
        run.lines.forEach((line, j) => {
          const matches = line.includes(IGNORE_MARKER) ? [] : [...line.matchAll(REF_RE)];
          const continuation = continuationAfter(run.lines, j);
          matches.forEach((m, k) => {
            refs.push({
              source: rel,
              sourceLine: run.start + j,
              kind: 'comment',
              target: m[1],
              start: Number(m[2]),
              end: m[3] ? Number(m[3]) : Number(m[2]),
              raw: m[0],
              context: sliceForRef(line, matches, k, continuation),
              wideContext: text
            });
          });
        });
      }
    }
  }
  return refs;
}

function judge(ref, index) {
  const res = resolveTarget(index, ref.target, ref.source);
  if (res.missing) return { ...ref, verdict: 'BROKEN', detail: 'no tracked file matches' };
  if (res.ambiguous) {
    return { ...ref, verdict: 'UNVERIFIABLE', detail: 'ambiguous basename: ' + res.ambiguous.join(', ') };
  }
  const rel = res.rel;
  const lines = linesOf(rel);
  if (!lines) return { ...ref, verdict: 'BROKEN', detail: 'unreadable: ' + rel };
  // A trailing newline makes split() yield one empty element past the last line.
  const count = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  if (ref.start > count || ref.end > count) {
    return { ...ref, resolved: rel, verdict: 'BROKEN', detail: `line ${ref.start}-${ref.end} past EOF (${count} lines)` };
  }
  // A reference to its own file that points at itself is a self-description, not
  // a claim about elsewhere. Still checked, but the context excludes the ref line.
  const span = lines.slice(ref.start - 1, ref.end).join('\n');
  const gather = (text) => {
    // Drop every file:line token first, so "permissions.js" inside the reference
    // itself cannot serve as its own anchor. stripRefs takes the wrapping backticks
    // with it; see the note there for what leaving them behind cost.
    const anchors = anchorsFrom(stripRefs(flatten(text))).filter((a) => {
      const n = norm(a.text).toLowerCase();
      return n !== path.posix.basename(rel).toLowerCase() && !n.startsWith(rel.toLowerCase());
    });
    return anchors
      .map((a) => ({ anchor: a, hits: findAnchor(a, lines) }))
      .map((s) => ({ ...s, strong: isStrong(s.anchor, s.hits.length) }));
  };
  let scored = gather(ref.context);
  let strong = scored.filter((s) => s.strong);
  if (!strong.length && ref.wideContext && ref.wideContext !== ref.context) {
    const wider = gather(ref.wideContext);
    if (wider.some((s) => s.strong)) {
      scored = wider;
      strong = wider.filter((s) => s.strong);
    }
  }
  if (!strong.length) {
    const best = scored[0];
    const why = best
      ? `no distinctive anchor (best: ${JSON.stringify(best.anchor.text.slice(0, 50))})`
      : 'no anchor in surrounding prose';
    return { ...ref, resolved: rel, verdict: 'UNVERIFIABLE', detail: why };
  }
  const inRange = strong.filter((s) => s.hits.some((h) => h >= ref.start && h <= ref.end));
  if (inRange.length) {
    return {
      ...ref,
      resolved: rel,
      verdict: 'OK',
      detail: `anchor ${JSON.stringify(inRange[0].anchor.text.slice(0, 60))}`
    };
  }
  // A reference that lands within TOLERANCE lines still points a reader at the
  // right place: prose routinely cites a function's body while the anchor is its
  // declaration a line above, or the reverse. Report it, but do not call it stale
  // and do not rewrite it — churning a reference that already works is how a
  // correction pass introduces the error it was meant to remove.
  const near = strong.filter((s) =>
    s.hits.some((h) => h >= ref.start - TOLERANCE && h <= ref.end + TOLERANCE)
  );
  if (near.length) {
    const h = near[0].hits.find((x) => x >= ref.start - TOLERANCE && x <= ref.end + TOLERANCE);
    return {
      ...ref,
      resolved: rel,
      verdict: 'NEAR',
      detail: `anchor ${JSON.stringify(near[0].anchor.text.slice(0, 50))} at ${h}, cited ${ref.start}` +
        (ref.end !== ref.start ? '-' + ref.end : '')
    };
  }
  // Every distinctive anchor lives somewhere else in the file. Prefer the most
  // specific one (longest quoted/backticked span, then fewest occurrences) when
  // proposing where the reference should now point.
  const ranked = strong.slice().sort((a, b) => {
    const w = { code: 2, quote: 2, ident: 1 };
    return (
      (w[b.anchor.kind] || 0) - (w[a.anchor.kind] || 0) ||
      a.hits.length - b.hits.length ||
      b.anchor.text.length - a.anchor.text.length
    );
  });
  const best = ranked[0];
  return {
    ...ref,
    resolved: rel,
    verdict: 'STALE',
    detail:
      `anchor ${JSON.stringify(best.anchor.text.slice(0, 60))} is at ` +
      best.hits.slice(0, 6).join(', ') +
      (best.hits.length > 6 ? ` (+${best.hits.length - 6} more)` : '') +
      ` (cited ${ref.start}${ref.end !== ref.start ? '-' + ref.end : ''})`,
    suggest: best.hits,
    anchor: best.anchor.text.slice(0, 80)
  };
}

// The objective half of the check, with none of the anchor heuristics: does the
// referenced file exist, and does the referenced line exist inside it?
//
// Split out deliberately. The STALE verdict is a CANDIDATE — it rests on
// recovering the right anchor from prose, and it picks a neighbouring symbol
// often enough that wiring it to a test would fail the suite on references that
// are correct. This half cannot do that. A reference either resolves or it does
// not, so it is safe to assert, and it is fast: no per-anchor scan of the target
// file, which is what makes the full report take seconds.
// A line that carries nothing a reader could have meant. Blank, or punctuation that
// only closes a block someone else opened.
//
// Deliberately NOT "a comment line" or "an import": this repo documents itself in
// comments, so a comment is a perfectly good target, and several references name a
// require on purpose.
const VACUOUS_LINE = new Set(['}', '};', '},', ')', ');', ']', '];', '})', '});']);

// Exported and unit-tested separately from checkVacuous, because the tree currently has
// ZERO offenders: an assertion that the offender list is empty stays green if someone
// empties VACUOUS_LINE or flips `every` to `some`, so the corpus test alone cannot pin
// this predicate. The unit test can.
function isVacuousSpan(span) {
  return span.length > 0 && span.every((l) => l.trim() === '' || VACUOUS_LINE.has(l.trim()));
}

// References that point at a blank line or a bare closing brace.
//
// This is the second OBJECTIVE check, alongside checkBounds. It needs no anchor, no
// prose and no judgement: nobody documents a closing brace, so a reference that lands
// on one is wrong however you read the sentence around it. That is what makes it
// assertable where the STALE verdict is not.
//
// A RANGE counts only when EVERY line in it is vacuous. A range whose first line is a
// closing brace but which then covers real code is a reference to that code, and an
// earlier draft of this check that tested only the start line called two such
// references wrong. 13 references in the tree matched the loose rule and 6 matched the
// strict one; the difference was entirely ranges.
function checkVacuous() {
  const files = tracked();
  const index = buildIndex(files);
  const bad = [];
  for (const ref of collectRefs(files)) {
    const res = resolveTarget(index, ref.target, ref.source);
    if (res.ambiguous || res.missing) continue;   // checkBounds owns those
    const lines = linesOf(res.rel);
    if (!lines) continue;
    const span = lines.slice(ref.start - 1, ref.end);
    if (!span.length) continue;                   // out of bounds is checkBounds' call
    if (!isVacuousSpan(span)) continue;
    bad.push({
      ...ref,
      resolved: res.rel,
      where: `${ref.source}:${ref.sourceLine} -> ${ref.raw}`,
      reason: span.length === 1
        ? `${res.rel}:${ref.start} is ${span[0].trim() === '' ? 'a blank line' : `just ${span[0].trim()}`}`
        : `every line of ${res.rel}:${ref.start}-${ref.end} is blank or a bare closing brace`,
    });
  }
  return bad;
}

function checkBounds() {
  const files = tracked();
  const index = buildIndex(files);
  const broken = [];
  for (const ref of collectRefs(files)) {
    const res = resolveTarget(index, ref.target, ref.source);
    if (res.ambiguous) continue; // reported by the full run, not assertable here
    const where = `${ref.source}:${ref.sourceLine} -> ${ref.raw}`;
    if (res.missing) {
      broken.push({ ...ref, reason: `no tracked file matches ${ref.target}`, where });
      continue;
    }
    const lines = linesOf(res.rel);
    if (!lines) {
      broken.push({ ...ref, reason: `unreadable: ${res.rel}`, where });
      continue;
    }
    const count = lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    if (ref.start < 1 || ref.start > count || ref.end > count) {
      broken.push({
        ...ref,
        resolved: res.rel,
        reason: `cites line ${ref.start}-${ref.end} but ${res.rel} has ${count} lines`,
        where
      });
    }
  }
  return broken;
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const quiet = argv.includes('--quiet');
  const files = tracked();
  const index = buildIndex(files);
  const results = collectRefs(files).map((r) => judge(r, index));

  const counts = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  // Only BROKEN decides the exit code; see the verdict table at the top.
  const bad = results.filter((r) => r.verdict === 'BROKEN');

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          total: results.length,
          counts,
          results: results.map((r) => ({
            source: r.source,
            sourceLine: r.sourceLine,
            kind: r.kind,
            ref: r.raw,
            resolved: r.resolved || null,
            verdict: r.verdict,
            detail: r.detail,
            suggest: r.suggest || null
          }))
        },
        null,
        2
      ) + '\n'
    );
  } else if (!quiet) {
    const detail = argv.includes('--detail');
    for (const r of results) {
      if (r.verdict === 'OK') continue;
      process.stdout.write(`${r.verdict.padEnd(13)} ${r.source}:${r.sourceLine}  ->  ${r.raw}\n`);
      process.stdout.write(`              ${r.detail}\n`);
      if (detail && r.resolved) {
        const src = linesOf(r.source) || [];
        process.stdout.write(`              says    | ${(src[r.sourceLine - 1] || '').trim().slice(0, 150)}\n`);
        const lines = linesOf(r.resolved) || [];
        const show = (n, tag) => {
          const t = (lines[n - 1] || '').trim().slice(0, 110);
          process.stdout.write(`              ${tag} ${r.resolved}:${n}  ${t}\n`);
        };
        show(r.start, 'cited   ');
        for (const s of (r.suggest || []).slice(0, 3)) show(s, 'suggest ');
      }
    }
  }
  if (!asJson) {
    const order = ['OK', 'NEAR', 'STALE', 'BROKEN', 'UNVERIFIABLE'];
    const summary = order.filter((k) => counts[k]).map((k) => `${k} ${counts[k]}`).join(' | ');
    process.stdout.write(`\n${results.length} references: ${summary}\n`);
  }
  process.exitCode = bad.length ? 1 : 0;
}

if (require.main === module) main();

// test/line-refs.test.js is the only importer, and these three are what it takes.
// `judge`, `buildIndex`, `anchorsFrom`, `findAnchor`, `isStrong` and `flatten` were
// listed here as well and no file anywhere destructured one of them, so the list was
// advertising six functions through a door nobody had opened — the first caller to
// use one would also be the first to exercise it. The FUNCTIONS stay: main() calls
// every one of them, and removing an export entry is free while removing a function
// is not.
// stripRefs and anchorsFrom are exported for the regression test that pins the
// backtick-stripping bug. They are the smallest seam that can observe it: the
// symptom is an anchor going missing between those two calls, and nothing the
// CLI prints distinguishes "no anchor in the prose" from "the anchor was eaten".
module.exports = {
  collectRefs, tracked, checkBounds, checkVacuous, isVacuousSpan, stripRefs, anchorsFrom,
};
