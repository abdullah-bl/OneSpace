// plans/17 §3: Word templates. Reading {{variables}} that Word split across runs, filling them
// (escaped, deterministic), and keeping dates/codes readable in Arabic lines.

import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { bidiSafe, fillDocx, mergeParagraph, sampleDocx, variablesOf } from "../onebase/lib/docxTemplate";

const documentXml = async (bytes: Uint8Array) => (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");

describe("docx templates", () => {
  test("a variable split across runs is rejoined into the run it starts in; other text stays in its run", () => {
    const p = `<w:p><w:r><w:t>الاسم: {{ال</w:t></w:r><w:proofErr w:type="spellStart"/><w:r><w:rPr><w:b/></w:rPr><w:t>اسم}} و{{</w:t></w:r><w:r><w:t>الدورة}}</w:t></w:r></w:p>`;
    expect(mergeParagraph(p)).toBe(
      `<w:p><w:r><w:t xml:space="preserve">الاسم: {{الاسم}}</w:t></w:r><w:proofErr w:type="spellStart"/><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"> و{{الدورة}}</w:t></w:r><w:r><w:t xml:space="preserve"></w:t></w:r></w:p>`,
    );
    const untouched = `<w:p><w:r><w:t>{{الاسم}}</w:t></w:r><w:r><w:t>نص</w:t></w:r></w:p>`;
    expect(mergeParagraph(untouched)).toBe(untouched);
  });

  test("variables are read in order, with spaces around the name ignored", async () => {
    const bytes = await sampleDocx("شهادة", ["الاسم", "full name"]);
    expect(await variablesOf(bytes)).toEqual(["الاسم", "full name", "الرقم_التسلسلي", "رمز_التحقق", "تاريخ_الإصدار"]);
  });

  test("filling escapes values, leaves unknown variables as written, and gives the same bytes for the same data", async () => {
    const bytes = await sampleDocx("شهادة", ["الاسم", "الدورة"]);
    const values = { الاسم: `سارة <ب> & "ج"`, الرقم_التسلسلي: "OS-2026-000001" };
    const a = await fillDocx(bytes, values);
    const b = await fillDocx(bytes, values);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    const xml = await documentXml(a);
    expect(xml).toContain("سارة &lt;ب&gt; &amp; &quot;ج&quot;");
    expect(xml).toContain("{{الدورة}}");
    expect(xml).toContain("‎OS-2026-000001‎");
    expect(await variablesOf(a)).toEqual(["الدورة", "رمز_التحقق", "تاريخ_الإصدار"]);
  });

  test("a file that isn't a Word document is refused with a reason", async () => {
    await expect(variablesOf(new TextEncoder().encode("hello"))).rejects.toThrow("الملف ليس ملف وورد");
  });

  test("dates, serials and codes keep their order in an Arabic line; Arabic and plain numbers are left alone", () => {
    expect(bidiSafe("2026-11-22")).toBe("‎2026-11-22‎");
    expect(bidiSafe("ABCD-EFGH-JKLM")).toBe("ABCD-EFGH-JKLM"); // no digits: nothing to reorder
    expect(bidiSafe("OS-2026-000001")).toBe("‎OS-2026-000001‎");
    expect(bidiSafe("سارة")).toBe("سارة");
    expect(bidiSafe("30")).toBe("30");
  });
});
