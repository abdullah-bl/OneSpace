"""OneSpace Phase-0 benchmark runner.

usage: python3 run.py [tests...] [--n-format 100] [--n-select 30] [--n-multi 10] [--n-code 10]
                      [--n-cite 30] [--n-abstain 30] [--ctx 16000,64000,128000] [--fast]
tests: format select multi code cite abstain recall perf think context ocr fast   (default: all)
Results -> results/<test>.json and results/summary.json (merged).
"""
import argparse, base64, json, os, random, re, statistics as st, subprocess, sys, time
import lib
from lib import (chat, chat_stream, embed, rerank, pmap, save, norm_ar, digits_only, arabic_ratio,
                 DATA, RESULTS, MAIN_URL, FAST_URL, FAST_MODEL)
import tools_def as T
import multistep, codegen

SUMMARY = os.path.join(RESULTS, "summary.json")


def put(key, val):
    s = json.load(open(SUMMARY)) if os.path.exists(SUMMARY) else {}
    s[key] = val
    json.dump(s, open(SUMMARY, "w"), ensure_ascii=False, indent=1)
    print(f"== {key}: {json.dumps(val, ensure_ascii=False)[:600]}", flush=True)


def pct(a, b):
    return round(100.0 * a / b, 1) if b else None


# ---------------------------------------------------------------- tool calling
def one_call(case, tools, think=False, base=None, model=None):
    msgs = [{"role": "system", "content": "أنت مساعد إداري. استخدم الأداة المناسبة لتنفيذ طلب المستخدم. التاريخ اليوم 2026-11-18."},
            {"role": "user", "content": case["prompt"]}]
    try:
        m, raw, dt = chat(msgs, tools=tools, think=think, max_tokens=4096 if think else 768, base=base, model=model)
    except Exception as ex:
        return {"id": case["id"], "error": str(ex)[:300], "called": False, "valid": False, "tool_ok": False}
    tcs = m.get("tool_calls") or []
    r = {"id": case["id"], "prompt": case["prompt"], "expected": case["tool"], "called": bool(tcs), "seconds": round(dt, 2),
         "completion_tokens": raw["usage"]["completion_tokens"], "content": (m.get("content") or "")[:200]}
    if not tcs:
        # raw tool-call markup leaking into content = format failure
        r.update(valid=False, tool_ok=False, leaked_markup="<tool_call>" in (m.get("content") or "") or "<function=" in (m.get("content") or ""))
        return r
    tc = tcs[0]["function"]
    r["got"] = tc["name"]
    try:
        args = json.loads(tc["arguments"]) if isinstance(tc["arguments"], str) else tc["arguments"]
        probs = T.validate_args(tc["name"], args)
    except Exception as ex:
        args, probs = None, [f"json: {ex}"]
    r.update(args=args, problems=probs, valid=not probs, tool_ok=tc["name"] == case["tool"])
    if args and r["tool_ok"]:
        r["args_ok"] = all(norm_ar(str(v)) in norm_ar(str(args.get(k, ""))) for k, v in case["checks"].items())
    return r


def test_format(n, base=None, model=None, tag="format"):
    cases = T.make_cases(n)
    res = pmap(lambda c: one_call(c, T.TOOLS, base=base, model=model), cases)
    called = [r for r in res if r["called"]]
    s = {"n": n, "called": len(called), "valid_of_all_pct": pct(sum(r["valid"] for r in res), n),
         "valid_of_called_pct": pct(sum(r["valid"] for r in called), len(called)),
         "correct_tool_pct": pct(sum(r["tool_ok"] for r in res), n),
         "args_ok_pct_of_correct": pct(sum(r.get("args_ok", False) for r in res), sum(r["tool_ok"] for r in res)),
         "leaked_markup": sum(r.get("leaked_markup", False) for r in res),
         "errors": sum(1 for r in res if "error" in r),
         "mean_s": round(st.mean(r.get("seconds", 0) for r in res), 2)}
    save(tag, res); put(tag, s)
    return s


def test_select(n, sizes=(5, 10, 15), think=False, base=None, model=None, tag="select"):
    cases = T.make_cases(n, seed=11)
    out = {}
    for k in sizes:
        res = pmap(lambda c: one_call(c, T.toolset(c["tool"], k, c["id"]), think=think, base=base, model=model), cases)
        out[str(k)] = {"n": n, "correct_pct": pct(sum(r["tool_ok"] for r in res), n),
                       "no_call": sum(not r["called"] for r in res),
                       "mean_s": round(st.mean(r.get("seconds", 0) for r in res), 2),
                       "mean_completion_tokens": round(st.mean(r.get("completion_tokens", 0) for r in res), 1)}
        save(f"{tag}_{k}", res)
    put(tag, out)
    return out


def test_multi(n, think=False, base=None, model=None, tag="multi"):
    tasks = (multistep.TASKS * 3)[:n]
    res = pmap(lambda t: multistep.run_task(t, think=think, base=base, model=model), tasks)
    for t, r in zip(tasks, res):
        r["task"] = t[0]
    s = {"n": n, "success_pct": pct(sum(r["ok"] for r in res), n),
         "by_task": [int(r["ok"]) for r in res],
         "format_errors": sum(r.get("format_errors", 0) for r in res),
         "mean_tool_calls": round(st.mean(r.get("tool_calls", 0) for r in res), 1),
         "mean_s": round(st.mean(r.get("seconds", 0) for r in res), 1)}
    save(tag, res); put(tag, s)
    return s


def test_code(n, think=False, tag="code"):
    codegen.make_data()
    cs = codegen.cases()[:n]
    res = pmap(lambda c: codegen.run_case(c, think=think), cs)
    s = {"n": len(cs), "correct_within_2_pct": pct(sum(r["ok"] for r in res), len(cs)),
         "correct_first_pct": pct(sum(r["ok_first"] for r in res), len(cs)),
         "runs_first_pct": pct(sum(r["runs_first"] for r in res), len(cs))}
    save(tag, res); put(tag, s)
    return s


# ---------------------------------------------------------------- RAG data
def load_corpus():
    corpus = json.load(open(os.path.join(DATA, "corpus.json")))
    qa = json.load(open(os.path.join(DATA, "qa.json")))
    return corpus, qa


def doc_text(c, style):
    if style in ("gemma", "gemma_qa"):
        return f"title: {c['title']} | text: {c['heading']}\n{c['text']}"
    return f"{c['title']}\n{c['heading']}\n{c['text']}"


def q_text(q, style):
    if style == "gemma":
        return f"task: search result | query: {q}"
    if style == "gemma_qa":
        return f"task: question answering | query: {q}"
    return q


def cos_rank(qv, dvs):
    sims = [sum(a * b for a, b in zip(qv, d)) for d in dvs]
    return sorted(range(len(dvs)), key=lambda i: -sims[i])


_vec_cache = {}


def corpus_vecs(corpus, style):
    if style == "gemma_qa":
        style = "gemma"
    if style not in _vec_cache:
        t = time.time()
        v = embed([doc_text(c, style) for c in corpus])
        _vec_cache[style] = (v, time.time() - t)
    return _vec_cache[style]


def test_recall():
    corpus, qa = load_corpus()
    ids = [c["id"] for c in corpus]
    out = {"chunks": len(corpus), "questions": len(qa), "docs": len({c["doc"] for c in corpus})}
    best = None
    def trunc(v, d):
        v = v[:d]; n = sum(x * x for x in v) ** 0.5
        return [x / n for x in v]
    for style in ("raw", "gemma", "gemma_qa", "gemma@512", "gemma@256", "gemma@128"):
        base_style, _, dim = style.partition("@")
        dv, secs = corpus_vecs(corpus, base_style)
        qv = embed([q_text(q["question"], base_style) for q in qa])
        if dim:
            dv = [trunc(v, int(dim)) for v in dv]; qv = [trunc(v, int(dim)) for v in qv]
        ranks = []
        for q, v in zip(qa, qv):
            order = cos_rank(v, dv)
            ranks.append(([ids[i] for i in order].index(q["chunk_id"]) + 1, order))
        r = [x[0] for x in ranks]
        out[style] = {"recall@1": pct(sum(x <= 1 for x in r), len(r)), "recall@5": pct(sum(x <= 5 for x in r), len(r)),
                      "recall@10": pct(sum(x <= 10 for x in r), len(r)), "recall@30": pct(sum(x <= 30 for x in r), len(r)),
                      "mrr": round(st.mean(1 / x for x in r), 3), "embed_chunks_per_s": round(len(corpus) / secs, 1)}
        if not dim and (best is None or out[style]["recall@10"] > out[best[0]]["recall@10"]):
            best = (style, ranks)
    # rerank top-30 of best style
    style, ranks = best
    rr = []
    def do(item):
        q, (rank, order) = item
        top = order[:30]
        sc = rerank(q["question"], [doc_text(corpus[i], "raw") for i in top])
        new = [top[i] for i in sorted(range(len(top)), key=lambda i: -sc[i])]
        newids = [ids[i] for i in new]
        return newids.index(q["chunk_id"]) + 1 if q["chunk_id"] in newids else 999
    t = time.time()
    rr = pmap(do, list(zip(qa, ranks)))
    out["rerank_top30_" + style] = {"recall@1": pct(sum(x <= 1 for x in rr), len(rr)), "recall@6": pct(sum(x <= 6 for x in rr), len(rr)),
                                    "recall@10": pct(sum(x <= 10 for x in rr), len(rr)), "mrr": round(st.mean(1 / x for x in rr), 3),
                                    "s_per_query_30docs": round((time.time() - t) / len(qa) * lib.CONCURRENCY, 2)}
    out["dimension"] = len(corpus_vecs(corpus, "raw")[0][0])
    put("recall", out)
    return out


# ---------------------------------------------------------------- cite / abstain
CITE_SYS = ("أنت مساعد يجيب عن أسئلة الموظفين من المقاطع المعطاة فقط. اكتب الإجابة بالعربية بإيجاز، "
            "وضع رقم المقطع الذي استندت إليه بين قوسين مربعين مثل [2] بعد كل معلومة. "
            "إذا لم تكن الإجابة موجودة في المقاطع فأجب بعبارة: لا أعلم — ولا تخمّن.")
ABSTAIN_RE = re.compile(r"لم ترد|لا يوجد نص|لا يوجد ما|لا\s*أعلم|لا\s*اعلم|لا تتوفر|غير متوفر|لا تحتوي|لم يرد|لم تذكر|لا يوجد في المقاطع|لا تتضمن|لم يتم ذكر|لا تذكر")


def neighbors(corpus, qa_item, k, exclude_gold):
    dv, _ = corpus_vecs(corpus, "raw")
    gi = [c["id"] for c in corpus].index(qa_item["chunk_id"])
    order = cos_rank(dv[gi], dv)
    out = []
    key = digits_only(qa_item["key"]).strip()
    for i in order:
        if i == gi:
            continue
        if exclude_gold and key and key in digits_only(corpus[i]["text"]):
            continue
        out.append(i)
        if len(out) == k:
            break
    return gi, out


def ctx_prompt(corpus, idxs, question):
    parts = [f"[{n+1}] {corpus[i]['title']} — {corpus[i]['heading']}\n{corpus[i]['text']}" for n, i in enumerate(idxs)]
    return "المقاطع:\n\n" + "\n\n".join(parts) + f"\n\nالسؤال: {question}"


def test_cite(n, think=False, base=None, model=None, tag="cite"):
    corpus, qa = load_corpus()
    items = [q for q in qa if q["key_in_text"]]
    random.Random(3).shuffle(items)
    items = items[:n]

    def one(q):
        gi, nb = neighbors(corpus, q, 4, exclude_gold=False)
        idxs = nb + [gi]; random.Random(q["chunk_id"]).shuffle(idxs)
        gold = idxs.index(gi) + 1
        m, raw, dt = chat([{"role": "system", "content": CITE_SYS}, {"role": "user", "content": ctx_prompt(corpus, idxs, q["question"])}],
                          think=think, max_tokens=4096 if think else 600, base=base, model=model)
        a = m.get("content") or ""
        cited = {int(x) for x in re.findall(r"\[(\d+)\]", digits_only(a))}
        key = digits_only(q["key"]).strip()
        # sources that also contain the key fact are acceptable citations
        ok_src = {gold} | {n + 1 for n, i in enumerate(idxs) if key and key in digits_only(corpus[i]["text"])}
        r = {"q": q["question"], "key": q["key"], "answer": a[:500], "gold": gold, "cited": sorted(cited),
             "gold_cited": gold in cited, "cites_valid": bool(cited) and cited <= ok_src | {gold},
             "key_in_answer": key in digits_only(a), "abstained": bool(ABSTAIN_RE.search(a)),
             "arabic": arabic_ratio(a) > 0.6, "seconds": round(dt, 1)}
        r["pass"] = r["gold_cited"] and not r["abstained"] and r["arabic"]
        r["pass_strict"] = r["pass"] and r["key_in_answer"] and r["cites_valid"]
        return r
    res = pmap(one, items)
    s = {"n": len(res), "pass_pct": pct(sum(r["pass"] for r in res), len(res)),
         "pass_strict_pct": pct(sum(r["pass_strict"] for r in res), len(res)),
         "gold_cited_pct": pct(sum(r["gold_cited"] for r in res), len(res)),
         "only_valid_citations_pct": pct(sum(r["cites_valid"] for r in res), len(res)),
         "key_in_answer_pct": pct(sum(r["key_in_answer"] for r in res), len(res)),
         "false_abstain": sum(r["abstained"] for r in res), "mean_s": round(st.mean(r["seconds"] for r in res), 1)}
    save(tag, res); put(tag, s)
    return s


def test_abstain(n, think=False, base=None, model=None, tag="abstain"):
    corpus, qa = load_corpus()
    items = [q for q in qa if q["key_in_text"] and len(digits_only(q["key"]).strip()) >= 2]
    random.Random(5).shuffle(items)
    items = items[:n]

    def one(q):
        _, nb = neighbors(corpus, q, 5, exclude_gold=True)
        m, raw, dt = chat([{"role": "system", "content": CITE_SYS}, {"role": "user", "content": ctx_prompt(corpus, nb, q["question"])}],
                          think=think, max_tokens=4096 if think else 600, base=base, model=model)
        a = m.get("content") or ""
        return {"q": q["question"], "answer": a[:400], "abstained": bool(ABSTAIN_RE.search(a)),
                "leaked_key": digits_only(q["key"]).strip() in digits_only(a), "seconds": round(dt, 1)}
    res = pmap(one, items)
    s = {"n": len(res), "abstain_pct": pct(sum(r["abstained"] for r in res), len(res)),
         "hallucinated_key": sum(r["leaked_key"] for r in res)}
    save(tag, res); put(tag, s)
    return s


# ---------------------------------------------------------------- performance
def filler(n_chars, seed):
    corpus, _ = load_corpus()
    rng = random.Random(seed)
    out = []
    while sum(len(x) for x in out) < n_chars:
        c = rng.choice(corpus); out.append(c["heading"] + "\n" + c["text"])
    return "\n\n".join(out)


def test_perf(base=None, model=None, tag="perf", max_tokens=256):
    out = {}
    for scen, nchars in (("short", 0), ("rag_4k", 9000)):
        for conc in (1, 2, 4):
            def one(i):
                nonce = f"[طلب {random.randint(0, 10**9)}]\n"
                ctx = filler(nchars, random.randint(0, 10**6)) + "\n\n" if nchars else ""
                return chat_stream([{"role": "user", "content": nonce + ctx + "اكتب فقرة من 150 كلمة عن أهمية الالتزام بالسياسات الإدارية."}],
                                   max_tokens=max_tokens, base=base, model=model)
            res = []
            for _ in range(2):  # two rounds
                res += pmap(one, range(conc), n=conc)
            out[f"{scen}_c{conc}"] = {
                "prompt_tokens": round(st.mean(r["prompt_tokens"] or 0 for r in res)),
                "ttft_s_mean": round(st.mean(r["ttft"] for r in res), 2), "ttft_s_max": round(max(r["ttft"] for r in res), 2),
                "per_user_tps": round(st.mean(r["decode_tps"] for r in res), 1),
                "aggregate_tps": round(st.mean(r["decode_tps"] for r in res) * conc, 1),
                "server_prefill_tps": round(st.mean(r["server_prefill_tps"] or 0 for r in res), 0)}
            print(scen, conc, out[f"{scen}_c{conc}"], flush=True)
    put(tag, out)
    return out


def test_think(n_select, n_multi):
    out = {}
    # latency: same question, thinking on vs off
    q = [{"role": "user", "content": "موظف لديه رصيد إجازة 30 يوماً، أخذ 12 يوماً ثم 7 أيام، ثم أُضيف له 5 أيام تعويضاً. كم رصيده الآن؟ وضّح باختصار."}]
    for think in (False, True):
        rs = [chat_stream(q, think=think, max_tokens=8192) for _ in range(2)]
        out[f"latency_think_{'on' if think else 'off'}"] = {
            "ttf_answer_s": round(st.mean(r["ttf_answer"] or r["total"] for r in rs), 1),
            "total_s": round(st.mean(r["total"] for r in rs), 1), "tokens": round(st.mean(r["n_tokens"] for r in rs))}
    out["select10_on"] = test_select(n_select, sizes=(10,), think=True, tag="select_think")["10"]
    out["multi_on"] = test_multi(n_multi, think=True, tag="multi_think")
    put("think", out)
    return out


# ---------------------------------------------------------------- context window
def tokenize_count(text, base=None):
    r = lib.post((base or MAIN_URL).replace("/v1", "") + "/tokenize", {"content": text})
    return len(r["tokens"])


def test_context(sizes):
    corpus, _ = load_corpus()
    chunk_text = "\n\n".join(c["heading"] + "\n" + c["text"] for c in corpus)
    per_char = tokenize_count(chunk_text) / len(chunk_text)
    out = {}
    for target in sizes:
        nchars = int(target / per_char * 0.97)
        hay = (chunk_text + "\n\n") * (nchars // len(chunk_text) + 1)
        hay = hay[:nchars]
        pos = int(len(hay) * 0.37)
        needle = "\n\nملاحظة إدارية: رمز التحقق الخاص بمشروع الواحة هو 7391-ك، ويُستخدم في المراسلات الداخلية فقط.\n\n"
        doc = hay[:pos] + needle + hay[pos:]
        msgs = [{"role": "user", "content": doc + "\n\nسؤال: ما رمز التحقق الخاص بمشروع الواحة؟ أجب بالرمز فقط."}]
        t = time.time()
        try:
            m, raw, dt = chat(msgs, max_tokens=50, temperature=0)
            a = m.get("content") or ""
            out[str(target)] = {"prompt_tokens": raw["usage"]["prompt_tokens"], "found": "7391" in digits_only(a),
                                "answer": a[:60], "seconds": round(dt, 1),
                                "prefill_tps": round(raw.get("timings", {}).get("prompt_per_second", 0))}
        except Exception as ex:
            out[str(target)] = {"error": str(ex)[:300], "seconds": round(time.time() - t, 1)}
        print(target, out[str(target)], flush=True)
    put("context", out)
    return out


# ---------------------------------------------------------------- OCR
OCR_TEXT = """المملكة العربية السعودية
إدارة الشؤون الإدارية
تعميم رقم 4512 بتاريخ 12 جمادى الأولى 1448هـ
إلى جميع منسوبي الإدارة
نفيدكم بأنه تقرر اعتماد آلية جديدة لطلبات الإجازة عبر النظام الإلكتروني اعتباراً من بداية الشهر القادم،
ويجب تقديم طلب الإجازة السنوية قبل موعدها بسبعة أيام عمل على الأقل، ولا يُقبل الطلب الورقي إلا في الحالات الطارئة.
كما يلزم إرفاق التقرير الطبي للإجازة المرضية خلال ثلاثة أيام من تاريخ الانقطاع.
وتقبلوا تحياتنا،
مدير الإدارة: عبدالله الحربي"""

OCR_RENDER = r'''
import sys, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter
text = open(sys.argv[1], encoding="utf-8").read().splitlines()
font = ImageFont.truetype(sys.argv[3], 30, layout_engine=ImageFont.Layout.RAQM)
W, H = 1654, 1100
img = Image.new("L", (W, H), 245); d = ImageDraw.Draw(img)
y = 80
for line in text:
    d.text((W - 90, y), line, font=font, fill=20, anchor="ra", direction="rtl", language="ar"); y += 62
rng = random.Random(1)
px = img.load()
for _ in range(25000):
    x, yy = rng.randrange(W), rng.randrange(H); px[x, yy] = rng.choice([90, 160, 200])
img = img.rotate(1.3, resample=Image.BICUBIC, fillcolor=235).filter(ImageFilter.GaussianBlur(0.8))
img.save(sys.argv[2], quality=55)
'''


def lev(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def test_ocr():
    os.makedirs(os.path.join(DATA, "ocr"), exist_ok=True)
    tp, ip, sp = (os.path.join(DATA, "ocr", f) for f in ("truth.txt", "scan.jpg", "render.py"))
    open(tp, "w", encoding="utf-8").write(OCR_TEXT); open(sp, "w").write(OCR_RENDER)
    font = subprocess.run(["fc-match", "-f", "%{file}", "Noto Naskh Arabic"], capture_output=True, text=True).stdout
    subprocess.run([codegen.PY, "-I", sp, tp, ip, font], check=True)
    b64 = base64.b64encode(open(ip, "rb").read()).decode()
    msgs = [{"role": "user", "content": [
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}},
        {"type": "text", "text": "استخرج النص العربي من هذه الصورة الممسوحة كما هو حرفياً سطراً بسطر، بدون أي تعليق."}]}]
    m, raw, dt = chat(msgs, max_tokens=1500, temperature=0)
    got = m.get("content") or ""
    norm = lambda s: re.sub(r"\s+", " ", norm_ar(s)).strip()
    cer = lev(norm(got), norm(OCR_TEXT)) / len(norm(OCR_TEXT))
    open(os.path.join(DATA, "ocr", "output.txt"), "w", encoding="utf-8").write(got)
    out = {"cer_pct": round(cer * 100, 2), "seconds": round(dt, 1), "image": ip, "note": "synthetic rendered + noise/blur/rotation/JPEG; real scans need manual review"}
    put("ocr", out)
    return out


# ---------------------------------------------------------------- fast model
def test_fast(a):
    b, m = FAST_URL, FAST_MODEL
    out = {"format": test_format(min(a.n_format, 50), base=b, model=m, tag="fast_format"),
           "select": test_select(min(a.n_select, 30), sizes=(5, 10), base=b, model=m, tag="fast_select"),
           "cite": test_cite(min(a.n_cite, 30), base=b, model=m, tag="fast_cite"),
           "abstain": test_abstain(min(a.n_abstain, 30), base=b, model=m, tag="fast_abstain"),
           "multi": test_multi(min(a.n_multi, 10), base=b, model=m, tag="fast_multi"),
           "perf": test_perf(base=b, model=m, tag="fast_perf")}
    put("fast", {k: v for k, v in out.items() if k != "perf"})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tests", nargs="*")
    ap.add_argument("--n-format", type=int, default=100)
    ap.add_argument("--n-select", type=int, default=30)
    ap.add_argument("--n-multi", type=int, default=10)
    ap.add_argument("--n-code", type=int, default=10)
    ap.add_argument("--n-cite", type=int, default=40)
    ap.add_argument("--n-abstain", type=int, default=40)
    ap.add_argument("--n-think-select", type=int, default=15)
    ap.add_argument("--n-think-multi", type=int, default=10)
    ap.add_argument("--ctx", default="16000,64000,128000,250000")
    a = ap.parse_args()
    tests = a.tests or ["format", "select", "multi", "code", "cite", "abstain", "recall", "perf", "think", "context", "ocr", "fast"]
    for t in tests:
        t0 = time.time(); print(f"### {t}", flush=True)
        try:
          {"format": lambda: test_format(a.n_format), "select": lambda: test_select(a.n_select),
         "multi": lambda: test_multi(a.n_multi), "code": lambda: test_code(a.n_code),
         "cite": lambda: test_cite(a.n_cite), "abstain": lambda: test_abstain(a.n_abstain),
         "recall": test_recall, "perf": test_perf, "think": lambda: test_think(a.n_think_select, a.n_think_multi),
         "context": lambda: test_context([int(x) for x in a.ctx.split(",")]), "ocr": test_ocr,
         "fast": lambda: test_fast(a)}[t]()
        except Exception as ex:
            import traceback; traceback.print_exc(); put(t + "_error", str(ex)[:500])
        print(f"### {t} done in {time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
