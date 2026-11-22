// Slide decks (kind "slides"): splitting, presenter notes, escaping, and the export Markdown.

import { describe, expect, test } from "bun:test";
import { renderSlides, slidesToMarkdown, splitSlides } from "../src/slides";
import { formatsFor } from "../onebase/lib/docExport";
import { tools } from "../onebase/tools/index";

const DECK = `# خطة التدريب 2027
الإدارة العامة للتدريب

---

## الأهداف
- رفع الكفاءة
- تقليل التكلفة
ملاحظات: ابدأ بالأرقام
ثم انتقل للأهداف

---

\`\`\`
a
---
b
\`\`\`

---
---
`;

describe("slides", () => {
  test("splits on --- lines, not inside code fences; drops empty slides", () => {
    const s = splitSlides(DECK);
    expect(s.length).toBe(3);
    expect(s[0]!.markdown.startsWith("# خطة التدريب")).toBe(true);
    expect(s[2]!.markdown).toContain("---");
  });

  test("notes after «ملاحظات:» belong to their slide and leave its body", () => {
    const s = splitSlides(DECK)[1]!;
    expect(s.notes).toBe("ابدأ بالأرقام\nثم انتقل للأهداف");
    expect(s.markdown).not.toContain("ملاحظات");
    expect(splitSlides("## a\nNote: say hi")[0]!.notes).toBe("say hi");
  });

  test("raw HTML the model writes stays text: the deck runs in the app's own page", () => {
    const [s] = renderSlides(`## x\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[a](javascript:alert(1))`);
    expect(s!.html).not.toMatch(/<script|<img|href="javascript/i);
    expect(s!.html).toContain("&lt;script&gt;");
  });

  test("export Markdown: no notes, every slide opens with a heading", () => {
    const md = slidesToMarkdown("plain first\n---\n## titled\nNote: hidden");
    expect(md).toBe("## شريحة 1\n\nplain first\n\n## titled");
  });

  test("slides download as PowerPoint and PDF; the agent can make them", () => {
    expect(formatsFor("slides")).toEqual(["pptx", "pdf"]);
    const t = tools.create_artifact!;
    expect((t.parameters as any).properties.kind.enum).toContain("slides");
  });
});
