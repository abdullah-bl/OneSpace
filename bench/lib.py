"""Tiny shared helpers for the OneSpace Phase-0 bench. Stdlib only."""
import json, os, re, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
RESULTS = os.path.join(ROOT, "results")
os.makedirs(DATA, exist_ok=True)
os.makedirs(RESULTS, exist_ok=True)

MAIN_URL = os.environ.get("LLM_BASE_URL", "http://127.0.0.1:8401/v1")
MAIN_MODEL = os.environ.get("LLM_MODEL", "qwen3.8-27b")
FAST_URL = os.environ.get("LLM_FAST_BASE_URL", "http://127.0.0.1:8402/v1")
FAST_MODEL = os.environ.get("LLM_FAST_MODEL", "lfm3-1.7b")
EMBED_URL = os.environ.get("EMBED_BASE_URL", "http://127.0.0.1:8403/v1")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "embeddinggemma-2")
RERANK_URL = os.environ.get("RERANK_BASE_URL", "http://127.0.0.1:8404/v1")
CONCURRENCY = int(os.environ.get("BENCH_CONCURRENCY", "4"))
TEMPERATURE = float(os.environ.get("BENCH_TEMPERATURE", "0.6"))


def post(url, body, timeout=1800):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def chat(messages, tools=None, think=False, max_tokens=1024, base=None, model=None, temperature=None, **extra):
    """Returns (message dict, raw response, seconds)."""
    body = {
        "model": model or MAIN_MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": TEMPERATURE if temperature is None else temperature,
        "top_p": 0.95,
        "top_k": 20,
        "chat_template_kwargs": {"enable_thinking": bool(think)},
    }
    if tools:
        body["tools"] = tools
    body.update(extra)
    t = time.time()
    r = post((base or MAIN_URL) + "/chat/completions", body)
    return r["choices"][0]["message"], r, time.time() - t


def chat_stream(messages, think=False, max_tokens=256, base=None, model=None):
    """Streaming request; returns dict(ttft, total, n_tokens, decode_tps, prompt_tokens)."""
    body = {
        "model": model or MAIN_MODEL, "messages": messages, "max_tokens": max_tokens,
        "temperature": TEMPERATURE, "stream": True, "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"enable_thinking": bool(think)},
    }
    req = urllib.request.Request((base or MAIN_URL) + "/chat/completions", data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json"})
    t0 = time.time(); ttft = None; ttfa = None; usage = {}; timings = {}
    with urllib.request.urlopen(req, timeout=3600) as r:
        for line in r:
            line = line.decode().strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            ev = json.loads(payload)
            if ev.get("usage"):
                usage = ev["usage"]
            if ev.get("timings"):
                timings = ev["timings"]
            for ch in ev.get("choices", []):
                d = ch.get("delta", {})
                if (d.get("content") or d.get("reasoning_content")) and ttft is None:
                    ttft = time.time() - t0
                if d.get("content") and ttfa is None:
                    ttfa = time.time() - t0
    total = time.time() - t0
    n = usage.get("completion_tokens", 0)
    return {"ttft": ttft, "ttf_answer": ttfa, "total": total, "n_tokens": n,
            "prompt_tokens": usage.get("prompt_tokens"),
            "decode_tps": (n - 1) / (total - ttft) if ttft and n > 1 and total > ttft else None,
            "server_decode_tps": timings.get("predicted_per_second"),
            "server_prefill_tps": timings.get("prompt_per_second")}


def embed(texts, base=None, batch=64):
    out = []
    for i in range(0, len(texts), batch):
        r = post((base or EMBED_URL) + "/embeddings", {"model": EMBED_MODEL, "input": texts[i:i + batch]})
        out.extend(d["embedding"] for d in sorted(r["data"], key=lambda d: d["index"]))
    return out


def rerank(query, docs, base=None):
    r = post((base or RERANK_URL) + "/rerank", {"query": query, "documents": docs})
    return [x["relevance_score"] for x in sorted(r["results"], key=lambda x: x["index"])]


def pmap(fn, items, n=None):
    with ThreadPoolExecutor(n or CONCURRENCY) as ex:
        return list(ex.map(fn, items))


AR_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")


def norm_ar(s):
    s = (s or "").translate(AR_DIGITS)
    s = re.sub("[ً-ْـ]", "", s)  # tashkeel + tatweel
    s = re.sub("[إأآا]", "ا", s).replace("ى", "ي").replace("ة", "ه")
    s = s.replace("٬", ",").replace("،", ",")
    return s


def digits_only(s):
    return re.sub(r"(?<=\d)[,\s](?=\d{3}\b)", "", norm_ar(s))


def arabic_ratio(s):
    letters = [c for c in s if c.isalpha()]
    return sum(1 for c in letters if "؀" <= c <= "ۿ") / max(1, len(letters))


def save(name, obj):
    with open(os.path.join(RESULTS, name + ".json"), "w") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


def extract_json(text):
    m = re.search(r"\{.*\}", text or "", re.S)
    return json.loads(m.group(0)) if m else None
