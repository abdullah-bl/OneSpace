// Slides (artifact kind "slides"): Markdown, one slide per block between lines of only `---`.
// Lines after a line starting «ملاحظات:» or "Note:" are the presenter's notes for that slide.
// The text is untrusted like any answer: it goes through renderAnswer (src/markdown.ts), which
// escapes raw HTML and keeps only safe links. That is why the deck can run reveal.js in the app's
// own page instead of the sandboxed frame: no byte the model wrote ever becomes markup or script.
// Kept free of React so the server (export) and tests can use it.

import { renderAnswer } from "./markdown";

export type Slide = { markdown: string; notes: string };

const SEPARATOR = /^\s*---\s*$/;
const NOTES = /^\s*(?:ملاحظات|ملاحظة|notes?)\s*[:：]\s?/i;

/** Splits slide Markdown into slides. A `---` inside a ``` fence doesn't split. Empty slides are dropped. */
export function splitSlides(src: string): Slide[] {
  const out: Slide[] = [];
  let body: string[] = [];
  let notes: string[] | null = null;
  let fence = false;
  const flush = () => {
    const markdown = body.join("\n").trim();
    const n = (notes ?? []).join("\n").trim();
    if (markdown || n) out.push({ markdown, notes: n });
    body = [];
    notes = null;
  };
  for (const line of src.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && SEPARATOR.test(line)) {
      flush();
      continue;
    }
    if (!fence && notes === null && NOTES.test(line)) {
      notes = [line.replace(NOTES, "")];
      continue;
    }
    (notes ?? body).push(line);
  }
  flush();
  return out;
}

/** Each slide's safe HTML (escaped, see the header) and its notes as plain text. */
export function renderSlides(src: string): { html: string; notes: string }[] {
  return splitSlides(src).map((s) => ({ html: renderAnswer(s.markdown, new Set()), notes: s.notes }));
}

/**
 * The deck as one Markdown document for Word / PDF / PowerPoint export: notes dropped, and every
 * slide opens with a `##` heading (the PowerPoint renderer starts a slide at each H1/H2), so a
 * slide that has none gets "شريحة n".
 */
export function slidesToMarkdown(src: string): string {
  return splitSlides(src)
    .filter((s) => s.markdown)
    .map((s, i) => (/^#{1,2}\s/.test(s.markdown) ? s.markdown : `## شريحة ${i + 1}\n\n${s.markdown}`))
    .join("\n\n");
}
