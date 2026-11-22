import { OneBaseError } from "onebase/values";
import { internal } from "../_generated/api";
import { DOC_FORMATS, DOC_LABEL, renderDocument, type DocFormat } from "../lib/docExport";
import { sha256Hex } from "../recordSources";
import type { AppTool } from "./types";

type Args = {
  format: DocFormat;
  artifactId?: string;
  title?: string;
  content?: string;
  sources?: { type: "file" | "recordSet" | "artifact"; id: string }[];
};

/**
 * The output to export: `artifactId`, or, with no content to write, a single output named in
 * `sources` (measured: the model kept passing the id it had as {type:"artifact"} in sources).
 */
export function exportTarget(a: unknown): string {
  const x = (a ?? {}) as Partial<Args>;
  if (typeof x.artifactId === "string" && x.artifactId.trim()) return x.artifactId.trim();
  if (typeof x.content === "string" && x.content.trim()) return "";
  const arts = Array.isArray(x.sources) ? x.sources.filter((s) => s && s.type === "artifact" && typeof s.id === "string" && s.id.trim()) : [];
  return arts.length === 1 ? arts[0]!.id.trim() : "";
}

/**
 * Word / PDF / PowerPoint files. The model writes Markdown (or names an existing output) and the
 * renderer lays it out (sandbox, Arabic right-to-left): the model never writes python-docx code.
 * The Markdown is kept as an output, so the user can edit it and export again.
 */
export const export_document: AppTool<Args> = {
  name: "export_document",
  label: "يُنشئ ملفاً…",
  description:
    "Make a Word (docx), PDF or PowerPoint (pptx) file. Either pass `artifactId` of an existing output (Markdown, HTML for PDF only, or a table), " +
    "or pass `title` + `content` in Markdown (headings, paragraphs, lists, pipe tables) to create the output and its file in one step. " +
    "For pptx each `#`/`##` heading starts a slide; keep slides short. Use this instead of run_analysis for documents and presentations. " +
    "List what the content was built from in `sources`. The file is saved in the output's space; the user can also download it from the output panel.",
  requiresConfirmation: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["format"],
    properties: {
      format: { type: "string", enum: DOC_FORMATS },
      artifactId: { type: "string", description: "An existing output to export (its id from «المخرجات هنا» in the prompt, or from the result that created it)." },
      title: { type: "string", maxLength: 200 },
      content: { type: "string", description: "Markdown content (when not exporting an existing output)." },
      sources: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["type", "id"], properties: { type: { type: "string", enum: ["file", "recordSet", "artifact"] }, id: { type: "string" } } },
      },
    },
  },
  async run(t, args) {
    const format = args?.format;
    if (!DOC_FORMATS.includes(format)) throw new OneBaseError("الصيغة يجب أن تكون docx أو pdf أو pptx");
    let artifactId = exportTarget(args);
    const created = !artifactId;
    const spaceIds: string[] = [];
    if (!artifactId) {
      if (typeof args.content !== "string" || !args.content.trim()) throw new OneBaseError("أرسل artifactId أو المحتوى (content) بصيغة Markdown");
      const created = await t.ctx.runMutation(internal.artifacts.createForUser, {
        userId: t.userId,
        scopeSpaceIds: t.scopeSpaceIds,
        threadId: t.threadId,
        title: String(args.title ?? "").trim() || "مستند",
        kind: "markdown",
        content: args.content,
        sources: Array.isArray(args.sources) ? args.sources.map((s) => ({ type: s.type, id: String(s.id) })) : undefined,
      });
      artifactId = created.artifactId;
      spaceIds.push(created.spaceId);
    }
    const art: any = await t.ctx.runMutation(internal.artifacts.openForExport, { userId: t.userId, artifactId, format, scopeSpaceIds: t.scopeSpaceIds, requireWrite: true });
    const out = await renderDocument(art, format);
    const storageId = await t.ctx.storage.store(new Blob([out.bytes as Uint8Array<ArrayBuffer>], { type: out.mime }));
    const saved = await t.ctx.runMutation(internal.artifacts.saveRenderedFile, {
      userId: t.userId,
      artifactId: art._id,
      storageId,
      name: out.fileName,
      mime: out.mime,
      size: out.bytes.length,
      sha256: sha256Hex(out.bytes),
      format,
      via: "agent",
    });
    if (!spaceIds.includes(saved.spaceId)) spaceIds.push(saved.spaceId);
    return {
      content: `حُفظ ملف ${DOC_LABEL[format]} «${out.fileName}» (${Math.ceil(out.bytes.length / 1024)} ك.ب) في مساحة المخرج، من النسخة ${art.version} من «${art.title}». يستطيع المستخدم فتح المخرج لتعديل نصه أو تنزيله بصيغة أخرى. artifactId=${art._id} fileId=${saved.fileId}`,
      display: `حُفظ «${out.fileName}» في المساحة. افتح المخرج لتعديله أو تنزيله بصيغة أخرى.`,
      artifactIds: [art._id],
      spaceIds,
      undo: { deleteFiles: [saved.fileId], deleteArtifacts: created ? [art._id] : [] },
    };
  },
};
