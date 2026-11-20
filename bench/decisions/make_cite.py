"""Builds bench/decisions/cite.json for plans/12 (citation checking) from the Phase-0 cite run.

Real answers of the main model (bench/results/cite.json, strict passes that cite only the gold
passage) with that passage as the cited source: these citations are correct. Ten of them get a
planted wrong citation: five cite a passage of another document on the nearest topic (unrelated),
five have the number in the answer changed (contradicts). Then five multi-citation answers made of
four of those each, renumbered. Deterministic; stdlib only."""
import json, os, re

ROOT = os.path.dirname(os.path.abspath(__file__))
BENCH = os.path.dirname(ROOT)
corpus = json.load(open(os.path.join(BENCH, "data", "corpus.json")))
qa = {q["question"]: q for q in json.load(open(os.path.join(BENCH, "data", "qa.json")))}
runs = json.load(open(os.path.join(BENCH, "results", "cite.json")))
by_id = {c["id"]: c for c in corpus}
words = lambda t: set(re.findall(r"[؀-ۿ]{4,}", t))

good = [r for r in runs if r["pass_strict"] and not r["abstained"] and r["cited"] == [r["gold"]] and r["q"] in qa][:20]
cases = []
NUM = r"(?<![\[\d])\d+(?![\]\d])"
digit_cases = [r for r in good if re.search(NUM, r["answer"])]
swap_ids = set(id(r) for r in [r for r in good if r not in digit_cases[:5]][:5])
num_ids = set(id(r) for r in digit_cases[:5])
for k, r in enumerate(good):
    chunk = by_id[qa[r["q"]]["chunk_id"]]
    n = r["gold"]
    answer = r["answer"].strip()
    passage = chunk["text"]
    planted = []
    if id(r) in swap_ids:
        # the nearest passage of another document: same words, different rule
        other = max((c for c in corpus if c["doc"] != chunk["doc"]), key=lambda c: len(words(c["text"]) & words(answer)))
        passage = other["text"]
        planted = [n]
    elif id(r) in num_ids:
        m = re.search(NUM, answer)
        changed = str(int(m.group()) * 2 + 3)
        answer = answer[: m.start()] + changed + answer[m.end():]
        planted = [n]
    cases.append({"id": f"cite-{k+1:02d}", "q": r["q"], "answer": answer, "passages": {str(n): passage}, "planted": planted})
# Multi-citation answers: four answers above joined into one, renumbered [1]..[4] (a small model
# judging several pairs in one call can drift by position; single-sentence answers don't show it).
for g in range(len(cases) // 4):
    group = cases[g * 4 : g * 4 + 4]
    parts, passages, planted = [], {}, []
    for j, c in enumerate(group, start=1):
        (old_n, passage), = c["passages"].items()
        parts.append(re.sub(r"\[" + old_n + r"\]", f"[{j}]", c["answer"]).strip())
        passages[str(j)] = passage
        if c["planted"]:
            planted.append(j)
    cases.append({"id": f"multi-{g+1:02d}", "q": None, "answer": "\n".join(f"- {p}" for p in parts), "passages": passages, "planted": planted})
json.dump({"about": __doc__.strip(), "cases": cases}, open(os.path.join(ROOT, "cite.json"), "w"), ensure_ascii=False, indent=1)
print(len(cases), "answers,", sum(1 for c in cases if c["planted"]), "planted")
