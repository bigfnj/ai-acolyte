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
rm -f "$MEM"/deep.md
{
  printf -- '---\nname: doc\nmetadata:\n  type: reference\n---\n\n'
  printf 'How to declare a gate:\n\n```yaml\nmetadata:\n  scope: global\n```\n\n'
  printf -- '<!-- gate -->\n- **This must NOT compile.** It is documentation, not a declaration.\n<!-- /gate -->\n'
} > "$MEM/doc.md"
"$PY" "$RECALL" --gates-compile >/dev/null 2>&1
grep -q 'must NOT compile' "$TMP/.claude/gates.generated.md" \
  && fail "a scope: global inside a fenced code example was compiled as a real gate"
echo "ok: scope: global inside a fenced example is not treated as a declaration"

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

echo "ALL PASS"
