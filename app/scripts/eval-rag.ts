// RAG evaluation against the real models (plans/03-rag.md §6), bench-style: one command, one table.
// Starts a throwaway onebase server on a temp dir, ingests the golden documents through the real
// pipeline (.docx → extract → chunk → embed), then measures:
//   - Recall@10 (retrieval, after fusion + rerank) and Recall@10 before rerank (fused only)
//   - citation accuracy: share of citations in full answers that point at the gold section
//     (or quote the gold fact), and the share of answers citing the gold section at all
//   - abstention on questions with no answer, and false abstention on answerable ones
//   - time per turn
//
//   bun scripts/eval-rag.ts [--turns 60] [--concurrency 4] [--out eval/results.json]
// Model servers default to bench/servers.sh (ports 8401–8404); override with the usual env vars.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Server, must } from "../tests/harness";
import { addBytes, docx, newThread, waitIngest } from "../tests/rag-helpers";
import { foldLetters } from "../onebase/lib/arabic";

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : def;
};
const TURNS = Number(arg("turns", "60"));
const CONC = Number(arg("concurrency", "4"));
const OUT = resolve(import.meta.dir, "..", arg("out", `eval/results-${new Date().toISOString().slice(0, 10)}.json`));

const env: Record<string, string> = {
  LLM_BASE_URL: process.env.LLM_BASE_URL ?? "http://127.0.0.1:8401/v1",
  LLM_MODEL: process.env.LLM_MODEL ?? "qwen3.8-27b",
  LLM_FAST_BASE_URL: process.env.LLM_FAST_BASE_URL ?? "http://127.0.0.1:8402/v1",
  LLM_FAST_MODEL: process.env.LLM_FAST_MODEL ?? "lfm3-1.7b",
  EMBED_BASE_URL: process.env.EMBED_BASE_URL ?? "http://127.0.0.1:8403/v1",
  EMBED_MODEL: process.env.EMBED_MODEL ?? "embeddinggemma-2",
  EMBED_DIMENSIONS: process.env.EMBED_DIMENSIONS ?? "768",
  RERANK_BASE_URL: process.env.RERANK_BASE_URL ?? "http://127.0.0.1:8404/v1",
  RERANK_MODEL: process.env.RERANK_MODEL ?? "qwen3-reranker-0.6b",
  GPU_SLOTS: process.env.GPU_SLOTS ?? "4",
  CHAT_BURST: "100000",
  CHAT_RATE_PER_MIN: "100000",
  ...(process.env.RAG_ABSTAIN_SCORE ? { RAG_ABSTAIN_SCORE: process.env.RAG_ABSTAIN_SCORE } : {}),
  ...(process.env.EMBED_QUERY_PREFIX !== undefined ? { EMBED_QUERY_PREFIX: process.env.EMBED_QUERY_PREFIX } : {}),
  ...(process.env.EMBED_DOC_PREFIX !== undefined ? { EMBED_DOC_PREFIX: process.env.EMBED_DOC_PREFIX } : {}),
};

type Q = { id: string; question: string; answerable: boolean; file?: string; heading?: string; key?: string };
const golden: { docs: { title: string; file: string; sections: { heading: string; text: string }[] }[]; questions: Q[] } = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../eval/golden.json"), "utf8"),
);

const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : 0);
const digits = (s: string) => foldLetters(s).replace(/[^0-9]/g, " ").replace(/\s+/g, " ").trim();
/** The gold fact (bench "key") appears in the text: by its digits when it has any (≥2), else as folded words. */
const keyIn = (text: string, key: string) => {
  const d = digits(key);
  if (d.replace(/\s/g, "").length >= 2) return ` ${digits(text)} `.includes(` ${d} `);
  const k = foldLetters(key).trim();
  return k.length >= 3 && foldLetters(text).includes(k);
};
const isGold =(q: Q, h: { fileName: string; section?: string | null }) => h.fileName === q.file && (h.section ?? "").includes(q.heading!);

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

const s = await new Server(undefined, env).start();
try {
  const t0 = Date.now();
  const u = await s.auth("signUp", "eval@onespace.test", "password-123", "مقيّم");
  must(await s.adminRun("admin:bootstrap", { email: "eval@onespace.test" }));
  const space = must(await s.call("mutation", "admin:createSharedSpace", { name: "السياسات", managerId: u.userId, everyone: true }, u.token));

  // 1. Ingest the documents through the real pipeline.
  const ids: string[] = [];
  for (const d of golden.docs) {
    const parts: ([string | null, string])[] = [["Title", d.title]];
    for (const sec of d.sections) parts.push(["Heading1", sec.heading], [null, sec.text]);
    ids.push(await addBytes(s, u.token, space, d.file, docx(parts), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"));
  }
  for (const id of ids) {
    const st = await waitIngest(s, u.token, space, id, 600_000);
    if (st.state !== "ready") throw new Error(`ingest failed: ${JSON.stringify(st)}`);
  }
  const ingestS = (Date.now() - t0) / 1000;
  console.log(`ingested ${ids.length} documents in ${ingestS.toFixed(1)} s`);

  // 2. Retrieval: Recall@k over every answerable question.
  const answerable = golden.questions.filter((q) => q.answerable);
  const ret = await pool(answerable, CONC, async (q) => {
    const r = must(await s.adminRun("search:debugSearch", { userId: u.userId, query: q.question, limit: 10 }));
    const rank = (list: any[]) => {
      const i = list.findIndex((h) => isGold(q, h));
      return i < 0 ? 999 : i + 1;
    };
    return { id: q.id, reranked: rank(r.hits), fused: rank(r.candidates) };
  });
  const recall = (k: number, key: "reranked" | "fused") => pct(ret.filter((x) => x[key] <= k).length, ret.length);

  // 3. Full turns: citations and abstention.
  const sample = answerable.filter((_, i) => i % Math.max(1, Math.floor(answerable.length / TURNS)) === 0).slice(0, TURNS);
  const none = golden.questions.filter((q) => !q.answerable);
  const turnQs = [...sample, ...none];
  const turns = await pool(turnQs, CONC, async (q) => {
    const thread = await newThread(s, u.token);
    const start = Date.now();
    must(await s.call("mutation", "chat:send", { threadId: thread, text: q.question }, u.token));
    for (;;) {
      const r = must(await s.call("query", "chat:messages", { threadId: thread }, u.token));
      if (r.turn?.state === "failed") return { q, error: r.turn.error, ms: Date.now() - start };
      const m = r.messages.at(-1);
      if (!r.turn && m?.role === "assistant") return { q, m, ms: Date.now() - start };
      await Bun.sleep(200);
    }
  });

  const answered = turns.filter((t) => t.q.answerable);
  let cites = 0;
  let supported = 0;
  let goldCited = 0;
  let falseAbstain = 0;
  let keyInAnswer = 0;
  for (const t of answered) {
    if (!("m" in t) || !t.m) continue;
    const m = t.m;
    if (m.abstained) falseAbstain++;
    if (t.q.key && keyIn(m.text, t.q.key)) keyInAnswer++;
    let gold = false;
    for (const c of m.citations) {
      cites++;
      const ok = isGold(t.q, c) || (!!t.q.key && keyIn(c.quote, t.q.key));
      if (ok) supported++;
      if (isGold(t.q, c)) gold = true;
    }
    if (gold) goldCited++;
  }
  const noneTurns = turns.filter((t) => !t.q.answerable);
  const abstained = noneTurns.filter((t) => "m" in t && t.m?.abstained).length;
  const errors = turns.filter((t) => "error" in t).length;
  const ms = turns.map((t) => t.ms).sort((a, b) => a - b);

  const summary = {
    date: new Date().toISOString(),
    models: { main: env.LLM_MODEL, fast: env.LLM_FAST_MODEL, embed: env.EMBED_MODEL, rerank: env.RERANK_MODEL },
    corpus: { documents: golden.docs.length, ingestSeconds: Math.round(ingestS) },
    retrieval: {
      questions: ret.length,
      "recall@10": recall(10, "reranked"),
      "recall@6 (context given to the model)": recall(6, "reranked"),
      "recall@1": recall(1, "reranked"),
      "recall@10 fused, before rerank": recall(10, "fused"),
      "recall@30 fused": recall(30, "fused"),
    },
    answers: {
      turns: answered.length,
      "citation accuracy (cited source supports the answer)": pct(supported, cites),
      "gold section cited": pct(goldCited, answered.length),
      "key fact in answer": pct(keyInAnswer, answered.length),
      "false abstention": pct(falseAbstain, answered.length),
    },
    abstention: { questions: noneTurns.length, "correct abstention": pct(abstained, noneTurns.length) },
    latency: { "median turn s": ms.length ? ms[Math.floor(ms.length / 2)]! / 1000 : null, "p90 turn s": ms.length ? ms[Math.floor(ms.length * 0.9)]! / 1000 : null },
    errors,
  };
  console.log(JSON.stringify(summary, null, 2));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        summary,
        retrieval: ret,
        turns: turns.map((t) => ({ id: t.q.id, q: t.q.question, ms: t.ms, error: "error" in t ? t.error : undefined, answer: "m" in t ? t.m.text : undefined, abstained: "m" in t ? t.m.abstained : undefined, citations: "m" in t ? t.m.citations.map((c: any) => ({ n: c.n, file: c.fileName, section: c.section })) : undefined, gold: t.q.answerable ? `${t.q.file} › ${t.q.heading}` : null })),
      },
      null,
      1,
    ),
  );
  console.log(`written ${OUT}`);
} finally {
  await s.stop();
}
