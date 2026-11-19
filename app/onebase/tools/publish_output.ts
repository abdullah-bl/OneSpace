// Agent tool (plans/11 step 4): publishes an output at a fixed link (its space, or the whole
// workspace), optionally with a form under it whose replies become rows of a list, or a quiz that
// code marks against a key (score and level written to the list). Always a card the user confirms.

import { internal } from "../_generated/api";
import { toolErrorText } from "./errors";
import type { AppTool, ToolContext, ToolResult } from "./types";

type Args = {
  artifactId: string;
  audience?: "space" | "workspace" | "public";
  form?: { listId: string; questions?: string[]; required?: boolean; onePerReader?: boolean; thanks?: string; quiz?: { answers: Record<string, string>; points?: number; levels?: { min: number; label: string }[]; showResult?: boolean } };
};

export const publish_output: AppTool<Args> = {
  name: "publish_output",
  label: "ينشر برابط…",
  requiresConfirmation: true,
  description:
    "Publishes an output (from create_artifact) at a fixed link: audience \"space\" (the output's space) or \"workspace\" (every employee), who open it with their account; " +
    "or \"public\" (anyone with the link, no sign-in) only when the user asks for people outside the organisation and the admin allows it — never for personal or sensitive data. " +
    "Published pages never run scripts, so interactive buttons written in HTML do nothing: anything people ANSWER (a survey, registration, feedback, a quiz or placement test) is done with a form: " +
    "1) create_list with one column per question (select with the options for multiple choice, text for open answers), 2) create_artifact with the intro/instructions page (no questions or inputs in it), " +
    "3) publish_output with form.listId = that list. Each reply becomes a row of the list, so the user sees every answer and the assistant can read them later (read_list). " +
    "For a quiz or placement test add form.quiz: answers = { column name: correct option }, optional points per question, optional levels [{min, label}] (the level is the highest band reached), " +
    "showResult (default true) shows the taker their score. Marking is done by code; the score and level are written to the list. " +
    "Name columns exactly as in the list. The intro page must never show the answers or an answer key (takers see it): keep the key only in form.quiz and tell the user in chat. " +
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
          quiz: {
            type: "object",
            additionalProperties: false,
            required: ["answers"],
            properties: {
              answers: { type: "object", description: "{ column name: correct option text }" },
              points: { type: "number" },
              levels: { type: "array", items: { type: "object", additionalProperties: false, required: ["min", "label"], properties: { min: { type: "number" }, label: { type: "string" } } } },
              showResult: { type: "boolean" },
            },
          },
        },
      },
    },
  },
  async run(t: ToolContext, a: Args): Promise<ToolResult> {
    const f = a?.form;
    let r: { url: string; state: "live" | "pending"; spaceId: string; note: string };
    try {
      r = await t.ctx.runMutation(internal.publications.publishFromTool, {
      userId: t.userId,
      scopeSpaceIds: t.scopeSpaceIds as string[],
      artifactId: String(a?.artifactId ?? ""),
      audience: a?.audience === "workspace" || a?.audience === "public" ? a.audience : "space",
      ...(f && f.listId
        ? {
            form: {
              listId: String(f.listId),
              ...(Array.isArray(f.questions) ? { questions: f.questions.map(String).slice(0, 100) } : {}),
              ...(typeof f.required === "boolean" ? { required: f.required } : {}),
              ...(typeof f.onePerReader === "boolean" ? { onePerReader: f.onePerReader } : {}),
              ...(f.thanks ? { thanks: String(f.thanks).slice(0, 500) } : {}),
              ...(f.quiz && typeof f.quiz.answers === "object"
                ? {
                    quiz: {
                      answers: Object.fromEntries(Object.entries(f.quiz.answers).map(([k, val]) => [String(k), String(val)])),
                      ...(typeof f.quiz.points === "number" ? { points: f.quiz.points } : {}),
                      ...(Array.isArray(f.quiz.levels) ? { levels: f.quiz.levels.filter((l) => l && typeof l === "object").map((l) => ({ min: Number(l.min) || 0, label: String(l.label ?? "") })) } : {}),
                      ...(typeof f.quiz.showResult === "boolean" ? { showResult: f.quiz.showResult } : {}),
                    },
                  }
                : {}),
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
        "اشرح للمستخدم في سطرين: يرسل الرابط لمن يريد (يفتحه بحسابه)، ويجرّب الصفحة بنفسه من زر «جرّبها» في البطاقة (ما يرسله فيها لا يُحفظ)، ويرى الردود" +
        (f?.listId ? ` في القائمة (زر «الردود»، أو [القائمة](#/list/${f.listId}))` : "") +
        " وفي «منشوراتي». لا تعِد كتابة الأسئلة أو الإجابات في ردّك.",
      display: `${head}${r.note} ${r.url}`,
      spaceIds: [r.spaceId],
    };
  },
};
