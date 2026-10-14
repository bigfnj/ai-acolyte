'use strict';

// Agent guidance — stop the prompts being *created*.
//
// Wildcarding and Auto Learn both act after the fact: a prompt happens, an
// approval is stored, and this repo generalizes it so the next one does not
// prompt. That leaves one class of friction untouched, and it is the expensive
// one. A compound command (`cd x && dotnet build`, or a multi-statement
// PowerShell block) is stored *verbatim* when approved, because there is no
// single command root to key on — `src/permissions.js` deliberately leaves those
// entries alone rather than shattering a quoted path into junk. Such an entry
// can never match a second command, so every variation prompts again. That is
// what fills a project's settings.local.json with hundreds of one-shot grants.
//
// No generalizer can fix that entry after the fact. The only fix is upstream:
// the agent writes one command per call, so the approval it produces is a
// command family instead of a string literal. That is a prompt-side change, so
// it belongs in the agent's instructions — and the agent cannot reliably install
// it itself, since editing its own permission surface is exactly what a
// permission classifier stops. The extension writes it instead.
//
// The target is `~/.claude/CLAUDE.md`: user-scope, loaded in every session of
// every project. The block is fenced by markers so it is idempotent to rewrite,
// removable without touching a byte of the user's own text, and obvious to a
// human reading the file.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeFileAtomicSync } = require('./permissions');
const { resolveCodexHome } = require('./codex-paths');

const BEGIN = '<!-- BEGIN permission-wildcarding: shell style (managed) -->';
const END = '<!-- END permission-wildcarding: shell style -->';

function guidancePath(home = os.homedir()) {
  return path.join(home, '.claude', 'CLAUDE.md');
}

function targetOptions(homeOrOptions) {
  return typeof homeOrOptions === 'string' ? { home: homeOrOptions } : (homeOrOptions || {});
}

function codexGuidanceTarget(options) {
  const directory = resolveCodexHome(options);
  const override = path.join(directory, 'AGENTS.override.md');
  const regular = path.join(directory, 'AGENTS.md');
  const candidates = [override, regular];
  // Codex loads the first nonempty global file. Filling an empty override would
  // hide the user's regular AGENTS.md, so leave it empty and update the base.
  // https://learn.chatgpt.com/docs/agent-configuration/agents-md
  try {
    if (fs.readFileSync(override, 'utf8').trim()) {
      return { agent: 'codex', path: override, candidates };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return { agent: 'codex', path: override, candidates,
        error: `cannot inspect Codex instruction override ${override}: ${error.code || error.message}` };
    }
  }
  return { agent: 'codex', path: regular, candidates };
}

// Both agents load a user-scope instruction file, and both are hurt by the same
// habit for different reasons. Claude Code stores approval patterns; Codex uses
// argv prefixes and may split simple shell chains before matching. Expansions
// and redirections can leave the wrapper as the command being checked. A script
// file needs its own permission; a rule for an inner tool does not cover it.
function guidanceTargets(homeOrOptions) {
  const options = targetOptions(homeOrOptions);
  const home = options.home ?? os.homedir();
  return [
    { agent: 'claude', path: guidancePath(home) },
    codexGuidanceTarget(options),
  ];
}

// Only write for an agent that is actually installed: the file may not exist yet
// (that is fine, it gets created), but its config directory must, or this would
// conjure a ~/.codex on a machine that has never run Codex.
function installedGuidanceTargets(homeOrOptions) {
  return guidanceTargets(homeOrOptions).filter((target) =>
    fs.existsSync(target.path) || fs.existsSync(path.dirname(target.path)));
}

// Kept short on purpose: this text is loaded into the context of every session,
// so it has the same budget discipline as a MEMORY.md hook line. Rules only,
// each one traceable to something the generalizer cannot do after the fact.
const GUIDANCE_BODY = `## Shell style that does not re-prompt

Claude Code stores command approval patterns; Codex stores argv prefix rules.
One simple command per call makes either approval easier to reuse. Compound
scripts can need an exact approval that does not cover the next variation.

- **One command per tool call.** No \`&&\`, \`;\` or \`|\` chains, and no
  multi-statement PowerShell (\`$x = ...; if (...) { ... }\`). A chain built only
  from already-allowed commands is fine — Claude Code checks each sub-command —
  the cost lands when a chain needs a *new* approval.
- **Use the tool's own path flag, not \`cd\`.** \`git -C <path> status\`,
  \`npm --prefix <dir> run build\`, \`dotnet build <path>\`, \`rg <pat> <path>\`,
  \`tail -n 50 <file>\`. Avoid coupling a directory change to the command
  whose approval you want to reuse.
- **Call executables by bare name.** A bare executable name
  is easier for this project's Claude generalizer to recognize than a quoted
  absolute path. Put its directory on PATH, or give a wrapper its own approval.
- **Put multi-step work in a script and run the script.** Use a stable invocation
  (\`./run-gate.ps1\`, \`./build.sh\`) that can receive its own reusable approval.
- The Claude generalizer strips \`VAR=value <cmd>\` prefixes. For Codex,
  verify the actual shell invocation before expecting a prefix rule to cover it.

Codex can split simple shell chains before checking argv prefix rules. Complex
shell syntax, including expansions and redirections, may leave the whole wrapper
as the checked command. Verify the actual invocation with Codex; a permission
for an inner tool does not automatically approve its wrapper or a script file.

Managed by permission-wildcarding. Remove this block, or turn it off with
\`wildcard-perms --guidance off\`.`;

// A marker only fences what cannot contain it. Neither body here is this repo's text —
// the gates body is compiled from the user's own memory corpus and a derived body embeds
// managed rule strings — so a body that quotes a marker is ordinary content. It used to
// truncate `blockRange` at the inner marker: a rewrite then replaced only the truncated
// range and left the rest of the old body plus an orphaned end marker behind, and since
// the reinstalled body still carried that inner marker, every later pass appended another
// copy. `off` removed only as far as the first inner marker, so none of it was removable.
//
// Neutralised rather than refused. Refusing would cost a user whose memory documents this
// very feature all of their gates; escaping the angle brackets leaves the marker readable
// to a human, stops it being a fence, and keeps the block removable.
function escapeMarker(marker) {
  return String(marker).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Where a marker counts (ported from rampage 7139659, src/managed-block.js) ──────
//
// Patched in here rather than imported: derived-guidance.js and codex-memory-gates.js build
// their blocks with this module's createManagedBlock, so every block in the user's
// instruction files gets the same rules.

// A UTF-8 file may open with a byte-order mark (the live ~/.codex/AGENTS.md on the
// development box does), and a decoded string keeps it as this one character.
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

// A marker counts only as a WHOLE LINE: at the start of the text (after a byte-order mark
// if the file has one) or right after a newline, and followed by `\r\n`, `\n` or the end
// of the text. Matched as a substring anywhere, a marker the user quoted in their own
// prose was a fence: a quoted BEGIN above the block made `on` replace everything from the
// quote to the real block's end, and `off` delete it, the user's own section with it.
// Nothing this module writes is affected: it writes every marker on a line of its own,
// and a body cannot carry one raw (see `fenced` in createManagedBlock).
function markerLineAt(text, marker, from = 0) {
  for (let at = text.indexOf(marker, from); at !== -1; at = text.indexOf(marker, at + 1)) {
    const opensLine = at === 0 || text[at - 1] === '\n' || (at === 1 && text[0] === BYTE_ORDER_MARK);
    const after = at + marker.length;
    const closesLine = after === text.length || text[after] === '\n'
      || (text[after] === '\r' && text[after + 1] === '\n');
    if (opensLine && closesLine) return at;
  }
  return -1;
}

// Closed code fences, as [start, end) offsets from the opening fence line to the end of
// the closing one. CommonMark's rule, cut down to what can hold a marker line: up to three
// spaces, then three or more backticks or tildes; a backtick opener's info string holds no
// backtick; the closer is the same character, at least as long, with only spaces or tabs
// after it.
//
// One deliberate departure: CommonMark runs an unclosed fence to the end of the file, and
// here an opener that never closes is plain text. A stray fence line in the user's notes
// must not be able to hide the real block below it.
const FENCE_OPENER = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSER = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
function fencedSpans(text) {
  const lines = [];
  for (let at = 0; at < text.length;) {
    const newline = text.indexOf('\n', at);
    const stop = newline === -1 ? text.length : newline + 1;
    lines.push({ at, stop, text: text.slice(at, newline === -1 ? stop : newline).replace(/\r$/, '') });
    at = stop;
  }
  if (lines.length && lines[0].text.startsWith(BYTE_ORDER_MARK)) lines[0].text = lines[0].text.slice(1);
  const spans = [];
  // The shortest opener of each character already scanned to the end of the file without
  // a closer. A later opener of that character at least as long cannot close either (its
  // closer would have closed the first), so it is skipped rather than scanned again.
  // Without this the scan is quadratic in unclosed openers: rampage measured 5,000 of them
  // at 487 to 542 ms against 4.5 to 4.9 ms, three fresh interleaved processes each.
  const unclosed = {};
  for (let i = 0; i < lines.length; i += 1) {
    const open = FENCE_OPENER.exec(lines[i].text);
    if (!open) continue;
    const [, fence, info] = open;
    const char = fence[0];
    if (char === '`' && info.includes('`')) continue;
    if (fence.length >= (unclosed[char] ?? Infinity)) continue;
    let close = -1;
    for (let j = i + 1; j < lines.length && close === -1; j += 1) {
      const shut = FENCE_CLOSER.exec(lines[j].text);
      if (shut && shut[1][0] === char && shut[1].length >= fence.length) close = j;
    }
    if (close === -1) { unclosed[char] = fence.length; continue; }
    spans.push([lines[i].at, lines[close].stop]);
    i = close;
  }
  return spans;
}

// The run of line terminators that ends at `at`, oldest first, and the run that starts at
// `at`. Each `\r\n` or bare `\n` is ONE terminator: the removal arithmetic in `apply`
// counts lines, and a CRLF counted as one `\n` and a stray `\r` is how an editor that saved
// the file as CRLF grew it by two blank lines per on/off cycle.
function terminatorsBefore(text, at) {
  const run = [];
  let from = at;
  while (from > 0 && text[from - 1] === '\n') {
    const crlf = from > 1 && text[from - 2] === '\r';
    run.unshift(crlf ? '\r\n' : '\n');
    from -= crlf ? 2 : 1;
  }
  return { from, run };
}

function terminatorsAfter(text, at) {
  const run = [];
  let to = at;
  for (;;) {
    if (text[to] === '\n') { run.push('\n'); to += 1; }
    else if (text[to] === '\r' && text[to + 1] === '\n') { run.push('\r\n'); to += 2; }
    else return { to, run };
  }
}

// A managed block is a marker pair plus a body. The shell-style text above is one
// instance; the compiled memory gates in `agent-gates.js` are another. Each closes over
// its own markers, so adding a block cannot change how an existing one behaves, and an
// "off" on one can never tear out the other.
function createManagedBlock({ begin, end, body }) {
  // Resolved per call, never captured: a static block hands back a const, while the gates
  // block reads whatever the compiler last wrote. That is what makes a corpus-derived
  // block's staleness detectable at all, with no version to bump.
  const fenced = (text) => (text == null ? '' : String(text))
    .split(begin).join(escapeMarker(begin))
    .split(end).join(escapeMarker(end));
  const bodyText = () => fenced(typeof body === 'function' ? body() : body);
  const block = () => `${begin}\n${bodyText()}\n${end}\n`;

  // Marker-fenced, so a rewrite replaces exactly what a previous version wrote and
  // an "off" leaves the rest of the file untouched. Matching is anchored on the
  // markers rather than the body text, which is what lets the wording change
  // between releases without stranding an old copy.
  //
  // Markers count only as whole lines (`markerLineAt`). The range runs from the LAST
  // begin line before the first end line, so a begin line the user left on its own above
  // the block cannot pull their text between it and the block into the range.
  //
  // A pair that sits wholly inside a closed code fence is a documented example and is
  // skipped. The fence has to enclose BOTH markers: one that closes between them (a gate's
  // own code fence closing a fence the user left open above) does not hide the block. What
  // this cannot tell from an example is a fence the user left open above a real block and
  // closed with a fence line below it; the block then reads as absent and the next `on`
  // appends a second copy (one only: the copy lands past the fence and is found from then
  // on). It takes both of those in the user's file, and Markdown renders that block as
  // code too.
  function blockRange(text) {
    let from = 0;
    let fences = null;
    for (;;) {
      let start = markerLineAt(text, begin, from);
      if (start === -1) return null;
      const stop = markerLineAt(text, end, start + begin.length);
      if (stop === -1) return null;
      for (let next = markerLineAt(text, begin, start + begin.length); next !== -1 && next < stop;
        next = markerLineAt(text, begin, next + begin.length)) start = next;
      fences = fences || fencedSpans(text);
      const example = fences.find(([open, close]) => open < start && stop + end.length <= close);
      if (!example) return { start, end: stop + end.length };
      from = example[1];
    }
  }

  function has(text) {
    return blockRange(typeof text === 'string' ? text : '') !== null;
  }

  // Whether the installed block is the current wording. An upgrade should refresh
  // a stale block silently; an unchanged one must not produce a write, or the
  // extension would rewrite CLAUDE.md on every activation.
  function isCurrent(text) {
    const range = blockRange(typeof text === 'string' ? text : '');
    if (!range) return false;
    return text.slice(range.start, range.end) === block().trimEnd();
  }

  // Compute the file content for turning the block on/off. Pure, so the decision is
  // testable without a filesystem: returns `changed: false` for a no-op.
  function apply(text, on) {
    const current = typeof text === 'string' ? text : '';
    const range = blockRange(current);

    if (!on) {
      if (!range) return { changed: false, text: current };
      // The block's own bytes are the fenced range, the newline that ends its last
      // marker line, and the ONE blank line the install below inserts ahead of it.
      // Every other newline in the two runs around it belongs to the user: the one
      // that ended their own last line above, and whatever separated what follows.
      //
      // Sweeping both runs bare and only restoring a newline at end of file fused
      // two of the user's own lines into one whenever the block sat between them,
      // and dropped the separator entirely ahead of a second managed block — the
      // shape `--guidance off` meets on any file that also carries the gates or a
      // derived block. It read as harmless only because a block written at line 1
      // makes the leading sweep a no-op.
      //
      // The sweeps count whole line terminators, `\r\n` and bare `\n` alike, and what is
      // kept is the user's own bytes from each run, never a newline this code chose. A
      // CRLF line keeps both its bytes and an LF line is never turned into CRLF. Sweeping
      // bare `\n` alone stopped at the `\r` of a CRLF block line, so a file an editor had
      // saved as CRLF kept the block's own terminator and its blank line as user bytes:
      // two blank lines more on every on/off cycle (ported from rampage 7139659).
      const up = terminatorsBefore(current, range.start);
      const down = terminatorsAfter(current, range.end);
      const head = current.slice(0, up.from);
      const tail = current.slice(down.to);
      // The install writes its blank line with `\n`, like the block's own lines, and an
      // editor that re-saves the file converts both alike. So the last terminator above
      // is the install's only when it is spelled like the block's first line ending; a
      // CRLF blank line right above an LF block is the user's own. Never the only one:
      // that is the terminator of the user's own last line.
      const blockEol = current[range.start + begin.length] === '\r' ? '\r\n' : '\n';
      const inserted = up.run.length > 1 && up.run[up.run.length - 1] === blockEol;
      // Start of file (a byte-order mark alone counts as nothing above): nothing to
      // separate from, and the run below was all the block's own. Anywhere else: the
      // user's run above less the install's blank line, then their run below less the
      // terminator that ended the block's last line. At the end of the file that leaves
      // the user's own trailing blank lines where they were; only the install's own blank
      // line and the block's terminator go.
      const separator = head === '' || head === BYTE_ORDER_MARK ? ''
        : up.run.slice(0, up.run.length - (inserted ? 1 : 0)).join('') + down.run.slice(1).join('');
      // End of file is the one branch that is deliberately NOT byte-exact, and it cannot
      // be. The install below adds no separator to a file already ending "\n\n" and one
      // to a file ending "\n", so both reach this point as the SAME two newlines above
      // the block: what would tell them apart is gone before removal runs. One of the two
      // round trips has to lose a byte, and it is this one — `"notes\n\n"` comes back as
      // `"notes\n"`, the single trailing newline a file with no final newline at all has
      // always been normalised to. The alternative is an install that always inserts its
      // own blank line, which buys byte-exactness at end of file by giving every ordinary
      // file a visible second blank line above the block. Pinned in test/agent-guidance.test.js.
      const next = head + separator + tail;
      return { changed: next !== current, text: next };
    }

    if (range) {
      if (isCurrent(current)) return { changed: false, text: current };
      const next = current.slice(0, range.start) + block().trimEnd() + current.slice(range.end);
      return { changed: true, text: next };
    }

    // Append rather than prepend: the user's own instructions keep their position
    // at the top of the file, where they were written to be read first. A file holding
    // only a byte-order mark is empty for this purpose: the block goes straight after it.
    const separator = current.length === 0 || current === BYTE_ORDER_MARK ? ''
      : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
    return { changed: true, text: `${current}${separator}${block()}` };
  }

  return { begin, end, block, blockRange, has, isCurrent, apply };
}

// The shell-style instance, plus delegates that keep every existing call site and test
// working unchanged: the suite that was green before the split is the proof it still is.
const SHELL_BLOCK = createManagedBlock({ begin: BEGIN, end: END, body: () => GUIDANCE_BODY });

const guidanceBlock = SHELL_BLOCK.block;
const hasGuidance = SHELL_BLOCK.has;
const isCurrent = SHELL_BLOCK.isCurrent;
const applyGuidance = SHELL_BLOCK.apply;

// The bytes of an instruction file and their text, or why it cannot be rewritten. A
// missing file is empty text with no bytes (`raw: null`): it is created on first write.
//
// Read as bytes and decoded once (ported from rampage 7139659). A file whose bytes do not
// survive the round trip through UTF-8 is refused, because decoding swaps every invalid
// byte for U+FFFD and writing that text back changed the user's own bytes outside the
// block. Rampage measured it: a cp1252 "Café" (what Windows PowerShell 5.1's Set-Content
// writes) came back as "Caf" plus EF BF BD, and a UTF-16LE file (its Out-File default) lost
// its FF FE byte-order mark the same way, in the file and in the backup both. A NUL byte is
// refused as well: it is valid UTF-8 but never text, and it is what UTF-16 without a
// byte-order mark looks like. `lossy` is the decoded text of a refused file, kept only so a
// status can say whether a block is in it; nothing is ever written from it.
function readInstructionFile(file) {
  let raw;
  try { raw = fs.readFileSync(file); }
  catch (error) {
    return error.code === 'ENOENT' ? { raw: null, text: '' } : { raw: null, error: `cannot read ${file}` };
  }
  const text = raw.toString('utf8');
  if (raw.includes(0) || !Buffer.from(text, 'utf8').equals(raw)) {
    return {
      raw, lossy: text, error: `${file} is not UTF-8 text (a UTF-16 or ANSI file?), so it will not be `
        + 'rewritten: save it as UTF-8 and try again',
    };
  }
  return { raw, text };
}

// The file a write lands in. An instruction file that is itself a symbolic link (a
// dotfiles checkout is the usual reason) is written THROUGH to its target. Renaming the
// temp file over the link replaced the link with a regular file: the dotfiles copy kept
// the old block and the link was gone for good (rampage 7139659). A link further up the
// path needs nothing, since a rename inside a linked directory already lands in the real one.
//
// A hard link is still split by the rename, the other name keeping the old bytes. Only an
// in-place write would keep it, and that gives up the atomic swap.
function writablePath(file) {
  const resolved = path.resolve(file);
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) return fs.realpathSync(resolved);
  } catch { /* absent, or a link whose target is gone: setGuidance's read says which */ }
  return resolved;
}

function isSymbolicLink(file) {
  try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; }
}

// `block` is additive and defaults to the shell-style instance, so every existing caller
// keeps its behaviour while `agent-gates.js` can drive the same file plumbing.
//
// A file that is not UTF-8 text reads as unreadable, with the reason in `error`, because
// every write to it is refused. Its `on` still says whether a block is in it, so an
// INACTIVE Codex file of that kind with no block in it needs no cleanup and blocks nothing.
function guidanceStatus(file = guidancePath(), block = SHELL_BLOCK) {
  const { text, lossy, error } = readInstructionFile(file);
  if (error) {
    const unreadable = { path: file, readable: false, on: false, current: false };
    return typeof lossy === 'string' ? { ...unreadable, on: block.has(lossy), error } : unreadable;
  }
  return { path: file, readable: true, on: block.has(text), current: block.isCurrent(text) };
}

// A status that cannot be acted on: unreadable, unless it is a file refused for its
// encoding that holds no block (nothing to remove, so nothing to refuse).
function blocksCleanup(state) {
  return !state.readable && (state.on || !state.error);
}

// ── One lock per instruction file, held across the whole read-decide-write ────
//
// FIVE writers share `~/.claude/CLAUDE.md`: `--guidance` and `--gates` from the CLI, the
// extension's guidance and gates toggles, and the derived-guidance reconcile in
// `src/derived-guidance.js`. Only the last ran under a lock at all, and it took the
// POLICY lock — the one that guards settings.json, which none of the other four take, so
// it bought nothing here. The window is not hypothetical: the extension recompiles gates
// on a memory-directory change, so an automatic write can land in the middle of a manual
// `wildcard-perms --guidance off`.
//
// Marker fencing does not make that safe, which is the part worth saying out loud. Every
// writer reads the WHOLE file, computes a whole new file, and writes it back. A write
// that lands between another writer's read and its own write is not merged into it — it
// is erased, and the user's own notes go with it. A single-slot backup then makes it
// permanent, because the next toggle copies the damaged file over the good copy. That is
// why setGuidance keeps two (`*.pre-guidance` and `*.pre-gates` written once, plus a
// rolling `*-prev`); `*.pre-derived` is still one slot.
//
// Keyed on the TARGET FILE rather than one global path: CLAUDE.md and AGENTS.md share no
// state and `setGuidanceAll` writes them in a loop, so a global lock would serialise two
// writes that cannot conflict. A sibling lock file also keeps a test that writes to a
// temp file out of the real `~/.claude`, which a home-derived path would not.
//
// Ordering, so this cannot deadlock: `decideDerived` takes the policy lock and then
// reaches this one through `setDerivedGuidance`. Nothing takes this lock and then the
// policy lock, so there is exactly one order and no cycle.
const INSTRUCTION_LOCK_SUFFIX = '.wildcarding.lock';
// The work under this lock is one read, a string operation and two atomic writes. Ten
// minutes — `policy-lock`'s default, sized for a full transcript scan — is the wrong
// order of magnitude for deciding that a holder of THIS lock has died. Past this age the
// lock is reclaimed even when the pid in it answers (`reclaimLiveWhenStale` below): a pid
// that answers after a crash is usually a reused one, and rampage measured a one-hour-old
// lock naming a live bystander, or pid 4, refusing every gates write until it was deleted
// by hand (7139659). No real holder of this lock runs for 30 s.
const INSTRUCTION_LOCK_STALE_MS = 30 * 1000;

// Beside the file a write lands in, so a symlinked instruction file is locked where it is
// written, whichever name a writer used.
function instructionLockPath(file) {
  return `${writablePath(file)}${INSTRUCTION_LOCK_SUFFIX}`;
}

// Run `write` holding the file's lock; call `onBusy` with the reason if someone else
// holds it. Reported, never waited on and never forced: every caller already renders a
// per-target `error` row, so "another process is writing this file, nothing changed"
// arrives through the path they already have, and the next command or activation
// retries. Waiting would instead make a toggle hang on the extension host thread.
function withInstructionLock(file, write, onBusy) {
  // Lazily required: `policy-lock.js` resolves its own default path from os.homedir() at
  // require time, and this module is loaded by tests that mock the home directory.
  const { createPolicyLock, POLICY_LOCK_CODE } = require('./policy-lock');
  const lock = createPolicyLock({
    lockPath: instructionLockPath(file),
    staleMs: INSTRUCTION_LOCK_STALE_MS,
    reclaimLiveWhenStale: true,
    busyMessage: () => `${file} is being written by another permission-wildcarding process`,
  });
  try {
    return lock.locked(write);
  } catch (error) {
    if (error?.code === POLICY_LOCK_CODE) return onBusy(error.message);
    throw error;
  }
}

// Drive the change. Backs the file up before every change: this is the user's own
// instruction file, and a managed block that ate someone's notes would be unforgivable
// even though the marker logic says it cannot. Two slots, both copied from the file's raw
// bytes rather than from decoded text (ported from rampage 7139659):
//   - `backupName` holds the file as it was before this block FIRST changed it, and is
//     never overwritten once written;
//   - `<backupName>-prev` holds it as it was before this block's most recent change.
// One slot rewritten on every change made any damage permanent at the next automatic
// write: the extension's recompile and `--gates refresh` both write unasked, and each one
// copied the damaged file over the only good copy.
//
// The read is INSIDE the lock, not above it. A lock taken around the write alone would
// still let a second writer land between this one's read and its own write, which is the
// interleaving itself rather than a smaller version of it.
//
// `inPlaceFallback` reaches the instruction file's own write (src/permissions.js
// writeFileAtomicSync). The unattended writers (the extension's ensureGates and
// ensureGuidance, and `--gates refresh`) pass false: a file held through every rename
// attempt then reports an error row and stays byte-identical, and the next activation,
// recompile or session retries. Written in place instead, the file is truncated and
// refilled while every new Claude or Codex session may be reading it.
function setGuidance(on, {
  file = guidancePath(),
  backupDir = path.join(os.homedir(), '.claude', 'backups'),
  // Named per target, so the Claude and Codex instruction files cannot overwrite
  // each other's pre-change copy in the shared backup directory.
  backupName = 'CLAUDE.md.pre-guidance',
  block = SHELL_BLOCK,
  validateTarget,
  inPlaceFallback = true,
} = {}) {
  return withInstructionLock(file, () => {
    // Selection can change while waiting for this file's lock. In particular an
    // override created after discovery must not be removed as an inactive copy.
    const selectionError = typeof validateTarget === 'function' ? validateTarget() : null;
    if (selectionError) return { changed: false, path: file, on: false, error: selectionError };
    const real = writablePath(file);
    const { raw, text, error: unreadable } = readInstructionFile(real);
    if (unreadable) {
      return { changed: false, error: unreadable.replace(real, file), path: file, on: false };
    }
    if (raw === null && isSymbolicLink(file)) {
      return { changed: false, path: file, on: false,
        error: `${file} is a symbolic link to a file that does not exist, so it will not be replaced by a regular file` };
    }

    const result = block.apply(text, on);
    if (!result.changed) return { changed: false, path: file, on: block.has(text), error: null };

    try {
      if (raw && raw.length) {
        fs.mkdirSync(backupDir, { recursive: true });
        const first = path.join(backupDir, backupName);
        if (!fs.existsSync(first)) writeFileAtomicSync(first, raw);
        writeFileAtomicSync(path.join(backupDir, `${backupName}-prev`), raw);
      }
      fs.mkdirSync(path.dirname(real), { recursive: true });
      writeFileAtomicSync(real, result.text, { inPlaceFallback });
    } catch (error) {
      return { changed: false, path: file, on: block.has(text), error: error.message };
    }
    return { changed: true, path: file, on: !!on, error: null };
  // A contended file reports `on: false` for the same reason the unreadable branch above
  // does — the state could not be read. No caller reads `on` off a row carrying an
  // `error`: the CLI and the extension both report the error and move to the next target.
  }, (busy) => ({ changed: false, path: file, on: false, error: busy }));
}

// Every installed agent's file, as one call — what the CLI and the extension
// actually drive. Each target is independent: an unreadable or failed one is
// reported in its own row rather than aborting the others.
function guidanceStatusAll(homeOrOptions, block = SHELL_BLOCK) {
  return installedGuidanceTargets(homeOrOptions).map((target) => {
    if (target.error) return { agent: target.agent, path: target.path, readable: false,
      on: false, current: false, error: target.error };
    const status = { agent: target.agent, ...guidanceStatus(target.path, block) };
    const shadowed = (target.candidates || []).filter((file) => file !== target.path)
      .map((file) => guidanceStatus(file, block));
    const unreadable = shadowed.find(blocksCleanup);
    if (unreadable) return { ...status, readable: false, current: false,
      error: `cannot inspect inactive Codex instruction file ${unreadable.path}` };
    const shadowedPaths = shadowed.filter((state) => state.on).map((state) => state.path);
    return shadowedPaths.length ? { ...status, current: false, shadowedPaths } : status;
  });
}

function setGuidanceAll(on, options = {}) {
  const home = options.home ?? os.homedir();
  const backupDir = options.backupDir || path.join(home, '.claude', 'backups');
  const block = options.block || SHELL_BLOCK;
  const backupSuffix = options.backupSuffix || 'pre-guidance';
  const inPlaceFallback = options.inPlaceFallback !== false;
  return installedGuidanceTargets(options).map((target) => {
    const results = [];
    const validateTarget = () => {
      if (!on || target.agent !== 'codex') return null;
      const selected = codexGuidanceTarget(options);
      return selected.error || (selected.path !== target.path
        ? 'Codex instruction selection changed during the update; retry' : null);
    };
    const finish = (error = null) => {
      const active = target.agent === 'codex' ? codexGuidanceTarget(options) : target;
      return { agent: target.agent, path: active.path,
        changed: results.some((result) => result.changed),
        on: !active.error && guidanceStatus(active.path, block).on,
        error: error || active.error || validateTarget() || null };
    };
    if (target.error) return finish(target.error);
    const write = (file, enabled) => {
      const result = setGuidance(enabled, { file, backupDir, block, validateTarget, inPlaceFallback,
        backupName: `${path.basename(file)}.${backupSuffix}` });
      results.push(result);
      return result;
    };
    if (on) {
      const active = write(target.path, true);
      if (active.error) return finish(active.error);
      // A concurrently created override must not turn the sibling cleanup into
      // removal of the newly active block. Report the changed selection instead.
      if (target.agent === 'codex') {
        const selected = codexGuidanceTarget(options);
        if (selected.error) return finish(selected.error);
        if (selected.path !== target.path) return finish('Codex instruction selection changed during the update; retry');
      }
    }
    // Clear inactive copies on enable, and both candidates on disable. An old
    // managed block must not return when the user later removes the override.
    const cleanup = on ? (target.candidates || []).filter((file) => file !== target.path)
      : [...new Set([target.path, ...(target.candidates || [])])];
    for (const file of cleanup) {
      const state = guidanceStatus(file, block);
      if (blocksCleanup(state)) return finish(state.error || `cannot read ${file}`);
      if (!state.on) continue;
      const removed = write(file, false);
      if (removed.error) return finish(removed.error);
    }
    return finish();
  });
}

// The path-selection details stay private; callers use the same selection for
// status and writes. SHELL_BLOCK is exposed through the existing delegates.
module.exports = {
  BEGIN, END, GUIDANCE_BODY,
  guidanceTargets, installedGuidanceTargets,
  guidanceBlock, hasGuidance, isCurrent, applyGuidance,
  guidanceStatus, setGuidance, guidanceStatusAll, setGuidanceAll,
  createManagedBlock, escapeMarker,
  instructionLockPath, withInstructionLock,
};
