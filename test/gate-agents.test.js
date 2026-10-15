'use strict';

// `agents:` in a gate memory's frontmatter, read twice: by recall.py _gate_agents, which
// decides what each agent's instruction file gets, and by vscode-extension/memoryLint.js
// gateAgents, which decides what the dashboard counts and names. Two readers of one rule is
// how the dashboard's gate count once read 17 where recall.py compiled 16, so the JavaScript
// one is held to Python's file by file here, over generated frontmatter, wherever the
// toolbox Python exists. The first test pins the documented forms in JavaScript alone, so CI
// still checks the reading without Python.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RECALL = path.join(ROOT, 'memory', 'recall.py');
const TOOLBOX_PY = process.env.TOOLBOX_PYTHON
  || path.join(process.env.LOCALAPPDATA || '', 'DevToolbox', 'python', '.venv', 'Scripts', 'python.exe');

// memoryLint.js requires 'vscode' at module scope and touches nothing on it until a
// MemoryLint is constructed, so an empty stand-in is enough to reach gateOf. Bound to a name
// and reached as memoryLint.gateOf, which is the shape test/dead-exports.test.js counts.
const modulePath = require.resolve('../vscode-extension/memoryLint');
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
delete require.cache[modulePath];
const memoryLint = require(modulePath);
Module._load = originalLoad;
delete require.cache[modulePath];

const gateOf = (text) => memoryLint.gateOf(text);
const ch = (code) => String.fromCharCode(code);
const GATE = '<!-- gate -->\n- a rule\n<!-- /gate -->\n';
const memory = (frontmatter) => `---\n${frontmatter}---\n${GATE}`;
const agentsOf = (text) => {
  const gate = gateOf(text);
  return gate && (gate.problem === null ? gate.agents.join(' ') : 'PROBLEM');
};

test('the documented agents: forms, and the readings that must not fall back to every agent', () => {
  const cases = [
    ['absent', 'scope: global\n', 'claude codex'],
    ['nested flow list', 'metadata:\n  scope: global\n  agents: [codex]\n', 'codex'],
    ['both', 'scope: global\nagents: [claude, codex]\n', 'claude codex'],
    ['bare', 'scope: global\nagents: codex\n', 'codex'],
    ['case', 'scope: global\nagents: Claude\n', 'claude'],
    ['empty', 'scope: global\nagents:\ntype: feedback\n', 'claude codex'],
    ['empty list', 'scope: global\nagents: []\n', 'claude codex'],
    ['quoted', 'scope: global\nagents: [\'codex\', "CLAUDE"]\n', 'claude codex'],
    ['comment', 'scope: global\nagents: [codex]  # not claude\n', 'codex'],
    ['spaced key', 'scope: global\nagents : [codex]\n', 'codex'],
    ['block list', 'metadata:\n  scope: global\n  agents:\n  - codex\n  type: x\n', 'codex'],
    // Each of these, read as "empty", would put a Codex-only rule in CLAUDE.md.
    ['comment inside a block list', 'scope: global\nagents:\n  # only this one\n  - codex\n', 'codex'],
    ['a value continued on the next line', 'metadata:\n  scope: global\n  agents:\n    codex\n', 'PROBLEM'],
    ['unknown agent', 'scope: global\nagents: [codex, gemini]\n', 'PROBLEM'],
    ['two agents: lines', 'scope: global\nagents: codex\nmetadata:\n  agents: claude\n', 'PROBLEM'],
    ['an unclosed list', 'scope: global\nagents: [codex\n', 'PROBLEM'],
    // Not a gate at all, whatever agents: says.
    ['not global', 'scope: retired\nagents: [codex]\n', null],
  ];
  for (const [name, frontmatter, expected] of cases) {
    assert.equal(agentsOf(memory(frontmatter)), expected, name);
  }
  // A CRLF file reads like its LF twin, as Python's universal newlines make it.
  assert.equal(agentsOf(memory('scope: global\r\nagents: [codex]\r\n').replace(/\n/g, '\r\n')), 'codex');
  assert.match(gateOf(memory('scope: global\nagents: [gemini]\n')).problem, /does not know: gemini/);

  // MUTATION: in gateAgents, `continue` on every line of a block list that is not an item
  // (or drop the comment skip) and the two cases flagged above read as every agent.
});

// Every slot recall.py's readers pass through, each filled from a set holding characters the
// two regex engines treat alike AND characters they treat differently (rampage's generator for
// `scope:`, widened to `agents:`). A seeded LCG, so a failure names a reproducible file. Its
// HIGH bits pick: an LCG modulo a power of two cycles its low bits with a short period, and
// `state % 4` taken straight off it chose the same value for one slot in every file.
function generated(seed, total) {
  let state = seed;
  const pick = (options) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return options[Math.floor(state / 65536) % options.length];
  };
  const indents = ['', '  ', '\t', ch(0x1c), ch(0xa0), ch(0xfeff), ch(0x85), ch(0x2028)];
  const values = ['[codex]', '[claude, codex]', 'codex', 'Claude', 'CODEX', '[Codex,]', '[]', '', '[gemini]',
    'codex, claude', '"codex"', "['claude']", '[codex] # note', '[codex]#x', '# all', '[codex',
    `codex${ch(0x2028)}x`, `cod${ch(0x85)}ex`, `codex${ch(0x1c)}`, `${ch(0xa0)}claude`, `[claude]${ch(0x85)}`];
  const blocks = ['  - codex\n', '- codex\n', '  # c\n  - claude\n', '    codex\n', '  -codex\n', '  -\n  - codex\n',
    `  -${ch(0x85)}codex\n`, `${ch(0x1c)} - claude\n`];
  const files = {};
  for (let i = 0; i < total; i += 1) {
    const lead = pick(['', ch(0xfeff), '\n\n', '\r\n']);
    const open = pick(['---\n', '---\r\n', '---\r']);
    const above = pick(['', 'name: a\n', 'metadata:\n']);
    const scope = `${pick(indents)}scope:${pick(['', ' ', ch(0x1c), ch(0x85)])}${pick(['global', 'global', 'global', 'retired'])}`
      + `${pick(['', '   ', ch(0x85), ch(0xa0), '\r'])}\n`;
    const indent = pick(indents);
    const key = pick(['agents:', 'agents :', 'agents:', `agents${ch(0x1c)}:`, 'Agents:', 'agents_x:']);
    const sep = pick(['', ' ', '\t', ` ${ch(0xa0)}`, ch(0x85)]);
    const shape = pick(['absent', 'inline', 'inline', 'inline', 'block', 'twice']);
    const agents = shape === 'absent' ? ''
      : shape === 'block' ? `${indent}${key}\n${pick(blocks)}`
        : shape === 'twice' ? `${indent}${key}${sep}codex\n${indent}${key}${sep}claude\n`
          : `${indent}${key}${sep}${pick(values)}${pick(['', ' ', ch(0x2029), '\r'])}\n`;
    const order = pick([0, 1]);
    const close = pick(['\n---\n', '\r\n---\r\n']);
    const body = order ? `${scope}${agents}` : `${agents}${scope}`;
    files[`gen_${String(i).padStart(3, '0')}.md`] = `${lead}${open}${above}${body.replace(/\n$/, '')}${close}${GATE}`;
  }
  return files;
}

// JavaScript's own reading with its own whitespace and line rules, the way a straight
// transliteration would make it: kept only to prove the generator reaches files where the two
// engines disagree, so a pass is not a pass over easy inputs.
function naive(text) {
  const head = String(text).replace(/^[\ufeff \t\r\n]+/, '');
  if (!head.startsWith('---')) return null;
  const end = head.indexOf('\n---', 3);
  if (end === -1) return null;
  const block = head.slice(3, end);
  const scope = block.match(/^\s*scope:\s*(.+)$/m);
  if (!scope || scope[1].trim().replace(/^["']|["']$/g, '') !== 'global') return null;
  const agents = block.match(/^\s*agents:\s*(.+)$/m);
  if (!agents) return 'claude codex';
  const names = agents[1].trim().replace(/^\[|\]$/g, '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean);
  return names.every((n) => n === 'claude' || n === 'codex') ? ['claude', 'codex'].filter((a) => names.includes(a)).join(' ') || 'claude codex' : 'PROBLEM';
}

const PY_READER = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("recall", sys.argv[1])
recall = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recall)
out = {}
for name in sorted(os.listdir(sys.argv[2])):
    text = open(os.path.join(sys.argv[2], name), encoding="utf-8", errors="replace").read()
    gate = recall._gate(text)
    out[name] = None if gate is None else (" ".join(gate[1]) if gate[2] is None else "PROBLEM")
print(json.dumps(out))
`;

test('gateOf agrees with recall.py _gate file by file over generated frontmatter', (t) => {
  if (!fs.existsSync(TOOLBOX_PY)) {
    t.skip(`no toolbox python at ${TOOLBOX_PY}; the forms above still pin the reading`);
    return;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-gate-agents-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'memory');
  fs.mkdirSync(dir);
  const files = generated(20261014, 480);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text, 'utf8');
  // One spawn for all of them.
  const run = spawnSync(TOOLBOX_PY, ['-c', PY_READER, RECALL, dir], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, RECALL_MEMORY_DIR: dir, RECALL_REEXEC: '1' },
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr);
  const python = JSON.parse(run.stdout);
  const names = Object.keys(files);
  assert.equal(Object.keys(python).length, names.length);

  // Non-degenerate: every outcome is common, and a JavaScript-rules reading differs from
  // Python's on a fair share of the files.
  const outcomes = {};
  for (const name of names) outcomes[python[name]] = (outcomes[python[name]] || 0) + 1;
  for (const outcome of ['null', 'claude codex', 'codex', 'claude', 'PROBLEM']) {
    assert.ok((outcomes[outcome] || 0) >= 15, `only ${outcomes[outcome] || 0} files read as ${outcome}: ${JSON.stringify(outcomes)}`);
  }
  const differ = names.filter((name) => naive(fs.readFileSync(path.join(dir, name), 'utf8')) !== python[name]);
  assert.ok(differ.length >= 30, `only ${differ.length} generated files separate Python's reading from JavaScript's rules`);
  t.diagnostic(`outcomes ${JSON.stringify(outcomes)}; ${differ.length} of ${names.length} differ under JavaScript's own rules`);

  const wrong = names.filter((name) => agentsOf(fs.readFileSync(path.join(dir, name), 'utf8')) !== python[name])
    .map((name) => `${name}: python ${python[name]}, js ${agentsOf(fs.readFileSync(path.join(dir, name), 'utf8'))} ${JSON.stringify(files[name])}`);
  assert.deepEqual(wrong, [], 'gateOf and recall.py read these files differently');

  // MUTATION: in memoryLint.js gateAgents, strip with JavaScript's trim() instead of pyStrip,
  // or split lines on /\r?\n/ without the universal-newline pass, and files here disagree.
});

// Retire and restore (2026-10-14, ported from rampage e5c0ee7). The dashboard card's "N retired"
// is memoryLint.js gateEntryOf, and the gates panel shows recall.py's --gates-list, which is
// _gate_entry: two readers of one rule again, so the second is held to the first the same way,
// state and agents both, over the same generated files (a quarter of them carry scope: retired).
const entryOf = (text) => {
  const entry = memoryLint.gateEntryOf(text);
  return entry && `${entry.state} ${entry.problem === null ? entry.agents.join('+') : 'PROBLEM'}`;
};

test('gateEntryOf reads retired gates with their agents, and is gateOf for a scope: global one', () => {
  assert.equal(entryOf(memory('scope: retired\nagents: [codex]\n')), 'retired codex');
  assert.equal(entryOf(memory('metadata:\n  scope: "retired"\n')), 'retired claude+codex');
  assert.equal(entryOf(memory('scope: retired\nagents: [gemini]\n')), 'retired PROBLEM');
  assert.equal(entryOf(memory('scope: global\nagents: [gemini]\n')), 'excluded PROBLEM');
  assert.equal(entryOf(memory('scope: global\nagents: [codex]\n')), 'active codex');
  assert.equal(entryOf(memory('scope: project\n')), null);
  assert.equal(entryOf('---\nscope: retired\n---\n<!-- gate -->\nno closing marker\n'), null);
  assert.equal(entryOf(memory('scope: retired  # was global\n')), null, 'a value with a comment is not "retired" to _fm');
  // MUTATION: accept any scope in gateEntryOf, or drop the GATE_BLOCK test, and the last three fail.
});

const PY_ENTRY_READER = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("recall", sys.argv[1])
recall = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recall)
out = {}
for name in sorted(os.listdir(sys.argv[2])):
    text = open(os.path.join(sys.argv[2], name), encoding="utf-8", errors="replace").read()
    entry = recall._gate_entry(name, text)
    out[name] = None if entry is None else entry["state"] + " " + ("+".join(entry["agents"]) if entry["problem"] is None else "PROBLEM")
print(json.dumps(out))
`;

test('gateEntryOf agrees with recall.py _gate_entry file by file over generated frontmatter', (t) => {
  if (!fs.existsSync(TOOLBOX_PY)) {
    t.skip(`no toolbox python at ${TOOLBOX_PY}; the forms above still pin the reading`);
    return;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-gate-entries-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'memory');
  fs.mkdirSync(dir);
  const files = generated(20261014, 480);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text, 'utf8');
  const run = spawnSync(TOOLBOX_PY, ['-c', PY_ENTRY_READER, RECALL, dir], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, RECALL_MEMORY_DIR: dir, RECALL_REEXEC: '1' },
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr);
  const python = JSON.parse(run.stdout);
  const names = Object.keys(files);
  assert.equal(Object.keys(python).length, names.length);
  // Non-degenerate: every state is common, retired ones with and without readable agents.
  const outcomes = {};
  for (const name of names) {
    const key = python[name] === null ? 'null' : python[name].split(' ')[0] + (python[name].endsWith('PROBLEM') ? '!' : '');
    outcomes[key] = (outcomes[key] || 0) + 1;
  }
  for (const outcome of ['null', 'active', 'excluded!', 'retired', 'retired!']) {
    assert.ok((outcomes[outcome] || 0) >= 10, `only ${outcomes[outcome] || 0} files read as ${outcome}: ${JSON.stringify(outcomes)}`);
  }
  t.diagnostic(`states ${JSON.stringify(outcomes)}`);
  const wrong = names.filter((name) => entryOf(fs.readFileSync(path.join(dir, name), 'utf8')) !== python[name])
    .map((name) => `${name}: python ${python[name]}, js ${entryOf(fs.readFileSync(path.join(dir, name), 'utf8'))} ${JSON.stringify(files[name])}`);
  assert.deepEqual(wrong, [], 'gateEntryOf and recall.py _gate_entry read these files differently');
  // MUTATION: read the retired state with JavaScript's own frontmatter rules (a /^\s*scope:/m
  // match) in gateEntryOf, or call a gate with a problem "active", and files here disagree.
});
