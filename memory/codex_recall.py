#!/usr/bin/env python3
"""Private CPU retrieval over adapter-selected Codex passages supplied on stdin.

No native-memory discovery, network, GPU provider, generated memories or Claude
index writes. Cache entries contain identities and vectors, not source text.
"""
import collections
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import stat
import sys
import tempfile

SCHEMA = 1
WINDOW_TOKENS = 224
WINDOW_OVERLAP = 32


def digest(data):
    return hashlib.sha256(data).hexdigest()


def identity_path(value):
    return os.path.normcase(os.path.abspath(value))


def linked(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 1024)


def ordinary_parents(file, create=False):
    parent = Path(file).parent
    for item in [*reversed(parent.parents), parent]:
        try:
            info = item.lstat()
        except FileNotFoundError:
            if not create:
                return False
            item.mkdir()
            info = item.lstat()
        if linked(info) or not stat.S_ISDIR(info.st_mode):
            raise ValueError("Recall cache parent is not an ordinary directory")
    return True


def ordinary_leaf(file):
    try:
        info = Path(file).lstat()
    except FileNotFoundError:
        return False
    if linked(info) or not stat.S_ISREG(info.st_mode):
        raise ValueError("Recall cache is not an ordinary file")
    return True


def validate(request):
    if request.get("schema") != SCHEMA or request.get("operation") not in ("search", "rebuild"):
        raise ValueError("Invalid Codex recall request")
    home, codex_home = request["home"], request["codexHome"]
    if not os.path.isabs(home) or not os.path.isabs(codex_home):
        raise ValueError("Recall profile paths must be absolute")
    profile = digest(identity_path(codex_home).encode("utf-8"))
    expected_cache = os.path.join(home, ".ai-acolyte", "codex", profile, "recall", "index.json")
    if request["profileId"] != profile or identity_path(request["cachePath"]) != identity_path(expected_cache):
        raise ValueError("Recall cache belongs to another profile")
    for field, hash_field in (("modelPath", "modelSha"), ("vocabPath", "vocabSha"),
                             ("recallScript", "recallSha")):
        if not os.path.isabs(request[field]) or digest(Path(request[field]).read_bytes()) != request[hash_field]:
            raise ValueError("CPU recall asset identity changed")
    if digest(Path(__file__).read_bytes()) != request["bridgeSha"]:
        raise ValueError("CPU bridge identity changed")
    if os.path.basename(request["modelPath"]) != "bge-small.onnx" or \
            os.path.abspath(request["vocabPath"]) != os.path.join(os.path.dirname(os.path.abspath(request["modelPath"])), "bge-small.vocab.txt"):
        raise ValueError("Model and vocabulary must be paired")
    seen = set()
    for chunk in request["chunks"]:
        if chunk["id"] in seen or digest(chunk["text"].encode("utf-8")) != chunk["sha256"]:
            raise ValueError("Duplicate or changed source passage")
        seen.add(chunk["id"])
    return profile, expected_cache


def cache_identity(request):
    return {key: request[key] for key in ("profileId", "modelSha", "vocabSha", "recallSha", "bridgeSha")} | {
        "schema": SCHEMA, "agent": "codex", "windowTokens": WINDOW_TOKENS, "windowOverlap": WINDOW_OVERLAP}


def load_cache(file, identity):
    if not ordinary_parents(file) or not ordinary_leaf(file):
        return {}, None
    try:
        value = json.loads(Path(file).read_text(encoding="utf-8"))
        if value.get("identity") != identity or not isinstance(value.get("windows"), dict):
            return {}, "The recall cache identity changed; vectors were rebuilt."
        return value["windows"], None
    except (ValueError, UnicodeError):
        return {}, "The recall cache was unreadable; vectors were rebuilt."


def save_cache(file, identity, windows):
    ordinary_parents(file, create=True)
    ordinary_leaf(file)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", prefix=".recall-",
                                         suffix=".tmp", dir=os.path.dirname(file), delete=False) as stream:
            temporary = stream.name
            json.dump({"identity": identity, "windows": windows}, stream, separators=(",", ":"), allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        ordinary_parents(file)
        ordinary_leaf(file)
        os.replace(temporary, file)
        temporary = None
    finally:
        if temporary is not None:
            os.unlink(temporary)


def lexical_index(recall, chunks):
    tf, dl, df = {}, {}, {}
    for chunk in chunks:
        terms = recall._lex_terms(chunk["text"])
        counts = collections.Counter(terms)
        tf[chunk["id"]], dl[chunk["id"]] = counts, len(terms)
        for term in counts:
            df[term] = df.get(term, 0) + 1
    total = len(tf)
    return {"tf": tf, "dl": dl, "idf": {term: math.log(1 + (total - count + .5) / (count + .5))
            for term, count in df.items()}, "avgdl": sum(dl.values()) / total if total and sum(dl.values()) else 1.0}


def token_windows(encoder, text):
    tokens = [encoder.vocab.get(piece, encoder.vocab["[UNK]"])
              for word in encoder._basic(text) for piece in encoder._wordpiece(word)]
    if not tokens:
        return [(0, 0, [])]
    output = []
    start = 0
    while start < len(tokens):
        end = min(start + WINDOW_TOKENS, len(tokens))
        output.append((start, end, tokens[start:end]))
        if end == len(tokens):
            break
        start = end - WINDOW_OVERLAP
    return output


def run(request):
    profile, cache_file = validate(request)
    identity = cache_identity(request)
    cached, warning = load_cache(cache_file, identity)
    chunks = request["chunks"]
    base = {"schema": SCHEMA, **{key: request[key] for key in
            ("profileId", "modelSha", "vocabSha", "recallSha", "bridgeSha")},
            "indexedChunks": len(chunks), "hits": [], "cacheWarning": warning}
    if not chunks:
        save_cache(cache_file, identity, {})
        return {**base, "mode": "empty", "providers": [], "windows": 0, "embeddedWindows": 0, "reusedWindows": 0}
    # Protect direct bridge callers as well as the Node wrapper: importing legacy
    # recall.py must not enumerate Claude memories or re-exec into another runtime.
    os.environ.update(RECALL_REEXEC="1", RECALL_MEMORY_DIR=os.path.dirname(cache_file),
                      RECALL_MEMORY_DIRS="", RECALL_MODEL_DIR=os.path.dirname(request["modelPath"]))
    spec = importlib.util.spec_from_file_location("acolyte_recall_cpu", request["recallScript"])
    recall = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(recall)

    class WindowBge(recall.Bge):
        pending_ids = None

        def _encode(self, text):
            if self.pending_ids is None:
                return super()._encode(text)
            return [self.vocab["[CLS]"]] + self.pending_ids + [self.vocab["[SEP]"]]

        def embed_ids(self, ids):
            self.pending_ids = ids
            try:
                return self.embed("")
            finally:
                self.pending_ids = None

    encoder = WindowBge()
    providers = encoder.sess.get_providers()
    if providers != ["CPUExecutionProvider"]:
        raise ValueError("Recall requires the CPU provider exclusively")
    windows, by_chunk, embedded, reused = {}, {}, 0, 0
    for chunk in chunks:
        by_chunk[chunk["id"]] = []
        for start, end, ids in token_windows(encoder, chunk["text"]):
            key = digest(f'{chunk["id"]}:{start}:{end}'.encode("utf-8"))
            old = cached.get(key, {}) if request["operation"] != "rebuild" else {}
            vector = old.get("vector")
            if not (isinstance(vector, list) and len(vector) == 384 and
                    all(isinstance(number, (float, int)) and math.isfinite(number) for number in vector)):
                vector = encoder.embed_ids(ids)
                embedded += 1
            else:
                reused += 1
            windows[key] = {"chunkId": chunk["id"], "sourceId": chunk["sourceId"], "sha256": chunk["sha256"],
                            "tokenStart": start, "tokenEnd": end, "vector": vector}
            by_chunk[chunk["id"]].append(vector)
    save_cache(cache_file, identity, windows)
    base.update(mode="hybrid", providers=providers, onnxVersion=recall.ort.__version__, windows=len(windows), embeddedWindows=embedded, reusedWindows=reused)
    if request["operation"] == "rebuild":
        return base
    query = encoder.embed(request["query"])
    cosine = {name: max(sum(a * b for a, b in zip(query, vector)) for vector in vectors)
              for name, vectors in by_chunk.items()}
    lexical = recall._bm25(request["query"], lexical_index(recall, chunks))
    names = sorted(by_chunk)
    vector_unit, lexical_unit = recall._unit(cosine, names), recall._unit(lexical, names)
    scores = {name: recall.FUSE_W * vector_unit[name] + (1.0 - recall.FUSE_W) * lexical_unit[name] for name in names}
    order = sorted(names, key=lambda name: (-scores[name], name))[:request["limit"]]
    base["hits"] = [{"id": name, "score": scores[name], "cosine": cosine[name], "bm25": lexical.get(name, 0.0)} for name in order]
    return base


if __name__ == "__main__":
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
        result = run(json.load(sys.stdin))
        json.dump(result, sys.stdout, ensure_ascii=False, allow_nan=False)
        sys.stdout.write("\n")
    except Exception as error:
        # Do not emit private query/passage text, native filenames or tracebacks.
        sys.stderr.write("Codex CPU recall failed: " + type(error).__name__ + "\n")
        sys.exit(1)
