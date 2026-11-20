// Agent tool (plans/11 step 4, plans/13): publishes an output at a fixed link (its space, the whole
// workspace, or the public). An app publishes with the lists it may use (its grants); a plain page
// may carry a declared form whose replies become rows of a list. Always a card the user confirms:
// `prepare` pins the version and puts the app's grants on the card, so what is approved goes live.

import { internal } from "../_generated/api";
import { toolErrorText } from "./errors";
import type { AppTool, ToolContext, ToolResult } from "./types";

type Args = {
  artifactId: string;
  audience?: "space" | "workspace" | "public";
  form?: { listId: string; questions?: string[]; required?: boolean; onePerReader?: boolean; thanks?: string };
  /** Set by prepare (not the model): the version on the card, and the app's grants in words. */
  version?: number;
  grants?: string[];
};

export const publish_output: AppTool<Args> = {
  name: "publish_output",
  label: "ينشر برابط…",
  requiresConfirmation: true,
  description:
    "Publishes an output or an app (artifactId = its id / appId) at a fixed link: audience \"space\" (the output's space) or \"workspace\" (every employee), who open it with their account; " +
    "or \"public\" (anyone with the link, no sign-in) only when the user asks for people outside the organisation (or e.g. students without accounts) and the admin allows it — never for personal or sensitive data. " +
    "An app (write_app) publishes with exactly the list grants it declares; the user sees them on the card. Test an app with test_app before publishing it. " +
    "For a simple reply form under a static page you may pass form.listId (each reply becomes a row of that list); anything interactive, marked, computed or validated is an app. " +
    "Never send people to outside services (Google Forms, GitHub Pages) for this.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["artifactId"],
    properties: {
      artifactId: { type: "string" },
      audience: { type: "string", enum: ["space", "workspace", "public"] },
      form: {
        type: "object",
        additionalProperties: false,
        required: ["listId"],
        properties: {
          listId: { type: "string" },
          questions: { type: "array", items: { type: "string" }, description: "Column names to ask (default: every column)." },
          required: { type: "boolean" },
          onePerReader: { type: "boolean" },
          thanks: { type: "string" },
        },
      },
    },
  },
  async prepare(t: ToolContext, a: Args): Promise<Args> {
    const r = await t.ctx.runQuery(internal.publications.publishPreview, { userId: t.userId, artifactId: String(a?.artifactId ?? "") });
    if (!r) return { ...a, version: undefined, grants: undefined };
    return { ...a, version: r.version, ...(r.grants ? { grants: r.grants } : { grants: undefined }) };
  },
  async run(t: ToolContext, a: Args): Promise<ToolResult> {
    const f = a?.form;
    let r: { url: string; state: "live" | "pending"; spaceId: string; note: string; version: number };
    try {
      r = await t.ctx.runMutation(internal.publications.publishFromTool, {
        userId: t.userId,
        scopeSpaceIds: t.scopeSpaceIds as string[],
        artifactId: String(a?.artifactId ?? ""),
        audience: a?.audience === "workspace" || a?.audience === "public" ? a.audience : "space",
        ...(typeof a?.version === "number" ? { version: a.version } : {}),
        ...(f && f.listId
          ? {
              form: {
                listId: String(f.listId),
                ...(Array.isArray(f.questions) ? { questions: f.questions.map(String).slice(0, 100) } : {}),
                ...(typeof f.required === "boolean" ? { required: f.required } : {}),
                ...(typeof f.onePerReader === "boolean" ? { onePerReader: f.onePerReader } : {}),
                ...(f.thanks ? { thanks: String(f.thanks).slice(0, 500) } : {}),
              },
            }
          : {}),
      });
    } catch (e) {
      // Nothing was saved (the mutation rolled back); the model gets the reason to fix and retry.
      const text = toolErrorText(e, "المخرج غير موجود أو لا تملك نشره");
      return { content: `لم يُنشر: ${text}`, display: `لم يُنشر: ${text}` };
    }
    const head = r.state === "pending" ? "طُلب النشر، ويعمل الرابط بعد أن يعتمده مدير المساحة." : "نُشر.";
    return {
      content:
        `${head}${r.note} الرابط: ${r.url}\n` +
        "اشرح للمستخدم في سطرين: يرسل الرابط لمن يريد، ويجرّب الصفحة بنفسه من زر «جرّبها» في البطاقة (ما يرسله فيها لا يُحفظ)، ويرى النتائج" +
        (f?.listId ? ` في القائمة ([القائمة](#/list/${f.listId}))` : " في قائمة التطبيق") +
        " وفي «منشوراتي». لا تعِد كتابة الأسئلة أو الإجابات في ردّك.",
      display: `${head}${r.note} ${r.url}`,
      spaceIds: [r.spaceId],
    };
  },
};
