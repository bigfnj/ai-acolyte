# Memory tool

Hygiene + semantic recall for the Claude Code file-memory system (the `MEMORY.md` index +
per-fact `*.md` files under `~/.claude/projects/<proj>/memory/`).

Two layers:

- **Thin index.** `MEMORY.md` is loaded into every session, so each entry stays a one-line
  hook (what it is + repo + one status word + key links). Running status/changelogs live in
  the memory file or the project's own repo, not the index.
- **On-demand recall.** `recall.py` embeds every memory file and finds the ones that *mean*
  the same thing as a query, so "have I solved X before?" works across projects even when the
  wording differs from the hook.

## Usage

```
python recall.py "how do I push git from the agent shell"
python recall.py -k 10 "run admin tasks without a UAC prompt"
python recall.py --vector-only "..."   # cosine alone; the pre-hybrid ranking
python recall.py --lexical-only "..."  # BM25 alone; builds no ONNX session
python recall.py --lint          # audit index bloat + broken links (no model needed)
python recall.py --gates-compile # lift scope:global gate blocks into ~/.claude/gates.generated.md
python recall.py --gates-compile --gates-allow-empty   # ... and let the result be empty
python recall.py --rebuild       # force re-embed everything
python recall.py --list          # show what's indexed
python recall.py --selftest      # verify the embedder's reference cosines
```

`--gates-compile` **refuses to replace a non-empty `gates.generated.md` with nothing** and exits
non-zero, naming the corpus it read. A compile that finds zero gates is nearly always
`RECALL_MEMORY_DIR` pointing at the wrong dir, and every downstream signal for it is silent: the
installer declines an empty block so `CLAUDE.md` still looks correct, the dashboard count reads 0,
and the `--lint` staleness check compares empty to empty and reports current. Pass
`--gates-allow-empty` when deleting every gate is what you actually meant.

Ranked output is `score  file  cos N  lex N  description  > best-matching line`.

The **cosine** is the number to calibrate on, and it is the one every figure recorded before
the hybrid ranker landed refers to: ~0.5+ is a real hit, 0.7+ is strong. The leading **score**
is min-max normalized *within one result set*, so it says how the results compare to each
other and nothing about how good the best one is. `--vector-only` prints the raw cosine in the
score column and reproduces the pre-hybrid output exactly.

## How it works

- **CPU embeddings.** `bge-small-en-v1.5` ONNX (the same asset desktopPet ships): BERT-uncased
  WordPiece, CLS-pool, L2-norm, 384-dim. Runs on the CPU via `onnxruntime` — always available,
  no GPU, no Ollama, no MCP, no Claude Code hook, so it runs untouched under the corporate
  managed policy. Verified to reproduce desktopPet's self-test cosines (0.72 / 0.44).
- **Hybrid ranking.** The cosine above, fused with Okapi BM25 over the whole file, each min-max
  normalized per query and averaged. The two legs see different text: `Bge._encode` truncates
  at 256 tokens, so on the live corpus 117 of 119 files are cut and the median file contributes
  only ~832 chars to its vector. BM25 reads all of it, which is why a question about a command
  or an error string buried mid-file can be answered at all. Measured over 24 questions,
  R@1 0.58 → 0.79 and worst rank 94 → 48; `bench/gate_recall.py` reproduces it.
  Lexical statistics are recomputed per query, never cached: `df` and `avgdl` are corpus-global
  and so invalidate on any edit, a different model from the per-file `(mtime, size)` one
  `recall_index.json` uses, and the whole pass costs ~67 ms against a ~210 ms session load.
- **Incremental cache.** One vector per file, cached in `recall_index.json` **in the memory
  dir** (not this repo); only changed files re-embed. Bump `EMBED_ID` in `recall.py` to force
  a full rebuild.
- **Runtime.** Needs `onnxruntime` + `numpy` (present in the DevToolbox venv). If launched
  under a Python without them, `recall.py` re-execs itself under the DevToolbox venv, so plain
  `python recall.py ...` works from anywhere.

## Config (env)

| var | default | meaning |
|---|---|---|
| `RECALL_MEMORY_DIR`  | auto-discovered: the `~/.claude/projects/*/memory` holding the most memory files | the one corpus to index, lint and compile gates from |
| `RECALL_MEMORY_DIRS` | the dir above | corpora to **search**, `os.pathsep`-separated |
| `RECALL_MODEL_DIR`   | `./models` beside this script | where `bge-small.onnx` lives |

The corpus is discovered rather than hardcoded because Claude Code derives the project slug
from the working directory, so renaming a working root relocates the whole store. The VS Code
extension pins both vars explicitly when it spawns this script, so its card and this tool
always agree on which dir they are talking about.

Discovery takes the single largest store, which means a rename **strands** the old one: this
machine has 6 memories sitting in `C--Anthropic/memory` that nothing could search, two of them
on topics the current corpus never re-recorded. `RECALL_MEMORY_DIRS` is the answer to that. It
affects search only — `--lint` and `--gates-compile` stay on `RECALL_MEMORY_DIR`, deliberately,
because a gate is a standing order and a second corpus must not be able to install one. Each
corpus keeps its own `recall_index.json` in its own directory, so the per-file staleness
contract the extension reads is unchanged. A filename present in two corpora prints qualified
by its store (`C--Anthropic/dup.md`); an un-collided name prints bare, so single-corpus output
is byte-identical to before.

## Model asset

`models/bge-small.vocab.txt` is committed; `models/bge-small.onnx` (~32 MB) is gitignored.
Easiest restore on a fresh clone: click **Rebuild recall index** in the VS Code extension's
Memory card, which downloads it (with a confirmation prompt) into
`~/.claude/wildcarding/models/` and copies the vocab beside it — a stable home that survives
extension upgrades and clone deletion. Point `RECALL_MODEL_DIR` there to share the one copy,
or copy `bge-small.onnx` from `desktopPet/src/Models/` / export `BAAI/bge-small-en-v1.5` to
ONNX yourself. The tool degrades with a clear message if the model is absent (`--lint` still
works without it).

Whichever dir wins, the vocab must sit beside the model: `Bge` loads
`bge-small.vocab.txt` from the same dir it resolved `bge-small.onnx` in.
