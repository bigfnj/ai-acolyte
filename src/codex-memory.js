'use strict';

// Native Codex memories are generated files. This adapter only reads the selected
// public memory surfaces; it does not inspect sessions, SQLite rows or raw inputs,
// change feature configuration, write an index, or generate memories.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveCodexHome } = require('./codex-paths');

const DEFAULT_MAX_CHARS = 6000;
const DEFAULT_MAX_LINES = 120;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const ROOT_FILES = [['memory_summary.md', 'summary'], ['MEMORY.md', 'registry']];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function positiveInteger(value, fallback, name, minimum = 1) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function addDiagnostic(result, code, relativePath, message, severity = 'warning') {
  result.diagnostics.push({
    code, severity, relativePath,
    path: relativePath ? path.join(result.root, ...relativePath.split('/')) : result.root,
    message,
  });
}

function unavailable(result, code, relativePath, message) {
  result.storageState = 'unreadable';
  addDiagnostic(result, code, relativePath, message, 'error');
}

function finishState(result) {
  result.state = result.featureState === 'disabled' ? 'disabled' : result.storageState;
  const available = Array.isArray(result.chunks) ? result.files.some((file) => file.readable) : result.files.length > 0;
  result.partial = result.storageState === 'unreadable' && available;
  return result;
}

function statSelected(result, relativePath, type) {
  // Recheck parents for every selected path, including the read-time checks.
  // A directory may have been replaced since enumeration. Node's portable fs
  // API cannot provide an atomic, hostile-filesystem traversal guarantee.
  const parents = [''];
  const parts = relativePath.split('/');
  for (let index = 1; index < parts.length; index += 1) parents.push(parts.slice(0, index).join('/'));
  for (const parent of parents) {
    let stat;
    try { stat = fs.lstatSync(path.join(result.root, ...parent.split('/'))); } catch (error) {
      unavailable(result, 'parent-unreadable', relativePath, `Cannot inspect selected memory parent (${error.code || 'unknown error'}).`);
      return null;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      unavailable(result, 'linked-or-invalid-parent', relativePath, 'Selected memory parent must be an ordinary directory; linked parents are not followed.');
      return null;
    }
  }
  const absolute = path.join(result.root, ...relativePath.split('/'));
  let stat;
  try { stat = fs.lstatSync(absolute); } catch (error) {
    if (error.code === 'ENOENT') return null;
    unavailable(result, 'path-unreadable', relativePath, `Cannot inspect selected memory path (${error.code || 'unknown error'}).`);
    return null;
  }
  if (stat.isSymbolicLink()) {
    unavailable(result, 'linked-path', relativePath, 'Linked memory paths are not followed.');
    return null;
  }
  if (type === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
    unavailable(result, 'unexpected-path-type', relativePath, `Selected memory path is not a ${type}.`);
    return null;
  }
  return stat;
}

function listDirectory(result, relativePath) {
  if (!statSelected(result, relativePath, 'directory')) return [];
  try {
    return fs.readdirSync(path.join(result.root, ...relativePath.split('/')), { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  } catch (error) {
    unavailable(result, 'directory-unreadable', relativePath, `Cannot list selected memory directory (${error.code || 'unknown error'}).`);
    return [];
  }
}

/** Metadata-only discovery. Explicit home options remain hermetic to CODEX_HOME. */
function discoverCodexMemory(options = {}) {
  const featureState = options.featureState === undefined ? 'unknown' : options.featureState;
  if (!['unknown', 'enabled', 'disabled'].includes(featureState)) {
    throw new TypeError('featureState must be unknown, enabled or disabled');
  }
  const codexHome = resolveCodexHome(options);
  const result = {
    agent: 'codex', codexHome, root: path.join(codexHome, 'memories'),
    featureState, storageState: 'readable', state: 'readable', partial: false,
    files: [], diagnostics: [],
  };
  let rootStat;
  try { rootStat = fs.lstatSync(result.root); } catch (error) {
    if (error.code === 'ENOENT') result.storageState = 'absent';
    else unavailable(result, 'root-unreadable', '', `Cannot inspect native memory directory (${error.code || 'unknown error'}).`);
    return finishState(result);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    unavailable(result, 'root-unreadable', '', 'Native memory root must be an ordinary directory; linked roots are not followed.');
    return finishState(result);
  }
  // Listing the root distinguishes an unreadable directory from an empty one.
  try { fs.readdirSync(result.root); } catch (error) {
    unavailable(result, 'root-unreadable', '', `Cannot list native memory directory (${error.code || 'unknown error'}).`);
    return finishState(result);
  }
  const add = (relativePath, kind) => {
    const stat = statSelected(result, relativePath, 'file');
    if (stat) result.files.push({
      path: path.join(result.root, ...relativePath.split('/')), relativePath, kind,
      size: stat.size, mtimeMs: stat.mtimeMs,
    });
  };
  for (const [relativePath, kind] of ROOT_FILES) add(relativePath, kind);
  for (const entry of listDirectory(result, 'rollout_summaries')) {
    if (entry.name.endsWith('.md')) add(`rollout_summaries/${entry.name}`, 'rollout-summary');
  }
  for (const entry of listDirectory(result, 'skills')) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const relativeDir = `skills/${entry.name}`;
    if (statSelected(result, relativeDir, 'directory')) add(`${relativeDir}/SKILL.md`, 'skill');
  }
  result.files.sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  return finishState(result);
}

function linesOf(text) {
  const lines = [];
  const pattern = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  let match;
  while ((match = pattern.exec(text)) && match[0]) {
    lines.push({ start: match.index, end: pattern.lastIndex, text: match[0].replace(/[\r\n]+$/, '') });
  }
  return lines;
}

function headingsFor(lines) {
  const headings = new Map();
  let fence = null;
  let parent = '';
  for (let index = 0; index < lines.length; index += 1) {
    const text = index === 0 ? lines[index].text.replace(/^\uFEFF/, '') : lines[index].text;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(text);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length &&
        /^ {0,3}(?:`+|~+)\s*$/.test(text)) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^ {0,3}(#{1,2})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(text);
    if (!heading) continue;
    if (heading[1].length === 1) parent = heading[2];
    headings.set(index, heading[1].length === 1 ? parent : [parent, heading[2]].filter(Boolean).join(' / '));
  }
  return headings;
}

function chunkFile(file, text, root, maxChars, maxLines) {
  const lines = linesOf(text);
  const headings = headingsFor(lines);
  const hasUtf8Bom = text.startsWith('\uFEFF');
  const sourceId = sha256(`${path.resolve(root)}\0${file.relativePath}`);
  const chunks = [];
  let offset = 0;
  let lineIndex = 0;
  let title = file.relativePath;
  while (offset < text.length) {
    if (offset === lines[lineIndex].start && headings.has(lineIndex)) title = headings.get(lineIndex);
    const start = offset;
    const startLineIndex = lineIndex;
    let endLineIndex = lineIndex;
    let end = offset;
    for (let next = lineIndex; next < lines.length; next += 1) {
      if (next > lineIndex && headings.has(next)) break;
      if (next - startLineIndex >= maxLines) break;
      const proposed = lines[next].end;
      if (proposed - start > maxChars) {
        if (end === start) {
          end = start + maxChars;
          // Do not split a Unicode scalar or the two bytes of a CRLF line ending.
          if ((/^[\uDC00-\uDFFF]$/.test(text[end]) && /^[\uD800-\uDBFF]$/.test(text[end - 1])) ||
            (text[end - 1] === '\r' && text[end] === '\n')) end -= 1;
          endLineIndex = next;
        }
        break;
      }
      end = proposed;
      endLineIndex = next;
    }
    const chunkText = text.slice(start, end);
    const hash = sha256(Buffer.from(chunkText, 'utf8'));
    const chunk = {
      id: sha256(`${sourceId}\0${start}:${end}\0${hash}`), sourceId,
      agent: 'codex', kind: file.kind, path: file.path, relativePath: file.relativePath, hasUtf8Bom,
      startLine: startLineIndex + 1, endLine: endLineIndex + 1,
      startColumn: start - lines[startLineIndex].start + 1,
      endColumn: end - lines[endLineIndex].start + 1,
      startOffset: start, endOffset: end, sha256: hash, title, text: chunkText,
    };
    chunks.push(chunk);
    offset = end;
    while (lineIndex < lines.length - 1 && offset >= lines[lineIndex].end) lineIndex += 1;
  }
  return { sourceId, lineCount: lines.length, hasUtf8Bom, chunks };
}

function lintFile(result, file, text, selectedPaths) {
  if (file.kind === 'summary' && linesOf(text)[0]?.text !== 'v1') {
    addDiagnostic(result, 'summary-version', file.relativePath,
      'Native memory_summary.md does not start with the v1 format marker. Content was retained for inspection.');
  }
  // Only generated-memory references are checked. Never follow rollout_path,
  // absolute paths, URLs, original sessions or arbitrary Markdown links.
  const references = new Set(text.match(/\b(?:rollout_summaries\/[^\s`<>"'()[\]]+\.md|skills\/[^\s`<>"'()[\]/]+\/SKILL\.md)\b/g) || []);
  for (const reference of references) {
    if (reference.split('/').some((part) => part === '.' || part === '..')) {
      addDiagnostic(result, 'unsafe-reference', file.relativePath, `Selected-memory reference contains traversal: ${reference}`);
    } else if (!selectedPaths.has(reference)) {
      addDiagnostic(result, 'missing-reference', file.relativePath, `Selected-memory reference is missing or unreadable: ${reference}`);
    }
  }
}

/** Read selected native files without changing them or writing any cached index. */
function readCodexMemory(options = {}) {
  const maxChars = positiveInteger(options.maxChars, DEFAULT_MAX_CHARS, 'maxChars', 2);
  const maxLines = positiveInteger(options.maxLines, DEFAULT_MAX_LINES, 'maxLines');
  const maxFileBytes = positiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 'maxFileBytes');
  const result = discoverCodexMemory(options);
  result.chunks = [];
  const contents = new Map();
  for (const file of result.files) {
    const before = statSelected(result, file.relativePath, 'file');
    if (!before) {
      unavailable(result, 'file-changed', file.relativePath, 'Selected memory file became unavailable after discovery; retry discovery.');
      file.readable = false;
      continue;
    }
    if (before.size > maxFileBytes) {
      unavailable(result, 'file-too-large', file.relativePath, `Selected memory file exceeds the ${maxFileBytes} byte read limit.`);
      file.readable = false;
      continue;
    }
    let bytes;
    try { bytes = fs.readFileSync(file.path); } catch (error) {
      unavailable(result, 'file-unreadable', file.relativePath, `Cannot read selected memory file (${error.code || 'unknown error'}).`);
      file.readable = false;
      continue;
    }
    const after = statSelected(result, file.relativePath, 'file');
    if (!after || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino || bytes.length !== after.size) {
      unavailable(result, 'file-changed', file.relativePath, 'Selected memory file changed while being read; retry discovery.');
      file.readable = false;
      continue;
    }
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      unavailable(result, 'invalid-utf8', file.relativePath, 'Selected memory file is not lossless UTF-8; its content was not indexed.');
      file.readable = false;
      continue;
    }
    const parsed = chunkFile(file, text, result.root, maxChars, maxLines);
    Object.assign(file, { readable: true, size: after.size, mtimeMs: after.mtimeMs,
      sha256: sha256(bytes), sourceId: parsed.sourceId, lineCount: parsed.lineCount, hasUtf8Bom: parsed.hasUtf8Bom,
      chunkCount: parsed.chunks.length });
    result.chunks.push(...parsed.chunks);
    contents.set(file.relativePath, text);
  }
  const selectedPaths = new Set(contents.keys());
  for (const file of result.files) {
    if (file.readable) lintFile(result, file, contents.get(file.relativePath), selectedPaths);
  }
  result.lineCount = result.files.reduce((sum, file) => sum + (file.lineCount || 0), 0);
  return finishState(result);
}

function tokens(text) {
  return String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

/** Deterministic BM25 retrieval. No model, network access or native-store writes. */
function queryCodexMemory(corpus, query, options = {}) {
  const limit = positiveInteger(options.limit, 6, 'limit');
  const queryTokens = [...new Set(tokens(query))];
  const chunks = Array.isArray(corpus?.chunks) ? corpus.chunks : [];
  if (!queryTokens.length || !chunks.length) return [];
  const documents = chunks.map((chunk) => {
    const words = tokens(chunk.text);
    const counts = new Map();
    for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
    return { chunk, length: words.length, counts };
  });
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1;
  const frequency = new Map(queryTokens.map((word) => [word, documents.filter((document) => document.counts.has(word)).length]));
  return documents.map(({ chunk, length, counts }) => {
    let score = 0;
    for (const word of queryTokens) {
      const count = counts.get(word) || 0;
      if (!count) continue;
      const present = frequency.get(word);
      const idf = Math.log(1 + (documents.length - present + 0.5) / (present + 0.5));
      score += idf * (count * 2.2) / (count + 1.2 * (0.25 + 0.75 * length / averageLength));
    }
    return { ...chunk, score };
  }).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score ||
    (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0) ||
    a.startOffset - b.startOffset).slice(0, limit);
}

module.exports = { discoverCodexMemory, readCodexMemory, queryCodexMemory };
