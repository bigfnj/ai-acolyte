'use strict';

// Retiring and restoring single memory gates: the plan both front ends run. Ported from the
// spin-off rampage (e5c0ee7, 2026-10-09) and adapted 2026-10-14 to per-agent gates.
//
// A gate is RETIRED by changing its memory's frontmatter `scope: global` to `scope: retired`,
// and RESTORED by the reverse. Nothing else in the memory changes, `agents:` included, and it
// stays in the store, where recall still finds it; it simply stops compiling, because recall.py
// compiles `scope: global` only. A retire is per memory, never per agent: a restored gate goes
// back to exactly the agents its `agents:` line names. This replaced an all-or-nothing control,
// where the one way to drop a gate was to remove every gate at once.
//
// recall.py makes the edit (`--gates-retire` / `--gates-restore`, after snapshotting the memory
// folder, which is not version controlled) and then recompiles, in the one store that compiles:
// memory.dir when it is set, else the store with the most memory files. Gates are installed only
// when they are switched on: a retire or restore never switches them on or off. This module
// decides only WHAT to ask for and in which order, and words the outcome. It spawns nothing and
// reads nothing, so the CLI (bin/wildcard-perms) and the extension run the same plan through
// their own process runner, and a test drives it with no Python at all.
//
// recall.py stays the one authority on what a gate is: the list planned against is its
// `--gates-list` output, and it re-validates every name before it writes. The checks here exist
// so that a refusal costs no snapshot and no second Python start, and so that both front ends
// refuse in the same words.

// Every agent recall.py compiles for, in its section order (recall.py GATE_AGENTS), and the
// instruction file each loads. Codex may load AGENTS.override.md instead; the name is the one
// people know the file by, and the CLI's status lines print the real path.
const GATE_AGENTS = ['claude', 'codex'];
const AGENT_FILES = { claude: 'CLAUDE.md', codex: 'AGENTS.md' };

// One gate as recall.py lists it: `state` is "active" (compiles for the agents it names),
// "excluded" (scope: global, but its `agents:` cannot be read, so it compiles for nobody: neither
// active nor retired) or "retired". Each state has exactly one scope, and a list whose fields
// contradict each other is refused rather than planned against, because which of two
// contradicting fields is the true one is not something this module can know.
const SCOPE_OF = { active: 'global', excluded: 'global', retired: 'retired' };

// Bad output from `recall.py --gates-list` throws, with a message that names the flag, so a
// caller can show it as it is. Returns `{ store, gates }`, each gate the object recall.py
// printed (file, scope, state, agents, problem, title, text, description).
function parseGatesList(stdout) {
  let data;
  try { data = JSON.parse(String(stdout)); }
  catch (error) { throw new Error(`recall.py --gates-list did not print JSON (${error.message})`); }
  if (!data || typeof data !== 'object' || !Array.isArray(data.gates)) {
    throw new Error('recall.py --gates-list printed JSON with no "gates" list');
  }
  for (const gate of data.gates) {
    if (!gate || typeof gate.file !== 'string' || !gate.file) {
      throw new Error('recall.py --gates-list printed a gate with no "file" name');
    }
    const disagree = (why) => new Error(`recall.py --gates-list printed ${gate.file} with ${why}`);
    if (!Object.prototype.hasOwnProperty.call(SCOPE_OF, gate.state) || gate.scope !== SCOPE_OF[gate.state]) {
      throw disagree(`state ${JSON.stringify(gate.state)} and scope ${JSON.stringify(gate.scope)}, which do not agree`);
    }
    if (!Array.isArray(gate.agents) || !gate.agents.every((agent) => GATE_AGENTS.includes(agent))) {
      throw disagree(`agents ${JSON.stringify(gate.agents)}, which are not agents recall.py compiles for`);
    }
    if (gate.problem !== null && (typeof gate.problem !== 'string' || !gate.problem)) {
      throw disagree(`problem ${JSON.stringify(gate.problem)}, which is neither null nor a reason`);
    }
    if (gate.state === 'active' && (gate.problem !== null || !gate.agents.length)) {
      throw disagree('state "active" and no agent it can be compiled for');
    }
    if (gate.state === 'excluded' && gate.problem === null) {
      throw disagree('state "excluded" and no reason it is left out');
    }
  }
  return { store: typeof data.store === 'string' ? data.store : '', gates: data.gates };
}

// A memory is named by its filename, with or without `.md`, as recall.py takes it, and
// otherwise exactly as spelled. No trim: ` lead.md` (a legal name on Windows) and `lead.md`
// are two memories, and a trim once planned the first as the second (rampage), so asking to
// retire one retired the other.
function normaliseName(name) {
  const text = String(name);
  return text.endsWith('.md') ? text : `${text}.md`;
}

// Once each, first spelling first. `retire a a.md` is one retirement: recall.py re-checks
// each file just before its own write, so a second entry for a file it has just retired
// would fail that re-check AFTER the first write, half way through the command.
function uniqueNames(names) {
  return [...new Set((names || []).map(normaliseName))];
}

const plural = (count) => `${count} gate${count === 1 ? '' : 's'}`;

// The names each agent loads from a list: the active gates that name it, in compile order.
function loadsOf(gates) {
  return Object.fromEntries(GATE_AGENTS.map((agent) => [agent,
    gates.filter((gate) => gate.state === 'active' && gate.agents.includes(agent)).map((gate) => gate.file)]));
}

// `{ retire, restore, activeBefore, activeAfter, agents, restoredLeftOut, retiredLeftOut }`, or
// `{ error, problems }` naming every bad name and why. A refusal is all or nothing, as
// recall.py's own is: one bad name among good ones refuses the whole request, so a typo never
// applies the rest of it.
//
// `agents` is per agent, `{ before, after, changed }`: the names it loads now and after the
// change, which is what "what loads next session" is computed from. Retiring a Codex-only gate
// changes `codex` alone. A gate left out for its `agents:` loads for nobody either side, so
// retiring one changes no agent (`retiredLeftOut`), and restoring one does not make it load
// (`restoredLeftOut`): recall.py allows both, because both move scope and nothing else.
function planGateChanges(gates, { retire = [], restore = [] } = {}) {
  const byFile = new Map((gates || []).map((gate) => [gate.file, gate]));
  const wanted = { retire: uniqueNames(retire), restore: uniqueNames(restore) };
  if (!wanted.retire.length && !wanted.restore.length) {
    const problem = 'nothing to retire or restore: name at least one memory';
    return { error: problem, problems: [problem] };
  }
  const problems = [];
  for (const [verb, names] of [['retire', wanted.retire], ['restore', wanted.restore]]) {
    for (const name of names) {
      if (verb === 'retire' && wanted.restore.includes(name)) {
        problems.push(`${name} is named both to retire and to restore`);
        continue;
      }
      if (verb === 'restore' && wanted.retire.includes(name)) continue; // said once, above
      const gate = byFile.get(name);
      if (!gate) {
        problems.push(`${name} is not a gate memory (no memory by that name in the compile store holds a gate block with scope global or retired)`);
      } else if (verb === 'retire' && gate.scope === 'retired') {
        problems.push(`${name} is already retired`);
      } else if (verb === 'restore' && gate.state === 'active') {
        problems.push(`${name} is already active`);
      } else if (verb === 'restore' && gate.state === 'excluded') {
        problems.push(`${name} is already scope: global; it loads for no agent because its agents: line cannot be read `
          + `(${markHidden(gate.problem)}), and a restore cannot change that: fix the line in the memory`);
      }
    }
  }
  if (problems.length) return { error: problems.join('; '), problems };
  const retiring = new Set(wanted.retire);
  const restoring = new Set(wanted.restore);
  const after = [...byFile.values()].map((gate) => {
    if (retiring.has(gate.file)) return { ...gate, scope: 'retired', state: 'retired' };
    if (restoring.has(gate.file)) return { ...gate, scope: 'global', state: gate.problem === null ? 'active' : 'excluded' };
    return gate;
  });
  const before = [...byFile.values()];
  const loadsBefore = loadsOf(before);
  const loadsAfter = loadsOf(after);
  return {
    retire: wanted.retire,
    restore: wanted.restore,
    activeBefore: before.filter((gate) => gate.state === 'active').length,
    activeAfter: after.filter((gate) => gate.state === 'active').length,
    agents: Object.fromEntries(GATE_AGENTS.map((agent) => [agent, {
      before: loadsBefore[agent],
      after: loadsAfter[agent],
      changed: loadsBefore[agent].join('\n') !== loadsAfter[agent].join('\n'),
    }])),
    retiredLeftOut: wanted.retire.filter((name) => byFile.get(name).state === 'excluded'),
    restoredLeftOut: wanted.restore.filter((name) => byFile.get(name).problem !== null)
      .map((name) => ({ file: name, problem: byFile.get(name).problem })),
  };
}

// Whether gates are switched on is the caller's to say, and every function below that words
// or decides an install needs it: `{ gatesOn: true | false }`. The two callers read it
// differently. The CLI has no setting, so it reads `--gates status`: on means a gates block is
// installed in some agent's instruction file. The extension reads its gates.enabled setting
// alone (from user settings, machine-scoped), the rule its activation follows, so with the
// setting on a change installs whether or not a block is there yet. It is required rather than
// defaulted, because either default is wrong half the time: `true` installs a block the user
// switched off, `false` leaves a retired gate resident.
function requireState(state, who) {
  if (!state || typeof state.gatesOn !== 'boolean') {
    throw new Error(`${who} needs the current state, { gatesOn: true | false }: whether gates are `
      + 'switched on decides what is installed');
  }
}

// The recall.py argument lists, in the order they run, and the install that follows them:
// `{ steps: [edit, compile], install: 'on' | 'off' | 'none' }`.
//
// The edit is ONE invocation even when it both retires and restores, so there is one
// snapshot and one validation pass for the whole request, and a refusal leaves every file as
// it was. Each name is its own `--gates-retire=<name>` / `--gates-restore=<name>`: argparse
// takes the value after `=` verbatim, so a memory named `-dash.md` is a name and not an
// option (spaced out, recall.py read it as a flag and refused the whole command), and the
// flags' `action="extend"` gathers every one of them.
//
// With no gate left active the compile needs `--gates-allow-empty`: without it recall.py
// refuses to empty a compiled file that still holds gates, the guard against a store pointed
// at by mistake. Here the empty result is the request.
//
// The install follows the state, and never changes it. Gates switched OFF: `none`, so the
// edit and the compile happen and nothing is written to an instruction file; the change takes
// effect when gates are turned on, which installs the fresh compile. Gates ON: `on`, which
// installs each agent's own section (an agent the compile gives no gates has its block
// removed), or `off` once no gate is left active for any agent, because setGatesAll refuses to
// install an empty compile (src/agent-gates.js, refusalFor): the blocks are removed instead. A
// caller must act on `none` by installing nothing at all: `setGatesAll(install === 'on')` would
// read it as `off` and remove a block.
function gateSteps(plan, state) {
  if (!plan || plan.error) throw new Error('gateSteps needs a plan from planGateChanges, not a refusal');
  requireState(state, 'gateSteps');
  const edit = [
    ...plan.retire.map((name) => `--gates-retire=${name}`),
    ...plan.restore.map((name) => `--gates-restore=${name}`),
  ];
  if (!edit.length) throw new Error('gateSteps needs a plan that retires or restores something');
  const compile = ['--gates-compile', ...(plan.activeAfter === 0 ? ['--gates-allow-empty'] : [])];
  const install = !state.gatesOn ? 'none' : plan.activeAfter > 0 ? 'on' : 'off';
  return { steps: [edit, compile], install };
}

// The confirmation the extension's panel shows before anything runs (the CLI asks nothing; the
// command line is the request): what changes, that the memory folder is snapshotted first, and
// what each agent's instruction file loads from the next session, CLAUDE.md and AGENTS.md each
// on its own line.
//
// `state` is `{ gatesOn, loadedNow, targets }`. `loadedNow` is `{ claude, codex }`, how many
// gates each agent's installed block holds today, which only the caller can read; a count is
// shown as `(N now)`, and one that is not an integer is left out rather than guessed. `targets`
// is the agents with an instruction file at all (every agent when it is not given), so a
// machine without Codex is not told about an AGENTS.md it does not have.
function describePlan(plan, state) {
  requireState(state, 'describePlan');
  const targets = Array.isArray(state.targets) ? GATE_AGENTS.filter((agent) => state.targets.includes(agent)) : GATE_AGENTS;
  const lines = [];
  if (plan.retire.length) lines.push(`Retire ${plural(plan.retire.length)}: ${plan.retire.join(', ')}`);
  if (plan.restore.length) lines.push(`Restore ${plural(plan.restore.length)}: ${plan.restore.join(', ')}`);
  lines.push('A snapshot of the memory folder is taken first.');
  if (!state.gatesOn) {
    lines.push('Gates are switched off, so nothing is installed and no gates load now. '
      + (plan.activeAfter === 0
        ? 'With no gate left active, none will load when gates are turned on either.'
        : 'The change takes effect when gates are turned on: '
          + targets.map((agent) => `${AGENT_FILES[agent]} will load ${plural(plan.agents[agent].after.length)}`).join(', ')
          + '.'));
  } else {
    lines.push('From the next session:');
    for (const agent of targets) {
      const { after, changed } = plan.agents[agent];
      const loaded = state.loadedNow ? state.loadedNow[agent] : undefined;
      const known = Number.isInteger(loaded) && loaded >= 0;
      const now = known ? ` (${loaded} now)` : '';
      const file = AGENT_FILES[agent];
      // A zero means no block is installed there: gates on before the first install, or after
      // `wildcard-perms --gates off`, or an agent no gate is for. Nothing to remove.
      if (!changed) lines.push(`  ${file}: not changed by this, ${plural(after.length)}${now}.`);
      else if (after.length) lines.push(`  ${file}: ${plural(after.length)} will load${now}.`);
      else if (known && loaded === 0) lines.push(`  ${file}: no gates load now, and none will; it holds no gates block, so nothing is removed.`);
      else lines.push(`  ${file}: no gates will load${now}, and its gates block is removed.`);
    }
  }
  for (const name of plan.retiredLeftOut || []) {
    lines.push(`${name} loads for no agent today (its agents: line cannot be read), so retiring it changes no instruction file.`);
  }
  for (const { file, problem } of plan.restoredLeftOut || []) {
    lines.push(`${file} is restored, but its agents: line cannot be read (${problem}), so it loads for no agent until that line is fixed.`);
  }
  return lines.join('\n');
}

// What `--gates-retire` / `--gates-restore` printed: `snapshot <dir>`, then one `retired <file>`
// or `restored <file>` per file written. Read whatever the exit status, because the lines are
// the record of what was WRITTEN: an edit that failed after its first write still names that
// file, and the caller must then say the memories changed rather than that nothing did.
function parseEditOutput(stdout) {
  const done = { snapshot: null, retired: [], restored: [] };
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = /^(snapshot|retired|restored) (.+)$/.exec(line.trim());
    if (!match) continue;
    if (match[1] === 'snapshot') done.snapshot = match[2];
    else done[match[1]].push(match[2]);
  }
  return done;
}

// The failure contract once the memories have been edited: a compile or install that fails
// AFTER the edit must not read like a refusal. The memories now say something the instruction
// files do not, so this says they changed, where the snapshot taken before the change is, and
// how to finish the job.
//
// How to finish depends on what the memories now hold and on whether gates are on, so the
// caller passes the `plan` and `gatesOn` as well as what recall.py printed. The default advice
// is the CLI's:
// - gates on, a gate still active: `wildcard-perms --gates refresh`, which compiles and installs.
// - gates on, no gate active: `wildcard-perms --gates off`, which removes the blocks whatever the
//   compiled file holds. refresh cannot: its compile is refused (or finds nothing), it then
//   installs whatever was last compiled or nothing, and the block, retired gate and all, stays
//   resident. When the compile did not complete, the compiled file still holds the retired
//   gates, so the empty compile is named too: without it a later `--gates on` would put them
//   back, and lint reports the compile stale.
// - gates off: nothing was installed and nothing should be. Only the compile is named, because
//   refresh would also switch gates on.
// `recall` is how to run recall.py from where the caller stands (default `recall.py`), which may
// carry quoted paths, so commands are set off in backticks, as the install refusals set theirs
// (src/agent-gates.js refusalFor). `advice`, when given, replaces the advice sentence outright:
// the extension's panel has one action that finishes every one of these cases.
// The active count is what was WRITTEN: after an edit that stopped part way, recall.py's lines
// say which files changed, and the plan's own count is not what the memories hold.
function changedButFailed({ stage, detail, snapshot, retired = [], restored = [], plan, gatesOn, recall = 'recall.py', advice }) {
  if (!plan || plan.error || typeof gatesOn !== 'boolean') {
    throw new Error('changedButFailed needs the plan and gatesOn: the advice depends on both');
  }
  const changed = [...retired.map((file) => `retired ${file}`), ...restored.map((file) => `restored ${file}`)];
  const active = stage === 'edit' ? plan.activeBefore - retired.length + restored.length : plan.activeAfter;
  const compiledStale = stage !== 'install';
  const compileCommand = `${recall} --gates-compile${active === 0 ? ' --gates-allow-empty' : ''}`;
  let next = typeof advice === 'string' && advice ? advice : null;
  if (!next && !gatesOn) {
    next = `Gates are switched off, so nothing was installed. Run \`${compileCommand}\` to compile the gates `
      + 'the memories now hold, so that turning gates on installs them.';
  } else if (!next && active > 0) {
    next = 'Run `wildcard-perms --gates refresh` to compile and install the gates the memories now hold.';
  } else if (!next) {
    next = 'No gate is active now, so run `wildcard-perms --gates off` to remove the gates blocks from CLAUDE.md and AGENTS.md'
      + (compiledStale ? `, and \`${compileCommand}\` to empty the compiled file, which still holds the retired gates` : '')
      + '.';
  }
  // recall.py's own messages end in a full stop, and this sentence adds its own.
  const reason = String(detail).trim().replace(/\.$/, '');
  return `the memories WERE changed (${changed.join(', ') || 'see the snapshot'}), but the ${stage} failed: ${reason}. `
    + `The memory folder was snapshotted first, to ${snapshot || '(recall.py named no snapshot)'}. ${next}`;
}

// Memory text is untrusted, and a terminal acts on control characters: an ESC in a title can
// recolour, retitle or clear the user's terminal, and a bidi override can reorder the line it
// sits on. Each becomes `?` for display. The JSON form passes recall.py's bytes through as they
// are, because a program reading it has to see the real file name.
//
// THE HIDDEN SET (2026-10-20), one for every place memory text is SHOWN: the terminal here and in
// bin/wildcard-perms, and the gates panel's page, modal and toasts (extension.js forDisplay). The
// C0 controls (a whole text keeps its line feeds and tabs), DEL and the C1 controls, the soft
// hyphen U+00AD, U+034F, the bidi controls U+061C, U+200E, U+200F, U+202A-U+202E and
// U+2066-U+2069, U+180E, the zero-width characters U+200B-U+200D, U+2060-U+206F, U+FEFF, the tag
// block U+E0000-U+E007F and the variation selectors U+E0100-U+E01EF, and a selector U+FE00-U+FE0F
// that does not directly follow a shown character which is not one, so the one in a warning sign
// shows and a run does not. Where recall.py REMOVES text it compiles (_THREAD_STRIP, _GATE_STRIP,
// _strip_hidden), a display MARKS: every character it removes is in this set, which
// test/threads-compile.sh checks code point by code point. Two lines that differ only in hidden
// characters therefore never read alike. Code points, so no hidden character sits in this source.
const HIDDEN_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x180e, 0x180e],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xe0000, 0xe007f], [0xe0100, 0xe01ef]];
const isSelector = (cp) => cp >= 0xfe00 && cp <= 0xfe0f;

// `text` with every hidden character as `?`, one per code point. `keepLines` keeps the line feed
// and the tab, for a whole message or a gate's text; a caller turns CRLF into a line feed first.
function markHidden(text, { keepLines = false } = {}) {
  let out = '';
  let last = null;   // the last code point shown as itself
  for (const ch of Array.from(String(text))) {
    const cp = ch.codePointAt(0);
    const hidden = !(keepLines && (cp === 0x0a || cp === 0x09))
      && (HIDDEN_RANGES.some(([from, to]) => cp >= from && cp <= to) || (isSelector(cp) && (last === null || isSelector(last))));
    if (hidden) {
      out += '?';
    } else {
      out += ch;
      last = cp;
    }
  }
  return out;
}
const forTerminal = (text) => markHidden(String(text || ''));

// `wildcard-perms --gates list`: one line per gate memory in recall.py's order (by filename,
// the compile order), then the counts and what each instruction file loads.
//   [x] file  title                    active, for every agent
//   [x] file  title  (codex only)      active, for the agents it names
//   [ ] file  title  (retired)         retired; a restore returns it to its agents
//   [-] file  title  (left out ...)    scope: global, but its agents: line cannot be read
function formatGateList({ gates }) {
  const only = (gate) => (gate.agents.length && gate.agents.length < GATE_AGENTS.length
    ? `${gate.agents.join(' + ')} only` : '');
  const lines = gates.map((gate) => {
    const notes = [];
    if (gate.state === 'retired') notes.push('retired');
    if (gate.problem !== null) notes.push(`${gate.state === 'excluded' ? 'left out for every agent' : 'its agents: line cannot be read'}: ${forTerminal(gate.problem)}`);
    else if (only(gate)) notes.push(only(gate));
    const mark = gate.state === 'active' ? '[x]' : gate.state === 'retired' ? '[ ]' : '[-]';
    const title = forTerminal(gate.title);
    return `${mark} ${forTerminal(gate.file)}${title ? `  ${title}` : ''}${notes.length ? `  (${notes.join('; ')})` : ''}`;
  });
  const count = (state) => gates.filter((gate) => gate.state === state).length;
  const loads = loadsOf(gates);
  lines.push(`${count('active')} active, ${count('retired')} retired`
    + `${count('excluded') ? `, ${count('excluded')} left out` : ''}; `
    + GATE_AGENTS.map((agent) => `${AGENT_FILES[agent]} loads ${loads[agent].length}`).join(', '));
  return `${lines.join('\n')}\n`;
}

module.exports = {
  parseGatesList, planGateChanges, gateSteps, describePlan,
  parseEditOutput, changedButFailed, formatGateList, markHidden,
};
