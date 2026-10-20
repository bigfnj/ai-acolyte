#!/usr/bin/env python3
"""recall.py -- semantic search + hygiene lint over the Claude Code file-memory dir.

The always-loaded MEMORY.md index is deliberately thin (one-line hooks). This is the
on-demand second layer: ask a plain-language question and it finds the memory *files*
that mean the same thing, so "have I solved X before?" works across projects even when
the words differ from the hook. `--lint` audits the index for bloat and broken links.

Embeddings run on the CPU via a local bge-small-en-v1.5 ONNX model (the int8 ONNX
export of BAAI/bge-small-en-v1.5) -- always available, no GPU, no Ollama, no MCP, no
hooks, so it runs under a managed policy. Vectors are cached and only changed files
re-embed on the next run.

Ranking is hybrid: the embedding cosine, fused with BM25 over the WHOLE file. The two
answer different questions because the embedder truncates at 256 tokens, so on this
corpus the median file contributes only ~832 chars to its vector and deeper text -- the
commands, the error strings, the paths -- is invisible to the vector leg entirely.

Usage (from anywhere):
    python recall.py "how do I push git from the agent shell"
    python recall.py -k 10 "run admin tasks without a UAC prompt"
    python recall.py --vector-only "..."   # cosine alone; the pre-hybrid ranking
    python recall.py --lexical-only "..."  # BM25 alone; builds no ONNX session
    python recall.py --lint            # audit index bloat + links (no model needed)
    python recall.py --gates-compile   # lift scope:global gate blocks into ~/.claude/gates.generated.md
                                       # (one section per agent once a gate names `agents:`)
    python recall.py --gates-compile --gates-allow-empty
                                       # ... and allow the result to be EMPTY. Without this flag a
                                       # compile that finds no gates refuses to overwrite a non-empty
                                       # gates.generated.md, because the usual cause is a corpus
                                       # pointed at the wrong dir, not a deliberate deletion.
    python recall.py --rebuild         # force re-embed every file
    python recall.py --list            # show what's indexed
    python recall.py --selftest        # verify the embedder reproduces its reference cosines
    python recall.py --gates-list      # every scope:global / scope:retired gate, as JSON
    python recall.py --gates-retire NAME [NAME ...]    # scope: global -> retired, after a
    python recall.py --gates-restore NAME [NAME ...]   # snapshot; the caller compiles next
    python recall.py --threads-compile # every memory whose `status:` is open, awaiting, blocked or
                                       # deferred, plus MEMORY.md's health, into
                                       # ~/.claude/open-threads.generated.md

Config via env:
    RECALL_MEMORY_DIR   corpus to index      (default: the ~/.claude/projects/*/memory
                                             holding the most memory files)
    RECALL_MEMORY_DIRS  corpora to SEARCH    (os.pathsep-separated; default: the one above.
                                             --lint, --gates-compile and the gate edits
                                             never span these)
    RECALL_MODEL_DIR    bge-small.onnx dir   (default ./models)
    AI_ACOLYTE_GATE_SNAPSHOT_DIR             where --gates-retire / --gates-restore snapshot
                                             the memory dir first (default
                                             ~/.claude/wildcarding/gate-snapshots)

Retrieval quality is measured by bench/gate_recall.py, not asserted here.
"""
import os, sys, re, json, math, time, argparse, hashlib, unicodedata
from collections import Counter

# --- runtime shim: onnxruntime + numpy live in the DevToolbox venv, not system python.
# Re-run under the venv python via subprocess (NOT os.execv -- Windows detaches the
# execv'd process from the parent's stdio, so its output would be lost). ---
def _ensure_runtime():
    # AVAILABILITY, not import. This used to be `import onnxruntime, numpy`, which is a
    # very expensive way to ask a yes/no question: it paid the full module
    # initialisation of both on every invocation, including --lint, --lexical-only,
    # --gates-compile and --list, none of which reach either library. find_spec walks
    # the path and executes no module code.
    from importlib.util import find_spec
    try:
        if find_spec("onnxruntime") is not None and find_spec("numpy") is not None:
            return
    except (ImportError, ValueError):
        pass
    if os.environ.get("RECALL_REEXEC") == "1":
        sys.exit("[recall] needs onnxruntime + numpy. In the DevToolbox venv:\n"
                 "  & \"$env:LOCALAPPDATA\\DevToolbox\\python\\.venv\\Scripts\\python.exe\" -m pip install onnxruntime numpy")
    base = os.environ.get("CODEX_TOOLBOX") or os.path.expandvars(r"%LOCALAPPDATA%\DevToolbox")
    py = os.path.join(base, "python", ".venv", "Scripts", "python.exe")
    if os.path.exists(py) and os.path.abspath(py) != os.path.abspath(sys.executable):
        import subprocess
        env = dict(os.environ, RECALL_REEXEC="1")
        sys.exit(subprocess.run([py, os.path.abspath(__file__)] + sys.argv[1:], env=env).returncode)
    sys.exit("[recall] needs onnxruntime + numpy and the DevToolbox venv was not found.")


_ensure_runtime()


# Imported on first ATTRIBUTE ACCESS, not at module scope.
#
# onnxruntime is touched at exactly one line in this file (Bge.__init__, the
# InferenceSession) and numpy only inside the embedder, the cosine matmul and
# --selftest. `--lint`, `--lexical-only`, `--gates-compile` and `--list` reach none of
# them and were paying both import costs anyway, and --gates-compile is on the VS Code
# extension's corpus-watcher path, so it runs whenever a memory file is saved.
#
# A proxy rather than a `global np` loader called from each function: there are ten use
# sites and a loader you can forget to call at one of them fails with a confusing
# AttributeError on None. This cannot be forgotten, because there is nothing to call.
# Every use in this file is an attribute access (np.array, np.linalg.norm,
# ort.InferenceSession); nothing passes the module itself anywhere.
class _LazyModule:
    def __init__(self, name):
        self._lazy_name = name
        self._lazy_mod = None

    def __getattr__(self, attr):
        mod = self._lazy_mod
        if mod is None:
            import importlib
            mod = importlib.import_module(self._lazy_name)
            object.__setattr__(self, "_lazy_mod", mod)
        return getattr(mod, attr)


np = _LazyModule("numpy")
ort = _LazyModule("onnxruntime")

HERE = os.path.dirname(os.path.abspath(__file__))


# Claude Code derives the project slug from the working directory, so the corpus moves
# whenever the working root is renamed (that happened here on 2026-08-20 and left the
# old hardcoded default pointing at a deleted directory). Discover the
# store instead of hardcoding one slug: pick the ~/.claude/projects/*/memory holding the
# most memory files, and only fall back to a literal when nothing is found.
def _discover_memory_dir():
    root = os.path.expanduser(r"~/.claude/projects")
    best, best_count = None, 0
    try:
        slugs = os.listdir(root)
    except OSError as e:
        print(f"[recall] cannot list {root} ({e}); falling back to the default store",
              file=sys.stderr)
        if not isinstance(e, FileNotFoundError):   # no projects dir at all: a fresh machine
            _DISCOVERY_ERRORS.append((root, e))
        slugs = []
    for slug in slugs:
        candidate = os.path.join(root, slug, "memory")
        if not os.path.isdir(candidate):
            continue
        try:
            count = len([f for f in os.listdir(candidate) if f.endswith(".md")])
        except OSError as e:
            # Per-candidate, and LOUD. A single `except OSError: pass` around the whole loop
            # meant one unreadable store aborted the scan and silently returned the best of
            # whatever had been reached first, or the hardcoded fallback if the first candidate
            # raised. This is the authority for which corpus gets indexed, linted and compiled
            # into standing orders, and it was the quiet one: the Node copy in memoryLint.js
            # already refuses to degrade in silence, for the same reason and after an injected
            # EMFILE scored a 123-file store below a 7-file one.
            print(f"[recall] cannot read {candidate} ({e}); it cannot win corpus selection",
                  file=sys.stderr)
            _DISCOVERY_ERRORS.append((candidate, e))
            continue
        if count > best_count:
            best, best_count = candidate, count
    return best or os.path.join(root, "memory")  # slug-free: a hardcoded one named the author's root


# normpath for the same reason GATES_OUT gets it: expanduser substitutes a backslash HOME into
# the forward-slash literal in _discover_memory_dir and leaves the rest, so this read
# `C:\Users\<user>/.claude/projects\<slug>\memory` -- and it is interpolated into the same
# two compile_gates() refusal messages, where a mixed-separator path reads like a bug in the
# thing reporting the bug. Separator-only, so the message LENGTH does not move (228 and 226
# chars here, both still inside extension.js's 300-char stderr slice).
#
# _DISCOVERY_ERRORS holds (path, error) for each directory discovery could not read, and
# compile_gates() refuses on any of them (ported from rampage 7139659, 2026-10-14). An explicit
# RECALL_MEMORY_DIR skips discovery, so it never fills.
_DISCOVERY_ERRORS = []
MEMORY_DIR =os.path.normpath(os.environ.get("RECALL_MEMORY_DIR") or _discover_memory_dir())
# This count rule is the AUTHORITY. Two other places pick a corpus -- memoryLint.js
# pickPrimaryDir and scripts/verify-release.ps1 Find-MemoryDir -- and both used to sort by
# MEMORY.md mtime instead. The extension pins RECALL_MEMORY_DIR from its copy on every spawn, so
# its weaker rule silently overrode this one; they agreed only because one store was both largest
# and newest. All three count files as of 2026-09-14.
#
# They are NOT identical, and an earlier version of this comment overstated that. Two real
# differences, both left deliberately:
#   * Candidate sets. This accepts any `*/memory` directory; the other two require a MEMORY.md
#     inside it. A store with memories and no index file is this function's primary and is
#     invisible to them.
#   * Tie-breaks. This takes the first os.listdir entry on an exact count tie; both copies take
#     the newest MEMORY.md, and their tests assert it. On a tie the extension would therefore
#     compile gates from one store while a bare CLI run used the other. Not reachable at 122
#     files against 6, reachable the moment a store is copied rather than moved.
#
# test/recall-index.test.js pins this expression from the Node side. Note what that does and does
# not buy: it fires when the AUTHORITY moves, which is the safe direction. It cannot fire when a
# COPY drifts, which is the direction that shipped the original bug. memoryLint's copy is covered
# by its own behavioural tests; verify-release.ps1's copy has no test at all.
#
# SEARCH may span several corpora; everything else stays on the one primary dir above. A working
# root that gets renamed leaves its old store behind and _discover_memory_dir, which takes the
# single largest, then cannot see it. That happened here: 6 memories were stranded in a
# C--Anthropic store. Resolved 2026-09-14 -- the two the main corpus had never re-recorded were
# verified against the machine and copied across, the other four were older versions of memories
# it already held, and the store was then deleted along with the dev root that minted its slug.
# There is now exactly one store on this box. The capability below stays because the NEXT rename
# will do the same thing. --lint and --gates-compile deliberately
# do NOT span, because a gate is a standing order and a second corpus must not be able to
# install one silently.
def _search_dirs():
    """Corpora to SEARCH: the primary, then anything in RECALL_MEMORY_DIRS, order preserved.

    EXTENDS rather than replaces. Setting the plural var to just the stranded store is the
    obvious thing to type after reading about it, and under a replacing rule that silently
    removed all 119 primary memories from search while --lint, --list and --gates-compile
    carried on reporting them. A quiet hole is worse than an error.

    Non-existent entries are dropped here, not at the point of use: _display_keys already
    tolerated a bad path but _retriever's own loop did not, so one stale entry raised
    FileNotFoundError out of every query while --lexical-only kept working. Merging the
    stranded corpus and deleting it would have done exactly that. (The merge happened on
    2026-09-14; the store was deliberately left in place, so this now guards a stale hand-set
    var rather than an imminent deletion.) The primary is kept whether or not it exists, so its
    own error messages still name it.
    """
    extra = (os.environ.get("RECALL_MEMORY_DIRS") or "").split(os.pathsep)
    out, seen = [], set()
    for i, d in enumerate([MEMORY_DIR] + [e.strip() for e in extra]):
        if not d or (i and not os.path.isdir(d)):
            continue
        key = os.path.normcase(os.path.abspath(d))
        if key not in seen:
            seen.add(key)
            out.append(d)
    return out


MEMORY_DIRS = _search_dirs()
EMBED_CHAR_CAP = 8000          # per-file text handed to the tokenizer
EXCLUDE = {"MEMORY.md"}        # the index is just hooks; skip it as a search target
EMBED_ID = "bge-small-onnx"    # cache identity; bump to force a full re-embed
# --- lexical leg. The embedder truncates every doc to 256 tokens (_encode), so on this corpus
# the median file contributes only ~832 chars to its vector and the worst case 9%. Commands,
# error strings and paths deeper in a file are invisible to the vector leg. BM25 reads the whole
# file, which is where the recall it adds comes from -- do not narrow it to the embedded slice.
BM25_K1 = 1.2                  # term-frequency saturation; the textbook default. These files carry
                               # no keyword spam for a different value to defend against.
BM25_B = 0.75                  # length normalization, and the whole answer to the 211k-char file in
                               # this corpus: its dl/avgdl is 28.9, so the normalizer demands tf~26
                               # before it scores what a median file scores at tf=1. Measured at
                               # b=0 that one file took a top-10 slot on 8 of 8 probe queries; at
                               # 0.75 it took none. Do NOT cap the per-file read instead -- a cap
                               # reintroduces, one layer down, the exact truncation this leg exists
                               # to defeat.
LEX_MIN_TERM = 2               # chars. best_line uses 3; measured here 2 is better, because gh, ps,
                               # js, ui and db are discriminating keys in this corpus and
                               # reference_git_push_gh_helper's only natural handle is "gh".
LEX_SLUG_WEIGHT = 2            # extra counts for the filename's own words. A presence boost, not a
                               # fitted knob: measured flat (MRR .612/.612/.613/.613) from 1 to 5.
FUSE_W = 0.5                   # cosine's share of the fused score, the rest BM25, each min-max
                               # normalized per query. Measured flat across 0.3/0.5/0.7.
RRF_K = 60                     # damping for the reciprocal-rank fusion kept as mode="rrf". Not the
                               # default: RRF ranks, so a document NO query term touches scores as
                               # merely "last" rather than abstaining, and its floor is only 3x
                               # below its ceiling. Min-max lets the lexical leg contribute exactly
                               # 0.0 when it cannot separate, degrading to pure cosine.
LINT_LINE_WARN = 300           # chars; a dense one-line hook ceiling -- over this is drifting to changelog
LINT_TOTAL_WARN = 12000        # bytes; whole always-loaded index getting heavy
LINT_ENTRY_WARN = 16           # resident entries. Attention dilutes per-entry, not per-byte: 3k
                               # tokens costs nothing, 50 entries competing for relevance does.
                               # Set from the real floor after the 2026-08-24 diet (52 -> 11:
                               # 7 recall triggers + 4 entries nothing else can trigger), with
                               # headroom for a few triggers. 0 would mean report-only.
LINT_LINES_WARN = 140          # lines; the target below Claude Code's 200-line load cap
GATE_BEGIN = "<!-- gate -->"   # a scope:global memory's resident lines, lifted verbatim into
GATE_END = "<!-- /gate -->"    # the managed CLAUDE.md block so the compiler needs no judgement
# ONE pairing test, used by BOTH _compile_gates_text() and --lint's "resident-eligible, not
# compiled" report. They had two, and the linter's was the wider one: it asked `GATE_BEGIN in
# text`, so a memory carrying an opening marker and no closing marker compiled NOTHING and was
# omitted from the only report that exists to say so. Not hypothetical -- on the live corpus
# project_memory_gates.md is scope:global with one lone `<!-- gate -->` in prose describing this
# very pipeline, and --lint stayed silent about it. vscode-extension/memoryLint.js was narrowed
# to this rule on 2026-09-14; sharing one object is what stops the authority drifting off it.
GATE_BLOCK = re.compile(re.escape(GATE_BEGIN) + r"(.*?)" + re.escape(GATE_END), re.DOTALL)
UNK, CLS, SEP = "[UNK]", "[CLS]", "[SEP]"


def _model_dir():
    for d in (os.environ.get("RECALL_MODEL_DIR"),
              os.path.join(HERE, "models")):
        if d and os.path.exists(os.path.join(d, "bge-small.onnx")):
            return d
    sys.exit("[recall] bge-small.onnx not found. Put it in ./models or set RECALL_MODEL_DIR "
             "(the int8 ONNX export of BAAI/bge-small-en-v1.5; the extension can fetch it).")


class Bge:
    """bge-small-en-v1.5 ONNX embedder: BERT-uncased WordPiece, CLS-pool, L2-norm (384-dim)."""

    def __init__(self):
        d = _model_dir()
        self.vocab = {}
        with open(os.path.join(d, "bge-small.vocab.txt"), encoding="utf-8") as f:
            for i, line in enumerate(f):
                self.vocab[line.rstrip("\n")] = i
        for t in (UNK, CLS, SEP):
            if t not in self.vocab:
                sys.exit("[recall] vocab is missing a required special token.")
        self.sess = ort.InferenceSession(os.path.join(d, "bge-small.onnx"),
                                         providers=["CPUExecutionProvider"])
        self.innames = [i.name for i in self.sess.get_inputs()]

    def _basic(self, text):
        out, buf = [], []
        for c in text.lower():
            if c.isspace():
                if buf:
                    out.append("".join(buf)); buf = []
            elif unicodedata.category(c)[0] in ("P", "S"):
                if buf:
                    out.append("".join(buf)); buf = []
                out.append(c)
            else:
                buf.append(c)
        if buf:
            out.append("".join(buf))
        return out

    def _wordpiece(self, word):
        if len(word) > 100:
            return [UNK]
        start, pieces = 0, []
        while start < len(word):
            end, cur = len(word), None
            while start < end:
                sub = ("##" if start > 0 else "") + word[start:end]
                if sub in self.vocab:
                    cur = sub; break
                end -= 1
            if cur is None:
                return [UNK]
            pieces.append(cur); start = end
        return pieces

    def _encode(self, text):
        # Stop at the cap instead of wordpiecing the whole input and slicing at the end. The
        # model only ever sees 256 ids, so everything past that was tokenized and thrown away:
        # measured 87.6 ms uncapped against 3.2 ms on a 211 KB file, producing IDENTICAL ids.
        # Vector-identical by construction, so no EMBED_ID bump and no re-embed.
        #
        # 255 because the loop leaves room for the closing SEP appended below, which is what the
        # old `ids[:255] + [SEP]` slice produced.
        ids = [self.vocab[CLS]]
        for w in self._basic(text):
            for p in self._wordpiece(w):
                if len(ids) >= 255:
                    break
                ids.append(self.vocab.get(p, self.vocab[UNK]))
            else:
                continue
            break
        ids.append(self.vocab[SEP])
        return ids

    def embed(self, text):
        ids = self._encode(text or " ")
        n = len(ids)
        arr = np.array(ids, dtype=np.int64).reshape(1, n)
        feeds = {}
        for name in self.innames:
            low = name.lower()
            feeds[name] = (np.ones((1, n), dtype=np.int64) if "mask" in low
                           else np.zeros((1, n), dtype=np.int64) if "type" in low
                           else arr)
        out = self.sess.run(None, feeds)[0]
        v = (out[0, 0, :] if out.ndim == 3 else out[0, :]).astype(np.float64)
        return (v / (np.linalg.norm(v) or 1.0)).tolist()


_BGE = None


def _bge():
    """One ONNX session per process. Construction is most of a warm query's wall time, and two
    in-tree figures for it used to disagree threefold with no method beside either (~620 here,
    ~210 in test/recall-index.test.js). Re-measured 2026-09-14: ONE construction per FRESH
    process, timed around the Bge() call only, 35 processes in two batches. The very first, with
    the 34 MB model not yet in the OS file cache, took 674 ms; the remaining 34, cache warm,
    ran min 239 / p50 264 / max 313 ms. So the two old numbers were not in conflict, they were
    two regimes with neither named -- and the COLD one was being quoted in warm arguments.

    The warm figure is the one to quote here and at the two call sites that cite this: each of
    them is about a SECOND construction in a live process, which can never be the cold read.
    search() used to build its own AFTER build_or_update had already built one, so a query that
    followed an edit paid for the 34 MB session twice. Every caller inside this module goes
    through here; selftest() still constructs Bge directly because construction is what it tests.
    """
    global _BGE
    if _BGE is None:
        _BGE = Bge()
    return _BGE


def parse_meta(text):
    """Return (description, body). description from YAML frontmatter if present."""
    desc, body = "", text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            fm, body = text[3:end], text[end + 4:]
            m = re.search(r'^\s*description:\s*(.+)$', fm, re.MULTILINE)
            if m:
                desc = m.group(1).strip().strip('"').strip("'")
    return desc, body.strip()


def _index_path(mem_dir):
    return os.path.join(mem_dir, "recall_index.json")


def load_index(mem_dir=None):
    INDEX_PATH = _index_path(mem_dir or MEMORY_DIR)
    if os.path.exists(INDEX_PATH):
        try:
            return json.load(open(INDEX_PATH, encoding="utf-8"))
        except Exception as e:
            # Say so. A truncated cache silently discards every vector and re-embeds the whole
            # corpus, which looks exactly like a first run -- slow, correct, and unexplained.
            # stderr with exit 0 on purpose: extension.js treats a non-zero exit as sync failure.
            print(f"[recall] {INDEX_PATH} unreadable ({e.__class__.__name__}); re-embedding all.",
                  file=sys.stderr)
    return {"embed": EMBED_ID, "files": {}}


def save_index(idx, mem_dir=None):
    """Write via a temp file in the same directory, then os.replace. The previous
    json.dump(idx, open(...)) left a truncated cache behind if anything interrupted it, and
    load_index's bare except turned that into a silent full re-embed."""
    INDEX_PATH = _index_path(mem_dir or MEMORY_DIR)
    # Pid in the temp name. os.replace is atomic, but two writers racing into one fixed
    # ".tmp" path interleave BEFORE the replace, and the extension's 15-minute auto-sync
    # runs against the same store a CLI query may be updating.
    tmp = f"{INDEX_PATH}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(idx, f)
    os.replace(tmp, INDEX_PATH)


def build_or_update(force=False, quiet=False, mem_dir=None):
    MEMORY_DIR = mem_dir or globals()["MEMORY_DIR"]      # shadow for the whole body; see MEMORY_DIRS
    idx = load_index(MEMORY_DIR)
    if force or idx.get("embed") != EMBED_ID:
        idx = {"embed": EMBED_ID, "files": {}}

    on_disk = {n: os.stat(os.path.join(MEMORY_DIR, n))
               for n in os.listdir(MEMORY_DIR) if n.endswith(".md") and n not in EXCLUDE}
    gone = [n for n in idx["files"] if n not in on_disk]
    for n in gone:
        del idx["files"][n]

    todo = [n for n, st in on_disk.items()
            if n not in idx["files"]
            or idx["files"][n].get("mtime") != st.st_mtime
            or idx["files"][n].get("size") != st.st_size]

    if todo:
        if not quiet:
            print(f"[recall] embedding {len(todo)} file(s) on CPU (bge-small) ...", file=sys.stderr)
        emb = _bge()
        for n in todo:
            raw = open(os.path.join(MEMORY_DIR, n), encoding="utf-8", errors="replace").read()
            desc, body = parse_meta(raw)
            st = on_disk[n]
            idx["files"][n] = {"mtime": st.st_mtime, "size": st.st_size, "desc": desc,
                               "vec": emb.embed((desc + "\n" + body)[:EMBED_CHAR_CAP])}
    # `or gone`: a deletion-only change used to prune the in-memory dict and then never write it,
    # because the write sat inside `if todo:`. The next run re-read the same stale cache, so
    # recallIndexStatus reported count-mismatch forever and the extension's 15-minute auto-sync
    # re-ran without ever converging. --list printed the right thing throughout, from the pruned
    # in-memory copy, which is why this hid for so long.
    # `or force`: --rebuild over an empty corpus produces todo == [] and gone == [], so without
    # it the reset index is never written and a stale recall_index.json survives the rebuild
    # the user explicitly asked for.
    if todo or gone or force:
        save_index(idx, MEMORY_DIR)
    return idx


def best_line(query, name, text=None):
    terms = {w for w in re.findall(r"[a-z0-9]+", query.lower()) if len(w) > 2}
    if not terms:
        return ""
    best, score = "", 0
    if text is None:
        # A caller that did not build the lexical index (vector mode) passes no text. The name
        # may be qualified with a store slug when MEMORY_DIRS spans corpora, so resolve it rather
        # than assuming the primary dir, and treat a miss as "no snippet" -- a display extra must
        # never be the thing that ends a query.
        path = _display_keys(MEMORY_DIRS).get(name) or os.path.join(MEMORY_DIR, name)
        try:
            text = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            return ""
    for ln in text.splitlines():
        ln = ln.strip()
        # "description:" joined this list once the lexical leg landed: the frontmatter description
        # is already printed on the line above, so without it the snippet just says it twice and
        # never shows the line that actually matched.
        if len(ln) < 25 or ln.startswith(("---", "name:", "metadata:", "description:", "#")):
            continue
        hits = sum(1 for t in terms if t in ln.lower())
        if hits > score:
            best, score = ln, hits
    return (best[:200] + "...") if len(best) > 200 else best


# --- lexical leg: BM25 over the WHOLE file, which is the half the embedder never sees ---------

def _lex_terms(text):
    """Lowercased [a-z0-9]+ runs of LEX_MIN_TERM chars or more. Returns a LIST, not a set:
    document term frequency is the signal best_line never had."""
    return [w for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) >= LEX_MIN_TERM]


def _slug_terms(name):
    """A memory's filename is a hand-written summary -- reference_ps51_scriptroot_param_default
    carries the nouns a person would actually type. Leaving those out of the index is what forced
    the slug vocabulary to be resident in MEMORY.md in the first place."""
    stem = name[:-3] if name.endswith(".md") else name
    return _lex_terms(stem.replace("_", " ").replace("-", " ").replace("/", " "))


def _lex_index(names):
    """Corpus-wide BM25 statistics, computed fresh per run rather than cached. Deliberate: df and
    avgdl are corpus-GLOBAL, so editing one file invalidates them all, which is a different
    invalidation model from the per-file (mtime, size) one recall_index.json uses. Persisting
    would add a staleness axis src/recall-index.js structurally cannot see, to save ~80 ms on a
    command whose ONNX session construction alone costs ~264 ms (see _bge for the method).

    No stopword list: frontmatter boilerplate appears in nearly every file, so Robertson IDF
    flattens it without one (`the` -> 0.021, `backslash` -> 3.535).

    `names` as a LIST is live, not dead, and it is the weaker of the two shapes: it resolves
    each name against the module-global MEMORY_DIR rather than the directory the names came
    from, so a caller holding names from a SECOND corpus would silently read the wrong files.
    bench/gate_recall.py is the only list caller and is single-corpus by construction, which is
    the only reason this is harmless. Pass the {name: path} dict from anywhere else.
    """
    tf, dl, text, df = {}, {}, {}, {}
    for n, path in names.items() if isinstance(names, dict) else ((n, os.path.join(MEMORY_DIR, n))
                                                                 for n in names):
        try:
            raw = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        text[n] = raw
        # The description is already inside raw; counting it again would double-weight it.
        terms = _slug_terms(n) * LEX_SLUG_WEIGHT + _lex_terms(raw)
        # Counter, not a hand-rolled loop: it is a dict subclass, so tf[n] and every
        # downstream use are unchanged, and the counting runs in C.
        counts = Counter(terms)
        tf[n], dl[n] = counts, len(terms)
        for t in counts:
            df[t] = df.get(t, 0) + 1
    total = len(tf)
    idf = {t: math.log(1.0 + (total - d + 0.5) / (d + 0.5)) for t, d in df.items()}
    return {"tf": tf, "dl": dl, "idf": idf, "text": text,
            "avgdl": (sum(dl.values()) / total if total else 0.0) or 1.0}


def _bm25(query, lex):
    """{name: score}, omitting documents no query term touches. Query terms are set-deduped --
    asking twice is not asking harder -- while document term frequency carries the weight."""
    terms = set(_lex_terms(query))
    if not terms or not lex["tf"]:
        return {}
    scores = {}
    for name, counts in lex["tf"].items():
        norm = BM25_K1 * (1.0 - BM25_B + BM25_B * lex["dl"][name] / lex["avgdl"])
        s = 0.0
        for t in terms:
            f = counts.get(t, 0)
            if f:
                s += lex["idf"][t] * (f * (BM25_K1 + 1.0)) / (f + norm)
        if s:
            scores[name] = s
    return scores


def _unit(scores, names):
    """Min-max a score map onto 0..1. A map that separates nothing -- empty, or every value equal
    -- returns 0.0 for every document, so a fusion built on this degrades to the other leg
    instead of fusing an arbitrary order."""
    vals = [scores.get(n, 0.0) for n in names]
    lo, hi = (min(vals), max(vals)) if vals else (0.0, 0.0)
    if hi <= lo:
        return {n: 0.0 for n in names}
    return {n: (scores.get(n, 0.0) - lo) / (hi - lo) for n in names}


def _rank_map(scores, names):
    """name -> 0-based rank, best first. Ties break on name so the order is reproducible."""
    return {n: i for i, n in enumerate(sorted(names, key=lambda n: (-scores.get(n, 0.0), n)))}


MODES = ("hybrid", "vector", "lexical", "rrf")


def _check_mode(mode):
    """An unrecognised mode used to fall through every branch: cos={} and bm={} produced an
    all-zero fused score and an alphabetically ordered result set, so `--modes hybird` printed a
    plausible-looking row and a benchmark exited 0 on a typo. Fail loudly instead."""
    if mode not in MODES:
        raise ValueError(f"unknown ranking mode {mode!r}; expected one of {', '.join(MODES)}")


def _display_keys(dirs):
    """{display key: absolute path} across every searched corpus. A bare filename stays bare, so
    single-corpus output is unchanged; a filename that exists in two corpora is qualified with
    its store's slug, because "which of the two portal-project.md did you mean" has to be
    answerable from the printed line alone."""
    # Labels must be unique before they are used to disambiguate, or they disambiguate nothing.
    # Two corpora whose parent directories share a name -- a backup at
    # a backup copy beside the live store, the likeliest thing anyone would
    # actually add -- both resolve to the SAME parent-directory slug, so the qualified key collided and
    # the last writer silently won. That removed the primary's copy of EVERY shared filename
    # from search, which is the exact failure this qualification exists to prevent.
    labels, used = {}, {}
    for d in dirs:
        base = os.path.basename(os.path.dirname(d.rstrip("/\\"))) or os.path.basename(d) or d
        n = used.get(base, 0)
        used[base] = n + 1
        labels[d] = base if not n else f"{base}~{n + 1}"

    seen, keys = {}, {}
    for d in dirs:
        try:
            names = [n for n in os.listdir(d) if n.endswith(".md") and n not in EXCLUDE]
        except OSError:
            continue
        for n in names:
            seen.setdefault(n, []).append(d)
    for n, owners in seen.items():
        for d in owners:
            keys[n if len(owners) == 1 else f"{labels[d]}/{n}"] = os.path.join(d, n)
    return keys


def _retriever(mode):
    """rank()'s query-independent half, built only as far as the mode needs. "lexical" builds
    neither the vector cache nor the ONNX session, which is what makes --lexical-only a usable
    fallback on a box with no model rather than merely an A/B switch.

    Spans MEMORY_DIRS. Each corpus keeps its own recall_index.json in its own directory, so the
    per-file (mtime, size) contract src/recall-index.js reads is untouched; only the merged view
    is new."""
    _check_mode(mode)
    keys = _display_keys(MEMORY_DIRS)
    files = {}
    if mode != "lexical":
        for d in MEMORY_DIRS:
            sub = build_or_update(mem_dir=d)["files"]
            for key, path in keys.items():
                if os.path.dirname(path) == d.rstrip("/\\") and os.path.basename(path) in sub:
                    files[key] = sub[os.path.basename(path)]
    idx = {"embed": EMBED_ID, "files": files}
    names = sorted(files) if files else sorted(keys)
    lex = _lex_index({k: keys[k] for k in names if k in keys}) if mode != "vector" else None
    emb = _bge() if mode in ("hybrid", "vector", "rrf") else None
    return idx, lex, emb, names


def rank(query, k=6, mode="hybrid", idx=None, lex=None, emb=None, names=None):
    """The whole retriever with no printing -- what the eval harness imports and calls.

        "hybrid"   cosine and BM25, each min-max normalized per query, averaged at FUSE_W
        "vector"   cosine alone; the pre-hybrid ordering, kept as the A/B control
        "lexical"  BM25 alone; no ONNX session, no vector cache
        "rrf"      reciprocal rank fusion instead of min-max; the A/B for "hybrid"

    idx/lex/emb/names are the query-independent pieces. Pass them in to score many queries
    against one corpus: the ONNX session alone is ~264 ms (see _bge for the method), which is most
    of what a benchmark would otherwise be measuring. Returns the top k as dicts, best first;
    k=0 means all.
    """
    _check_mode(mode)
    if idx is None or names is None:
        idx, lex, emb, names = _retriever(mode)
    # A partial tuple used to degrade in silence: `lex` was never checked, so passing
    # idx+names with lex=None returned pure-vector ordering at exactly half score in
    # hybrid, and every score 0.0 in alphabetical order in lexical. That is the same
    # failure _check_mode above exists to prevent, reached through a different door.
    if lex is None and mode in ("hybrid", "lexical", "rrf"):
        raise ValueError(f"rank(mode={mode!r}) needs lex; pass all four parts or none")
    files = idx["files"]
    if not names:
        return []

    cos = {}
    if mode in ("hybrid", "vector", "rrf"):
        q = (emb or _bge()).embed(query)
        # One matrix multiply instead of a Python-level dot product per document. The
        # vectors are already lists and numpy is already imported, so this is the same
        # arithmetic in C. Immaterial for one CLI query, real across a bench run.
        hit = [n for n in names if n in files]
        if hit:
            mat = np.asarray([files[n]["vec"] for n in hit], dtype=np.float64)
            cos = dict(zip(hit, (mat @ np.asarray(q, dtype=np.float64)).tolist()))
    bm = _bm25(query, lex) if mode in ("hybrid", "lexical", "rrf") and lex else {}

    if mode == "vector":
        fused = cos
    elif mode == "lexical":
        top = max(bm.values()) if bm else 0.0
        fused = {n: bm.get(n, 0.0) / top for n in names} if top else {n: 0.0 for n in names}
    elif mode == "rrf":
        cr, lr = _rank_map(cos, names), _rank_map(bm, names)
        fused = {n: 1.0 / (RRF_K + 1 + cr[n]) + 1.0 / (RRF_K + 1 + lr[n]) for n in names}
    else:
        uc, ul = _unit(cos, names), _unit(bm, names)
        fused = {n: FUSE_W * uc[n] + (1.0 - FUSE_W) * ul[n] for n in names}

    order = sorted(names, key=lambda n: (-fused.get(n, 0.0), n))
    rv, rl = _rank_map(cos, names), _rank_map(bm, names)
    out = [{"name": n, "score": fused.get(n, 0.0),
            # In lexical mode idx["files"] is empty, so this used to print nothing at all.
            # lex["text"][n] already holds the raw file, so the description costs a parse
            # of text we are carrying anyway rather than a second read.
            "desc": (files.get(n, {}).get("desc")
                     or parse_meta((lex or {}).get("text", {}).get(n, ""))[0]),
            "cos": cos.get(n), "bm25": bm.get(n),
            # Both guards are per-DOCUMENT membership. rank_vec used to test `if cos`,
            # the truthiness of the whole per-query dict, so in hybrid a document with no
            # cached vector still received a rank while a document no query term touched
            # correctly received None. Two columns, two meanings, and the fusion bench
            # these exist for would have read them as comparable.
            "rank_vec": rv[n] + 1 if n in cos else None,
            "rank_lex": rl[n] + 1 if n in bm else None,
            "text": (lex or {}).get("text", {}).get(n)} for n in order]
    return out[:k] if k else out


def search(query, k, mode="hybrid"):
    idx, lex, emb, names = _retriever(mode)
    if not names:
        sys.exit("[recall] nothing indexed.")
    label = {"hybrid": "bge-small + BM25", "vector": "bge-small CPU",
             "lexical": "BM25 only, no model", "rrf": "bge-small + BM25, RRF"}[mode]
    print(f'\n  recall: "{query}"   ({label}, {len(names)} memories)\n')
    for r in rank(query, k, mode=mode, idx=idx, lex=lex, emb=emb, names=names):
        # A fused score is normalized per query, so it is comparable WITHIN a result set and not
        # across them. The cosine tail keeps the README's "~0.5+ is a real hit" calibration, and
        # every figure recorded before this change, readable.
        tail = ""
        if mode != "vector":
            bits = ([f"cos {r['cos']:.3f}"] if r["cos"] is not None else []) + \
                   ([f"lex {r['bm25']:.1f}"] if r["bm25"] is not None else [])
            tail = ("   " + "  ".join(bits)) if bits else ""
        print(f"  {r['score']:5.3f}  {r['name']}{tail}")
        if r["desc"]:
            print(f"         {r['desc'][:150]}")
        hit = best_line(query, r["name"], r["text"])
        if hit:
            print(f"         > {hit}")
        print()


def search_json(query, k, mode="hybrid"):
    """search() for a program, as one JSON object on stdout (2026-10-19). The Claude memory card's
    Search runs this and opens a result at its line, the way the Codex memory card's search
    already does. Each result names the file it came from, which a multi-store search needs
    (_display_keys), and the 1-based line its best excerpt sits on, or null when no line stood
    out. An empty corpus is an empty list, not an error: the card says so in its own words."""
    idx, lex, emb, names = _retriever(mode)
    keys = _display_keys(MEMORY_DIRS)
    results = []
    for r in (rank(query, k, mode=mode, idx=idx, lex=lex, emb=emb, names=names) if names else []):
        hit = best_line(query, r["name"], r["text"]) or ""
        line = None
        needle = hit.strip()
        if needle and r["text"]:
            for number, text in enumerate(r["text"].splitlines(), start=1):
                if needle in text:
                    line = number
                    break
        results.append({"name": r["name"], "path": keys.get(r["name"]), "description": r["desc"] or "",
                        "score": round(float(r["score"]), 4), "line": line, "excerpt": hit})
    json.dump({"query": query, "mode": mode, "memories": len(names), "results": results},
              sys.stdout, ensure_ascii=False)
    print()


def _norm(s):
    return s.strip().lower().replace("-", "_")


def _fm(text, key):
    """One frontmatter scalar. Shapes vary across the corpus -- some files nest under
    `metadata:`, older ones are flat -- so match the key at any indent instead of parsing
    YAML. `^\\s*type:` cannot collide with `node_type:`: only whitespace may precede it.

    The indent tolerance is the DESIGN, not an accident to be tightened later. It was once
    filed as a hazard -- "`scope: global` nested under `metadata:` compiles a gate nobody
    declared at the top level" -- which had the corpus exactly backwards. Measured
    2026-09-14: 16 of the 19 memories carrying `scope:` nest it under `metadata:`, and all 16
    of the currently compiled gates are among them, because that is the shape Claude Code's
    own memory writer emits. `type:` is nested in the same blocks. Requiring column 0 for
    either key would silently compile ZERO gates off the real corpus and break every fixture
    in test/recall-py.sh. Anchoring to the `---` block below is what keeps this safe.

    Scoped to the real `---` block rather than a byte window. It used to read text[:400], which
    cut mid-value: 6 files in the live corpus misread `type:` (5 as "", and one as "r"), so they
    escaped the lint's demotion check. 38 of 119 frontmatter blocks are already longer than 400
    chars and the longest is 9,664, so the cliff was going to reach `scope:` eventually, and a
    `scope:` that falls off it drops that memory out of the compiled gates in silence.

    Raising the cap instead would be wrong, not merely crude: this corpus contains memories that
    DOCUMENT gate syntax, so a whole-text search would match `scope: global` inside a fenced
    example and compile a gate nobody declared.
    """
    # Tolerate a UTF-8 BOM and leading blank lines before the fence. The byte-window version
    # this replaced scanned with re.MULTILINE and did not care where the fence sat; requiring it
    # at byte 0 reintroduced the same class of silent failure from the other side. Files are
    # opened as "utf-8", not "utf-8-sig", and PowerShell 5.1's `Out-File -Encoding utf8` writes
    # a BOM, so a memory edited by a PowerShell one-liner would drop out of the compiled gates
    # with nothing reporting it. No file in either live corpus has one today: this is a guard
    # against a regression, not a fix for a present breakage.
    m = re.search(rf'^\s*{key}:\s*(.+)$', _frontmatter_block(text), re.MULTILINE)
    return m.group(1).strip().strip('"').strip("'") if m else ""


def _frontmatter_block(text):
    """The text between a memory's `---` fences, or "" when it has none. _fm's scoping, shared
    with _gate_agents so the two keys are read from the same block."""
    head = text.lstrip("﻿ \t\r\n")
    if not head.startswith("---"):
        return ""
    end = head.find("\n---", 3)
    return head[3:end] if end != -1 else ""


# Every agent a gate memory can name in `agents:`, in the order the per-agent compile writes
# their sections (_compile_gates_text). src/agent-gates.js GATE_AGENTS is the same list.
GATE_AGENTS = ("claude", "codex")


def _uncomment(value):
    """A YAML value without its trailing comment: from the first `#` that follows whitespace."""
    for i in range(1, len(value)):
        if value[i] == "#" and value[i - 1].isspace():
            return value[:i]
    return value


def _gate_agents(text):
    """Which agents a gate memory is for: (agents, problem).

    `agents:` sits in the frontmatter at any indent, like `scope:` (nested under `metadata:` is
    the shape Claude Code's memory writer emits). Accepted values, case-insensitive: `codex`,
    `claude`, a flow list (`[codex]`, `[claude, codex]`), or a block list of `- name` lines
    under it. Absent or empty means every agent, which is what a gate meant before `agents:`
    was read at all.

    A declaration this cannot read is never guessed at. An unknown name, or two `agents:`
    lines, returns `problem` and no agents, and the compiler leaves that gate out for every
    agent: guessing "every agent" would put a Codex-only rule in CLAUDE.md, which is the one
    failure the key exists to prevent. --lint names each one.

    Python's whitespace throughout, and lines split on "\\n" only, because the text arrives
    through universal newlines. vscode-extension/memoryLint.js gateAgents is the same reading in
    JavaScript, held to this one by test/recall-py.sh over generated frontmatter."""
    lines = _frontmatter_block(text).split("\n")
    # `agents :` is still the key in YAML. Missing it would read as "absent", every agent.
    found = [i for i, line in enumerate(lines)
             if line.lstrip().startswith("agents") and line.lstrip()[6:].lstrip().startswith(":")]
    if not found:
        return GATE_AGENTS, None
    if len(found) > 1:
        return (), "more than one `agents:` line"
    line = lines[found[0]]
    rest = line.lstrip()
    indent = len(line) - len(rest)
    value = _uncomment(rest[6:].lstrip()[1:]).strip()
    if value:
        if value.startswith("[") and value.endswith("]"):
            value = value[1:-1]
        items = value.split(",")
    else:
        # A block list. Its items may sit at the key's own indent, which YAML allows, and a
        # comment line between them is skipped: stopping there read the list as empty, which
        # is every agent. A deeper line that is not an item is a value this cannot read (a
        # plain scalar continued onto the next line), so it is refused rather than taken as empty.
        items = []
        for below in lines[found[0] + 1:]:
            item = below.lstrip()
            if not item or item.startswith("#"):
                continue
            depth = len(below) - len(item)
            if depth >= indent and item[0] == "-" and (len(item) == 1 or item[1].isspace()):
                items.append(_uncomment(item[1:]))
                continue
            if depth > indent and not items:
                return (), "an `agents:` value on the line below it that is not a `- name` list"
            break
    names = [n for n in (i.strip().strip('"').strip("'").strip() for i in items) if n]
    if not names:
        return GATE_AGENTS, None
    unknown = [n for n in names if n.lower() not in GATE_AGENTS]
    if unknown:
        return (), "`agents:` names an agent this compiler does not know: " + ", ".join(unknown)
    wanted = {n.lower() for n in names}
    return tuple(a for a in GATE_AGENTS if a in wanted), None


def _strip_code(text):
    """Blank out fenced + inline code spans so example [[links]] written inside
    backticks (e.g. `[[...]]`) aren't counted as real wiki-links."""
    text = re.sub(r"```.*?```", " ", text, flags=re.DOTALL)
    text = re.sub(r"~~~.*?~~~", " ", text, flags=re.DOTALL)
    text = re.sub(r"``[^`]*``", " ", text)
    text = re.sub(r"`[^`]*`", " ", text)
    return text


# Fences as src/memory-index-guard.js spells them: spaces and tabs only, never `\s`, because
# Python's and JavaScript's `\s` are different sets (memoryLint.js PY_SPACE has the list).
# THE GUARD'S RULE (any indent, no info-string test). Twin: FENCE_OPEN and FENCE_CLOSE in
# src/memory-index-guard.js. Not _COMMONMARK_FENCE_OPEN below, which is deliberately different.
_GUARD_FENCE_OPEN = re.compile(r"^[ \t]*(`{3,}|~{3,})")
_GUARD_FENCE_CLOSE = re.compile(r"^[ \t]*(`{3,}|~{3,})[ \t]*$")


def _comment_defects(text):
    """Broken HTML comments in the index, as (line, kind) pairs, line 1-based: a `<!--` opened
    while a comment is already open ("nested", the first `-->` closes both and the text up to
    the next one leaks into every session), an "orphan" `-->`, and a `<!--` still open at the
    end ("unclosed", reported where it opened). Markers inside fenced code and inline code
    spans are examples and are skipped; inside an open comment nothing is code.

    A port of commentDefectList in src/memory-index-guard.js, the MEMORY.md guard, step for
    step, so the guard, this lint and the extension's gauge count the same defects.
    `text` must be read with newline="" so lines split at LF or CRLF only, as the guard's do."""
    defects, opened, fence = [], None, None
    for row, line in enumerate(re.split(r"\r?\n", text), 1):
        if opened is None:
            if fence:
                m = _GUARD_FENCE_CLOSE.match(line)
                if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence):
                    fence = None
                continue
            m = _GUARD_FENCE_OPEN.match(line)
            if m:
                fence = m.group(1)
                continue
        i = 0
        while i < len(line):
            if opened is not None:
                close, reopen = line.find("-->", i), line.find("<!--", i)
                if reopen != -1 and (close == -1 or reopen < close):
                    defects.append((row, "nested"))
                    i = reopen + 4
                    continue
                if close == -1:
                    break
                opened = None
                i = close + 3
                continue
            if line[i] == "`":
                run = 1
                while i + run < len(line) and line[i + run] == "`":
                    run += 1
                ticks = "`" * run
                end = line.find(ticks, i + run)
                # A closing run must be exactly as long as the opening one.
                while end != -1 and end + run < len(line) and line[end + run] == "`":
                    skip = run
                    while end + skip < len(line) and line[end + skip] == "`":
                        skip += 1
                    end = line.find(ticks, end + skip)
                i = i + run if end == -1 else end + run
                continue
            if line.startswith("<!--", i):
                opened = row
                i += 4
                continue
            if line.startswith("-->", i):
                defects.append((row, "orphan"))
                i += 3
                continue
            i += 1
    if opened is not None:
        defects.append((opened, "unclosed"))
    return defects


def lint():
    """Audit the always-loaded index for bloat and broken links. No model needed.

    Exits 0 whatever it finds, deliberately. It is a REPORTER, and its two harnesses
    (test/recall-py.sh, test/gates-stale.sh) read the exit status to tell "lint crashed"
    apart from "lint found something" -- both run lint over corpora seeded to be wrong.
    The release gate does not need the status either: scripts/verify-release.ps1 asserts
    each condition out of the text, line by line, which is stricter than one bit."""
    index = os.path.join(MEMORY_DIR, "MEMORY.md")
    if not os.path.exists(index):
        print(f"\n  no MEMORY.md at {index} -- nothing to lint\n")
        return
    mem = open(index, encoding="utf-8", errors="replace").read()
    # getsize, not len(mem.encode()). Python text mode normalises CRLF to LF, so the
    # encoded length undercounts by one byte per line against what is actually on disk:
    # 6564 against 6837 here. memoryLint.js measures the real file and so did not agree,
    # and the loader that enforces the 25 KB half of the cap reads bytes too.
    total = os.path.getsize(index)
    print(f'\n  MEMORY.md: {total} bytes (~{total // 4} tokens loaded every session), '
          f'target < {LINT_TOTAL_WARN}')
    # Bound to a name and carried down to the `clean:` verdict. Printing a `!` here and then
    # announcing "index within budget" at the bottom is the failure this whole file is about:
    # a summary line that asserts more than its condition tests.
    over_budget = total > LINT_TOTAL_WARN
    if over_budget:
        print(f"  ! index is {total - LINT_TOTAL_WARN} bytes over budget")
    print()

    valid, stems, meta, texts = set(), [], {}, {}
    for name in os.listdir(MEMORY_DIR):
        if not name.endswith(".md"):
            continue
        stem = name[:-3]
        stems.append(stem)
        text = open(os.path.join(MEMORY_DIR, name), encoding="utf-8", errors="replace").read()
        texts[stem] = text
        valid.add(_norm(stem)); valid.add(_norm(_fm(text, "name") or stem))
        # Frontmatter reads are scoped to the --- block, but a gate block can sit anywhere in
        # the body, so that one looks at the whole file. GATE_BLOCK, not `GATE_BEGIN in text`:
        # this answers "would the compiler take this file?", and the compiler needs the PAIR.
        meta[stem] = (_fm(text, "type"), _fm(text, "scope"), bool(GATE_BLOCK.search(text)))

    # The entries, lines, widths and comments, measured the way the MEMORY.md guard
    # (src/memory-index-guard.js) and vscode-extension/memoryLint.js measure them (2026-10-19):
    # read with newline="" so a line ends at LF or CRLF only, a trailing newline is not one more
    # line, a CR is not a character, and a width is code points, which is what len() counts.
    # test/memory-guard-parity.test.js runs this lint and the guard over the same fixtures.
    with open(index, encoding="utf-8", errors="replace", newline="") as handle:
        raw = handle.read()
    raw_lines = re.split(r"\r?\n", raw)
    if raw_lines and raw_lines[-1] == "":
        raw_lines.pop()

    # Over raw_lines, not `mem.splitlines()` (2026-10-20): `mem` is a universal-newline read, so
    # a lone CR already ended a line there, and splitlines() also ends one at \v, \f, \x1c-\x1e,
    # \x85, U+2028 and U+2029. The guard splits at LF or CRLF only, so "- a", a U+2028, then
    # "- b" was one entry to the hook that enforces the ceiling and two here.
    entries = [ln for ln in raw_lines if ln.startswith("- ")]
    print(f"  {len(entries)} resident index entries" +
          (f", target < {LINT_ENTRY_WARN}" if LINT_ENTRY_WARN else " (no ceiling set yet)"))
    over_ceiling = bool(LINT_ENTRY_WARN and len(entries) > LINT_ENTRY_WARN)
    if over_ceiling:
        print(f"  ! {len(entries) - LINT_ENTRY_WARN} entries over the attention ceiling")
    print()

    print(f"  {len(raw_lines)} lines, target {LINT_LINES_WARN} (Claude Code loads the first 200)")
    over_lines = len(raw_lines) > LINT_LINES_WARN
    if over_lines:
        print(f"  ! {len(raw_lines) - LINT_LINES_WARN} line(s) past the {LINT_LINES_WARN}-line target "
              f"-- each addition should now take a line out")
    print()

    # EVERY physical line, not only the "- " entries (2026-10-19): a 300-character heading or
    # note costs the same tokens and attention as a 300-character hook, and the guard counts it.
    over = []
    for i, ln in enumerate(raw_lines, 1):
        ln = ln.replace("\r", "")
        if len(ln) > LINT_LINE_WARN:
            over.append((len(ln), i, ln))
    if over:
        print(f"  {len(over)} index line(s) over {LINT_LINE_WARN} chars "
              f"-- move detail into the file/repo, leave a hook:")
        for length, i, ln in sorted(over, reverse=True):
            print(f"    {length:4d} ch  L{i}  {(ln[2:] if ln.startswith('- ') else ln)[:70]}...")
        print()

    # Claude Code strips HTML comments from the index, so a broken one is never seen where it is
    # written: a nested `<!--` leaks the rest of its comment into every session, and an
    # unclosed one hides everything after it. The defect that leaked a real index's header.
    comment_defects = _comment_defects(raw)
    if comment_defects:
        kinds = {"nested": "<!-- inside an open comment", "orphan": "--> with no comment open",
                 "unclosed": "<!-- never closed"}
        print(f"  ! {len(comment_defects)} broken HTML comment(s) in MEMORY.md -- Claude Code strips "
              f"comments, so each one leaks text into every session or hides it:")
        for row, kind in comment_defects:
            print(f"    L{row}  {kinds[kind]}")
        print()

    broken = sorted({t for t, _ in re.findall(r'\]\(([^)]+\.md)(#[^)]*)?\)', mem)
                     if not os.path.exists(os.path.join(MEMORY_DIR, t))})
    if broken:
        print("  index links to MISSING files:")
        for t in broken:
            print(f"    {t}")
        print()

    # Standing orders have to be resident: a gate you must remember to go look up never
    # fires, because nothing triggers the lookup. These two checks are what the gate
    # compiler needs before it can run unattended -- `scope:` says which instruction file a
    # rule belongs in, the gate block says which of its lines to lift out.
    feedback = sorted(s for s in stems if meta[s][0] == "feedback")
    no_scope = [s for s in feedback if not meta[s][1]]
    if no_scope:
        print("  type: feedback with no `scope:` -- compiler cannot place these:")
        for s in no_scope:
            print(f"    {s}")
        print()

    # The gate reports below describe what the COMPILER would do, and the compiler skips the
    # index unconditionally, so they have to skip it too. Split ONCE, here, rather than testing
    # the same rule in each report -- two copies of one rule is how the reports came to disagree
    # with the compiler in the first place. `stems` stays whole: the link resolver above still
    # has to know the index file exists.
    #
    # Left whole, both reports lie about MEMORY.md in opposite directions. A scope:global index
    # with no block is reported as a gate to go and write, which the compiler would then ignore;
    # an index with a block and no scope is reported as needing one, which would not help either.
    #
    # And splitting is still only half, because both are INVERSE conditions: an index carrying a
    # scope AND a correctly paired block satisfies neither and goes unmentioned whichever list
    # they are built from. That is the silent skip itself, and `index_gate` is what speaks to it.
    #
    # No live corpus reaches any of this: no MEMORY.md here carries frontmatter, and the lone
    # `<!-- gate -->` in the real index is unpaired prose describing this very pipeline. A
    # property of the data in a user-edited file, not of the code.
    # vscode-extension/memoryLint.js already skips the index, and records it as divergence #3.
    gateable, index_only = [], []
    for s in stems:
        (index_only if s + ".md" in EXCLUDE else gateable).append(s)

    # The compiler never lifts a block out of the index, so one written there is resident in
    # THIS project only -- never a standing order anywhere else, whatever its scope says.
    index_gate = [s for s in index_only if meta[s][2]]
    if index_gate:
        print(f"  {GATE_BEGIN} block inside the always-loaded index "
              f"-- resident here, never compiled for any other project:")
        for s in index_gate:
            print(f"    {s}.md  (move it to its own memory file)")
        print()

    no_gate = [s for s in gateable if meta[s][1] == "global" and not meta[s][2]]
    if no_gate:
        print(f"  scope: global with no {GATE_BEGIN} ... {GATE_END} block "
              f"-- resident-eligible, not compiled:")
        for s in no_gate:
            print(f"    {s}")
        print()

    # The inverse skip, and the one nothing reported. The compiler selects on `scope:`, so a
    # fully paired gate block in a file with no scope: line at all is written, looks compiled to
    # anyone reading the memory, and is dropped in silence. Live as this is written:
    # heredoc-eats-backslashes and xml-comments-reject-double-hyphen both carry a paired block,
    # both are type: reference with no scope:, and MEMORY.md lists the first as compiled.
    #
    # A non-global scope is NOT a finding -- `scope: ai-platform` belongs in that repo's
    # CLAUDE.local.md and is installed by hand, so --gates-compile skipping it is correct.
    # Only a block with nowhere to go is unplaceable, which is the same defect the feedback
    # `no_scope` report above names, reached from the gate side instead of the type side.
    gate_no_scope = [s for s in gateable if meta[s][2] and not meta[s][1]]
    if gate_no_scope:
        print(f"  {GATE_BEGIN} block with no `scope:` -- written, never compiled, "
              f"nowhere to place it:")
        for s in gate_no_scope:
            print(f"    {s}")
        print()

    # The compile, once, from the texts already read: the per-agent counts below, the gates it
    # left out, and the drift check further down all describe this one result.
    fresh_gates, gate_names, gate_agents, gate_excluded = _compile_gates_text(texts)

    # What each agent's instruction file gets (`agents:`, _gate_agents). A count, not a finding.
    if gate_names:
        print(f"  {len(gate_names)} gate memor{'y' if len(gate_names) == 1 else 'ies'} compile: "
              + ", ".join(f"{a} {len(gate_agents[a])}" for a in GATE_AGENTS))
        print()

    # A gate whose `agents:` cannot be read is left out for every agent rather than guessed at,
    # so it is a standing order that loads nowhere, and that is a finding with a fix.
    if gate_excluded:
        print("  gate memory whose `agents:` cannot be read -- left out for every agent, not compiled:")
        for name, problem in gate_excluded:
            print(f"    {name[:-3]}  ({problem})")
        print()

    # Gate memories in the OTHER stores, which never compile (see _other_store_gates). Worded
    # without the phrase "not compiled" on purpose: scripts/verify-release.ps1 fails its
    # "every standing order is compiled" check on that phrase, and a gate the user keeps in a
    # second store is the user's arrangement, not a defect in the release being verified. It
    # is still a finding here, and `clean:` below counts it, because the line names a fix.
    primary_bodies = set()
    for s in gateable:
        body = _gate_body(texts[s])
        if body is not None:
            primary_bodies.add(body)
    other_gates, other_unreadable = _other_store_gates(primary_bodies)
    if other_gates or other_unreadable:
        total_other = sum(n for _, n in other_gates)
        print(f"  {total_other} scope:global gate memor{'y' if total_other == 1 else 'ies'} in other "
              f"memory stores -- not installed, because only this")
        print("  store compiles. Move one into this store to install it, or point RECALL_MEMORY_DIR")
        print("  (the extension's memory.dir) at its store:")
        for slug, n in other_gates:
            print(f"    {slug}: {n}")
        for slug in other_unreadable:
            print(f"    {slug}: could not be read")
        print()

    # Reference material wearing a standing order's clothes. These only matter once you are
    # already on the subject, so they belong behind a recall query. Reported and never
    # acted on: demoting a memory with no trigger pointing at it makes it invisible rather
    # than merely quiet, and invisible is the one failure you cannot see happening.
    demote = []
    for ln in entries:
        m = re.search(r'\]\(([^)#]+)\.md', ln)
        if m and meta.get(m.group(1), ("",))[0] in ("project", "reference"):
            demote.append((meta[m.group(1)][0], m.group(1), len(ln) + 1))
    if demote:
        print(f"  {len(demote)} demotion candidate(s), ~{sum(n for _, _, n in demote)} bytes "
              f"-- lookup-on-demand, not standing orders:")
        for t, stem, n in sorted(demote, key=lambda r: -r[2])[:8]:
            print(f"    {n:4d} ch  {t:9s} {stem}")
        if len(demote) > 8:
            print(f"    ... and {len(demote) - 8} more")
        print()

    # Staleness against SOURCE, not against the compiled artifact. Editing the text inside a
    # gate block without recompiling leaves the resident CLAUDE.md block out of date, and
    # `--gates status` cannot see it: status compares installed to gates.generated.md, so
    # when both are stale together it reports "current". The extension's watcher recompiles
    # on edit, but a CLI-only user, or one with the extension closed, has no other signal.
    # This is the one place the source is compared to what a recompile would produce.
    stale_gates = _gates_are_stale(texts, fresh_gates)
    if stale_gates:
        print("  gates.generated.md is STALE: a gate block changed since the last compile.")
        # Both commands below REFUSE when the corpus compiles nothing, and neither
        # `wildcard-perms --gates refresh` nor the extension can forward --gates-allow-empty. So
        # advising them unconditionally sent a user who had legitimately deleted their last gate
        # into a loop: lint says run X, X refuses, refresh warns on every session forever. Name
        # the escape hatch in the one case where the ordinary advice cannot work.
        if not gate_names:
            print("    this corpus compiles ZERO gate blocks, so --gates-compile will REFUSE")
            print("    rather than erase what is installed. If that is a surprise, check")
            print("    RECALL_MEMORY_DIR: it is probably pointing at the wrong corpus. If you")
            print("    really did delete every gate, run:")
            print("      recall.py --gates-compile --gates-allow-empty\n")
        else:
            print("    run `recall.py --gates-compile` (or `wildcard-perms --gates refresh`) "
                  "to update it.\n")

    # Open threads (--threads-compile), from the texts already read: the count, then each memory
    # whose `status:` the compile leaves out or cuts. Every one of them names a fix, so each
    # counts against `clean:` below. Worded clear of the phrases scripts/verify-release.ps1
    # fails a release on.
    threads, thread_findings, thread_declared = _collect_threads(texts)
    if thread_declared:
        n = len(threads)
        print(f"  {n} open thread{'' if n == 1 else 's'} compile{'s' if n == 1 else ''} "
              f"(of {thread_declared} memor{'y' if thread_declared == 1 else 'ies'} declaring `status:`)")
        print()
    if thread_findings["duplicate"]:
        print("  memory with more than one `status:` line -- left out of the open threads:")
        for stem, _ in thread_findings["duplicate"]:
            print(f"    {stem}")
        print()
    if thread_findings["unknown"]:
        print(f"  `status:` value that is neither listed ({', '.join(THREAD_STATUSES)}) nor closed "
              f"({', '.join(THREAD_CLOSED)}) -- left out of the open threads:")
        for stem, value in thread_findings["unknown"]:
            print(f"    {stem}  ({value or 'empty'})")
        print()
    if thread_findings["no-block"]:
        print(f"  listed `status:` with no {STATUS_BEGIN} ... {STATUS_END} block outside code "
              f"-- left out of the open threads:")
        for stem, status in thread_findings["no-block"]:
            print(f"    {stem}  ({status})")
        print()
    if thread_findings["long"]:
        print(f"  status text longer than {THREAD_TEXT_CAP} characters -- cut with an ellipsis "
              f"in the open threads:")
        for stem, length in thread_findings["long"]:
            print(f"    {stem}  ({length} characters)")
        print()
    thread_problems = any(thread_findings.values())

    unresolved = sorted({l for l in re.findall(r'\[\[([^\]]+)\]\]',
                                               _strip_code(mem + "".join(texts.values())))
                         if _norm(l) not in valid})
    if unresolved:
        print("  unresolved [[links]] (typo, or a forward-link not written yet):")
        for l in unresolved:
            print(f"    [[{l}]]")
        print()

    # `demote` is deliberately NOT a condition here, though it is still printed
    # above. Every other finding is actionable -- over budget, a link to a missing
    # file, a feedback with no scope, a scope:global with no gate block, a gate
    # edited without a recompile -- and each names a fix. A demotion candidate
    # names none: the comment where it is collected says it is "Reported and never
    # acted on", because demoting a memory nothing points at makes it invisible
    # rather than quiet. Including it made `clean:` unreachable for any corpus
    # holding a single project or reference memory, which is every real one, and
    # it contradicted this very message -- which claims budget, links and standing
    # orders, and says nothing about residency advice.
    #
    # Everything else the run PRINTS is a condition, because this line names it. It used to
    # test five of eight: a 9,757-byte index, 24 entries over the attention ceiling and an
    # unresolved [[link]] all printed their warnings and then "clean: index within budget,
    # links resolve" printed underneath them. Three of the words in this sentence were
    # decorative. If a finding is worth a line above, it is worth a bit here -- and if it is
    # not (demote), the message must not claim it.
    #
    # over_lines and comment_defects joined 2026-10-19 with their checks, and the sentence names
    # what they test: the line target is part of "within budget", and "comments close" is new.
    if not (over_budget or over_ceiling or over_lines or over or broken or comment_defects or unresolved
            or no_scope or no_gate or gate_no_scope or index_gate or stale_gates
            or other_gates or other_unreadable or gate_excluded or thread_problems):
        print("  clean: index within budget, links resolve, comments close, every standing order compiled.\n")
    return texts


# normpath because expanduser substitutes a backslash HOME into a forward-slash literal and
# leaves the rest, producing `C:\Users\<user>/.claude/gates.generated.md`. It opens fine, but it
# is interpolated into the refusal messages below, where a mixed-separator path reads like a bug
# in the thing reporting the bug.
GATES_OUT = os.path.normpath(os.path.expanduser(r"~/.claude/gates.generated.md"))


def _installed_gate_bytes():
    """Size of the standing orders currently installed, or 0 if there are effectively none.

    `.strip()` matches readCompiled()'s definition of "compiled" in src/agent-gates.js, so this
    counts exactly what that installer would have treated as real content. Shared by the two
    refusal paths in compile_gates() so they cannot drift apart: both are the same hazard, which
    is a compile that produces nothing while something is already installed and live.

    Two reads, on purpose. The text decides whether there is CONTENT (blank-but-present is 0,
    which is what the installer's guard means by "nothing compiled"); getsize reports the SIZE.
    They are not the same number: text mode decodes UTF-8, so `len(text)` counts CHARACTERS and
    undercounts by one per continuation byte -- 5864 against a real 5872 on this box's gate file,
    from the em-dashes and arrows in the gate text. The name says bytes, the refusal string
    prints it at the user, and lint() had the identical unit error against MEMORY.md.
    """
    try:
        existing = open(GATES_OUT, encoding="utf-8", errors="replace").read()
        return os.path.getsize(GATES_OUT) if existing.strip() else 0
    except OSError:
        return 0


def _gate(text):
    """(body, agents, problem) for a memory that is a gate, or None: `scope: global` in the
    frontmatter plus a paired GATE_BLOCK, and _gate_agents' reading of `agents:`. The one
    selection rule, shared by the compiler, --lint, and --lint's census of the OTHER stores
    (through _gate_body), so no report can count a memory the compiler would skip, or skip one
    it would take. `problem` set means the compiler leaves the gate out for every agent."""
    if _fm(text, "scope") != "global":
        return None
    m = GATE_BLOCK.search(text)
    if not m:
        return None
    agents, problem = _gate_agents(text)
    return m.group(1).strip(), agents, problem


def _gate_body(text):
    """The gate block a memory contributes to the compile, stripped, or None. A gate whose
    `agents:` cannot be read contributes nothing, so the census does not count it either."""
    gate = _gate(text)
    return gate[0] if gate and gate[2] is None else None


# Gates in memory stores OTHER than MEMORY_DIR: reported, never compiled (the maintainer's
# decision, 2026-10-14). Discovery takes ONE store, the configured one or the largest, and a
# `scope: global` gate in any other store used to be ignored in silence: the second
# workstation's only real gate sat in its 41-file store while the 48-file store won. Compiling
# from every store is not the fix, for the reason _search_dirs records: a gate is a standing
# order, and a second corpus must not be able to install one silently. So --lint names each
# other store and how many gate memories it holds that are not installed, and the dashboard's
# gates card says the same (vscode-extension/memoryLint.js otherStoreGates).
#
# "Not installed" means the block's text is not one this store compiles. A store copied
# rather than moved holds the same gates as the primary, and counting those would report
# standing orders that ARE installed. Folder names only, never paths: the line can be pasted.
def _other_store_gates(primary_bodies):
    """([(folder, count)], [unreadable folder]) over ~/.claude/projects/*/memory, MEMORY_DIR
    excluded, counting memories whose gate block is not among `primary_bodies`."""
    root = os.path.expanduser(r"~/.claude/projects")
    try:
        slugs = sorted(os.listdir(root))
    except OSError:
        return [], []   # no projects dir, or one discovery has already warned about
    primary = os.path.normcase(os.path.abspath(MEMORY_DIR))
    found, unreadable = [], []
    for slug in slugs:
        store = os.path.join(root, slug, "memory")
        if not os.path.isdir(store) or os.path.normcase(os.path.abspath(store)) == primary:
            continue
        try:
            names = sorted(os.listdir(store))
        except OSError:
            unreadable.append(slug)
            continue
        count = 0
        for name in names:
            if not name.endswith(".md") or name in EXCLUDE:
                continue
            try:
                text = open(os.path.join(store, name), encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            body = _gate_body(text)
            if body is not None and body not in primary_bodies:
                count += 1
        if count:
            found.append((slug, count))
    return found, unreadable


def _render_gates(blocks):
    """One compiled gate set from [(name, body)]: the header with its sha, the count line, and
    the bodies. "" for no gates. This is the whole file when no gate names a subset of agents,
    byte for byte what every compile wrote before `agents:` was read, and it is each agent's
    section of a per-agent compile."""
    if not blocks:
        # No gates means "" (write NOTHING), not a header over an empty body. The installer's
        # "refuse to install an empty block" guard tests file content, and a file that always
        # carried a header would sail past it and fence off a heading with no rules under it.
        return ""
    body = "\n".join(b for _, b in blocks)
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]
    return (f"<!-- generated by recall.py --gates-compile; sha {digest} -->\n"
            f"## Standing gates ({len(blocks)} memories, managed)\n\n{body}\n")


def _compile_gates_text(texts=None):
    """The compiled gates file as bytes, WITHOUT writing it. Pure over the corpus, so both
    the compiler and the lint drift-check produce identical output from the same memories --
    which is the whole point: lint can ask "would a recompile change the file?" without a
    second, divergent implementation. Returns (text, [names], {agent: [names]}, [(name,
    problem)]): the file, every gate compiled, the gates each agent gets, and the gates left
    out because their `agents:` could not be read. text is "" for no gates.

    ONE FILE FOR EVERY AGENT, written by one os.replace (the per-agent gates design, 2026-10-14).
    When every gate is for every agent, which is every corpus with no `agents:` key, the file is
    _render_gates over all of them: the bytes this function wrote before, so every installed
    block stays byte-identical. When any gate names a subset, the file is a per-agent header
    giving each agent's section length in UTF-8 bytes, then each agent's _render_gates in
    GATE_AGENTS order, an agent with no gates contributing "". src/agent-gates.js
    compiledForAgents reads it in one read and checks every section against its own sha, so an
    install can never mix two compiles, and no per-agent file exists that could be left behind.
    The header begins as every compile does, so an installer with compiledIsWhole that predates
    it refuses the file as torn rather than installing every agent's text everywhere. One older
    than that (1.6.3 and earlier) checks nothing and would install it whole: run one version.

    Selected on scope, not type. Residency is a question of reach, and a `reference` can be
    every bit as resident-worthy as a `feedback` when its failure is silent -- a heredoc
    eating backslashes raises nothing, so no trigger ever fires. The gate block is the opt-in.
    Sorted by filename and hashed so a re-run is byte-identical.

    `texts` is an optional {stem: text} map for a caller that has already read the corpus.
    --lint reads every .md into exactly such a map and then called this twice, so the 123
    files were opened three times in one run for one answer. Passing the map keeps this
    function pure over the corpus, which is the property the drift check depends on: it
    still derives the answer from the same bytes, it just stops re-reading them."""
    blocks, excluded = [], []
    for name in sorted(os.listdir(MEMORY_DIR)):
        if not name.endswith(".md") or name in EXCLUDE:
            continue
        stem = name[:-3]
        text = (texts.get(stem) if texts is not None else None)
        if text is None:
            text = open(os.path.join(MEMORY_DIR, name), encoding="utf-8",
                        errors="replace").read()
        gate = _gate(text)
        if gate is None:
            continue
        body, agents, problem = gate
        if problem is not None:
            excluded.append((name, problem))
        else:
            blocks.append((name, body, agents))

    per_agent = {a: [name for name, _, agents in blocks if a in agents] for a in GATE_AGENTS}
    if all(agents == GATE_AGENTS for _, _, agents in blocks):
        out = _render_gates([(name, body) for name, body, _ in blocks])
    else:
        sections = [_render_gates([(name, body) for name, body, agents in blocks if a in agents])
                    for a in GATE_AGENTS]
        sizes = ", ".join(f"{a} {len(s.encode('utf-8'))}" for a, s in zip(GATE_AGENTS, sections))
        out = f"<!-- generated by recall.py --gates-compile; per agent: {sizes} -->\n" + "".join(sections)
    return out, [name for name, _, _ in blocks], per_agent, excluded


def _gates_are_stale(texts=None, fresh=None):
    """True when a recompile would change gates.generated.md -- i.e. someone edited a gate
    block in a memory, or moved one between agents, but never ran --gates-compile. This is the
    failure the whole feature exists to prevent, one level up: a standing order silently out of
    date. Only meaningful once gates have been compiled at least once, so a never-compiled
    corpus is not 'stale'. `fresh` is _compile_gates_text's text, for a caller that has it."""
    if not os.path.isdir(MEMORY_DIR) or not os.path.exists(GATES_OUT):
        return False
    if fresh is None:
        fresh = _compile_gates_text(texts)[0]
    on_disk = open(GATES_OUT, encoding="utf-8", errors="replace").read()
    return fresh != on_disk


def compile_gates(allow_empty=False):
    """Lift every scope:global gate block into one block for the installer to drop into
    CLAUDE.md, and write it. The judgement happened when the memory was written, which is
    what lets this run unattended."""
    # Discovery that could not read a store has not answered "which store", only "which of the
    # stores I could read". Compiling from that answer replaced the standing orders with the
    # next-largest store's, exit 0: reproduced in rampage (7139659) with one store denied by
    # icacls, where two gates became the other store's one and the only trace was a warning the
    # caller never showed. So refuse before anything is read or written. Search and --lint still
    # run on such a pick (they warn); a gate is a standing order. An explicit RECALL_MEMORY_DIR,
    # which is what the extension passes whenever it has a store, skips discovery entirely, and
    # an absent ~/.claude/projects is a fresh machine, not a read failure, so it is not recorded.
    # The extension's compileGates shows the first 300 chars of stderr; the discovery warning
    # printed above this line already names the store, and this line names it again.
    if _DISCOVERY_ERRORS:
        store, err = _DISCOVERY_ERRORS[0]
        more = f" and {len(_DISCOVERY_ERRORS) - 1} more" if len(_DISCOVERY_ERRORS) > 1 else ""
        sys.exit(f"[recall] refusing to compile gates: cannot read {os.path.normpath(store)} "
                 f"({type(err).__name__}){more}, so {MEMORY_DIR} may be the wrong store. Fix that, "
                 f"or set RECALL_MEMORY_DIR.")

    # A missing memory dir is a normal state (a fresh machine, a mocked HOME), not a crash.
    # This can run from a hook, where an unhandled traceback would land in the agent's face.
    #
    # But it is NOT normal when standing orders are already installed, and this returned 0 for
    # both cases. A typo'd RECALL_MEMORY_DIR therefore printed "nothing to compile" and exited
    # success, which bin/wildcard-perms reads as a clean compile and extension.js chains into
    # ensureGates() -- reinstalling stale bytes and reporting that it worked. Same hazard as an
    # empty compile, reached by a different door, so it gets the same test: a fresh machine has
    # nothing installed and stays a quiet no-op.
    if not os.path.isdir(MEMORY_DIR):
        installed = 0 if allow_empty else _installed_gate_bytes()
        if installed:
            sys.exit(f"[recall] no memory dir at {MEMORY_DIR}, but {GATES_OUT} holds "
                     f"{installed} bytes of standing orders. Check RECALL_MEMORY_DIR, or pass "
                     f"--gates-allow-empty to erase them.")
        print(f"\n  no memory dir at {MEMORY_DIR} -- nothing to compile\n")
        return

    out, names, per_agent, excluded = _compile_gates_text()

    # Refuse to replace a compiled file with nothing. A corpus that yields zero gates is
    # almost always RECALL_MEMORY_DIR pointing somewhere unintended, and the damage is
    # silent in every direction: agent-gates.js declines to install an empty block so
    # CLAUDE.md survives and looks fine, the dashboard's gate count reads 0, and
    # _gates_are_stale() then compares "" to "" and answers "not stale" -- the one
    # mechanism built to notice this goes quiet. Exiting non-zero is the point: both
    # callers (the extension's execFile and `wildcard-perms --gates refresh`) read the
    # status and surface stderr, and neither sees a `return`.
    #
    # The guard lives HERE, in the writer, and must not move into _compile_gates_text():
    # _gates_are_stale() shares that pure function, so a guard there would make staleness
    # lie about the very drift it exists to report, and would put a file read on the
    # normal path. `.strip()` matches readCompiled()'s definition of "compiled" in
    # src/agent-gates.js, so this refuses exactly when that would have installed something.
    if not names and not allow_empty:
        installed = _installed_gate_bytes()
        if installed:
            # Kept short on purpose: vscode-extension/extension.js:4338#slice cuts this stderr
            # to 300 chars before showing it (`#slice` is checked by scripts/check-line-refs.js;
            # this said :3013 until 2026-10-13, when .py comments were first scanned). Re-measured
            # 2026-09-14 after MEMORY_DIR was normpath'd and `installed` became a real byte count:
            # 226 here, and 228 for the sibling refusal above. Both still fit, and both still
            # name GATES_OUT and MEMORY_DIR inside the slice.
            # A corpus whose every gate was left out for its `agents:` says so, after the part
            # that has to fit, since "no gate blocks" alone would send the user to the wrong store.
            left_out = f" ({len(excluded)} left out for their `agents:`, see --lint)" if excluded else ""
            sys.exit(f"[recall] refusing to empty {GATES_OUT} ({installed} bytes): "
                     f"no gate blocks in {MEMORY_DIR}. Check RECALL_MEMORY_DIR, or pass "
                     f"--gates-allow-empty to erase every gate.{left_out}")

    # newline="\n" on purpose: a CRLF translation on Windows would change the bytes and
    # make the hash useless as a "has anything actually changed" signal.
    #
    # Through a pid-named temp and os.replace, as save_index writes the index (ported from
    # rampage 7139659). Written in place, a reader racing the write sees an empty or partial
    # file, and src/agent-gates.js turned an empty read into an empty gates block. Rampage
    # measured it 2026-10-08, two runs of a Node readFileSync loop against a writer looping
    # for 5 s: in place, 2,275 and 2,136 empty reads (27,369 and 14,423 EBUSY); replaced,
    # 14,485 and 8,526 whole reads and not one empty, partial or failed read.
    #
    # The retry is there because Windows will not replace a file another process holds open:
    # against that same reader a bare os.replace failed 1,849 and 1,724 of 2,000 times (WinError
    # 5). Same schedule as src/permissions.js writeFileAtomicSync, 10 attempts at 20..180 ms.
    # Unlike that writer there is NO in-place fallback, because writing in place is the bug. A
    # reader that never lets go still wins, and then this exits non-zero with the previous file
    # whole, which both callers already handle as a failed compile. _replace_file_text is that
    # write, shared with compile_threads() since 2026-10-19, unchanged.
    _replace_file_text(GATES_OUT, out)

    # On stderr, so `wildcard-perms --gates refresh` passes it through: a gate the user wrote
    # and the compile left out is a standing order that is not loading anywhere.
    for name, problem in excluded:
        print(f"[recall] gate left out for every agent: {name}: {problem}",
              file=sys.stderr)

    if not names:
        print(f"\n  no scope:global gate blocks found -- wrote 0 bytes to {GATES_OUT}")
        print("  (the installer will refuse rather than fence off an empty block)\n")
        return

    print(f"\n  compiled {len(names)} gate(s), {len(out)} bytes\n  -> {GATES_OUT}")
    print("  " + ", ".join(f"{a} {len(per_agent[a])}" for a in GATE_AGENTS) + "\n")
    for name in names:
        print(f"    {name}")
    print()


def _replace_file_text(path, text):
    """Write `text` to `path` through a pid-named temp and os.replace, retried 10 times at 20 to
    180 ms on PermissionError, with NO in-place fallback; on failure remove the temp and exit
    non-zero with the previous file whole. compile_gates()'s write (G1, ported from rampage
    7139659; the reasons are in its comment), lifted out on 2026-10-19 so compile_threads()
    writes the same way. The temp name, the schedule and the refusal text are what they were."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        for attempt in range(10):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                if attempt == 9:
                    raise
                time.sleep(0.02 * (attempt + 1))
    except OSError as e:
        try:
            os.remove(tmp)
        except OSError:
            pass
        sys.exit(f"[recall] could not write {path} ({type(e).__name__}: {e}); "
                 f"the previous file is unchanged.")


# --- open threads: --threads-compile ---------------------------------------------------------
#
# Added 2026-10-19. MEMORY.md is the one memory file Claude Code loads every session, and only its
# first 200 lines. It bloated because agents wrote STATUS on its index lines (10 of 15 lines
# demoted from the owner's index carried DONE, SHIPPED or AWAITING). Status gets its own home
# here: a memory declares `status:` in its frontmatter and says what is open in a paired
# `<!-- status -->` ... `<!-- /status -->` block, and this compiles the open ones into
# ~/.claude/open-threads.generated.md, which src/agent-open-threads.js installs into each agent's
# instruction file as a managed block, exactly as the gates are.
#
# Selection, primary store only, the index excluded (EXCLUDE):
#   * `status:` anywhere in the frontmatter, at any indent, like `scope:` and `agents:`, its
#     trailing `# comment` dropped (_uncomment). Two `status:` lines are refused, never guessed at.
#   * listed, case-insensitive: THREAD_STATUSES. Known closed: THREAD_CLOSED, silently not
#     listed. Any other value is a --lint finding and is not listed.
#   * a listed status needs its block: marker lines on their own, outside fenced code, so a
#     memory that documents this syntax in a code fence does not compile its example. A listed
#     status with no block is a finding and is not listed.
#
# The file also carries an INDEX line whenever MEMORY.md is past one of its budgets, because the
# MEMORY.md guard hook cannot run where a managed policy blocks user hooks, and this block is
# loaded in every session regardless. Not the 16-entry ceiling: that is a soft attention target,
# and a line for it would be printed forever.
#
# vscode-extension/memoryLint.js threadOf is this reading in JavaScript, for the dashboard's
# count; test/threads-compile.sh holds the two together over generated memories.
THREADS_OUT = os.path.normpath(os.path.expanduser(r"~/.claude/open-threads.generated.md"))
STATUS_BEGIN = "<!-- status -->"
STATUS_END = "<!-- /status -->"
THREAD_STATUSES = ("open", "awaiting", "blocked", "deferred")   # listed, in the block's order
THREAD_CLOSED = ("done", "closed", "live", "shelved", "deleted", "dropped", "shipped")
THREAD_TEXT_CAP = 240          # characters (code points) of one thread's text, ellipsis included
THREAD_LINES_CAP = 10          # thread lines in the block; the rest are counted on one line
ELLIPSIS = chr(0x2026)
BACKSLASH = chr(92)
# A marker line: up to three spaces of indent (four is an indented code block), the marker, then
# nothing but spaces or tabs. Fences are CommonMark's, cut down: up to three spaces, three or more
# backticks or tildes, a backtick opener's info string holding no backtick, and a closer of the
# same character at least as long with nothing after it but spaces or tabs. Unlike the managed
# block's reading (src/agent-guidance.js fencedSpans), an opener that never closes runs to the
# end of the file, as CommonMark has it: a status marker that might be an example is left out.
# THE COMMONMARK RULE. Twin: COMMONMARK_FENCE_OPEN and COMMONMARK_FENCE_CLOSE in
# vscode-extension/memoryLint.js. Not _GUARD_FENCE_OPEN above, the guard's any-indent rule.
_STATUS_MARK = re.compile(r" {0,3}(<!-- /?status -->)[ \t]*")
_COMMONMARK_FENCE_OPEN = re.compile(r" {0,3}(`{3,}|~{3,})(.*)")
_COMMONMARK_FENCE_CLOSE = re.compile(r" {0,3}(`{3,}|~{3,})[ \t]*")


def _status_of(text):
    """(value, problem) for a memory's `status:`: (None, None) when it declares none, (None,
    problem) for two `status:` lines, else the value with quotes and a trailing comment removed,
    not yet lowercased. `status :` is still the key, as `agents :` is (_gate_agents)."""
    found = [line for line in _frontmatter_block(text).split("\n")
             if line.lstrip().startswith("status") and line.lstrip()[6:].lstrip().startswith(":")]
    if not found:
        return None, None
    if len(found) > 1:
        return None, "more than one `status:` line"
    value = _uncomment(found[0].lstrip()[6:].lstrip()[1:])
    return value.strip().strip('"').strip("'").strip(), None


def _memory_body(text):
    """The text below a memory's closing `---` fence line, as _frontmatter_block finds it."""
    head = text.lstrip(chr(0xFEFF) + " \t\r\n")
    if not head.startswith("---"):
        return text
    end = head.find("\n---", 3)
    if end == -1:
        return ""
    below = head.find("\n", end + 4)
    return "" if below == -1 else head[below + 1:]


def _status_block(text):
    """The lines between the first paired status markers in the body, outside fenced code, joined
    with "\\n", or None. The last opening marker before the first closing one starts the block, as
    a managed block's range does (src/agent-guidance.js blockRange)."""
    start, fence = None, None
    lines = _memory_body(text).split("\n")
    for i, line in enumerate(lines):
        if fence is not None:
            m = _COMMONMARK_FENCE_CLOSE.fullmatch(line)
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= fence[1]:
                fence = None
            continue
        m = _COMMONMARK_FENCE_OPEN.fullmatch(line)
        if m and not (m.group(1)[0] == "`" and "`" in m.group(2)):
            fence = (m.group(1)[0], len(m.group(1)))
            continue
        m = _STATUS_MARK.fullmatch(line)
        if not m:
            continue
        if m.group(1) == STATUS_BEGIN:
            start = i
        elif start is not None:
            return "\n".join(lines[start + 1:i])
    return None


# Removed from thread text, the stem and the INDEX line's path before anything else (2026-10-20):
# the C0 and C1 controls and DEL that str.split() does not already treat as whitespace, and the
# bidirectional controls (ALM, LRM, RLM, the embeddings and overrides U+202A-U+202E, the isolates
# U+2066-U+2069), which can reorder how a line of CLAUDE.md or AGENTS.md reads. Code points, not
# escapes, so no writer can turn them into the characters themselves. memoryLint.js THREAD_STRIP is
# the same set, held to it by test/threads-compile.sh.
_THREAD_STRIP = dict.fromkeys([*range(0x00, 0x09), *range(0x0E, 0x1C), *range(0x7F, 0x85),
                               *range(0x86, 0xA0), 0x061C, 0x200E, 0x200F,
                               *range(0x202A, 0x202F), *range(0x2066, 0x206A)])


def _thread_text(raw):
    """One line of thread text: control and bidi characters removed (_THREAD_STRIP), whitespace
    collapsed, every `<!--` and `-->` neutralised (Claude Code strips HTML comments, so a stray one
    would swallow the lines after it), and a leading `#` escaped. Not capped: _cap does that, so
    --lint can say how long it was."""
    text = " ".join(raw.translate(_THREAD_STRIP).split()).replace("<!--", "&lt;!--").replace("-->", "--&gt;")
    return BACKSLASH + text if text.startswith("#") else text


def _cap(text):
    return text if len(text) <= THREAD_TEXT_CAP else text[:THREAD_TEXT_CAP - 1] + ELLIPSIS


def _thread(text):
    """What a memory is to the open threads, as (kind, status, detail):
      None                      no `status:` at all
      ("listed", status, text)  an open thread; `text` is _thread_text's, uncapped
      ("closed", status, None)  a known closed status, silently not listed
      ("duplicate", None, problem), ("unknown", value, None), ("no-block", status, None)
                                findings: --lint names each, and none is listed."""
    value, problem = _status_of(text)
    if problem is not None:
        return ("duplicate", None, problem)
    if value is None:
        return None
    status = value.lower()
    if status in THREAD_CLOSED:
        return ("closed", status, None)
    if status not in THREAD_STATUSES:
        return ("unknown", value, None)
    block = _status_block(text)
    if block is None:
        return ("no-block", status, None)
    return ("listed", status, _thread_text(block))


def _collect_threads(texts=None):
    """([(status, stem, text)], {kind: [(stem, detail)]}, declared) over MEMORY_DIR, the index
    excluded: the listed threads sorted by status (THREAD_STATUSES order) then stem, each finding
    by stem, and how many memories declare a `status:` at all. `texts` is lint()'s {stem: text}
    map. A memory that cannot be read refuses the compile rather than dropping its thread."""
    threads, declared = [], 0
    findings = {"duplicate": [], "unknown": [], "no-block": [], "long": []}
    for name in sorted(os.listdir(MEMORY_DIR)):
        if not name.endswith(".md") or name in EXCLUDE:
            continue
        stem = name[:-3]
        text = texts.get(stem) if texts is not None else None
        if text is None:
            try:
                text = open(os.path.join(MEMORY_DIR, name), encoding="utf-8", errors="replace").read()
            except OSError as e:
                sys.exit(f"[recall] refusing to compile open threads: cannot read "
                         f"{os.path.join(MEMORY_DIR, name)} ({type(e).__name__}); nothing was written.")
        found = _thread(text)
        if found is None:
            continue
        declared += 1
        kind, status, detail = found
        if kind == "listed":
            threads.append((status, stem, detail))
            if len(detail) > THREAD_TEXT_CAP:
                findings["long"].append((stem, len(detail)))
        elif kind == "duplicate":
            findings["duplicate"].append((stem, detail))
        elif kind in ("unknown", "no-block"):
            findings[kind].append((stem, status))
    threads.sort(key=lambda t: (THREAD_STATUSES.index(t[0]), t[1]))
    return threads, findings, declared


def _index_health():
    """Each budget MEMORY.md is past, as "<value> <unit> (budget <b>)" phrases, [] when it is
    within all three or there is none. Lines as `wc -l` and memoryLint.js fastLint count them
    (a final newline adds none); bytes on disk; the longest physical line in code points, its
    CRs excluded. An index that exists and cannot be read is warned about and skipped:
    the threads still compile."""
    index = os.path.join(MEMORY_DIR, "MEMORY.md")
    try:
        with open(index, "rb") as f:
            data = f.read()
    except FileNotFoundError:
        return []
    except OSError as e:
        print(f"[recall] cannot read {index} ({type(e).__name__}), so its health is left out "
              f"of the open threads", file=sys.stderr)
        return []
    lines = data.decode("utf-8", errors="replace").split("\n")
    if lines[-1] == "":
        lines.pop()
    # Every CR out, not only a trailing one (2026-10-20): the guard, the lint and memoryLint.js
    # all measure a line with its CRs removed, and a 300-character line holding one interior CR
    # read as 301 here, an INDEX line for a width the guard calls within budget.
    longest = max((len(line.replace("\r", "")) for line in lines), default=0)
    over = []
    if len(lines) > LINT_LINES_WARN:
        over.append(f"{len(lines)} lines (budget {LINT_LINES_WARN})")
    if len(data) > LINT_TOTAL_WARN:
        over.append(f"{len(data)} bytes (budget {LINT_TOTAL_WARN})")
    if longest > LINT_LINE_WARN:
        over.append(f"{longest} characters on its longest line (budget {LINT_LINE_WARN})")
    return over


def _home_relative(path):
    """`path` with forward slashes and the home directory written `~`, as the INDEX line names
    the index: the same on every OS, and no user name in a file every session loads. A path
    outside the home (another drive included) is written whole."""
    full = os.path.normpath(os.path.abspath(path))
    home = os.path.normpath(os.path.expanduser("~"))
    try:
        rel = os.path.relpath(full, home)
    except ValueError:
        rel = None
    if rel is None or rel == os.pardir or rel.startswith(os.pardir + os.sep) or os.path.isabs(rel):
        return full.replace(os.sep, "/")
    return "~/" + rel.replace(os.sep, "/")


def _compile_threads_text(texts=None):
    """(file text, threads, findings, health) without writing. The file is a header line holding
    the first 16 hex digits of the SHA-256 of everything below it, then `## Open threads (N,
    managed)` with N counting threads only, then the INDEX line when `health` has any phrase,
    then at most THREAD_LINES_CAP thread lines and one line counting the rest. With no thread and
    a healthy index it is the header and the heading alone: never an empty file, which a reader
    could not tell from a torn one."""
    threads, findings, _ = _collect_threads(texts)
    health = _index_health()
    clean = lambda s: (" ".join(s.translate(_THREAD_STRIP).split())
                       .replace("<!--", "&lt;!--").replace("-->", "--&gt;"))
    lines = []
    if health:
        # The index is NAMED (2026-10-20): this line reaches every session's CLAUDE.md and
        # AGENTS.md, in every project, and "MEMORY.md" alone let an agent elsewhere prune its own
        # healthy index.
        index = clean(_home_relative(os.path.join(MEMORY_DIR, "MEMORY.md")))
        lines.append(f"- **INDEX** {index} is {'; '.join(health)}: compact it before adding "
                     f"anything, and move detail into the memory files.")
    for status, stem, text in threads[:THREAD_LINES_CAP]:
        lines.append(f"- **{status.upper()}** {_cap(text)} ({clean(stem)})")
    more = len(threads) - THREAD_LINES_CAP
    if more > 0:
        lines.append(f"- +{more} more open thread{'' if more == 1 else 's'} (recall \"status\")")
    body = f"## Open threads ({len(threads)}, managed)\n" + "".join(line + "\n" for line in lines)
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]
    return (f"<!-- generated by recall.py --threads-compile; sha {digest} -->\n{body}",
            threads, findings, health)


def compile_threads():
    """--threads-compile: write THREADS_OUT from the primary store. Refuses, exit 1 with nothing
    written, when discovery could not read a store (compile_gates()' reason) or there is no memory
    dir. Unlike the gates there is no empty-compile refusal: zero threads and a healthy index is a
    real answer, and it is written as one, so a closed thread leaves the block."""
    if _DISCOVERY_ERRORS:
        store, err = _DISCOVERY_ERRORS[0]
        more = f" and {len(_DISCOVERY_ERRORS) - 1} more" if len(_DISCOVERY_ERRORS) > 1 else ""
        sys.exit(f"[recall] refusing to compile open threads: cannot read {os.path.normpath(store)} "
                 f"({type(err).__name__}){more}, so {MEMORY_DIR} may be the wrong store. Fix that, "
                 f"or set RECALL_MEMORY_DIR.")
    if not os.path.isdir(MEMORY_DIR):
        sys.exit(f"[recall] refusing to compile open threads: no memory dir at {MEMORY_DIR}; "
                 f"nothing was written.")
    try:
        out, threads, findings, health = _compile_threads_text()
    except OSError as e:
        sys.exit(f"[recall] refusing to compile open threads: cannot list {MEMORY_DIR} "
                 f"({type(e).__name__}); nothing was written.")
    # Written only when the bytes differ (2026-10-20). Every open VS Code window watches this file
    # and reinstalls on each change, and most recompiles change nothing, so an identical compile
    # leaves the file, its id and its mtime as they were.
    try:
        with open(THREADS_OUT, "rb") as f:
            unchanged = f.read() == out.encode("utf-8")
    except OSError:
        unchanged = False
    if not unchanged:
        _replace_file_text(THREADS_OUT, out)
    # On stderr, as the gates' are, so `wildcard-perms --open-threads refresh` passes them on.
    for stem, problem in findings["duplicate"]:
        print(f"[recall] open thread left out: {stem}.md: {problem}", file=sys.stderr)
    for stem, value in findings["unknown"]:
        print(f"[recall] open thread left out: {stem}.md: unknown status {value!r}", file=sys.stderr)
    for stem, status in findings["no-block"]:
        print(f"[recall] open thread left out: {stem}.md: status {status} with no "
              f"{STATUS_BEGIN} block", file=sys.stderr)
    print(f"\n  compiled {len(threads)} open thread(s)\n  -> {THREADS_OUT}{' (unchanged)' if unchanged else ''}")
    if health:
        print(f"  MEMORY.md: {'; '.join(health)}")
    print()


# --- one gate at a time: --gates-list, --gates-retire, --gates-restore ------------------------
#
# Ported from rampage e5c0ee7 (2026-10-09), adapted 2026-10-14. A gate is RETIRED by rewriting
# its memory's `scope: global` to `scope: retired`, and RESTORED by the reverse. Nothing else in
# the file changes, `agents:` included, and the memory stays in the store, so recall still finds
# it, while _gate() selects on scope == "global" and so simply stops compiling it. A retire is
# per memory, never per agent: moving a gate between agents is an edit of `agents:`, and the
# compile already removes it from the agent it left. A restored gate returns to the agents its
# `agents:` names, because that line was never touched.
#
# These verbs act on MEMORY_DIR alone, the one store that compiles (RECALL_MEMORY_DIR, which the
# extension pins from memory.dir or the largest store, else discovery's pick). The other stores
# --lint reports are never listed, retired or restored here. The verbs never compile: the caller
# (bin/wildcard-perms, the extension's gates panel) compiles next, which keeps the one refusal of
# an empty result where it already lives, in compile_gates().
#
# The memory folder is not version controlled, so a bad rewrite there has no undo. Every edit is
# preceded by a byte snapshot of the whole folder, and a snapshot that cannot be written stops the
# command before any memory is touched.
GATE_SCOPES = ("global", "retired")    # the only two states these verbs move a gate between
SNAPSHOT_KEEP = 30                      # snapshot dirs kept per store, counting the one just written
# Only names this code mints are ever pruned. AI_ACOLYTE_GATE_SNAPSHOT_DIR can point anywhere,
# and a looser match would make the prune an rmtree over whatever else lives in that directory.
SNAPSHOT_NAME = re.compile(r"^\d{8}T\d{6}Z-(?:retire|restore|retire\+restore)(?:-\d+)?$")


def _snapshot_root():
    # Beside the extension's other Claude-side state (~/.claude/wildcarding holds the policy lock,
    # the learner's state and the recall model), because the store being snapshotted is Claude
    # Code's. normpath for GATES_OUT's reason: the path is printed, and expanduser mixes separators.
    return os.path.normpath(os.environ.get("AI_ACOLYTE_GATE_SNAPSHOT_DIR")
                            or os.path.expanduser(r"~/.claude/wildcarding/gate-snapshots"))


def _gate_entry(name, text):
    """The --gates-list record for one memory, or None when it is not a gate these verbs manage.

    _fm, GATE_BLOCK and _gate_agents are the compiler's own, so "listed as active" and "compiled"
    are one test rather than two that happen to agree today. `state` is "active" exactly when
    _gate() would compile the memory for at least one agent, "excluded" for a scope:global gate
    whose `agents:` cannot be read (left out for every agent, so neither active nor retired), and
    "retired" for scope: retired. `agents` is _gate_agents' reading, for a retired gate the agents
    a restore returns it to; `problem` is its reason when it cannot be read."""
    scope = _fm(text, "scope")
    if scope not in GATE_SCOPES:
        return None
    m = GATE_BLOCK.search(text)
    if not m:
        return None
    agents, problem = _gate_agents(text)
    state = "retired" if scope == "retired" else ("active" if problem is None else "excluded")
    body = m.group(1).strip()
    first = next((ln for ln in body.splitlines() if ln.strip()), "")
    title = re.sub(r"^\s*[-*+]\s+", "", first).replace("**", "").strip()[:160].rstrip()
    return {"file": name, "scope": scope, "state": state, "agents": list(agents),
            "problem": problem, "title": title, "text": body,
            "description": _fm(text, "description")}


def _gate_files():
    """The files _compile_gates_text() walks, in its order: *.md in MEMORY_DIR, sorted by
    filename, the index skipped. One copy of that rule for the list and the edit verbs both."""
    return [n for n in sorted(os.listdir(MEMORY_DIR)) if n.endswith(".md") and n not in EXCLUDE]


def _gate_entries(texts=None):
    """Every scope:global or scope:retired gate in MEMORY_DIR, in compile order, each file read
    exactly as _compile_gates_text() reads it. `texts` is lint()'s {stem: text} map, when the
    caller has already read the store.

    An unreadable file exits rather than being skipped. A list that quietly left one out would
    show the gates panel a store with one standing order fewer than the compiler sees."""
    if not os.path.isdir(MEMORY_DIR):
        return []
    out = []
    for name in _gate_files():
        text = texts.get(name[:-3]) if texts is not None else None
        if text is None:
            try:
                text = open(os.path.join(MEMORY_DIR, name), encoding="utf-8", errors="replace").read()
            except OSError as e:
                sys.exit(f"[recall] cannot read {name} in {MEMORY_DIR} ({type(e).__name__}); "
                         f"a gate list without it would hide a gate.")
        entry = _gate_entry(name, text)
        if entry:
            out.append(entry)
    return out


def gates_list():
    """--gates-list: JSON for bin/wildcard-perms and the extension's gates panel. No model, no
    write. `store` is the one store that compiles; no other store is ever listed."""
    print(json.dumps({"store": MEMORY_DIR, "gates": _gate_entries()}, indent=2))


def _lint_retired(texts):
    """--lint's note on retired gates, from the texts lint() already read. main() prints it AFTER
    lint() returns, on purpose: a retired gate is a decision the owner made, not a finding, and
    living outside lint() keeps it out of the `clean:` condition by construction. Worded without
    the phrase "not compiled", which scripts/verify-release.ps1's standing-order check fails on."""
    retired = [g["file"][:-3] for g in _gate_entries(texts) if g["state"] == "retired"]
    if retired:
        print(f"  {len(retired)} retired gate memor{'y' if len(retired) == 1 else 'ies'} "
              f"(scope: retired), kept in the store and left out of the compile by choice: "
              f"{', '.join(retired)}\n")


def _as_compiler_reads(raw):
    """What `open(path, encoding="utf-8", errors="replace").read()` returns for these bytes: the
    same decoder and the same universal-newline translation. One read of the bytes then serves
    both the rewrite and the _fm check of what the rewrite produced."""
    import io
    return io.TextIOWrapper(io.BytesIO(raw), encoding="utf-8", errors="replace").read()


def _rescope(raw, want):
    """`raw` with the scope VALUE on the line _fm reads replaced by `want`, every other byte kept:
    a BOM, CRLF or LF, the indentation of a key nested under `metadata:`, the quotes (`"global"`
    becomes `"retired"`), any spaces after the value, and every other key, `agents:` among them.
    None when there is no such line.

    The search mirrors _fm over the file with its own line endings intact, decoded with
    surrogateescape so every byte round-trips. The value stops at a CR as well as a LF, because the
    compiler's reader ends a line at a lone CR. Not trusted alone: _change_gate_scopes() requires
    _fm to read the new value back, and this to turn the result back into exactly `raw`, so a
    disagreement refuses instead of rewriting some other `scope:` line or any other byte."""
    s = raw.decode("utf-8", errors="surrogateescape")
    lead = len(s) - len(s.lstrip(chr(0xFEFF) + " \t\r\n"))
    head = s[lead:]
    if not head.startswith("---"):
        return None
    end = head.find("\n---", 3)
    if end == -1:
        return None
    m = re.search(r'^\s*scope:\s*([^\r\n]+)', head[3:end], re.MULTILINE)
    if not m:
        return None
    a, b = m.span(1)
    v = m.group(1)
    for chars in (None, '"', "'"):     # _fm's .strip().strip('"').strip("'"), kept as a span
        t = v.lstrip(chars)
        a, v = a + len(v) - len(t), t
        t = v.rstrip(chars)
        b, v = b - (len(v) - len(t)), t
    a, b = a + lead + 3, b + lead + 3
    return (s[:a] + want + s[b:]).encode("utf-8", errors="surrogateescape")


def _write_bytes_atomic(path, data, expect):
    """compile_gates()'s write, for a memory file: a pid-named temp beside it, then os.replace,
    with the same retry for a Windows reader that holds the file open. Before every retry the file
    is read again and must still hold `expect`, the bytes the caller checked: that reader may have
    saved an edit while this waited, and the replace would erase it. The temp takes the original's
    mode, so a 0600 memory is not widened. Any failure removes the temp and raises."""
    import shutil
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        shutil.copymode(path, tmp)
        for attempt in range(10):
            if attempt:
                time.sleep(0.02 * attempt)
                _require_bytes(path, expect)
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                if attempt == 9:
                    raise
    except OSError:
        _remove_temp(tmp)
        raise


def _write_snapshot(op, expected):
    """Byte copies of every *.md in MEMORY_DIR, and manifest.json, in a new directory under
    _snapshot_root(). Returns that directory, or exits having removed it.

    `expected` maps each file about to change to the bytes that were validated. The snapshot must
    hold exactly those, or it is not the before-image of the edit it exists to undo, so a file
    that changed in between refuses the command here. Every copy is read back and hashed before
    the manifest is written: the manifest's presence means the copies beside it are whole."""
    import datetime, shutil
    root = _snapshot_root()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    snap, why = None, None
    try:
        os.makedirs(root, exist_ok=True)
        for n in range(1, 100):            # two runs inside one second must not share a dir
            candidate = os.path.join(root, f"{stamp}-{op}" + (f"-{n}" if n > 1 else ""))
            try:
                os.mkdir(candidate)
            except FileExistsError:
                continue
            snap = candidate
            break
        if snap is None:
            raise FileExistsError(f"99 snapshot dirs already named {stamp}-{op}")
        files = {}
        for name in sorted(os.listdir(MEMORY_DIR)):
            src = os.path.join(MEMORY_DIR, name)
            if not name.endswith(".md") or not os.path.isfile(src):
                continue
            with open(src, "rb") as f:
                data = f.read()
            with open(os.path.join(snap, name), "wb") as f:
                f.write(data)
            files[name] = hashlib.sha256(data).hexdigest()
        moved = [n for n, raw in expected.items() if files.get(n) != hashlib.sha256(raw).hexdigest()]
        if moved:
            why = f"{', '.join(moved)} changed while this command ran; run it again"
        else:
            for name, digest in files.items():
                with open(os.path.join(snap, name), "rb") as f:
                    if hashlib.sha256(f.read()).hexdigest() != digest:
                        raise OSError(f"the copy of {name} did not read back intact")
            with open(os.path.join(snap, "manifest.json"), "w", encoding="utf-8", newline="\n") as f:
                json.dump({"op": op, "store": MEMORY_DIR, "changed": list(expected),
                           "files": files}, f, indent=2)
                f.write("\n")
    except OSError as e:
        why = f"the snapshot could not be written ({type(e).__name__}: {e})"
    if why:
        if snap:
            shutil.rmtree(snap, ignore_errors=True)
        sys.exit(f"[recall] refusing to change any gate: {why}. Nothing was written to {MEMORY_DIR}.")
    return snap


def _prune_snapshots(snap):
    """Keep the newest SNAPSHOT_KEEP snapshots OF THIS STORE, counting `snap` (the one just
    written), and never remove `snap` itself, even when a clock that went backwards sorts it
    oldest. Newest is by name, which leads with the UTC stamp, and the oldest go first. A dir that
    cannot be removed is reported and kept: the snapshot guarding this run is already whole, so the
    prune is housekeeping, not a gate.

    Only a dir this code wrote is a candidate: a SNAPSHOT_NAME name AND a manifest that names
    MEMORY_DIR (_snapshot_of_this_store). The name alone once let a hand-made dir with that shape
    be deleted, and let 30 edits to one store delete another store's only before-image, because the
    default root is shared by every store. Every dir this code leaves behind carries a manifest:
    one whose snapshot failed is removed (_write_snapshot). A FILE with a snapshot's name has no
    manifest to read, so the same test keeps it out."""
    import shutil
    root, mine = os.path.split(snap)
    try:
        old = sorted((n for n in os.listdir(root)
                      if n != mine and SNAPSHOT_NAME.match(n)
                      and not os.path.islink(os.path.join(root, n))), reverse=True)
    except OSError as e:
        print(f"[recall] could not list {root} to prune old snapshots ({type(e).__name__}); "
              f"none were removed.", file=sys.stderr)
        return
    old = [n for n in old if _snapshot_of_this_store(os.path.join(root, n))]
    for n in reversed(old[SNAPSHOT_KEEP - 1:]):
        try:
            shutil.rmtree(os.path.join(root, n))
        except OSError as e:
            print(f"[recall] could not prune old snapshot {n} ({type(e).__name__}: {e}); it is kept.",
                  file=sys.stderr)


def _snapshot_of_this_store(d):
    """True when `d` holds a manifest.json that _write_snapshot could have written for MEMORY_DIR:
    a JSON object whose `op` is one of the three and whose `store` is MEMORY_DIR, both spellings
    normalised (normpath and normcase), so a drive letter's case or a trailing separator does not
    matter. Anything else, unreadable, malformed or another store's, is not this store's to prune."""
    try:
        with open(os.path.join(d, "manifest.json"), encoding="utf-8") as f:
            man = json.load(f)
    except (OSError, ValueError):
        return False
    return (isinstance(man, dict) and man.get("op") in ("retire", "restore", "retire+restore")
            and isinstance(man.get("store"), str)
            and os.path.normcase(os.path.normpath(man["store"])) == os.path.normcase(MEMORY_DIR))


def change_gate_scopes(retire=(), restore=()):
    """--gates-retire and --gates-restore, together or apart.

    Every name is validated before anything is written, then one snapshot, then one in-place
    rewrite per file, each re-read and compared with the bytes that were validated and
    snapshotted immediately before its own write. Never compiles. Prints `snapshot <dir>`, then
    `retired <file>` or `restored <file>` per file. A refusal exits 1 having written nothing; a
    failure part way through puts back the files already rewritten, so the caller's rule "an edit
    failure means nothing changed" holds, and says so loudly in the one case where it cannot.

    The whole read-decide-write runs under the gate-edit lock (_take_gate_lock). Without it, two
    runs at once interleaved: one run's put-back reverted a file the other had just reported as
    retired, measured by rampage in 1 of 25 trials of two real processes. A second edit now
    refuses instead."""
    owner = _take_gate_lock()
    try:
        _change_gate_scopes(retire, restore)
    finally:
        _drop_gate_lock(owner)


def _change_gate_scopes(retire, restore):
    """change_gate_scopes()'s body, run while it holds the gate-edit lock."""
    # compile_gates()'s refusal, for its reason: discovery that could not read a store may have
    # picked the wrong one, and this edits standing orders just as surely as compiling does.
    if _DISCOVERY_ERRORS:
        store, err = _DISCOVERY_ERRORS[0]
        sys.exit(f"[recall] refusing to change any gate: cannot read {os.path.normpath(store)} "
                 f"({type(err).__name__}), so {MEMORY_DIR} may be the wrong store. Fix that, "
                 f"or set RECALL_MEMORY_DIR.")
    if not os.path.isdir(MEMORY_DIR):
        sys.exit(f"[recall] refusing to change any gate: no memory dir at {MEMORY_DIR}.")

    def named(names):                  # with or without .md; a repeat is the same request
        out = []
        for n in names:
            n = n if n.endswith(".md") else n + ".md"
            if n not in out:
                out.append(n)
        return out

    wanted = ([("retire", n, "global", "retired") for n in named(retire)] +
              [("restore", n, "retired", "global") for n in named(restore)])
    both = set(named(retire)) & set(named(restore))
    present, walked = set(os.listdir(MEMORY_DIR)), set(_gate_files())
    plan, problems = [], []
    for verb, name, have, want in wanted:
        why, raw, new = None, None, None
        if name in both:
            if verb == "restore":
                continue                       # reported once, under retire
            why = "named in both --gates-retire and --gates-restore"
        elif os.path.basename(name) != name:
            why = "is a path; name a memory file in the store"
        elif name not in present:              # exact spelling: the output names what it changed
            why = f"no such memory in {MEMORY_DIR}"
        elif name not in walked:               # present and *.md, so the one file the walk skips
            why = "is the index, which is never compiled"
        elif (link := _link_problem(os.path.join(MEMORY_DIR, name))):
            why = link
        else:
            try:
                with open(os.path.join(MEMORY_DIR, name), "rb") as f:
                    raw = f.read()
            except OSError as e:
                why = f"cannot be read ({type(e).__name__})"
            else:
                text = _as_compiler_reads(raw)
                scope = _fm(text, "scope")
                new = _rescope(raw, want)
                if not GATE_BLOCK.search(text):
                    why = f"holds no {GATE_BEGIN} ... {GATE_END} block, so it is not a gate"
                elif scope == want:
                    # "scope: global", not "active": a scope:global gate whose `agents:` cannot be
                    # read compiles for no agent, and is still not one a restore can change.
                    why = ("is already retired (scope: retired)" if want == "retired"
                           else "is already scope: global, not retired")
                elif scope != have:
                    why = (f"has scope: {scope}; only a scope: {have} gate can be {verb}d" if scope
                           else f"has no scope: line; only a scope: {have} gate can be {verb}d")
                elif new is None or _fm(_as_compiler_reads(new), "scope") != want:
                    why = ("its scope: line could not be located the way the compiler reads it; "
                           "edit it by hand")
                elif _rescope(new, have) != raw:
                    # The backstop for _rescope itself: the edit must be exactly reversible, so a
                    # span that ran past the value (a lone CR once let it eat the next key) refuses.
                    why = "rewriting its scope: value would change other bytes too; edit it by hand"
                else:
                    why = _acl_problem(os.path.join(MEMORY_DIR, name))
        if why:
            problems.append(f"  {name}: {why}")
        else:
            plan.append((verb, name, raw, new))
    if problems:
        sys.exit("[recall] refusing to change any gate; nothing was written:\n" + "\n".join(problems))

    op = "+".join(v for v in ("retire", "restore") if any(p[0] == v for p in plan))
    snap = _write_snapshot(op, {name: raw for _, name, raw, _ in plan})
    print(f"snapshot {snap}", flush=True)
    _prune_snapshots(snap)

    done, why = [], None
    for verb, name, raw, new in plan:
        path = os.path.join(MEMORY_DIR, name)
        try:
            with open(path, "rb") as f:
                if f.read() != raw:
                    why = f"{name} changed after it was snapshotted"
                    break
            _write_bytes_atomic(path, new, raw)
        except OSError as e:
            why = f"{name} could not be written ({type(e).__name__}: {e})"
            break
        done.append((name, raw, new))
    if why:
        # Put back what this run rewrote, newest first, but only a file still holding the bytes
        # this run wrote: anything else was edited by someone after us, and is theirs to keep.
        stuck = []
        for name, raw, new in reversed(done):
            path = os.path.join(MEMORY_DIR, name)
            try:
                with open(path, "rb") as f:
                    if f.read() != new:
                        raise OSError("it changed again after this run wrote it")
                _write_bytes_atomic(path, raw, new)
            except OSError:
                stuck.append(name)
        if stuck:
            # The per-file lines are the record of what this run WROTE (bin/wildcard-perms and the
            # extension read them whatever the exit status), so a file left changed is named
            # there too, not only here.
            for verb, name, _, _ in plan:
                if name in stuck:
                    print(f"{'retired' if verb == 'retire' else 'restored'} {name}")
            sys.exit(f"[recall] stopped part way: {why}. {', '.join(stuck)} could NOT be put back "
                     f"and still differ from the snapshot at {snap}; copy them back from there.")
        undone = f" ({len(done)} file(s) already rewritten were put back)" if done else ""
        sys.exit(f"[recall] stopped: {why}. Nothing was changed{undone}; the snapshot is at {snap}.")
    for verb, name, _, _ in plan:
        print(f"{'retired' if verb == 'retire' else 'restored'} {name}")


def _require_bytes(path, expect):
    """Raise OSError unless `path` holds exactly `expect`; _write_bytes_atomic asks before every
    retry. A read that fails raises too: a file this cannot see is not one to replace blind."""
    with open(path, "rb") as f:
        if f.read() != expect:
            raise OSError("it changed while waiting to replace it")


def _remove_temp(tmp):
    """Remove a temp _write_bytes_atomic made. copymode gave it the memory's mode, and on Windows
    the temp of a read-only memory is read-only too, so os.remove failed and the temp, holding the
    rewritten text, stayed in the store while the run said nothing was changed. The write bit goes
    back on first. Best effort, because the caller is already raising."""
    import stat
    try:
        os.chmod(tmp, stat.S_IREAD | stat.S_IWRITE)
    except OSError:
        pass
    try:
        os.remove(tmp)
    except OSError:
        pass


def _link_problem(path):
    """Why the memory at `path` must not be rewritten because it is a link, or None.

    os.replace swaps the NAME for a new file. A symbolic link or a junction became a plain copy
    holding the new scope while its target kept the old one, and a hard link would be split from
    its other names; a snapshot holds bytes only, so neither can be put back from it. So a name
    whose real path is not the store's own entry for it (realpath resolves symlinks and junctions
    alike) is refused, and so is a file with more than one name. A store that is itself a link is
    fine: the file and the temp beside it are then both in the real directory."""
    own = os.path.join(os.path.realpath(MEMORY_DIR), os.path.basename(path))
    if os.path.normcase(os.path.realpath(path)) != os.path.normcase(own):
        return ("is a symbolic link or junction, so a rewrite would replace the link with a copy "
                "and leave its target as it was; edit the target by hand")
    try:
        links = os.lstat(path).st_nlink
    except OSError:
        return None                       # the read that follows names the failure
    if links > 1:
        return f"has {links} hard links, so a rewrite would split it from the others; edit it by hand"
    return None


def _acl_problem(path):
    """Why the memory at `path` must not be rewritten because of its access rules, or None.

    A rewrite is a new file, and on Windows a new file takes the folder's inherited ACL. A memory
    whose ACL was set by hand (inheritance cut off, or an entry granted or denied on the file
    itself) lost it without a word: one user's Modify became the folder's SYSTEM, Administrators
    and OWNER RIGHTS. Such a memory is refused. One holding only inherited entries, which is what
    Git Bash, a heredoc, Node and Python all write (measured by rampage 2026-10-09), gets the same
    ACL back. Rules that cannot be read refuse too. POSIX keeps the mode through copymode, and a
    volume that stores no ACLs (FAT, exFAT) has none to lose, so neither is checked."""
    if os.name != "nt" or not _volume_keeps_acls(path):
        return None
    import ctypes
    from ctypes import wintypes

    class Acl(ctypes.Structure):
        _fields_ = [("rev", ctypes.c_ubyte), ("sbz1", ctypes.c_ubyte), ("size", wintypes.WORD),
                    ("count", wintypes.WORD), ("sbz2", wintypes.WORD)]

    class AceHeader(ctypes.Structure):
        _fields_ = [("type", ctypes.c_ubyte), ("flags", ctypes.c_ubyte), ("size", wintypes.WORD)]

    P = ctypes.c_void_p
    advapi, kernel = ctypes.WinDLL("advapi32"), ctypes.WinDLL("kernel32")   # own instances: no
    get_info = advapi.GetNamedSecurityInfoW                                 # shared argtypes
    get_info.argtypes = [wintypes.LPCWSTR, ctypes.c_int, wintypes.DWORD, P, P,
                         ctypes.POINTER(P), P, ctypes.POINTER(P)]
    get_info.restype = wintypes.DWORD
    get_control = advapi.GetSecurityDescriptorControl
    get_control.argtypes = [P, ctypes.POINTER(wintypes.WORD), ctypes.POINTER(wintypes.DWORD)]
    get_control.restype = wintypes.BOOL
    get_ace = advapi.GetAce
    get_ace.argtypes = [P, wintypes.DWORD, ctypes.POINTER(P)]
    get_ace.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [P]
    kernel.LocalFree.restype = P
    sd, dacl, control, revision = P(), P(), wintypes.WORD(), wintypes.DWORD()
    # SE_FILE_OBJECT is 1, DACL_SECURITY_INFORMATION is 4.
    err = get_info(path, 1, 4, None, None, ctypes.byref(dacl), None, ctypes.byref(sd))
    if err:
        return f"its access rules (ACL) could not be read (Windows error {err}); edit it by hand"
    try:
        own = (not dacl.value                     # a NULL DACL grants everyone: set on purpose
               or not get_control(sd, ctypes.byref(control), ctypes.byref(revision))
               or bool(control.value & 0x1000))   # SE_DACL_PROTECTED: inheritance cut off
        for i in range(0 if own else ctypes.cast(dacl, ctypes.POINTER(Acl)).contents.count):
            ace = P()
            if (not get_ace(dacl, i, ctypes.byref(ace))
                    or not ctypes.cast(ace, ctypes.POINTER(AceHeader)).contents.flags & 0x10):
                own = True                        # not INHERITED_ACE: an entry set on the file
                break
    finally:
        kernel.LocalFree(sd)
    return ("has access rules of its own (an ACL set on the file), which a rewrite would replace "
            "with the folder's; edit it by hand" if own else None)


def _volume_keeps_acls(path):
    """False only when Windows says the volume holding `path` stores no ACLs. Any failure to ask
    answers True, so the ACL is then checked rather than assumed absent."""
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32")
    kernel.GetVolumePathNameW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    kernel.GetVolumePathNameW.restype = wintypes.BOOL
    D = ctypes.POINTER(wintypes.DWORD)
    kernel.GetVolumeInformationW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD,
                                             D, D, D, wintypes.LPWSTR, wintypes.DWORD]
    kernel.GetVolumeInformationW.restype = wintypes.BOOL
    root, flags = ctypes.create_unicode_buffer(1024), wintypes.DWORD()
    if not (kernel.GetVolumePathNameW(path, root, len(root)) and
            kernel.GetVolumeInformationW(root.value, None, 0, None, None, ctypes.byref(flags), None, 0)):
        return True
    return bool(flags.value & 0x8)                # FILE_PERSISTENT_ACLS


# The gate-edit lock: one O_EXCL file in ~/.claude/wildcarding, held across a whole retire or
# restore, so two edits never interleave whichever process started them (the CLI, the extension's
# gates panel, a shell). It follows the instruction lock in src/policy-lock.js: created with
# O_EXCL, never waited on (a second edit is told to run again), released only by its owner, and
# reclaimed once it is older than the stale window. Age alone decides staleness, never the pid in
# it: a pid that answers after a crash is usually a reused one, and on Windows os.kill(pid, 0)
# does not probe a process, it terminates it. The work under the lock is a snapshot of one store
# and a handful of small writes, so thirty seconds is generous.
GATE_LOCK_STALE_S = 30


def _gate_lock_path():
    return os.path.normpath(os.path.expanduser(r"~/.claude/wildcarding/gates-edit.lock"))


def _take_gate_lock():
    """Create the gate-edit lock and return this run's owner token, or exit 1 having written
    nothing to any store. A lock older than GATE_LOCK_STALE_S is reclaimed once."""
    path = _gate_lock_path()
    owner = os.urandom(16).hex()
    stop = "[recall] refusing to change any gate:"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
    except OSError as e:
        sys.exit(f"{stop} cannot create {os.path.dirname(path)} for the gate-edit lock "
                 f"({type(e).__name__}). Nothing was written.")
    for attempt in range(2):
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0),
                         0o600)
        except (FileExistsError, PermissionError) as e:
            # PermissionError is a busy lock too: on Windows a lock its holder has just removed
            # stays delete-pending until the last handle closes, and creating it then fails so.
            if attempt == 0 and _reclaim_gate_lock(path):
                continue
            how = "" if isinstance(e, FileExistsError) else f" ({type(e).__name__} creating it)"
            sys.exit(f"{stop} another AI Acolyte gate edit holds {path}{how}. Nothing was written; "
                     f"run it again in a moment. A lock left by a run that died is reclaimed once "
                     f"it is {GATE_LOCK_STALE_S} s old.")
        except OSError as e:
            sys.exit(f"{stop} the gate-edit lock {path} could not be created "
                     f"({type(e).__name__}: {e}). Nothing was written.")
        try:
            os.write(fd, (json.dumps({"pid": os.getpid(), "owner": owner, "at": time.time()})
                          + "\n").encode("utf-8"))
        except OSError as e:
            os.close(fd)
            try:
                os.remove(path)               # O_EXCL made it, so it is this run's to remove
            except OSError:
                pass
            sys.exit(f"{stop} the gate-edit lock {path} could not be written "
                     f"({type(e).__name__}: {e}). Nothing was written.")
        os.close(fd)
        return owner


def _reclaim_gate_lock(path):
    """True when the lock is gone, or was older than GATE_LOCK_STALE_S, read the same twice, and
    has been removed. False while it is live, or when it changed while that was being decided."""
    try:
        first = os.stat(path)
        if time.time() - first.st_mtime <= GATE_LOCK_STALE_S:
            return False
        with open(path, "rb") as f:
            text = f.read()
        again = os.stat(path)
        with open(path, "rb") as f:
            if f.read() != text:
                return False
        # mtime in float seconds, the unit the index writes: test/recall-index.test.js holds this
        # whole file to that unit, so the nanosecond field is not used here either. Two stats of an
        # unchanged file give the same float, and size, inode and the bytes read twice above back
        # up a change too small for a float of seconds to show.
        if (again.st_size, again.st_mtime, again.st_ino) != (first.st_size, first.st_mtime,
                                                             first.st_ino):
            return False
        os.remove(path)
        return True
    except FileNotFoundError:
        return True
    except OSError:
        return False


def _drop_gate_lock(owner):
    """Remove the gate-edit lock if it is still this run's. One that is not was reclaimed by another
    run after this one outlived the stale window, and is that run's to remove. A lock that cannot
    be removed is reported: until it is stale, every later gate edit refuses."""
    path = _gate_lock_path()
    try:
        with open(path, "rb") as f:
            held = json.loads(f.read().decode("utf-8"))
        if not isinstance(held, dict) or held.get("owner") != owner:
            return
        os.remove(path)
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as e:
        print(f"[recall] could not remove the gate-edit lock {path} ({type(e).__name__}); gate "
              f"edits refuse until it is {GATE_LOCK_STALE_S} s old.", file=sys.stderr)


def selftest():
    e = Bge()
    a, b, c = (np.array(e.embed(t)) for t in
               ("I love programming in C sharp",
                "Writing code in dot net is really fun",
                "The weather outside is freezing cold today"))
    hi, lo = float(a @ b), float(a @ c)
    print(f"  dim={len(a)}  cos(code,code)={hi:.4f} (HIGH)  cos(code,weather)={lo:.4f} (LOW)")
    print("  RESULT:", "PASS" if hi > lo else "FAIL")


def main():
    for stream in (sys.stdout, sys.stderr):        # Windows consoles default to cp1252
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser(description="Semantic search + hygiene lint over the Claude memory dir.")
    ap.add_argument("query", nargs="*", help="what you're trying to recall")
    # default=None, so "was -k given?" has an answer the refusals below can ask; a search reads 6.
    ap.add_argument("-k", type=int, default=None, help="how many results (default 6)")
    ap.add_argument("--rebuild", action="store_true", help="force re-embed every file")
    ap.add_argument("--list", action="store_true", help="show what's indexed and exit")
    ap.add_argument("--lint", action="store_true", help="audit index bloat + links (no model)")
    ap.add_argument("--gates-compile", action="store_true",
                    help="lift scope:global gate blocks into ~/.claude/gates.generated.md "
                         "(refuses to overwrite a compiled file with nothing)")
    ap.add_argument("--gates-allow-empty", action="store_true",
                    help="with --gates-compile: allow an empty result to erase every compiled gate")
    ap.add_argument("--gates-list", action="store_true",
                    help="print every scope:global or scope:retired gate in the compile store as JSON "
                         "(no model)")
    ap.add_argument("--gates-retire", nargs="+", action="extend", default=[], metavar="NAME",
                    help="set these gate memories to scope: retired, after a snapshot of the "
                         "memory dir (does not compile)")
    ap.add_argument("--gates-restore", nargs="+", action="extend", default=[], metavar="NAME",
                    help="set these retired gate memories back to scope: global, after a snapshot "
                         "of the memory dir (does not compile)")
    ap.add_argument("--threads-compile", action="store_true",
                    help="compile every memory whose status: is open, awaiting, blocked or deferred, "
                         "and MEMORY.md's health, into ~/.claude/open-threads.generated.md (no model)")
    ap.add_argument("--selftest", action="store_true", help="verify the embedder's reference cosines")
    ap.add_argument("--vector-only", action="store_true", help="rank by embedding cosine alone")
    ap.add_argument("--lexical-only", action="store_true", help="rank by BM25 alone (no model load)")
    ap.add_argument("--json", action="store_true",
                    help="with a query: print the results as one JSON object (file, line, excerpt)")
    args = ap.parse_args()

    editing = bool(args.gates_retire or args.gates_restore)
    # A query's own flags, refused beside every mode that runs alone (2026-10-20). They were left
    # out of these lists, so `--threads-compile --json` and `--lint --json` ran and dropped the
    # flag without a word, which is the half-done run the lists below exist to refuse.
    query_flags = (("--json", args.json), ("-k", args.k is not None),
                   ("--vector-only", args.vector_only), ("--lexical-only", args.lexical_only))
    if args.gates_list or editing:
        # Each runs alone. `--gates-retire x --gates-compile` reads as "retire, then compile", and
        # quietly doing half of it is the shape of failure this file keeps removing. Exit 2 is
        # argparse's usage error, distinct from a refusal's 1.
        mixed = [flag for flag, on in (("--gates-list", args.gates_list and editing),
                                       ("--lint", args.lint), ("--gates-compile", args.gates_compile),
                                       ("--gates-allow-empty", args.gates_allow_empty),
                                       ("--threads-compile", args.threads_compile),
                                       ("--selftest", args.selftest), ("--rebuild", args.rebuild),
                                       ("--list", args.list), ("a query", bool(args.query)))
                 + query_flags if on]
        if mixed:
            ap.error(f"--gates-list, --gates-retire and --gates-restore run on their own (retire "
                     f"and restore may share a run), not with {', '.join(mixed)}. Compile in a "
                     f"second run.")
        if args.gates_list:
            gates_list()
        else:
            change_gate_scopes(args.gates_retire, args.gates_restore)
        return
    if args.threads_compile:
        # Alone, for the reason above: `--threads-compile --gates-compile` doing one of the two
        # would be half of what was asked.
        mixed = [flag for flag, on in (("--lint", args.lint), ("--gates-compile", args.gates_compile),
                                       ("--gates-allow-empty", args.gates_allow_empty),
                                       ("--selftest", args.selftest), ("--rebuild", args.rebuild),
                                       ("--list", args.list), ("a query", bool(args.query)))
                 + query_flags if on]
        if mixed:
            ap.error(f"--threads-compile runs on its own, not with {', '.join(mixed)}.")
        compile_threads()
        return
    if args.lint:
        # Alone too: the lint printed its report and returned, and whatever else was asked for
        # (a rebuild, a compile, a query and its flags) was dropped in silence.
        mixed = [flag for flag, on in (("--gates-compile", args.gates_compile),
                                       ("--gates-allow-empty", args.gates_allow_empty),
                                       ("--selftest", args.selftest), ("--rebuild", args.rebuild),
                                       ("--list", args.list), ("a query", bool(args.query)))
                 + query_flags if on]
        if mixed:
            ap.error(f"--lint runs on its own, not with {', '.join(mixed)}.")
        texts = lint()
        if texts is not None:
            _lint_retired(texts)
        return
    if args.gates_compile:
        # Alone as well, beside its own --gates-allow-empty (2026-10-20). Without a list here,
        # `--gates-compile --rebuild` compiled and dropped the rebuild, and `--json`, `-k` or a
        # query were dropped without a word, the half-done run the lists above refuse.
        mixed = [flag for flag, on in (("--selftest", args.selftest), ("--rebuild", args.rebuild),
                                       ("--list", args.list), ("a query", bool(args.query)))
                 + query_flags if on]
        if mixed:
            ap.error(f"--gates-compile runs on its own (--gates-allow-empty aside), not with "
                     f"{', '.join(mixed)}.")
        compile_gates(allow_empty=args.gates_allow_empty); return
    if args.gates_allow_empty:
        # It qualifies the compile and nothing else, so alone it was dropped in silence too.
        ap.error("--gates-allow-empty applies only to --gates-compile.")
    if args.selftest:
        selftest(); return
    if args.rebuild:
        # Spans MEMORY_DIRS. Rebuilding only the primary while search covers several corpora
        # meant there was no way to force a re-embed of a secondary one: after an EMBED_ID bump
        # --rebuild reported success and left it on stale vectors.
        for d in MEMORY_DIRS:
            build_or_update(force=True, mem_dir=d)
        print("[recall] rebuilt." if len(MEMORY_DIRS) == 1
              else f"[recall] rebuilt {len(MEMORY_DIRS)} corpora.", file=sys.stderr)
        if not args.query:
            return
    if args.list:
        idx = build_or_update()
        for name in sorted(idx["files"]):
            print(f"  {name}  --  {idx['files'][name]['desc'][:90]}")
        return
    if not args.query:
        if args.json:
            ap.error("--json needs a query to answer.")
        ap.print_help(); return
    if args.vector_only and args.lexical_only:
        sys.exit("[recall] --vector-only and --lexical-only are mutually exclusive.")
    mode = "vector" if args.vector_only else "lexical" if args.lexical_only else "hybrid"
    (search_json if args.json else search)(" ".join(args.query), 6 if args.k is None else args.k, mode)


if __name__ == "__main__":
    main()
