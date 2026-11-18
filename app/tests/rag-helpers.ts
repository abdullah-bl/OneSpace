// Helpers for the Phase 2 tests: ask a question and wait for the answer, wait for ingestion,
// and build small .docx / .xlsx / .pdf files in memory (stored zip, hand-written PDF).

import { must, type Server } from "./harness";

export type Answer = { id: string; text: string; citations: any[]; toolRuns: any[]; abstained: boolean; raw: any };

export async function waitIngest(s: Server, token: string, spaceId: string, fileId: string, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < end) {
    const list = must(await s.call("query", "ingest:statuses", { spaceId }, token));
    last = list.find((x: any) => x.fileId === fileId);
    if (last && ["ready", "failed", "skipped"].includes(last.state)) return last;
    await Bun.sleep(50);
  }
  throw new Error("ingest timeout: " + JSON.stringify(last));
}

export async function newThread(s: Server, token: string, scope: any = { kind: "all" }) {
  return must(await s.call("mutation", "chat:createThread", { scope }, token)) as string;
}

/** Sends a question and waits until the turn is done; returns the assistant message. */
export async function ask(s: Server, token: string, threadId: string, text: string, timeoutMs = 20_000): Promise<Answer> {
  const before = must(await s.call("query", "chat:messages", { threadId }, token)).messages.length;
  must(await s.call("mutation", "chat:send", { threadId, text }, token));
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = must(await s.call("query", "chat:messages", { threadId }, token));
    if (r.turn?.state === "failed") throw new Error("turn failed: " + r.turn.error);
    const msgs = r.messages;
    if (!r.turn && msgs.length >= before + 2 && msgs.at(-1).role === "assistant") {
      const m = msgs.at(-1);
      return { id: m.id, text: m.text, citations: m.citations, toolRuns: m.toolRuns, abstained: m.abstained, raw: r };
    }
    await Bun.sleep(40);
  }
  throw new Error("answer timeout");
}

export async function addBytes(s: Server, token: string, spaceId: string | undefined, name: string, bytes: string | Uint8Array, type: string) {
  const storageId = await s.upload(token, bytes, type);
  return must(await s.call("mutation", "files:create", { storageId, name, ...(spaceId ? { spaceId } : {}) }, token)) as string;
}

// ---------------------------------------------------------------- zip (stored), docx, xlsx

export function zip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = enc.encode(content);
    const nm = enc.encode(name);
    const crc = Bun.hash.crc32(data) >>> 0;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nm.length, true);
    const local = new Uint8Array([...new Uint8Array(lh.buffer), ...nm, ...data]);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, nm.length, true);
    ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array([...new Uint8Array(ch.buffer), ...nm]));
    locals.push(local);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, centrals.length, true);
  end.setUint16(10, centrals.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const b of [...locals, ...centrals, new Uint8Array(end.buffer)]) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** paragraphs: [style|null, text] or {table: string[][]}; "PAGE" inserts a rendered page break. */
export function docx(parts: ([string | null, string] | { table: string[][] } | "PAGE")[]): Uint8Array {
  const body = parts
    .map((p) => {
      if (p === "PAGE") return `<w:p><w:r><w:lastRenderedPageBreak/><w:t></w:t></w:r></w:p>`;
      if (!Array.isArray(p)) {
        const rows = p.table.map((r) => `<w:tr>${r.map((c) => `<w:tc><w:p><w:r><w:t>${esc(c)}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`).join("");
        return `<w:tbl>${rows}</w:tbl>`;
      }
      const [style, text] = p;
      return `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
    })
    .join("");
  return zip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

export function xlsx(sheet: string, rows: string[][]): Uint8Array {
  const strings = [...new Set(rows.flat())];
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheetXml = rows
    .map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => `<c r="${col(ci)}${ri + 1}" t="s"><v>${strings.indexOf(c)}</v></c>`).join("")}</row>`)
    .join("");
  return zip({
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<?xml version="1.0"?><sst>${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet><sheetData>${sheetXml}</sheetData></worksheet>`,
  });
}

// ---------------------------------------------------------------- PDF

/** A PDF with one page per entry: a string[] of text lines (ASCII), or "SCAN" for an image-only page. */
export function pdf(pages: (string[] | "SCAN")[]): Uint8Array {
  const objs: string[] = [];
  const add = (s: string) => objs.push(s) && objs.length;
  const catalog = add("");
  const pagesObj = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const img = add("");
  const kids: number[] = [];
  for (const p of pages) {
    let content: string;
    let res: string;
    if (p === "SCAN") {
      content = "q 200 0 0 200 100 400 cm /Im1 Do Q";
      res = `<< /XObject << /Im1 ${img} 0 R >> >>`;
    } else {
      content = `BT /F1 12 Tf 72 720 Td 16 TL ${p.map((l) => `(${l.replace(/[()\\]/g, "\\$&")}) Tj T*`).join(" ")} ET`;
      res = `<< /Font << /F1 ${font} 0 R >> >>`;
    }
    const c = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources ${res} /Contents ${c} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const pixels = "\x80\x80\x80".repeat(64);
  objs[img - 1] = `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n${pixels}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (ch) => ch.charCodeAt(0));
}
