// search_documents(query, spaces?): hybrid search in the documents the *user* may read.
// The model may narrow the spaces, never widen them: `spaces` is intersected with the turn's
// scope, and searchDocuments intersects again with readableSpaceIds at call time.

import { searchDocuments } from "../search";
import type { AppTool, Citation } from "./types";

export const searchDocumentsTool: AppTool<{ query: string; spaces?: string[] }> = {
  name: "search_documents",
  label: "يبحث في المستندات…",
  description:
    "Search the user's documents (policies, regulations, letters, minutes) for passages relevant to a query. " +
    "Use a short, specific query in the language of the documents; call again with different wording if the first results don't answer. " +
    "Returns numbered passages to cite.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for, e.g. 'مدة إجازة الأمومة'" },
      spaces: { type: "array", items: { type: "string" }, description: "Optional: limit to these space ids" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async run(t, args) {
    const query = String(args?.query ?? "").slice(0, 500);
    const wanted = Array.isArray(args?.spaces) ? args.spaces.map(String) : [];
    const spaceIds = wanted.length ? t.scopeSpaceIds.filter((s) => wanted.includes(s)) : t.scopeSpaceIds;
    const r = await searchDocuments(t.ctx, { userId: t.userId, spaceIds, fileIds: t.scopeFileIds, query });
    const citations: Citation[] = r.hits.map((h) => ({ fileId: h.fileId, fileName: h.fileName, page: h.page, section: h.section, quote: h.text, ...(h.steering ? { steering: true } : {}) }));
    return {
      content: citations.length ? `وُجدت ${citations.length} نتائج في الملفات، نصوصها أدناه مرقّمة كمصادر.` : "لم يُعثر على شيء مرتبط في الملفات المتاحة.",
      citations,
      spaceIds: [...new Set(r.hits.map((h) => h.spaceId))],
    };
  },
};
