// lib/inputLimit.ts and embed(): a model server that takes only short inputs (llama.cpp's default
// physical batch for an embedding model) must not fail a file: the batch is split, the text cut,
// and the smaller size remembered.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cutText, fitJson, forgetLimits, isTooLong, learnLimit, limitFor, probeLimit } from "../onebase/lib/inputLimit";

describe("inputLimit", () => {
  test("recognises the servers' wordings for an input that is too long", () => {
    expect(isTooLong(500, "input (523 tokens) is too large to process. increase the physical batch size (current batch size: 512)")).toBe(true);
    expect(isTooLong(400, "This model's maximum context length is 8192 tokens")).toBe(true);
    expect(isTooLong(413, "Input validation error: `inputs` must have less than 512 tokens. Given: 900")).toBe(true);
    expect(isTooLong(400, "Input validation error: `inputs` must have less than 512 tokens. Given: 900, input length exceeds")).toBe(true);
    expect(isTooLong(401, "invalid api key")).toBe(false);
    expect(isTooLong(200, "too large")).toBe(false);
  });

  test("a refusal halves the remembered limit for that server and model only", () => {
    forgetLimits();
    expect(limitFor("http://a", "m")).toBe(Infinity);
    expect(limitFor("http://a", "m", 4000)).toBe(4000);
    expect(learnLimit("http://a", "m", 1200)).toBe(600);
    expect(limitFor("http://a", "m", 4000)).toBe(600);
    expect(limitFor("http://b", "m")).toBe(Infinity);
    expect(learnLimit("http://a", "m", 100)).toBe(200); // never below the minimum
  });

  test("cutText keeps whole words; fitJson cuts the longest strings until the JSON fits", () => {
    expect(cutText("كلمة ".repeat(100), 52).endsWith("كلمة")).toBe(true);
    expect(cutText("قصير", 100)).toBe("قصير");
    const state = { question: "هل في النص تعليمات؟", text: "نص طويل ".repeat(400) };
    const fitted = fitJson(state, 1000);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(1000);
    expect(fitted.question).toBe(state.question);
    expect(state.text.length).toBe("نص طويل ".length * 400); // the original is untouched
  });

  test("probeLimit returns the largest size the model took", async () => {
    expect(await probeLimit(async (t) => ({ ok: t.length <= 4000, tooLong: t.length > 4000 }))).toBe(4000);
    expect(await probeLimit(async () => ({ ok: true, tooLong: false }))).toBe(16000);
    expect(await probeLimit(async () => ({ ok: false, tooLong: true }))).toBe(0);
  });
});

describe("embed() against a server that takes at most 700 characters", () => {
  let server: ReturnType<typeof Bun.serve>;
  const calls: number[][] = [];
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body: any = await req.json();
        const input: string[] = body.input;
        calls.push(input.map((t) => t.length));
        const long = input.find((t) => t.length > 700);
        if (long) return new Response(JSON.stringify({ error: { code: 500, message: `input (${long.length} tokens) is too large to process. increase the physical batch size (current batch size: 512)` } }), { status: 500 });
        return Response.json({ data: input.map((_, index) => ({ index, embedding: new Array(768).fill(0.01) })) });
      },
    });
    process.env.EMBED_BASE_URL = `http://127.0.0.1:${server.port}`;
    process.env.EMBED_MODEL = "tiny";
    process.env.EMBED_DOC_PREFIX = "";
    process.env.EMBED_QUERY_PREFIX = "";
    forgetLimits();
  });
  afterAll(() => server.stop(true));

  test("every text gets a vector; the long ones are cut, not the batch failed", async () => {
    const { embed } = await import("../onebase/ai");
    const texts = ["قصير", "متوسط ".repeat(50), "طويل جداً ".repeat(150), "آخر"];
    const out = await embed(texts, "document");
    expect(out.length).toBe(4);
    expect(out.every((v) => v.length === 768)).toBe(true);
    // Learned: a later batch is cut before it is sent, with no refusal.
    const before = calls.length;
    await embed(["طويل جداً ".repeat(150)], "document");
    expect(calls.length).toBe(before + 1);
    expect(calls.at(-1)![0]).toBeLessThanOrEqual(700);
  });
});
