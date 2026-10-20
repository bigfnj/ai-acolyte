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

# ---------------------------------------------------------------- B2: the write is ATOMIC
# Mutation: replace save_index's body (memory/recall.py:416-427#save_index) with a plain in-place
# `json.dump(idx, open(INDEX_PATH, "w"))`. The file-identity assertion below fails; nothing
# else in this suite does.
#
# The residue check underneath used to be the only guard here, and it was vacuous twice over.
# It globbed for `recall_index.json.tmp`, but save_index names its temp file with the writing
# PID -- `recall_index.json.<pid>.tmp` (memory/recall.py:432#os.getpid) -- so the literal path
# it tested has never existed on any run, broken or not. And even spelled correctly it only fires for
# "wrote a tmp, forgot os.replace": revert to an in-place json.dump and there is no temp file
# to leave behind, so it passes on the state it exists to forbid. Between it and the
# source-text pin, NOTHING failed when the write stopped being atomic.
#
# What separates the two implementations observably is file IDENTITY. os.replace swaps a new
# file into the name, so the NTFS file index changes; `open(path, "w")` truncates the existing
# file and keeps it. st_ino carries that index on Windows, which is where this suite runs.
file_id() {
  "$PY" -c "import os,sys; print(os.stat(sys.argv[1]).st_ino)" "$1"
}
printf -- '---\nname: d\ndescription: delta\n---\ndelta body\n' > "$MEM/d.md"
printf -- '---\nname: e\ndescription: echo\n---\necho body\n' > "$MEM/e.md"
seed_index
ID_BEFORE="$(file_id "$MEM/recall_index.json")"
[ -n "$ID_BEFORE" ] || fail "precondition: could not read the index file id, so atomicity is untestable"
rm "$MEM/e.md"
"$PY" "$RECALL" --list >/dev/null 2>&1
[ "$(count_index)" = "1" ] || fail "expected 1 entry after the deletion, got $(count_index)"
ID_AFTER="$(file_id "$MEM/recall_index.json")"
[ "$ID_BEFORE" != "$ID_AFTER" ] \
  || fail "the index was rewritten IN PLACE (file id $ID_AFTER unchanged): save_index is no longer atomic, so an interrupted write truncates the real cache"
# Correctly spelled this time, and still worth keeping: it is the other failure mode, where
# the tmp is written and the os.replace is dropped or throws.
for residue in "$MEM"/recall_index.json.*.tmp; do
  [ -e "$residue" ] && fail "a successful write left $residue behind"
done
echo "ok: the index write replaces the file rather than truncating it, and leaves no .tmp residue"

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
# Pin the OFFSET of `scope:`, not the file size. The size check passed on a fixture where
# scope: sat INSIDE the 400-byte window: measured 654 bytes with scope: at 540, and shortening
# the padding loop from 60 to 42 gives 510 bytes (size check still passes) with scope: at 396,
# where the text[:400] mutation this test exists to kill would survive silently. The ~100 bytes
# of gate block appended after the frontmatter is what opens the gap.
SCOPE_AT="$(grep -bo "scope: global" "$MEM/deep.md" | cut -d: -f1)"
[ -n "$SCOPE_AT" ] || fail "fixture does not contain scope: global at all"
[ "$SCOPE_AT" -gt 400 ] || fail "fixture puts scope: at byte $SCOPE_AT, inside the 400-byte window this test exists to cross"

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

# ------------------------------------------ --lint and the compiler must make the SAME gate test
# The linter asked `GATE_BEGIN in text`; the compiler requires GATE_BEGIN(.*?)GATE_END. So a
# memory with an opening marker and no closing one compiled NOTHING and was left out of the
# "resident-eligible, not compiled" report -- the one line that exists to say so. Not
# hypothetical: on the live corpus project_memory_gates.md is scope:global with a lone
# `<!-- gate -->` in prose, and --lint reported nothing at all about it.
#
# Mutation: put `GATE_BEGIN in text` back in lint()'s meta[] tuple. `unclosed` then vanishes from
# the report and the first assertion below fails, naming this file.
#
# Both halves are asserted over ONE corpus on purpose. Asserting only the report would also pass
# if the COMPILER were widened to match the linter, which loses the same gate from the other
# direction: half a gate block would become a standing order.
rm -f "$MEM"/*.md "$TMP/.claude/gates.generated.md"
printf -- '---\nname: closed\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **Closed.** Pass: this one compiles.\n<!-- /gate -->\n' > "$MEM/closed.md"
printf -- '---\nname: unclosed\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **Unclosed.** Nobody wrote the closing marker.\n' > "$MEM/unclosed.md"
printf -- '# Memory Index\n' > "$MEM/MEMORY.md"
"$PY" "$RECALL" --gates-compile >/dev/null 2>&1 \
  || fail "--gates-compile exited non-zero on a corpus holding one half-written gate"
# Captured in THIS shell, and the exit status checked before the text is read: `lint | grep`
# would run `fail` in a subshell and let a CRASHED lint read as a silent pass. gates-stale.sh
# carries the same note after that exact mistake survived a mutation twice.
GATE_LINT="$("$PY" "$RECALL" --lint)" || fail "--lint exited non-zero"
[ -n "$GATE_LINT" ] || fail "--lint produced no output at all"
# Sliced to ONE report, not grepped across the whole run. lint() prints several findings as
# `    <stem>` at the same indent, so a bare stem grep cannot tell which report named the file
# and a mutation in one is reported against another -- measured: widening the unplaceable-gate
# predicate made the assertion below fail with "reported a fully paired gate as not compiled",
# about a report that had not moved. `report_block` takes the lines under a heading, up to the
# blank line that ends it, so every assertion names the report it is actually about.
report_block() {   # report_block <lint output> <substring of the heading line>
  printf '%s\n' "$1" | awk -v want="$2" '
    index($0, want) { on = 1; next }
    on && /^[[:space:]]*$/ { exit }
    on { print }'
}
NOT_COMPILED="$(report_block "$GATE_LINT" 'resident-eligible, not compiled')"
printf '%s\n' "$NOT_COMPILED" | grep -q '^    unclosed$' \
  || fail "--lint did not report the half-written gate as resident-eligible, not compiled"
printf '%s\n' "$NOT_COMPILED" | grep -q '^    closed$' \
  && fail "--lint reported a fully paired gate as not compiled"
grep -q 'Pass: this one compiles' "$TMP/.claude/gates.generated.md" \
  || fail "the fully paired gate did not compile"
grep -q 'Nobody wrote the closing marker' "$TMP/.claude/gates.generated.md" \
  && fail "an unpaired opening marker was compiled into the standing orders"
echo "ok: --lint reports a gate the compiler skips, using the compiler's own pairing test"

# ------------------------------------- the SAME skip from the other side: a block with no scope:
# _compile_gates_text() selects on `scope:`, so a fully paired <!-- gate --> block in a file that
# declares no scope at all is written, reads as a standing order to anyone opening the memory, and
# is dropped in silence. lint()'s `no_gate` report is the inverse condition and was blind to it.
# Live when this was written: heredoc-eats-backslashes and xml-comments-reject-double-hyphen both
# carry a paired block with no scope:, and MEMORY.md lists the first as compiled into CLAUDE.md.
#
# Mutation: delete the `gate_no_scope` block from lint(). The first assertion fails, naming this
# file. Mutating the predicate to `meta[s][2]` alone instead fails the second: a scope:global gate
# would then be reported as unplaceable.
#
# THREE files on one corpus on purpose. `placed` proves the report is not "every gate block", and
# `local` proves a non-global scope is not a finding -- scope: ai-platform belongs in that repo's
# CLAUDE.local.md and is installed by hand, so --gates-compile skipping it is correct, not a loss.
rm -f "$MEM"/*.md "$TMP/.claude/gates.generated.md"
printf -- '---\nname: orphan\nmetadata:\n  type: reference\n---\n<!-- gate -->\n- **Orphan.** A gate block nobody gave a scope.\n<!-- /gate -->\n' > "$MEM/orphan.md"
printf -- '---\nname: placed\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **Placed.** Pass: this one compiles.\n<!-- /gate -->\n' > "$MEM/placed.md"
printf -- '---\nname: local\nmetadata:\n  scope: ai-platform\n---\n<!-- gate -->\n- **Local.** Hand-installed in a repo CLAUDE.local.md.\n<!-- /gate -->\n' > "$MEM/local.md"
printf -- '# Memory Index\n' > "$MEM/MEMORY.md"
"$PY" "$RECALL" --gates-compile >/dev/null 2>&1 \
  || fail "--gates-compile exited non-zero on a corpus holding one unscoped gate block"
ORPHAN_LINT="$("$PY" "$RECALL" --lint)" || fail "--lint exited non-zero"
[ -n "$ORPHAN_LINT" ] || fail "--lint produced no output at all"
UNPLACEABLE="$(report_block "$ORPHAN_LINT" 'nowhere to place it')"
printf '%s\n' "$UNPLACEABLE" | grep -q '^    orphan$' \
  || fail "--lint did not report a paired gate block that declares no scope:"
printf '%s\n' "$UNPLACEABLE" | grep -q '^    placed$' \
  && fail "--lint reported a scope:global gate block as unplaceable"
printf '%s\n' "$UNPLACEABLE" | grep -q '^    local$' \
  && fail "--lint reported a non-global scope as unplaceable; only a MISSING scope is"
grep -q 'A gate block nobody gave a scope' "$TMP/.claude/gates.generated.md" \
  && fail "an unscoped gate block was compiled into the standing orders"
# Printing the finding is half of it; the verdict at the bottom has to agree. Mutation: drop
# `gate_no_scope` from lint()'s clean condition.
printf '%s\n' "$ORPHAN_LINT" | grep -q 'clean:' \
  && fail "--lint reported an unplaceable gate block and still called the corpus clean"
echo "ok: --lint reports a paired gate block that declares no scope, which the compiler drops"

# ------------------------------------------- a gate block in the INDEX, which nothing can lift
# _compile_gates_text() skips EXCLUDE unconditionally; lint() built both gate reports from every
# .md stem, MEMORY included. That is wrong in three separable ways, and excluding the index only
# fixes two of them -- both reports are INVERSE conditions, so an index carrying a scope AND a
# correctly paired block satisfies neither and goes unmentioned whichever list they are built
# from. That is the silent skip: a block written in MEMORY.md is resident in this project only,
# and is not a standing order anywhere else however global its scope says it is.
#
# No live corpus reaches any of this: no MEMORY.md here carries frontmatter, and the lone
# `<!-- gate -->` in the real index is unpaired prose about this pipeline. A property of the data
# in a user-edited file, not of the code -- so the case is BUILT here rather than looked for.
#
# Three mutations, three different assertions, all naming this file:
#   delete the `index_gate` report      -> "a gate block in MEMORY.md went unreported"
#   `gateable` -> `stems` in gate_no_scope -> "named MEMORY in the unplaceable report"  (case B)
#   `gateable` -> `stems` in no_gate       -> "told the user to add a gate block"       (case C)
rm -f "$MEM"/*.md "$TMP/.claude/gates.generated.md"
printf -- '---\nname: keep\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **Keep.** Pass: a real gate so the compile is not empty.\n<!-- /gate -->\n' > "$MEM/keep.md"
# A: scope AND a paired block. The compiler drops it in silence and neither inverse report can
# mention it, so the only correct behaviour is a report of its own.
printf -- '---\nname: MEMORY\nmetadata:\n  scope: global\n---\n# Memory Index\n<!-- gate -->\n- **Index gate.** Nothing may ever lift this.\n<!-- /gate -->\n' > "$MEM/MEMORY.md"
"$PY" "$RECALL" --gates-compile >/dev/null 2>&1 || fail "precondition: the keep gate should compile"
INDEX_LINT="$("$PY" "$RECALL" --lint)" || fail "--lint exited non-zero"
[ -n "$INDEX_LINT" ] || fail "--lint produced no output at all"
grep -q 'Index gate' "$TMP/.claude/gates.generated.md" \
  && fail "the compiler lifted a gate block out of MEMORY.md; EXCLUDE no longer holds"
printf '%s\n' "$INDEX_LINT" | grep -q '^    MEMORY\.md  (move it' \
  || fail "a gate block in MEMORY.md went unreported; nothing will ever compile it"
printf '%s\n' "$INDEX_LINT" | grep -q 'clean:' \
  && fail "--lint reported a gate block nothing can compile and still called the corpus clean"
# B: a paired block and no scope. Reporting "no scope:" would send the user to add one, which
# changes nothing, because the index is skipped on its NAME.
printf -- '---\nname: MEMORY\nmetadata:\n  type: reference\n---\n# Memory Index\n<!-- gate -->\n- **Index gate.** Nothing may ever lift this.\n<!-- /gate -->\n' > "$MEM/MEMORY.md"
INDEX_LINT="$("$PY" "$RECALL" --lint)" || fail "--lint exited non-zero"
report_block "$INDEX_LINT" 'nowhere to place it' | grep -q '^    MEMORY$' \
  && fail "--lint named MEMORY in the unplaceable report; a scope there would not help"
# C: a scope and NO block. Same: writing one would not get it compiled either.
printf -- '---\nname: MEMORY\nmetadata:\n  scope: global\n---\n# Memory Index\n' > "$MEM/MEMORY.md"
INDEX_LINT="$("$PY" "$RECALL" --lint)" || fail "--lint exited non-zero"
report_block "$INDEX_LINT" 'resident-eligible, not compiled' | grep -q '^    MEMORY$' \
  && fail "--lint told the user to add a gate block to MEMORY.md, which EXCLUDE drops anyway"
echo "ok: a gate block in the index is reported once, and never as advice that would not help"

# ------------------------------------------------- `clean:` may not assert more than it tests
# The verdict claims budget, links and standing orders. It tested five of eight printed findings:
# the byte budget, the attention ceiling and unresolved [[links]] were all absent from the
# condition, so a 9,757-byte index, 24 entries over the ceiling, with a dangling wiki-link,
# printed both warnings and then "clean: index within budget, links resolve" underneath them.
# Three of those words were decorative -- the exact shape of a log line that cannot fail.
#
# ONE AXIS PER CORPUS, which is the whole reason this is a loop and not one dirty fixture. The
# first version varied the ceiling and the wiki-link together and MEASURABLY could not fail:
# dropping `over_ceiling` from the condition left `unresolved` firing and the suite said ALL
# PASS. A differential fixture is only as strong as the axes it varies one at a time.
#
# Mutation, per arm: drop that arm's term from the condition in lint(). Exactly the arm named
# fails, naming this file.
rm -f "$MEM"/*.md "$TMP/.claude/gates.generated.md"
printf -- '---\nname: g\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **Clean.** Pass: nothing to report.\n<!-- /gate -->\n' > "$MEM/g.md"

clean_index() { printf -- '# Memory Index\n\n- [g](g.md) hook\n' > "$MEM/MEMORY.md"; }
clean_index
"$PY" "$RECALL" --gates-compile >/dev/null 2>&1 || fail "precondition: the clean corpus should compile"
CLEAN_LINT="$("$PY" "$RECALL" --lint)" || fail "--lint exited non-zero"
printf '%s\n' "$CLEAN_LINT" | grep -q 'clean:' \
  || fail "a corpus with no findings at all never reaches the clean verdict"

# Each arm perturbs exactly one axis away from that corpus, and asserts BOTH that its own
# warning fired (or the fixture is degenerate and proves nothing) and that clean: did not.
#   over_budget   > LINT_TOTAL_WARN bytes, from prose -- entry count and line length untouched
#   over_ceiling  > LINT_ENTRY_WARN short entries -- 40 x ~20 chars stays well inside the budget
#   unresolved    one [[link]] to nothing -- one extra short line changes no other axis
check_axis() {   # check_axis <name> <warning substring>
  AXIS_LINT="$("$PY" "$RECALL" --lint)" || fail "$1: --lint exited non-zero"
  printf '%s\n' "$AXIS_LINT" | grep -q "$2" \
    || fail "degenerate fixture for $1: its own warning never fired, so clean: was not challenged"
  printf '%s\n' "$AXIS_LINT" | grep -q 'clean:' \
    && fail "--lint printed the $1 warning and then called the corpus clean"
}

# 50 prose lines of ~255 characters: past the byte budget, and still inside the 140-line target
# and the 300-character line rule, so this arm moves bytes alone (it used 200 short lines until
# the line target existed, which would have made it a two-axis fixture).
PAD="$(printf '%0240d' 0 | tr 0 p)"
{ clean_index
  i=0; while [ $i -lt 50 ]; do
    printf 'Prose line %03d, %s\n' "$i" "$PAD"
    i=$((i + 1))
  done
} > "$MEM/MEMORY.md"
check_axis over_budget 'over budget'

{ printf -- '# Memory Index\n\n'
  i=0; while [ $i -lt 40 ]; do printf -- '- [g](g.md) hook %02d\n' "$i"; i=$((i + 1)); done
} > "$MEM/MEMORY.md"
check_axis over_ceiling 'over the attention ceiling'

clean_index
printf 'A forward link to nothing: [[no-such-memory]]\n' >> "$MEM/MEMORY.md"
check_axis unresolved 'unresolved \[\[links\]\]'

# The MEMORY.md guard's three rules (2026-10-19), one axis each, the same way.
#   over_lines       150 short prose lines: past the 140-line target, ~1.5 KB, no entries added
#   over (any line)  one 301-character PROSE line: the rule used to read only "- " lines
#   comment_defects  a <!-- inside an open comment: one short line, nothing else moves
{ clean_index
  i=0; while [ $i -lt 150 ]; do printf 'note %03d\n' "$i"; i=$((i + 1)); done
} > "$MEM/MEMORY.md"
check_axis over_lines 'line(s) past the 140-line target'

clean_index
printf '%0301d\n' 0 | tr 0 q >> "$MEM/MEMORY.md"
check_axis long_prose_line 'index line(s) over 300 chars'

clean_index
printf '<!-- header <!-- nested --> tail -->\n' >> "$MEM/MEMORY.md"
check_axis comment_defects 'broken HTML comment'
echo "ok: the clean verdict tests every finding it prints, not five of eight"

# --------------------------------------------- widths are code points, and fenced markers are code
# 300 astral emoji are 300 characters to len(), the guard and the editor lint alike, and 1200
# UTF-8 bytes. A comment marker inside a fence or a code span is an example, not a comment.
# Mutation: measure width in UTF-8 bytes or UTF-16 units, or drop the fence skip in
# _comment_defects, and this fails.
clean_index
"$PY" -c "import sys; open(sys.argv[1], 'a', encoding='utf-8').write('\U0001F600' * 300 + '\n')" "$MEM/MEMORY.md"
printf '```\n<!-- an example\n```\n- write `-->` to close\n' >> "$MEM/MEMORY.md"
WIDE_LINT="$("$PY" "$RECALL" --lint)" || fail "--lint exited non-zero on the code-point fixture"
printf '%s\n' "$WIDE_LINT" | grep -q 'over 300 chars' \
  && fail "300 code points were counted as more than 300 characters"
printf '%s\n' "$WIDE_LINT" | grep -q 'broken HTML comment' \
  && fail "a comment marker inside fenced code or a code span was read as a comment"
printf '%s\n' "$WIDE_LINT" | grep -q 'clean:' \
  || fail "the code-point fixture should be clean"
echo "ok: line widths are code points, and comment markers in code are not comments"

# ---------------------------------------------------------------- gates compile is ORDERED
# Mutation: drop the `sorted()` from `for name in sorted(os.listdir(MEMORY_DIR))` at
# (memory/recall.py:1312#sorted). The order assertion below fails; the two-compiles assertion does not.
#
# This block used to hold one gate memory and compile it twice. With ONE file there is no
# order to get wrong, and with any number of files a second os.listdir over an UNCHANGED
# directory returns the same sequence as the first -- so `$ONE = $TWO` held for a compiler
# with no ordering guarantee whatsoever. The docstring at memory/recall.py:1304#Sorted promises
# "Sorted by filename and hashed so a re-run is byte-identical", and nothing tested the first
# half of that sentence, which is the half the second one rests on: two machines, or one
# machine after a restore, agree on the sha only because the walk is sorted.
#
# The fixture is eight memories whose NTFS directory order is NOT their sorted order. NTFS
# collates case-insensitively and puts `_` after the letters, so `A2 a5 b1 B4 c3 C6 z8 _7`
# comes back from os.listdir where sorted() gives `A2 B4 C6 _7 a5 b1 c3 z8`. Each gate body
# names its own file, so the compiled output can be read back as a sequence.
rm -f "$MEM"/*.md
GATE_STEMS='A2 B4 C6 _7 a5 b1 c3 z8'
for stem in $GATE_STEMS; do
  printf -- '---\nname: %s\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **Gate from %s.**\n<!-- /gate -->\n' \
    "$stem" "$stem" > "$MEM/$stem.md"
done
printf -- '# Memory Index\n' > "$MEM/MEMORY.md"

# The axis has to be non-degenerate or the order assertion proves nothing, and a control that
# can run degraded must say so rather than skip in silence.
DISK_ORDER="$("$PY" -c "import os,sys; print(' '.join(n[:-3] for n in os.listdir(sys.argv[1]) if n.endswith('.md') and n != 'MEMORY.md'))" "$MEM")"
SORTED_ORDER="$("$PY" -c "import os,sys; print(' '.join(sorted(n[:-3] for n in os.listdir(sys.argv[1]) if n.endswith('.md') and n != 'MEMORY.md')))" "$MEM")"

"$PY" "$RECALL" --gates-compile >/dev/null 2>&1
ONE="$(head -1 "$TMP/.claude/gates.generated.md")"
COMPILED_ORDER="$(grep -o 'Gate from [A-Za-z0-9_]*' "$TMP/.claude/gates.generated.md" | sed 's/Gate from //' | tr '\n' ' ' | sed 's/ $//')"
[ -n "$COMPILED_ORDER" ] || fail "precondition: the compiled file names no gate, so there is no order to read"

if [ "$DISK_ORDER" = "$SORTED_ORDER" ]; then
  echo "DEGRADED: this filesystem returns directory entries already sorted ($DISK_ORDER), so the"
  echo "          order assertion below cannot tell a sorted walk from an unsorted one. The"
  echo "          two-compiles check still runs; the ordering guarantee does NOT."
else
  [ "$COMPILED_ORDER" = "$SORTED_ORDER" ] \
    || fail "the gate compile is not sorted by filename: compiled '$COMPILED_ORDER', sorted '$SORTED_ORDER', on-disk '$DISK_ORDER'"
fi

"$PY" "$RECALL" --gates-compile >/dev/null 2>&1
TWO="$(head -1 "$TMP/.claude/gates.generated.md")"
[ "$ONE" = "$TWO" ] || fail "compiling twice over an unchanged corpus produced a different sha"
echo "ok: the gate compile walks the corpus in filename order, and two runs yield the same sha"

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

# --------------------------------------- the refusal's "N bytes" has to be BYTES, not characters
# _installed_gate_bytes() read the file in TEXT mode and returned len(), so the number the refusal
# prints at the user was a CHARACTER count: 5864 against a real 5872 on the live gate file. The
# helper's name says bytes, the message says bytes, and lint() had the identical unit error
# against MEMORY.md 130 lines above. Mutation: put `len(existing)` back -- both assertions below
# fire (the shipped `fail` exits on the first), and the second names the wrong number outright.
#
# The em-dash is the whole fixture. With an ASCII-only gate the two counts are EQUAL and this
# test cannot fail however broken the helper is, so the counts are compared first and the run
# stops if they ever coincide. An axis that does not vary is not an axis.
rm -f "$MEM"/*.md "$GATES"
printf -- '---\nname: wide\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **Wide.** Pass: an em-dash \xe2\x80\x94 makes bytes and characters differ.\n<!-- /gate -->\n' > "$MEM/wide.md"
printf -- '# Memory Index\n' > "$MEM/MEMORY.md"
"$PY" "$RECALL" --gates-compile >/dev/null 2>&1 || fail "precondition: the em-dash gate should compile"
SIZE="$(wc -c < "$GATES" | tr -d ' ')"
CHARS="$("$PY" -c "import sys;print(len(open(sys.argv[1],encoding='utf-8').read()))" "$GATES")"
[ "$SIZE" != "$CHARS" ] \
  || fail "fixture is degenerate: $GATES is $SIZE bytes and $CHARS chars, so this cannot fail"
ERR="$(RECALL_MEMORY_DIR="$GATELESS" "$PY" "$RECALL" --gates-compile 2>&1 >/dev/null)"
printf '%s\n' "$ERR" | grep -qF "($SIZE bytes)" \
  || fail "the refusal does not report the file's real size of $SIZE bytes: '$ERR'"
printf '%s\n' "$ERR" | grep -qF "($CHARS bytes)" \
  && fail "the refusal reported $CHARS -- the CHARACTER count -- and called it bytes: '$ERR'"
echo "ok: the refusal reports the installed gates' real byte count, not its character count"

# ------------------------------------ MEMORY_DIR is normalised before any message interpolates it
# _discover_memory_dir builds on expanduser("~/.claude/projects"), which substitutes a backslash
# HOME into a forward-slash literal and leaves the rest: the primary corpus read
# `C:\Users\<user>/.claude/projects\<slug>\memory` on this box. GATES_OUT was normpath'd for
# exactly this reason -- it lands in the two compile_gates() refusals, where a mixed-separator
# path reads like a bug in the thing reporting the bug -- and MEMORY_DIR, which lands in the SAME
# two messages, was not. Mutation: drop the normpath() around the MEMORY_DIR assignment.
#
# The redundant `.` is built INSIDE python, not passed through the shell: MSYS rewrites anything
# path-shaped on its way into python.exe (see the note in the gateless block above), and a fixture
# the shell has already normalised is a fixture that cannot fail. The first assertion proves the
# raw value really is non-normal on whatever platform this is running on.
"$PY" - "$RECALL" <<'PY' || fail "MEMORY_DIR is not normalised, so both refusal messages print a mixed-separator path"
import os, runpy, sys
recall = sys.argv[1]
raw = os.path.join(os.environ["RECALL_MEMORY_DIR"], ".", "")
assert raw != os.path.normpath(raw), f"degenerate fixture: {raw!r} is already normal"
os.environ["RECALL_MEMORY_DIR"] = raw
got = runpy.run_path(recall)["MEMORY_DIR"]
assert got == os.path.normpath(raw), f"MEMORY_DIR kept the raw form {got!r}"
PY
echo "ok: MEMORY_DIR is normalised, so the refusal messages name one separator style"

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

# ---------------------------------------------------------------- the gates write is ATOMIC
# Ported from rampage 7139659 (2026-10-14). compile_gates wrote gates.generated.md in place, and
# a reader racing that write could read it empty or partial, which src/agent-gates.js turned into
# an empty or truncated gates block. It now writes a pid-named temp and os.replace()s it over the
# target, as save_index does, and the observable is the one the index test above uses: os.replace
# swaps a NEW file in, so the file id changes, while an in-place write truncates the old file and
# keeps its id.
#
# Mutation: put `with open(GATES_OUT, "w", ...)` back in place of the temp file and os.replace.
# The file-id assertion fails, naming this file; nothing else here does.
ATOM="$TMP/atomic"; mkdir -p "$ATOM"
printf -- '# Memory Index\n' > "$ATOM/MEMORY.md"
printf -- '---\nname: a\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **Atomic one.** Pass: first wording.\n<!-- /gate -->\n' > "$ATOM/a.md"
RECALL_MEMORY_DIR="$ATOM" "$PY" "$RECALL" --gates-compile >/dev/null 2>&1 || fail "precondition: the atomic corpus should compile"
ID_BEFORE="$(file_id "$GATES")"
[ -n "$ID_BEFORE" ] || fail "precondition: could not read the compiled file's id, so atomicity is untestable"
printf -- '---\nname: a\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **Atomic one.** Pass: second wording.\n<!-- /gate -->\n' > "$ATOM/a.md"
RECALL_MEMORY_DIR="$ATOM" "$PY" "$RECALL" --gates-compile >/dev/null 2>&1 || fail "the second atomic compile exited non-zero"
grep -q 'second wording' "$GATES" || fail "the recompile did not reach gates.generated.md"
ID_AFTER="$(file_id "$GATES")"
[ "$ID_BEFORE" != "$ID_AFTER" ] \
  || fail "gates.generated.md was rewritten IN PLACE (file id $ID_AFTER unchanged): a reader racing the compile can read it empty"
for residue in "$TMP/.claude"/gates.generated.md.*.tmp; do
  [ -e "$residue" ] && fail "a successful gates compile left $residue behind"
done
echo "ok: the gates write replaces the file rather than truncating it, and leaves no .tmp residue"

# ------------------------------------------- an unreadable store stops the gates compile cold
# Ported from rampage 7139659. With RECALL_MEMORY_DIR unset, _discover_memory_dir picks the store
# holding the most .md files, and one it cannot read is skipped with a warning. The pick then
# falls to the next-largest store, and --gates-compile used to compile THAT store's gates and exit
# 0, while `wildcard-perms --gates refresh` swallowed the warning: the standing orders silently
# came from the wrong store. A gate is a standing order, so the compile now refuses, writes
# nothing, and names the store. (The extension passes RECALL_MEMORY_DIR whenever it has a store,
# so this is the CLI's and a bare run's path.)
#
# The unreadable store is simulated by making os.listdir raise for it inside the harness, so this
# runs the same on every platform and as any user (a chmod 000 does not stop root). The first
# compile, with nothing denied, is the control: it proves the big store IS the pick, so the
# refusal after it is caused by the read failure and nothing else.
#
# Mutations, one assertion each, all naming this file:
#   delete the `if _DISCOVERY_ERRORS:` refusal in compile_gates -> "compiled gates from the fallback"
#   drop the append in _discover_memory_dir's per-store except  -> "compiled gates from the fallback"
DHOME="$TMP/disc-home"
for store in big-store small-store; do mkdir -p "$DHOME/.claude/projects/$store/memory"; done
DBIG="$DHOME/.claude/projects/big-store/memory"
DSMALL="$DHOME/.claude/projects/small-store/memory"
printf -- '# Memory Index\n' > "$DBIG/MEMORY.md"
printf -- '# Memory Index\n' > "$DSMALL/MEMORY.md"
printf -- '---\nname: b1\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **Big-store gate one.**\n<!-- /gate -->\n' > "$DBIG/b1.md"
printf -- '---\nname: b2\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **Big-store gate two.**\n<!-- /gate -->\n' > "$DBIG/b2.md"
printf -- '---\nname: b3\n---\nplain note\n' > "$DBIG/b3.md"
printf -- '---\nname: s1\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **Small-store gate.**\n<!-- /gate -->\n' > "$DSMALL/s1.md"
DISC_OUT="$(RECALL_MEMORY_DIR= "$PY" - "$RECALL" "$DHOME" 2>&1 <<'PY'
import importlib.util, os, sys
recall, home = sys.argv[1:3]
os.environ.pop("RECALL_MEMORY_DIR", None)
os.environ["HOME"] = os.environ["USERPROFILE"] = home
big = os.path.join(home, ".claude", "projects", "big-store", "memory")
key = lambda p: os.path.normcase(os.path.abspath(p))
real_listdir = os.listdir
def run(deny):
    def listdir(p="."):
        if deny and key(p) == key(deny):
            raise PermissionError(13, "Permission denied", p)
        return real_listdir(p)
    os.listdir = listdir
    try:
        s = importlib.util.spec_from_file_location("recall", recall)
        m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
        try:
            m.compile_gates()
            return m, "RETURNED"
        except SystemExit as e:
            return m, f"EXIT {e.code}"
    finally:
        os.listdir = real_listdir
m, result = run(None)
print("CONTROL-PICK-OK" if key(m.MEMORY_DIR) == key(big) else f"CONTROL-PICK-WRONG {m.MEMORY_DIR}")
print("CONTROL", result)
m, result = run(big)
print("DENY", result)
PY
)"
printf '%s\n' "$DISC_OUT" | grep -q '^CONTROL-PICK-OK' \
  || fail "precondition: discovery did not pick the larger store, so the refusal below proves nothing: $DISC_OUT"
printf '%s\n' "$DISC_OUT" | grep -q '^CONTROL RETURNED' \
  || fail "precondition: the control compile, with nothing unreadable, did not succeed: $DISC_OUT"
grep -q 'Small-store gate' "$DHOME/.claude/gates.generated.md" \
  && fail "an unreadable store let --gates-compile compile gates from the fallback store"
grep -q 'Big-store gate one' "$DHOME/.claude/gates.generated.md" \
  || fail "the refused compile changed the gates compiled from the big store: $DISC_OUT"
printf '%s\n' "$DISC_OUT" | grep -q '^DENY EXIT .*refusing to compile gates.*big-store' \
  || fail "the refusal does not exit non-zero naming the store it could not read: $DISC_OUT"
echo "ok: a store discovery cannot read stops --gates-compile, which names it and writes nothing"

# ...but a home with no ~/.claude/projects at all is a fresh machine, not an unreadable store. The
# root listdir raises FileNotFoundError there, and recording that refused every compile on a
# machine that had never run a session, where the fresh-machine test above expects a quiet no-op.
# That test cannot see it: it sets RECALL_MEMORY_DIR, and discovery only runs without one.
# Mutation: record the root's error whatever it is (drop the isinstance(e, FileNotFoundError)
# test in _discover_memory_dir) -> "a home with no projects dir refused the gates compile".
FRESH="$TMP/fresh-home"; mkdir -p "$FRESH"
FRESH_OUT="$(RECALL_MEMORY_DIR= "$PY" - "$RECALL" "$FRESH" 2>&1 <<'PY'
import importlib.util, os, sys
recall, home = sys.argv[1:3]
os.environ.pop("RECALL_MEMORY_DIR", None)
os.environ["HOME"] = os.environ["USERPROFILE"] = home
assert not os.path.exists(os.path.join(home, ".claude")), "degenerate fixture: the fresh home has a .claude"
s = importlib.util.spec_from_file_location("recall", recall)
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
try:
    m.compile_gates()
    print("FRESH RETURNED")
except SystemExit as e:
    print(f"FRESH EXIT {e.code}")
PY
)"
printf '%s\n' "$FRESH_OUT" | grep -q '^FRESH RETURNED' \
  || fail "a home with no projects dir refused the gates compile, where a fresh machine is a quiet no-op: $FRESH_OUT"
[ -e "$FRESH/.claude/gates.generated.md" ] && fail "a fresh machine's no-op gates compile wrote a gates file"
echo "ok: a home with no ~/.claude/projects is a fresh machine, and its gates compile stays a no-op"

# ------------------------------------------- gates in OTHER stores are reported, never compiled
# The maintainer's decision (2026-10-14): the compiler reads one store (RECALL_MEMORY_DIR, else
# the largest) and a scope:global gate anywhere else was ignored in silence. It is still never
# compiled; --lint now names each other store, by folder name only, with how many gate memories
# it holds that are not installed. A gate whose text the compile store already has is installed,
# so a store copied rather than moved is not reported for it.
#
# Mutations, one assertion each:
#   delete the other-store section in lint()                  -> "--lint did not report the other store"
#   drop `body not in primary_bodies` in _other_store_gates   -> the count reads 2: "did not report"
#   drop `or other_gates or other_unreadable` from `clean:`   -> "called a corpus ... clean"
#   drop the unreadable append in _other_store_gates          -> "skipped in silence"
# (The `== primary` skip is not separately falsifiable: every gate the compile store holds is in
# primary_bodies by construction, so the dedup already zeroes it. The skip saves the re-read.)
OHOME="$TMP/other-home"
OP="$OHOME/.claude/projects"
mkdir -p "$OP/main-store/memory" "$OP/side-store/memory" "$OP/quiet-store/memory" "$OHOME/.claude"
gate() { printf -- '---\nname: %s\nmetadata:\n  scope: global\n---\n<!-- gate -->\n- **%s**\n<!-- /gate -->\n' "$1" "$2"; }
printf -- '# Memory Index\n' > "$OP/main-store/memory/MEMORY.md"
gate m1 'Main-store gate.' > "$OP/main-store/memory/m1.md"
printf -- '---\nname: m2\n---\nplain\n' > "$OP/main-store/memory/m2.md"
printf -- '---\nname: m3\n---\nplain\n' > "$OP/main-store/memory/m3.md"
printf -- '# Memory Index\n' > "$OP/side-store/memory/MEMORY.md"
gate s1 'Side-store gate.' > "$OP/side-store/memory/s1.md"
gate s2 'Main-store gate.' > "$OP/side-store/memory/s2-copied.md"   # installed via main-store
printf -- '# Memory Index\n' > "$OP/quiet-store/memory/MEMORY.md"
printf -- '---\nname: q1\n---\nno gate here\n' > "$OP/quiet-store/memory/q1.md"
olint()    { HOME="$OHOME" USERPROFILE="$OHOME" RECALL_MEMORY_DIR="${1:-}" "$PY" "$RECALL" --lint 2>&1; }
ocompile() { HOME="$OHOME" USERPROFILE="$OHOME" RECALL_MEMORY_DIR="${1:-}" "$PY" "$RECALL" --gates-compile >/dev/null 2>&1; }
OGATES="$OHOME/.claude/gates.generated.md"

OUT="$(olint)"
printf '%s\n' "$OUT" | grep -q '1 scope:global gate memory in other memory stores -- not installed' \
  || fail "--lint did not report the other store's gate: $OUT"
printf '%s\n' "$OUT" | grep -qx '    side-store: 1' \
  || fail "--lint counted a gate the compile store installs, or did not name side-store by folder: $OUT"
printf '%s\n' "$OUT" | grep -q 'main-store:' && fail "--lint reported the compile store as another store: $OUT"
printf '%s\n' "$OUT" | grep -q 'quiet-store' && fail "--lint reported a store that holds no gate: $OUT"
printf '%s\n' "$OUT" | grep -q 'projects[\\/]' && fail "--lint printed a store's path, not its folder name: $OUT"
printf '%s\n' "$OUT" | grep -q 'not compiled' && fail "the section says 'not compiled', which verify-release.ps1 fails on: $OUT"
printf '%s\n' "$OUT" | grep -q 'clean:' && fail "--lint called a corpus with an uninstalled gate clean: $OUT"
ocompile || fail "precondition: the compile over main-store failed"
grep -q 'Main-store gate' "$OGATES" || fail "precondition: main-store, the largest, is the store that compiles"
grep -q 'Side-store gate' "$OGATES" && fail "a gate in another store was compiled into the standing orders"
echo "ok: a gate in another store is reported by folder name and count, and is not compiled"

# Control: the compile is byte-identical with the other store and without it.
WITH="$("$PY" -c "import sys;print(open(sys.argv[1],'rb').read().hex())" "$OGATES")"
mv "$OP/side-store" "$OHOME/side-store.away"
ocompile || fail "the compile without side-store failed"
WITHOUT="$("$PY" -c "import sys;print(open(sys.argv[1],'rb').read().hex())" "$OGATES")"
{ [ -n "$WITH" ] && [ "$WITH" = "$WITHOUT" ]; } || fail "the other store changed the compiled bytes"
# Control: with no gate in any other store, there is no section at all.
OUT="$(olint)"
printf '%s\n' "$OUT" | grep -q 'other memory stores' && fail "--lint reported other-store gates where there are none: $OUT"
mv "$OHOME/side-store.away" "$OP/side-store"
echo "ok: the compile is byte-identical with and without the other store, which reports nothing once it holds no gate"

# A pinned store is respected: point RECALL_MEMORY_DIR at side-store and IT compiles, while
# main-store, now the other store, is the one reported, for its one gate side-store lacks.
gate m4 'Main-only gate.' > "$OP/main-store/memory/m4.md"
SIDE_W="$(cygpath -m "$OP/side-store/memory" 2>/dev/null || echo "$OP/side-store/memory")"
OUT="$(olint "$SIDE_W")"
printf '%s\n' "$OUT" | grep -qx '    main-store: 1' \
  || fail "under RECALL_MEMORY_DIR the unpinned store was not the one reported: $OUT"
printf '%s\n' "$OUT" | grep -q 'side-store:' && fail "the pinned store was reported as another store: $OUT"
ocompile "$SIDE_W" || fail "the compile over the pinned side-store failed"
grep -q 'Side-store gate' "$OGATES" || fail "RECALL_MEMORY_DIR did not decide which store compiles"
grep -q 'Main-only gate' "$OGATES" && fail "under the pin, a gate in the unpinned store was compiled"
echo "ok: RECALL_MEMORY_DIR decides the compile store, and the census reports the rest"

# A store the census cannot read is named, not skipped in silence. In-process, as above, so no
# chmod is needed.
UNREAD="$(RECALL_MEMORY_DIR= "$PY" - "$RECALL" "$OHOME" 2>&1 <<'PY'
import importlib.util, os, sys
recall, home = sys.argv[1:3]
os.environ.pop("RECALL_MEMORY_DIR", None)
os.environ["HOME"] = os.environ["USERPROFILE"] = home
s = importlib.util.spec_from_file_location("recall", recall)
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
quiet = os.path.join(home, ".claude", "projects", "quiet-store", "memory")
key = lambda p: os.path.normcase(os.path.abspath(p))
real = os.listdir
def listdir(p="."):
    if key(p) == key(quiet):
        raise PermissionError(13, "Permission denied", p)
    return real(p)
os.listdir = listdir
m.lint()
PY
)"
printf '%s\n' "$UNREAD" | grep -qx '    quiet-store: could not be read' \
  || fail "an unreadable other store was skipped in silence: $UNREAD"
echo "ok: an other store the census cannot read is named as such"

# ------------------------------------------------ per-agent gates: `agents:` (2026-10-14)
# A gate memory can name the agents it is for. The compile then writes one file with a section
# per agent (_compile_gates_text), and each agent's installer takes only its own
# (src/agent-gates.js compiledForAgents). Compiled here by the real recall.py and installed by
# the real setGatesAll, in a home of its own with both agents present.
AHOME="$TMP/agents-home"
AMEM="$AHOME/mem"
mkdir -p "$AMEM" "$AHOME/.claude" "$AHOME/.codex"
printf -- '# Memory Index\n' > "$AMEM/MEMORY.md"
agate() {  # file, agents: line ('' for none), rule
  printf -- '---\nname: %s\nmetadata:\n  type: feedback\n  scope: global\n%s---\n<!-- gate -->\n- %s\n<!-- /gate -->\n' \
    "$1" "${2:+  agents: $2
}" "$3" > "$AMEM/$1.md"
}
acompile() { HOME="$AHOME" USERPROFILE="$AHOME" RECALL_MEMORY_DIR="$AMEM" "$PY" "$RECALL" --gates-compile 2>&1; }
alint()    { HOME="$AHOME" USERPROFILE="$AHOME" RECALL_MEMORY_DIR="$AMEM" "$PY" "$RECALL" --lint 2>&1; }
# setGatesAll from a given src/ (this tree's, or the baseline's below) into a given home, both
# agents explicit, so nothing can reach a real profile. Prints each row as agent:changed:on:error.
install_from() {
  CODEX_HOME= node -e '
    const path = require("path");
    const [src, home] = process.argv.slice(1);
    const rows = require(path.join(src, "agent-gates.js")).setGatesAll(true,
      { home, codexHome: path.join(home, ".codex"), backupDir: path.join(home, ".claude", "backups") });
    console.log(rows.map((r) => [r.agent, r.changed, r.on, r.error].join(":")).join(" "));
  ' "$1" "$2"
}
SRC="$HERE/../src"
ACLAUDE="$AHOME/.claude/CLAUDE.md"
ACODEX="$AHOME/.codex/AGENTS.md"
printf -- '# Mine\n' > "$ACLAUDE"; printf -- '# Mine\n' > "$ACODEX"

agate shared '' 'Shared rule, for both agents.'
agate codexonly '[codex]' 'Codex-only rule: keep shells short.'
agate claudeonly 'Claude' 'Claude-only rule.'
OUT="$(acompile)" || fail "the per-agent compile failed: $OUT"
printf '%s\n' "$OUT" | grep -qx '  claude 2, codex 2' || fail "the compile did not print each agent's count: $OUT"
head -1 "$AHOME/.claude/gates.generated.md" | grep -q '^<!-- generated by recall.py --gates-compile; per agent: claude [0-9]*, codex [0-9]* -->$' \
  || fail "a corpus with a targeted gate did not compile per agent: $(head -1 "$AHOME/.claude/gates.generated.md")"
ROWS="$(install_from "$SRC" "$AHOME")"
[ "$ROWS" = "claude:true:true: codex:true:true:" ] || fail "the per-agent install did not land for both agents: $ROWS"
grep -q 'Codex-only rule' "$ACLAUDE" && fail "a Codex-only gate reached CLAUDE.md"
grep -q 'Claude-only rule' "$ACODEX" && fail "a Claude-only gate reached AGENTS.md"
grep -q 'Codex-only rule' "$ACODEX" || fail "the Codex-only gate did not reach AGENTS.md"
grep -q 'Claude-only rule' "$ACLAUDE" || fail "the Claude-only gate did not reach CLAUDE.md"
{ grep -q 'Shared rule' "$ACLAUDE" && grep -q 'Shared rule' "$ACODEX"; } || fail "the shared gate did not reach both agents"
OUT="$(alint)"
printf '%s\n' "$OUT" | grep -qx '  3 gate memories compile: claude 2, codex 2' || fail "--lint did not report the per-agent counts: $OUT"
echo "ok: a Codex-only gate reaches AGENTS.md only, a Claude-only gate CLAUDE.md only, from the real compiler"

# A gate that moves between agents leaves the one it left, on the next compile and install.
# Mutation: in _compile_gates_text, take the `all(...)` branch whatever the agents say (every gate
# compiled for every agent) and the Codex-only rule reaches CLAUDE.md above and stays below.
agate codexonly '' 'Codex-only rule: keep shells short.'
acompile >/dev/null || fail "the compile with the gate shared again failed"
install_from "$SRC" "$AHOME" >/dev/null
grep -q 'Codex-only rule' "$ACLAUDE" || fail "a gate made shared again did not reach CLAUDE.md"
agate codexonly 'codex' 'Codex-only rule: keep shells short.'
OUT="$(alint)"
printf '%s\n' "$OUT" | grep -q 'STALE' || fail "--lint did not see a gate moved between agents as drift: $OUT"
acompile >/dev/null || fail "the compile after moving the gate failed"
install_from "$SRC" "$AHOME" >/dev/null
grep -q 'Codex-only rule' "$ACLAUDE" && fail "a gate moved to Codex was left in CLAUDE.md"
grep -q 'Codex-only rule' "$ACODEX" || fail "a gate moved to Codex is missing from AGENTS.md"
# Every Claude gate moves away: Claude's block is removed, and its own text is left exactly.
agate shared '[codex]' 'Shared rule, for both agents.'
agate claudeonly 'codex' 'Claude-only rule.'
acompile >/dev/null || fail "the compile with no Claude gates failed"
ROWS="$(install_from "$SRC" "$AHOME")"
[ "$ROWS" = "claude:true:false: codex:true:true:" ] || fail "Claude, with no gates left, was not turned off: $ROWS"
[ "$(cat "$ACLAUDE")" = "# Mine" ] || fail "CLAUDE.md is not its own text again after its last gate left: $(cat "$ACLAUDE")"
echo "ok: a gate that moves between agents is removed from the one it left, and the last one takes the block"

# A gate whose agents: cannot be read is left out for every agent, named by the compile on
# stderr and by --lint, and keeps `clean:` from printing.
# Mutations: return GATE_AGENTS for an unknown name in _gate_agents -> "reached CLAUDE.md";
# drop `or gate_excluded` from `clean:` -> "called ... clean"; drop the stderr loop in
# compile_gates -> "the compile did not name".
rm -f "$AMEM"/*.md; printf -- '# Memory Index\n' > "$AMEM/MEMORY.md"
agate shared '' 'Shared rule, for both agents.'
agate typo '[codex, gemini]' 'A rule for an agent nobody has.'
OUT="$(acompile)" || fail "a compile with one unreadable agents: line failed outright: $OUT"
printf '%s\n' "$OUT" | grep -q 'gate left out for every agent: typo.md: `agents:` names an agent this compiler does not know: gemini' \
  || fail "the compile did not name the gate it left out: $OUT"
install_from "$SRC" "$AHOME" >/dev/null
grep -q 'nobody has' "$ACLAUDE" "$ACODEX" && fail "a gate naming an unknown agent reached CLAUDE.md or AGENTS.md"
OUT="$(alint)"
printf '%s\n' "$OUT" | grep -q 'left out for every agent, not compiled' || fail "--lint did not report the left-out gate: $OUT"
printf '%s\n' "$OUT" | grep -qx '    typo  (`agents:` names an agent this compiler does not know: gemini)' \
  || fail "--lint did not name the left-out gate and why: $OUT"
printf '%s\n' "$OUT" | grep -q 'clean:' && fail "--lint called a corpus with a left-out gate clean: $OUT"
# And the other-store census uses the same rule (_gate_body): a left-out gate in another store
# is not a gate there either, so it is not reported as one to move. Mutation: return the body in
# _gate_body whatever `problem` says -> "counted a left-out gate in another store".
mkdir -p "$AHOME/.claude/projects/side-store/memory"
printf -- '---\nscope: global\nagents: [gemini]\n---\n<!-- gate -->\n- Elsewhere.\n<!-- /gate -->\n' \
  > "$AHOME/.claude/projects/side-store/memory/elsewhere.md"
OUT="$(alint)"
printf '%s\n' "$OUT" | grep -q 'other memory stores' && fail "--lint counted a left-out gate in another store: $OUT"
rm -rf "$AHOME/.claude/projects"
echo "ok: a gate naming an unknown agent is left out for every agent, and both the compile and --lint name it"

# ------------------------------------------- migration: no `agents:` key, nothing moves
# The user's live corpus has no agents: key at all, and its installed blocks must come out of
# this change byte for byte as they went in. So a 13-gate corpus, written to catch what the
# selection rule could change (nested and flat scope, a BOM, CRLF, quoting, non-ASCII text, a
# body that DOCUMENTS agents: in a fenced example, a description that mentions agents, and
# non-gates beside them), is compiled and installed by the code this branch started from and
# then by this tree, and every byte compared: the compiled file, both instruction files (with
# Codex's AGENTS.override.md active in a second home), and the backups. Then this tree runs
# over the baseline's install and must change nothing.
#
# The baseline is BASE below, extracted with git archive, so the comparison is live rather
# than against a stored copy. Without that commit (a shallow clone) the comparison is skipped.
# Mutations: write the per-agent header for every compile (drop the `all(...)` branch) ->
# "compiled file differs"; add a compile id to _render_gates' header line -> the same; in
# setGatesAll, give an agent with no `agents:` gates `on: false` -> "differs".
BASE=d624539
OLD="$TMP/baseline"
if git -C "$HERE/.." cat-file -e "$BASE^{commit}" 2>/dev/null; then
  mkdir -p "$OLD"
  git -C "$HERE/.." archive "$BASE" src memory/recall.py | tar -x -C "$OLD" || fail "could not extract the baseline $BASE"
  mig_corpus() {  # $1 = memory dir
    mkdir -p "$1"
    printf -- '# Memory Index\n\n- [one](g01.md) hook\n' > "$1/MEMORY.md"
    for i in 01 02 03 04 05; do
      printf -- '---\nname: g%s\ndescription: rule %s, for agents: all of them\nmetadata:\n  node_type: memory\n  type: feedback\n  scope: global\n  modified: 2026-10-01T00:00:00Z\n---\n\nWhy this matters.\n\n<!-- gate -->\n- **Rule %s.** Do the thing \xe2\x80\x94 then check it \xe2\x86\x92 twice.\n<!-- /gate -->\n' \
        "$i" "$i" "$i" > "$1/g$i.md"
    done
    printf -- '---\nname: g06\ntype: reference\nscope: global\n---\n<!-- gate -->\n- **Flat scope.** A reference can be resident too.\n- Second line of the same gate.\n<!-- /gate -->\n' > "$1/g06.md"
    printf -- '\xef\xbb\xbf---\nname: g07\nscope: global\n---\n<!-- gate -->\n- **Behind a BOM.** Written by PowerShell 5.1.\n<!-- /gate -->\n' > "$1/g07.md"
    printf -- '---\r\nname: g08\r\nmetadata:\r\n  scope: global\r\n---\r\n<!-- gate -->\r\n- **CRLF.** Saved by an editor.\r\n<!-- /gate -->\r\n' > "$1/g08.md"
    printf -- '---\nname: g09\nscope: "global"\n---\n<!-- gate -->\n- **Quoted scope.** Still global.\n<!-- /gate -->\n' > "$1/g09.md"
    printf -- '---\nname: g10\nmetadata:\n  scope: global\n---\nThe syntax, as an example:\n\n```\nagents: [codex]\n```\n\n<!-- gate -->\n- **Documents agents.** The example above is body, not frontmatter.\n<!-- /gate -->\n' > "$1/g10.md"
    printf -- '---\nname: g11\nmetadata:\n  scope: global\n---\n<!-- gate -->\n  - **Indented bullet.**   Trailing spaces stay inside.   \n\n<!-- /gate -->\n' > "$1/g11.md"
    printf -- '---\nname: g12\nmetadata:\n  type: feedback\n  scope: global\n---\n<!-- gate -->\n- **Caf\xc3\xa9 rule.** Non-ASCII in the gate.\n<!-- /gate -->\n' > "$1/g12.md"
    printf -- '---\nname: g13\nscope: global\n---\n<!-- gate -->\n- **Last rule.** Sorted last by name.\n<!-- /gate -->\n' > "$1/g13.md"
    printf -- '---\nname: n1\nscope: project\n---\n<!-- gate -->\n- Not global.\n<!-- /gate -->\n' > "$1/n1.md"
    printf -- '---\nname: n2\nscope: global\n---\nNo gate block at all.\n' > "$1/n2.md"
    printf -- '---\nname: n3\nscope: global\n---\n<!-- gate -->\n- Never closed.\n' > "$1/n3.md"
    printf -- '---\nname: n4\n---\n<!-- gate -->\n- No scope.\n<!-- /gate -->\n' > "$1/n4.md"
  }
  mig_home() {  # $1 = home, $2 = 'override' to make AGENTS.override.md the active Codex file
    mkdir -p "$1/.claude" "$1/.codex"
    mig_corpus "$1/mem"
    printf -- '# My global instructions\r\n\r\nAlways use the toolbox python.\r\n' > "$1/.claude/CLAUDE.md"
    printf -- '# Codex notes\n' > "$1/.codex/AGENTS.md"
    [ "${2:-}" = override ] && printf -- '# Codex override\n\nOverride text.\n' > "$1/.codex/AGENTS.override.md"
    return 0
  }
  mig_compile() { HOME="$1" USERPROFILE="$1" RECALL_MEMORY_DIR="$1/mem" "$PY" "$2" --gates-compile >/dev/null 2>&1; }
  hexof() { "$PY" -c "import sys;print(open(sys.argv[1],'rb').read().hex())" "$1"; }
  # Every file under the home's .claude and .codex, the corpus aside, as name=hex.
  snapshot() {
    (cd "$1" && find .claude .codex -type f ! -name '*.lock' | LC_ALL=C sort | while read -r f; do printf '%s=%s\n' "$f" "$(hexof "$f")"; done)
  }
  for shape in base override; do
    H_OLD="$TMP/mig-old-$shape"; H_NEW="$TMP/mig-new-$shape"
    mig_home "$H_OLD" "$shape"; mig_home "$H_NEW" "$shape"
    mig_compile "$H_OLD" "$OLD/memory/recall.py" || fail "$shape: the baseline compile failed"
    mig_compile "$H_NEW" "$RECALL" || fail "$shape: this tree's compile failed"
    grep -q '^## Standing gates (13 memories, managed)$' "$H_OLD/.claude/gates.generated.md" \
      || fail "$shape: precondition: the baseline compiled $(grep -o 'gates ([0-9]* memories' "$H_OLD/.claude/gates.generated.md"), not 13"
    [ "$(hexof "$H_OLD/.claude/gates.generated.md")" = "$(hexof "$H_NEW/.claude/gates.generated.md")" ] \
      || fail "$shape: the compiled file differs from the baseline's for a corpus with no agents: key"
    R_OLD="$(install_from "$OLD/src" "$H_OLD")"; R_NEW="$(install_from "$SRC" "$H_NEW")"
    [ "$R_OLD" = "claude:true:true: codex:true:true:" ] || fail "$shape: precondition: the baseline install: $R_OLD"
    [ "$R_NEW" = "$R_OLD" ] || fail "$shape: the install rows differ: baseline $R_OLD, now $R_NEW"
    S_OLD="$(snapshot "$H_OLD")"; S_NEW="$(snapshot "$H_NEW")"
    [ "$S_OLD" = "$S_NEW" ] || fail "$shape: the installed files differ from the baseline's: $(diff <(printf '%s\n' "$S_OLD" | cut -c1-90) <(printf '%s\n' "$S_NEW" | cut -c1-90))"
    # This tree over the baseline's own install: a recompile and an install that change nothing.
    mig_compile "$H_OLD" "$RECALL" || fail "$shape: this tree's recompile over the baseline failed"
    R_AGAIN="$(install_from "$SRC" "$H_OLD")"
    [ "$R_AGAIN" = "claude:false:true: codex:false:true:" ] || fail "$shape: this tree rewrote the baseline's install: $R_AGAIN"
    [ "$(snapshot "$H_OLD")" = "$S_OLD" ] || fail "$shape: this tree changed a byte of the baseline's install"
  done
  [ -s "$TMP/mig-new-override/.codex/AGENTS.override.md" ] && grep -q 'Last rule' "$TMP/mig-new-override/.codex/AGENTS.override.md" \
    || fail "precondition: the override home installed into AGENTS.override.md"
  echo "ok: a 13-gate corpus with no agents: key compiles and installs byte for byte as $BASE did, for both agents and the Codex override"
else
  echo "skip: the migration comparison needs $BASE in this clone (git archive); none of the other checks do"
fi

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


# ---------------------------------------------------------------- --json, for the dashboard
# The Claude memory card's Search runs a query with --json and opens a result at its line
# (2026-10-19). A result has to name the file it came from and the line its best excerpt sits
# on, or the card cannot open it. Mutation: always call search() (drop --json from the dispatch).
MEMJ="$TMP/memory-json"
mkdir -p "$MEMJ"
printf "%s
" "# Index" "- [Kettle](kettle.md) - how the kettle descales" > "$MEMJ/MEMORY.md"
printf "%s
" "---" "name: kettle" "description: how the kettle descales" "---" "" "Fill it with vinegar." "The descaling cycle runs twelve minutes." > "$MEMJ/kettle.md"
OUT="$(RECALL_MEMORY_DIR="$MEMJ" RECALL_MEMORY_DIRS= "$PY" "$RECALL" --json --lexical-only -k 3 "descaling cycle minutes" 2>/dev/null)"
echo "$OUT" | "$PY" -c "
import json, os, sys
data = json.load(sys.stdin)
hits = [r for r in data[\"results\"] if r[\"name\"].endswith(\"kettle.md\")]
assert hits, data
assert os.path.basename(hits[0][\"path\"]) == \"kettle.md\", hits[0]
assert hits[0][\"line\"] == 7, hits[0]
assert \"twelve minutes\" in hits[0][\"excerpt\"], hits[0]
assert data[\"mode\"] == \"lexical\", data
" || fail "--json did not name the file and the line of its best excerpt: $OUT"
"$PY" "$RECALL" --json >/dev/null 2>&1 && fail "--json with no query exited 0"
echo "ok: --json names each result's file and the line of its best excerpt"

# ---------------------------------------------------------------- the heavy imports stay lazy
# numpy and onnxruntime used to be imported at module scope, and _ensure_runtime imported both
# again just to ask whether they were installed. onnxruntime is reached at exactly one line in
# the file (the InferenceSession) and numpy only in the embedder, the cosine matmul and
# --selftest, so --lint, --gates-compile, --lexical-only and --list paid for two libraries they
# never touch. Measured 2026-09-25, 30 interleaved process pairs per verb, toolbox python:
#   --lint          eager min 321.9 / p50 331.9 ms   lazy min 117.3 / p50 121.1 ms
#   --gates-compile eager min 326.2 / p50 339.5 ms   lazy min 117.7 / p50 122.2 ms
# and a real query, which does reach both, was unchanged (p50 575.3 -> 570.8, n=12).
# --gates-compile is on the VS Code extension corpus-watcher path, so it runs on every save.
#
# -X importtime rather than a timing assertion: a wall-clock threshold on a shared box is a
# flake, and it answers a different question anyway. This asks the question the change was
# about -- was the module loaded at all -- and it cannot pass for an unrelated reason.
#
# MUTATION: put `import numpy as np` back at module scope in memory/recall.py. This fails with
# "numpy was imported by --lint".
IMPORTS="$("$PY" -X importtime "$RECALL" --lint 2>&1 >/dev/null)"
RC=$?
[ "$RC" = "0" ] || fail "--lint under -X importtime exited $RC"
# The witness: prove the log was captured before reading it for absences. Four of the
# assertions in this file used to be negative greps with nothing asserting the text existed,
# and an empty capture satisfies every negative.
echo "$IMPORTS" | grep -q "^import time:" || fail "no -X importtime log was captured at all"
echo "$IMPORTS" | grep -q "argparse" || fail "the importtime log does not even show argparse; it is not recall.py's"
echo "$IMPORTS" | grep -qE "[| ]numpy$" && fail "numpy was imported by --lint, which never touches it"
echo "$IMPORTS" | grep -qE "[| ]onnxruntime$" && fail "onnxruntime was imported by --lint, which never touches it"
echo "ok: --lint loads neither numpy nor onnxruntime"
echo "ALL PASS"
