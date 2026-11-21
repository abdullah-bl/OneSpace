// plans/15 bench: do facts said early in a long chat survive the summary? Each chat in
// chats.json is built from planted turns (facts, a decision that changes later, an output, an
// open item) between ordinary turns. Everything but the last 8 messages is folded into the summary
// in steps of 6, with the app's own prompt and parser (lib/chatSummary.ts) on the app's «fast»
// role, exactly as chat.ts compactThread does. The checks then read the final summary.
//
//   cd app && LLM_FAST_BASE_URL=http://127.0.0.1:9931/v1 LLM_FAST_MODEL="AtomicChat/LFM3-1.7B-Uncensored-GGUF:Q6_K" \
//     bun ../bench/summary/run.ts
//   The model the «fast» role uses on «مزوّدو النماذج» (here the llama.cpp router); any OpenAI-compatible
//   server works, with LLM_API_KEY for a hosted one.
//
// Summary → bench/results/summary_<model>.json (committed); each chat's final summary → bench/run/.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chat } from "../../app/onebase/ai";
import { outputLine, parseSummary, renderSummary, SUMMARY_SCHEMA, summaryPrompt, withCodeOutputs, type SummarySections } from "../../app/onebase/lib/chatSummary";

const DIR = import.meta.dir;
const RESULTS = join(DIR, "..", "results");
const RUN = join(DIR, "..", "run");
mkdirSync(RUN, { recursive: true });
const { fillers, chats } = JSON.parse(readFileSync(join(DIR, "chats.json"), "utf8"));
const model = process.env.LLM_FAST_MODEL ?? "(fast)";
const KEEP = 8; // the newest messages stay word for word
const STEP = 6; // folded in steps, as the window moves

type Msg = { role: string; text: string; action?: { tool: string; label: string; display?: string } };

/** The chat: each planted pair at its turn, ordinary turns everywhere else, 24 turns in all. */
function build(c: any): Msg[] {
  const out: Msg[] = [];
  let f = 0;
  for (let turn = 0; turn < 24; turn++) {
    const p = c.plant.find((x: any) => x.at === turn);
    const pair = p ? p.msgs : [fillers[f++ % fillers.length], fillers[f++ % fillers.length]];
    pair.forEach(([role, text]: [string, string], i: number) => out.push({ role, text, ...(p?.action && i === pair.length - 1 ? { action: p.action } : {}) }));
  }
  return out;
}

const rows: any[] = [];
for (const c of chats) {
  const msgs = build(c);
  const foldTo = msgs.length - KEEP;
  let prev: SummarySections | null = null;
  const ms: number[] = [];
  let failures = 0;
  for (let from = 0; from < foldTo; from += STEP) {
    const to = Math.min(foldTo, from + STEP);
    const t0 = Date.now();
    try {
      const r = await chat({ role: "fast", maxTokens: 1500, temperature: 0, jsonSchema: SUMMARY_SCHEMA, messages: summaryPrompt(prev, false, msgs.slice(from, to)) as any });
      // As chat.ts: the folded messages' executed actions, from the records.
      const outputs = msgs.slice(from, to).flatMap((m) => (m.action ? [outputLine(m.action)].filter(Boolean) : [])) as string[];
      const parsed = parseSummary(r.text);
      const next = parsed ? withCodeOutputs(parsed, [...(prev?.outputs ?? []), ...outputs]) : null;
      if (next) prev = next;
      else failures++;
    } catch (e) {
      failures++;
      console.error(c.id, "fold failed:", e instanceof Error ? e.message : e);
    }
    ms.push(Date.now() - t0);
  }
  const text = prev ? renderSummary(prev) : "";
  const checks = c.checks.map((k: any) => {
    const ok = (k.must ?? []).every((p: string) => new RegExp(p).test(text)) && !(k.mustNot ?? []).some((p: string) => new RegExp(p).test(text));
    return { id: k.id, ok };
  });
  rows.push({ id: c.id, folds: ms.length, failures, ms, chars: text.length, passed: checks.filter((x: any) => x.ok).length, of: checks.length, missed: checks.filter((x: any) => !x.ok).map((x: any) => x.id) });
  writeFileSync(join(RUN, `summary-${c.id}-${Date.now()}.txt`), text);
  console.log(`${c.id}: ${rows.at(-1).passed}/${checks.length}  missed: ${rows.at(-1).missed.join(", ") || "—"}  (${text.length} chars, ${failures} failed folds)`);
}
const all = rows.flatMap((r) => r.ms).sort((a, b) => a - b);
const summary = {
  model,
  chats: rows,
  passed: rows.reduce((n, r) => n + r.passed, 0),
  of: rows.reduce((n, r) => n + r.of, 0),
  foldMs: { n: all.length, p50: all[Math.floor(all.length / 2)] ?? 0, p90: all[Math.floor(all.length * 0.9)] ?? 0, max: all.at(-1) ?? 0 },
};
const safe = model.replace(/[^\w.-]+/g, "_");
writeFileSync(join(RESULTS, `summary_${safe}.json`), JSON.stringify(summary, null, 1));
console.log(`\n${model}: ${summary.passed}/${summary.of} checks; fold p50 ${summary.foldMs.p50} ms, p90 ${summary.foldMs.p90} ms`);
