'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { resolveCodexHome } = require('../src/codex-paths');

function environment(t, value) {
  const prior = process.env.CODEX_HOME;
  if (value === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = value;
  t.after(() => {
    if (prior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior;
  });
}

test('Codex home defaults to the user profile and follows nonempty CODEX_HOME', (t) => {
  const home = path.join(os.tmpdir(), 'codex-path-home-fixture');
  t.mock.method(os, 'homedir', () => home);
  environment(t, undefined);
  assert.equal(resolveCodexHome(), path.join(home, '.codex'));
  process.env.CODEX_HOME = '   ';
  assert.equal(resolveCodexHome(), path.join(home, '.codex'));
  const custom = path.join(os.tmpdir(), 'codex-path-custom-fixture');
  process.env.CODEX_HOME = custom;
  assert.equal(resolveCodexHome(), path.resolve(custom));
});

test('an explicit home is hermetic and an explicit Codex home wins over both', (t) => {
  environment(t, path.join(os.tmpdir(), 'codex-path-ambient-fixture'));
  const home = path.join(os.tmpdir(), 'codex-path-explicit-fixture');
  const custom = path.join(home, 'alternate-profile');
  assert.equal(resolveCodexHome({ home }), path.join(home, '.codex'));
  assert.equal(resolveCodexHome({ home, codexHome: custom }), path.resolve(custom));
  assert.throws(() => resolveCodexHome({ home: '' }), /home must be a nonempty path/);
});
