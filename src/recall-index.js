'use strict';

// Recall vector-cache bookkeeping, shared by the extension and its tests.
//
// recall.py owns the cache; this module only answers "is it behind the files?"
// so the extension can decide whether spawning python is worth it. recall.py's
// build_or_update() stays the authority, and every predicate here mirrors the
// comparison it makes (name set, size, mtime, embed identity) so the two agree
// on what "current" means. Drift tests pin all three shared constants: two by
// importing them, and the mtime tolerance by reading recall.py's source for the
// unit it writes, since the tolerance is an arithmetic assumption about that unit
// rather than a value the two sides exchange.
//
// The rule that is easy to get wrong: MEMORY.md is the always-loaded index, and
// recall.py excludes it from the corpus. Counting it as an indexable file makes
// a complete cache read one short forever, which silently converts a staleness
// check into a full re-embed of every memory on every tick.

const fs = require('fs');
const path = require('path');

const MEMORY_INDEX_NAME = 'MEMORY.md';       // recall.py EXCLUDE
const RECALL_EMBED_ID = 'bge-small-onnx';    // recall.py EMBED_ID
const RECALL_INDEX_NAME = 'recall_index.json';
// Python writes st_mtime as float seconds and Node reads mtimeMs; measured on a
// real store the two agree to ~0.0002ms, so 1ms is slack for the float
// round-trip without being loose enough to miss an edit.
const MTIME_TOLERANCE_MS = 1;

// The files recall.py would embed: every .md in the dir except the index itself.
// null when the dir cannot be read — there is nothing to say about it then.
function indexableMemories(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.md') && name !== MEMORY_INDEX_NAME)
      .sort();
  } catch { return null; }
}

// One memoised read of recall_index.json, keyed on the file's own `mtimeMs:size`.
//
// The dashboard pushes this on every refresh and the file is not small: 1.20 MB on the
// live store, 4.62 min / 6.14 p50 ms to read and parse (n=40, warm, real ~/.claude), which
// is the largest single fs term in the whole push. A statSync of the same file is
// 0.035/0.045 ms. recall.py rewrites the index through a pid-suffixed temp plus
// os.replace, so every rewrite lands a new mtime.
//
// This cannot produce a false "not stale", which is the one outcome the staleness check
// exists to prevent and the reason the per-memory statSync in recallIndexStatus below (one
// each, 136 on the live store) are NOT removed. Those still run on every call; only the CACHE side
// of the comparison is memoised. Measured on this box, NTFS mtime granularity is ~0.5 ms
// (191 distinct stamps over 200 back-to-back same-size rewrites; mtimeNs gives no extra
// resolution, so `{ bigint: true }` would buy nothing). So the residual risk is an index
// rewritten to an identical SIZE inside one 0.5 ms tick — and even then the stale half is
// the cache, whose older entries mismatch the newer files and report `stale: true`. A
// spurious incremental `--list`, self-healing on the next write. The dangerous direction
// needs the file on disk to go BACKWARDS in content, which nothing writes.
//
// What is kept is a projection, not the parsed object: `vec` is 384 floats per memory and
// no caller here reads it. Measured on the live index (136 entries, 10 retained copies
// divided, two forced GCs either side): the whole parse holds 486 KB, the projection 16 KB.
// Both are for the life of the window, which is why the 470 KB is worth four lines.
let indexCache = { file: null, key: null, value: null };

// The parsed cache, or null when it is absent, unreadable, or not a cache.
function readRecallIndex(dir) {
  const file = path.join(dir, RECALL_INDEX_NAME);
  let key = null;
  try {
    const stats = fs.statSync(file);
    key = `${stats.mtimeMs}:${stats.size}`;
    if (indexCache.file === file && indexCache.key === key) return indexCache.value;
  } catch {
    // No stat means no file to key on. Drop what was held for THIS file and fall through
    // to the read, which answers null the same way it always did. Scoped to this file
    // because a second store's index going missing must not evict the one that is fine.
    if (indexCache.file === file) indexCache = { file: null, key: null, value: null };
  }
  let value = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && parsed.files && typeof parsed.files === 'object') {
      const files = {};
      for (const [name, entry] of Object.entries(parsed.files)) {
        files[name] = entry && typeof entry === 'object'
          ? { mtime: entry.mtime, size: entry.size }
          : entry;
      }
      value = { embed: parsed.embed, files };
    }
  } catch { value = null; }
  // A corrupt or absent-`files` cache is memoised too, on the same key: re-parsing 1.2 MB
  // of broken JSON on every push to reach the same null is the case this exists to stop.
  if (key !== null) indexCache = { file, key, value };
  return value;
}

// How many memories are in the cache; null when it has not been built yet.
function recallIndexCount(dir) {
  const index = readRecallIndex(dir);
  return index ? Object.keys(index.files).length : null;
}

function entryMatchesFile(entry, stats) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.size !== stats.size) return false;
  return Math.abs(Number(entry.mtime) * 1000 - stats.mtimeMs) <= MTIME_TOLERANCE_MS;
}

// Is the cache behind the corpus? A count comparison alone cannot see an
// in-place edit (count unchanged) or a deletion (count moves the wrong way), so
// both used to slip past: the feature looked like it worked because a separate
// off-by-one kept it firing anyway.
function recallIndexStatus(dir) {
  const indexable = indexableMemories(dir);
  if (indexable == null) {
    return { indexable: null, embedded: null, stale: false, reason: 'unreadable-dir' };
  }
  const index = readRecallIndex(dir);
  if (!index) {
    return {
      indexable: indexable.length, embedded: null,
      stale: indexable.length > 0, reason: 'no-cache',
    };
  }
  const embedded = Object.keys(index.files).length;
  const base = { indexable: indexable.length, embedded, stale: false, reason: 'current' };
  // recall.py discards the whole cache when the embedder identity changed, so a
  // mismatch is pending work however well the per-file stats line up.
  if (index.embed !== RECALL_EMBED_ID) return { ...base, stale: true, reason: 'embed-id-changed' };
  if (embedded !== indexable.length) return { ...base, stale: true, reason: 'count-mismatch' };
  for (const name of indexable) {
    const entry = index.files[name];
    if (!entry) return { ...base, stale: true, reason: 'missing-entry' };
    let stats;
    try { stats = fs.statSync(path.join(dir, name)); }
    catch { return { ...base, stale: true, reason: 'unreadable-file' }; }
    if (!entryMatchesFile(entry, stats)) return { ...base, stale: true, reason: 'file-changed' };
  }
  return base;
}

// `readRecallIndex` is deliberately NOT exported: recallIndexCount and recallIndexStatus
// are its only callers and both live in this file.
//
// `MTIME_TOLERANCE_MS` is not exported either, and no longer needs to be. It was held on
// the dead-export list for a branch in flight that was going to import it; that branch has
// landed, as the 'recall.py still writes mtime as float SECONDS' test, and it pins the
// constant by reading recall.py's source rather than by requiring this name. The constant
// and its use in entryMatchesFile stay — only the export entry goes.
module.exports = {
  MEMORY_INDEX_NAME, RECALL_EMBED_ID, RECALL_INDEX_NAME,
  indexableMemories, recallIndexCount, recallIndexStatus,
};
