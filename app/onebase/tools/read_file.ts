// read_file(fileId, pages?): reads a whole document (or some pages) when passages aren't enough.
// The file id comes from the model, so it is never trusted: the file must be readable by the
// user right now and inside the turn's scope, or the answer is the same "not found" either way.

import { internal } from "../_generated/api";
import type { AppTool, Citation } from "./types";

const MAX_CHARS = 12_000;

function parsePages(p: unknown): [number, number] | null {
  if (typeof p === "number" && p > 0) return [p, p];
  const m = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(String(p ?? ""));
  if (!m) return null;
  const a = Number(m[1]);
  return [a, Number(m[2] ?? a)];
}

export const readFileTool: AppTool<{ fileId: string; pages?: string | number }> = {
  name: "read_file",
  label: "يقرأ الملف…",
  description:
    "Read the full text of one document (or a page range like '3-5') by its file id, as given in the sources. " +
    "Use when the passages from search_documents are not enough to answer.",
  parameters: {
    type: "object",
    properties: {
      fileId: { type: "string", description: "The file id shown with a source" },
      pages: { type: "string", description: "Optional page range, e.g. '2' or '3-5'" },
    },
    required: ["fileId"],
    additionalProperties: false,
  },
  async run(t, args) {
    const file = await t.ctx.runQuery(internal.search.fileChunks, {
      userId: t.userId,
      fileId: String(args?.fileId ?? ""),
      scopeSpaceIds: t.scopeSpaceIds,
      scopeFileIds: t.scopeFileIds,
    });
    if (!file) return { content: "الملف غير موجود أو لا تملك صلاحية الوصول إليه." };
    const range = parsePages(args?.pages);
    let chunks = file.chunks;
    if (range) chunks = chunks.filter((c) => c.page !== undefined && c.page <= range[1] && (c.pageEnd ?? c.page) >= range[0]);
    if (!chunks.length) return { content: `لا يوجد نص مستخرج${range ? " في هذه الصفحات" : ""} من "${file.name}".`, spaceIds: [file.spaceId] };
    const citations: Citation[] = [];
    let total = 0;
    for (const c of chunks) {
      if (total + c.text.length > MAX_CHARS) break;
      total += c.text.length;
      citations.push({ fileId: file.fileId, fileName: file.name, page: c.page, section: c.section, quote: c.text });
    }
    const truncated = citations.length < chunks.length ? ` (عُرض أول ${citations.length} من ${chunks.length} مقطعاً؛ اطلب صفحات محددة للباقي)` : "";
    return { content: `نص "${file.name}" مقسّماً أدناه كمصادر مرقّمة${truncated}.`, citations, spaceIds: [file.spaceId] };
  },
};
