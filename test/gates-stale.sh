#!/usr/bin/env bash
#
# recall.py gate-staleness check, proven in isolation.
#
# Not part of `node --test`: recall.py needs the local toolbox Python (numpy + onnxruntime),
# which GitHub CI does not have, so this is a local check in the same spirit as recall.py's
# own `--selftest`. Run it where the toolbox lives:
#
#     bash test/gates-stale.sh
#
# What it guards: editing the text inside a <!-- gate --> block without recompiling leaves
# the resident CLAUDE.md block out of date, and `--gates status` cannot see it (it compares
# installed to gates.generated.md, so when both are stale together it reads "current"). The
# `recall.py --lint` drift check is the one place source is compared to what a recompile
# would produce. Everything runs under a throwaway HOME, so the real ~/.claude is untouched.
set -e

PY="${TOOLBOX_PYTHON:-$LOCALAPPDATA/DevToolbox/python/.venv/Scripts/python.exe}"
RECALL="$(dirname "$0")/../memory/recall.py"

HOME_TMP="$(mktemp -d)"
MEM="$HOME_TMP/mem"
mkdir -p "$MEM" "$HOME_TMP/.claude"
trap 'rm -rf "$HOME_TMP"' EXIT

cat > "$MEM/a-rule.md" <<'EOF'
---
name: a-rule
scope: global
type: feedback
---
<!-- gate -->
- **Test.** Original wording. Pass: nothing.
<!-- /gate -->
EOF
printf '# Memory Index\n\n- [a](a-rule.md) hook\n' > "$MEM/MEMORY.md"

lint()    { HOME="$HOME_TMP" USERPROFILE="$HOME_TMP" RECALL_MEMORY_DIR="$MEM" RECALL_REEXEC=1 "$PY" "$RECALL" --lint; }
compile() { HOME="$HOME_TMP" USERPROFILE="$HOME_TMP" RECALL_MEMORY_DIR="$MEM" RECALL_REEXEC=1 "$PY" "$RECALL" --gates-compile >/dev/null; }

fail() { echo "FAIL: $1"; exit 1; }

# Every negative below used to read `lint | grep -q STALE && fail ... || echo ok`, and three of
# the four could not fail. A pipeline masks python's exit status, and an `&&`/`||` list suppresses
# `set -e`, so a lint that CRASHED printed nothing, grep matched nothing, and the `||` branch
# reported "ok". Proven: deleting `or not os.path.exists(GATES_OUT)` from _gates_are_stale left a
# FileNotFoundError traceback in the output and the suite still said ALL PASS. Only the positive
# assertion (drift detected) could ever fire.
#
# So capture first, and prove the run happened before reading its text.
#
# NOT `lint_check ... | grep`. The first repair of this file did exactly that and the mutation
# still survived: every stage of a pipeline runs in a SUBSHELL, so `fail`'s `exit 1` killed the
# subshell and the parent went on reading grep's status. The capture has to happen in THIS shell.
LINT_OUT=""
run_lint() {
  LINT_OUT="$(lint)" || fail "$1: --lint exited non-zero"
  [ -n "$LINT_OUT" ] || fail "$1: --lint produced no output at all"
}
says_stale() { printf '%s' "$LINT_OUT" | grep -q STALE; }

compile
run_lint "fresh compile"
says_stale && fail "stale right after compile"
echo "ok: fresh compile is not stale"

sed -i 's/Original wording/CHANGED wording/' "$MEM/a-rule.md"
run_lint "after a gate edit"
says_stale || fail "drift NOT detected after a gate edit"
echo "ok: drift detected"

compile
run_lint "after recompile"
says_stale && fail "still stale after recompile"
echo "ok: recompile clears it"

rm -f "$HOME_TMP/.claude/gates.generated.md"
run_lint "never compiled"
says_stale && fail "a never-compiled corpus must not report stale"
echo "ok: uncompiled is not stale"

echo "ALL PASS"