// Documents: an output (Markdown / HTML / table) → Word, PDF, PowerPoint, rendered by the real
// sandbox-runner (image module onespace_doc), with Arabic right-to-left. Also the export_document
// agent tool (proposal → نفّذ → file saved in the output's space) and editing an output.
// Skipped when Docker or the sandbox image is missing.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { Server, must } from "./harness";
import { buildFixture, type Fixture } from "./fixture";
import { aiEnv, startFakeAI, type FakeAI } from "./fake-ai";
import { ask, waitIngest } from "./rag-helpers";
import { cfg, proposalsOf, publishedAgent } from "./agents-helpers";
import { sandboxAvailable, startRunner, type Runner } from "./sandbox";

const HAS_SANDBOX = await sandboxAvailable();
if (!HAS_SANDBOX) console.warn("[docs] Docker or sandbox image missing: document rendering tests skipped");

let ai: FakeAI;
let s: Server;
let f: Fixture;
let runner: Runner | undefined;
const tok = (a: string) => (f.tokens as any)[a] as string;

const MD = `# تقرير الموظفين DOCMARK-1

ملخص **مهم** عن الإدارات، مع كلمة English في الوسط.

## الإدارات

- الشؤون القانونية: 55
- تقنية المعلومات: 54
  - فرعي

1. أولاً
2. ثانياً

| الإدارة | العدد |
| --- | --- |
| المالية | 43 |
| الموارد البشرية | 41 |

## Notes

Plain English paragraph.
`;

beforeAll(async () => {
  ai = startFakeAI();
  if (HAS_SANDBOX) runner = await startRunner();
  s = await new Server(undefined, aiEnv(ai)).start();
  f = await buildFixture(s);
}, 120_000);

afterAll(async () => {
  await s?.stop();
  ai?.stop();
  await runner?.stop();
});

async function markdownArtifact(token: string, title: string, content = MD, spaceId?: string) {
  return must(await s.call("mutation", "artifacts:create", { title, kind: "markdown", content, ...(spaceId ? { spaceId } : {}) }, token)).artifactId as string;
}

async function exported(token: string, artifactId: string, format: "docx" | "pdf" | "pptx") {
  const r = must(await s.call("action", "artifacts:exportDocument", { artifactId, format }, token));
  return { ...r, bytes: Buffer.from(r.base64, "base64") };
}

async function zipText(bytes: Buffer, prefix: string) {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((n) => n.startsWith(prefix) && n.endsWith(".xml")).sort();
  return { names, xml: (await Promise.all(names.map((n) => zip.file(n)!.async("string")))).join("\n") };
}

describe.skipIf(!HAS_SANDBOX)("export to Word / PDF / PowerPoint", () => {
  test("Word: headings, lists, table, bold; Arabic paragraphs and tables are right-to-left", async () => {
    const id = await markdownArtifact(tok("mem"), "تقرير DOCX");
    const r = await exported(tok("mem"), id, "docx");
    expect(r.fileName).toBe("تقرير DOCX.docx");
    expect(r.mime).toContain("wordprocessingml");
    const { xml } = await zipText(r.bytes, "word/document");
    for (const text of ["تقرير الموظفين DOCMARK-1", "الشؤون القانونية: 55", "الموارد البشرية", "Plain English paragraph."]) expect(xml).toContain(text);
    expect(xml).toContain('<w:bidi w:val="1"/>'); // Arabic paragraphs
    expect(xml).toContain('<w:bidi w:val="0"/>'); // the English one stays left-to-right
    expect(xml).toContain("<w:bidiVisual/>"); // Arabic table: first column on the right
    expect(xml).toContain("<w:bCs/>"); // bold Arabic run
    expect(xml).toMatch(/w:val="Heading1"|w:val="Heading 1"/);
    expect(xml).toMatch(/ListBullet|ListNumber/);
  }, 60_000);

  test("PowerPoint: a title slide, one slide per heading, Arabic text right-to-left", async () => {
    const id = await markdownArtifact(tok("mem"), "عرض PPTX");
    const r = await exported(tok("mem"), id, "pptx");
    expect(r.fileName).toBe("عرض PPTX.pptx");
    const { names, xml } = await zipText(r.bytes, "ppt/slides/slide");
    // title slide (from the leading # heading) + "الإدارات" (bullets) + its table + "Notes"
    expect(names.length).toBe(4);
    expect(xml).toContain("تقرير الموظفين DOCMARK-1");
    expect(xml).toContain("الشؤون القانونية: 55");
    expect(xml).toContain('rtl="1"');
    expect(xml).toContain("<a:tbl>");
    expect(xml).toContain("Plain English paragraph.");
  }, 60_000);

  test("PDF: Arabic text is shaped with an embedded Arabic font and extractable", async () => {
    const id = await markdownArtifact(tok("mem"), "تقرير PDF");
    const r = await exported(tok("mem"), id, "pdf");
    expect(r.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const tool = async (cmd: string[]) => {
      try {
        const p = Bun.spawn(cmd, { stdin: r.bytes, stdout: "pipe", stderr: "ignore" });
        const out = await new Response(p.stdout).text();
        return (await p.exited) === 0 ? out : null;
      } catch {
        return null; // poppler-utils not installed
      }
    };
    const path = `${process.env.TMPDIR ?? "/tmp"}/docs-test-${Date.now()}.pdf`;
    await Bun.write(path, r.bytes);
    const fonts = await tool(["pdffonts", path]);
    if (fonts !== null) expect(fonts).toMatch(/Noto-?(Naskh|Sans)-?Arabic/);
    const text = await tool(["pdftotext", path, "-"]);
    if (text !== null) {
      expect(text).toContain("DOCMARK-1");
      expect(text).toContain("المالية");
    }
  }, 60_000);

  test("tables export through Markdown; HTML only prints to PDF", async () => {
    const table = must(await s.call("mutation", "artifacts:create", { title: "جدول", kind: "table", content: JSON.stringify({ columns: ["الاسم", "العدد"], rows: [["سارة | س", 3]] }) }, tok("mem"))).artifactId;
    const { xml } = await zipText((await exported(tok("mem"), table, "docx")).bytes, "word/document");
    expect(xml).toContain("سارة | س");
    const html = must(await s.call("mutation", "artifacts:create", { title: "صفحة", kind: "html", content: "<h1>صفحة HTMLMARK</h1><img src='http://example.com/x.png'>" }, tok("mem"))).artifactId;
    expect((await exported(tok("mem"), html, "pdf")).bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const docx = await s.call("action", "artifacts:exportDocument", { artifactId: html, format: "docx" }, tok("mem"));
    expect(docx.ok).toBe(false);
  }, 60_000);

  test("exporting a sensitive output is audited", async () => {
    const id = await markdownArtifact(tok("mgr"), "حساس للتصدير", "# سري", f.spaces.S_sens);
    await exported(tok("mgr"), id, "docx");
    const log = must(await s.call("query", "audit:list", { userId: f.ids.mgr, limit: 200 }, tok("admin")));
    expect(log.some((x: any) => x.action === "artifact.export" && x.resourceId === id)).toBe(true);
  }, 60_000);
});

describe.skipIf(!HAS_SANDBOX)("export_document tool (agent, after نفّذ)", () => {
  const call = (json: string) => `CALL_TOOL export_document ${json}`;

  test("from Markdown into my personal space: runs without asking (tier 1), and «تراجع» removes the file and the output", async () => {
    const id = await publishedAgent(s, tok("admin"), cfg({ name: "كاتب مستندات", allowedTools: ["export_document"], maxSteps: 2, instructions: call('{"format":"docx","title":"مذكرة TOOLDOC-2","content":"# مذكرة\\n\\nنص المذكرة TOOLDOC-2"}') }));
    const t = must(await s.call("mutation", "chat:createThread", { agentId: id }, tok("mem")));
    await ask(s, tok("mem"), t, "اكتب مذكرة بصيغة Word");
    const [p] = await proposalsOf(s, tok("mem"), t);
    expect(p.tool).toBe("export_document");
    expect(p.state).toBe("executed");
    expect(p.auto).toBe(true);
    expect(p.tier).toBe(1);
    // The card shows a line for the user; ids and details stay in the text meant for the model.
    expect(p.display).toContain("مذكرة TOOLDOC-2.docx");
    expect(p.display).not.toMatch(/artifactId=|fileId=/);
    const personal = must(await s.call("query", "spaces:mine", {}, tok("mem"))).find((x: any) => x.kind === "personal")._id;
    const files = () => s.call("query", "files:list", { spaceId: personal }, tok("mem")).then((r) => must(r).filter((x: any) => x.name === "مذكرة TOOLDOC-2.docx"));
    const arts = () => s.call("query", "artifacts:list", { spaceId: personal }, tok("mem")).then((r) => must(r).filter((a: any) => a.title === "مذكرة TOOLDOC-2"));
    expect((await files()).length).toBe(1);
    expect((await files())[0].mime).toContain("wordprocessingml");
    // Indexed like an upload, so the assistant can read and search what it made.
    expect((await waitIngest(s, tok("mem"), personal, (await files())[0]._id)).state).toBe("ready");
    expect((await arts()).length).toBe(1);
    // Undo: someone else can't; the owner can, once.
    expect((await s.call("mutation", "chat:undo", { proposalId: p.id }, tok("mgr"))).ok).toBe(false);
    must(await s.call("mutation", "chat:undo", { proposalId: p.id }, tok("mem")));
    expect(await files()).toEqual([]);
    expect(await arts()).toEqual([]);
    expect((await proposalsOf(s, tok("mem"), t))[0].state).toBe("undone");
    // The removed output gets no chip any more (opening it would fail and break the chat page).
    expect((await proposalsOf(s, tok("mem"), t))[0].artifactIds).toEqual([]);
    expect((await s.call("mutation", "chat:undo", { proposalId: p.id }, tok("mem"))).ok).toBe(false);
    // The ids reach the model on the next question (hidden note), never the visible answer.
    const msgs = must(await s.call("query", "chat:messages", { threadId: t }, tok("mem"))).messages;
    expect(msgs.at(-1).text).not.toMatch(/artifactId=|fileId=/);
    await ask(s, tok("mem"), t, "عدّل المذكرة FOLLOWUP-9");
    const next = ai.requests.filter((q) => q.path === "/v1/chat/completions" && JSON.stringify(q.body.messages).includes("FOLLOWUP-9"));
    expect(next.some((q) => JSON.stringify(q.body.messages).includes(`artifactId=${p.artifactIds[0]}`))).toBe(true);
  }, 60_000);

  test("into a shared space: a card that waits for «نفّذ» (tier 2); after it the chat line has no ids, the model still gets them", async () => {
    const art = await markdownArtifact(tok("mgr"), "مذكرة مشتركة TOOLDOC-3", "# مشتركة", f.spaces.S_plain);
    const id = await publishedAgent(s, tok("admin"), cfg({ name: "مصدّر مشترك", allowedTools: ["export_document"], maxSteps: 2, instructions: call(`{"format":"pdf","artifactId":"${art}"}`) }));
    const t = must(await s.call("mutation", "chat:createThread", { agentId: id }, tok("mem")));
    await ask(s, tok("mem"), t, "صدّرها PDF");
    const [p] = await proposalsOf(s, tok("mem"), t);
    expect(p.state).toBe("pending");
    expect(p.tier).toBe(2);
    const r = must(await s.call("action", "chat:confirmProposal", { proposalId: p.id }, tok("mem")));
    expect(r.ok).toBe(true);
    const files = must(await s.call("query", "files:list", { spaceId: f.spaces.S_plain }, tok("mgr")));
    expect(files.some((x: any) => x.name === "مذكرة مشتركة TOOLDOC-3.pdf")).toBe(true);
    const msgs = must(await s.call("query", "chat:messages", { threadId: t }, tok("mem"))).messages;
    expect(msgs.at(-1).text).toContain("✅ نُفّذ");
    expect(msgs.at(-1).text).not.toMatch(/artifactId=|fileId=/);
    await ask(s, tok("mem"), t, "وماذا بعد FOLLOWUP-10");
    const next = ai.requests.filter((q) => q.path === "/v1/chat/completions" && JSON.stringify(q.body.messages).includes("FOLLOWUP-10"));
    expect(next.some((q) => JSON.stringify(q.body.messages).includes(`artifactId=${art}`))).toBe(true);
    // A confirmed (tier 2) action can't be undone this way.
    expect((await s.call("mutation", "chat:undo", { proposalId: p.id }, tok("mem"))).ok).toBe(false);
  }, 60_000);

  test("a reader can download an output but the tool can't save a file in a space they only read", async () => {
    const art = await markdownArtifact(tok("mgr"), "للقارئ", "# نص", f.spaces.S_plain);
    expect((await exported(tok("rdr"), art, "pdf")).bytes.length).toBeGreaterThan(0);
    const id = await publishedAgent(s, tok("admin"), cfg({ name: "مصدّر", allowedTools: ["export_document"], maxSteps: 2, instructions: call(`{"format":"pdf","artifactId":"${art}"}`) }));
    const t = must(await s.call("mutation", "chat:createThread", { agentId: id }, tok("rdr")));
    await ask(s, tok("rdr"), t, "صدّر المخرج");
    const [p] = await proposalsOf(s, tok("rdr"), t);
    const r = must(await s.call("action", "chat:confirmProposal", { proposalId: p.id }, tok("rdr")));
    expect(r.ok).toBe(false);
    const files = must(await s.call("query", "files:list", { spaceId: f.spaces.S_plain }, tok("mgr")));
    expect(files.some((x: any) => x.name === "للقارئ.pdf")).toBe(false);
  }, 60_000);
});

describe("editing an output", () => {
  test("each save is a new version; tables can't be edited as text; readers can't edit", async () => {
    const id = await markdownArtifact(tok("mgr"), "قابل للتعديل", "# الأولى", f.spaces.S_plain);
    must(await s.call("mutation", "artifacts:edit", { artifactId: id, content: "# الثانية" }, tok("mgr")));
    const v = must(await s.call("query", "artifacts:versions", { artifactId: id }, tok("mgr")));
    expect(v.artifact.currentVersion).toBe(2);
    expect(must(await s.call("mutation", "artifacts:open", { artifactId: id, version: 1 }, tok("mgr"))).content).toBe("# الأولى");
    expect(must(await s.call("mutation", "artifacts:open", { artifactId: id }, tok("mgr"))).content).toBe("# الثانية");
    expect((await s.call("mutation", "artifacts:edit", { artifactId: id, content: "x" }, tok("rdr"))).ok).toBe(false);
    const table = must(await s.call("mutation", "artifacts:create", { title: "ج", kind: "table", content: JSON.stringify({ columns: ["a"], rows: [["b"]] }) }, tok("mem"))).artifactId;
    expect((await s.call("mutation", "artifacts:edit", { artifactId: table, content: "x" }, tok("mem"))).ok).toBe(false);
  });
});
