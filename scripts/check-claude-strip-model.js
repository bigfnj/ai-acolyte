'use strict';

// Does Claude Code still strip the environment variables this repo thinks it strips?
//
//   node scripts/check-claude-strip-model.js                    the newest installed VS Code extension's CLI
//   node scripts/check-claude-strip-model.js --binary <path>    any Claude Code CLI: the native claude(.exe),
//                                                               or the npm package's cli.js
//   node scripts/check-claude-strip-model.js --json             machine-readable
//
// Exit 0: the binary's known-safe name list is CLAUDE_SAFE_ENV_VARS (src/permission-match.js)
// exactly. Exit 1: it differs; the names it adds and the names it dropped are printed. Exit 2:
// no decision, because no binary was found or readable, no list was found in it, or more than
// one candidate list was, which means the bundle changed shape and the read has to be redone
// by hand. Read-only: the binary is opened for reading and nothing is written anywhere.
//
// It also reports, ADVISORILY (M5, 2026-10-14; `lookupCase` in `--json`, a line otherwise), whether
// the membership lookup converts the name's case before testing it. `claudeStripsAssignment`
// (src/permission-match.js) models the strip case-exact, which is what makes `LANG=C` strip and
// `lang=C` keep its assignment. It never changes the exit code.
//
// A thin command line over src/claude-strip-model.js, where the reader moved on 2026-10-15 so the
// extension can run the same check (scripts/ is not packaged). That file's header holds the WHY
// and the HOW, and says where in the binary to re-read by hand the parts of the strip model this
// does not check: the value class, the wrapper shapes and the matcher's order. The extension runs
// check() once per new Claude Code binary and warns on drift; this command reads the answer, with
// the offsets, on demand.

const { CLAUDE_SAFE_ENV_VARS } = require('../src/permission-match');
const { check, defaultBinary } = require('../src/claude-strip-model');

function parseArgs(argv) {
  const options = { binary: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--binary' && argv[i + 1]) options.binary = argv[++i];
    else if (argv[i] === '--json') options.json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') options.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return options;
}

function main(argv) {
  let options;
  try { options = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
  if (options.help) {
    console.log('usage: node scripts/check-claude-strip-model.js [--binary <path>] [--json]');
    return 0;
  }
  const located = options.binary ? { path: options.binary } : defaultBinary();
  if (!located) {
    console.error('no Claude Code CLI found under ~/.vscode*/extensions/anthropic.claude-code-*; pass --binary <path>');
    return 2;
  }
  let result;
  try { result = check(located.path); } catch (error) {
    console.error(`could not read ${located.path}: ${error.message}`);
    return 2;
  }
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else if (result.status === 'undecided') {
    console.log(`${result.binary}: ${result.candidates} candidate lists, expected 1. The bundle changed shape;`
      + ' re-read the strip model by hand (src/claude-strip-model.js\'s header says where).');
  } else {
    console.log(`${result.binary}: ${result.count} known-safe names, CLAUDE_SAFE_ENV_VARS has ${CLAUDE_SAFE_ENV_VARS.size}.`);
    if (result.status === 'same') console.log('Same set.');
    else {
      if (result.added.length) console.log(`Claude Code strips, this repo does not: ${result.added.join(' ')}`);
      if (result.dropped.length) console.log(`This repo strips, Claude Code no longer does: ${result.dropped.join(' ')}`);
      console.log('Update CLAUDE_SAFE_ENV_VARS (src/permission-match.js), the literal in test/permissions-env.test.js,'
        + ' and docs/claude-code-permissions.md section 3, on this evidence.');
    }
    // Advisory, not part of the verdict (M5): whether the membership lookup converts case.
    if (result.lookupCase === 'exact') {
      console.log('The membership lookup is case-exact (claudeStripsAssignment models that: LANG=C strips, lang=C keeps).');
    } else if (result.lookupCase === 'folded') {
      console.log('The membership lookup converts case; claudeStripsAssignment (src/permission-match.js) models it case-exact — re-read by hand.');
    }
  }
  return { same: 0, drift: 1 }[result.status] ?? 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

// check and defaultBinary are src/claude-strip-model.js's exports since 2026-10-15; the tests
// take them from there and drive this command through main.
module.exports = { main };
