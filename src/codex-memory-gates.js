'use strict';

// Deliberate extension annotations, not a claim about what Codex generates:
// leading scope: global frontmatter plus paired standalone gate comments.
// Native sources stay untouched. Only this Codex-only block is installed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { readCodexMemory } = require('./codex-memory');
const { resolveCodexHome } = require('./codex-paths');
const { guidanceTargets, createManagedBlock, withInstructionLock, escapeMarker } = require('./agent-guidance');

const BEGIN = '<!-- BEGIN permission-wildcarding: native Codex memory gates (managed) -->';
const END = '<!-- END permission-wildcarding: native Codex memory gates -->';
const AUTOMATIC = Symbol('already-installed-native-gates');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const hashObject = value => sha(JSON.stringify(value));

function ordinaryParents(file, create = false) {
  const directory = path.dirname(path.resolve(file)), root = path.parse(directory).root;
  let current = root;
  for (const part of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return false;
      fs.mkdirSync(current); stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Native gate parent is linked or not a directory: ${current}`);
  }
  return true;
}

function snapshot(file) {
  ordinaryParents(file);
  let before;
  try { before = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return { path: file, exists: false, hash: sha(Buffer.alloc(0)), content: Buffer.alloc(0), text: '' }; throw error; }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Native gate file is linked or not ordinary: ${file}`);
  const content = fs.readFileSync(file), after = fs.lstatSync(file);
  ordinaryParents(file);
  if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
    before.ino !== after.ino || content.length !== after.size) throw new Error(`Native gate file changed during inspection: ${file}`);
  const text = content.toString('utf8');
  if (!Buffer.from(text).equals(content)) throw new Error(`Native gate file is not lossless UTF-8: ${file}`);
  return { path: file, exists: true, hash: sha(content), content, text };
}

function strictWrite(file, bytes) {
  ordinaryParents(file, true);
  snapshot(file);
  const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let descriptor, renamed = false;
  try {
    descriptor = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    ordinaryParents(file);
    snapshot(file);
    fs.renameSync(temp, file);
    renamed = true;
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* preserve the write error */ }
    if (!renamed) try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function lines(text) {
  return [...text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)].filter(match => match[0]).map((match, index) => ({
    text: match[0].replace(/[\r\n]+$/, ''), start: match.index, end: match.index + match[0].length, number: index + 1,
  }));
}

function scopeScalar(value) {
  // This annotation uses a single literal scalar, not aliases, flow collections,
  // multiline values, or YAML escape evaluation. A malformed/unsupported scalar
  // must not look like an intentional change from global to a narrower scope.
  const match = /^("[^"\\]*"|'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_#-]*)(?:[ \t]+#.*)?$/.exec(value);
  if (!match) return null;
  const literal = match[1];
  if (literal.startsWith('"')) return literal.slice(1, -1);
  if (literal.startsWith("'")) return literal.slice(1, -1).replace(/''/g, "'");
  return literal;
}

function gatesFromFile(file, text, diagnostics) {
  const rows = lines(text), warn = (code, message, line = 1) => diagnostics.push({ code, severity: 'error', path: file.path,
    relativePath: file.relativePath, line, message });
  let start = 0;
  if (rows[0]) rows[0].text = rows[0].text.replace(/^\uFEFF/, '');
  while (start < rows.length && !rows[start].text.trim()) start++;
  if (file.kind === 'summary' && rows[start]?.text === 'v1') start++;
  while (start < rows.length && !rows[start].text.trim()) start++;
  if (rows[start]?.text !== '---') return [];
  const finish = rows.findIndex((row, index) => index > start && row.text === '---');
  if (finish < 0) { warn('unclosed-frontmatter', 'Native gate frontmatter is not closed.'); return []; }
  const scopes = [], stack = [];
  for (const row of rows.slice(start + 1, finish)) {
    const match = /^( *)([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(row.text);
    if (!match) continue;
    const indent = match[1].length, key = match[2], value = match[3].trim();
    const separator = row.text[indent + key.length + 1];
    const separated = separator === undefined || /[ \t]/.test(separator);
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    if (key === 'scope' && (indent === 0 || (stack.length === 1 && stack[0].key === 'metadata' && stack[0].value === ''))) {
      scopes.push({ value, line: row.number, separated: separated && (indent === 0 || stack[0].separated) });
    }
    stack.push({ indent, key, value: value.startsWith('#') ? '' : value, separated });
  }
  if (scopes.length > 1) { warn('ambiguous-scope', 'Declare one unambiguous native gate scope.'); return []; }
  if (!scopes.length) return [];
  const scope = scopes[0].separated ? scopeScalar(scopes[0].value) : null;
  if (scope === null) {
    warn('invalid-scope', 'Native gate scope must be a complete single-line literal scalar; malformed or unsupported scope syntax was retained for review.', scopes[0].line);
    return [];
  }
  if (scope !== 'global') return [];
  const result = [];
  let fence = null, opening = null, invalid = false;
  for (const row of rows.slice(finish + 1)) {
    const code = /^ {0,3}(`{3,}|~{3,})/.exec(row.text);
    if (code) {
      if (!fence) fence = code[1];
      else if (code[1][0] === fence[0] && code[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(row.text)) fence = null;
      continue;
    }
    if (fence) continue;
    if (/^ {0,3}<!-- gate -->[ \t]*$/.test(row.text)) {
      if (opening) { warn('nested-gate', 'Native gate sections must not nest.', row.number); invalid = true; }
      opening = row; continue;
    }
    if (/^ {0,3}<!-- \/gate -->[ \t]*$/.test(row.text)) {
      if (!opening) { warn('unpaired-gate', 'Native gate closing marker has no opening marker.', row.number); invalid = true; continue; }
      const body = text.slice(opening.end, row.start);
      if (body.trim()) result.push({ id: hashObject([file.sourceId, file.sha256, opening.end, row.start]),
        path: file.path, relativePath: file.relativePath, sourceId: file.sourceId, sourceHash: file.sha256,
        startOffset: opening.end, endOffset: row.start, startLine: opening.number + 1, endLine: row.number - 1,
        text: body, bodyHash: sha(body) });
      opening = null;
    }
  }
  if (opening) { warn('unpaired-gate', 'Native gate opening marker has no closing marker.', opening.number); invalid = true; }
  return invalid ? [] : result;
}

function markerCount(text, marker) { return text.split(marker).length - 1; }
function blockState(text, body) {
  const block = createManagedBlock({ begin: BEGIN, end: END, body });
  const begins = markerCount(text, BEGIN), ends = markerCount(text, END);
  if (begins !== ends || begins > 1 || (begins && (!block.has(text) ||
    !text.split(/\r?\n/).some(line => line === BEGIN) || !text.split(/\r?\n/).some(line => line === END)))) {
    throw new Error('Native Codex gate markers are ambiguous; reconcile this instruction file before changing them.');
  }
  return { block, on: block.has(text), current: block.isCurrent(text) };
}

function coordinates(options) {
  const home = options.home ?? os.homedir();
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new TypeError('home must be an absolute path');
  const codexHome = resolveCodexHome(options), profileId = sha(canonical(codexHome));
  return { home: path.resolve(home), codexHome, profileId,
    compiledPath: path.join(home, '.ai-acolyte', 'codex', profileId, 'native-gates', 'compiled.json') };
}

function targets(options, body = '') {
  const selected = guidanceTargets(options).find(target => target.agent === 'codex');
  if (selected.error) throw new Error(selected.error);
  const candidates = selected.candidates.map(file => {
    const before = snapshot(file), state = blockState(before.text, body);
    return { before, on: state.on, current: state.current };
  });
  return { path: selected.path, candidates };
}

const targetSignature = selection => selection.candidates.map(({ before }) => ({ path: before.path, exists: before.exists, hash: before.hash }));

function inspectNativeCodexGates(options = {}) {
  const location = coordinates(options), memory = readCodexMemory(options);
  const diagnostics = [...memory.diagnostics], gates = [];
  for (const file of memory.files.filter(file => file.readable)) {
    const pieces = memory.chunks.filter(chunk => chunk.path === file.path).sort((a, b) => a.startOffset - b.startOffset);
    const text = pieces.map(chunk => chunk.text).join('');
    if (sha(Buffer.from(text)) !== file.sha256) {
      diagnostics.push({ code: 'incomplete-source', severity: 'error', path: file.path, relativePath: file.relativePath,
        message: 'Selected native gate source did not reconstruct exactly.' });
      continue;
    }
    gates.push(...gatesFromFile(file, text, diagnostics));
  }
  // Quoted managed marker syntax must remain ordinary text even when another
  // instruction writer scans for its own fences in the same AGENTS file.
  const content = gates.map(gate => gate.text.trim()).join('\n\n').replace(/<!-- (?:BEGIN|END) permission-wildcarding:[^\r\n]*?-->/g, escapeMarker);
  const body = gates.length ? `## Native Codex memory gates (${gates.length} sections)\n\n${content}` : '';
  const bodyHash = sha(body), complete = memory.storageState === 'readable' && !diagnostics.some(item => item.severity === 'error');
  const result = { agent: 'codex', ...location, root: memory.root, storageState: memory.storageState,
    featureState: memory.featureState, complete, compilationState: !complete ? memory.storageState === 'absent' ? 'absent' : 'unreadable'
      : gates.length ? 'ready' : 'zero', body, bodyHash, gates, diagnostics, count: gates.length,
    readable: false, canEnable: false, fingerprint: null, removalFingerprint: null, target: null };
  const sourceSnapshot = memory.files.map(file => ({ relativePath: file.relativePath, hash: file.sha256 || null, readable: file.readable === true }));
  result.sourceSignature = hashObject([canonical(location.codexHome), memory.storageState, sourceSnapshot, diagnostics]);
  try {
    const selection = targets(options, body), active = selection.candidates.find(candidate => candidate.before.path === selection.path);
    result.target = { path: selection.path, exists: active.before.exists, hash: active.before.hash, on: active.on,
      current: complete && active.current && !selection.candidates.some(candidate => candidate.before.path !== selection.path && candidate.on),
      shadowedPaths: selection.candidates.filter(candidate => candidate.before.path !== selection.path && candidate.on).map(candidate => candidate.before.path),
      candidates: targetSignature(selection) };
    result.readable = true;
    result.canEnable = complete && gates.length > 0;
    result.removalFingerprint = hashObject(['codex-native-gates-remove-v1', canonical(location.codexHome), selection.path, targetSignature(selection)]);
    result.fingerprint = hashObject(['codex-native-gates-enable-v1', result.sourceSignature, bodyHash, result.removalFingerprint]);
  } catch (error) {
    result.target = { path: path.join(location.codexHome, 'AGENTS.md'), on: false, current: false, error: error.message };
  }
  return result;
}

function setNativeCodexGates(enabled, request = {}, options = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean');
  const location = coordinates(options);
  if (typeof request.fingerprint !== 'string' || !request.fingerprint) throw new Error('Review the complete native Codex gate change before applying it.');
  // Disable deliberately avoids reading any native source or compiled cache.
  const removalView = () => {
    const selection = targets(options);
    return { selection, fingerprint: hashObject(['codex-native-gates-remove-v1', canonical(location.codexHome), selection.path, targetSignature(selection)]) };
  };
  const initial = enabled ? inspectNativeCodexGates(options) : removalView();
  const allowed = status => request[AUTOMATIC] === true
    ? status.complete && status.readable && (status.target.on || status.target.shadowedPaths.length > 0)
    : status.canEnable;
  if (enabled && !allowed(initial)) throw new Error(initial.target?.error || `Native Codex gates cannot be enabled from a ${initial.compilationState} compilation.`);
  if (request.fingerprint !== initial.fingerprint) throw new Error('Native Codex gate review is stale; inspect the current sources and instruction targets again.');
  const candidatePaths = (enabled ? initial.target.candidates : targetSignature(initial.selection)).map(candidate => candidate.path).sort();
  if (!enabled && !initial.selection.candidates.some(candidate => candidate.on)) {
    return { changed: false, on: false, path: initial.selection.path, compiledPath: location.compiledPath, count: 0, modifiedPaths: [] };
  }
  const locked = index => index === candidatePaths.length ? update() : withInstructionLock(candidatePaths[index],
    () => locked(index + 1), reason => { throw new Error(reason); });
  function update() {
    const fresh = enabled ? inspectNativeCodexGates(options) : removalView();
    if (fresh.fingerprint !== request.fingerprint || (enabled && !allowed(fresh))) {
      throw new Error('Native Codex gate sources or instruction targets changed while acquiring their locks.');
    }
    const selection = enabled ? targets(options, fresh.body) : fresh.selection;
    const changes = selection.candidates.map(({ before }) => {
      const block = blockState(before.text, enabled ? fresh.body : '').block;
      const desired = block.apply(before.text, enabled && before.path === selection.path);
      return { before, content: Buffer.from(desired.text) };
    }).filter(change => !change.content.equals(change.before.content));
    const written = [];
    const assertCurrent = () => {
      const current = targets(options, enabled ? fresh.body : '');
      for (const candidate of current.candidates) {
        const changed = written.find(change => change.before.path === candidate.before.path);
        const expectedBefore = changed ? { exists: true, hash: sha(changed.content) }
          : selection.candidates.find(old => old.before.path === candidate.before.path).before;
        if (candidate.before.exists !== expectedBefore.exists || candidate.before.hash !== expectedBefore.hash) {
          throw new Error('Codex instruction bytes changed before the native gate write.');
        }
      }
      if (enabled && (current.path !== selection.path || inspectNativeCodexGates(options).sourceSignature !== fresh.sourceSignature)) {
        throw new Error('Native gate sources or effective Codex target changed before writing.');
      }
    };
    try {
      assertCurrent();
      if (enabled) {
        const compiled = Buffer.from(JSON.stringify({ version: 1, agent: 'codex', profileId: location.profileId,
          body: fresh.body, bodyHash: fresh.bodyHash, sourceSignature: fresh.sourceSignature, gates: fresh.gates }, null, 2) + '\n');
        const before = snapshot(location.compiledPath);
        if (!compiled.equals(before.content)) { strictWrite(location.compiledPath, compiled); written.push({ before, content: compiled }); }
      }
      for (const change of changes) {
        assertCurrent();
        if (enabled && change.before.exists) strictWrite(path.join(path.dirname(location.compiledPath), 'backups',
          `${path.basename(change.before.path)}.${change.before.hash}.bak`), change.before.content);
        assertCurrent();
        strictWrite(change.before.path, change.content);
        written.push(change);
      }
      assertCurrent();
    } catch (error) {
      const incomplete = [];
      for (const change of [...written].reverse()) {
        try {
          const current = snapshot(change.before.path);
          if (!current.exists || current.hash !== sha(change.content)) throw new Error('concurrent bytes preserved');
          if (change.before.exists) strictWrite(change.before.path, change.before.content);
          else fs.unlinkSync(change.before.path);
        } catch { incomplete.push(change.before.path); }
      }
      const failure = new Error(`Native Codex gate update failed: ${error.message}` +
        (incomplete.length ? ` Partial changes remain; inspect before retrying: ${incomplete.join(', ')}` : ' Previous instruction bytes were preserved.'));
      failure.changedPaths = incomplete;
      throw failure;
    }
    const after = targets(options, enabled ? fresh.body : '');
    return { changed: written.length > 0, on: after.candidates.some(candidate => candidate.on), path: after.path,
      compiledPath: location.compiledPath, bodyHash: enabled ? fresh.bodyHash : null, count: enabled ? fresh.count : 0,
      modifiedPaths: written.map(change => change.before.path) };
  }
  return locked(0);
}

function refreshNativeCodexGates(options = {}) {
  const status = inspectNativeCodexGates(options);
  if (status.target?.error) throw new Error(status.target.error);
  if (!status.target.on && status.target.shadowedPaths.length === 0) {
    return { changed: false, on: false, path: status.target.path, compiledPath: status.compiledPath,
      count: status.count, skipped: true, reason: 'Native Codex gates are not installed; review Install to opt in.' };
  }
  if (!status.complete) throw new Error(`Installed native Codex gates were retained: the source compilation is ${status.compilationState}.`);
  // An existing owned marker is the opt-in. A complete zero result retains an
  // empty marker, so new deliberate annotations can repopulate it. Remove deletes
  // both candidate markers and cancels refresh regardless of compiled-cache text.
  return setNativeCodexGates(true, { fingerprint: status.fingerprint, [AUTOMATIC]: true }, options);
}

module.exports = { inspectNativeCodexGates, setNativeCodexGates, refreshNativeCodexGates };
