'use strict';

// Windows file-holder stress: run test files many times in parallel while CPU burners and a
// stand-in scanner load the box, and keep every failing run's output.
//
//   node scripts/stress-windows-holders.js [options] test/<file>.test.js ...
//     --runs K       runs in total (default 20)
//     --workers W    runs at once (default 6)
//     --burners B    busy-loop processes beside them (default 6)
//     --hold MS      how long the scanner holds each new file open (default 10; 0 = no scanner,
//                    the control)
//     --prefix RE    hold only files under top-level directories of the private TEMP whose name
//                    matches RE (default: every one)
//     --name RE      passed to node --test as --test-name-pattern
//     --cwd DIR      where the test files are resolved (default: this checkout)
//     --out DIR      where fail-<n>.txt and scanner-stats.txt go (default: a new temp directory)
//   node scripts/stress-windows-holders.js --self-check
//     runs the scanner for about a second against a fresh private directory and confirms it held
//     a file it had not written; on Windows, also that a rename of the holding directory was
//     refused while it held, and landed once it let go. Exit 0 when it did, 1 otherwise.
//
// Exit 0 when every run passed, 1 when any failed (the summary line names the out dir), 2 on a
// bad argument.
//
// WHAT IT REPRODUCES. On Windows a rename is refused while anything holds a handle in its way,
// and Defender and the search indexer open a file milliseconds after it is written. Measured
// 2026-10-13 on Node 24.19.0 (597b4f7): renaming a DIRECTORY fails EPERM while any file inside it
// is open, even through Node's own read handle, which shares delete; replacing a FILE fails EPERM
// while the destination is open; creating a junction fails EBUSY while anything has the new
// directory open. A test that writes a fixture and renames or links its directory a few
// milliseconds later therefore fails some of the time on a real box and never on CI. CPU load and
// concurrency alone did not reproduce it (120 parallel runs of the two files, and 9 full suites 3
// at a time: 0 failures). The scanner here does: it keeps listing the fixture directories and
// opens each newly written (or rewritten) file ONCE, holding it for --hold ms, the way a scanner
// does a scan-on-write.
//
// THE NUMBERS IT PRODUCED (K = 60 runs per cell, 6 in parallel, 6 burners, private TEMP):
//   597b4f7  codex-reviewed-plans   10 ms 39 of 60 before, 0 after; 100 ms 60 of 60, 0
//            codex-memory-gates     10 ms 41 of 60 before, 0 after; 100 ms 60 of 60, 0
//   1d6b776  memory-lint-watchers   none 0 of 60; 10 ms 60 of 60 before, 0 of 60 and 0 of 180
//                                   after; 100 ms 60 of 60, 0
//            codex-memory           none 0 of 60; 10 ms 59 of 60 before, 0 of 60 and 0 of 180
//                                   after; 100 ms 60 of 60, 0
// "Before" is the test file with no retry, under the identical scanner; the "none" rows (no
// scanner) are the control that shows the holder is the whole cause. The fixes are the
// `whenReleased` / `linkDirectory` retries in those test files and `strictWrite`'s retry in
// src/codex-memory-gates.js; b4271f3 gave the recall model download's rename the same.
//
// THE PRIVATE TEMP IS NOT OPTIONAL. Every run, and the scanner, get TEMP, TMP and TMPDIR pointed
// at a fresh directory this script creates and deletes when it ends, and the scanner is handed
// that directory explicitly and walks nothing else. The first version of this harness scanned the
// shared %TEMP%, so it held the fixtures of OTHER worktrees' test runs on the same box and failed
// their tests (the engineering record's 1.6.2 clearance entry for 597b4f7 and 1d6b776). A harness
// that models a scanner is a scanner: point it only at files it owns.
//
// This is a tool for a developer's Windows box. It is not part of `node --test` (a run takes
// minutes and proves nothing off Windows) and not wired into CI. It writes nothing outside its
// private TEMP and its out dir, and never touches the user's home.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const USAGE = 'usage: node scripts/stress-windows-holders.js [--runs K] [--workers W] [--burners B] [--hold MS]'
  + ' [--prefix RE] [--name RE] [--cwd DIR] [--out DIR] <test files...> | --self-check';

function parseArgs(argv) {
  const opt = { runs: 20, workers: 6, burners: 6, hold: 10, prefix: '', name: null,
    cwd: path.resolve(__dirname, '..'), out: null, files: [], selfCheck: false, scanner: null };
  const number = (value, flag) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} needs a whole number, got ${value}`);
    return parsed;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--runs') opt.runs = number(value(), arg);
    else if (arg === '--workers') opt.workers = Math.max(1, number(value(), arg));
    else if (arg === '--burners') opt.burners = number(value(), arg);
    else if (arg === '--hold') opt.hold = number(value(), arg);
    else if (arg === '--prefix') opt.prefix = value();
    else if (arg === '--name') opt.name = value();
    else if (arg === '--cwd') opt.cwd = path.resolve(value());
    else if (arg === '--out') opt.out = path.resolve(value());
    else if (arg === '--self-check') opt.selfCheck = true;
    // Internal: the runner starts the scanner as a child of this same script.
    else if (arg === '--scanner') opt.scanner = { root: value(), hold: number(value(), arg), prefix: value(), stats: value() };
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else opt.files.push(arg);
  }
  new RegExp(opt.prefix); // fail here, not in a child, on a bad pattern
  return opt;
}

// ── the stand-in scanner ────────────────────────────────────────────────────────────
//
// Lists `root` (only `root`), walks each top-level directory whose name matches `prefix`, and
// opens every file it has not seen at this size and mtime once, read-only, closing it `hold` ms
// later. The walk is a busy loop on setImmediate, like a real-time scanner's queue, so a file is
// usually open within a millisecond or two of being written. `stats`, when given, is rewritten
// every 200 ms with the tick and open counts.
function runScanner({ root, hold, prefix, stats }) {
  const pattern = new RegExp(prefix);
  const seen = new Map();
  let ticks = 0;
  let opened = 0;
  const walk = (dir, depth, files) => {
    if (depth > 8) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1, files);
      else if (entry.isFile()) files.push(full);
    }
  };
  const tick = () => {
    ticks += 1;
    let tops = [];
    try { tops = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && pattern.test(entry.name)); }
    catch { /* the root is going away */ }
    const files = [];
    for (const top of tops) walk(path.join(root, top.name), 0, files);
    for (const file of files) {
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      const signature = `${stat.mtimeMs}:${stat.size}`;
      if (seen.get(file) === signature) continue;
      seen.set(file, signature);
      try {
        const fd = fs.openSync(file, 'r');
        opened += 1;
        setTimeout(() => { try { fs.closeSync(fd); } catch { /* already closed */ } }, hold);
      } catch { /* gone, or held by someone else */ }
    }
    if (seen.size > 200000) seen.clear();
    setImmediate(tick);
  };
  if (stats && stats !== '-') {
    setInterval(() => { try { fs.writeFileSync(stats, `ticks=${ticks} opened=${opened}\n`); } catch { /* out dir gone */ } }, 200);
  }
  tick();
}

function startScanner(root, hold, prefix, stats, env) {
  return spawn(process.execPath, [__filename, '--scanner', root, String(hold), prefix, stats || '-'],
    { stdio: 'ignore', windowsHide: true, env });
}

function readStats(file) {
  try {
    const match = /ticks=(\d+) opened=(\d+)/.exec(fs.readFileSync(file, 'utf8'));
    return match ? { ticks: Number(match[1]), opened: Number(match[2]) } : null;
  } catch { return null; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function removeTree(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); return true; }
  catch { return false; }
}

// ── the runner ──────────────────────────────────────────────────────────────────────
async function runStress(opt) {
  const out = opt.out || fs.mkdtempSync(path.join(os.tmpdir(), 'stress-holders-out-'));
  fs.mkdirSync(out, { recursive: true });
  // Short, so fixture paths stay under MAX_PATH.
  const privateTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'whs-'));
  const env = { ...process.env, TEMP: privateTemp, TMP: privateTemp, TMPDIR: privateTemp };
  const helpers = [];
  for (let i = 0; i < opt.burners; i += 1) {
    helpers.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true }));
  }
  const statsFile = path.join(out, 'scanner-stats.txt');
  // A reused --out keeps the last run's stats, which would read as this run's.
  try { fs.unlinkSync(statsFile); } catch { /* none yet */ }
  if (opt.hold > 0) helpers.push(startScanner(privateTemp, opt.hold, opt.prefix, statsFile, env));

  let started = 0;
  let failed = 0;
  const begun = Date.now();
  const runOne = (id) => new Promise((resolve) => {
    const args = ['--test', '--test-reporter=spec'];
    if (opt.name) args.push('--test-name-pattern', opt.name);
    args.push(...opt.files);
    const child = spawn(process.execPath, args, { cwd: opt.cwd, windowsHide: true, env });
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.stderr.on('data', (chunk) => { text += chunk; });
    child.on('close', (code) => {
      if (code !== 0) {
        failed += 1;
        fs.writeFileSync(path.join(out, `fail-${id}.txt`), text);
        const names = [...text.matchAll(/^\s*✖ (.+)$/gm)].map((match) => match[1]).slice(0, 6);
        process.stdout.write(`FAIL run ${id} exit ${code}: ${names.join(' | ')}\n`);
      }
      resolve();
    });
  });
  const worker = async () => {
    while (started < opt.runs) {
      started += 1;
      await runOne(started);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(opt.workers, Math.max(opt.runs, 1)) }, worker));
  } finally {
    for (const helper of helpers) { try { helper.kill(); } catch { /* already gone */ } }
    await sleep(500);
  }
  const gone = removeTree(privateTemp) && !fs.existsSync(privateTemp);
  const stats = readStats(statsFile);
  const seconds = ((Date.now() - begun) / 1000).toFixed(0);
  process.stdout.write(`DONE runs=${opt.runs} workers=${opt.workers} burners=${opt.burners} hold=${opt.hold}ms`
    + ` failed=${failed} secs=${seconds}${stats ? ` scanner ticks=${stats.ticks} opened=${stats.opened}` : ''}`
    + ` privateTempRemoved=${gone} out=${out}\n`);
  return failed ? 1 : 0;
}

// ── the self-check ──────────────────────────────────────────────────────────────────
//
// Two races are taken out on purpose, both measured 2026-10-13 while writing this. The
// scanner child takes a few hundred ms to start, so the check waits for its first stats
// line before writing anything. And a file the scanner meets while it is still being
// written is opened at size 0 and again once written, which moves the end of the hold; so
// the file is written under a directory the prefix does not match, and the directory is
// renamed to the matching name only once the file is whole. With no scanner of ours,
// the same write-then-rename was refused 0 times in 80 (delays of 0, 50, 200 and 500 ms), so
// a refusal here is the stand-in's and not Defender's.
async function selfCheck() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whs-self-check-'));
  const staging = path.join(root, 'staging');
  const fixture = path.join(root, 'fixture');
  const inner = path.join(fixture, 'store');
  const stats = path.join(root, 'stats.txt');
  const hold = 1000;
  const results = [];
  const scanner = startScanner(root, hold, '^fixture$', stats, process.env);
  const waitFor = async (predicate, ms) => {
    for (const until = Date.now() + ms; Date.now() < until; await sleep(25)) if (predicate()) return true;
    return predicate();
  };
  try {
    const running = await waitFor(() => readStats(stats)?.ticks >= 1, 5000);
    results.push(['the scanner started', running]);
    fs.mkdirSync(path.join(staging, 'store'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'store', 'MEMORY.md'), '# written by the self-check\n');
    const placed = await waitFor(() => {
      try { fs.renameSync(staging, fixture); return true; } catch { return false; }
    }, 2000);
    results.push(['the finished file was moved where the scanner looks', placed]);
    const held = placed && await waitFor(() => readStats(stats)?.opened >= 1, 3000);
    results.push(['the scanner opened the file it found', held]);
    if (process.platform === 'win32' && held) {
      let refused = null;
      try { fs.renameSync(inner, `${inner}-moved`); fs.renameSync(`${inner}-moved`, inner); }
      catch (error) { refused = error.code; }
      results.push([`renaming the directory was refused while it held (${refused || 'it was not'})`,
        refused === 'EPERM' || refused === 'EACCES' || refused === 'EBUSY']);
      const begun = Date.now();
      const landed = await waitFor(() => {
        try { fs.renameSync(inner, `${inner}-moved`); return true; } catch { return false; }
      }, hold * 3);
      results.push([`the rename landed once it let go (${landed ? `${Date.now() - begun} ms later` : `not in ${hold * 3} ms`})`,
        landed]);
    }
  } finally {
    try { scanner.kill(); } catch { /* already gone */ }
    await sleep(300);
    removeTree(root);
  }
  for (const [label, ok] of results) process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}\n`);
  if (process.platform !== 'win32') process.stdout.write('(not Windows: a held file does not block a rename here, so only the hold is checked)\n');
  return results.every(([, ok]) => ok) ? 0 : 1;
}

async function main(argv) {
  let opt;
  try { opt = parseArgs(argv); } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (opt.scanner) { runScanner(opt.scanner); return null; }
  if (opt.selfCheck) return selfCheck();
  if (!opt.files.length) { process.stderr.write(`${USAGE}\n`); return 2; }
  return runStress(opt);
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { if (code !== null) process.exit(code); });
