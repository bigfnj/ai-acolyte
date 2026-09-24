#!/usr/bin/env node

// Release gate for the removed MAX feature. It reads the built VSIX itself, not
// the checkout that was meant to produce it, so a stale generated src/ tree or
// a direct vsce invocation cannot smuggle the old enable implementation back.

import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_FILES = new Set([
  'extension/src/codex-max.js',
]);

const FORBIDDEN_RUNTIME_SYMBOLS = [
  'enableMaxAllow',
  'ensureApproveScript',
  'registerApproveHook',
  'applyMax',
  'applyCodexMax',
  'writeCodexMaxState',
];

const FORBIDDEN_MANIFEST_KEYS = [
  'permission-wildcarding.toggleMax',
  'permission-wildcarding.toggleCodexMax',
  'permissionWildcarding.maxMode',
  'permissionWildcarding.codexMaxMode',
];

function centralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 0xffff - 22);
  let end = -1;
  for (let at = buffer.length - 22; at >= minimum; at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error('not a ZIP/VSIX: end-of-central-directory record is missing');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) {
      throw new Error(`invalid ZIP central-directory entry ${index}`);
    }
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8').replace(/\\/g, '/');
    entries.push({ name, method, compressedSize, localOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entryBytes(buffer, entry) {
  const at = entry.localOffset;
  if (buffer.readUInt32LE(at) !== 0x04034b50) {
    throw new Error(`invalid ZIP local header for ${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(at + 26);
  const extraLength = buffer.readUInt16LE(at + 28);
  const start = at + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return inflateRawSync(compressed);
  throw new Error(`unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

export function inspectVsix(file) {
  const buffer = readFileSync(file);
  return centralDirectory(buffer).map((entry) => ({
    name: entry.name,
    text: /(?:\.js|package\.json)$/i.test(entry.name)
      ? entryBytes(buffer, entry).toString('utf8')
      : null,
  }));
}

export function assertNoRetiredMaxEntries(entries, label = 'VSIX') {
  const failures = [];
  for (const entry of entries) {
    const name = String(entry?.name || '').replace(/\\/g, '/');
    if (FORBIDDEN_FILES.has(name)) failures.push(`${name}: retired implementation file is packaged`);
    if (typeof entry?.text !== 'string') continue;
    if (/^extension\/(?:src\/.*\.js|extension\.js)$/i.test(name)) {
      for (const symbol of FORBIDDEN_RUNTIME_SYMBOLS) {
        const exact = new RegExp(`\\b${symbol}\\b`);
        if (exact.test(entry.text)) failures.push(`${name}: retired enabling symbol ${symbol}`);
      }
    }
    if (name === 'extension/package.json') {
      for (const key of FORBIDDEN_MANIFEST_KEYS) {
        if (entry.text.includes(key)) failures.push(`${name}: retired contribution ${key}`);
      }
    }
  }
  if (failures.length) {
    throw new Error(`${label} still contains retired MAX enable surfaces:\n- ${failures.join('\n- ')}`);
  }
}

export function assertRetiredMaxAbsent(file) {
  assertNoRetiredMaxEntries(inspectVsix(file), file);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2];
  if (!file) throw new Error('usage: node scripts/assert-retired-max-absent.mjs <extension.vsix>');
  assertRetiredMaxAbsent(file);
  process.stdout.write(`retired MAX enable surfaces absent from ${file}\n`);
}
