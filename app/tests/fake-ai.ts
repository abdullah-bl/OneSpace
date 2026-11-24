// A deterministic, GPU-free stand-in for the model servers, speaking the OpenAI-compatible API
// (/v1/embeddings, /v1/rerank, /v1/chat/completions with SSE streaming and tool calls).
//
//  - embeddings: hashed bag of normalized Arabic tokens (so paraphrases sharing words match)
//  - rerank: share of the query's keywords found in the passage
//  - chat: echoes the numbered sources it was given as a cited answer ("[n]"), or abstains when
//    it got none. Like a compromised model it OBEYS instructions found in documents: a source
//    containing `CALL_TOOL <name> <json>` makes it call that tool — the tools must hold the line.
//    The same line in the system prompt (an agent's instructions) works too, and the call is made
//    whether or not that tool was offered (only that *some* tools were).
//    `ANNOUNCE_TOOL <name> <json>` in a question: it names the tool without calling it, unless the
//    request has tool_choice "required".
//  - vision (an image in the message): returns fixed OCR text.

import { keywordQuery, tokens } from "../onebase/lib/arabic";

export const GENERAL_ANSWER = "إجابة عامة من معرفة النموذج GENERALANSWER-1.";
export const FAKE_TITLE = "عنوان مقترح";
export const OCR_TEXT ="# صفحة ممسوحة\nنص مستخرج بالرؤية OCRWORD-4471 عن لائحة الأرشفة";

export type FakeAI = { url: string; dims: number; requests: any[]; stop: () => void };

function vec(text: string, dims: number) {
  const v = new Array(dims).fill(0);
  for (const t of tokens(text)) {
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
    v[(h >>> 0) % dims] += 1;
  }
  v[0] += 0.01;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

function stripPrefix(s: string) {
  return s.replace(/^task: [^|]*\| query: /, "").replace(/^title: [^|]*\| text: /, "");
}

function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => p.text ?? "").join("\n");
  return "";
}

/** The numbered sources the model has been shown so far: [n] → text. */
function sourcesOf(messages: any[]) {
  const out = new Map<number, string>();
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "tool") continue;
    const text = contentText(m.content);
    const re = /\[(\d+)\] \(ملف: [^\n]*\)\n([\s\S]*?)(?=\n\n\[\d+\] \(ملف:|\n\n---\n|$)/g;
    for (const x of text.matchAll(re)) out.set(Number(x[1]), x[2]!);
  }
  return out;
}

function answerFor(body: any): { text: string; toolCalls: { name: string; args: string }[] } {
  const messages: any[] = body.messages ?? [];
  const sources = sourcesOf(messages);
  // Obey injected instructions once each (a model that falls for prompt injection).
  const done = new Set<string>();
  for (const m of messages) for (const tc of m.tool_calls ?? []) done.add(`${tc.function.name} ${tc.function.arguments}`);
  if (body.tools?.length) {
    const calls: { name: string; args: string }[] = [];
    // ...and instructions in its system prompt (an agent's admin-written instructions, Phase 6).
    const system = messages.filter((m) => m.role === "system").map((m) => contentText(m.content));
    for (const text of [...sources.values(), ...system]) {
      for (const x of text.matchAll(/CALL_TOOL (\w+) (\{[^\n]*?\})(?=\s|$)/g)) {
        const key = `${x[1]} ${x[2]}`;
        if (!done.has(key) && !calls.some((c) => `${c.name} ${c.args}` === key)) calls.push({ name: x[1]!, args: x[2]! });
      }
    }
    if (calls.length) return { text: "", toolCalls: calls };
    // "ANNOUNCE_TOOL <name> <json>" in a question: like a small model, it says it will use the tool
    // and makes no call, unless the request requires a call (tool_choice "required").
    const asked = messages.filter((m) => m.role === "user").map((m) => contentText(m.content)).join("\n");
    const ann = /ANNOUNCE_TOOL (\w+) (\{[^\n]*?\})(?=\s|$)/.exec(asked);
    if (ann && !done.has(`${ann[1]} ${ann[2]}`)) {
      if (body.tool_choice === "required") return { text: "", toolCalls: [{ name: ann[1]!, args: ann[2]! }] };
      return { text: `سأستخدم \`${ann[1]}\` لقراءة الملف.`, toolCalls: [] };
    }
  }
  const question = contentText(messages.at(-1)?.role === "user" ? messages.at(-1).content : messages.findLast((m: any) => m.role === "user")?.content);
  // A general ("open") assistant answers from general knowledge when no file passage was given
  // (UX redesign); a document-only agent abstains. The general answer never echoes the question.
  const openMode = messages.some((m) => m.role === "system" && contentText(m.content).includes("تجيب عن أي سؤال"));
  // A model that copies an internal id into its answer: "ECHO-ID[<id>]" is written back as "[<id>]".
  const echo = /ECHO-ID\[([a-z0-9]+)\]/.exec(question);
  if (echo) return { text: `هذا هو الملف [${echo[1]}].`, toolCalls: [] };
  if (/ABSTAIN-PLEASE/.test(question)) return { text: "لم أجد هذا في المستندات المتاحة لك.", toolCalls: [] };
  if (sources.size === 0) return { text: openMode ? GENERAL_ANSWER : "لم أجد هذا في المستندات المتاحة لك.", toolCalls: [] };
  const parts = [...sources].slice(0, 4).map(([n, t]) => `${t.split("\n").slice(1).join(" ").slice(0, 160)} [${n}]`);
  return { text: `حسب المستندات: ${parts.join(" ")}`, toolCalls: [] };
}

export function startFakeAI(dims = 64): FakeAI {
  const requests: any[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/v1/models") return Response.json({ data: [{ id: "fake" }] });
      const body: any = await req.json().catch(() => ({}));
      requests.push({ path: url.pathname, body });
      if (url.pathname === "/v1/embeddings") {
        const input: string[] = Array.isArray(body.input) ? body.input : [body.input];
        return Response.json({ data: input.map((t, index) => ({ index, embedding: vec(stripPrefix(t), dims) })), model: body.model });
      }
      if (url.pathname === "/v1/rerank") {
        const q = new Set(keywordQuery(body.query).split(" ").filter(Boolean));
        const results = (body.documents as string[]).map((d, index) => {
          const dt = new Set(tokens(d));
          const hit = [...q].filter((t) => dt.has(t)).length;
          return { index, relevance_score: q.size ? hit / q.size : 0 };
        });
        return Response.json({ results });
      }
      if (url.pathname === "/v1/chat/completions") {
        const messages: any[] = body.messages ?? [];
        const last = contentText(messages.at(-1)?.content);
        // "SLOW-TURN" in the conversation: a slow model (≈1.5 s, streamed in pieces).
        const slow = /SLOW-TURN/.test(JSON.stringify(messages));
        if (slow) await Bun.sleep(300);
        // "CUT-TOOL-CALL" in the system prompt: the model's tool call runs past max_tokens and the
        // server fails to parse it (llama.cpp answers 500), until it's asked for a shorter one.
        const all = JSON.stringify(messages);
        if (body.tools?.length && /CUT-TOOL-CALL/.test(all) && !all.includes("انقطع استدعاء الأداة")) {
          return Response.json({ error: { code: 500, message: "Failed to parse tool call arguments as JSON: parse error - invalid string: missing closing quote", type: "server_error" } }, { status: 500 });
        }
        let text: string;
        let toolCalls: { name: string; args: string }[] = [];
        if (messages.some((m) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url"))) text = OCR_TEXT;
        else if (body.response_format && JSON.stringify(body.response_format).includes('"allowedTools"'))
          // AI-drafted agent (agentDrafts.ts): one unknown tool, to check it is dropped.
          text = JSON.stringify({ name: "وكيل العقود", description: "يراجع العقود DRAFTAGENT-1", instructions: "أنت تراجع العقود وتذكر المادة.", allowedTools: ["read_file", "search_documents", "run_shell"], dataScope: "member", grounding: "documents", maxSteps: 3 });
        else if (body.response_format && JSON.stringify(body.response_format).includes('"instructions"'))
          // AI-drafted skill (skills.draftFromThread): echoes a marker from the chat into the instructions.
          text = JSON.stringify({ name: "خطاب رسمي", title: "خطاب رسمي", description: "حين أطلب خطاباً", instructions: `اكتب بصيغة رسمية. ${/SKILLMARK-\d+/.exec(JSON.stringify(messages))?.[0] ?? ""}` });
        else if (body.response_format && JSON.stringify(body.response_format).includes('"parts"')) {
          // Sub-agent planner (plans/08 §A): two parts, on the first two agents offered.
          const names: string[] = body.response_format.json_schema?.schema?.properties?.parts?.items?.properties?.agent?.enum ?? [];
          text = JSON.stringify({ parts: [{ goal: "PART-A اقرأ الجزء الأول", agent: names[0] }, { goal: "PART-B اقرأ الجزء الثاني", agent: names[1] ?? names[0] }] });
        } else if (body.response_format && JSON.stringify(body.response_format).includes('"title"')) text = JSON.stringify({ title: FAKE_TITLE });
        else if (body.response_format && JSON.stringify(body.response_format).includes('"decisions"')) {
          // Chat summary (plans/15): the markers it saw become facts; "قررنا X" lines become decisions.
          const all = JSON.stringify(messages);
          const marks = [...all.matchAll(/[A-Z]+Q-\d+/g)].map((x) => x[0]).filter((x, i, a) => a.indexOf(x) === i);
          const decided = [...all.matchAll(/قررنا ([^"\\]+?)(?:\\n|")/g)].map((x) => x[1]!.trim());
          // Like a real model, it merges the previous summary (given as JSON) with the new messages.
          const userText = contentText(messages.at(-1)?.content);
          let prev: any = {};
          try {
            prev = JSON.parse(/الملخص السابق \(JSON\):\n(.*)\n\nالرسائل الجديدة/s.exec(userText)?.[1] ?? "{}");
          } catch {}
          const facts = [...new Set([...(prev.facts ?? []), ...marks.map((m) => `ذُكر ${m}`)])];
          text = JSON.stringify({ topics: `SUMMARY-OF ${marks.join(" ")}`, facts, decisions: [...new Set([...(prev.decisions ?? []), ...decided])], open: [], outputs: [] });
        }
        else if (body.response_format && JSON.stringify(body.response_format).includes('"skill"')) {
          // Router (plans/07 §C): "SKILL=<name>" in the request picks that skill; "SKILL-UNSURE" answers with
          // low confidence; otherwise the default (marked in the list).
          const sys = contentText(messages.find((m) => m.role === "system")?.content);
          const lines = [...sys.matchAll(/^(\d+)\. (.+?)(?: \(الافتراضي\))? — /gm)].map((x) => ({ n: Number(x[1]), name: x[2]!, def: x[0].includes("(الافتراضي)") }));
          const hit = [...lines].sort((a, b) => b.name.length - a.name.length).find((l) => last.includes(`SKILL=${l.name}`));
          const def = lines.find((l) => l.def) ?? lines[0];
          text = JSON.stringify({ skill: (hit ?? def)?.name ?? "", deep: /DEEP-Q/.test(last), split: /SPLIT-Q/.test(last), confidence: /SKILL-UNSURE/.test(last) ? 0.2 : 0.9 });
        } else if (body.response_format) text = JSON.stringify({ query: /السؤال الأخير: (.*)$/s.exec(last)?.[1]?.trim() ?? last });
        else ({ text, toolCalls } = answerFor(body));
        const usage = { prompt_tokens: 100, completion_tokens: 20 };
        if (!body.stream) {
          return Response.json({
            choices: [{ message: { role: "assistant", content: text, tool_calls: toolCalls.map((t, i) => ({ id: `c${i}`, type: "function", function: { name: t.name, arguments: t.args } })) }, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
            usage,
          });
        }
        const enc = new TextEncoder();
        const events: any[] = [];
        // Thinking on: some hidden reasoning first (llama.cpp sends it as reasoning_content).
        if (body.chat_template_kwargs?.enable_thinking) events.push({ choices: [{ index: 0, delta: { reasoning_content: "REASONING-HIDDEN" } }] });
        for (let i = 0; i < text.length; i += 12) events.push({ choices: [{ index: 0, delta: { content: text.slice(i, i + 12) } }] });
        toolCalls.forEach((t, i) => events.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${i}_${Date.now()}`, type: "function", function: { name: t.name, arguments: t.args } }] } }] }));
        events.push({ choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length ? "tool_calls" : "stop" }] });
        events.push({ choices: [], usage });
        return new Response(
          new ReadableStream({
            async start(c) {
              for (const e of events) {
                c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
                if (slow) await Bun.sleep(1200 / events.length);
              }
              c.enqueue(enc.encode("data: [DONE]\n\n"));
              c.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, dims, requests, stop: () => server.stop(true) };
}

/** Environment for a onebase server that talks to this fake. */
export function aiEnv(ai: FakeAI, extra: Record<string, string> = {}): Record<string, string> {
  return {
    LLM_BASE_URL: ai.url,
    LLM_MODEL: "fake-main",
    LLM_FAST_BASE_URL: ai.url,
    LLM_FAST_MODEL: "fake-fast",
    EMBED_BASE_URL: ai.url,
    EMBED_MODEL: "fake-embed",
    EMBED_DIMENSIONS: String(ai.dims),
    RERANK_BASE_URL: ai.url,
    RERANK_MODEL: "fake-rerank",
    RAG_ABSTAIN_SCORE: "0.2",
    GPU_SLOTS: "2",
    CHAT_RATE_PER_MIN: "10000",
    CHAT_BURST: "10000",
    // plans/12: no decision model unless a test sets one (decisions.test.ts). Nothing listens on
    // port 9, so every decision falls back to the code, which is today's behaviour: these tests
    // run that fallback path, and their request counts stay those of the main and fast models.
    LLM_DECIDE_BASE_URL: "http://127.0.0.1:9/v1",
    ...extra,
  };
}
