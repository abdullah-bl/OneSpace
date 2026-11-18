"""Hybrid retrieval check: BM25 (normalized Arabic, light prefix stripping) + dense (RRF), then rerank top-30.
Approximates the plan's FTS5 + vector + rerank pipeline. Run: python3 hybrid.py"""
import json, math, os, re
from collections import Counter
import run
from lib import embed, rerank, pmap, norm_ar, DATA

PREFIXES = ("وال", "بال", "كال", "فال", "لل", "ال", "و")


def toks(s):
    out = []
    for w in re.findall(r"[\w]+", norm_ar(s)):
        for p in PREFIXES:
            if w.startswith(p) and len(w) - len(p) >= 3:
                w = w[len(p):]; break
        if len(w) >= 2:
            out.append(w)
    return out


def bm25_rank(qs, docs, k1=1.5, b=0.75):
    dt = [Counter(toks(d)) for d in docs]
    avg = sum(sum(c.values()) for c in dt) / len(dt)
    df = Counter(w for c in dt for w in c)
    N = len(docs)
    res = []
    for q in qs:
        qt = toks(q)
        sc = []
        for c in dt:
            L = sum(c.values()); s = 0.0
            for w in qt:
                if w in c:
                    idf = math.log(1 + (N - df[w] + .5) / (df[w] + .5))
                    s += idf * c[w] * (k1 + 1) / (c[w] + k1 * (1 - b + b * L / avg))
            sc.append(s)
        res.append(sorted(range(N), key=lambda i: -sc[i]))
    return res


def stats(ranks):
    n = len(ranks)
    return {f"recall@{k}": round(100 * sum(r <= k for r in ranks) / n, 1) for k in (1, 6, 10, 30)} | {"mrr": round(sum(1 / r for r in ranks) / n, 3)}


def main():
    corpus, qa = run.load_corpus()
    ids = [c["id"] for c in corpus]
    docs = [run.doc_text(c, "raw") for c in corpus]
    pos = lambda order, q: ([ids[i] for i in order].index(q["chunk_id"]) + 1) if q["chunk_id"] in [ids[i] for i in order] else 999
    bm = bm25_rank([q["question"] for q in qa], docs)
    dv = embed(docs); qv = embed([q["question"] for q in qa])
    dense = [run.cos_rank(v, dv) for v in qv]
    hyb = []
    for a, b in zip(dense, bm):
        s = Counter()
        for r, i in enumerate(a): s[i] += 1 / (60 + r)
        for r, i in enumerate(b): s[i] += 1 / (60 + r)
        hyb.append([i for i, _ in s.most_common()])
    def rr(item):
        q, order = item
        top = order[:30]
        sc = rerank(q["question"], [docs[i] for i in top])
        return pos([top[i] for i in sorted(range(len(top)), key=lambda i: -sc[i])], q)
    out = {"bm25": stats([pos(o, q) for o, q in zip(bm, qa)]),
           "dense": stats([pos(o, q) for o, q in zip(dense, qa)]),
           "hybrid_rrf": stats([pos(o, q) for o, q in zip(hyb, qa)]),
           "hybrid_rrf+rerank30": stats(pmap(rr, list(zip(qa, hyb))))}
    run.put("hybrid", out)


if __name__ == "__main__":
    main()
