#!/usr/bin/env bash
# Behavioural tests for memory/recall.py's cache and frontmatter handling.
#
# Not part of `node --test`: recall.py needs the local toolbox Python (numpy + onnxruntime),
# which GitHub CI does not have, so this is a local check in the same spirit as recall.py's own
# --selftest and test/gates-stale.sh. Run it where the toolbox lives:
#
#   bash test/recall-py.sh
#
# No ONNX model is required. Every test seeds recall_index.json with matching (mtime, size) so
# `todo` is empty by construction, which means Bge() is never built. --gates-compile needs the
# venv to import, but never constructs the embedder either.
#
# Each test names the mutation that must make it fail. A test that cannot fail is not a test.
set -u

PY="${TOOLBOX_PYTHON:-$LOCALAPPDATA/DevToolbox/python/.venv/Scripts/python.exe}"
HERE="$(cd "$(dirname "$0")" && pwd)"
RECALL="$HERE/../memory/recall.py"

[ -x "$PY" ] || { echo "skip: toolbox python not found at $PY"; exit 0; }

fail() { echo "FAIL: $1"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
MEM="$TMP/memory"
mkdir -p "$MEM" "$TMP/.claude"

# The four-variable incantation, copied from test/cli-gates.test.js rather than the two-variable
# one in gates-stale.sh: GATES_OUT resolves through expanduser, which consults all of them.
export HOME="$TMP" USERPROFILE="$TMP" HOMEDRIVE="${TMP%%/*}" HOMEPATH="${TMP#?}"
export RECALL_MEMORY_DIR="$MEM" RECALL_REEXEC=1

seed_index() {
  "$PY" - "$MEM" <<'PY'
import json, os, sys
mem = sys.argv[1]
files = {}
for n in sorted(os.listdir(mem)):
    if not n.endswith(".md") or n == "MEMORY.md":
        continue
    st = os.stat(os.path.join(mem, n))
    files[n] = {"mtime": st.st_mtime, "size": st.st_size, "desc": n, "vec": [0.0] * 384}
json.dump({"embed": "bge-small-onnx", "files": files},
          open(os.path.join(mem, "recall_index.json"), "w", encoding="utf-8"))
PY
}

count_index() {
  "$PY" -c "import json,sys;print(len(json.load(open(sys.argv[1],encoding='utf-8'))['files']))" \
    "$MEM/recall_index.json"
}

# ---------------------------------------------------------------- B1: deletion is persisted
# Mutation: move `save_index(idx)` back inside `if todo:`. Then a deletion-only run prunes the
# in-memory dict, writes nothing, and the on-disk cache keeps the dead entry forever --
# recallIndexStatus reads count-mismatch and the extension's auto-sync never converges.
#
# The trap this test exists to avoid: --list prints from the PRUNED in-memory copy, so a test
# that greps --list stdout passes under the bug. Assert on the FILE.
printf -- '---\nname: a\ndescription: alpha\n---\nalpha body\n' > "$MEM/a.md"
printf -- '---\nname: b\ndescription: bravo\n---\nbravo body\n' > "$MEM/b.md"
printf -- '---\nname: c\ndescription: charlie\n---\ncharlie body\n' > "$MEM/c.md"
printf -- '# Memory Index\n' > "$MEM/MEMORY.md"
seed_index
[ "$(count_index)" = "3" ] || fail "seeded index should hold 3 entries, got $(count_index)"

rm "$MEM/b.md"
"$PY" "$RECALL" --list >/dev/null 2>&1 || fail "--list exited non-zero after a deletion"
[ "$(count_index)" = "2" ] || fail "deletion-only change was not persisted: on-disk index still has $(count_index) entries"
grep -q '"b.md"' "$MEM/recall_index.json" && fail "deleted memory is still in the on-disk index"
echo "ok: a deletion-only change is written to disk, not just to the in-memory copy"

# ---------------------------------------------------------------- B2: a corrupt cache says so
# Mutation: restore `except Exception: pass` in load_index(). The truncated cache is then
# discarded in silence and all 119 vectors re-embed, which looks exactly like a first run.
#
# The corpus is emptied first, deliberately. A corrupt cache marks every file for re-embedding,
# which would construct Bge() and demand the 34 MB ONNX model; with no indexable files, `todo`
# stays empty and the warning path is still exercised. Keeping this harness model-free is what
# lets it run on a machine that has never downloaded the model.
rm -f "$MEM"/a.md "$MEM"/b.md "$MEM"/c.md
printf '{"embed": "bge-small-onnx", "files": {"a.md": {"mti' > "$MEM/recall_index.json"
ERR="$("$PY" "$RECALL" --list 2>&1 >/dev/null)"
RC=$?
echo "$ERR" | grep -q 'unreadable' || fail "a truncated index was discarded silently: stderr was '$ERR'"
echo "$ERR" | grep -q 'recall_index.json' || fail "the warning does not name the file it could not read"
[ "$RC" = "0" ] || fail "a corrupt cache must not exit non-zero: extension.js reads that as sync failure"
echo "ok: a corrupt index warns on stderr, names the file, and still exits 0"

# ---------------------------------------------------------------- B2: no temp residue
printf -- '---\nname: d\ndescription: delta\n---\ndelta body\n' > "$MEM/d.md"
printf -- '---\nname: e\ndescription: echo\n---\necho body\n' > "$MEM/e.md"
seed_index
rm "$MEM/e.md"
"$PY" "$RECALL" --list >/dev/null 2>&1
[ -e "$MEM/recall_index.json.tmp" ] && fail "a successful write left recall_index.json.tmp behind"
[ "$(count_index)" = "1" ] || fail "expected 1 entry after the deletion, got $(count_index)"
echo "ok: the atomic write leaves no .tmp residue"

# ---------------------------------------------------------------- B3: frontmatter past 400 chars
# Mutation: revert _fm to text[:400]. `scope: global` sits past the boundary here, so the gate
# silently vanishes from the compiled output -- which is how a standing order stops being
# enforced without anything reporting it.
rm -f "$MEM"/*.md
{
  printf -- '---\nname: deep\n'
  printf 'description: "'
  printf 'padding %.0s' $(seq 1 60)
  printf '"\nmetadata:\n  type: feedback\n  scope: global\n---\n\n'
  printf -- '<!-- gate -->\n- **A gate declared past the 400-char cliff.** Pass: it compiles.\n<!-- /gate -->\n'
} > "$MEM/deep.md"
printf -- '# Memory Index\n' > "$MEM/MEMORY.md"
[ "$(wc -c < "$MEM/deep.md")" -gt 400 ] || fail "fixture is too short to cross the 400-char boundary"

"$PY" "$RECALL" --gates-compile >/dev/null 2>&1 || fail "--gates-compile exited non-zero"
grep -q 'past the 400-char cliff' "$TMP/.claude/gates.generated.md" \
  || fail "a scope:global declared past 400 chars did not reach the compiled gates"
echo "ok: frontmatter is read from the --- block, not a byte window"

# ---------------------------------------------------------------- B3: a fenced example is not a gate
# This is the assertion that separates the correct fix from the naive one. Simply dropping the
# 400-char cap passes the test above AND passes on the live corpus, and is still wrong: this
# corpus contains memories that document gate syntax.
#
# The generated file is deleted first, and that deletion is load-bearing. The expected compile
# here is EMPTY, so leaving the previous test's output in place walks straight into
# compile_gates()'s empty-compile guard: the write is refused, the file keeps deep.md's gate, and
# an assertion phrased as "the new text is absent" then inspects the PREVIOUS gate and passes
# without ever reaching _fm. Starting from no file means the guard is not reached and the
# assertion reads what this compile actually produced.
#
# `[ -s ]` rather than a grep for the fixture's wording: for a negative, "nothing compiled at all"
# is strictly stronger than "this one string is absent", and it cannot be satisfied by stale bytes.
rm -f "$MEM"/deep.md "$TMP/.claude/gates.generated.md"
{
  printf -- '---\nname: doc\nmetadata:\n  type: reference\n---\n\n'
  printf 'How to declare a gate:\n\n```yaml\nmetadata:\n  scope: global\n```\n\n'
  printf -- '<!-- gate -->\n- **This must NOT compile.** It is documentation, not a declaration.\n<!-- /gate -->\n'
} > "$MEM/doc.md"
"$PY" "$RECALL" --gates-compile >/dev/null 2>&1
[ -s "$TMP/.claude/gates.generated.md" ] \
  && fail "a scope: global inside a fenced code example was compiled as a real gate"
echo "ok: scope: global inside a fenced example is not treated as a declaration"

# ---------------------------------------------------------------- B3b: a BOM must not hide a gate
# Scoping _fm to the --- block fixed the byte-window bug and introduced the mirror image of it:
# requiring the fence at byte 0 means a UTF-8 BOM, or a leading blank line, drops the memory out
# of the compiled gates in silence. PowerShell 5.1's `Out-File -Encoding utf8` writes a BOM, so
# one PowerShell one-liner over a gated memory was enough. Mutation: remove the lstrip in _fm.
rm -f "$MEM"/*.md
printf '\xEF\xBB\xBF' > "$MEM/bom.md"
printf -- '---\nname: bom\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **Declared behind a BOM.** Pass: it still compiles.\n<!-- /gate -->\n' >> "$MEM/bom.md"
printf -- '# Memory Index\n' > "$MEM/MEMORY.md"
"$PY" "$RECALL" --gates-compile >/dev/null 2>&1
grep -q 'Declared behind a BOM' "$TMP/.claude/gates.generated.md" \
  || fail "a gated memory written with a UTF-8 BOM dropped out of the compiled standing orders"
echo "ok: a UTF-8 BOM before the frontmatter fence does not hide a gate"

# ---------------------------------------------------------------- gates compile is idempotent
# gates-stale.sh covers drift-detected and drift-cleared. Nothing covered stability, and an
# unstable compile would make --lint report STALE forever.
rm -f "$MEM"/*.md
printf -- '---\nname: g\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **Stable.** Pass: same sha twice.\n<!-- /gate -->\n' > "$MEM/g.md"
printf -- '# Memory Index\n' > "$MEM/MEMORY.md"
"$PY" "$RECALL" --gates-compile >/dev/null 2>&1
ONE="$(head -1 "$TMP/.claude/gates.generated.md")"
"$PY" "$RECALL" --gates-compile >/dev/null 2>&1
TWO="$(head -1 "$TMP/.claude/gates.generated.md")"
[ "$ONE" = "$TWO" ] || fail "compiling twice over an unchanged corpus produced a different sha"
echo "ok: compiling an unchanged corpus twice yields the same sha"

# ---------------------------------------------------------------- a gateless corpus cannot empty it
# Runs here because the block above leaves a real, non-empty compile on disk, which is the only
# state in which this failure exists.
#
# Point RECALL_MEMORY_DIR at a corpus with no gate blocks -- a wrong dir, a renamed working root,
# a half-migrated store -- and the compiler used to write "" over a good gates.generated.md. Every
# downstream signal for that is silent: agent-gates.js refuses to install an empty block so
# CLAUDE.md keeps its old text and looks correct, the dashboard's gate count reads 0, and
# _gates_are_stale() then compares "" against "" and answers "not stale". The one mechanism built
# to notice the problem is the one the problem switches off.
#
# The refusal has to be LOUD. Both callers -- the extension's execFile and
# `wildcard-perms --gates refresh` -- branch on the exit status, and neither of them can see a
# bare `return`.
#
# Mutations, one assertion each: delete the `if not names and not allow_empty` block (the file is
# overwritten); swap the sys.exit for a `return` (exit 0); drop the `and not allow_empty` half (the
# escape hatch stops working); add `if not fresh: return False` to _gates_are_stale (no STALE).
GATES="$TMP/.claude/gates.generated.md"
[ -s "$GATES" ] || fail "precondition: the idempotence block should have left a non-empty compile"
BEFORE="$(cat "$GATES")"

GATELESS="$TMP/gateless"
mkdir -p "$GATELESS"
printf -- '---\nname: plain\nmetadata:\n  scope: project\n---\nnothing global, no gate block\n' > "$GATELESS/plain.md"
printf -- '# Memory Index\n' > "$GATELESS/MEMORY.md"

ERR="$(RECALL_MEMORY_DIR="$GATELESS" "$PY" "$RECALL" --gates-compile 2>&1 >/dev/null)"
RC=$?
[ "$(cat "$GATES")" = "$BEFORE" ] || fail "a gateless corpus overwrote the compiled gates with nothing"
[ "$RC" = "0" ] && fail "the refusal exited 0: neither the extension nor --gates refresh can see that"
# The corpus is named by its full path, which MSYS rewrites to native form on the way into
# python.exe, so match the leaf rather than "$GATELESS".
echo "$ERR" | grep -q 'gateless' || fail "the refusal does not name the corpus it read: '$ERR'"
echo "$ERR" | grep -q -- '--gates-allow-empty' || fail "the refusal does not name its own escape hatch: '$ERR'"
echo "ok: a gateless corpus is refused, non-zero, with the compiled gates left intact"

# Silence would be the worst outcome: the file is preserved, so nothing looks wrong. The refusal
# has to leave the drift check able to see the mismatch it just declined to erase.
LINTED="$(RECALL_MEMORY_DIR="$GATELESS" "$PY" "$RECALL" --lint 2>&1)"
echo "$LINTED" | grep -q STALE || fail "after a refused compile --lint reported no drift at all"
echo "ok: a refused compile leaves --lint reporting STALE rather than empty-equals-empty"

# Deleting every gate on purpose must still be possible, or the guard is a wall instead of a
# question. The flag is the whole difference between an accident and an intention.
RECALL_MEMORY_DIR="$GATELESS" "$PY" "$RECALL" --gates-compile --gates-allow-empty >/dev/null 2>&1
RC=$?
[ "$RC" = "0" ] || fail "--gates-allow-empty must compile cleanly, exited $RC"
[ -s "$GATES" ] && fail "--gates-allow-empty did not empty the compiled gates"
echo "ok: --gates-allow-empty still lets a deliberate 'delete every gate' through"

# ------------------------------------------- a MISSING dir is the third route to the same loss
# The guard above catches a corpus that compiles zero gates. It did NOT catch a corpus that is
# not there at all: compile_gates returned early, printed "nothing to compile" and exited 0, so
# bin/wildcard-perms read a clean compile and extension.js chained into ensureGates() and
# reinstalled stale bytes reporting success. A typo'd RECALL_MEMORY_DIR is the likeliest way to
# reach it. Mutation: move the `if not os.path.isdir(MEMORY_DIR)` block back above the guard.
# The preceding test deliberately emptied the compiled file, so establish the state this
# one needs rather than inheriting it: a real gate, compiled and installed.
GATED="$TMP/gated"; mkdir -p "$GATED"
printf -- '# Memory Index
' > "$GATED/MEMORY.md"
printf -- '---
name: g
metadata:
  scope: global
---
<!-- gate -->
- **A real gate.** Pass: it compiles.
<!-- /gate -->
' > "$GATED/g.md"
RECALL_MEMORY_DIR="$GATED" "$PY" "$RECALL" --gates-compile >/dev/null 2>&1 || fail "precondition: compiling a gated corpus should succeed"
BEFORE="$(cat "$GATES")"
[ -n "$BEFORE" ] || fail "precondition: expected compiled gates on disk after a gated compile"
RECALL_MEMORY_DIR="$TMP/no-such-corpus" "$PY" "$RECALL" --gates-compile >/dev/null 2>&1
RC=$?
[ "$RC" != "0" ] || fail "a missing memory dir exited 0, so the caller treats it as a clean compile"
[ "$(cat "$GATES")" = "$BEFORE" ] || fail "a missing memory dir changed the installed standing orders"
echo "ok: a missing memory dir refuses too, instead of reporting a clean compile"

# ...and a genuinely fresh machine, with nothing installed, stays a quiet no-op rather than
# becoming a wall. Same test separates the two cases. Mutation: drop the `installed` check.
mv "$GATES" "$GATES.away"
RECALL_MEMORY_DIR="$TMP/no-such-corpus" "$PY" "$RECALL" --gates-compile >/dev/null 2>&1
RC=$?
mv "$GATES.away" "$GATES"
[ "$RC" = "0" ] || fail "a fresh machine with no compiled gates must stay a no-op, exited $RC"
echo "ok: a fresh machine with nothing installed is still a quiet no-op"

# ------------------------------------------------ rank() must refuse a partial parts tuple
# Passing idx+names with lex=None silently returned pure-vector ordering at exactly half score
# in hybrid, and every score 0.0 in alphabetical order in lexical -- the same failure
# _check_mode exists to prevent, reached through a different door. Mutation: delete the
# `if lex is None` raise in rank().
ERR="$("$PY" -c "
import importlib.util, sys
s = importlib.util.spec_from_file_location('recall', sys.argv[1])
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
try:
    m.rank('q', mode='lexical', idx={'files': {}}, names=['a.md'], lex=None, emb=None)
    print('NO-RAISE')
except ValueError as e:
    print('RAISED', e)
" "$RECALL" 2>&1)"
echo "$ERR" | grep -q RAISED || fail "rank() accepted a partial parts tuple: $ERR"
echo "$ERR" | grep -q lex || fail "the error does not name the missing part: $ERR"
echo "ok: rank() refuses a partial parts tuple instead of degrading in silence"

# ---------------------------------------------------------------- MEMORY_DIRS spans corpora
# A renamed working root strands its old store: _discover_memory_dir takes the single largest and
# cannot see the rest. RECALL_MEMORY_DIRS searches both. --lint and --gates-compile deliberately
# stay on the primary dir, so a second corpus cannot install a standing order.
#
# Mutation: make _display_keys qualify unconditionally, or never. Unconditional breaks the first
# assertion (single-corpus output must stay bare); never breaks the second (a collision becomes
# unanswerable from the printed line).
MEM2="$TMP/memory2"
mkdir -p "$MEM2"
rm -f "$MEM"/*.md "$MEM"/recall_index.json
printf -- '---\nname: only\ndescription: unique to the primary store\n---\nprimary body\n' > "$MEM/only-here.md"
printf -- '---\nname: dup\ndescription: primary copy\n---\nprimary duplicate body\n' > "$MEM/dup.md"
printf -- '---\nname: dup\ndescription: secondary copy\n---\nsecondary duplicate body\n' > "$MEM2/dup.md"
printf -- '---\nname: strand\ndescription: stranded in the second store\n---\nstranded body\n' > "$MEM2/strand.md"
printf -- '# Memory Index\n' > "$MEM/MEMORY.md"

# MSYS translates a lone POSIX path in an env var but leaves a ;-separated list alone, so the
# native Python would receive /tmp/... and find nothing. Convert explicitly.
if command -v cygpath >/dev/null 2>&1; then
  DIRS2="$(cygpath -m "$MEM");$(cygpath -m "$MEM2")"
else
  DIRS2="$MEM:$MEM2"
fi

OUT="$(RECALL_MEMORY_DIRS="$DIRS2" "$PY" "$RECALL" --lexical-only -k 8 "stranded body" 2>/dev/null)"
echo "$OUT" | grep -q 'strand.md' || fail "a memory in the second corpus was not searchable"
echo "$OUT" | grep -q 'only-here.md' || fail "qualification dropped an un-collided primary name"
echo "$OUT" | grep -qE '^\s+[0-9.]+\s+only-here\.md' || fail "an un-collided name must print bare, not qualified"
echo "ok: a second corpus is searchable and un-collided names still print bare"

OUT="$(RECALL_MEMORY_DIRS="$DIRS2" "$PY" "$RECALL" --lexical-only -k 8 "duplicate body" 2>/dev/null)"
echo "$OUT" | grep -q '/dup.md' || fail "a filename present in both corpora was not qualified by store"
echo "ok: a filename that exists in two corpora is qualified with its store"

# --gates-compile must NOT span: a second corpus installing a standing order is the failure this
# separation exists to prevent.
printf -- '---\nname: sneak\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **From the second corpus.** Must not compile.\n<!-- /gate -->\n' > "$MEM2/sneak.md"
RECALL_MEMORY_DIRS="$DIRS2" "$PY" "$RECALL" --gates-compile >/dev/null 2>&1
grep -q 'From the second corpus' "$TMP/.claude/gates.generated.md" \
  && fail "a gate declared in a secondary corpus reached the compiled standing orders"
echo "ok: --gates-compile stays on the primary corpus even when search spans several"

# ---------------------------------------------------------------- a bad path cannot kill a query
# _display_keys tolerated an unreadable dir; _retriever's own loop did not, so one stale entry in
# RECALL_MEMORY_DIRS raised FileNotFoundError out of every non-lexical query. Deleting the
# stranded corpus after merging it would have triggered exactly that. (That merge happened on
# 2026-09-14 and the store was deliberately NOT deleted, so this guard is now protecting against
# a stale hand-set var rather than an imminent deletion. Still reachable, still worth keeping.)
# Mutation: drop the `os.path.isdir` filter in _search_dirs.
#
# Asserted against _search_dirs directly, NOT through a --lexical-only query. That is how this
# was written first and it could not fail: _retriever skips the dir-walking loop entirely for
# lexical mode, so the query exercised the one mode the defect never touched. Proven by applying
# the named mutation and watching the suite stay green. Reading the list is also a stronger
# assertion than "the query survived", because it names what the filter is supposed to produce.
BAD="$TMP/does-not-exist"
OUT="$("$PY" -c "
import importlib.util, os, sys
os.environ['RECALL_MEMORY_DIRS'] = sys.argv[2] + os.pathsep + sys.argv[3]
os.environ['RECALL_MEMORY_DIR'] = sys.argv[4]
s = importlib.util.spec_from_file_location('recall', sys.argv[1])
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
print('DIRS', len(m.MEMORY_DIRS))
for d in m.MEMORY_DIRS: print('  ', d)
" "$RECALL" "$(cygpath -m "$MEM2" 2>/dev/null || echo "$MEM2")" "$BAD" "$MEM" 2>&1)"
RC=$?
[ "$RC" = "0" ] || fail "a non-existent dir in RECALL_MEMORY_DIRS made import exit $RC: $OUT"
echo "$OUT" | grep -qi 'traceback\|FileNotFoundError' && fail "a non-existent dir raised instead of being skipped"
echo "$OUT" | grep -q '^DIRS 2$' || fail "expected exactly the primary + the good secondary: $OUT"
echo "$OUT" | grep -q 'does-not-exist' && fail "the non-existent dir survived into MEMORY_DIRS"
echo "ok: a non-existent corpus in RECALL_MEMORY_DIRS is skipped, not fatal"

# ---------------------------------------------------------------- DIRS extends, never replaces
# Naming only the secondary store is the obvious thing to type. If that REPLACED the primary,
# every memory in it would silently vanish from search while --lint and --list kept reporting
# them. Mutation: drop MEMORY_DIR from the list _search_dirs builds.
# The witness is only-here.md, NOT dup.md. dup.md exists in BOTH fixture corpora, so dropping
# the primary still leaves a file of that name in the output and the assertion passed against the
# mutation it names. Proven by applying it. only-here.md is unique to the primary, so it is the
# only filename that can distinguish "extends" from "replaces".
OUT="$(RECALL_MEMORY_DIRS="$(cygpath -m "$MEM2" 2>/dev/null || echo "$MEM2")" "$PY" "$RECALL" --lexical-only -k 8 "unique to the primary store" 2>/dev/null)"
echo "$OUT" | grep -q 'only-here.md' || fail "naming only the secondary corpus dropped the primary from search"
echo "ok: RECALL_MEMORY_DIRS extends the primary corpus rather than replacing it"

# ---------------------------------------------------------------- an unknown mode is not silent
# rank() used to fall through every branch on an unrecognised mode, producing all-zero scores and
# an alphabetical result set -- so a typo like --modes hybird printed a plausible table and a
# benchmark exited 0. Mutation: delete the _check_mode call in rank().
#
# The parts are passed in so rank() cannot fall through to _retriever, which calls _check_mode
# as its own first statement. Without them the deleted call was replaced by _retriever's and the
# ValueError still arrived, so the assertion passed against the mutation it names. Proven by
# applying it. Empty parts are enough: the check must happen before anything is scored.
ERR="$("$PY" -c "
import importlib.util, sys
s = importlib.util.spec_from_file_location('recall', sys.argv[1])
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
parts = dict(idx={'files': {}}, names=[], lex={'df': {}, 'len': {}, 'avg': 1.0, 'text': {}}, emb=None)
try:
    m.rank('anything', mode='hybird', **parts)
    print('NO-RAISE')
except ValueError as e:
    print('RAISED', e)
" "$RECALL" 2>&1)"
echo "$ERR" | grep -q 'RAISED' || fail "an unknown ranking mode did not raise: $ERR"
echo "$ERR" | grep -q 'hybird' || fail "the error does not name the bad mode"
echo "ok: an unrecognised ranking mode raises instead of scoring everything zero"

echo "ALL PASS"
