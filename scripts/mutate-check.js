#!/usr/bin/env node
'use strict';
// Run one mutation against a test command and restore the file byte for byte, sha256 checked.
//
//   node scripts/mutate-check.js <file> <from-json> <to-json> <test command...>
//
// <from-json> and <to-json> are JSON strings, so a replacement can carry quotes, backslashes and
// newlines without the shell mangling them. The span must occur exactly once. Prints FIRED (the
// test command failed, which is what a mutation is for) or SURVIVED, and exits 0 either way unless
// the span is missing or the restore could not be verified.
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const [file, fromJson, toJson, ...command] = process.argv.slice(2);
if (!file || !fromJson || !toJson || !command.length) {
  console.error('usage: node scripts/mutate-check.js <file> <from-json> <to-json> <test command...>');
  process.exit(2);
}
const from = JSON.parse(fromJson);
const to = JSON.parse(toJson);
const original = fs.readFileSync(file);
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const text = original.toString('utf8');
const count = text.split(from).length - 1;
if (count !== 1) { console.error(`the span occurs ${count} times in ${file}, not once`); process.exit(2); }
fs.writeFileSync(file, text.replace(from, () => to));
let run;
try {
  run = spawnSync(command[0], command.slice(1), { encoding: 'utf8', shell: false, windowsHide: true });
} finally {
  fs.writeFileSync(file, original);
}
if (sha(fs.readFileSync(file)) !== sha(original)) { console.error(`RESTORE FAILED for ${file}`); process.exit(3); }
const failed = run.status !== 0;
const first = `${run.stdout || ''}\n${run.stderr || ''}`.split('\n').find((line) => /^✖ |not ok |FAIL/.test(line)) || '';
console.log(`${failed ? 'FIRED' : 'SURVIVED'}: ${JSON.stringify(to).slice(0, 90)}${first ? `  ->  ${first.trim().slice(0, 140)}` : ''}`);
