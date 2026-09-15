'use strict';

// An export entry with no importer.
//
// It costs nothing to keep and quite a lot to trust: it advertises a function as part of a
// module's contract when nobody has ever called it through that door, so the first caller
// to use it is also the first to exercise it. Four had accumulated here. Removing the
// EXPORT is free; removing the FUNCTION is not, and this repo already records the
// difference — `fastLint` and `pickPrimaryDir` look identical from a production-import
// scan and are test-only rather than dead, and their test calls are the mutation-killing
// assertions for the line cap and the store-selection rule.
//
// So this test does not say "nothing uses it". It says: every name a module exports is
// either destructured from a require of that module somewhere, or is listed below with the
// reason it is held. A name that is neither is dead weight, and a name that is held has to
// say why in writing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');

// Held on purpose. The key is the export; the value is why, and is printed on failure.
const HELD = {
  'src/recall-index.js': {
    MTIME_TOLERANCE_MS:
      'the third cross-language constant this module reconciles against recall.py, and the '
      + 'only one the promised drift test does not yet pin. A branch in flight adds a test '
      + 'that imports this name; removing it now would be a rename for that branch to undo.',
  },
  'vscode-extension/memoryLint.js': {
    fastLint:
      'test-only, not dead: test/memory-line-cap.test.js calls it directly through '
      + 'loadLint(), and those calls are what make the line-cap off-by-one falsifiable.',
    pickPrimaryDir:
      'test-only, not dead: test/memory-lint-watchers.test.js and test/recall-index.test.js '
      + 'pin the store-selection rule through it, against recall.py as the authority.',
  },
};

// Every file that could plausibly import one of these modules.
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  for (const dir of ['src', 'test', 'vscode-extension', 'scripts']) walk(path.join(ROOT, dir));
  // Extensionless, so the walk above cannot see it, and it is the highest-frequency
  // consumer of src/ in the repo.
  out.push(path.join(ROOT, 'bin', 'wildcard-perms'));
  return out;
}

// The names destructured from a require of `moduleFile`, across every other file.
//
// A require site, not a bare mention: `fullReport` appears in a comment in
// test/dashboard-view.test.js and in memoryLint.js's own export note, and neither is a
// consumer. Matching the require is what keeps prose out of the answer.
function importedNames(moduleFile) {
  const stem = path.basename(moduleFile, '.js');
  const absolute = path.join(ROOT, moduleFile);
  const pattern = new RegExp(
    String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\((['"])(?:[^'"]*\/)?`
    + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + String.raw`(?:\.js)?\2\)`,
    'g',
  );
  const names = new Set();
  for (const file of sourceFiles()) {
    if (path.resolve(file) === absolute) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let match;
    while ((match = pattern.exec(text)) !== null) {
      for (const part of match[1].split(',')) {
        // `cfg: memoryConf` binds under a local alias; the EXPORT is the left half.
        const name = part.split(':')[0].trim();
        if (name) names.add(name);
      }
    }
  }
  return names;
}

// memoryLint.js requires 'vscode' at module scope. Nothing in its export list touches the
// API, so a stub that merely exists is enough.
function loadModule(moduleFile) {
  const modulePath = path.join(ROOT, moduleFile);
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') {
      return { workspace: { getConfiguration: () => ({ get: () => undefined }) } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(modulePath)];
    return Object.keys(require(modulePath)).sort();
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(modulePath)];
  }
}

for (const moduleFile of ['src/recall-index.js', 'src/tool-learn.js', 'vscode-extension/memoryLint.js']) {
  test(`${moduleFile} exports nothing it cannot account for`, () => {
    const exported = loadModule(moduleFile);
    const imported = importedNames(moduleFile);
    const held = HELD[moduleFile] || {};

    assert.ok(exported.length > 0, 'precondition: the module was loaded and does export');
    // Precondition, and it has to be here: if the require-site scan matched nothing at all
    // — a renamed file, a regex that stopped parsing the destructure — every name would
    // fall through to the allowlist and the test would report dead exports that are fine,
    // or worse, pass because everything happened to be held.
    assert.ok(imported.size > 0,
      `no require of ${moduleFile} was found anywhere, so this test proved nothing`);

    for (const name of exported) {
      if (imported.has(name)) continue;
      assert.ok(name in held,
        `${moduleFile} exports ${name} and no file destructures it from a require of that `
        + 'module. Remove the export entry (keep the function), or add it to HELD with the '
        + 'reason it is kept.');
    }

    // The other direction, so over-pruning fails here rather than at runtime.
    for (const name of imported) {
      assert.ok(exported.includes(name),
        `something imports ${name} from ${moduleFile}, which no longer exports it`);
    }

    // And a held name that gained a real importer should stop being held, or the list
    // rots into a permanent excuse.
    for (const name of Object.keys(held)) {
      assert.ok(exported.includes(name), `HELD lists ${name}, which ${moduleFile} no longer exports`);
      assert.ok(!imported.has(name),
        `${name} is now imported from ${moduleFile}; drop it from HELD — ${held[name]}`);
    }
  });
}
