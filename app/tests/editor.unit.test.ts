// The visual editor's conversion (plans/19): nothing is lost between Markdown and the editor.

import { describe, expect, test } from "bun:test";
import { getSchema, type JSONContent } from "@tiptap/core";
import { draftSource, openDocument, saveDocument, unchanged } from "../src/editor/document";
import { editorExtensions } from "../src/editor/extensions";
import { blockJson, clean, docJson, type Block, type Span } from "../src/editor/model";
import { plainMarked, seen } from "../src/editor/read";

/** Through the editor's real schema, as the screen does. */
function edited(source: string, change: (nodes: JSONContent[]) => void = () => {}) {
  const open = openDocument(source);
  const json = structuredClone(open.json);
  change(json.content!);
  const node = getSchema(editorExtensions({ kept: open.kept })).nodeFromJSON(json);
  node.check();
  return saveDocument(open, node.toJSON() as JSONContent);
}
const p = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
const write = (blocks: Block[]) => {
  const open = openDocument("");
  return saveDocument(open, getSchema(editorExtensions({ kept: open.kept })).nodeFromJSON(docJson(blocks)).toJSON() as JSONContent);
};
const shows = (md: string) => seen(plainMarked.parse(md) as string);

const EDITABLE: Record<string, string> = {
  heading: "# تقرير الربع\n",
  softbreak: "السيد: أحمد\nالمحترم\n",
  escapedStar: "السعر 5\\*3 ريال\n",
  entities: "&lt;b&gt; و A&amp;B و x < y\n",
  fileName: "الملف budget_2026_final.csv\n",
  escapedHash: "\\# ليس عنواناً\n",
  escapedNumber: "2026\\. سنة الإنجاز\n",
  bold: "**المجموع:** 150 ألف\n",
  boldInWord: "بـ **150 ألف** ريال\n",
  nested: "***مهم*** و~~ملغى~~ و`code_x`\n",
  link: "راجع [اللائحة](https://example.com/a \"العنوان\")\n",
  boldLink: "**[اللائحة](https://example.com)**\n",
  reference: "[الموقع][r]\n\n[r]: https://example.com\n",
  address: "الموقع https://example.com/a_b?x=1&y=2 والبريد first_last@example.com\n",
  hardBreak: "سطر  \nثان\n",
  bullets: "- أول\n- ثان\n",
  loose: "- أول\n\n- ثان\n",
  start: "3. ثالث\n4. رابع\n",
  arabicDigits: "١. أول\n٢. ثان\n",
  nestedList: "1. أول\n   - فرع\n   - فرع ثان\n2. ثان\n",
  tasks: "- [ ] أول\n- [x] ثان\n",
  quote: "> اقتباس\n> ثان\n",
  code: "```py\nprint('``')\n```\n",
  rule: "---\n",
  table: "| البند | المبلغ |\n|:--|--:|\n| التدريب | **150** |\n",
  emptyCell: "| أ | ب |\n|---|---|\n|  | 2 |\n",
  pipeInCell: "| أ | ب |\n|---|---|\n| x \\| y | 2 |\n",
  breakInCell: "| أ | ب |\n|---|---|\n| سطر<br>ثان | 2 |\n",
};

const LOCKED: Record<string, string> = {
  singleTilde: "من ~5~ إلى 7", // struck out in the preview, plain in Word
  html: '<div align="center">بسم الله</div>',
  comment: "<!-- ملاحظة -->",
  image: "![شعار](data:image/png;base64,AAAA)",
  inlineImage: "الشعار ![شعار](logo.png) هنا",
  inlineHtml: "نص <u>تحته خط</u>",
  definition: "[r]: https://example.com",
  unsafeLink: "[اضغط](javascript:alert(1))",
  imageInList: "- أول\n- ![صورة](a.png)",
  mixedTasks: "- [ ] مهمة\n- عادي",
  unknownEntity: "سهم &rarr; هنا",
};

describe("nothing edited", () => {
  for (const [name, md] of Object.entries({ ...EDITABLE, ...LOCKED }))
    test(`${name}: saved byte for byte`, () => expect(edited(md).markdown).toBe(md));

  for (const md of ["", "\n\n", "  \n# أ\n\n\n\nنص\n\n", "# أ\r\n\r\nنص\r\n", "# أ\nنص بلا سطر فارغ", "---\ntitle: x\n---\n\nنص\n", "﻿# أ\n"])
    test(`${JSON.stringify(md)}: saved byte for byte`, () => expect(edited(md).markdown).toBe(md));
});

describe("editable", () => {
  for (const [name, md] of Object.entries(EDITABLE))
    test(`${name}: can be edited, and written again reads the same`, () => {
      const open = openDocument(md);
      const editable = open.parts.filter((x) => x.block.t !== "keep").map((x) => x.block);
      // only a link's definition is locked here
      expect(open.parts.length - editable.length).toBe(name === "reference" ? 1 : 0);
      const { markdown, lossy } = write(editable);
      expect(lossy).toBe(false);
      expect(openDocument(markdown).parts.map((x) => x.block)).toEqual(editable);
      if (name !== "reference") expect(shows(markdown)).toBe(shows(md));
    });
});

describe("locked", () => {
  for (const [name, md] of Object.entries(LOCKED))
    test(`${name}: locked, and survives edits around it`, () => {
      const src = `قبل\n\n${md}\n\nبعد\n`;
      expect(openDocument(src).kept.size).toBe(1);
      const out = edited(src, (n) => {
        n[0] = p("قبل معدّل");
        n[2] = p("بعد معدّل");
      }).markdown;
      expect(out).toBe(`قبل معدّل\n\n${md}\n\nبعد معدّل\n`);
    });

  test("deleting it on purpose removes it", () => {
    expect(edited("قبل\n\n<div>x</div>\n\nبعد\n", (n) => void n.splice(1, 1)).markdown).toBe("قبل\n\nبعد\n");
  });

  test("an id from another document is refused", () => {
    const open = openDocument("نص");
    expect(() => saveDocument(open, { type: "doc", content: [{ type: "keep", attrs: { id: "other-0" } }] })).toThrow();
  });

  test("can't be put inside a list", () => {
    const open = openDocument("<div>x</div>");
    const id = [...open.kept.keys()][0];
    const schema = getSchema(editorExtensions({ kept: open.kept }));
    const json = { type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [p("أ"), { type: "keep", attrs: { id } }] }] }] };
    expect(() => schema.nodeFromJSON(json).check()).toThrow();
  });
});

describe("edits", () => {
  const REPORT = "# تقرير الربع\n## المصروفات\n* أول\n* ثان\n\n| أ|ب |\n|---|---|\n|1|2|\n\n\n<!-- داخلي -->\nنص   بمسافات\nوسطر\n\nالأخير\n";

  test("one paragraph changes and every other byte stays", () => {
    expect(edited(REPORT, (n) => (n[n.length - 1] = p("الأخير معدّل"))).markdown).toBe(REPORT.replace("الأخير", "الأخير معدّل"));
  });

  test("a CRLF document stays CRLF", () => {
    expect(edited("# أ\r\n\r\nنص\r\n\r\nآخر\r\n", (n) => (n[1] = p("جديد"))).markdown).toBe("# أ\r\n\r\nجديد\r\n\r\nآخر\r\n");
  });

  test("two lists that come to touch stay two lists", () => {
    for (const src of ["- أ\n\nبينهما\n\n- ب\n", "1. أ\n\nبينهما\n\n1. ب\n", "- أ\n\nبينهما\n\n- [x] ب\n"]) {
      const out = edited(src, (n) => void n.splice(1, 1)).markdown;
      expect(openDocument(out).parts.length).toBe(2);
    }
  });

  test("a deleted link definition takes the address into the link", () => {
    const out = edited("[الموقع][r]\n\n[r]: https://example.com\n", (n) => void n.splice(1, 1)).markdown;
    expect(out).toContain("[الموقع](https://example.com)");
  });

  test("typed syntax is text", () => {
    for (const text of ["# ليس عنواناً", "- ليس قائمة", "2026. سنة", "**ليس عريضاً**", "[ليس](https://x.com)", "<script>alert(1)</script>", "<!-- ظاهر -->", "| ليس | جدولاً |", "a\\b", "&lt;", "---", "===", "> ليس اقتباساً", "```", "~~~", "[r]: https://x.com", "![x](y.png)", "+ 5", "www.example.com/a_b"]) {
      const { markdown, lossy } = write([{ t: "p", spans: [{ s: text }] }]);
      expect(lossy).toBe(false);
      expect(openDocument(markdown).parts.map((x) => x.block)).toEqual([{ t: "p", spans: [{ s: text }] }]);
    }
  });

  test("emphasis Markdown can't open gives way at its edge, never the text", () => {
    const { markdown } = write([{ t: "p", spans: [{ s: "المجموع:", b: true }, { s: "150" }] }]);
    expect(markdown.trim()).toBe("**المجموع**:150");
  });

  test("an unsafe link never gets written", () => {
    const open = openDocument("");
    const out = saveDocument(open, { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "اضغط", marks: [{ type: "link", attrs: { href: "java\tscript:alert(1)" } }] }] }] }).markdown;
    expect(out.trim()).toBe("اضغط");
  });

  test("an unknown node stops the save instead of vanishing", () => {
    expect(() => saveDocument(openDocument("نص"), { type: "doc", content: [{ type: "video" }] })).toThrow();
  });

  test("a merged cell keeps the columns in place", () => {
    const cell = (text: string, colspan = 1) => ({ type: "tableCell", attrs: { colspan }, content: [p(text)] });
    const out = edited("", (n) => (n[0] = { type: "table", content: [{ type: "tableRow", content: [cell("أ"), cell("ب")] }, { type: "tableRow", content: [cell("مدموجة", 2)] }] })).markdown;
    expect(out).toContain("| مدموجة |  |");
  });

  test("a large document saves quickly", () => {
    const src = Array.from({ length: 1500 }, (_, i) => `## بند ${i}\n\nنص البند **${i}**`).join("\n\n");
    const started = performance.now();
    const out = edited(src, (n) => {
      n.splice(1000, 1, p("معدّل"));
      n.splice(20, 1);
    }).markdown;
    expect(out).toContain("معدّل");
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------- generated documents

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}
const ATOMS = ["كلمة", "الميزانية", "word", "150", "١٢", " ", " ", " ", "*", "**", "_", "`", "[", "]", "(", ")", "<", ">", "#", "|", "\\", "~", "!", "&", "&amp;", ":", ".", "-", "+", "=", "،", "«", "»", "/", "@", "🙂", "\n", "مُحَمَّد", "1.", "https://x.sa/a_b", " "];

function generator(next: () => number) {
  const pick = <T>(xs: T[]) => xs[Math.floor(next() * xs.length)]!;
  const spans = (): Span[] =>
    Array.from({ length: 1 + Math.floor(next() * 4) }, () => {
      const s = Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(ATOMS)).join("");
      return { s, ...(next() < 0.2 && { b: true as const }), ...(next() < 0.12 && { i: true as const }), ...(next() < 0.06 && { x: true as const }), ...(next() < 0.07 && { href: "https://example.com/p" }), ...(next() < 0.06 && !s.includes("\n") && { code: true as const }) };
    });
  const block = (depth: number): Block => {
    const r = next();
    const n = 1 + Math.floor(next() * 3);
    if (depth > 1 || r < 0.35) return { t: "p", spans: spans() };
    if (r < 0.47) return { t: "h", level: 1 + Math.floor(next() * 3), spans: spans() };
    if (r < 0.57) return { t: "ul", items: Array.from({ length: n }, () => ({ blocks: [{ t: "p", spans: spans() }, ...(next() < 0.3 ? [block(depth + 1)] : [])] })) };
    if (r < 0.67) return { t: "ol", start: pick([1, 1, 3]), items: Array.from({ length: n }, () => ({ blocks: [{ t: "p", spans: spans() }] })) };
    if (r < 0.73) return { t: "tl", items: Array.from({ length: n }, () => ({ checked: next() < 0.5, blocks: [{ t: "p", spans: spans() }] })) };
    if (r < 0.8) return { t: "quote", blocks: [{ t: "p", spans: spans() }] };
    if (r < 0.86) return { t: "code", lang: pick(["", "py"]), text: pick(["a=1", "```\nx", "  in\n\nout"]) };
    if (r < 0.9) return { t: "hr" };
    return { t: "table", align: [pick([null, "left", "right"] as const), null], rows: Array.from({ length: n + 1 }, () => [spans(), spans()]) };
  };
  return { block: () => block(0), pick };
}

// What a paragraph says, whatever its formatting.
const textOf = (blocks: unknown): string => {
  const out: string[] = [];
  JSON.stringify(blocks, (k, v) => ((k === "s" || k === "text") && typeof v === "string" ? (out.push(v), v) : v));
  return out.join("").replace(/\s+/g, "");
};

describe("generated", () => {
  test("3000 hostile documents: always saved, and no text is ever lost", () => {
    const g = generator(rng(7));
    let lossy = 0;
    for (let i = 0; i < 3000; i++) {
      // In the normal form: emphasis Markdown can't open is reported by the save (another test).
      const blocks = clean(Array.from({ length: 1 + (i % 4) }, () => g.block()));
      let r: { markdown: string; lossy: boolean };
      try {
        r = write(blocks);
      } catch (e) {
        throw new Error(`#${i} ${(e as Error).message}: ${JSON.stringify(blocks)}`);
      }
      if (r.lossy) lossy++;
      const back = openDocument(r.markdown);
      expect(back.kept.size).toBe(0);
      expect(textOf(back.parts.map((x) => x.block))).toBe(textOf(blocks));
    }
    // Marks piled on signs here; anything that would read differently in Word gives way, after asking.
    expect(lossy).toBeLessThan(800);
  }, 120_000);

  test("ordinary formatted paragraphs: the question about formatting is rare", () => {
    const next = rng(7);
    const words = ["الميزانية", "150", "ألف", "المجموع:", "(تقديري)", "،", "مهم", "تقرير"];
    let asked = 0;
    for (let i = 0; i < 2000; i++) {
      const spans: Span[] = Array.from({ length: 2 + Math.floor(next() * 4) }, (_, k) => ({ s: (k ? " " : "") + words[Math.floor(next() * words.length)], ...(next() < 0.25 && { b: true as const }), ...(next() < 0.12 && { i: true as const }), ...(next() < 0.05 && { x: true as const }) }));
      const blocks = clean([{ t: "p", spans }]);
      if (blocks.length && write(blocks).lossy) asked++;
    }
    expect(asked).toBeLessThan(40);
  });

  test("2000 edits of documents with locked parts: every untouched part keeps its bytes", () => {
    const next = rng(11);
    const g = generator(next);
    const sources = [...Object.values(EDITABLE).filter((x) => !x.includes("[r]")), ...Object.values(LOCKED)].map((x) => x.trimEnd());
    for (let i = 0; i < 2000; i++) {
      const picked = Array.from({ length: 5 }, () => g.pick(sources));
      const src = picked.join("\n\n") + "\n";
      const open = openDocument(src);
      const at = Math.floor(next() * open.parts.length);
      if (open.parts[at]!.block.t === "keep") continue;
      const json = structuredClone(open.json);
      json.content![at] = blockJson({ t: "p", spans: [{ s: `تعديل ${i}` }] });
      const out = saveDocument(open, json).markdown;
      expect(out).toBe(src.slice(0, open.parts[at]!.start) + `تعديل ${i}` + src.slice(open.parts[at]!.end));
    }
  }, 120_000);
});

// ---------------------------------------------------------------- found in review

describe("found in review", () => {
  const ul = (...items: string[]): JSONContent => ({ type: "bulletList", content: items.map((x) => ({ type: "listItem", content: [p(x)] })) });
  const ol = (...items: string[]): JSONContent => ({ type: "orderedList", attrs: { start: 1 }, content: items.map((x) => ({ type: "listItem", content: [p(x)] })) });

  test("a list written next to a locked list stays its own list", () => {
    for (const [src, change] of [
      ["- [ ] مهمة\n- عادي\n", (n: JSONContent[]) => void n.push(ul("جديد"))],
      ["1. أول &rarr; ثان\n", (n: JSONContent[]) => void n.push(ol("جديد"))],
      ["مقدمة\n\n- أول\n- ![صورة](a.png)\n", (n: JSONContent[]) => void (n[0] = ul("جديد"))],
    ] as const) {
      const out = edited(src, change).markdown;
      expect(out.startsWith(src) || out.endsWith(src.replace("مقدمة\n\n", ""))).toBe(true);
      expect(openDocument(out).parts.length).toBe(2);
    }
  });

  test("code in a list or quote, with tabs or a line like a link definition, saves", () => {
    for (const text of ["[ERROR]: failed", "\tindented", "a\tb"])
      for (const wrap of [(c: JSONContent) => ({ type: "bulletList", content: [{ type: "listItem", content: [p("خطوة"), c] }] }), (c: JSONContent) => ({ type: "blockquote", content: [c] })]) {
        const out = edited("", (n) => void (n[0] = wrap({ type: "codeBlock", content: [{ type: "text", text }] }))).markdown;
        expect(openDocument(out).kept.size).toBe(0);
      }
    expect(edited("", (n) => void (n[0] = { type: "paragraph", content: [{ type: "text", text: "ملاحظة]: مهم", marks: [{ type: "link", attrs: { href: "https://x.sa" } }] }] })).markdown).toContain("https://x.sa");
  });

  test("formatting that has to give way is asked about, and counts as a change", () => {
    const glued = edited("و**ملغى**\n", (n) => void n[0]!.content![1]!.marks!.push({ type: "strike" }));
    expect(glued.lossy).toBe(true);
    // a struck-out amount stays struck out
    expect(glued.markdown).toContain("~~ملغى~~");
    const open = openDocument("النسبة 50%\n");
    const json = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "النسبة 50" }, { type: "text", text: "%", marks: [{ type: "bold" }] }] }] };
    expect(unchanged(open, json)).toBe(false);
    expect(saveDocument(open, json).lossy).toBe(true);
  });

  test("deleting a link definition a locked part uses is refused, not saved broken", () => {
    for (const src of ["راجع [اللائحة][r] &rarr;\n\n[r]: https://gov.sa/reg\n", "![الشعار][logo]\n\n[logo]: data:image/png;base64,AAAA\n"])
      expect(() => edited(src, (n) => void n.splice(1, 1))).toThrow();
  });

  test("what can't be saved can still be seen as source, to fix by hand", () => {
    const open = openDocument("نص\n\n<!-- مسودة\n");
    const json = structuredClone(open.json);
    json.content!.push(p("توقيع"));
    expect(() => saveDocument(open, json)).toThrow();
    expect(draftSource(open, json)).toBe("نص\n\n<!-- مسودة\n\nتوقيع\n");
  });

  test("a long document edited at both ends keeps everything between", () => {
    const src = Array.from({ length: 2100 }, (_, i) => `* بند ${i}\n\n\nنص   [${i}](https://x.sa/${i})  \nسطر`).join("\n\n");
    const open = openDocument(src);
    const out = edited(src, (n) => {
      n[0] = p("أول");
      n[n.length - 1] = p("آخر");
    }).markdown;
    expect(out).toBe(src.slice(0, open.parts[0]!.start) + "أول" + src.slice(open.parts[0]!.end, open.parts.at(-1)!.start) + "آخر" + src.slice(open.parts.at(-1)!.end));
  });

  test("line endings: CR only and mixed stay as they were", () => {
    expect(edited("أ\rب\r\rج\r", (n) => void (n[1] = p("x"))).markdown).toBe("أ\rب\r\rx\r");
    expect(edited("أ\r\n\r\nب\n\nج\r\n", (n) => void (n[1] = p("x"))).markdown).toBe("أ\r\n\r\nx\n\nج\r\n");
  });

  test("a paragraph of only a non-breaking space is kept", () => {
    expect(edited("أ\n\n \n\nب\n", (n) => void n.splice(1, 0, p("جديد"))).markdown).toBe("أ\n\nجديد\n\n \n\nب\n");
  });

  test("long words and long runs of spaces open quickly", () => {
    for (const src of ["a".repeat(160_000), `a${" ".repeat(160_000)}b`, `${"x@".repeat(40_000)}y.co`]) {
      const started = performance.now();
      openDocument(src);
      expect(performance.now() - started).toBeLessThan(2000);
    }
  });

  test("a list numbered at the limit gets another item", () => {
    expect(edited("999999999. a\n", (n) => void n[0]!.content!.push({ type: "listItem", content: [p("b")] })).markdown).toBe("999999998. a\n999999999. b\n");
  });
});
