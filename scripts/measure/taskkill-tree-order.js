'use strict';
// IN WHICH ORDER DOES taskkill /T END A TREE? (Windows only; committed 2026-10-20.)
//
//   usage: node scripts/measure/taskkill-tree-order.js [rounds, default 10]
//
// Each round starts its own three-process tree and nothing else: a node root, which spawns a
// cmd.exe, which runs a node that writes its pid and waits. The root writes a mark file the
// moment its child's 'exit' arrives. Once the leaf is up, `taskkill /PID <root> /T /F` (System32's)
// ends the tree, and the round prints the PIDs in the order taskkill reported ending them and
// whether the root saw its child die before it died itself. Rounds run one after another; it
// adds no load beyond the tree it observes, and removes its temporary directory at the end.
//
// docs/engineering-record.md ("Spawn timing under load", the tree-kill row) quotes it: unloaded,
// taskkill ended the root last in 10 of 10 trees, which is how a worker could see its cmd.exe
// die and answer before the kill reached it. This is the script that measured it, with comments
// and the platform check added, its logic unchanged.

if (process.platform !== 'win32') {
  console.error('taskkill-tree-order.js measures Windows taskkill; nothing to do on ' + process.platform);
  process.exit(2);
}
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rounds = Number(process.argv[2] || 10);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treeorder-'));
const taskkill = path.join(process.env.SystemRoot, 'System32', 'taskkill.exe');
const hang = path.join(dir, 'hang.js');
fs.writeFileSync(hang, `require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n`);
const shim = path.join(dir, 'hang.cmd');
fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${hang}" %*\r\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let saw = 0;
  for (let i = 0; i < rounds; i += 1) {
    const mark = path.join(dir, `saw-${i}`);
    const pidFile = path.join(dir, `pid-${i}`);
    const root = spawn(process.execPath, ['-e', `
      const c = require('child_process').spawn(process.env.ComSpec, ['/d', '/s', '/c', '"' + ${JSON.stringify(shim)} + '" ' + ${JSON.stringify(pidFile)}], { windowsVerbatimArguments: true, stdio: 'pipe', windowsHide: true });
      c.once('exit', (code, signal) => require('fs').writeFileSync(${JSON.stringify(mark)}, String(code) + '/' + String(signal)));
      setInterval(() => {}, 1000);`], { stdio: 'ignore', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } });
    while (!fs.existsSync(pidFile)) await wait(20);
    await wait(200);
    let out = '';
    try { out = execFileSync(taskkill, ['/PID', String(root.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true }); } catch (e) { out = String(e.stdout || e.message); }
    await new Promise((r) => root.once('close', r));
    const seen = fs.existsSync(mark);
    if (seen) saw += 1;
    console.log(`round ${i + 1}: root saw its child exit first: ${seen}; taskkill order: ${out.trim().split(/\r?\n/).map((l) => (l.match(/PID (\d+)/) || [])[1]).join(' > ')} (root ${root.pid})`);
  }
  console.log(`root observed the child's death before its own in ${saw} of ${rounds}`);
  fs.rmSync(dir, { recursive: true, force: true });
})();
