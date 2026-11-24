"""Summarizes results/*.json from run.py: one table per model × condition, then per-case failures."""
import glob, json, os
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
files = sorted(glob.glob(os.path.join(HERE, "results", "*.json")))
runs = [json.load(open(f)) for f in files]
COLS = ["ok", "right_tool", "no_call_when_needed", "abstain_right", "schema_valid", "args_right", "markup_leak", "prompt_tokens_avg", "secs_avg", "errors"]
print("| model | cond | " + " | ".join(COLS) + " |")
print("|" + "---|" * (len(COLS) + 2))
for r in runs:
    s = r["summary"]
    print(f"| {r['model'].split('/')[-1]} | {r['cond']} | " + " | ".join(str(s.get(c)) for c in COLS) + " |")

print("\n## Failures by case (model/cond → what it did)\n")
fails = defaultdict(list)
total = defaultdict(int)
for r in runs:
    for row in r["rows"]:
        total[row["id"]] += 1
        if row.get("ok"):
            continue
        what = row.get("error") or (f"called {row.get('tool')}" if row.get("tool") else "no tool call")
        detail = (row.get("schema_errors") or []) + (row.get("check_errors") or [])
        fails[row["id"]].append(f"{r['model'].split('/')[-1]}/{r['cond']}: {what}" + (f" — {'; '.join(detail)[:200]}" if detail else ""))
for cid in sorted(fails, key=lambda k: -len(fails[k])):
    print(f"- **{cid}** ({len(fails[cid])}/{total[cid]} runs failed)")
    for f in fails[cid]:
        print(f"  - {f}")
