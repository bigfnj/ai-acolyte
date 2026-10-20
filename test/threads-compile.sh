#!/usr/bin/env bash
# Behavioural tests for `recall.py --threads-compile` (2026-10-19): which memories are open
# threads, the exact shape of ~/.claude/open-threads.generated.md, its caps, the header-only file
# for zero threads, the INDEX line for MEMORY.md's health, the refusals, the atomic write, the
# --lint sections, and that vscode-extension/memoryLint.js threadOf and indexHealth read every
# generated memory and index exactly as recall.py does.
#
# Not part of `node --test`: recall.py needs a Python with numpy + onnxruntime (it checks they are
# installed before every verb, this one included), so this runs as its own step, like
# test/gates-manage.sh, and in the same CI job:
#
#   bash test/threads-compile.sh
#   TOOLBOX_PYTHON=/path/to/python bash test/threads-compile.sh
#
# A missing interpreter (or node, for the agreement half) is a local SKIP and a CI FAILURE: under
# CI=true a skip that exits 0 would be a step that cannot fail.
#
# No ONNX model is required. Everything runs under a throwaway HOME, so the real ~/.claude and the
# real memory store are never read or written. Every fixture is synthetic.
#
# Each test names the mutation that must make it fail. A test that cannot fail is not a test.
set -u

PY="${TOOLBOX_PYTHON:-${LOCALAPPDATA:-}/DevToolbox/python/.venv/Scripts/python.exe}"
HERE="$(cd "$(dirname "$0")" && pwd)"
RECALL="$HERE/../memory/recall.py"
LINT_JS="$HERE/../vscode-extension/memoryLint.js"

missing() {
  if [ "${CI:-}" = "true" ]; then
    echo "FAIL: $1, and CI=true forbids skipping."
    exit 1
  fi
  echo "skip: $1 (under CI=true this fails)"
  exit 0
}
# A path or a bare command name (`TOOLBOX_PYTHON=python3`) both count as present.
if ! [ -x "$PY" ] && ! command -v "$PY" >/dev/null 2>&1; then
  missing "python not found at $PY (set TOOLBOX_PYTHON to a Python that has numpy and onnxruntime)"
fi
command -v node >/dev/null 2>&1 || missing "node not found on PATH"

fail() { echo "FAIL: $1"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
MEM="$TMP/memory"
THREADS="$TMP/.claude/open-threads.generated.md"
mkdir -p "$TMP/.claude"

# The four-variable incantation test/recall-py.sh uses: expanduser consults all of them, and
# THREADS_OUT resolves through it.
export HOME="$TMP" USERPROFILE="$TMP" HOMEDRIVE="${TMP%%/*}" HOMEPATH="${TMP#?}"
export RECALL_MEMORY_DIR="$MEM" RECALL_REEXEC=1

# stdout, stderr and the exit status captured SEPARATELY and in THIS shell (a pipeline would run
# `fail` in a subshell). CRs dropped: Python's stdout writes CRLF on Windows.
OUT="" ERR="" RC=0
recall() {
  OUT="$("$PY" "$RECALL" "$@" 2>"$TMP/stderr.txt")"
  RC=$?
  ERR="$(cat "$TMP/stderr.txt")"
  OUT="${OUT//$'\r'/}"
  ERR="${ERR//$'\r'/}"
}

# A fresh store holding MEMORY.md and nothing else, and no compiled file.
fresh() {
  rm -rf "$MEM" "$THREADS"
  mkdir -p "$MEM"
  printf -- '# Memory Index\n- [x](x.md) - hook\n' > "$MEM/MEMORY.md"
}

# mem <file> <status line or ""> <block text or ""> [extra body]
mem() {
  local status="" block="" extra="${4:-}"
  [ -n "$2" ] && status="$2"$'\n'
  [ -n "$3" ] && block=$'<!-- status -->\n'"$3"$'\n<!-- /status -->\n'
  printf -- '---\nname: %s\ndescription: synthetic\n%s---\n\nThe body.\n%s%s' "${1%.md}" "$status" "$block" "$extra" > "$MEM/$1"
}

# The compiled file's lines, CRs dropped (there should be none: the write is newline="\n").
lines() { tr -d '\r' < "$THREADS"; }
# What the header's sha must be: SHA-256 of every byte after the header line, first 16 hex.
body_sha() {
  "$PY" -c 'import hashlib,sys
data = open(sys.argv[1], "rb").read()
print(hashlib.sha256(data[data.index(b"\n") + 1:]).hexdigest()[:16])' "$THREADS" | tr -d '\r'
}
file_id() { "$PY" -c "import os,sys; print(os.stat(sys.argv[1]).st_ino)" "$1" | tr -d '\r'; }
sha_of() { "$PY" -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$1" | tr -d '\r'; }

# ------------------------------------------------------------------ the format, byte for byte
# Mutations, each failing here: sort by name alone (the AWAITING line moves); the label not
# uppercased; the stem dropped; the sha taken over anything but the bytes below the header (the
# header check); the heading counting lines instead of threads; a blank line after the heading.
fresh
mem b-open.md 'status: open' 'Second open thread.'
mem a-open.md 'status: OPEN' 'First open thread.'
mem z-awaiting.md $'metadata:\n  type: project\n  status: awaiting  # the owner decides' 'Waiting.'
mem m-blocked.md 'status: "blocked"' 'Blocked on X.'
mem d-deferred.md "status: 'Deferred'" 'Later.'
mem c-done.md 'status: done' 'Finished.'
mem plain.md '' ''
recall --threads-compile
[ "$RC" = "0" ] || fail "a plain corpus did not compile: exit $RC, stderr: $ERR"
EXPECTED='## Open threads (5, managed)
- **OPEN** First open thread. (a-open)
- **OPEN** Second open thread. (b-open)
- **AWAITING** Waiting. (z-awaiting)
- **BLOCKED** Blocked on X. (m-blocked)
- **DEFERRED** Later. (d-deferred)'
[ "$(lines | tail -n +2)" = "$EXPECTED" ] || fail "the compiled body is not the documented format:
$(lines)"
HEADER="$(lines | head -1)"
[ "$HEADER" = "<!-- generated by recall.py --threads-compile; sha $(body_sha) -->" ] \
  || fail "the header's sha is not SHA-256 of the bytes below it: $HEADER, expected $(body_sha)"
[ "$(tail -c 1 "$THREADS" | od -An -c | tr -d ' ')" = '\n' ] || fail "the file does not end with one newline"
if grep -q $'\r' "$THREADS"; then fail "the compiled file holds a CR: the write is not newline=\"\\n\""; fi
[ -z "$ERR" ] || fail "a clean corpus wrote to stderr: $ERR"
echo "ok: the compiled file is the header with its sha, the heading, and one line per thread in class then name order"

# --------------------------------------------- which memories are threads, and which are not
# Each memory here differs from a listed thread on ONE axis. Mutations, each failing here:
#   _status_of reading only the first `status:` (dup lists as OPEN);   no _uncomment (cmt reads
#   "open  # x", an unknown value);   `status :` not the key (spaced is missing);   no lowercase
#   (caps is unknown);   the fence skip dropped (fenced and tilde list their examples);   CommonMark's
#   unclosed fence read as plain text (unclosed lists);   a 4-space marker accepted (indented
#   lists);   a marker with text after it accepted (trailing lists);   EXCLUDE dropped (MEMORY.md
#   lists itself);   closed values treated as unknown (the clean verdict, further down).
fresh
mem dup.md $'status: open\nmetadata:\n  status: blocked' 'Two statuses.'
mem cmt.md 'status: open  # still open' 'Commented.'
mem spaced.md 'status : open' 'Spaced key.'
mem caps.md 'status: AwAiTiNg' 'Mixed case.'
mem fenced.md 'status: open' '' $'```\n<!-- status -->\nAn example.\n<!-- /status -->\n```\n'
mem tilde.md 'status: open' '' $'~~~~ md\n<!-- status -->\nAn example.\n<!-- /status -->\n~~~~\n'
mem unclosed.md 'status: open' '' $'```\nnever closed\n<!-- status -->\nInside it.\n<!-- /status -->\n'
mem indented.md 'status: open' '' $'    <!-- status -->\nIndented.\n    <!-- /status -->\n'
mem trailing.md 'status: open' '' $'<!-- status --> and more\nTrailing.\n<!-- /status -->\n'
mem spaces-ok.md 'status: open' '' $'   <!-- status -->  \nThree spaces is a marker.\n<!-- /status -->\t\n'
mem after-fence.md 'status: open' '' $'```js\nconst x = 1;\n```\n<!-- status -->\nAfter a closed fence.\n<!-- /status -->\n'
# A closer shorter than its opener closes nothing, so the block below it is still fenced.
mem shortclose.md 'status: open' '' $'~~~~\ncode\n~~~\n<!-- status -->\nInside the fence still.\n<!-- /status -->\n~~~~\n'
mem wip.md 'status: wip' 'Unknown.'
mem empty.md 'status:' 'Empty value.'
mem noblock.md 'status: blocked' ''
mem statuses.md 'statuses: open' 'Not the key.'
mem note.md 'status_note: open' 'Not the key either.'
for closed in done closed live shelved deleted dropped shipped; do
  mem "closed-$closed.md" "status: ${closed^^}" 'Closed.'
done
# The index with a frontmatter of its own, at the TOP, where _frontmatter_block reads one. Appended
# below the index lines, as the first version of this test did, it declared nothing, and the
# EXCLUDE mutation survived.
printf -- '---\nstatus: open\n---\n<!-- status -->\nThe index itself.\n<!-- /status -->\n- [x](x.md) - hook\n' > "$MEM/MEMORY.md"
recall --threads-compile
[ "$RC" = "0" ] || fail "the selection corpus did not compile: exit $RC, stderr: $ERR"
EXPECTED='## Open threads (5, managed)
- **OPEN** After a closed fence. (after-fence)
- **OPEN** Commented. (cmt)
- **OPEN** Spaced key. (spaced)
- **OPEN** Three spaces is a marker. (spaces-ok)
- **AWAITING** Mixed case. (caps)'
[ "$(lines | tail -n +2)" = "$EXPECTED" ] || fail "the selection is wrong:
$(lines | tail -n +2)"
# The left-out ones are named on stderr, one line each, so `--open-threads refresh` can pass them on.
for want in 'dup.md: more than one `status:` line' "wip.md: unknown status 'wip'" "empty.md: unknown status ''" \
    'noblock.md: status blocked with no <!-- status --> block' 'fenced.md: status open with no' \
    'tilde.md: status open with no' 'unclosed.md: status open with no' 'indented.md: status open with no' \
    'trailing.md: status open with no' 'shortclose.md: status open with no'; do
  printf '%s\n' "$ERR" | grep -qF "[recall] open thread left out: $want" || fail "stderr does not name: $want
stderr was: $ERR"
done
printf '%s\n' "$ERR" | grep -q 'closed-\|statuses\|note\.md\|MEMORY' && fail "stderr names a memory that is not a finding: $ERR"
echo "ok: the selection takes listed statuses with a block outside code, and leaves the rest out"

# ------------------------------------------------- the text: collapsed, neutralised, escaped, capped
# Mutations, each failing here: no whitespace collapse (the tab and the NBSP survive); `<!--` or
# `-->` left raw (a stray comment would swallow the block in Claude Code); the leading `#` left
# bare; the cap measured in bytes (the e-acute line is cut short) or left off; the ellipsis
# dropped; the cap at 241 or 239.
fresh
NB="$("$PY" -c 'import sys; sys.stdout.buffer.write(chr(0xa0).encode())')"
mem spaced.md 'status: open' "  Lots${NB}of"$'\t\t'"space,"$'\n'"  over two lines.  "
mem comment.md 'status: open' 'Has <!-- a comment --> and a stray --> end.'
mem hash.md 'status: open' '# Looks like a heading.'
LONG="$("$PY" -c 'import sys; sys.stdout.buffer.write(("\u00e9" * 300).encode())')"
mem long.md 'status: open' "$LONG"
EXACT="$("$PY" -c 'import sys; sys.stdout.buffer.write(("x" * 240).encode())')"
mem exact.md 'status: open' "$EXACT"
# 240 characters and 480 bytes: the cap counts characters, so this is not cut either.
EXACTE="$("$PY" -c 'import sys; sys.stdout.buffer.write((chr(0xe9) * 240).encode())')"
mem exacte.md 'status: open' "$EXACTE"
recall --threads-compile
[ "$RC" = "0" ] || fail "the text corpus did not compile: exit $RC"
lines | grep -qxF -- "- **OPEN** Lots of space, over two lines. (spaced)" || fail "whitespace is not collapsed:
$(lines)"
lines | grep -qxF -- "- **OPEN** Has &lt;!-- a comment --&gt; and a stray --&gt; end. (comment)" \
  || fail "comment markers are not neutralised:
$(lines)"
lines | grep -qxF -- '- **OPEN** \# Looks like a heading. (hash)' || fail "a leading # is not escaped:
$(lines)"
lines | grep -qxF -- "- **OPEN** $EXACT (exact)" || fail "a text of exactly 240 characters was cut"
lines | grep -qxF -- "- **OPEN** $EXACTE (exacte)" || fail "240 characters of 480 bytes were cut: the cap is counting bytes"
"$PY" - "$THREADS" <<'PY' || fail "the long text is not 239 characters plus an ellipsis"
import sys
for line in open(sys.argv[1], encoding="utf-8").read().split("\n"):
    if line.endswith("(long)"):
        text = line[len("- **OPEN** "):-len(" (long)")]
        assert len(text) == 240, len(text)
        assert text == chr(0xe9) * 239 + chr(0x2026), text[-3:]
        break
else:
    raise SystemExit("no long line")
PY
echo "ok: thread text is collapsed, its comment markers neutralised, a leading # escaped, and capped at 240 characters"

# ----------------------------------------------------------------------- at most ten thread lines
# Mutations: the cap removed (twelve lines); the cap at 9 or 11; the count line counting the
# listed lines; the heading counting the listed lines (it must say 12); "threads" for one.
fresh
for i in 01 02 03 04 05 06 07 08 09 10 11 12; do mem "t$i.md" 'status: open' "Thread $i."; done
recall --threads-compile
[ "$(lines | sed -n 2p)" = '## Open threads (12, managed)' ] || fail "the heading does not count every thread: $(lines | sed -n 2p)"
[ "$(lines | grep -c '^- \*\*OPEN\*\*')" = "10" ] || fail "not exactly ten thread lines:
$(lines)"
[ "$(lines | tail -1)" = '- +2 more open threads (recall "status")' ] || fail "no count of the rest: $(lines | tail -1)"
lines | grep -qF '(t10)' || fail "the tenth thread is missing"
lines | grep -qF '(t11)' && fail "an eleventh thread line was written"
rm "$MEM/t12.md"
recall --threads-compile
[ "$(lines | tail -1)" = '- +1 more open thread (recall "status")' ] || fail "one more is not singular: $(lines | tail -1)"
rm "$MEM/t11.md"
recall --threads-compile
lines | grep -q 'more open thread' && fail "exactly ten threads printed a count line"
echo "ok: at most ten thread lines, then one line counting the rest; the heading counts them all"

# ------------------------------------------------------- zero threads: a header-only file, never empty
# Mutations: write "" for no threads (the size check); drop the heading; skip the write when there
# is nothing (the stale thread survives); refuse an empty compile as the gates do.
fresh
mem a.md 'status: open' 'About to close.'
recall --threads-compile
lines | grep -qF '(a)' || fail "precondition: the thread compiled"
mem a.md 'status: done' 'About to close.'
recall --threads-compile
[ "$RC" = "0" ] || fail "a corpus with no open thread must compile, exited $RC: $ERR"
[ -s "$THREADS" ] || fail "zero threads wrote an EMPTY file, which a reader cannot tell from a torn read"
[ "$(lines | wc -l | tr -d ' ')" = "2" ] || fail "zero threads is not the header and the heading alone:
$(lines)"
[ "$(lines | sed -n 2p)" = '## Open threads (0, managed)' ] || fail "the zero heading is wrong: $(lines | sed -n 2p)"
[ "$(lines | head -1)" = "<!-- generated by recall.py --threads-compile; sha $(body_sha) -->" ] || fail "the zero file's sha is wrong"
echo "ok: zero threads and a healthy index write the header and the heading, never an empty file"

# ------------------------------------------------------------------------------- the INDEX line
# Lines, bytes and the longest line, each at its budget (no line) and one past it (a line), alone
# and together, CRLF and LF alike. Mutations, each failing here: `>=` for `>` (140 lines prints);
# a line counted for the final newline (140 lines reads 141); the 16-entry ceiling reported;
# bytes counted from decoded text (CRLF undercounts); the longest line counted in bytes (the
# e-acute line of 151 characters reads 302) or with its CR; the INDEX line after the threads;
# the phrases joined with anything but "; ".
index_lines() {  # index_lines <count> [crlf]
  "$PY" - "$MEM/MEMORY.md" "$1" "${2:-}" <<'PY'
import sys
path, n, crlf = sys.argv[1], int(sys.argv[2]), sys.argv[3] == "crlf"
eol = "\r\n" if crlf else "\n"
open(path, "w", encoding="utf-8", newline="").write("".join(f"- line {i}{eol}" for i in range(n)))
PY
}
index_line() { lines | sed -n 3p; }
fresh
mem a.md 'status: open' 'A thread.'
index_lines 140
recall --threads-compile
lines | grep -q 'INDEX' && fail "140 lines is within the budget, and an INDEX line was written"
index_lines 141
recall --threads-compile
[ "$(index_line)" = '- **INDEX** MEMORY.md is 141 lines (budget 140): compact it before adding anything, and move detail into the memory files.' ] \
  || fail "141 lines: $(index_line)"
[ "$(lines | sed -n 4p)" = '- **OPEN** A thread. (a)' ] || fail "the thread does not follow the INDEX line"
[ "$(lines | sed -n 2p)" = '## Open threads (1, managed)' ] || fail "the INDEX line was counted as a thread"
index_lines 141 crlf
recall --threads-compile
index_line | grep -qF '141 lines (budget 140)' || fail "a CRLF index is counted differently: $(index_line)"
# 17 entries is past the 16-entry ceiling, and within every budget here.
index_lines 17
recall --threads-compile
lines | grep -q 'INDEX' && fail "the entry ceiling produced an INDEX line"
# Bytes: 12000 on disk is within; 12001 is past. CRLF counts its CRs (120 lines of 100 bytes).
"$PY" -c 'import sys; open(sys.argv[1], "wb").write((b"- " + b"x" * 96 + b"\r\n") * 120)' "$MEM/MEMORY.md"
recall --threads-compile
lines | grep -q 'INDEX' && fail "12000 bytes is within the budget"
"$PY" -c 'import sys; open(sys.argv[1], "wb").write((b"- " + b"x" * 96 + b"\r\n") * 120 + b"x")' "$MEM/MEMORY.md"
recall --threads-compile
index_line | grep -qF 'MEMORY.md is 12001 bytes (budget 12000):' || fail "12001 bytes: $(index_line)"
# The longest line in characters, its CR excluded: 300 e-acutes (600 bytes) is within, 301 past.
"$PY" -c 'import sys; open(sys.argv[1], "wb").write(("\u00e9" * 300 + "\r\n").encode())' "$MEM/MEMORY.md"
recall --threads-compile
lines | grep -q 'INDEX' && fail "a 300-character line is within the budget"
"$PY" -c 'import sys; open(sys.argv[1], "wb").write(("short\n" + "\u00e9" * 301 + "\r\n").encode())' "$MEM/MEMORY.md"
recall --threads-compile
index_line | grep -qF 'MEMORY.md is 301 characters on its longest line (budget 300):' || fail "301 characters: $(index_line)"
# All three at once, in the documented order, and with no thread the INDEX line still stands.
# 150 x (800 + 1 + 100 + 1) bytes.
"$PY" -c 'import sys; open(sys.argv[1], "wb").write((("\u00e9" * 400 + "\n" + "- " + "y" * 98 + "\n") * 150).encode())' "$MEM/MEMORY.md"
mem a.md 'status: done' 'Closed.'
recall --threads-compile
[ "$(lines | sed -n 2p)" = '## Open threads (0, managed)' ] || fail "the INDEX line is counted with no thread"
[ "$(index_line)" = '- **INDEX** MEMORY.md is 300 lines (budget 140); 135300 bytes (budget 12000); 400 characters on its longest line (budget 300): compact it before adding anything, and move detail into the memory files.' ] \
  || fail "three budgets at once: $(index_line)"
rm "$MEM/MEMORY.md"
recall --threads-compile
[ "$RC" = "0" ] || fail "a store with no MEMORY.md must still compile: $ERR"
lines | grep -q 'INDEX' && fail "a missing MEMORY.md produced an INDEX line"
echo "ok: the INDEX line names each budget MEMORY.md is past (140 lines, 12000 bytes, 300 characters), and nothing else"

# ------------------------------------------------------------------- refusals write nothing at all
# Mutations: delete the _DISCOVERY_ERRORS refusal (the store compiles, the file changes); turn the
# missing-dir refusal into a quiet return (exit 0); drop a memory that cannot be read instead of
# refusing (exit 0, a thread vanishes); write in place, or skip the temp's removal, when the
# replace keeps failing (the file id moves or a .tmp is left).
cat > "$TMP/harness.py" <<'PY'
import builtins, importlib.util, os, sys
recall_path, mode = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location("recall", recall_path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
if mode == "discovery":
    m._DISCOVERY_ERRORS.append((os.path.join(m.MEMORY_DIR, "unreadable"), PermissionError(13, "denied")))
elif mode == "unreadable":
    real_open = builtins.open
    def deny(path, *a, **k):
        if str(path).endswith("b.md"):
            raise PermissionError(13, "denied", str(path))
        return real_open(path, *a, **k)
    m.open = deny
elif mode == "held":
    def held(src, dst):
        raise PermissionError(13, "held open by another process")
    m.os.replace = held
    m.time.sleep = lambda s: None
try:
    m.compile_threads()
    print("RETURNED")
except SystemExit as e:
    print("EXIT", e.code)
PY
harness() { OUT="$("$PY" "$TMP/harness.py" "$RECALL" "$1" 2>"$TMP/stderr.txt")"; OUT="${OUT//$'\r'/}"; }
fresh
mem a.md 'status: open' 'A.'
mem b.md 'status: open' 'B.'
recall --threads-compile
BEFORE="$(sha_of "$THREADS")"
ID_BEFORE="$(file_id "$THREADS")"
mem a.md 'status: done' 'A.'
harness discovery
printf '%s\n' "$OUT" | grep -q '^EXIT \[recall\] refusing to compile open threads: cannot read .*unreadable (PermissionError)' \
  || fail "a store discovery could not read did not refuse: $OUT"
[ "$(sha_of "$THREADS")" = "$BEFORE" ] || fail "the discovery refusal changed the compiled file"
harness unreadable
printf '%s\n' "$OUT" | grep -q '^EXIT \[recall\] refusing to compile open threads: cannot read .*b\.md (PermissionError); nothing was written\.' \
  || fail "a memory that cannot be read did not refuse: $OUT"
[ "$(sha_of "$THREADS")" = "$BEFORE" ] || fail "the unreadable-memory refusal changed the compiled file"
harness held
printf '%s\n' "$OUT" | grep -q '^EXIT \[recall\] could not write .*open-threads.generated.md (PermissionError: .*); the previous file is unchanged\.' \
  || fail "a replace that never succeeds did not exit naming the file: $OUT"
[ "$(sha_of "$THREADS")" = "$BEFORE" ] || fail "a held file was changed"
[ "$(file_id "$THREADS")" = "$ID_BEFORE" ] || fail "a held file was replaced"
for residue in "$TMP/.claude"/open-threads.generated.md.*.tmp; do
  [ -e "$residue" ] && fail "a failed write left $residue behind"
done
RECALL_MEMORY_DIR="$TMP/no-such-store" recall --threads-compile
[ "$RC" = "1" ] || fail "a missing memory dir must exit 1, exited $RC"
printf '%s\n' "$ERR" | grep -qF 'refusing to compile open threads: no memory dir at' || fail "the missing-dir refusal does not say so: $ERR"
[ "$(sha_of "$THREADS")" = "$BEFORE" ] || fail "the missing-dir refusal changed the compiled file"
rm -f "$THREADS"
RECALL_MEMORY_DIR="$TMP/no-such-store" recall --threads-compile
[ -e "$THREADS" ] && fail "the missing-dir refusal created the compiled file"
echo "ok: an unreadable store or memory, a missing store and a held file each refuse, and write nothing"

# ---------------------------------------------------------------- the write REPLACES the file
# Mutation: write THREADS_OUT in place (open(path, "w")) instead of through _replace_file_text.
# The file id assertion fails. The gates' own write, now the same helper, keeps its test in
# test/recall-py.sh ("the gates write replaces the file rather than truncating it").
fresh
mem a.md 'status: open' 'First wording.'
recall --threads-compile
ID_BEFORE="$(file_id "$THREADS")"
mem a.md 'status: open' 'Second wording.'
recall --threads-compile
lines | grep -qF 'Second wording.' || fail "the recompile did not reach the file"
[ "$(file_id "$THREADS")" != "$ID_BEFORE" ] || fail "open-threads.generated.md was rewritten IN PLACE"
for residue in "$TMP/.claude"/open-threads.generated.md.*.tmp; do
  [ -e "$residue" ] && fail "a successful compile left $residue behind"
done
echo "ok: the threads write replaces the file rather than truncating it, and leaves no .tmp residue"

# ---------------------------------------------------- --threads-compile runs on its own
# Mutation: drop the `mixed` check (the compile runs, half of what was asked), or drop
# --threads-compile from the gate verbs' list (the retire runs and the compile is ignored).
recall --threads-compile --lint
[ "$RC" = "2" ] || fail "--threads-compile --lint must be a usage error, exited $RC"
recall --gates-retire a --threads-compile
[ "$RC" = "2" ] || fail "--gates-retire with --threads-compile must be a usage error, exited $RC"
echo "ok: --threads-compile refuses to share a run"

# ------------------------------------------------------------------------------------- --lint
# The four findings, each alone, each keeping `clean:` from printing, and none of them worded
# with a phrase scripts/verify-release.ps1 fails a release on. Mutations, each failing here:
# drop `thread_problems` from the clean condition; drop any one section; word a section
# "not compiled", "STALE" or "over budget", or start a line with "!".
lint_case() {  # lint_case <label> <heading substring>; the store is already seeded
  recall --lint
  [ "$RC" = "0" ] || fail "$1: --lint crashed, exit $RC: $ERR"
  printf '%s\n' "$OUT" | grep -qF "$2" || fail "$1: --lint does not report it:
$OUT"
  printf '%s\n' "$OUT" | grep -q 'clean:' && fail "$1: --lint printed clean: over a finding"
  printf '%s\n' "$OUT" | grep -qE 'STALE|over budget|not compiled|over the attention ceiling' \
    && fail "$1: --lint used a phrase verify-release.ps1 fails on:
$OUT"
  printf '%s\n' "$OUT" | grep -qE '^[[:space:]]*!' && fail "$1: --lint printed a ! line:
$OUT"
  return 0
}
fresh
printf -- '# Memory Index\n' > "$MEM/MEMORY.md"   # no link to a missing file, so clean: is reachable
mem a.md 'status: open' 'Fine.'
mem b.md 'status: shipped' 'Closed.'
recall --lint
printf '%s\n' "$OUT" | grep -qF '1 open thread compiles (of 2 memories declaring `status:`)' || fail "the count line is missing:
$OUT"
printf '%s\n' "$OUT" | grep -q 'clean:' || fail "listed and closed threads alone must lint clean:
$OUT"
mem c.md $'status: open\n  status: done' 'Two.'
lint_case duplicate 'memory with more than one `status:` line -- left out of the open threads:'
printf '%s\n' "$OUT" | grep -qx '    c' || fail "the duplicate section does not name c"
rm "$MEM/c.md"; mem d.md 'status: someday' 'Odd.'
lint_case unknown '`status:` value that is neither listed (open, awaiting, blocked, deferred) nor closed'
printf '%s\n' "$OUT" | grep -qx '    d  (someday)' || fail "the unknown section does not name d and its value"
rm "$MEM/d.md"; mem e.md 'status: deferred' ''
lint_case no-block 'listed `status:` with no <!-- status --> ... <!-- /status --> block outside code'
printf '%s\n' "$OUT" | grep -qx '    e  (deferred)' || fail "the no-block section does not name e"
rm "$MEM/e.md"; mem f.md 'status: open' "$("$PY" -c 'print("w" * 241)' | tr -d '\r')"
lint_case long 'status text longer than 240 characters -- cut with an ellipsis'
printf '%s\n' "$OUT" | grep -qx '    f  (241 characters)' || fail "the long section does not name f and its length"
echo "ok: --lint counts the threads, names each kind of left-out or cut memory, and is clean only without them"

# ------------------------------------- JavaScript and Python agree on what every memory is
# vscode-extension/memoryLint.js threadOf against recall.py _thread, memory by memory, over a
# generated corpus that varies every axis the reading has: where `status:` sits and how it is
# spelled, the value, the quoting and the comment, a BOM, CRLF or a lone CR, the markers' indent
# and what follows them, fences of either character, closed or not, with an info string, Python's
# whitespace (the 29 code points, which JavaScript's \s and trim() do not match) in the value and
# in the text, comment markers and a leading # in the text. Then indexHealth against
# _index_health over generated indexes.
#
# Mutations, each failing here: threadOf trimming with JavaScript's trim(), or collapsing with
# \s; `.` for `[^\n]` in FENCE_OPEN (killed only by a fence whose info string holds U+2028, which
# the first version of this generator never wrote); no universal newlines in memoryBody; the fence skip, the
# backtick-info rule or the unclosed-fence rule dropped; `status :` not the key; the value not
# uncommented; indexHealth counting UTF-16 units, or `>=`.
GEN="$TMP/gen"; mkdir -p "$GEN"
"$PY" - "$GEN" <<'PY'
import os, sys
out = sys.argv[1]
state = 20261019
def pick(seq):
    global state
    state = (state * 6364136223846793005 + 1442695040888963407) % (1 << 64)
    return seq[(state >> 33) % len(seq)]
SPACES = [chr(c) for c in (0x09, 0x0b, 0x0c, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2007, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000)]
NOT_SPACE = [chr(0xfeff), chr(0x200b), chr(0x180e)]
values = ["open", "OPEN", "Awaiting", "blocked", "deferred", "done", "Shipped", "live", "wip", "", "open-ish",
          "awaiting " + chr(0xa0), chr(0x1c) + "blocked", chr(0xfeff) + "open", "deferred" + chr(0x200b)]
keys = ["status:", "status :", "  status:", "    status:", "status" + chr(0xa0) + ":", "statuses:", "status_note:", "Status:"]
for i in range(700):
    eol = pick(["\n", "\n", "\r\n", "\r"])
    fm = ["name: g%d" % i]
    nkeys = pick([0, 1, 1, 1, 1, 2])
    for _ in range(nkeys):
        value = pick(values)
        quote = pick(["", "", '"', "'"])
        comment = pick(["", "", "  # why", " #not-a-comment", "\t# tab comment"])
        nest = pick(["", "", "metadata:\n  "])
        fm.append(nest + pick(keys) + pick(["", " ", "  ", chr(0xa0)]) + quote + value + quote + comment)
    body = []
    indent_b = pick(["", "", " ", "   ", "    ", "\t"])
    indent_e = pick(["", "", "   ", "    "])
    after = pick(["", "", "  ", "\t", " x"])
    word = lambda: pick(["word", "<!--", "-->", "#tag", "a" + pick(SPACES) + "b", pick(NOT_SPACE) + "z", "`x`", "~"])
    text_lines = [pick(["", "#", "  #", pick(SPACES)]) + " ".join(word() for _ in range(pick([1, 3, 6]))) for _ in range(pick([1, 2, 3]))]
    block = [indent_b + "<!-- status -->" + after] + text_lines + [indent_e + "<!-- /status -->" + pick(["", " ", " y"])]
    shape = pick(["plain", "plain", "fenced", "tilde", "unclosed", "info-backtick", "end-first", "two-begins", "none", "after-fence",
                  "short-closer"])
    if shape == "plain":
        body += block
    elif shape == "fenced":
        # U+2028 in the info string: Python's `.` takes it, JavaScript's does not.
        body += ["```" + pick(["", "md", chr(0x2028) + "x"])] + block + [pick(["```", "````", "``", " ```"])]
    elif shape == "tilde":
        body += ["~~~~"] + block + [pick(["~~~~", "~~~", "~~~~~"])]
    elif shape == "unclosed":
        body += ["```"] + block
    elif shape == "info-backtick":
        body += ["``` a`b"] + block + ["```"]
    elif shape == "end-first":
        body += ["<!-- /status -->"] + block
    elif shape == "two-begins":
        body += ["<!-- status -->", "dropped"] + block
    elif shape == "short-closer":
        # A shorter closer before the block closes nothing; a longer one, or the same, does.
        body += [pick(["~~~~", "````"]), "code", pick(["~~~", "```", "~~~~~", "`````"])] + block + ["~~~~"]
    elif shape == "after-fence":
        body += ["```", "code", "```"] + block
    lead = pick(["", "", chr(0xfeff), "\n\n", " \t\n"])
    text = lead + "---\n" + "\n".join(fm) + "\n---\n" + "\n".join(["Body text."] + body) + "\n"
    with open(os.path.join(out, "m%03d.md" % i), "w", encoding="utf-8", newline="") as f:
        f.write(text.replace("\n", eol) if eol != "\n" else text)
PY
cat > "$TMP/py-reader.py" <<'PY'
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("recall", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
out = {}
for name in sorted(os.listdir(sys.argv[2])):
    t = m._thread(open(os.path.join(sys.argv[2], name), encoding="utf-8", errors="replace").read())
    out[name] = None if t is None else [t[0], t[1], t[2] if t[0] == "listed" else None]
json.dump(out, open(sys.argv[3], "w", encoding="utf-8"), ensure_ascii=True)
PY
cat > "$TMP/js-reader.js" <<'JS'
const Module = require('module');
const real = Module._load;
Module._load = function load(request, ...rest) { return request === 'vscode' ? {} : real.call(this, request, ...rest); };
const lint = require(process.argv[2]);
const fs = require('fs');
const path = require('path');
const out = {};
for (const name of fs.readdirSync(process.argv[3]).sort()) {
  const t = lint.threadOf(fs.readFileSync(path.join(process.argv[3], name), 'utf8'));
  out[name] = t === null ? null : [t.kind, t.status, t.kind === 'listed' ? t.text : null];
}
fs.writeFileSync(process.argv[4], JSON.stringify(out));
JS
"$PY" "$TMP/py-reader.py" "$RECALL" "$GEN" "$TMP/py.json" || fail "the Python reader crashed"
node "$TMP/js-reader.js" "$LINT_JS" "$GEN" "$TMP/js.json" || fail "the JavaScript reader crashed"
"$PY" - "$TMP/py.json" "$TMP/js.json" "$GEN" <<'PY' || fail "JavaScript and Python disagree about which memories are threads (above)"
import json, os, sys
from collections import Counter
py = json.load(open(sys.argv[1], encoding="utf-8"))
js = json.load(open(sys.argv[2], encoding="utf-8"))
assert sorted(py) == sorted(js), "the readers saw different files"
kinds = Counter((v or ["none"])[0] for v in py.values())
print("  kinds:", dict(sorted(kinds.items())))
# Witness: every outcome is reached often enough that the agreement below is over real variety.
for kind in ("none", "listed", "closed", "duplicate", "unknown", "no-block"):
    assert kinds[kind] >= 15, f"the generator reached {kind} only {kinds[kind]} times"
listed = [v[2] for v in py.values() if v and v[0] == "listed"]
for marker, what in (("&lt;!--", "a neutralised <!--"), ("--&gt;", "a neutralised -->"), (chr(92) + "#", "an escaped #")):
    assert any(marker in t for t in listed), f"no listed text holds {what}"
wrong = [n for n in sorted(py) if py[n] != js[n]]
for n in wrong[:8]:
    raw = open(os.path.join(sys.argv[3], n), "rb").read()
    print(f"  {n}: python {py[n]!r}\n        js     {js[n]!r}\n        file   {raw!r}")
assert not wrong, f"{len(wrong)} of {len(py)} memories read differently"
print(f"  {len(py)} memories, every one read alike")
PY
IDX="$TMP/idx"; mkdir -p "$IDX"
"$PY" - "$IDX" <<'PY'
import os, sys
out = sys.argv[1]
cases = []
for n in (139, 140, 141):
    for eol in ("\n", "\r\n"):
        cases.append("".join(f"- l{i}{eol}" for i in range(n)))
for size in (11999, 12000, 12001):
    cases.append("x" * (size - 1) + "\n")
    cases.append(chr(0xe9) * ((size - 1) // 2) + "\n" + "y" * ((size - 1) % 2))
for width in (299, 300, 301):
    for ch in ("x", chr(0xe9), chr(0x1f600)):
        cases.append("short\n" + ch * width + "\r\n")
cases.append(chr(0xfeff) + "x" * 300 + "\n")
cases.append("")
cases.append("no newline at the end")
for i, text in enumerate(cases):
    d = os.path.join(out, "s%02d" % i)
    os.makedirs(d)
    open(os.path.join(d, "MEMORY.md"), "w", encoding="utf-8", newline="").write(text)
PY
cat > "$TMP/py-index.py" <<'PY'
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("recall", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
out = {}
for d in sorted(os.listdir(sys.argv[2])):
    m.MEMORY_DIR = os.path.join(sys.argv[2], d)
    out[d] = m._index_health()
json.dump(out, open(sys.argv[3], "w", encoding="utf-8"))
PY
cat > "$TMP/js-index.js" <<'JS'
const Module = require('module');
const real = Module._load;
Module._load = function load(request, ...rest) { return request === 'vscode' ? {} : real.call(this, request, ...rest); };
const lint = require(process.argv[2]);
const fs = require('fs');
const path = require('path');
const conf = { lineBudget: 300, totalBudget: 12000, maxLines: 200 };
const out = {};
for (const d of fs.readdirSync(process.argv[3]).sort()) out[d] = lint.indexHealth(lint.fastLint(path.join(process.argv[3], d), conf));
fs.writeFileSync(process.argv[4], JSON.stringify(out));
JS
"$PY" "$TMP/py-index.py" "$RECALL" "$IDX" "$TMP/py-index.json" || fail "the Python index reader crashed"
node "$TMP/js-index.js" "$LINT_JS" "$IDX" "$TMP/js-index.json" || fail "the JavaScript index reader crashed"
"$PY" - "$TMP/py-index.json" "$TMP/js-index.json" <<'PY' || fail "indexHealth and _index_health disagree (above)"
import json, sys
py = json.load(open(sys.argv[1], encoding="utf-8"))
js = json.load(open(sys.argv[2], encoding="utf-8"))
flagged = sum(1 for v in py.values() if v)
assert 10 <= flagged < len(py), f"the index cases are degenerate: {flagged} of {len(py)} flagged"
wrong = [k for k in sorted(py) if py[k] != js[k]]
for k in wrong:
    print(f"  {k}: python {py[k]}\n       js     {js[k]}")
assert not wrong, f"{len(wrong)} of {len(py)} indexes judged differently"
print(f"  {len(py)} indexes, {flagged} past a budget, every one judged alike")
PY
echo "ok: memoryLint.js threadOf and indexHealth read every generated memory and index exactly as recall.py does"

echo "ALL PASS: test/threads-compile.sh"
