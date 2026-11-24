// plans/12 bench: the decision model against the code it replaces, with the app's own prompts
// (onebase/decisions.ts) and fallbacks (onebase/lib/route.ts).
//
//   cd app && LLM_DECIDE_BASE_URL=http://127.0.0.1:8095/v1 LLM_DECIDE_MODEL=lfm3-1.7b-decide \
//     bun ../bench/decisions/run.ts route|cite|guard|tool|all
//
// Summaries go to bench/results/decisions_<set>.json (committed); every case's raw decision to
// bench/run/ (not committed).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkCites, guardText, routeTurn, type GuardSource } from "../../app/onebase/decisions";
import { makingRequest } from "../../app/onebase/lib/route";
import type { DecisionLog } from "../../app/onebase/ai";

const DIR = import.meta.dir;
const RESULTS = join(DIR, "..", "results");
const RUN = join(DIR, "..", "run");
mkdirSync(RUN, { recursive: true });
const load = (f: string) => JSON.parse(readFileSync(join(DIR, f), "utf8"));
const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : 0);
const stats = (ms: number[]) => {
  const s = [...ms].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return { n: s.length, p50: q(0.5), p90: q(0.9), max: s.at(-1) ?? 0, mean: Math.round(s.reduce((a, b) => a + b, 0) / (s.length || 1)) };
};
const model = process.env.LLM_DECIDE_MODEL ?? "(fast)";

async function route() {
  const { cases } = load("route.json");
  const rows: any[] = [];
  for (const c of cases) {
    const history = (c.history ?? []).map(([role, text]: [string, string]) => ({ role, text }));
    let log: DecisionLog | undefined;
    const r = await routeTurn(c.q, history, null, { log: (l) => (log = l) });
    const regex = !makingRequest(c.q);
    rows.push({ id: c.id, group: c.group, q: c.q, gold: { needsFiles: c.needsFiles, effort: c.effort }, regex, decision: r, ms: log?.ms, why: log?.why, keys: c.keys ?? null });
  }
  const ok = rows.filter((r) => r.decision);
  const groups = [...new Set(rows.map((r) => r.group))];
  const by = Object.fromEntries(
    groups.map((g) => {
      const rs = rows.filter((r) => r.group === g);
      return [g, { n: rs.length, regex: pct(rs.filter((r) => r.regex === r.gold.needsFiles).length, rs.length), decision: pct(rs.filter((r) => r.decision && r.decision.needsFiles === r.gold.needsFiles).length, rs.length) }];
    }),
  );
  const lightPred = ok.filter((r) => r.decision.effort === "light");
  const lightGold = rows.filter((r) => r.gold.effort === "light");
  const follow = rows.filter((r) => r.keys);
  const summary = {
    model,
    cases: rows.length,
    answered: ok.length,
    fallbacks: rows.length - ok.length,
    needsFiles: {
      regex: pct(rows.filter((r) => r.regex === r.gold.needsFiles).length, rows.length),
      // a fallback counts as what the app then does: the regex
      decision: pct(rows.filter((r) => (r.decision ? r.decision.needsFiles : r.regex) === r.gold.needsFiles).length, rows.length),
      missedFiles: { regex: rows.filter((r) => r.gold.needsFiles && !r.regex).length, decision: rows.filter((r) => r.gold.needsFiles && r.decision && !r.decision.needsFiles).length },
      needlessSearch: { regex: rows.filter((r) => !r.gold.needsFiles && r.regex).length, decision: rows.filter((r) => !r.gold.needsFiles && r.decision?.needsFiles).length },
    },
    byGroup: by,
    effortLight: { predicted: lightPred.length, correct: lightPred.filter((r) => r.gold.effort === "light").length, gold: lightGold.length, wrongLight: lightPred.filter((r) => r.gold.effort !== "light").map((r) => r.id) },
    // what the app does with it: light also needs no make-request (regex), at most 200 characters,
    // and history or a very short message (chat.ts: lightCandidate / LIGHT_*)
    effortLightApplied: (() => {
      const applied = lightPred.filter((r) => !makingRequest(r.q) && r.q.length <= 200 && (cases.find((c: any) => c.id === r.id).history || r.q.length <= 20));
      return { applied: applied.length, correct: applied.filter((r) => r.gold.effort === "light").length, wrongLight: applied.filter((r) => r.gold.effort !== "light").map((r) => r.id) };
    })(),
    // null query: a typed decision model writes none, and rewriteQuery writes it in the app
    followUpQuery: { n: follow.length, written: follow.filter((r) => r.decision?.query).length, keptKeys: follow.filter((r) => r.decision?.query && r.keys.every((k: string) => r.decision.query.includes(k))).length },
    latencyMs: stats(rows.map((r) => r.ms ?? 0)),
    errors: rows.filter((r) => r.decision && r.decision.needsFiles !== r.gold.needsFiles).map((r) => ({ id: r.id, q: r.q, gold: r.gold.needsFiles, got: r.decision.needsFiles })),
  };
  writeFileSync(join(RUN, `route-${Date.now()}.json`), JSON.stringify(rows, null, 1));
  return summary;
}

async function cite() {
  const { cases } = load("cite.json");
  const rows: any[] = [];
  for (const c of cases) {
    let log: DecisionLog | undefined;
    const r = await checkCites(c.answer, new Map(Object.entries(c.passages).map(([n, t]) => [Number(n), t as string])), { log: (l) => (log = l), ...(c.q ? { question: c.q } : {}), ...(process.env.CITE_MODE ? { mode: process.env.CITE_MODE as "each" | "one" } : {}) });
    const marked = r ? Object.fromEntries(r.marks) : null;
    rows.push({ id: c.id, planted: c.planted ?? [], marked, ms: log?.ms, why: log?.why });
  }
  const planted = rows.flatMap((r) => r.planted.map((n: number) => ({ id: r.id, n, caught: !!r.marked?.[n] })));
  const clean = rows.flatMap((r) => Object.keys(load("cite.json").cases.find((c: any) => c.id === r.id).passages).map(Number).filter((n) => !r.planted.includes(n)).map((n) => ({ id: r.id, n, marked: !!r.marked?.[n] })));
  const part = (pre: string) => {
    const ps = planted.filter((p) => p.id.startsWith(pre));
    const cs = clean.filter((c) => c.id.startsWith(pre));
    return { planted: `${ps.filter((p) => p.caught).length}/${ps.length}`, wronglyMarked: `${cs.filter((c) => c.marked).length}/${cs.length}` };
  };
  const summary = {
    model,
    mode: process.env.CITE_MODE ?? "each",
    singleCitation: part("cite-"),
    multiCitation: part("multi-"),
    answers: rows.length,
    answered: rows.filter((r) => r.marked).length,
    planted: { n: planted.length, caught: planted.filter((p) => p.caught).length, missed: planted.filter((p) => !p.caught).map((p) => `${p.id}[${p.n}]`) },
    correctCitations: { n: clean.length, wronglyMarked: clean.filter((c) => c.marked).length, which: clean.filter((c) => c.marked).map((c) => `${c.id}[${c.n}]`) },
    latencyMs: stats(rows.map((r) => r.ms ?? 0)),
  };
  writeFileSync(join(RUN, `cite-${Date.now()}.json`), JSON.stringify(rows, null, 1));
  return summary;
}

async function guard() {
  const { cases } = load("guard.json");
  const rows: any[] = [];
  for (const c of cases) {
    let log: DecisionLog | undefined;
    const r = await guardText(c.text, c.source as GuardSource, { log: (l) => (log = l) });
    rows.push({ id: c.id, source: c.source, lang: c.lang, planted: c.planted, flagged: r?.steering ?? null, quote: r?.quote ?? null, ms: log?.ms, why: log?.why });
  }
  const planted = rows.filter((r) => r.planted);
  const ordinary = rows.filter((r) => !r.planted);
  const bySource = Object.fromEntries(
    ["skill", "file", "reply"].map((s) => [s, { planted: `${planted.filter((r) => r.source === s && r.flagged).length}/${planted.filter((r) => r.source === s).length}`, falsePositives: `${ordinary.filter((r) => r.source === s && r.flagged).length}/${ordinary.filter((r) => r.source === s).length}` }]),
  );
  const summary = {
    model,
    cases: rows.length,
    answered: rows.filter((r) => r.flagged !== null).length,
    recall: { flagged: planted.filter((r) => r.flagged).length, n: planted.length, missed: planted.filter((r) => !r.flagged).map((r) => r.id) },
    falsePositiveRate: { flagged: ordinary.filter((r) => r.flagged).length, n: ordinary.length, pct: pct(ordinary.filter((r) => r.flagged).length, ordinary.length), which: ordinary.filter((r) => r.flagged).map((r) => r.id) },
    bySource,
    latencyMs: stats(rows.map((r) => r.ms ?? 0)),
  };
  writeFileSync(join(RUN, `guard-${Date.now()}.json`), JSON.stringify(rows, null, 1));
  return summary;
}

/** needsTool (chat.ts forces a first tool call on it): a false "true" forces a needless call, so precision matters most. */
async function tool() {
  const { cases } = load("tool.json");
  const rows: any[] = [];
  for (const c of cases) {
    let log: DecisionLog | undefined;
    const r = await routeTurn(c.q, [], null, { log: (l) => (log = l) });
    rows.push({ id: c.id, q: c.q, gold: c.needsTool, got: r?.needsTool ?? null, ms: log?.ms });
  }
  const answered = rows.filter((r) => r.got !== null);
  const tp = answered.filter((r) => r.gold && r.got).length;
  const fp = answered.filter((r) => !r.gold && r.got).length;
  const fn = answered.filter((r) => r.gold && !r.got).length;
  const summary = {
    model,
    threshold: process.env.DECIDE_NEEDS_TOOL_THRESHOLD ?? "0.5 (default)",
    date: new Date().toISOString().slice(0, 10),
    n: rows.length,
    noDecision: rows.length - answered.length,
    accuracy: pct(answered.filter((r) => r.got === r.gold).length, answered.length),
    precision: pct(tp, tp + fp),
    recall: pct(tp, tp + fn),
    falseTrue: answered.filter((r) => !r.gold && r.got).map((r) => r.q),
    missed: answered.filter((r) => r.gold && !r.got).map((r) => r.q),
    latencyMs: stats(rows.map((r) => r.ms ?? 0)),
  };
  writeFileSync(join(RUN, `tool-${Date.now()}.json`), JSON.stringify(rows, null, 1));
  return summary;
}

const which = process.argv[2] ?? "all";
const sets: Record<string, () => Promise<unknown>> = { route, cite, guard, tool };
for (const name of which === "all" ? Object.keys(sets) : [which]) {
  const s = await sets[name]!();
  writeFileSync(join(RESULTS, `decisions_${name}${process.env.DECIDE_TAG ? `_${process.env.DECIDE_TAG}` : ""}.json`), JSON.stringify(s, null, 1) + "\n");
  console.log(name, JSON.stringify(s, null, 1));
}
