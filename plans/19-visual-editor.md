# 19 — The document editor («المحرر»)

## Why

Outputs are Markdown, and editing one meant typing Markdown into a text box. Most employees don't know it.

## What

«تعديل» on a document opens it as a document, with a toolbar: headings, bold, italic, strikethrough, bullets, numbers, tasks, links, tables, quotes, a rule. Storage stays Markdown, so exports, the assistant and versions are unchanged. The source is under «المزيد» ← «نص Markdown (متقدّم)». HTML pages still open as code, with a line saying to ask the assistant.

Built on Tiptap 3.32.3 (MIT), bundled with the app and loaded when someone edits.

## Why not Tiptap's own Markdown package

Measured on 30 common cases, `@tiptap/markdown` changed 8: it dropped images and task boxes, turned HTML into text, and un-escaped `\#` into a heading. So the conversion is ours (`app/src/editor`), on the `marked` parser the preview already uses.

## Three promises (`document.ts`)

1. **What wasn't edited is saved byte for byte.** Each top-level block remembers its source, and only edited blocks are written again.
2. **What can't be shown faithfully is locked, never dropped:** images, HTML, link definitions, unknown entities. A chart shows as the chart. A block is editable only if writing it again says the same to a reader.
3. **What is saved was read back first** and says what the editor showed, both to the preview's parser and, as tested, to the Word/PDF exporter's. Formatting that can't be written gives way only after asking; text never does. Otherwise nothing is saved, and «نص Markdown» under «المزيد» shows the source to fix by hand.

An independent review attacked these promises and found 12 ways to break them, among them states that couldn't be saved, formatting dropped silently, broken links in locked parts, and slow regexes. Each is fixed and has a test under «found in review».

## Files

| File | |
|---|---|
| `model.ts` | The blocks, their normal form, to and from Tiptap |
| `read.ts` | Markdown → blocks, with each one's place in the source |
| `write.ts` | Blocks → Markdown |
| `document.ts` | Open, save, the checks |
| `extensions.ts` | What the editor can hold |
| `paste.ts` | Pasted tables |
| `VisualEditor.tsx` | The screen |

## Limits

- A table cell is one line, and merged cells become a cell and empty ones (Markdown has neither).
- No images can be added, no underline, colours or paragraph alignment.
- Bold that ends in punctuation glued to the next word loses that one sign's bold («**المجموع**:150»).
- An existing `<br>` in a cell is kept, and Word prints it as text (the exporter's behaviour before this).
- A locked part that never closes (an HTML comment or a code fence without its end) takes in what follows it: saving after it is refused, and the source shows why.
- Two locked lists made to touch become one list: refused the same way.
- Resolving a conflict is still by hand: compare, copy, save. Merging by section is plans/18 phase 3.

## Tests

`tests/editor.unit.test.ts`: round trips, locked parts, edits, generated hostile documents and edits, and what the review found.

Measured outside the tests:
- 333 local documents and answers: all saved byte for byte when not edited, and none lost a byte outside the edited part.
- 38,324 written documents (real and generated, much nested formatting) read the same by the exporter's parser (Python markdown-it) as by the editor.
