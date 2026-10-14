'use strict';

// ONE list of the provider credentials a runtime harness scrubs from the Codex it launches.
//
// Every scripts/check-codex-*.js harness drives a real Codex against a scripted loopback
// responder, and must strip the variables that would let it reach a real model on the
// developer's account instead. Until 2026-10-14 that list existed twelve times, identical,
// in ten files (the v1.6.2 audit): a SECRET_ENV or CREDENTIALS const in seven, inline
// arrays in check-codex-runtime.js (twice), check-codex-mcp-runtime.js and
// check-codex-wait-runtime.js. A variable Codex learns to read would have had to be added
// to all twelve, and missing one would leave that harness able to bill a real account.
// scripts/check-codex-runtime.js now exports PROVIDER_CREDENTIAL_ENV, every harness
// already imported from it, and this census holds the rest of the directory to it, in
// the shape of test/runtime-instruction-isolation.test.js's census.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const { PROVIDER_CREDENTIAL_ENV } = require('../scripts/check-codex-runtime');

const HARNESSES = fs.readdirSync(SCRIPTS).filter((file) => /^check-codex-.*\.js$/.test(file)).sort();
const textOf = (name) => fs.readFileSync(path.join(SCRIPTS, name), 'utf8');

test('the shared list names every provider credential the copies did, and cannot be changed', () => {
  assert.deepEqual([...PROVIDER_CREDENTIAL_ENV].sort(), [
    'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'CODEX_ACCESS_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY',
    'OPENAI_BASE_URL', 'OPENAI_ORGANIZATION', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID',
  ]);
  assert.ok(Object.isFrozen(PROVIDER_CREDENTIAL_ENV), 'a harness that pushed onto it would change every other scrub');
});

test('no harness spells a provider credential itself: the one list is the only place', () => {
  const spelled = [];
  for (const name of HARNESSES) {
    const lines = textOf(name).split('\n');
    lines.forEach((line, index) => {
      for (const key of PROVIDER_CREDENTIAL_ENV) {
        if (new RegExp(String.raw`['"\`]${key}['"\`]`).test(line)) spelled.push(`${name}:${index + 1} ${key}`);
      }
    });
  }
  // The definition itself, in check-codex-runtime.js, names each key exactly once.
  const definition = spelled.filter((entry) => entry.startsWith('check-codex-runtime.js:'));
  assert.equal(definition.length, PROVIDER_CREDENTIAL_ENV.length, definition.join('\n'));
  const elsewhere = spelled.filter((entry) => !entry.startsWith('check-codex-runtime.js:'));
  assert.deepEqual(elsewhere, [], `a credential list outside PROVIDER_CREDENTIAL_ENV:\n${elsewhere.join('\n')}`);
});

test('every harness that drives its own Codex session scrubs it with the shared list', () => {
  // Own: configures its own loopback provider, so it launches Codex itself. Scrubbing:
  // loops over a list deleting each name from process.env or a child env before a launch
  // (restoring a saved environment afterwards deletes too, one key at a time, and is not a
  // scrub). Either one must read PROVIDER_CREDENTIAL_ENV, directly or under a local alias.
  const own = [];
  const scrubbing = [];
  for (const name of HARNESSES) {
    const text = textOf(name);
    const reads = /\bPROVIDER_CREDENTIAL_ENV\b/.test(text);
    if (/model_providers\./.test(text)) {
      own.push(name);
      assert.ok(reads, `${name} drives Codex with its own provider and never reads PROVIDER_CREDENTIAL_ENV`);
    }
    if (/for\s*\(\s*const\s+key\s+of\s+[^)]*\)\s*delete\s+(?:process\.env|env|childEnv)\[key\]/.test(text)) {
      scrubbing.push(name);
      assert.ok(reads, `${name} scrubs an environment without the shared list`);
    }
  }
  // WITNESS: the census found the harnesses it exists for.
  for (const name of ['check-codex-runtime.js', 'check-codex-mcp-runtime.js', 'check-codex-code-mode-runtime.js',
    'check-codex-wait-runtime.js', 'check-codex-hook-runtime.js', 'check-codex-memory-runtime.js',
    'check-codex-native-gates-runtime.js', 'check-codex-project-rules-runtime.js']) {
    assert.ok(own.includes(name), `${name} not found among the harnesses with their own provider`);
  }
  for (const name of ['check-codex-prune-runtime.js', 'check-codex-restore-runtime.js', 'check-codex-wrapper-runtime.js']) {
    assert.ok(scrubbing.includes(name), `${name} not found among the harnesses that scrub process.env`);
  }
});
