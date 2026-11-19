// «استيراد مهارة»: a SKILL.md or a .zip of a skill's folder (skills.sh, GitHub) read into a draft by
// code; references and scripts kept as the skill's files; use_skill loads one by name.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must } from "./harness";
import { ACTORS, buildFixture, type Fixture } from "./fixture";
import { aiEnv, startFakeAI, type FakeAI } from "./fake-ai";
import { frontMatter, parseSkillPackage, skillName } from "../onebase/lib/skillImport";

/** A zip with stored (uncompressed) entries. */
function zip(files: Record<string, string | Uint8Array>): Uint8Array {
  const enc = new TextEncoder();
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const data = typeof body === "string" ? enc.encode(body) : body;
    const nameB = enc.encode(name);
    const l = new DataView(new ArrayBuffer(30));
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint32(14, crc(data), true);
    l.setUint32(18, data.length, true);
    l.setUint32(22, data.length, true);
    l.setUint16(26, nameB.length, true);
    const local = new Uint8Array([...new Uint8Array(l.buffer), ...nameB, ...data]);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint32(16, crc(data), true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, nameB.length, true);
    c.setUint32(42, offset, true);
    centrals.push(new Uint8Array([...new Uint8Array(c.buffer), ...nameB]));
    locals.push(local);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, centrals.length, true);
  e.setUint16(10, centrals.length, true);
  e.setUint32(12, cdSize, true);
  e.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const b of [...locals, ...centrals, new Uint8Array(e.buffer)]) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

const SKILL_MD = `---
name: pdf-forms
description: >
  Fill PDF forms from data. Use when the user
  asks to fill or extract a form.
license: MIT
---
# PDF Forms

Read references/forms.md first. Run scripts/fill.py on the file. IMPORT-BODY-1
`;

describe("reading a skill package", () => {
  test("front matter: plain, quoted and folded values", () => {
    const { meta, body } = frontMatter(`---\nname: "my skill"\ndescription: >\n  one\n  two\n---\nBody`);
    expect(meta).toEqual({ name: "my skill", description: "one two" });
    expect(body).toBe("Body");
    expect(skillName("My Skill!")).toBe("My-Skill");
  });

  test("a SKILL.md alone", () => {
    const s = parseSkillPackage("SKILL.md", new TextEncoder().encode(SKILL_MD));
    expect(s).toMatchObject({ name: "pdf-forms", title: "PDF Forms", description: "Fill PDF forms from data. Use when the user asks to fill or extract a form." });
    expect(s.instructions).toContain("IMPORT-BODY-1");
    expect(s.files).toEqual([]);
  });

  test("a zip: references and Python scripts kept; binaries, other folders and bad paths skipped", () => {
    const s = parseSkillPackage(
      "pdf-forms.zip",
      zip({
        "pdf-forms/SKILL.md": SKILL_MD,
        "pdf-forms/references/forms.md": "# Forms reference REF-1",
        "pdf-forms/scripts/fill.py": "print('fill')",
        "pdf-forms/scripts/setup.sh": "echo hi",
        "pdf-forms/assets/logo.png": new Uint8Array([137, 80, 78, 71, 0, 0]),
        "pdf-forms/../escape.md": "x",
        "other/notes.md": "x",
        "__MACOSX/pdf-forms/._SKILL.md": "x",
      }),
    );
    expect(s.name).toBe("pdf-forms");
    expect(s.files.map((f) => [f.name, f.kind])).toEqual([
      ["references/forms.md", "reference"],
      ["scripts/fill.py", "script"],
      ["scripts/setup.sh", "reference"],
    ]);
    expect(s.skipped.map((x) => x.path)).toEqual(expect.arrayContaining(["assets/logo.png", "other/notes.md"]));
    expect(JSON.stringify(s)).not.toContain("escape.md\",\"kind");
  });

  test("a long SKILL.md: the body is kept whole as a reference", () => {
    const body = `---\nname: long\ndescription: d\n---\n${"x".repeat(20_000)}END-LONG`;
    const s = parseSkillPackage("SKILL.md", new TextEncoder().encode(body));
    expect(s.instructions.length).toBeLessThan(1000);
    expect(s.files[0]).toMatchObject({ name: "SKILL.md", kind: "reference" });
    expect(s.files[0]!.content).toContain("END-LONG");
  });

  test("no SKILL.md, or not a zip: refused", () => {
    expect(() => parseSkillPackage("x.zip", zip({ "a/readme.md": "x" }))).toThrow();
    expect(() => parseSkillPackage("x.zip", new Uint8Array([1, 2, 3]))).toThrow();
  });
});

let ai: FakeAI;
let s: Server;
let f: Fixture;
const tok = (a: string) => (f.tokens as any)[a] as string | undefined;
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

describe("importing into the app", () => {
  beforeAll(async () => {
    ai = startFakeAI();
    s = await new Server(undefined, aiEnv(ai)).start();
    f = await buildFixture(s);
  }, 120_000);
  afterAll(async () => {
    await s?.stop();
    ai?.stop();
  });

  test("skills:parseImport: any active employee; it saves nothing", async () => {
    const data = b64(new TextEncoder().encode(SKILL_MD));
    for (const a of ACTORS) expect([a, (await s.call("action", "skills:parseImport", { fileName: "SKILL.md", dataBase64: data }, tok(a))).ok]).toEqual([a, !["pend", "dis", "anon"].includes(a)]);
    expect(must(await s.call("query", "skills:list", {}, tok("mem"))).some((x: any) => x.name === "pdf-forms")).toBe(false);
    expect((await s.call("action", "skills:parseImport", { fileName: "x.exe", dataBase64: data }, tok("mem"))).ok).toBe(false);
  });

  test("saved with its files (kinds checked, secrets masked); in a space a member's waits for a manager", async () => {
    const draft = must(await s.call("action", "skills:parseImport", { fileName: "pdf-forms.zip", dataBase64: b64(zip({ "pdf-forms/SKILL.md": SKILL_MD, "pdf-forms/references/forms.md": "# Forms REF-1\nkey sk-or-v1-0123456789abcdef0123456789abcdef0123", "pdf-forms/scripts/fill.py": "print(1)" })) }, tok("mem")));
    must(await s.call("mutation", "skills:create", { name: draft.name, title: draft.title, description: draft.description, instructions: draft.instructions, files: [...draft.files, { name: "../../evil.md", kind: "weird", content: "x" }] }, tok("mem")));
    const mine = must(await s.call("query", "skills:list", {}, tok("mem"))).find((x: any) => x.name === "pdf-forms");
    expect(mine.files.map((x: any) => [x.name, x.kind])).toEqual([
      ["references/forms.md", "reference"],
      ["scripts/fill.py", "script"],
      ["evil.md", "reference"],
    ]);
    expect(JSON.stringify(mine.files)).not.toContain("0123456789abcdef0123456789abcdef");
    const r = must(await s.call("mutation", "skills:addSpace", { spaceId: f.spaces.S_plain, name: "pdf-forms", title: draft.title, description: draft.description, instructions: draft.instructions, files: draft.files }, tok("mem")));
    expect(r.state).toBe("proposed");
  });

  test("use_skill lists the references and loads one by name", async () => {
    must(await s.call("mutation", "spaces:setInstructions", { spaceId: f.spaces.S_plain, instructions: 'CALL_TOOL use_skill {"name":"pdf-forms","file":"references/forms.md"}\nCALL_TOOL use_skill {"name":"pdf-forms"}' }, tok("mgr")));
    try {
      const t = must(await s.call("mutation", "chat:createThread", { spaceId: f.spaces.S_plain }, tok("mem")));
      must(await s.call("mutation", "chat:send", { threadId: t, text: "املأ النموذج IMP-Q1" }, tok("mem")));
      for (let i = 0; i < 800; i++) {
        const r = must(await s.call("query", "chat:messages", { threadId: t }, tok("mem")));
        if (!r.turn && r.messages.at(-1)?.role === "assistant") break;
        await Bun.sleep(25);
      }
    } finally {
      must(await s.call("mutation", "spaces:setInstructions", { spaceId: f.spaces.S_plain, instructions: "" }, tok("mgr")));
    }
    const sent = ai.requests.filter((r) => JSON.stringify(r.body.messages ?? []).includes("IMP-Q1")).map((r) => JSON.stringify(r.body.messages)).join();
    expect(sent).toContain("REF-1"); // the reference, loaded by name
    expect(sent).toContain("ملفات مرجعية للمهارة"); // and listed with the instructions
  }, 60_000);
});
