'use strict';

// CODEX COMPRESSES ITS IDLE ROLLOUTS IN PLACE, AND A COMPRESSED ONE IS STILL A TRANSCRIPT.
//
// MEASURED 2026-10-16 on the development box: nine of seventeen rollouts had
// become `rollout-<ts>-<uuid>.jsonl.zst`, in `sessions/YYYY/MM/DD/` and in
// `archived_sessions/`. Every one is a single zstd frame whose header declares
// its decompressed size, Codex's `state_5.sqlite` goes on naming the `.jsonl`,
// and the history store's cursor equals the DECOMPRESSED size for all nine. The
// reader took `.jsonl` only, so the five compressed live threads read as orphans
// and the dashboard said "scan degraded" for good.
//
// Two facts about Node's decoder shape the reader, both MEASURED the same day on
// 24.19.0: `zstdDecompressSync` returns only the FIRST frame of a multi-frame
// file, and returns a short buffer, without an error, for a file cut in half.
// So the frames are walked from their headers first, and only complete ones are
// decompressed. The tests for both are below.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { scanHistoryFiles, parseCodexJsonl, cursorKeyForFile, codexHistoryStoreState } = require('../src/history-adapters');
const { createAutoLearnManager } = require('../src/auto-learn-manager');

// Node added zstd in v23.8.0 / v22.15.0, so CI's Node 20 leg has none. The tests
// that need the decoder say so when they skip; the walk, the probe and the
// refusals use frames built by hand and run everywhere.
const ZSTD = typeof zlib.zstdDecompressSync === 'function' && typeof zlib.zstdCompressSync === 'function';
if (!ZSTD) {
  process.stderr.write(`\n[codex-compressed-rollouts] SKIPPING the decoder tests: no zstd on ${process.version}. `
    + 'Only the frame walk, the probe and the refusals were exercised in this run.\n\n');
}
let SqliteDatabase = null;
try {
  const sqlite = require('node:sqlite');
  SqliteDatabase = typeof sqlite.Database === 'function' ? sqlite.Database : sqlite.DatabaseSync;
} catch { SqliteDatabase = null; }
const SQLITE = typeof SqliteDatabase === 'function';

const THREAD = '0192aaaa-1111-7000-8000-00000000ac01';
const OTHER = '0192aaaa-1111-7000-8000-00000000ac02';

function jsonl(...records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

// A rollout: the head record, then one shell call per command. `null` as an id
// writes a call with no call id at all, whose identity is a hash that includes
// the transcript's NAME, which is the identity compression could move.
function rolloutText(thread, calls, padding = 0) {
  const records = [{ type: 'session_meta', payload: { id: thread, cwd: 'C:\\w' } }];
  for (const [id, command] of calls) {
    records.push({ type: 'response_item', payload: {
      type: 'function_call', name: 'shell_command', ...(id ? { call_id: id } : {}),
      arguments: JSON.stringify({ command, pad: 'p'.repeat(padding) }),
    } });
    if (id) {
      records.push({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: { exit_code: 0 } } });
    }
  }
  return Buffer.from(jsonl(...records));
}

// A zstd frame built by hand from raw blocks (RFC 8878 section 3.1.1): needs no
// compressor, so it runs on a Node without zstd. `declare` writes the content
// size into the header the way Codex's frames carry it; without it the header
// has a window descriptor instead (2 MiB).
function rawFrame(bytes, { declare = true } = {}) {
  const parts = [Buffer.from([0x28, 0xB5, 0x2F, 0xFD])];
  if (declare) {
    const header = Buffer.alloc(5);
    header[0] = 0xA0; // Single_Segment, a 4-byte Frame_Content_Size
    header.writeUInt32LE(bytes.length, 1);
    parts.push(header);
  } else {
    parts.push(Buffer.from([0x00, 0x58]));
  }
  let at = 0;
  do {
    const size = Math.min(128 * 1024, bytes.length - at);
    const header = (size << 3) | (at + size >= bytes.length ? 1 : 0);
    parts.push(Buffer.from([header & 0xff, (header >> 8) & 0xff, (header >> 16) & 0xff]), bytes.subarray(at, at + size));
    at += size;
  } while (at < bytes.length);
  return Buffer.concat(parts);
}

// One RLE block: `count` copies of one byte, stored in thirteen bytes. The file
// is far smaller than what it declares, which is the shape of every real
// compressed rollout, and the one the projection check has to get right.
function rleFrame(count) {
  const header = (count << 3) | (1 << 1) | 1;
  const descriptor = Buffer.alloc(5);
  descriptor[0] = 0xA0;
  descriptor.writeUInt32LE(count, 1);
  return Buffer.concat([Buffer.from([0x28, 0xB5, 0x2F, 0xFD]), descriptor,
    Buffer.from([header & 0xff, (header >> 8) & 0xff, (header >> 16) & 0xff, 0x78])]);
}

function codexHome(t, label) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `acolyte-zst-${label}-`));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const day = path.join(home, '.codex', 'sessions', '2026', '10', '01');
  fs.mkdirSync(day, { recursive: true });
  return { home, day, sessions: path.join(home, '.codex', 'sessions'), plain: path.join(day, `rollout-2026-10-01T09-00-00-${THREAD}.jsonl`) };
}

function scan(roots, extra = {}) {
  return scanHistoryFiles({ roots: roots.map((root) => ({ path: root, source: 'codex' })), ...extra });
}

const view = (observations) => observations.map((o) => ({ id: o.id, command: o.command, status: o.status, session: o.session }))
  .sort((a, b) => a.id.localeCompare(b.id));

test('the hand-built frames are real zstd', { skip: !ZSTD }, () => {
  const text = rolloutText(THREAD, [['c1', 'git status']], 200 * 1024);
  assert.deepEqual(zlib.zstdDecompressSync(rawFrame(text)), text);
  assert.deepEqual(zlib.zstdDecompressSync(rawFrame(text, { declare: false })), text);
  assert.equal(zlib.zstdDecompressSync(rleFrame(1000)).toString(), 'x'.repeat(1000));
});

test('a compressed rollout reads exactly as its plain form did, call identities included', { skip: !ZSTD }, (t) => {
  const f = codexHome(t, 'same');
  const text = rolloutText(THREAD, [['c1', 'git status'], ['c2', 'git log --oneline'], [null, 'npm test']]);
  fs.writeFileSync(f.plain, text);
  const before = scan([f.sessions]);
  assert.equal(before.observations.length, 3, 'precondition: three calls, one without a call id');

  fs.writeFileSync(`${f.plain}.zst`, zlib.zstdCompressSync(text));
  fs.rmSync(f.plain);
  const after = scan([f.sessions]);
  assert.deepEqual(after.files.map((file) => [file.mode, file.compressed]), [['full', true]]);
  assert.deepEqual(view(after.observations), view(before.observations),
    'witness:compressed-identity -- the compressed rollout came back with different calls or identities');
  assert.equal(after.files[0].size, text.length, 'the reported size is the decompressed one, the space cursors are in');

  // The control that the name is load-bearing: the call with no call id hashes
  // the transcript name into its identity, so parsing under the `.zst` name
  // would have filed it under a second id and counted it again.
  const underZst = parseCodexJsonl(text, { file: `${f.plain}.zst` }).find((o) => o.command === 'npm test');
  const asPlain = before.observations.find((o) => o.command === 'npm test');
  assert.notEqual(underZst.id, asPlain.id);
});

test('an unchanged compressed rollout is not decompressed again', { skip: !ZSTD }, (t) => {
  const f = codexHome(t, 'unchanged');
  const file = `${f.plain}.zst`;
  fs.writeFileSync(file, zlib.zstdCompressSync(rolloutText(THREAD, [['c1', 'git status']])));
  let calls = 0;
  const zstdDecompress = (...args) => { calls += 1; return zlib.zstdDecompressSync(...args); };

  const first = scan([f.sessions], { zstdDecompress });
  assert.equal(calls, 1);
  const second = scan([f.sessions], { zstdDecompress, cursors: first.cursors });
  assert.equal(calls, 1, 'witness:compressed-fast-path -- an unchanged compressed rollout was decompressed on every scan');
  assert.deepEqual(second.files.map((entry) => [entry.mode, entry.bytesRead, entry.compressed]), [['unchanged', 0, true]]);
  assert.deepEqual(second.cursors, first.cursors);

  // The control: a new mtime is not proof of anything, so the bytes are judged.
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(file, later, later);
  const touched = scan([f.sessions], { zstdDecompress, cursors: second.cursors });
  assert.equal(calls, 2);
  assert.equal(touched.files[0].mode, 'unchanged', 'the same bytes under a new mtime are still unchanged');
  assert.equal(touched.observations.length, 0);
});

test('a compressed rollout past the ingest cap catches up over scans and loses nothing', { skip: !ZSTD }, (t) => {
  const f = codexHome(t, 'catch-up');
  const calls = Array.from({ length: 120 }, (_, index) => [`c${index}`, `echo ${index}`]);
  const text = rolloutText(THREAD, calls, 400);
  fs.writeFileSync(`${f.plain}.zst`, zlib.zstdCompressSync(text));
  const whole = scan([f.sessions], { ingestBytes: 0 });
  assert.equal(whole.observations.length, 120);

  let cursors = {};
  const seen = new Map();
  const modes = [];
  for (let round = 0; round < 40; round += 1) {
    const result = scan([f.sessions], { cursors, ingestBytes: 16 * 1024, overlapBytes: 1024 });
    cursors = result.cursors;
    modes.push(result.files[0].mode);
    for (const observation of result.observations) seen.set(observation.id, observation);
    if (result.files[0].mode === 'unchanged') break;
  }
  assert.ok(modes.includes('partial') && modes.includes('append'), `the cap never applied: ${modes.join(', ')}`);
  assert.equal(modes.at(-1), 'unchanged', 'the catch-up never finished');
  assert.deepEqual(view([...seen.values()]), view(whole.observations),
    'witness:compressed-catch-up -- a capped compressed read lost or re-identified calls');
  assert.ok([...seen.values()].every((o) => o.session === THREAD),
    'an append slice of a compressed rollout lost its head seed');
});

test('a runtime with no zstd skips a compressed rollout, says why, and keeps its cursor', (t) => {
  const f = codexHome(t, 'no-zstd');
  const file = `${f.plain}.zst`;
  const text = rolloutText(THREAD, [['c1', 'git status']]);
  fs.writeFileSync(file, rawFrame(text));
  const prior = { source: 'codex', size: 10, offset: 10, mtimeMs: 1, headLength: 10, headHash: 'a', tailStart: 0, tailLength: 10, tailHash: 'b' };
  const key = cursorKeyForFile(file);

  const result = scan([f.sessions], { zstdDecompress: null, cursors: { [key]: prior } });
  assert.deepEqual(result.files, [{
    path: path.resolve(file), source: 'codex', mode: 'skipped', reason: 'zstd-unavailable',
    size: text.length, bytesRead: 0, compressed: true,
  }], 'witness:compressed-unsupported -- a runtime without zstd reported something other than a skip');
  assert.equal(result.observations.length, 0);
  assert.deepEqual(result.cursors, { [key]: prior },
    'a cursor this runtime cannot check was dropped, so a runtime that can would start over');
});

test('a compressed rollout past the ceiling is refused, before or after decompressing', (t) => {
  const f = codexHome(t, 'ceiling');
  const file = `${f.plain}.zst`;
  fs.writeFileSync(file, rawFrame(rolloutText(THREAD, [['c1', 'git status']], 4096)));
  // Larger than the ceiling on disk: refused unread, so the decoder is never reached.
  const refused = scan([f.sessions], {
    compressedMaxBytes: 1024, zstdDecompress: () => { throw new Error('the decoder was reached'); },
  });
  assert.deepEqual(refused.files.map((entry) => [entry.mode, entry.reason]), [['skipped', 'too-large']]);
});

test('a compressed rollout that decompresses past the ceiling is refused, and one within it is read', { skip: !ZSTD }, (t) => {
  const f = codexHome(t, 'ceiling-decoded');
  const text = rolloutText(THREAD, Array.from({ length: 40 }, (_, index) => [`c${index}`, 'git status']), 4096);
  const packed = zlib.zstdCompressSync(text);
  fs.writeFileSync(`${f.plain}.zst`, packed);
  assert.ok(packed.length < 8192 && text.length > 100 * 1024, 'precondition: small on disk, large decompressed');
  const over = scan([f.sessions], { compressedMaxBytes: 64 * 1024 });
  assert.deepEqual(over.files.map((entry) => [entry.mode, entry.reason]), [['skipped', 'too-large']]);
  const within = scan([f.sessions], { compressedMaxBytes: 1024 * 1024 });
  assert.equal(within.files[0].mode, 'full');
  assert.equal(within.observations.length, 40);
});

test('a truncated compressed rollout is an unreadable file, never a short read', { skip: !ZSTD }, (t) => {
  const f = codexHome(t, 'truncated');
  const calls = Array.from({ length: 30 }, (_, index) => [`c${index}`, `echo ${index}`]);
  const packed = zlib.zstdCompressSync(rolloutText(THREAD, calls, 2048));
  fs.writeFileSync(`${f.plain}.zst`, packed.subarray(0, Math.floor(packed.length / 2)));
  const cut = scan([f.sessions]);
  assert.equal(cut.files[0].mode, 'error',
    'witness:compressed-truncated -- a file cut in half read as a whole, shorter transcript');
  assert.match(cut.files[0].error, /truncated or is not zstd/);
  assert.equal(cut.observations.length, 0);
  assert.deepEqual(cut.cursors, {}, 'a cursor recorded over the short read would skip the rest for good');

  // The control: the whole file reads.
  fs.writeFileSync(`${f.plain}.zst`, packed);
  assert.equal(scan([f.sessions]).observations.length, 30);
});

test('every frame of a multi-frame rollout is read', { skip: !ZSTD }, (t) => {
  const f = codexHome(t, 'frames');
  const head = rolloutText(THREAD, [['c1', 'git status']]);
  const tail = Buffer.from(jsonl(
    { type: 'response_item', payload: { type: 'function_call', name: 'shell_command', call_id: 'c2', arguments: JSON.stringify({ command: 'git diff' }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: { exit_code: 0 } } },
  ));
  fs.writeFileSync(`${f.plain}.zst`, Buffer.concat([zlib.zstdCompressSync(head), rawFrame(tail, { declare: false })]));
  const result = scan([f.sessions]);
  assert.deepEqual(result.observations.map((o) => o.command).sort(), ['git diff', 'git status'],
    'witness:compressed-frames -- only the first frame of the file was read');
  assert.equal(result.files[0].size, head.length + tail.length);
  assert.ok(result.observations.every((o) => o.session === THREAD));
});

test('a plain rollout and its compressed twin are read once, from the plain one', (t) => {
  const f = codexHome(t, 'twin');
  const text = rolloutText(THREAD, [['c1', 'git status']]);
  fs.writeFileSync(f.plain, text);
  // Half a frame: what a twin still being written can look like. Never read.
  fs.writeFileSync(`${f.plain}.zst`, rawFrame(text).subarray(0, 12));
  const result = scan([f.sessions]);
  assert.deepEqual(result.files.map((entry) => [path.basename(entry.path), entry.mode]),
    [[path.basename(f.plain), 'full']], 'witness:compressed-twin -- a rollout and its compressed twin were both read');
  assert.equal(result.observations.length, 1);
});

// ---------------------------------------------------------------------------
// The history-store check.

function sessionIndex(home, ids) {
  fs.writeFileSync(path.join(home, '.codex', 'session_index.jsonl'),
    `${ids.map((id) => JSON.stringify({ id, thread_name: 'fixture' })).join('\n')}\n`);
}

test('a compressed rollout is a transcript to the history-store check, live or archived', (t) => {
  const f = codexHome(t, 'probe');
  fs.writeFileSync(`${f.plain}.zst`, rawFrame(rolloutText(THREAD, [])));
  const archived = path.join(f.home, '.codex', 'archived_sessions');
  fs.mkdirSync(archived);
  fs.writeFileSync(path.join(archived, `rollout-2026-10-01T10-00-00-${OTHER}.jsonl.zst`), rawFrame(rolloutText(OTHER, [])));
  sessionIndex(f.home, [THREAD, OTHER]);

  const state = codexHistoryStoreState({ home: f.home });
  assert.equal(state.stale, false,
    `witness:compressed-orphans -- compressed rollouts read as threads with no transcript: ${state.reasons.join(' ')}`);
  assert.equal(state.rolloutFiles, 2);
  assert.equal(state.archivedFiles, 1);

  // The control: with the compressed file gone, the thread is an orphan again.
  fs.rmSync(`${f.plain}.zst`);
  const gone = codexHistoryStoreState({ home: f.home });
  assert.equal(gone.stale, true);
  assert.deepEqual(gone.orphans, [THREAD]);
});

function threadStore(home, offsets) {
  const db = new SqliteDatabase(path.join(home, '.codex', 'thread_history_1.sqlite'));
  db.exec(`CREATE TABLE thread_history_projection_state (
    thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER NOT NULL, next_rollout_ordinal INTEGER NOT NULL )`);
  const insert = db.prepare('INSERT INTO thread_history_projection_state VALUES (?, ?, 1)');
  for (const [id, offset] of Object.entries(offsets)) insert.run(id, offset);
  db.close();
}

test('the store cursor into a compressed rollout is compared with its decompressed length', { skip: !SQLITE }, (t) => {
  const f = codexHome(t, 'projection');
  const file = `${f.plain}.zst`;
  fs.writeFileSync(file, rleFrame(5000));
  assert.ok(fs.statSync(file).size < 5000, 'precondition: smaller on disk than decompressed, as every real one is');
  sessionIndex(f.home, [THREAD]);
  threadStore(f.home, { [THREAD]: 5000 });
  assert.deepEqual(codexHistoryStoreState({ home: f.home }).projectionAhead, [],
    'witness:compressed-projection -- a cursor equal to the decompressed size read as a store ahead of its file');
});

test('control: a store cursor past a compressed rollout\'s decompressed end is still ahead', { skip: !SQLITE || !ZSTD }, (t) => {
  const f = codexHome(t, 'projection-ahead');
  fs.writeFileSync(`${f.plain}.zst`, rleFrame(5000));
  sessionIndex(f.home, [THREAD]);
  threadStore(f.home, { [THREAD]: 5001 });
  assert.deepEqual(codexHistoryStoreState({ home: f.home }).projectionAhead, [THREAD]);
});

test('a multi-frame rollout is measured whole, not by the first frame its header declares', { skip: !SQLITE || !ZSTD }, (t) => {
  const f = codexHome(t, 'projection-frames');
  fs.writeFileSync(`${f.plain}.zst`, Buffer.concat([rleFrame(3000), rleFrame(2000)]));
  sessionIndex(f.home, [THREAD]);
  threadStore(f.home, { [THREAD]: 5000 });
  assert.deepEqual(codexHistoryStoreState({ home: f.home }).projectionAhead, [],
    'witness:compressed-projection-frames -- the first frame\'s declared size was taken as the whole file');
  // The control: one byte past the whole is still ahead.
  fs.rmSync(path.join(f.home, '.codex', 'thread_history_1.sqlite'));
  threadStore(f.home, { [THREAD]: 5001 });
  assert.deepEqual(codexHistoryStoreState({ home: f.home }).projectionAhead, [THREAD]);
});

test('a state row naming the .jsonl of a transcript Codex compressed elsewhere is relocated, not an orphan', { skip: !SQLITE }, (t) => {
  const f = codexHome(t, 'relocated');
  const elsewhere = path.join(f.home, '.codex', 'elsewhere');
  fs.mkdirSync(elsewhere);
  const recorded = path.join(elsewhere, `rollout-2026-10-01T09-00-00-${THREAD}.jsonl`);
  fs.writeFileSync(`${recorded}.zst`, rawFrame(rolloutText(THREAD, [])));
  sessionIndex(f.home, [THREAD]);
  const db = new SqliteDatabase(path.join(f.home, '.codex', 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0)');
  db.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(THREAD, recorded);
  db.close();

  const state = codexHistoryStoreState({ home: f.home });
  assert.deepEqual(state.relocated, [THREAD],
    'witness:compressed-relocated -- the .zst beside the recorded .jsonl was not taken as the recorded file');
  assert.deepEqual(state.orphans, []);
  fs.rmSync(`${recorded}.zst`);
  assert.deepEqual(codexHistoryStoreState({ home: f.home }).orphans, [THREAD], 'control: with nothing there it is an orphan');
});

// ---------------------------------------------------------------------------
// The manager.

function manager(home, extra = {}) {
  return createAutoLearnManager({
    home, claudeRoots: [path.join(home, '.claude', 'projects')], codexRulesPath: null,
    codexHistoryStore: () => ({ stale: false, inspected: 'exact', reasons: [], notes: [] }),
    ...extra,
  });
}

test('Codex compressing a rollout the manager has counted does not count it again', { skip: !ZSTD }, (t) => {
  const f = codexHome(t, 'manager-recount');
  const text = rolloutText(THREAD, [['c1', 'git status'], ['c2', 'git status --short'], [null, 'git status -s']]);
  fs.writeFileSync(f.plain, text);
  const first = manager(f.home).scan({ platform: 'win32' });
  // Two, not three: the call with no call id has no result to match, and an
  // unanswered call is not execution evidence (the manager's scan loop).
  assert.equal(first.newObservations, 2);
  const success = () => Object.values(JSON.parse(fs.readFileSync(manager(f.home).paths.state, 'utf8')).candidates)
    .reduce((total, item) => total + item.counts.success, 0);
  const before = success();

  fs.writeFileSync(`${f.plain}.zst`, zlib.zstdCompressSync(text));
  fs.rmSync(f.plain);
  const compressed = manager(f.home).scan({ platform: 'win32' });
  assert.equal(compressed.newObservations, 0,
    'witness:compressed-recount -- the compressed rollout\'s calls were counted a second time');
  assert.equal(success(), before, 'counts.success, which gates auto-safe apply, was inflated by the compression');
  assert.equal(compressed.errors, 0);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(manager(f.home).paths.state, 'utf8')).cursors).length, 1,
    'one transcript, one cursor: the plain path must not keep one');
});

test('compressed rollouts not read are counted by why, survive a reload, and are not errors', (t) => {
  const f = codexHome(t, 'manager-counts');
  fs.writeFileSync(`${f.plain}.zst`, rawFrame(rolloutText(THREAD, [['c1', 'git status']])));
  const big = path.join(f.day, `rollout-2026-10-01T10-00-00-${OTHER}.jsonl.zst`);
  fs.writeFileSync(big, rawFrame(rolloutText(OTHER, [['c2', 'git status']], 8192)));
  const historyScanner = (options) => scanHistoryFiles({ ...options, zstdDecompress: null });
  const result = manager(f.home, { historyScanner }).scan();
  assert.equal(result.compressedUnsupported, 2);
  assert.equal(result.errors, 0);
  const reloaded = manager(f.home).status().lastScanStats;
  assert.equal(reloaded.compressedUnsupported, 2,
    'witness:compressed-reload -- the count the panel phrases its note from did not survive a reload');
  assert.equal(reloaded.compressedOversize, 0);

  // Past the ceiling is the other reason, counted apart.
  const ceiling = (options) => scanHistoryFiles({ ...options, compressedMaxBytes: 4096, zstdDecompress: () => Buffer.alloc(0) });
  const oversize = manager(f.home, { historyScanner: ceiling }).scan();
  assert.equal(oversize.compressedOversize, 1);
  assert.equal(manager(f.home).status().lastScanStats.compressedOversize, 1);
});
