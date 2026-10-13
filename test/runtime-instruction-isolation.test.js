'use strict';

// THE RUNTIME HARNESSES' WORKSPACES ARE THEIR OWN PROJECT ROOTS (2026-10-13).
//
// Codex walks up from a session's cwd to the nearest project-root marker and loads
// every AGENTS.md from there down. The harness temp trees sit under os.tmpdir(),
// inside the user's home on Windows, and on the development box Codex 0.161.0 counted
// the home's `.git` (a directory holding only credentials) and loaded the home's own
// AGENTS.md into every fresh harness session. scripts/check-codex-runtime.js now
// plants an empty `.git` in each workspace (Codex counts a `.git` by existence for
// AGENTS.md, measured) and a canary AGENTS.md one level up beside an empty `.git` of
// its own, and every harness asserts the canary never reaches its loopback.
//
// These tests need no Codex: they pin what the helper writes, where it refuses to
// write, and that no harness driving a session can skip it. The live proof is the
// harness runs themselves, and the mutation recorded with this change (workspace
// marker removed, every session carries the canary).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isolateWorkspaceInstructions, assertNoForeignInstructions } = require('../scripts/check-codex-runtime');

const SCRIPTS = path.join(__dirname, '..', 'scripts');

function tempTree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-isolation-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('the workspace and its parent each get a root marker, and the parent the canary', (t) => {
  const root = tempTree(t);
  const workspace = path.join(root, 'case', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const canary = isolateWorkspaceInstructions(workspace);
  assert.ok(fs.statSync(path.join(workspace, '.git')).isDirectory(), 'the workspace is its own root');
  assert.deepEqual(fs.readdirSync(path.join(workspace, '.git')), [], 'an EMPTY marker, not a repository');
  assert.ok(fs.statSync(path.join(root, 'case', '.git')).isDirectory(), 'the parent is a root a walk past the workspace would stop at');
  const text = fs.readFileSync(path.join(root, 'case', 'AGENTS.md'), 'utf8');
  assert.ok(text.includes(canary), 'the parent carries the canary');
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false, 'nothing is planted above the parent');
  // Idempotent: shared parents (prune, restore, shared) plant once and re-check.
  assert.equal(isolateWorkspaceInstructions(workspace), canary);
  const sibling = path.join(root, 'case', 'workspace-b');
  fs.mkdirSync(sibling);
  isolateWorkspaceInstructions(sibling);
  assert.equal(fs.readFileSync(path.join(root, 'case', 'AGENTS.md'), 'utf8'), text);
});

test('an existing .git is a marker as it is and is never replaced', (t) => {
  const root = tempTree(t);
  const worktree = path.join(root, 'case', 'worktree');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: ../main/.git/worktrees/worktree\n');
  isolateWorkspaceInstructions(worktree);
  assert.ok(fs.statSync(path.join(worktree, '.git')).isFile(), 'a worktree pointer file stays a file');
  const repository = path.join(root, 'case', 'repository');
  fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repository, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  isolateWorkspaceInstructions(repository);
  assert.equal(fs.readFileSync(path.join(repository, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/main\n');
});

test('the helper refuses to plant in the temp root, outside it, or over a real AGENTS.md', (t) => {
  // A workspace directly under os.tmpdir() would put the canary and a `.git` in the
  // temp root itself, where every other process's sessions would walk into them.
  // Neither workspace exists, so even a helper without the refusal could create
  // nothing here: its first write is inside the missing workspace.
  assert.throws(() => isolateWorkspaceInstructions(path.join(os.tmpdir(), 'acolyte-not-created-here')), /only below the temp root/);
  const outside = path.join(__dirname, 'acolyte-not-a-workspace');
  assert.throws(() => isolateWorkspaceInstructions(outside), /only below the temp root/);
  assert.equal(fs.existsSync(path.join(__dirname, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(__dirname, '.git')), false);
  const root = tempTree(t);
  const workspace = path.join(root, 'case', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(root, 'case', 'AGENTS.md'), '# somebody else\n');
  assert.throws(() => isolateWorkspaceInstructions(workspace), /is not the isolation canary/);
  assert.equal(fs.readFileSync(path.join(root, 'case', 'AGENTS.md'), 'utf8'), '# somebody else\n');
});

test('a request that carries the canary fails, one that does not passes', (t) => {
  const root = tempTree(t);
  const workspace = path.join(root, 'case', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const canary = isolateWorkspaceInstructions(workspace);
  const body = (text) => JSON.stringify({ input: [{ type: 'message', role: 'user',
    content: [{ type: 'input_text', text: `# AGENTS.md instructions for C:\\src\\example\n\n<INSTRUCTIONS>\n${text}\n</INSTRUCTIONS>` }] }] });
  assert.doesNotThrow(() => assertNoForeignInstructions(body('# Fixture user instructions'), 'control'));
  assert.throws(() => assertNoForeignInstructions(body(fs.readFileSync(path.join(root, 'case', 'AGENTS.md'), 'utf8')), 'leak'),
    /leak: Codex loaded an AGENTS.md from above the workspace/);
  assert.ok(canary.length > 20, 'the canary is specific enough not to occur by accident');
});

// Every harness that configures its own loopback provider drives its own Codex
// session, so it has to do both halves itself. The rest reach Codex only through
// runtimeCase, which does both.
test('every runtime harness that drives its own Codex session isolates it and checks every request', () => {
  const own = [];
  const delegated = [];
  for (const name of fs.readdirSync(SCRIPTS).filter((file) => /^check-codex-.*\.js$/.test(file))) {
    const text = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
    if (/model_providers\./.test(text)) {
      own.push(name);
      assert.match(text, /isolateWorkspaceInstructions\(/, `${name} drives Codex without making its workspace a root`);
      assert.match(text, /assertNoForeignInstructions\(/, `${name} drives Codex without checking its requests for the canary`);
    } else if (/\bruntimeCase\(/.test(text)) delegated.push(name);
  }
  // WITNESS: the census found the harnesses it exists for.
  for (const name of ['check-codex-runtime.js', 'check-codex-mcp-runtime.js', 'check-codex-code-mode-runtime.js',
    'check-codex-wait-runtime.js', 'check-codex-hook-runtime.js', 'check-codex-memory-runtime.js',
    'check-codex-native-gates-runtime.js', 'check-codex-project-rules-runtime.js']) assert.ok(own.includes(name), `${name} not found`);
  for (const name of ['check-codex-prune-runtime.js', 'check-codex-restore-runtime.js', 'check-codex-shared-runtime.js',
    'check-codex-wrapper-runtime.js']) assert.ok(delegated.includes(name), `${name} not found`);
});
