'use strict';
// SUMMARY OF A SPAWN TIMING CAPTURE (committed 2026-10-20).
//
//   usage: node scripts/measure/spawn-capture-summary.js <dir> [<dir> ...]
//
// Each <dir> is a CAPTURE_DIR written by scripts/measure/spawn-capture.js, or a run directory
// holding one as `cap/`. Over every directory given, it prints n, min, p50, p90 and max of:
//   - how long spawn()/execFile() held its thread, for a node child, a cmd.exe or .cmd child,
//     and anything else (codex.exe, taskkill);
//   - for a node child, how long after its spawn() returned its own `start` line was written
//     (the child's JS running), matched by pid and kept when under 10 s.
// p50 is the element at floor(n/2) of the sorted values and p90 at floor(0.9n). Given the three
// captured runs of `d4e977d`, this printed the figures in docs/engineering-record.md ("Spawn
// timing under load", the capture paragraph). It reads files only. This is the script that
// printed them, with comments and argument handling added and its arithmetic unchanged.

const fs = require('fs');
const path = require('path');

const given = process.argv.slice(2);
if (!given.length) {
  console.error('usage: node scripts/measure/spawn-capture-summary.js <dir> [<dir> ...]');
  process.exit(2);
}
const held = { node: [], cmd: [], other: [] };
const start = [];
for (const run of given) {
  const dir = fs.existsSync(path.join(run, 'cap')) ? path.join(run, 'cap') : run;
  const ev = [];
  for (const n of fs.readdirSync(dir)) for (const l of fs.readFileSync(path.join(dir, n), 'utf8').split('\n')) if (l) try { ev.push(JSON.parse(l)); } catch {}
  ev.sort((a, b) => a.at - b.at);
  const starts = ev.filter((e) => e.ev === 'start' && e.tid === 0);
  for (const s of ev.filter((e) => e.ev === 'spawned')) {
    const k = /node(\.exe)?$/i.test(s.file) ? 'node' : /cmd\.exe$|\.cmd$/i.test(s.file) ? 'cmd' : 'other';
    held[k].push(s.held);
    if (k === 'node') {
      const p = starts.find((x) => x.pid === s.child && x.at >= s.at - 2000);
      if (p && p.at - s.at < 10000) start.push(p.at - s.at);
    }
  }
}
const st = (a) => {
  a = [...a].sort((x, y) => x - y);
  return `n=${a.length} min=${a[0]} p50=${a[Math.floor(a.length / 2)]} p90=${a[Math.floor(a.length * 0.9)]} max=${a.at(-1)}`;
};
console.log('spawn() held, node child:', st(held.node));
console.log('spawn() held, cmd.exe:', st(held.cmd));
console.log('spawn() held, other (codex.exe, taskkill):', st(held.other));
console.log('node child JS running after spawn() returned:', st(start));
