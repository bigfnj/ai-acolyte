#!/usr/bin/env node
// Stage current development code without changing versions, generated mirrors,
// build stamps, VSIX files or installed extensions.
//   node scripts/stage-extension.mjs --out D:/.ai-work/scratch/<unique>/extension

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const receiptName = 'dev-staging-provenance.json';
const usage = 'Usage: node scripts/stage-extension.mjs --out <new-directory-outside-checkout>';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const portable = (name) => name.replace(/\\/g, '/');

function statIfPresent(target) {
  try { return lstatSync(target); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function within(parent, target) {
  const rest = relative(parent, target);
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith('../') && !rest.startsWith('..\\'));
}

function physicalDestination(target) {
  let ancestor = target;
  const missing = [];
  while (!statIfPresent(ancestor)) {
    const next = dirname(ancestor);
    if (next === ancestor) throw new Error('No existing parent for staging output: ' + target);
    missing.unshift(relative(next, ancestor));
    ancestor = next;
  }
  return join(realpathSync(ancestor), ...missing);
}

function sourcePlan() {
  const files = [];
  const add = (source, target) => {
    if (!lstatSync(join(root, source)).isFile()) throw new Error('Staging requires a regular source file: ' + source);
    files.push({ source: portable(source), path: portable(target) });
  };
  // Root runtime assets come from the extension. Generated src/ and memory/
  // directories are deliberately never traversed; their originals follow below.
  for (const entry of readdirSync(join(root, 'vscode-extension'), { withFileTypes: true })) {
    if (entry.isFile()) add(join('vscode-extension', entry.name), entry.name);
    else if (entry.isSymbolicLink()) throw new Error('Linked extension assets are unsupported: ' + entry.name);
  }
  const media = (directory) => {
    for (const entry of readdirSync(join(root, 'vscode-extension', directory), { withFileTypes: true })) {
      const next = join(directory, entry.name);
      if (entry.isDirectory()) media(next);
      else add(join('vscode-extension', next), next);
    }
  };
  media('media');
  for (const entry of readdirSync(join(root, 'src'), { withFileTypes: true })) {
    if (entry.name.endsWith('.js')) add(join('src', entry.name), join('src', entry.name));
  }
  add(join('memory', 'recall.py'), join('memory', 'recall.py'));
  add(join('memory', 'codex_recall.py'), join('memory', 'codex_recall.py'));
  add(join('memory', 'models', 'bge-small.vocab.txt'), join('memory', 'models', 'bge-small.vocab.txt'));
  files.sort((a, b) => a.path.localeCompare(b.path));
  if (files.some((file) => file.path === receiptName)) throw new Error('Source contains the reserved staging receipt');
  return files;
}

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--out' || !args[1] || args[1].startsWith('--')) throw new Error(usage);
  const output = resolve(args[1]);
  if (statIfPresent(output)) throw new Error('Staging output already exists; choose a new directory: ' + output);
  if (within(root, output) || within(realpathSync(root), physicalDestination(output))) {
    throw new Error('Staging output must be outside the checkout: ' + output);
  }

  const startedAt = new Date().toISOString();
  const plan = sourcePlan();
  const files = plan.map((file) => {
    const bytes = readFileSync(join(root, file.source));
    return { ...file, bytes, sha256: sha256(bytes) };
  });
  const manifestFile = files.find((file) => file.path === 'package.json');
  if (!manifestFile || !files.some((file) => file.path === 'extension.js')) throw new Error('Extension entry or manifest is absent');
  const manifest = JSON.parse(manifestFile.bytes.toString('utf8'));

  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output);
  for (const file of files) {
    const target = join(output, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes, { flag: 'wx' });
    if (sha256(readFileSync(target)) !== file.sha256) throw new Error('Staged bytes differ: ' + file.path);
  }
  if (JSON.stringify(sourcePlan()) !== JSON.stringify(plan)) throw new Error('Source file inventory changed during staging; discard this stage');
  for (const file of files) {
    if (sha256(readFileSync(join(root, file.source))) !== file.sha256) {
      throw new Error('Source changed during staging; discard this stage: ' + file.source);
    }
  }
  const hashes = files.map(({ source, path, bytes, sha256 }) => ({ path, source, bytes: bytes.length, sha256 }));
  const receipt = {
    kind: 'development-extension-staging', schemaVersion: 1, sourceRoot: root, extensionDir: output,
    startedAt, completedAt: new Date().toISOString(),
    manifest: { name: manifest.name, publisher: manifest.publisher, version: manifest.version },
    contentSha256: sha256(JSON.stringify(hashes)), files: hashes,
  };
  writeFileSync(join(output, receiptName), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ extensionDir: output, provenance: join(output, receiptName),
    files: files.length, contentSha256: receipt.contentSha256 }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
