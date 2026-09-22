#!/usr/bin/env python3
"""gate_recall.py -- retrieval-quality gate for recall.py's ranking modes.

bench_embed.py answers "which EMBEDDER should we ship". This answers a different question:
"given the embedder we ship, does the RANKER find the right memory from a question phrased the
way a person would actually ask it?" That matters because the always-loaded MEMORY.md index
carries a slug vocabulary purely so the model can feed exact filenames back to the retriever. If
a natural-language question ranks the right file first, the vocabulary can leave the index.

It ranks the same question set under every mode recall.py supports and reports R@1, R@3, MRR and
the median rank of the first correct target, then applies two gates:

  PASS  hybrid R@1 >= GATE_R1_MIN
  PROOF hybrid MRR must beat vector-only by GATE_MRR_LIFT -- if it does not, the lexical leg is
        doing nothing and the change must not ship. The mutation test, built in rather than
        bolted on.

Median rank is reported and deliberately NOT gated. Measured 2026-09-14: all four modes score a
median of 1.0 on the 24-question set, vector-only included, so a median gate would have passed
against completely unchanged code. That is the failure mode this file exists to avoid, so it is
worth naming here rather than in a commit message nobody re-reads.

Usage (from anywhere):
    python gate_recall.py
    python gate_recall.py --verbose        # per-question ranks, all modes
    python gate_recall.py --modes hybrid,vector

Config via env:
    RECALL_MEMORY_DIR   corpus to rank over   (default: recall.py's own discovery)
    RECALL_MODEL_DIR    bge-small.onnx dir    (default: recall.py's own discovery)
    GATE_QUERIES        question set path     (default: ./queries.json)
    GATE_R1_MIN         pass threshold on R@1 (default: 0.70)
    GATE_MRR_LIFT       hybrid must beat vector by this (default: 0.05)

queries.json is gitignored on purpose -- it maps the private memory corpus. Its shape is the one
bench_embed.py already reads, with one optional field added:

    {"queries": [{"q": "...", "targets": ["file.md"], "axis": "paraphrase"}]}

`axis` is advisory, printed in --verbose, and exists so a later reader can check the set still
varies the things it claims to vary. A gate whose generator is degenerate on some axis proves
nothing about that axis.
"""
import os, sys, json, argparse, importlib.util, statistics

for stream in (sys.stdout, sys.stderr):          # Windows consoles default to cp1252
    try: stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass

HERE = os.path.dirname(os.path.abspath(__file__))
QUERIES = os.environ.get("GATE_QUERIES") or os.path.join(HERE, "queries.json")
# There is deliberately no GATE_MEDIAN_MAX. It existed, was documented as a pass threshold, and
# nothing read it -- a documented knob that silently does nothing is the same class of defect as
# a gate that cannot fail. Median is a reported column; see the gate below for why.
R1_MIN = float(os.environ.get("GATE_R1_MIN", "0.70"))      # the gate that actually discriminates
MRR_LIFT_MIN = float(os.environ.get("GATE_MRR_LIFT", "0.05"))  # hybrid must beat vector by this
MISS_RANK_PENALTY = 999          # a target that never appears must hurt the median, not be dropped

# --- import recall.py so the gate measures the DEPLOYED ranker, not a copy of it ---
_spec = importlib.util.spec_from_file_location("recall", os.path.join(HERE, "..", "recall.py"))
recall = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(recall)                 # runs its runtime shim; a no-op inside the venv


# The corpus is the owner's PRIVATE memory store, and a filename in it can carry
# personal or employer material. This project's convention puts bench numbers in
# the commit message, and a public commit message cannot be un-published, so the
# raw filename never leaves this process. A stable short hash still answers the
# question these reports are for -- is the SAME wrong file winning every time --
# without naming it.
def _opaque(name):
    import hashlib
    if not name:
        return "(none)"
    return "file:" + hashlib.sha256(str(name).encode("utf-8")).hexdigest()[:10]


def load_queries():
    if not os.path.exists(QUERIES):
        sys.exit(f"[gate] no question set at {QUERIES}\n"
                 f"       queries.json is gitignored (it maps the private corpus). Author it, or\n"
                 f"       point GATE_QUERIES at a fixture set.")
    return json.load(open(QUERIES, encoding="utf-8"))["queries"]


def rank_of(results, targets):
    """1-based rank of the first correct target, or None if it never appears."""
    for i, row in enumerate(results):
        if row["name"] in targets:
            return i + 1
    return None


def measure(mode, queries, parts):
    idx, lex, emb, names = parts
    ranks, misses = [], []
    for item in queries:
        results = recall.rank(item["q"], k=0, mode=mode,
                              idx=idx, lex=lex, emb=emb, names=names)
        r = rank_of(results, set(item["targets"]))
        ranks.append(r)
        if r != 1:
            misses.append((item["q"][:54], results[0]["name"] if results else "(none)", r))
    scored = [r if r else MISS_RANK_PENALTY for r in ranks]
    n = len(ranks)
    return {
        "R@1": sum(1 for r in ranks if r == 1) / n,
        "R@3": sum(1 for r in ranks if r and r <= 3) / n,
        "MRR": sum(1.0 / r for r in ranks if r) / n,
        "median": statistics.median(scored),
        "worst": max(scored),
        "ranks": ranks,
        "misses": misses,
    }


def main():
    ap = argparse.ArgumentParser(description="Retrieval-quality gate for recall.py's rankers.")
    ap.add_argument("--modes", default="hybrid,vector,lexical", help="comma-separated modes to run")
    ap.add_argument("--verbose", action="store_true", help="per-question ranks and miss detail")
    ap.add_argument("--fuse-w", type=float, default=None,
                    help="override recall.FUSE_W. --fuse-w 1.0 disables the lexical leg entirely, "
                         "which is the mutation that must make this gate FAIL")
    args = ap.parse_args()
    if args.fuse_w is not None:
        recall.FUSE_W = args.fuse_w

    queries = load_queries()
    modes = [m.strip() for m in args.modes.split(",") if m.strip()]

    # Build the corpus, the lexical statistics and the ONNX session ONCE, then hand the same
    # objects to every mode. Otherwise the comparison is between one cold start and three warm
    # ones, and the session costs ~620 ms measured on this box.
    idx = recall.build_or_update()
    if not idx["files"]:
        sys.exit("[gate] nothing indexed.")
    names = sorted(idx["files"])
    lex = recall._lex_index(names)
    # _bge(), NOT Bge(). build_or_update above already populates the module singleton whenever
    # anything was stale, so constructing directly here built a SECOND session: measured +624 ms
    # and +45 MB RSS. That is the exact defect this file exists to validate the fix for,
    # reintroduced inside the validator, beneath a comment claiming the session is built once.
    emb = recall._bge()
    parts = (idx, lex, emb, names)

    print(f"\n  gate: {len(queries)} questions over {len(idx['files'])} memories"
          f"   (pass: hybrid R@1 >= {R1_MIN:.2f}, MRR lift >= {MRR_LIFT_MIN:.2f})\n")
    print(f"  {'mode':9s} {'R@1':>6s} {'R@3':>6s} {'MRR':>6s} {'median':>7s} {'worst':>6s}")
    print(f"  {'-' * 9} {'-' * 6} {'-' * 6} {'-' * 6} {'-' * 7} {'-' * 6}")

    got = {}
    for mode in modes:
        m = measure(mode, queries, parts)
        got[mode] = m
        worst = "miss" if m["worst"] == MISS_RANK_PENALTY else f"{m['worst']:.0f}"
        print(f"  {mode:9s} {m['R@1']:6.2f} {m['R@3']:6.2f} {m['MRR']:6.3f} "
              f"{m['median']:7.1f} {worst:>6s}")

    if args.verbose:
        print(f"\n  {'axis':<14s} {'question':<56s} " + " ".join(f"{m:>8s}" for m in modes))
        for i, item in enumerate(queries):
            cells = " ".join(f"{(got[m]['ranks'][i] or 0) or '-':>8}" for m in modes)
            print(f"  {item.get('axis', '-'):<14s} {item['q'][:56]:<56s} {cells}")

    print()
    # `gated` starts False so an invocation that runs NO gate cannot report PASS. Both gates are
    # conditional on hybrid being in --modes, so `--modes lexical` previously printed a table and
    # exited 0 with RESULT: PASS, having checked nothing at all.
    ok, gated = True, False
    if "hybrid" in got:
        # NOT median rank. Measured 2026-09-14 on the 24-question set: EVERY mode scores a median
        # of 1.0, including vector-only, because most questions already land their target first.
        # A gate that the unchanged code also passes is not a gate. R@1 is what moves (0.58 ->
        # 0.79) and it is what the resident slug vocabulary was buying, so R@1 is what decides
        # whether the vocabulary can leave MEMORY.md.
        passed = got["hybrid"]["R@1"] >= R1_MIN
        print(f"  {'PASS ' if passed else 'FAIL '} hybrid R@1 {got['hybrid']['R@1']:.2f} "
              f"{'>=' if passed else '<'} {R1_MIN:.2f}   (median {got['hybrid']['median']:.1f}, "
              f"reported but NOT gated: every mode scores 1.0)")
        ok &= passed
        gated = True
    if "hybrid" in got and "vector" in got:
        # The mutation test. If the old ranker clears the same bar, the new leg earned nothing and
        # shipping it would be cargo cult. A green gate that cannot fail is not evidence.
        lift = got["hybrid"]["MRR"] - got["vector"]["MRR"]
        proof = lift >= MRR_LIFT_MIN
        print(f"  {'PROOF' if proof else 'FAIL '} vector-only MRR {got['vector']['MRR']:.3f} vs "
              f"hybrid {got['hybrid']['MRR']:.3f}, lift {lift:+.3f} "
              f"(need >= {MRR_LIFT_MIN:.3f})"
              + ("" if proof else "   <-- lexical leg adds NOTHING, do not ship"))
        ok &= proof

    for mode in modes:
        if got[mode]["misses"]:
            print(f"\n  {mode} did not rank first ({len(got[mode]['misses'])}):")
            for q, first, r in got[mode]["misses"]:
                print(f"    rank {r if r else 'miss':>4}  {q}\n            got: {_opaque(first)}")

    if not gated:
        print("  NO GATE RAN. Both gates need 'hybrid' in --modes; this run only measured.")
    print(f"\n  RESULT: {'PASS' if ok and gated else 'FAIL'}\n")
    sys.exit(0 if ok and gated else 1)


if __name__ == "__main__":
    main()
