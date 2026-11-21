// Phase 2 behaviour (plans/03-rag.md, plans/04 "المرحلة 2"): ingestion per file type with a
// visible status, versions/moves/deletes reflected in the index, cited and streamed answers,
// abstention, query rewriting, the GPU queue, the rate limit and the embedding-model guard.
// Model servers: the deterministic fake in tests/fake-ai.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must } from "./harness";
import { buildFixture, type Fixture } from "./fixture";
import { aiEnv, OCR_TEXT, startFakeAI, type FakeAI } from "./fake-ai";
import { addBytes, ask, docx, newThread, pdf, waitIngest, xlsx } from "./rag-helpers";

let ai: FakeAI;
let s: Server;
let f: Fixture;
const tok = (a: string) => (f.tokens as any)[a] as string;

beforeAll(async () => {
  ai = startFakeAI();
  // Small OCR settings so the batched OCR (several steps, a page limit) shows with a few pages.
  s = await new Server(undefined, aiEnv(ai, { OCR_MAX_PAGES: "5", OCR_BATCH_PAGES: "2", OCR_CONCURRENCY: "2" })).start();
  f = await buildFixture(s);
}, 60_000);

afterAll(async () => {
  await s?.stop();
  ai?.stop();
});

describe("ingestion: every type gets a visible status and lands in the index", () => {
  test("plain text: pending → ready, chunked with a context header", async () => {
    const id = await addBytes(s, tok("mgr"), f.spaces.S_every, "سياسة-العمل-عن-بعد.txt", "# سياسة العمل عن بعد\n## المادة 3\nيجوز العمل عن بعد يومين في الأسبوع TEXTKEY-1001 بموافقة المدير المباشر.", "text/plain");
    const first = must(await s.call("query", "ingest:statuses", { spaceId: f.spaces.S_every }, tok("rdr"))).find((x: any) => x.fileId === id);
    expect(["pending", "processing", "ready"]).toContain(first.state);
    const st = await waitIngest(s, tok("mgr"), f.spaces.S_every, id);
    expect(st).toMatchObject({ state: "ready", label: "جاهز", kind: "text", chunks: 1, ocr: false });
    const t = await newThread(s, tok("rdr"));
    const a = await ask(s, tok("rdr"), t, "كم يوماً يجوز العمل عن بعد TEXTKEY-1001؟");
    const c = a.citations.find((c: any) => c.fileId === id);
    expect(c).toBeTruthy();
    expect(c.fileName).toBe("سياسة-العمل-عن-بعد.txt");
    expect(c.section).toBe("سياسة العمل عن بعد › المادة 3");
    expect(c.quote).toContain("[سياسة-العمل-عن-بعد | سياسة العمل عن بعد › المادة 3]");
    expect(a.text).toMatch(/\[\d+\]/);
    expect(a.abstained).toBe(false);
  });

  test("Word .docx: headings become sections, tables stay whole, pages from rendered breaks", async () => {
    const bytes = docx([
      ["Title", "لائحة الإجازات"],
      ["Heading1", "الباب الثاني: الإجازات"],
      [null, "مقدمة الباب."],
      "PAGE",
      ["Heading2", "المادة 12: إجازة الأمومة"],
      [null, "تمنح الموظفة إجازة أمومة DOCXKEY-2002 مدتها سبعون يوماً براتب كامل."],
      { table: [["النوع", "المدة"], ["أمومة", "70 يوماً"]] },
    ]);
    const id = await addBytes(s, tok("mgr"), f.spaces.S_every, "لائحة-الإجازات.docx", bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(await waitIngest(s, tok("mgr"), f.spaces.S_every, id)).toMatchObject({ state: "ready", kind: "docx" });
    const t = await newThread(s, tok("out"));
    const a = await ask(s, tok("out"), t, "ما مدة إجازة الأمومة DOCXKEY-2002؟");
    const c = a.citations.find((c: any) => c.fileId === id && c.quote.includes("DOCXKEY-2002"));
    expect(c.section).toBe("الباب الثاني: الإجازات › المادة 12: إجازة الأمومة");
    expect(c.page).toBe(2);
    expect(c.quote).toContain("| أمومة | 70 يوما |");
  });

  test("text PDF keeps page numbers and drops running footers; a scanned page is read by the vision model and marked OCR", async () => {
    const bytes = pdf([
      ["Travel Policy", "Article 1: per diem PDFKEY-3003 is 500 riyals.", "Confidential footer"],
      ["Article 2: flights are economy class.", "Confidential footer"],
      "SCAN",
      ["Article 4: receipts within 30 days.", "Confidential footer"],
    ]);
    const id = await addBytes(s, tok("mgr"), f.spaces.S_every, "travel.pdf", bytes, "application/pdf");
    const st = await waitIngest(s, tok("mgr"), f.spaces.S_every, id);
    expect(st).toMatchObject({ state: "ready", kind: "pdf", ocr: true, pages: 4 });
    const t = await newThread(s, tok("out"));
    const a = await ask(s, tok("out"), t, "per diem PDFKEY-3003");
    const c = a.citations.find((c: any) => c.fileId === id);
    expect(c.page).toBe(1);
    expect(c.quote).not.toContain("Confidential footer");
    const ocr = await ask(s, tok("out"), t, "OCRWORD-4471 لائحة الأرشفة");
    const oc = ocr.citations.find((c: any) => c.fileId === id);
    expect(oc.quote).toContain("OCRWORD-4471");
    expect(oc.page).toBe(3);
    expect(ai.requests.some((r) => JSON.stringify(r.body).includes("image_url"))).toBe(true);
    expect(OCR_TEXT).toContain("OCRWORD-4471");
  });

  test("scanned pages are read in batches up to the page limit, and a retry reuses the pages already read", async () => {
    const images = () => ai.requests.filter((r) => JSON.stringify(r.body).includes("image_url")).length;
    const before = images();
    const bytes = pdf([["Scanned archive BATCHKEY-5150 cover page."], "SCAN", "SCAN", "SCAN", "SCAN", "SCAN", "SCAN", "SCAN"]);
    const id = await addBytes(s, tok("mgr"), f.spaces.S_every, "archive-scan.pdf", bytes, "application/pdf");
    const st = await waitIngest(s, tok("mgr"), f.spaces.S_every, id);
    // 7 scanned pages, limit 5: read in 3 batches (2+2+1), the rest noted on the file.
    expect(st).toMatchObject({ state: "ready", kind: "pdf", ocr: true, pages: 8, note: "قُرئت أول 5 صفحة ممسوحة فقط", ocrProgress: null });
    expect(images() - before).toBe(5);
    const t = await newThread(s, tok("out"));
    const a = await ask(s, tok("out"), t, "OCRWORD-4471 لائحة الأرشفة");
    const pages = a.citations.filter((c: any) => c.fileId === id).map((c: any) => c.page);
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) expect(p).toBeGreaterThanOrEqual(2);

    // Retry (same version): the saved pages are used, nothing is sent to the vision model again.
    const mid = images();
    must(await s.call("mutation", "ingest:retry", { fileId: id }, tok("mgr")));
    expect(await waitIngest(s, tok("mgr"), f.spaces.S_every, id)).toMatchObject({ state: "ready", ocr: true });
    expect(images()).toBe(mid);
  });

  test("Excel is described (sheets, columns, rows), not chunked as text", async () => {
    const bytes = xlsx("درجات الفصل", [["رقم الطالب", "الاسم", "المعدل"], ["4410", "سالم", "4.6"], ["4411", "نورة", "4.9"]]);
    const id = await addBytes(s, tok("mgr"), f.spaces.S_sens, "درجات-XLSKEY.xlsx", bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(await waitIngest(s, tok("mgr"), f.spaces.S_sens, id)).toMatchObject({ state: "ready", kind: "sheet", chunks: 1 });
    const t = await newThread(s, tok("mgr"), { kind: "file", id });
    const a = await ask(s, tok("mgr"), t, "ما أعمدة ورقة درجات الفصل؟");
    const c = a.citations.find((c: any) => c.fileId === id);
    expect(c.quote).toContain("الأعمدة: رقم الطالب، الاسم، المعدل");
    expect(c.quote).toContain("2 صفاً");
    expect(c.quote).not.toContain("سالم"); // the rows themselves are not indexed as text
  });

  test("an unsupported type is shown as not indexable", async () => {
    const id = await addBytes(s, tok("mgr"), f.spaces.S_plain, "archive.zip", new Uint8Array([80, 75, 5, 6, ...new Array(18).fill(0)]), "application/zip");
    expect(await waitIngest(s, tok("mgr"), f.spaces.S_plain, id)).toMatchObject({ state: "skipped", label: "لا يُفهرس" });
  });

  test("a failed ingest can be retried by a writer of the space", async () => {
    const id = await addBytes(s, tok("mgr"), f.spaces.S_plain, "empty.txt", "   ", "text/plain");
    const st = await waitIngest(s, tok("mgr"), f.spaces.S_plain, id);
    expect(st.state).toBe("failed");
    expect(st.error).toBeTruthy();
    expect((await s.call("mutation", "ingest:retry", { fileId: id }, tok("mem"))).ok).toBe(true);
    expect((await s.call("mutation", "ingest:retry", { fileId: id }, tok("rdr"))).ok).toBe(false);
  });
});

describe("the index follows the files", () => {
  test("a new version replaces the old chunks", async () => {
    const id = await addBytes(s, tok("mgr"), f.spaces.S_plain, "عقد-الصيانة.txt", "عقد الصيانة VERONE-111 مدته سنتان.", "text/plain");
    await waitIngest(s, tok("mgr"), f.spaces.S_plain, id);
    const t = await newThread(s, tok("mem"));
    expect((await ask(s, tok("mem"), t, "VERONE-111 مدة عقد الصيانة")).citations.some((c: any) => c.fileId === id)).toBe(true);
    const storageId = await s.upload(tok("mgr"), "عقد الصيانة VERTWO-222 مدته ثلاث سنوات.");
    must(await s.call("mutation", "files:uploadVersion", { fileId: id, storageId }, tok("mgr")));
    await Bun.sleep(30);
    expect((await waitIngest(s, tok("mgr"), f.spaces.S_plain, id)).state).toBe("ready");
    const old = await ask(s, tok("mem"), t, "VERONE-111");
    expect(JSON.stringify(old.citations)).not.toContain("VERONE-111");
    const now = await ask(s, tok("mem"), t, "VERTWO-222 مدة عقد الصيانة");
    expect(now.citations.find((c: any) => c.fileId === id)?.quote).toContain("ثلاث سنوات");
  });

  test("a deleted file disappears from search at once", async () => {
    const id = await addBytes(s, tok("mgr"), f.spaces.S_plain, "مؤقت.txt", "مذكرة مؤقتة DELKEY-555 عن الجرد السنوي.", "text/plain");
    await waitIngest(s, tok("mgr"), f.spaces.S_plain, id);
    const t = await newThread(s, tok("mem"));
    expect((await ask(s, tok("mem"), t, "DELKEY-555 الجرد السنوي")).citations.some((c: any) => c.fileId === id)).toBe(true);
    must(await s.call("mutation", "files:remove", { fileId: id }, tok("mgr")));
    const after = await ask(s, tok("mem"), t, "DELKEY-555 الجرد السنوي");
    expect(after.citations.some((c: any) => c.fileId === id)).toBe(false);
    // UX redesign: the default agent is a general assistant, so it answers in general terms
    // instead of abstaining; the deleted file's content still never reaches the answer.
    expect(after.text).not.toContain("مذكرة مؤقتة");
  });

  test("a file moved from my space to a shared one: its members find it, others still don't", async () => {
    const id = await addBytes(s, tok("mem"), undefined, "خطة-التدريب.txt", "خطة التدريب MOVEKEY-777 تشمل دورة القيادة في مارس.", "text/plain");
    await waitIngest(s, tok("mem"), f.spaces.P_mem, id);
    const tr = await newThread(s, tok("rdr"));
    expect((await ask(s, tok("rdr"), tr, "MOVEKEY-777 خطة التدريب")).citations.some((c: any) => c.fileId === id)).toBe(false);
    must(await s.call("mutation", "files:move", { fileId: id, toSpaceId: f.spaces.S_plain }, tok("mem")));
    const a = await ask(s, tok("rdr"), tr, "MOVEKEY-777 خطة التدريب");
    expect(a.citations.some((c: any) => c.fileId === id)).toBe(true);
    const to = await newThread(s, tok("out"));
    expect((await ask(s, tok("out"), to, "MOVEKEY-777 خطة التدريب")).citations.some((c: any) => c.fileId === id)).toBe(false);
  });
});

describe("answers", () => {
  // UX redesign (intentional change): chats are free-form. The default agent answers a general
  // question from general knowledge, with no citations and no abstention; a document-only agent
  // (السياسات) keeps the Phase 2 behaviour below.
  test("the default agent answers a general question without documents (no citations, no abstention)", async () => {
    const t = await newThread(s, tok("mem"));
    const before = ai.requests.length;
    const a = await ask(s, tok("mem"), t, "ما عاصمة البرازيل؟");
    expect(a.abstained).toBe(false);
    expect(a.citations).toEqual([]);
    expect(a.text).toContain("GENERALANSWER-1");
    const chats = ai.requests.slice(before).filter((r) => r.path === "/v1/chat/completions" && !r.body.response_format);
    expect(chats.length).toBe(1);
    // No unrelated passage was put in front of the model.
    expect(JSON.stringify(chats[0].body.messages)).not.toContain("(ملف:");
  });

  test("a document-only agent: a question outside the documents gets a clear abstention, without calling the model", async () => {
    const policies = must(await s.call("query", "agents:available", {}, tok("mem"))).find((a: any) => a.name === "السياسات")._id;
    const t = must(await s.call("mutation", "chat:createThread", { agentId: policies }, tok("mem")));
    const before = ai.requests.length;
    const a = await ask(s, tok("mem"), t, "ما عاصمة البرازيل؟");
    expect(a.abstained).toBe(true);
    expect(a.citations).toEqual([]);
    expect(a.text.startsWith("لم أجد هذا في المستندات المتاحة لك.")).toBe(true);
    const chats = ai.requests.slice(before).filter((r) => r.path === "/v1/chat/completions" && !r.body.response_format);
    expect(chats.length).toBe(0);
  });

  test("a follow-up is rewritten into a standalone query by the fast model (JSON-schema constrained)", async () => {
    const t = await newThread(s, tok("mem"));
    await ask(s, tok("mem"), t, "كم يوماً يجوز العمل عن بعد TEXTKEY-1001؟");
    const before = ai.requests.length;
    await ask(s, tok("mem"), t, "وبموافقة من؟");
    // The query rewrite (the router's JSON request comes first in an unpinned chat).
    const rw = ai.requests.slice(before).find((r) => JSON.stringify(r.body.response_format ?? "").includes('"query"'));
    expect(rw.body.model).toBe("fake-fast");
    expect(rw.body.response_format.type).toBe("json_schema");
    expect(JSON.stringify(rw.body.messages)).toContain("TEXTKEY-1001");
  });

  test("the answer streams while it is written, with the step shown as a label", async () => {
    const t = await newThread(s, tok("mem"));
    must(await s.call("mutation", "chat:send", { to: "assistant", threadId: t, text: "SLOW-TURN العمل عن بعد TEXTKEY-1001" }, tok("mem")));
    const labels = new Set<string>();
    let streamed = "";
    for (let i = 0; i < 300; i++) {
      const r = must(await s.call("query", "chat:messages", { threadId: t }, tok("mem")));
      if (r.turn?.label) labels.add(r.turn.label);
      if (r.turn?.streamId) streamed = must(await s.call("query", "chat:stream", { threadId: t, streamId: r.turn.streamId }, tok("mem"))).text || streamed;
      if (!r.turn) {
        expect(r.messages.at(-1).text).toContain(streamed.slice(0, 20));
        break;
      }
      await Bun.sleep(20);
    }
    expect([...labels].some((l) => ["يبحث في المستندات…", "يكتب الإجابة…", "يجهّز الإجابة…"].includes(l))).toBe(true);
    expect(streamed.length).toBeGreaterThan(0);
  });

  test("👍/👎 is saved on the message", async () => {
    const t = await newThread(s, tok("mem"));
    const a = await ask(s, tok("mem"), t, "TEXTKEY-1001");
    must(await s.call("mutation", "chat:feedback", { messageId: a.id, value: "down" }, tok("mem")));
    const r = must(await s.call("query", "chat:messages", { threadId: t }, tok("mem")));
    expect(r.messages.at(-1).feedback).toBe("down");
  });

  test("a thread scoped to a space only searches that space", async () => {
    const t = await newThread(s, tok("mem"), { kind: "space", id: f.spaces.S_plain });
    const a = await ask(s, tok("mem"), t, "كم يوماً يجوز العمل عن بعد TEXTKEY-1001؟"); // that policy is in S_every
    expect(a.citations.every((c: any) => !c.quote.includes("TEXTKEY-1001"))).toBe(true);
  });

  test("every AI turn is audited with the spaces whose content was used", async () => {
    const log = must(await s.call("query", "audit:list", { spaceId: f.spaces.S_every }, tok("mgr")));
    expect(log.some((r: any) => r.action === "ai.turn")).toBe(true);
  });
});

describe("model output hygiene", () => {
  test("tool-call / thinking markup written as text never reaches the saved answer", async () => {
    const { stripMarkup } = await import("../onebase/chat");
    expect(stripMarkup("<tool_call> <function=search_documents> <parameter=query> x </parameter> </function> </tool_call>")).toBe("");
    expect(stripMarkup("<think>hmm</think>الجواب [1]")).toBe("الجواب [1]");
  });
});

describe("GPU queue", () => {
  test("with 2 slots, a third simultaneous question waits (shown as queued) and then runs", async () => {
    const users = ["mem", "rdr", "out"];
    const threads = await Promise.all(users.map((u) => newThread(s, tok(u))));
    await Promise.all(users.map((u, i) => s.call("mutation", "chat:send", { to: "assistant", threadId: threads[i], text: "SLOW-TURN TEXTKEY-1001" }, tok(u))));
    let sawQueued = false;
    let done = 0;
    for (let i = 0; i < 400 && done < 3; i++) {
      done = 0;
      for (const [k, u] of users.entries()) {
        const r = must(await s.call("query", "chat:messages", { threadId: threads[k] }, tok(u)));
        if (r.turn?.state === "queued") sawQueued = true;
        if (!r.turn && r.messages.at(-1)?.role === "assistant") done++;
      }
      await Bun.sleep(25);
    }
    expect(sawQueued).toBe(true);
    expect(done).toBe(3);
  }, 30_000);
});

describe("rate limit and embedding-model guard (own server)", () => {
  let s2: Server;
  let ai2: FakeAI;
  let token: string;
  let space: string;
  beforeAll(async () => {
    ai2 = startFakeAI();
    s2 = await new Server(undefined, aiEnv(ai2, { CHAT_BURST: "2", CHAT_RATE_PER_MIN: "1" })).start();
    const u = await s2.auth("signUp", "boss@onespace.test", "password-123", "مدير");
    token = u.token;
    must(await s2.adminRun("admin:bootstrap", { email: "boss@onespace.test" }));
    space = must(await s2.call("query", "spaces:mine", {}, token))[0]._id;
  }, 30_000);
  afterAll(async () => {
    await s2?.stop();
    ai2?.stop();
  });

  test("per-user rate limit: the third quick question is refused with a wait time", async () => {
    const t = await newThread(s2, token);
    await ask(s2, token, t, "سؤال أول");
    await ask(s2, token, t, "سؤال ثان");
    const r = await s2.call("mutation", "chat:send", { to: "assistant", threadId: t, text: "سؤال ثالث" }, token);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("حاول بعد");
  });

  test("a different embedding model than the index was built with is refused (ingest and search)", async () => {
    const id = await addBytes(s2, token, undefined, "a.txt", "نص أول GUARDKEY", "text/plain");
    expect((await waitIngest(s2, token, space, id)).state).toBe("ready");
    await s2.stop(false);
    const s3 = new Server(s2.dataDir, aiEnv(ai2, { EMBED_MODEL: "another-embedder", CHAT_BURST: "100" }));
    s3.adminKey = s2.adminKey;
    await s3.start();
    s2 = s3;
    const b = await addBytes(s3, token, undefined, "b.txt", "نص ثان", "text/plain");
    const st = await waitIngest(s3, token, space, b);
    expect(st.state).toBe("failed");
    expect(st.error).toContain("إعادة الفهرسة");
    const t = await newThread(s3, token);
    must(await s3.call("mutation", "chat:send", { to: "assistant", threadId: t, text: "GUARDKEY" }, token));
    let err = "";
    for (let i = 0; i < 200 && !err; i++) {
      const r = must(await s3.call("query", "chat:messages", { threadId: t }, token));
      if (r.turn?.state === "failed") err = r.turn.error;
      await Bun.sleep(25);
    }
    expect(err).toContain("إعادة الفهرسة");
  }, 30_000);
});
