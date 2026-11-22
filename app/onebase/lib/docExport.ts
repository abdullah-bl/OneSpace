// Turns an output (artifact) into a Word, PDF or PowerPoint file. The work happens in the sandbox
// (sandbox-runner, image `onespace_doc` module): no network, no database, only the one document's
// text goes in and one file comes out. Callers check access and audit before calling this.

import { OneBaseError } from "onebase/values";
import { callSandbox, SandboxUnavailable } from "./sandboxClient";
import { slidesToMarkdown } from "../../src/slides";

export type DocFormat = "docx" | "pdf" | "pptx";
export const DOC_FORMATS: DocFormat[] = ["docx", "pdf", "pptx"];

export const DOC_MIME: Record<DocFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const DOC_LABEL: Record<DocFormat, string> = { docx: "Word", pdf: "PDF", pptx: "PowerPoint" };

const RENDER_LIMITS = { timeoutMs: 60_000, memoryMb: 1024, cpus: 1, pids: 64, outputMb: 40 };
const RENDER_CODE = "import onespace_doc\nonespace_doc.main()\n";

/** Which formats an artifact kind can become. HTML only prints to PDF; tables go through Markdown. */
export function formatsFor(kind: string): DocFormat[] {
  if (kind === "markdown" || kind === "table") return DOC_FORMATS;
  if (kind === "slides") return ["pptx", "pdf"];
  if (kind === "html") return ["pdf"];
  return [];
}

function mdCell(c: unknown) {
  return c === null || c === undefined ? "" : String(c).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** A table artifact ({columns, rows}) as a Markdown pipe table, so every format can take it. */
export function tableToMarkdown(json: string): string {
  const t = JSON.parse(json) as { columns: string[]; rows: unknown[][] };
  const head = `| ${t.columns.map(mdCell).join(" | ")} |`;
  const sep = `| ${t.columns.map(() => "---").join(" | ")} |`;
  return [head, sep, ...t.rows.map((r) => `| ${t.columns.map((_, i) => mdCell(r[i])).join(" | ")} |`)].join("\n");
}

export function safeBaseName(title: string) {
  return title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 100) || "document";
}

export async function renderDocument(art: { title: string; kind: string; content: string }, format: DocFormat): Promise<{ fileName: string; mime: string; bytes: Uint8Array }> {
  if (!formatsFor(art.kind).includes(format)) throw new OneBaseError(`لا يمكن تحويل هذا المخرج إلى ${DOC_LABEL[format] ?? format}`);
  const kind = art.kind === "html" ? "html" : "markdown";
  const content = art.kind === "table" ? tableToMarkdown(art.content) : art.kind === "slides" ? slidesToMarkdown(art.content) : art.content;
  const doc = JSON.stringify({ title: art.title, kind, content, format });
  let r;
  try {
    r = await callSandbox({ code: RENDER_CODE, files: [{ name: "doc.json", b64: Buffer.from(doc, "utf8").toString("base64") }], limits: RENDER_LIMITS });
  } catch (e) {
    if (e instanceof SandboxUnavailable) throw new OneBaseError(`تعذّر إنشاء الملف: ${e.message}`);
    throw e;
  }
  const out = r.files.find((f) => f.name === `out.${format}`);
  if (!r.ok || !out) {
    const why = r.timedOut ? "استغرق وقتاً أطول من المسموح" : (r.stderr.trim().split("\n").at(-1) ?? r.error ?? "").slice(0, 200);
    throw new OneBaseError(`تعذّر إنشاء ملف ${DOC_LABEL[format]}${why ? `: ${why}` : ""}`);
  }
  return { fileName: `${safeBaseName(art.title)}.${format}`, mime: DOC_MIME[format], bytes: new Uint8Array(Buffer.from(out.b64, "base64")) };
}
