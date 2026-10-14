#!/usr/bin/env bash
# Behavioural tests for recall.py's per-gate verbs: --gates-list, --gates-retire and
# --gates-restore, the snapshot they take before any memory changes, and the --lint note that
# names retired gates. Ported from rampage e5c0ee7 (2026-10-09) and adapted 2026-10-14: AI
# Acolyte's data directory (~/.claude/wildcarding), its snapshot override
# (AI_ACOLYTE_GATE_SNAPSHOT_DIR), and per-agent gates (`agents:`), which a retire and a restore
# must leave byte for byte, and which --gates-list must carry.
#
# Not part of `node --test`: recall.py needs a Python with numpy + onnxruntime, so this runs as
# its own step, like test/recall-py.sh and test/gates-stale.sh. Locally that is the toolbox
# Python; in CI it is whatever interpreter the job installs those two into, named by
# TOOLBOX_PYTHON:
#
#   bash test/gates-manage.sh
#   TOOLBOX_PYTHON=/path/to/python bash test/gates-manage.sh
#
# A missing interpreter is a local SKIP and a CI FAILURE: under CI=true (which GitHub Actions
# sets) a skip that exits 0 would be a step that cannot fail.
#
# No ONNX model is required: none of these verbs constructs the embedder. Everything runs under a
# throwaway HOME with AI_ACOLYTE_GATE_SNAPSHOT_DIR inside it, so the real ~/.claude and the real
# memory store are never read or written. Every fixture is synthetic.
#
# Each test names the mutation that must make it fail. A test that cannot fail is not a test.
set -u

PY="${TOOLBOX_PYTHON:-${LOCALAPPDATA:-}/DevToolbox/python/.venv/Scripts/python.exe}"
HERE="$(cd "$(dirname "$0")" && pwd)"
RECALL="$HERE/../memory/recall.py"

# A path or a bare command name (`TOOLBOX_PYTHON=python3`) both count as present.
if ! [ -x "$PY" ] && ! command -v "$PY" >/dev/null 2>&1; then
  if [ "${CI:-}" = "true" ]; then
    echo "FAIL: python not found at $PY, and CI=true forbids skipping. Set TOOLBOX_PYTHON to a"
    echo "      Python that has numpy and onnxruntime."
    exit 1
  fi
  echo "skip: toolbox python not found at $PY (set TOOLBOX_PYTHON; under CI=true this fails)"
  exit 0
fi

fail() { echo "FAIL: $1"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
MEM="$TMP/memory"
SNAPS="$TMP/snaps"
GATES="$TMP/.claude/gates.generated.md"
LOCK="$TMP/.claude/wildcarding/gates-edit.lock"   # the gate-edit lock, under the throwaway HOME
mkdir -p "$TMP/.claude"
OS_NAME="$("$PY" -c 'import os; print(os.name)')"; OS_NAME="${OS_NAME//$'\r'/}"

# The four-variable incantation test/recall-py.sh uses: expanduser consults all of them, and the
# default snapshot root, the lock and GATES_OUT all resolve through it.
export HOME="$TMP" USERPROFILE="$TMP" HOMEDRIVE="${TMP%%/*}" HOMEPATH="${TMP#?}"
export RECALL_MEMORY_DIR="$MEM" RECALL_REEXEC=1 AI_ACOLYTE_GATE_SNAPSHOT_DIR="$SNAPS"

# stdout, stderr and the exit status captured SEPARATELY and in THIS shell: gates-stale.sh records
# what a pipeline does to `fail`. CRs are dropped because Python's stdout writes CRLF on Windows.
OUT="" ERR="" RC=0
recall() {
  OUT="$("$PY" "$RECALL" "$@" 2>"$TMP/stderr.txt")"
  RC=$?
  ERR="$(cat "$TMP/stderr.txt")"
  OUT="${OUT//$'\r'/}"
  ERR="${ERR//$'\r'/}"
}

# Every regular file in a dir with its sha256, sorted: the before/after witness for "wrote
# nothing". A temp file left behind shows up here as a new line.
state() {
  "$PY" -c 'import hashlib,os,sys
d = sys.argv[1]
for n in sorted(os.listdir(d)):
    p = os.path.join(d, n)
    if os.path.isfile(p):
        print(n, hashlib.sha256(open(p, "rb").read()).hexdigest())' "$1"
}

file_id() { "$PY" -c "import os,sys; print(os.stat(sys.argv[1]).st_ino)" "$1"; }

# The gate-edit lock's bytes, or "absent": a run must leave it exactly as it found it.
lock_state() { if [ -e "$LOCK" ]; then cat "$LOCK"; else echo absent; fi; }

SNAP_RE='^[0-9]{8}T[0-9]{6}Z-(retire|restore|retire\+restore)(-[0-9]+)?$'
# Snapshot DIRECTORIES under $SNAPS whose names this code mints, one per line.
snapdirs() {
  for d in "$SNAPS"/*; do [ -d "$d" ] && basename "$d"; done | grep -E "$SNAP_RE"
}
# The snapshot dir named on the first stdout line, as a bare name.
snap_name() { local line; line="$(printf '%s\n' "$OUT" | head -1)"; printf '%s' "${line##*[\\/]}"; }

# The harness imports recall.py and patches ONE seam, to play a second writer or a platform event
# no shell can time, then runs change_gate_scopes(names) and prints RETURNED or EXIT <message>:
#   discovery       a store discovery could not read, which compile_gates() also refuses on
#   race-snapshot   edits names[0] after validation, before the snapshot reads it
#   race-next       edits names[1] after names[0] was rewritten, before names[1]'s own re-check
#   race-stuck      as race-next, and edits names[0] too, so it cannot be put back
#   race-wait       names[0]'s first os.replace fails as if another writer held it open, and that
#                   writer saves an edit while this waits to retry
#   sloppy-rescope  a _rescope that also drops plain.md's description line (a future bug)
#   lock-stolen     another run takes over the gate-edit lock mid-command
#   lock-stuck      the gate-edit lock cannot be removed when the run ends
#   hold            stops after validation, holding the lock, until $HOLD_DIR/hold.go exists
#   prune-order     prints PRUNED <dir> for each snapshot the prune removes, in order
#   acl-volume      the volume says it stores no ACLs
cat > "$TMP/harness.py" <<'PY'
import importlib.util, json, os, shutil, sys, time
recall_path, mode, names = sys.argv[1], sys.argv[2], sys.argv[3:]
spec = importlib.util.spec_from_file_location("recall", recall_path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
def edit(stem):
    with open(os.path.join(m.MEMORY_DIR, stem + ".md"), "ab") as f:
        f.write(b"edited by another writer\n")
def at_snapshot(hook):
    real_root = m._snapshot_root
    def root():
        hook()
        return real_root()
    m._snapshot_root = root
if mode == "discovery":
    m._DISCOVERY_ERRORS.append((os.path.join(m.MEMORY_DIR, "unreadable"), PermissionError(13, "denied")))
elif mode == "race-snapshot":
    at_snapshot(lambda: edit(names[0]))
elif mode in ("race-next", "race-stuck"):
    real_write = m._write_bytes_atomic
    calls = []
    def write(path, data, *rest):
        real_write(path, data, *rest)
        calls.append(path)
        if len(calls) == 1:
            edit(names[1])
            if mode == "race-stuck":
                edit(names[0])
    m._write_bytes_atomic = write
elif mode == "race-wait":
    target = os.path.normcase(os.path.join(m.MEMORY_DIR, names[0] + ".md"))
    real_replace, failed = os.replace, []
    def replace(src, dst):
        if os.path.normcase(dst) == target and not failed:
            failed.append(dst)
            edit(names[0])
            raise PermissionError(13, "held open by another writer")
        return real_replace(src, dst)
    os.replace = replace
elif mode == "sloppy-rescope":
    real_rescope = m._rescope
    def sloppy(raw, want):
        out = real_rescope(raw, want)
        return out and out.replace(b"description: a global rule about the widget\n", b"")
    m._rescope = sloppy
elif mode == "lock-stolen":
    def steal():
        with open(m._gate_lock_path(), "w") as f:
            json.dump({"pid": 1, "owner": "another-run", "at": 0}, f)
    at_snapshot(steal)
elif mode == "lock-stuck":
    real_remove = os.remove
    def remove(path):
        if os.path.normcase(path) == os.path.normcase(m._gate_lock_path()):
            raise PermissionError(13, "held open")
        return real_remove(path)
    os.remove = remove
elif mode == "hold":
    hold = os.environ["HOLD_DIR"]
    def wait():
        open(os.path.join(hold, "hold.ready"), "w").close()
        for _ in range(600):
            if os.path.exists(os.path.join(hold, "hold.go")):
                return
            time.sleep(0.05)
    at_snapshot(wait)
elif mode == "prune-order":
    real_rmtree = shutil.rmtree
    def rmtree(path, *a, **k):
        print("PRUNED", os.path.basename(path), flush=True)
        return real_rmtree(path, *a, **k)
    shutil.rmtree = rmtree
elif mode == "acl-volume":
    m._volume_keeps_acls = lambda path: False
try:
    m.change_gate_scopes(names, [])
    print("RETURNED")
except SystemExit as e:
    print(f"EXIT {e.code}")
PY
HARNESS_OUT=""
harness() { HARNESS_OUT="$("$PY" "$TMP/harness.py" "$RECALL" "$@" 2>&1)"; HARNESS_OUT="${HARNESS_OUT//$'\r'/}"; }
with_edit() { cat "$1"; printf 'edited by another writer\n'; }

# Old snapshot dirs for the prune: mksnaps <root> <name>[=<op>,<kind>] ...  Each holds a marker
# file and, by kind, a manifest naming this store (ours, the default), this store spelled another
# way (alt: upper case on Windows and a trailing `/.`), ANOTHER store (other), no manifest (none),
# or a manifest that is not JSON (badjson). The store is computed as recall.py computes MEMORY_DIR.
cat > "$TMP/mksnaps.py" <<'PY'
import json, os, sys
root, specs = sys.argv[1], sys.argv[2:]
store = os.path.normpath(os.environ["RECALL_MEMORY_DIR"])
stores = {"ours": store, "alt": (store.upper() if os.name == "nt" else store) + os.sep + ".",
          "other": os.path.join(os.path.dirname(store), "other-store")}
os.makedirs(root, exist_ok=True)
for spec in specs:
    name, _, how = spec.partition("=")
    op, _, kind = (how or "retire,ours").partition(",")
    d = os.path.join(root, name)
    os.makedirs(d)
    with open(os.path.join(d, "marker.md"), "w") as f:
        f.write("old\n")
    if kind == "none":
        continue
    with open(os.path.join(d, "manifest.json"), "w", encoding="utf-8") as f:
        if kind == "badjson":
            f.write("not json\n")
        else:
            json.dump({"op": op, "store": stores[kind], "changed": ["plain.md"], "files": {}}, f)
PY
mksnaps() { "$PY" "$TMP/mksnaps.py" "$@" || fail "precondition: could not lay out the old snapshots"; }
# mksnaps names for <count> snapshots: snapnames <count> <stamp prefix> <suffix>
snapnames() { local i=0; while [ $i -lt "$1" ]; do printf "%s%02dZ-%s " "$2" "$i" "$3"; i=$((i + 1)); done; }

# ---------------------------------------------------------------- fixtures
# One template per axis the rewrite must preserve, each taking the scope VALUE as $1. The bytes
# expected after a retire are the same template run with "retired": an oracle that shares no code
# with recall.py's _rescope. Two carry a decoy a sloppier rewrite would hit instead: plain has
# "global" in its description ABOVE the scope line, nested has `scope: global` in a fenced example
# BELOW the frontmatter.
mk_plain()  { printf -- '---\nname: plain\ndescription: a global rule about the widget\nscope: %s\n---\n<!-- gate -->\n- **Plain rule.** Reset the widget cache first.\n<!-- /gate -->\n' "$1"; }
mk_crlf()   { printf -- '---\r\nname: crlf\r\ndescription: a gadget rule, CRLF throughout\r\nscope: %s  \r\n---\r\n<!-- gate -->\r\n- **CRLF rule.** The line endings stay CRLF.\r\n<!-- /gate -->\r\n' "$1"; }
mk_bom()    { printf '\xEF\xBB\xBF'; printf -- '---\nname: bom\nmetadata:\n  scope: %s\n---\n<!-- gate -->\n- **BOM rule.** Written by a PowerShell one-liner.\n<!-- /gate -->\n' "$1"; }
mk_nested() { printf -- '---\nname: nested\nmetadata:\n    type: feedback\n    scope: %s\n    origin: synthetic\n---\n<!-- gate -->\n- **Nested rule.** Four-space indent under metadata.\n<!-- /gate -->\n\nHow to declare one:\n\n```yaml\nscope: global\n```\n' "$1"; }
mk_dquote() { printf -- '---\nname: dquote\nmetadata:\n  scope: "%s"\n---\n<!-- gate -->\n- **Double-quoted rule.** The quotes stay.\n<!-- /gate -->\n' "$1"; }
mk_squote() { printf -- "---\nname: squote\nmetadata:\n  scope: '%s'\n---\n<!-- gate -->\n- **Single-quoted rule.** The quotes stay.\n<!-- /gate -->\n" "$1"; }
mk_combo()  { printf '\xEF\xBB\xBF'; printf -- '---\r\nname: combo\r\nmetadata:\r\n  type: reference\r\n  scope: "%s"\r\n---\r\n<!-- gate -->\r\n- **Combined rule.** BOM, CRLF, nesting and quotes at once.\r\n<!-- /gate -->\r\n' "$1"; }
# Not UTF-8 at all: a Latin-1 byte and a lone 0xFF in the frontmatter, a stray continuation byte in
# the body. Only a decode that keeps every byte (surrogateescape) gives these back.
mk_bytes()  { printf -- '---\nname: caf\xe9 \xff\nmetadata:\n  scope: %s\n---\n<!-- gate -->\n- **Raw bytes.** A stray \x80 stays where it is.\n<!-- /gate -->\n' "$1"; }
# A lone CR right AFTER the value. The compiler's reader (universal newlines) ends the scope line
# there; a search that ran to the next LF took the rest of that line as part of the value, so a
# retire deleted the next key (cr_key), the frontmatter's closing fence (cr_fence: the body's own
# `---` rule then closed it), or the closing quote and the next key (cr_quote).
mk_cr_key()   { printf -- '---\nname: cr_key\nmetadata:\n  scope: %s\r  type: feedback\n  origin: synthetic\n---\n<!-- gate -->\n- **CR after the value.** The next key survives.\n<!-- /gate -->\n' "$1"; }
mk_cr_fence() { printf -- '---\nname: cr_fence\nscope: %s\r---\n<!-- gate -->\n- **CR before the fence.** The fence survives.\n<!-- /gate -->\n\nSome prose.\n\n---\n\ndescription: body text after a rule\n' "$1"; }
mk_cr_quote() { printf -- '---\nname: cr_quote\nmetadata:\n  scope: "%s"\r  type: reference\n---\n<!-- gate -->\n- **Quoted, then a CR.** Both quotes survive.\n<!-- /gate -->\n' "$1"; }
# Per-agent gates (`agents:`). A retire rewrites the scope value and nothing else, so each of
# these must come back with its agents: line exactly as it was, and a restored gate returns to the
# agents it named. A flow list after the scope; a CRLF block list before it; an agents: key right
# after a lone CR, which the compiler reads as a line of its own; and a gate whose agents: names an
# agent the compiler does not know, which compiles for nobody and may still be retired and restored.
mk_agents_flow()  { printf -- '---\nname: agents_flow\nmetadata:\n  scope: %s\n  agents: [codex]\n---\n<!-- gate -->\n- **Codex-only flow list.** Kept out of CLAUDE.md.\n<!-- /gate -->\n' "$1"; }
mk_agents_block() { printf -- '---\r\nname: agents_block\r\nmetadata:\r\n  agents:\r\n  - claude\r\n  scope: "%s"\r\n---\r\n<!-- gate -->\r\n- **Claude-only block list.** Kept out of AGENTS.md.\r\n<!-- /gate -->\r\n' "$1"; }
mk_cr_agents()    { printf -- '---\nname: cr_agents\nmetadata:\n  scope: %s\r  agents: [codex]\n---\n<!-- gate -->\n- **Agents after a lone CR.** The key survives the CR.\n<!-- /gate -->\n' "$1"; }
mk_excluded()     { printf -- '---\nname: excluded\nmetadata:\n  scope: %s\n  agents: [codex, gemini]\n---\n<!-- gate -->\n- **Unknown agent.** Left out for every agent.\n<!-- /gate -->\n' "$1"; }
ROUND_TRIP='plain crlf bom nested dquote squote combo bytes cr_key cr_fence cr_quote agents_flow agents_block cr_agents excluded'

seed() {
  rm -rf "$MEM"
  mkdir -p "$MEM"
  for f in $ROUND_TRIP; do "mk_$f" global > "$MEM/$f.md"; done
  printf -- '---\nname: retired_one\nmetadata:\n  scope: retired\n  agents: [claude]\n---\n<!-- gate -->\n- **Retired rule.** Kept in the store, not compiled.\n<!-- /gate -->\n' > "$MEM/retired_one.md"
  printf -- '---\nname: project_only\nmetadata:\n  scope: project-alpha\n---\n<!-- gate -->\n- **Project rule.** Installed by hand.\n<!-- /gate -->\n' > "$MEM/project_only.md"
  printf -- '---\nname: no_block\nmetadata:\n  scope: global\n---\nA standing order that never got its gate markers.\n' > "$MEM/no_block.md"
  printf -- '---\nname: half_block\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **Half a gate.** Nobody wrote the closing marker.\n' > "$MEM/half_block.md"
  printf -- '---\nname: Upper_case\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **Upper-case filename.** Sorts before every lower-case one.\n<!-- /gate -->\n' > "$MEM/Upper_case.md"
  { printf -- '---\nname: long_title\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **Long title.** '
    printf 'widget %.0s' $(seq 1 40)
    printf '\n<!-- /gate -->\n'; } > "$MEM/long_title.md"
  # The index carries a scope and a paired block on purpose: the compiler skips it whatever it
  # says, so the gate verbs must too.
  printf -- '---\nscope: global\n---\n# Memory Index\n<!-- gate -->\n- **Index block.** Never compiled.\n<!-- /gate -->\n' > "$MEM/MEMORY.md"
  printf '{"embed": "bge-small-onnx", "files": {}}' > "$MEM/recall_index.json"
}

# ---------------------------------------------------------------- --gates-list
# Mutations, one assertion each:
#   drop `and n not in EXCLUDE` from _gate_files         -> "listed the index"
#   drop the GATE_SCOPES test in _gate_entry             -> "listed project_only.md"
#   match an opening marker alone instead of GATE_BLOCK  -> "listed half_block.md"
#   drop the sorted() in _gate_files                     -> "not in compile order" (NTFS; see below)
#   drop .replace("**", "") from the title               -> "title for plain.md"
#   drop the [:160] from the title                       -> "long_title.md title"
#   call a gate whose agents: cannot be read "active"    -> "as state 'active'" for excluded.md, and
#       "active is not what the compiler compiles"
#   drop "agents" or "problem" from the entry            -> "has keys"
#   read agents: with anything but _gate_agents          -> "the agents of"
seed
recall --gates-list
[ "$RC" = "0" ] || fail "--gates-list exited $RC: $ERR"
printf '%s' "$OUT" > "$TMP/list.json"
LIST_CHECK="$("$PY" - "$TMP/list.json" "$MEM" "$RECALL" <<'PY'
import importlib.util, json, os, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
mem = sys.argv[2]
def bad(msg):
    print(msg)
    sys.exit(1)
if list(data) != ["store", "gates"]:
    bad(f"--gates-list top-level keys are {list(data)}, wanted store and gates")
if not os.path.samefile(data["store"], mem):
    bad(f"--gates-list store is {data['store']}, not the corpus it read")
files = [g["file"] for g in data["gates"]]
want = sorted(["plain.md", "crlf.md", "bom.md", "nested.md", "dquote.md", "squote.md",
               "combo.md", "bytes.md", "cr_key.md", "cr_fence.md", "cr_quote.md",
               "agents_flow.md", "agents_block.md", "cr_agents.md", "excluded.md",
               "retired_one.md", "Upper_case.md", "long_title.md"])
if "MEMORY.md" in files:
    bad("--gates-list listed the index, which the compiler never compiles")
if "project_only.md" in files:
    bad("--gates-list listed project_only.md, whose scope is neither global nor retired")
if "no_block.md" in files:
    bad("--gates-list listed no_block.md, which holds no gate block")
if "half_block.md" in files:
    bad("--gates-list listed half_block.md, whose gate block is never closed, so it never compiles")
if sorted(files) != want:
    bad(f"--gates-list listed {sorted(files)}, wanted {want}")
disk = [n for n in os.listdir(mem) if n in want]
if disk == want:
    print("DEGRADED: this filesystem lists the fixture already sorted, so the order check below")
    print("          cannot tell a sorted walk from an unsorted one.")
elif files != want:
    bad(f"--gates-list is not in compile order (sorted by filename): {files}")
KEYS = ["file", "scope", "state", "agents", "problem", "title", "text", "description"]
EVERY = ["claude", "codex"]
AGENTS = {"agents_flow.md": ["codex"], "agents_block.md": ["claude"], "cr_agents.md": ["codex"],
          "retired_one.md": ["claude"], "excluded.md": []}
by = {}
for g in data["gates"]:
    if list(g) != KEYS:
        bad(f"--gates-list entry for {g.get('file')} has keys {list(g)}, wanted {KEYS}")
    scope = "retired" if g["file"] == "retired_one.md" else "global"
    state = "retired" if scope == "retired" else ("excluded" if g["file"] == "excluded.md" else "active")
    if g["scope"] != scope or g["state"] != state:
        bad(f"--gates-list has {g['file']} as scope {g['scope']!r}, state {g['state']!r}; wanted {scope!r}, {state!r}")
    if g["agents"] != AGENTS.get(g["file"], EVERY):
        bad(f"--gates-list has the agents of {g['file']} as {g['agents']}, wanted {AGENTS.get(g['file'], EVERY)}")
    if (g["problem"] is None) != (g["file"] != "excluded.md"):
        bad(f"--gates-list has the problem of {g['file']} as {g['problem']!r}")
    by[g["file"]] = g
if "gemini" not in by["excluded.md"]["problem"]:
    bad(f"excluded.md's problem does not name the unknown agent: {by['excluded.md']['problem']!r}")
p = by["plain.md"]
if p["title"] != "Plain rule. Reset the widget cache first.":
    bad(f"--gates-list title for plain.md is {p['title']!r}: bullet and ** not stripped")
if p["text"] != "- **Plain rule.** Reset the widget cache first.":
    bad(f"--gates-list text for plain.md is {p['text']!r}, not the gate block body")
if p["description"] != "a global rule about the widget":
    bad(f"--gates-list description for plain.md is {p['description']!r}")
t = by["long_title.md"]["title"]
if len(t) != 160 or not t.startswith("Long title. widget widget"):
    bad(f"--gates-list long_title.md title is {len(t)} chars, wanted the first 160: {t!r}")
# "active" is what the compiler compiles, for each agent: the list is planned against, so a
# disagreement would let the panel promise a CLAUDE.md the compile does not write.
spec = importlib.util.spec_from_file_location("recall", sys.argv[3])
recall = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recall)
_, names, per_agent, excluded = recall._compile_gates_text()
active = [g["file"] for g in data["gates"] if g["state"] == "active"]
if active != names:
    bad(f"active is not what the compiler compiles: listed {active}, compiled {names}")
for agent in EVERY:
    listed = [g["file"] for g in data["gates"] if g["state"] == "active" and agent in g["agents"]]
    if listed != per_agent[agent]:
        bad(f"for {agent}, listed {listed}, compiled {per_agent[agent]}")
if [n for n, _ in excluded] != [g["file"] for g in data["gates"] if g["state"] == "excluded"]:
    bad(f"excluded is not what the compiler leaves out: {excluded}")
print("ok")
PY
)" || fail "$LIST_CHECK"
printf '%s\n' "$LIST_CHECK" | grep '^DEGRADED' || true
echo "ok: --gates-list prints every global and retired gate as JSON, in compile order, with its agents"

# ---------------------------------------------------------------- retire and restore, byte for byte
# Mutations, each failing on the fixture named:
#   strip only whitespace from _rescope's span (drop the '"' and "'" passes) -> cmp of dquote
#   normalise CRLF to LF before _rescope edits the text                      -> cmp of crlf
#   drop chr(0xFEFF) from _rescope's lstrip (the BOM file is then refused)    -> "--gates-retire exited 1"
#   str.replace the first "global" in the file instead of the located span    -> "--gates-retire exited 1"
#       (plain's description decoy takes the hit, and the _fm read-back refuses the run)
#   take the LAST scope: line in the file instead of the first in the block  -> "--gates-retire exited 1"
#       (nested's fenced decoy takes the hit, and the read-back refuses it the same way)
#   write through open(path, "wb") in place instead of temp + os.replace      -> "rewritten IN PLACE"
#   _rescope's value pattern back to `(.+)$`, which runs past a lone CR       -> "--gates-retire exited 1"
#       (cr_key, cr_fence, cr_quote and cr_agents: the reversibility backstop refuses all four, so
#       nothing is written; with the backstop dropped as well, the cmp of cr_key fails instead)
#   decode with errors="replace" instead of "surrogateescape" in _rescope     -> "--gates-retire exited 1"
#       (bytes: the round trip no longer gives back raw, so the backstop refuses; with the backstop
#       dropped as well, the cmp of bytes fails)
#   rewrite agents: to every agent on retire (a per-agent retire)              -> cmp of agents_flow
#   drop the _drop_gate_lock() in change_gate_scopes's finally                -> "left the gate-edit lock"
seed
rm -rf "$TMP/before"
mkdir -p "$TMP/before"
cp "$MEM"/*.md "$TMP/before/"
# The axes must actually be present, or the round trip proves nothing about them.
# Counted with tr, not grep: Git for Windows' grep drops the CR before matching.
[ "$(tr -cd '\r' < "$MEM/crlf.md" | wc -c | tr -d ' ')" -gt 0 ] || fail "precondition: crlf.md holds no CR"
[ "$(head -c 3 "$MEM/bom.md" | od -An -tx1 | tr -d ' \n')" = "efbbbf" ] \
  || fail "precondition: bom.md does not start with a UTF-8 BOM"
grep -q '^    scope: global$' "$MEM/nested.md" || fail "precondition: nested.md does not nest scope four deep"
grep -q '^  scope: "global"$' "$MEM/dquote.md" || fail "precondition: dquote.md does not double-quote its scope"
grep -q "^  scope: 'global'\$" "$MEM/squote.md" || fail "precondition: squote.md does not single-quote its scope"
AXES="$("$PY" - "$MEM" <<'PY'
import os, sys
mem = sys.argv[1]
read = lambda n: open(os.path.join(mem, n), "rb").read()
try:
    read("bytes.md").decode("utf-8")
    print("bytes.md is valid UTF-8")
except UnicodeDecodeError:
    pass
for name, needle in (("cr_key.md", b"global\r  type"), ("cr_fence.md", b"global\r---"),
                     ("cr_quote.md", b'"global"\r  type'), ("cr_agents.md", b"global\r  agents: [codex]"),
                     ("agents_flow.md", b"  agents: [codex]\n"), ("agents_block.md", b"  agents:\r\n  - claude\r\n")):
    if needle not in read(name):
        print(f"{name} does not hold {needle!r}")
PY
)"
[ -z "$AXES" ] || fail "precondition: $AXES"

ID_BEFORE="$(file_id "$MEM/plain.md")"
[ -n "$ID_BEFORE" ] || fail "precondition: could not read plain.md's file id, so atomicity is untestable"
recall --gates-retire $ROUND_TRIP
[ "$RC" = "0" ] || fail "--gates-retire exited $RC: $ERR"
case "$(printf '%s\n' "$OUT" | head -1)" in
  "snapshot "*) ;;
  *) fail "the first line of --gates-retire is not 'snapshot <dir>': $OUT" ;;
esac
EXPECT="$(for f in $ROUND_TRIP; do echo "retired $f.md"; done)"
[ "$(printf '%s\n' "$OUT" | sed 1d)" = "$EXPECT" ] \
  || fail "--gates-retire did not print one 'retired <file>' line per file, in order: $OUT"
for f in $ROUND_TRIP; do
  "mk_$f" retired > "$TMP/expect.md"
  cmp -s "$MEM/$f.md" "$TMP/expect.md" || fail "retiring $f.md changed more than its scope value"
done
for f in retired_one project_only no_block half_block Upper_case long_title MEMORY; do
  cmp -s "$MEM/$f.md" "$TMP/before/$f.md" || fail "retiring the round-trip set touched $f.md"
done
ID_AFTER="$(file_id "$MEM/plain.md")"
[ "$ID_BEFORE" != "$ID_AFTER" ] \
  || fail "plain.md was rewritten IN PLACE (file id $ID_AFTER unchanged), not through a temp file and os.replace"
for residue in "$MEM"/*.tmp; do
  [ -e "$residue" ] && fail "a successful retire left $residue behind"
done
[ -e "$LOCK" ] && fail "a successful retire left the gate-edit lock $LOCK behind"
RETIRE_SNAP="$(snap_name)"
echo "ok: retiring rewrites only the scope value, across CRLF, a BOM, nesting, quotes and agents:"

recall --gates-restore $(for f in $ROUND_TRIP; do printf '%s.md ' "$f"; done)
[ "$RC" = "0" ] || fail "--gates-restore exited $RC: $ERR"
EXPECT="$(for f in $ROUND_TRIP; do echo "restored $f.md"; done)"
[ "$(printf '%s\n' "$OUT" | sed 1d)" = "$EXPECT" ] \
  || fail "--gates-restore did not print one 'restored <file>' line per file, in order: $OUT"
for f in $ROUND_TRIP; do
  cmp -s "$MEM/$f.md" "$TMP/before/$f.md" || fail "restoring $f.md did not give back its original bytes"
done
RESTORE_SNAP="$(snap_name)"
echo "ok: restoring gives back the original file byte for byte, agents: included"

# ---------------------------------------------------------------- the snapshot and its manifest
# Mutations, one assertion each:
#   take the snapshot AFTER the rewrites instead of before   -> "--gates-retire exited 1" in the
#       round trip above: the `moved` guard in _write_snapshot sees files that no longer hold the
#       validated bytes and refuses ("changed while this command ran"), so check_snapshot's own
#       "is not the bytes from before" is never reached by this mutation
#   copy every file, recall_index.json included              -> "holds recall_index.json"
#   hash something other than the copied bytes               -> "manifest hash for"
#   a snapshot root other than AI_ACOLYTE_GATE_SNAPSHOT_DIR  -> "is not under AI_ACOLYTE_GATE_SNAPSHOT_DIR"
check_snapshot() {   # check_snapshot <dir name> <op> <dir holding the before-image> <changed, space-separated>
  printf '%s\n' "$1" | grep -Eq "^[0-9]{8}T[0-9]{6}Z-$(printf '%s' "$2" | sed 's/+/\\+/')(-[0-9]+)?\$" \
    || fail "snapshot dir '$1' is not named <UTC YYYYmmddTHHMMSSZ>-$2"
  [ -d "$SNAPS/$1" ] || fail "snapshot $1 is not under AI_ACOLYTE_GATE_SNAPSHOT_DIR"
  SNAP_CHECK="$("$PY" - "$SNAPS/$1" "$3" "$4" "$MEM" "$2" <<'PY'
import hashlib, json, os, sys
snap, before, changed, mem, op = sys.argv[1], sys.argv[2], sys.argv[3].split(), sys.argv[4], sys.argv[5]
def bad(msg):
    print(msg)
    sys.exit(1)
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
names = sorted(os.listdir(before))
got = sorted(n for n in os.listdir(snap) if n != "manifest.json")
if "recall_index.json" in got:
    bad("the snapshot holds recall_index.json, which is a cache, not a memory")
if got != names:
    bad(f"the snapshot holds {got}, wanted every *.md in the store: {names}")
for n in names:
    if open(os.path.join(snap, n), "rb").read() != open(os.path.join(before, n), "rb").read():
        bad(f"the snapshot copy of {n} is not the bytes from before the change")
man = json.load(open(os.path.join(snap, "manifest.json"), encoding="utf-8"))
if list(man) != ["op", "store", "changed", "files"]:
    bad(f"manifest keys are {list(man)}")
if man["op"] != op:
    bad(f"manifest op is {man['op']!r}, wanted {op!r}")
if not os.path.samefile(man["store"], mem):
    bad(f"manifest store is {man['store']}, not the corpus")
if man["changed"] != changed:
    bad(f"manifest changed is {man['changed']}, wanted {changed}")
if sorted(man["files"]) != names:
    bad(f"manifest files are {sorted(man['files'])}, wanted {names}")
for n in names:
    if man["files"][n] != sha(os.path.join(before, n)) or man["files"][n] != sha(os.path.join(snap, n)):
        bad(f"manifest hash for {n} is not the sha256 of its bytes")
print("ok")
PY
)" || fail "$SNAP_CHECK"
}
# Both snapshots so far were taken over the same pre-image: the restore ran on the retired files,
# so its own before-image is the retired set, which `before-retired` reconstructs.
check_snapshot "$RETIRE_SNAP" retire "$TMP/before" "$(for f in $ROUND_TRIP; do printf '%s.md ' "$f"; done)"
rm -rf "$TMP/before-retired"
cp -r "$TMP/before" "$TMP/before-retired"
for f in $ROUND_TRIP; do "mk_$f" retired > "$TMP/before-retired/$f.md"; done
check_snapshot "$RESTORE_SNAP" restore "$TMP/before-retired" "$(for f in $ROUND_TRIP; do printf '%s.md ' "$f"; done)"

recall --gates-retire plain --gates-restore retired_one
[ "$RC" = "0" ] || fail "--gates-retire with --gates-restore exited $RC: $ERR"
[ "$(printf '%s\n' "$OUT" | sed 1d)" = "$(printf 'retired plain.md\nrestored retired_one.md')" ] \
  || fail "a combined run did not print its retired and restored lines: $OUT"
check_snapshot "$(snap_name)" "retire+restore" "$TMP/before" "plain.md retired_one.md"
echo "ok: the snapshot is a byte copy of every memory taken before the change, with a true manifest"

# ---------------------------------------------------------------- refusals write nothing
# Mutations, each failing on the label named:
#   delete the `if problems: sys.exit(...)`, so bad names are skipped  -> "unknown name"
#   validate each file just before its own write instead of all first  -> "one bad name among good"
#   drop the `both` test                                               -> "a name in both lists"
#   drop the `name not in walked` test                                 -> "the index"
#   drop the os.path.basename test                                     -> "a path"
#   report only the first problem                                      -> "named only the first"
refused() {   # refused <label> <stderr substring> <recall args...>
  local label="$1" want="$2" before snaps_before lock_before
  shift 2
  before="$(state "$MEM")"
  snaps_before="$(ls -1 "$SNAPS" 2>/dev/null)"
  lock_before="$(lock_state)"
  recall "$@"
  [ "$RC" = "1" ] || fail "$label: exited $RC, wanted a refusal (1). stderr: $ERR"
  printf '%s\n' "$ERR" | grep -qF -- "$want" || fail "$label: stderr does not say '$want': $ERR"
  [ "$(state "$MEM")" = "$before" ] || fail "$label: the refusal wrote to the store"
  [ "$(ls -1 "$SNAPS" 2>/dev/null)" = "$snaps_before" ] || fail "$label: the refusal left a snapshot behind"
  [ -z "$OUT" ] || fail "$label: a refusal printed to stdout: $OUT"
  [ "$(lock_state)" = "$lock_before" ] || fail "$label: the refusal did not leave the gate-edit lock as it found it"
}
seed
refused "unknown name"            "no_such.md: no such memory"              --gates-retire no_such
refused "not a gate"              "no_block.md: holds no"                   --gates-retire no_block
refused "retire, already retired" "retired_one.md: is already retired"      --gates-retire retired_one
refused "restore, already global" "plain.md: is already scope: global, not retired" --gates-restore plain
refused "restore, a gate left out for its agents:" "excluded.md: is already scope: global" --gates-restore excluded
refused "another scope"           "project_only.md: has scope: project-alpha" --gates-retire project_only
refused "the index"               "MEMORY.md: is the index"                 --gates-retire MEMORY
refused "a path"                  "plain.md: is a path"                     --gates-retire ../memory/plain
refused "one bad name among good" "no_such.md: no such memory"              --gates-retire plain crlf no_such
refused "a name in both lists"    "plain.md: named in both"                 --gates-retire plain --gates-restore plain
refused "two bad names"           "no_such.md: no such memory"              --gates-retire no_such no_block
printf '%s\n' "$ERR" | grep -qF "no_block.md: holds no" \
  || fail "a refusal over two bad names named only the first: $ERR"

# A lone CR is a line break to the compiler's reader (universal newlines) and not to the byte-level
# search _rescope runs, so here the two disagree about which `scope:` line is the first: _fm reads
# the one after the CR, the search finds the next one. Both say `global`, so the rewrite reverses
# exactly and the reversibility backstop passes it; only the _fm read-back sees that the compiler
# would still read `global`, and it must refuse rather than report "retired" over a live gate.
# Mutation: drop the `_fm(_as_compiler_reads(new), "scope") != want` read-back -> "lone CR: exited 0".
printf -- '---\nname: lone_cr\rscope: global\nscope: global\n---\n<!-- gate -->\n- **Lone CR.** Two readers, two first lines.\n<!-- /gate -->\n' > "$MEM/lone_cr.md"
refused "lone CR" "lone_cr.md: its scope: line could not be located" --gates-retire lone_cr
rm -f "$MEM/lone_cr.md"
echo "ok: an unknown name, a non-gate, a wrong state, the index, a path or a clash refuses, writing nothing"

# ---------------------------------------------------------------- links are refused, never replaced
# os.replace swaps the NAME for a new file, so a rewrite through a link replaced the link with a
# plain copy and left its target at scope: global, and no snapshot (bytes only) could put the link
# back. Each kind is refused before anything is written, and its target is untouched.
#   hard.md     a second name for a file outside the store (os.link works unprivileged everywhere)
#   soft.md     a file symlink to it, where this platform lets an unprivileged user make one
#   dirlink.md  a directory link named like a memory: a junction on Windows, a symlink elsewhere
# Mutations, one assertion each:
#   drop the st_nlink test in _link_problem                -> "a hard link: exited 0"
#   drop the realpath test in _link_problem                -> "a directory link named like a memory:
#       stderr does not say" (it is then refused only as unreadable), and "a symbolic link: exited 0"
#       where soft.md exists
seed
rm -rf "$TMP/outside"
mkdir -p "$TMP/outside/dir"
mk_plain global > "$TMP/outside/shared.md"
cp "$TMP/outside/shared.md" "$TMP/shared.before"
LINKS="$("$PY" - "$TMP/outside" "$MEM" <<'PY'
import os, sys
out, mem = sys.argv[1], sys.argv[2]
made = ["hard"]
os.link(os.path.join(out, "shared.md"), os.path.join(mem, "hard.md"))
try:
    os.symlink(os.path.join(out, "shared.md"), os.path.join(mem, "soft.md"))
    made.append("soft")
except OSError as e:
    print(f"DEGRADED: no file symlink can be made here ({e.strerror}), so the symbolic-link refusal")
    print("          is checked through the directory link only.")
if os.name == "nt":
    import _winapi
    _winapi.CreateJunction(os.path.join(out, "dir"), os.path.join(mem, "dirlink.md"))
else:
    os.symlink(os.path.join(out, "dir"), os.path.join(mem, "dirlink.md"), target_is_directory=True)
made.append("dirlink")
print("MADE " + " ".join(made))
PY
)" || fail "precondition: could not make the links: $LINKS"
LINKS="${LINKS//$'\r'/}"
printf '%s\n' "$LINKS" | grep '^DEGRADED\|^  ' || true
MADE="$(printf '%s\n' "$LINKS" | sed -n 's/^MADE //p')"
refused "a hard link" "hard.md: has 2 hard links" --gates-retire hard
case " $MADE " in
  *" soft "*) refused "a symbolic link" "soft.md: is a symbolic link or junction" --gates-retire soft ;;
esac
refused "a directory link named like a memory" "dirlink.md: is a symbolic link or junction" --gates-retire dirlink
cmp -s "$TMP/outside/shared.md" "$TMP/shared.before" || fail "a refused link still changed its target"
"$PY" - "$MEM" <<'PY' || fail "could not remove the test links"
import os, sys
mem = sys.argv[1]
for name in ("hard.md", "soft.md"):
    if os.path.lexists(os.path.join(mem, name)):
        os.unlink(os.path.join(mem, name))
link = os.path.join(mem, "dirlink.md")
os.rmdir(link) if os.name == "nt" else os.unlink(link)    # the link, never what it points at
PY
[ -f "$TMP/outside/shared.md" ] && [ -d "$TMP/outside/dir" ] || fail "removing the links removed a target"
echo "ok: every link made here ($MADE) is refused, and its target is untouched"

# ---------------------------------------------------------------- an ACL set on the file is refused
# A rewrite is a new file, and on Windows a new file takes the folder's inherited ACL, so a memory
# whose own ACL was set by hand lost it: one user's Modify became the folder's defaults. It is
# refused instead. Every other fixture in this file has only inherited entries and is NOT refused,
# which is the check that this does not fire on an ordinary file.
# Mutations, one assertion each:
#   _acl_problem returns None at once                        -> "an ACL set on the file: exited 0"
#   drop the `not dacl.value` test                           -> "a NULL DACL: stderr does not say"
#   drop the `not _volume_keeps_acls(path)` test             -> "a volume that keeps no ACLs"
if [ "$OS_NAME" = "nt" ]; then
  seed
  mk_plain global > "$MEM/acl.md"
  ACL_SET="$("$PY" - "$MEM/acl.md" <<'PY'
import subprocess, sys
sid = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"], capture_output=True,
                     text=True).stdout.strip().split(",")[-1].strip('"')
r = subprocess.run(["icacls", sys.argv[1], "/inheritance:r", "/grant:r", f"*{sid}:(M)"],
                   capture_output=True, text=True)
shown = subprocess.run(["icacls", sys.argv[1]], capture_output=True, text=True).stdout
if r.returncode or "(I)" in shown:
    print(f"icacls did not set an explicit ACL (exit {r.returncode}): {shown.strip()}")
PY
)"
  [ -z "$ACL_SET" ] || fail "precondition: $ACL_SET"
  refused "an ACL set on the file" "acl.md: has access rules of its own" --gates-retire acl
  # No DACL at all ("No permissions are set. All users have full control"), which is a choice too.
  # SetFileSecurityW applies the descriptor as given, so the DACL is NULL and NOT protected (control
  # 0x8004, measured by rampage): only the NULL test can see it. SetNamedSecurityInfoW marks a NULL
  # DACL protected (0x9404), which the protected test would catch on its own.
  mk_plain global > "$MEM/nulldacl.md"
  NULL_SET="$("$PY" - "$MEM/nulldacl.md" <<'PY'
import ctypes, sys
from ctypes import wintypes
P = ctypes.c_void_p
advapi = ctypes.WinDLL("advapi32")
advapi.InitializeSecurityDescriptor.argtypes = [P, wintypes.DWORD]
advapi.SetSecurityDescriptorDacl.argtypes = [P, wintypes.BOOL, P, wintypes.BOOL]
advapi.SetFileSecurityW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, P]
get, control = advapi.GetNamedSecurityInfoW, advapi.GetSecurityDescriptorControl
get.argtypes = [wintypes.LPCWSTR, ctypes.c_int, wintypes.DWORD, P, P, ctypes.POINTER(P), P, ctypes.POINTER(P)]
get.restype = wintypes.DWORD
control.argtypes = [P, ctypes.POINTER(wintypes.WORD), ctypes.POINTER(wintypes.DWORD)]
sd = ctypes.create_string_buffer(64)
made = (advapi.InitializeSecurityDescriptor(sd, 1) and advapi.SetSecurityDescriptorDacl(sd, True, None, False)
        and advapi.SetFileSecurityW(sys.argv[1], 4, sd))     # DACL_SECURITY_INFORMATION, NULL DACL
dacl, got_sd, bits, rev = P(), P(), wintypes.WORD(), wintypes.DWORD()
got = get(sys.argv[1], 1, 4, None, None, ctypes.byref(dacl), None, ctypes.byref(got_sd))
control(got_sd, ctypes.byref(bits), ctypes.byref(rev))
if not made or got or dacl.value or bits.value & 0x1000:
    print(f"could not give nulldacl.md an unprotected NULL DACL (made {made}, get {got}, "
          f"dacl {dacl.value}, control {bits.value:#06x})")
PY
)"
  [ -z "$NULL_SET" ] || fail "precondition: $NULL_SET"
  refused "a NULL DACL" "nulldacl.md: has access rules of its own" --gates-retire nulldacl
  harness acl-volume acl
  printf '%s\n' "$HARNESS_OUT" | grep -qx "RETURNED" \
    || fail "a volume that keeps no ACLs still had its memory's ACL checked: $HARNESS_OUT"
  echo "ok: a memory with an ACL of its own is refused, and one on a volume without ACLs is not checked"
else
  echo "DEGRADED: not Windows, so the ACL refusal is not exercised here (POSIX keeps the mode through copymode)"
fi

# A verb mixed with --gates-compile is a usage error (2), and neither half runs.
# Mutation: drop the `mixed` refusal in main() -> exit 0, plain.md retired.
seed
BEFORE_STATE="$(state "$MEM")"
recall --gates-retire plain --gates-compile
[ "$RC" = "2" ] || fail "--gates-retire with --gates-compile exited $RC, wanted the usage error 2"
printf '%s\n' "$ERR" | grep -qF "run on their own" || fail "the usage error does not say why: $ERR"
[ "$(state "$MEM")" = "$BEFORE_STATE" ] || fail "--gates-retire with --gates-compile still wrote to the store"
[ -e "$GATES" ] && fail "--gates-retire with --gates-compile still compiled"
echo "ok: retire mixed with compile is refused as a usage error, and neither runs"

# ---------------------------------------------------------------- a snapshot that fails refuses first
# AI_ACOLYTE_GATE_SNAPSHOT_DIR under a regular FILE cannot be created, on either platform.
# Mutations: rewrite the files before taking the snapshot -> "wrote to the store"; drop the
# sys.exit after a failed snapshot -> "does not say the snapshot".
#
# The path is handed over in the interpreter's own spelling. MSYS rewrites a POSIX path in the
# environment into a Windows one, but measured by rampage it leaves one running THROUGH a regular
# file alone, and python.exe then read `/tmp/...` as the root of the current drive: the first run
# of that test wrote its snapshot there, outside the throwaway HOME.
printf 'a file, not a directory\n' > "$TMP/blocker"
NATIVE_TMP="$("$PY" -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$TMP")"
NATIVE_TMP="${NATIVE_TMP//$'\r'/}"
export AI_ACOLYTE_GATE_SNAPSHOT_DIR="$NATIVE_TMP/blocker/snaps"
BEFORE_STATE="$(state "$MEM")"
recall --gates-retire plain
export AI_ACOLYTE_GATE_SNAPSHOT_DIR="$SNAPS"
[ "$RC" = "1" ] || fail "a snapshot that cannot be written exited $RC, wanted 1: $ERR"
printf '%s\n' "$ERR" | grep -qF "the snapshot could not be written" \
  || fail "the refusal does not say the snapshot could not be written: $ERR"
printf '%s\n' "$ERR" | grep -q "Traceback" && fail "a failed snapshot crashed instead of refusing: $ERR"
[ "$(state "$MEM")" = "$BEFORE_STATE" ] || fail "a failed snapshot still wrote to the store"
[ -z "$OUT" ] || fail "a failed snapshot printed to stdout: $OUT"
echo "ok: a snapshot that cannot be written refuses before any memory is touched"

# ---------------------------------------------------------------- keep the newest 30
# 35 snapshots of THIS store from 2020 (the oldest with its store spelled another way), beside
# things the prune must never touch:
#   keep-me, 20200101T000000Z-other  manifests naming this store, under names this code never mints
#   20190101T000000Z-retire          a FILE whose name matches the pattern
#   20180101T00000{0,1,2}Z-retire    the right name with no manifest (a dir made by hand), with a
#                                    manifest that is not JSON, and with an op this code never writes
#   20190101T00000{0,1,2}Z-restore   ANOTHER store's snapshots, older than every one of this store's
#   20210101T00000{0,1}Z-restore     two more of the other store's, newer than every one of these
# Mutations, one assertion each:
#   old[SNAPSHOT_KEEP:] instead of old[SNAPSHOT_KEEP - 1:]   -> "...05Z-retire survived the prune"
#   SNAPSHOT_NAME loosened to any name                        -> "removed ...06Z-retire, one of the
#       newest 30" (keep-me carries this store's manifest and sorts newest, so it takes a place)
#   drop the `n != mine` exclusion                            -> "removed ...06Z-retire, one of the newest 30"
#   a missing or malformed manifest counts as this store's    -> "warned while pruning" (the FILE
#       named like a snapshot is then a candidate, and rmtree refuses it before any other check)
#   drop the op test in _snapshot_of_this_store               -> "removed 20180101T000002Z-retire"
#   drop the store test in _snapshot_of_this_store            -> "removed ...06Z-retire, one of the
#       newest 30" (the other store's two newer snapshots take two of the 30 places)
#   compare the manifest's store without normpath/normcase    -> "...00Z-retire survived the prune"
seed
rm -rf "$SNAPS"
OURS="$(snapnames 35 20200101T0000 retire)"
mksnaps "$SNAPS" "20200101T000000Z-retire=retire,alt" ${OURS#20200101T000000Z-retire } \
  keep-me 20200101T000000Z-other \
  20180101T000000Z-retire=retire,none 20180101T000001Z-retire=retire,badjson \
  20180101T000002Z-retire=delete,ours \
  $(for n in $(snapnames 3 20190101T0000 restore) $(snapnames 2 20210101T0000 restore); do printf '%s=restore,other ' "$n"; done)
printf 'a file\n' > "$SNAPS/20190101T000000Z-retire"
recall --gates-retire plain
[ "$RC" = "0" ] || fail "a retire beside 35 old snapshots exited $RC: $ERR"
printf '%s\n' "$ERR" | grep -q "could not" && fail "warned while pruning: $ERR"
NEW="$(snap_name)"
[ -d "$SNAPS/$NEW" ] || fail "the snapshot just written was pruned"
i=0
for d in $OURS; do
  if [ $i -lt 6 ]; then
    [ -e "$SNAPS/$d" ] && fail "the old snapshot $d survived the prune"
  else
    [ -d "$SNAPS/$d" ] || fail "the prune removed $d, one of the newest 30"
  fi
  i=$((i + 1))
done
for d in keep-me 20200101T000000Z-other; do
  [ -d "$SNAPS/$d" ] || fail "the prune removed $d, a name it never mints"
done
[ -f "$SNAPS/20190101T000000Z-retire" ] || fail "the prune removed a FILE whose name looks like a snapshot"
for d in 20180101T000000Z-retire 20180101T000001Z-retire 20180101T000002Z-retire; do
  [ -d "$SNAPS/$d" ] || fail "the prune removed $d, whose manifest is not one this code writes"
done
for d in $(snapnames 3 20190101T0000 restore) $(snapnames 2 20210101T0000 restore); do
  [ -d "$SNAPS/$d" ] || fail "the prune removed $d, another store's snapshot"
done
echo "ok: the prune keeps this store's newest 30 and touches nothing it did not write for this store"

# The oldest go first, so a prune cut short keeps the newer ones. 32 old snapshots and the new one
# leave three to remove. Mutation: drop the reversed() in the prune loop -> "in this order".
seed
rm -rf "$SNAPS"
mksnaps "$SNAPS" $(snapnames 32 20200101T0000 retire)
harness prune-order plain
printf '%s\n' "$HARNESS_OUT" | grep -qx RETURNED || fail "the prune-order run did not succeed: $HARNESS_OUT"
[ "$(printf '%s\n' "$HARNESS_OUT" | sed -n 's/^PRUNED //p' | tr '\n' ' ')" = "$(snapnames 3 20200101T0000 retire)" ] \
  || fail "the prune did not remove the three oldest, oldest first, in this order: $HARNESS_OUT"
echo "ok: the prune removes the oldest first"

# A clock that went backwards: 30 snapshots from 2099 make the new one the OLDEST by name. It must
# survive anyway, and the total stays 30. Mutation: the natural "keep the newest 30 of them all"
# (drop `n != mine` AND slice at SNAPSHOT_KEEP), which passes the case above -> "just written was
# pruned".
rm -rf "$SNAPS"
mksnaps "$SNAPS" $(for n in $(snapnames 30 20990101T0000 restore); do printf '%s=restore,ours ' "$n"; done)
recall --gates-restore plain
[ "$RC" = "0" ] || fail "a restore beside 30 future-dated snapshots exited $RC: $ERR"
NEW="$(snap_name)"
[ -d "$SNAPS/$NEW" ] || fail "the snapshot just written was pruned because a skewed clock sorted it oldest"
[ "$(snapdirs | wc -l | tr -d ' ')" = "30" ] || fail "$(snapdirs | wc -l | tr -d ' ') snapshot dirs remain after the skewed prune, wanted 30"
[ -e "$SNAPS/20990101T000000Z-restore" ] && fail "the oldest future-dated snapshot was kept, so 31 remain"
echo "ok: the snapshot just written survives the prune even when it sorts oldest"

# The default root is ~/.claude/wildcarding/gate-snapshots, here inside the throwaway HOME: beside
# the extension's other Claude-side state, never a directory named for another product.
# Mutation: change the default in _snapshot_root -> "not under ~/.claude/wildcarding/gate-snapshots".
seed
unset AI_ACOLYTE_GATE_SNAPSHOT_DIR
recall --gates-retire plain
export AI_ACOLYTE_GATE_SNAPSHOT_DIR="$SNAPS"
[ "$RC" = "0" ] || fail "a retire with no AI_ACOLYTE_GATE_SNAPSHOT_DIR exited $RC: $ERR"
[ -d "$TMP/.claude/wildcarding/gate-snapshots/$(snap_name)" ] \
  || fail "with AI_ACOLYTE_GATE_SNAPSHOT_DIR unset the snapshot is not under ~/.claude/wildcarding/gate-snapshots: $OUT"
echo "ok: the snapshot defaults to ~/.claude/wildcarding/gate-snapshots"

# ---------------------------------------------------------------- races, through the module
# A second writer editing a memory mid-command cannot be timed from a shell, so these use the
# harness (defined with the helpers above) to play that writer at one seam.

# Mutation: drop the per-file re-read before each write -> "a file edited between the snapshot and
# its write did not stop the run" (the run then returns, so that assertion fires before the cmp that
# would show crlf.md's edit overwritten).
# Mutation: drop the put-back loop -> "plain.md was left retired".
seed
rm -rf "$SNAPS"
harness race-next plain crlf
printf '%s\n' "$HARNESS_OUT" | grep -q "^EXIT .*crlf.md changed after it was snapshotted.*Nothing was changed" \
  || fail "a file edited between the snapshot and its write did not stop the run: $HARNESS_OUT"
cmp -s "$MEM/plain.md" "$TMP/before/plain.md" || fail "plain.md was left retired after the run stopped"
with_edit "$TMP/before/crlf.md" > "$TMP/expect.md"
cmp -s "$MEM/crlf.md" "$TMP/expect.md" || fail "the run overwrote another writer's edit to crlf.md"
# The per-file lines are what bin/wildcard-perms and the extension read as "written", whatever the
# exit status, so a run that put everything back prints none. Mutation: print every planned line
# before the edits -> "named a file it had put back".
printf '%s\n' "$HARNESS_OUT" | grep -q '^retired ' && fail "a stopped run named a file it had put back: $HARNESS_OUT"
echo "ok: each file is re-checked just before its own write, and a stop puts back what was rewritten"

# Mutations: drop the "still holding the bytes this run wrote" test in the put-back loop ->
# "not named loudly"; drop the stdout lines for a stuck file -> "not named on stdout".
seed
harness race-stuck plain crlf
printf '%s\n' "$HARNESS_OUT" | grep -q "^EXIT .*plain.md could NOT be put back" \
  || fail "a file that could not be put back was not named loudly: $HARNESS_OUT"
printf '%s\n' "$HARNESS_OUT" | grep -qx 'retired plain.md' \
  || fail "a file left changed was not named on stdout, where the callers read what was written: $HARNESS_OUT"
printf '%s\n' "$HARNESS_OUT" | grep -qx 'retired crlf.md' \
  && fail "a stopped run named crlf.md, which it never wrote: $HARNESS_OUT"
{ mk_plain retired; printf 'edited by another writer\n'; } > "$TMP/expect.md"
cmp -s "$MEM/plain.md" "$TMP/expect.md" || fail "the run put back plain.md over another writer's edit"
echo "ok: a file edited after this run wrote it is left to that writer, and named"

# Mutation: drop the `moved` test in _write_snapshot -> the run gets as far as plain.md's own
# re-check, so the message and the leftover snapshot both differ.
seed
rm -rf "$SNAPS"
harness race-snapshot plain crlf
printf '%s\n' "$HARNESS_OUT" | grep -q "^EXIT .*plain.md changed while this command ran.*Nothing was written" \
  || fail "a file edited before the snapshot read it did not refuse the run: $HARNESS_OUT"
[ -z "$(snapdirs 2>/dev/null)" ] || fail "a refused snapshot was left behind: $(snapdirs)"
with_edit "$TMP/before/plain.md" > "$TMP/expect.md"
cmp -s "$MEM/plain.md" "$TMP/expect.md" || fail "plain.md does not hold exactly the other writer's edit"
cmp -s "$MEM/crlf.md" "$TMP/before/crlf.md" || fail "crlf.md changed in a run that was refused"
echo "ok: a snapshot that is not the before-image of the edit refuses the run"

# Mutation: delete the `if _DISCOVERY_ERRORS:` refusal in _change_gate_scopes -> "RETURNED".
seed
rm -rf "$SNAPS"
harness discovery plain
printf '%s\n' "$HARNESS_OUT" | grep -q "^EXIT .*refusing to change any gate: cannot read" \
  || fail "a store discovery could not read did not refuse the retire: $HARNESS_OUT"
cmp -s "$MEM/plain.md" "$TMP/before/plain.md" || fail "a refused retire still rewrote plain.md"
[ -z "$(snapdirs 2>/dev/null)" ] || fail "a refused retire left a snapshot behind"
echo "ok: a store discovery could not read refuses the retire, as it refuses the compile"

# A writer holding the memory open without FILE_SHARE_DELETE makes os.replace fail until it lets
# go, and it may save an edit while this waits. The retry re-reads the file first and stops when it
# changed. Before that, the next attempt replaced the file and the edit was in neither the file nor
# the snapshot (measured by rampage with a real second process in 3 of 3 runs).
# Mutation: drop the _require_bytes() call in _write_bytes_atomic's retry -> "RETURNED", and the cmp
# "the retry replaced the file over another writer's edit".
seed
rm -rf "$SNAPS"
harness race-wait plain
printf '%s\n' "$HARNESS_OUT" | grep -q "^EXIT .*plain.md could not be written (OSError: it changed while waiting to replace it). Nothing was changed" \
  || fail "an edit saved while the replace waited did not stop the run: $HARNESS_OUT"
with_edit "$TMP/before/plain.md" > "$TMP/expect.md"
cmp -s "$MEM/plain.md" "$TMP/expect.md" || fail "the retry replaced the file over another writer's edit"
for residue in "$MEM"/*.tmp; do
  [ -e "$residue" ] && fail "a run stopped while waiting left $residue behind"
done
echo "ok: a retry re-reads the memory and stops when it changed while the replace waited"

# The reversibility backstop. A _rescope that changes more than the value (here it also drops
# plain.md's description, as the lone-CR bug dropped the next key) still passes the _fm read-back,
# so only the backstop can refuse it.
# Mutation: drop the `_rescope(new, have) != raw` test -> "RETURNED".
seed
rm -rf "$SNAPS"
harness sloppy-rescope plain
printf '%s\n' "$HARNESS_OUT" | grep -q "^EXIT .*refusing to change any gate; nothing was written" \
  || fail "a rewrite that changes more than the value was not refused: $HARNESS_OUT"
printf '%s\n' "$HARNESS_OUT" | grep -qxF "  plain.md: rewriting its scope: value would change other bytes too; edit it by hand" \
  || fail "the refusal of a rewrite that changes more than the value does not say why: $HARNESS_OUT"
cmp -s "$MEM/plain.md" "$TMP/before/plain.md" || fail "a refused rewrite still changed plain.md"
[ -z "$(snapdirs 2>/dev/null)" ] || fail "a refused rewrite left a snapshot behind"
echo "ok: a rewrite that would change any byte but the value is refused"

# A read-only memory on Windows: copymode makes the temp read-only too, and os.replace then fails.
# The temp, holding the rewritten text, used to stay in the store because the remove failed on the
# same bit. Alone, and as the second of two files (the first is put back).
# Mutation: drop the os.chmod in _remove_temp -> "left plain.md.<pid>.tmp" (the state differs).
if [ "$OS_NAME" = "nt" ]; then
  seed
  "$PY" -c 'import os,stat,sys; os.chmod(sys.argv[1], stat.S_IREAD)' "$MEM/plain.md"
  BEFORE_STATE="$(state "$MEM")"
  for names in "plain" "crlf plain"; do
    recall --gates-retire $names
    [ "$RC" = "1" ] || fail "retiring a read-only memory ($names) exited $RC, wanted 1: $ERR"
    printf '%s\n' "$ERR" | grep -qF "plain.md could not be written" \
      || fail "retiring a read-only memory ($names) did not say why: $ERR"
    [ "$(state "$MEM")" = "$BEFORE_STATE" ] \
      || fail "retiring a read-only memory ($names) left the store changed: $(ls "$MEM" | grep -v '\.md$')"
  done
  "$PY" -c 'import os,stat,sys; os.chmod(sys.argv[1], stat.S_IREAD | stat.S_IWRITE)' "$MEM/plain.md"
  echo "ok: a read-only memory is refused at its write and leaves no temp file in the store"
else
  echo "DEGRADED: not Windows, where a read-only memory is replaced normally (the directory decides a"
  echo "          rename), so the read-only temp this guards against cannot be produced here"
fi

# ---------------------------------------------------------------- the gate-edit lock
# One O_EXCL file under ~/.claude/wildcarding, held for the whole read-decide-write, so two edits
# never interleave. Without it two real processes at once ended with one run's put-back reverting
# a file the other had reported retired (rampage: 1 of 25 trials).
# Mutations, one assertion each:
#   take no lock at all (change_gate_scopes calls _change_gate_scopes alone) -> "a held lock: exited 0"
#   release the lock before the edit instead of after it                     -> "a second process during
#       a run: exited 0"
#   drop the stale reclaim (_reclaim_gate_lock returns False)                -> "a stale lock was not reclaimed"
#   remove the lock whoever owns it in _drop_gate_lock                       -> "removed another run's lock"
#   drop the warning when the lock cannot be removed                         -> "did not say the lock"
#   let os.makedirs raise in _take_gate_lock                                 -> "a lock dir that cannot be made"
seed
rm -rf "$SNAPS"
mkdir -p "${LOCK%/*}"
printf '{"pid": 1, "owner": "another-run", "at": 0}\n' > "$LOCK"
refused "a held lock" "another AI Acolyte gate edit holds" --gates-retire plain
printf '%s\n' "$ERR" | grep -qF "gates-edit.lock" || fail "the held-lock refusal does not name the lock: $ERR"

"$PY" -c 'import os,sys,time; t = time.time() - 120; os.utime(sys.argv[1], (t, t))' "$LOCK"
recall --gates-retire plain
[ "$RC" = "0" ] || fail "a stale lock was not reclaimed: exited $RC: $ERR"
[ -e "$LOCK" ] && fail "the run that reclaimed a stale lock left a lock behind"

seed
rm -rf "$SNAPS"
rm -f "$TMP/hold.ready" "$TMP/hold.go"
HOLD_DIR="$TMP" "$PY" "$TMP/harness.py" "$RECALL" hold plain > "$TMP/hold.out" 2>&1 &
HOLD_PID=$!
i=0
while [ ! -e "$TMP/hold.ready" ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i + 1)); done
[ -e "$TMP/hold.ready" ] || { touch "$TMP/hold.go"; wait "$HOLD_PID"; fail "precondition: the holding run never reached its seam: $(cat "$TMP/hold.out")"; }
refused "a second process during a run" "another AI Acolyte gate edit holds" --gates-retire crlf
touch "$TMP/hold.go"
wait "$HOLD_PID"
tr -d '\r' < "$TMP/hold.out" | grep -qx "RETURNED" || fail "the holding run did not finish: $(cat "$TMP/hold.out")"
mk_plain retired > "$TMP/expect.md"
cmp -s "$MEM/plain.md" "$TMP/expect.md" || fail "the holding run did not retire plain.md"
cmp -s "$MEM/crlf.md" "$TMP/before/crlf.md" || fail "the refused second run changed crlf.md"
[ -e "$LOCK" ] && fail "the holding run left its lock behind"

seed
harness lock-stolen plain
printf '%s\n' "$HARNESS_OUT" | grep -qx RETURNED || fail "the lock-stolen run did not finish: $HARNESS_OUT"
grep -qF '"another-run"' "$LOCK" 2>/dev/null || fail "a run removed another run's lock on its way out"
rm -f "$LOCK"

seed
harness lock-stuck plain
printf '%s\n' "$HARNESS_OUT" | grep -qF "could not remove the gate-edit lock" \
  || fail "a lock that could not be removed was not reported, so it did not say the lock blocks later edits: $HARNESS_OUT"
rm -f "$LOCK"

# Mutation: let os.makedirs raise in _take_gate_lock (drop its try) -> "a lock dir that cannot be
# made: stderr does not say" (a traceback instead of a refusal).
mkdir -p "$TMP/home2/.claude"
printf 'a file where the lock directory goes\n' > "$TMP/home2/.claude/wildcarding"
HOME="$TMP/home2" USERPROFILE="$TMP/home2" refused "a lock dir that cannot be made" \
  "cannot create" --gates-retire plain
echo "ok: the gate-edit lock refuses a second edit, is reclaimed when stale, and is removed only by its owner"

# ---------------------------------------------------------------- compile, lint, zero active
# A clean corpus of two gates, so `clean:` is reachable and its survival means something.
# Mutations, one assertion each:
#   drop _lint_retired() from main()'s --lint                -> "did not name the retired gate"
#   print the note whatever the count (drop `if retired:`)   -> "printed a retired-gate line with none retired"
#   make a retired gate a lint finding (a term in `clean:`)  -> "cost the corpus its clean verdict"
#   word the note "not compiled"                             -> "verify-release.ps1 fails on"
rm -rf "$MEM" "$GATES"
mkdir -p "$MEM"
printf -- '---\nname: g_one\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **Gate one.** Compiled while it is active.\n<!-- /gate -->\n' > "$MEM/g_one.md"
printf -- '---\nname: g_two\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **Gate two.** Compiled until it is retired.\n<!-- /gate -->\n' > "$MEM/g_two.md"
printf -- '# Memory Index\n\n- [one](g_one.md) hook\n- [two](g_two.md) hook\n' > "$MEM/MEMORY.md"
recall --gates-compile
[ "$RC" = "0" ] || fail "precondition: the two-gate corpus did not compile: $ERR"
cp "$GATES" "$TMP/gates.both"
recall --lint
[ "$RC" = "0" ] || fail "--lint exited $RC"
printf '%s\n' "$OUT" | grep -q 'clean:' || fail "precondition: the two-gate corpus is not clean, so clean: proves nothing: $OUT"
printf '%s\n' "$OUT" | grep -q 'retired gate' && fail "--lint printed a retired-gate line with none retired: $OUT"

recall --gates-retire g_one
[ "$RC" = "0" ] || fail "--gates-retire g_one exited $RC: $ERR"
recall --lint
printf '%s\n' "$OUT" | grep -q STALE || fail "--lint did not report the compile stale after a retire: $OUT"
recall --gates-compile
[ "$RC" = "0" ] || fail "--gates-compile after a retire exited $RC: $ERR"
grep -q 'Gate one' "$GATES" && fail "a retired gate was compiled"
grep -q 'Gate two' "$GATES" || fail "retiring one gate dropped the other from the compile"
grep -qF '## Standing gates (1 memories, managed)' "$GATES" || fail "the compiled header does not count one gate"
recall --lint
[ "$RC" = "0" ] || fail "--lint exited $RC"
printf '%s\n' "$OUT" | grep -qxF '  1 retired gate memory (scope: retired), kept in the store and left out of the compile by choice: g_one' \
  || fail "--lint did not name the retired gate: $OUT"
printf '%s\n' "$OUT" | grep -q 'clean:' || fail "a retired gate cost the corpus its clean verdict: $OUT"
printf '%s\n' "$OUT" | grep -q 'not compiled' \
  && fail "--lint says 'not compiled' over a retired gate, which scripts/verify-release.ps1 fails on: $OUT"
echo "ok: a retired gate stops compiling, and --lint names it without calling it a finding"

# Zero active: the compile refuses to empty an installed file without the flag, and empties it with
# it, which is the pair of steps the CLI and the extension run when the last gate is retired.
recall --gates-retire g_two
[ "$RC" = "0" ] || fail "--gates-retire g_two exited $RC: $ERR"
cp "$GATES" "$TMP/gates.one"
recall --gates-compile
[ "$RC" = "0" ] && fail "a compile with every gate retired emptied the installed file without --gates-allow-empty"
cmp -s "$GATES" "$TMP/gates.one" || fail "the refused zero-active compile changed the compiled file"
recall --gates-compile --gates-allow-empty
[ "$RC" = "0" ] || fail "the zero-active compile with --gates-allow-empty exited $RC: $ERR"
[ -s "$GATES" ] && fail "the zero-active compile with --gates-allow-empty did not empty the compiled file"
recall --lint
printf '%s\n' "$OUT" | grep -qxF '  2 retired gate memories (scope: retired), kept in the store and left out of the compile by choice: g_one, g_two' \
  || fail "--lint did not name both retired gates: $OUT"
printf '%s\n' "$OUT" | grep -q 'clean:' || fail "two retired gates cost the corpus its clean verdict: $OUT"

recall --gates-restore g_one g_two
[ "$RC" = "0" ] || fail "restoring both gates exited $RC: $ERR"
recall --gates-compile
[ "$RC" = "0" ] || fail "the compile after restoring both exited $RC: $ERR"
cmp -s "$GATES" "$TMP/gates.both" || fail "restoring both gates did not compile back to the same bytes"
recall --lint
printf '%s\n' "$OUT" | grep -q 'retired gate' && fail "--lint still names retired gates after both were restored: $OUT"
echo "ok: retiring every gate compiles empty only with --gates-allow-empty, and restoring compiles back byte for byte"

# ---------------------------------------------------------------- per agent: a retire changes one agent's section
# A Codex-only gate, a Claude-only gate and a shared one, so the compile is per agent (recall.py
# _compile_gates_text). Retiring the Codex-only gate changes Codex's section and leaves Claude's
# byte for byte, which is what the panel's "what loads next session" promises: AGENTS.md changes,
# CLAUDE.md does not. Retiring the Claude-only one too returns the compile to a single gate set,
# and restoring both compiles back to the original bytes, each gate in its own agent's section.
# Mutations, one assertion each:
#   _rescope also rewrites the agents: value to every agent    -> "Claude's section changed"
#   _gate_agents read the agents of a gate retired then restored as every agent -> "restored codex_only"
#   a retire that edits agents: instead of scope: (moving the gate) -> "a single gate set"
rm -rf "$MEM" "$GATES"
mkdir -p "$MEM"
printf -- '---\nname: shared\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **Shared rule.** For both agents.\n<!-- /gate -->\n' > "$MEM/shared.md"
printf -- '---\nname: codex_only\nmetadata:\n  scope: global\n  agents: [codex]\n---\n<!-- gate -->\n- **Codex rule.** AGENTS.md only.\n<!-- /gate -->\n' > "$MEM/codex_only.md"
printf -- '---\nname: claude_only\nmetadata:\n  agents:\n  - claude\n  scope: global\n---\n<!-- gate -->\n- **Claude rule.** CLAUDE.md only.\n<!-- /gate -->\n' > "$MEM/claude_only.md"
printf -- '# Memory Index\n' > "$MEM/MEMORY.md"
cat > "$TMP/sections.py" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
m = re.match(r"<!-- generated by recall\.py --gates-compile; per agent: claude (\d+), codex (\d+) -->\n", text)
if not m:
    print("SINGLE")
    sys.exit(0)
body = text[m.end():].encode("utf-8")
a, b = int(m.group(1)), int(m.group(2))
open(sys.argv[2] + ".claude", "wb").write(body[:a])
open(sys.argv[2] + ".codex", "wb").write(body[a:a + b])
print("PER-AGENT")
PY
sections() { local out; out="$("$PY" "$TMP/sections.py" "$GATES" "$1")"; printf '%s' "${out//$'\r'/}"; }
recall --gates-compile
[ "$RC" = "0" ] || fail "precondition: the per-agent corpus did not compile: $ERR"
cp "$GATES" "$TMP/agents.original"
[ "$(sections "$TMP/s0")" = "PER-AGENT" ] || fail "precondition: the per-agent corpus did not compile per agent"
grep -q 'Codex rule' "$TMP/s0.claude" && fail "precondition: the Codex-only gate is in Claude's section"

recall --gates-retire codex_only
[ "$RC" = "0" ] || fail "--gates-retire codex_only exited $RC: $ERR"
recall --gates-compile
[ "$RC" = "0" ] || fail "the compile after retiring codex_only exited $RC: $ERR"
[ "$(sections "$TMP/s1")" = "PER-AGENT" ] || fail "retiring the Codex-only gate left no per-agent compile, though claude_only names one agent"
cmp -s "$TMP/s1.claude" "$TMP/s0.claude" || fail "retiring a Codex-only gate: Claude's section changed"
grep -q 'Codex rule' "$TMP/s1.codex" && fail "the retired Codex-only gate is still in Codex's section"
grep -q 'Shared rule' "$TMP/s1.codex" || fail "retiring the Codex-only gate took the shared gate out of Codex's section"

recall --gates-retire claude_only
[ "$RC" = "0" ] || fail "--gates-retire claude_only exited $RC: $ERR"
recall --gates-compile
[ "$RC" = "0" ] || fail "the compile after retiring claude_only exited $RC: $ERR"
[ "$(sections "$TMP/s2")" = "SINGLE" ] || fail "with only a shared gate left, the compile is not a single gate set"

recall --gates-restore codex_only claude_only
[ "$RC" = "0" ] || fail "restoring both exited $RC: $ERR"
recall --gates-compile
[ "$RC" = "0" ] || fail "the compile after restoring both exited $RC: $ERR"
cmp -s "$GATES" "$TMP/agents.original" || fail "restored codex_only and claude_only did not compile back to the original bytes"
sections "$TMP/s3" >/dev/null
grep -q 'Codex rule' "$TMP/s3.claude" && fail "restored codex_only reached Claude's section"
grep -q 'Claude rule' "$TMP/s3.codex" && fail "restored claude_only reached Codex's section"
echo "ok: a retire changes only the agents its gate is for, and a restore returns it to them"

# ---------------------------------------------------------------- --gates-list loads no model
# Mutation: touch np anywhere on the --gates-list path (an `np.zeros(1)` in gates_list) ->
# "numpy was imported by --gates-list".
#
# The pattern matches the package OR any of its submodules, and it has to. recall.py imports
# numpy only through _LazyModule, which calls importlib.import_module, and -X importtime prints no
# line for a top-level module imported that way: measured by rampage on Python 3.11, `import numpy`
# prints `| numpy` and importlib.import_module("numpy") prints only the `numpy.*` lines under it.
IMPORTS="$("$PY" -X importtime "$RECALL" --gates-list 2>&1 >/dev/null)"
RC=$?
IMPORTS="${IMPORTS//$'\r'/}"
[ "$RC" = "0" ] || fail "--gates-list under -X importtime exited $RC"
printf '%s\n' "$IMPORTS" | grep -q "import time:" || fail "precondition: -X importtime printed no import table"
printf '%s\n' "$IMPORTS" | grep -qE '\|[[:space:]]*numpy(\.|$)' \
  && fail "numpy was imported by --gates-list, which never touches it"
printf '%s\n' "$IMPORTS" | grep -qE '\|[[:space:]]*onnxruntime(\.|$)' \
  && fail "onnxruntime was imported by --gates-list, which never touches it"
echo "ok: --gates-list loads neither numpy nor onnxruntime"

echo "ALL PASS"
