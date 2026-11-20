// Agent tool (plans/13): writes a small web app — HTML/JS/CSS/data files, private server/ files and
// Python handlers, and the lists it may use (grants) — as an output of kind "app", versioned. Tiered
// like create_artifact/update_artifact: in my personal space it runs at once with «تراجع».

import { internal } from "../_generated/api";
import type { AppTool, ToolContext, ToolResult } from "./types";

type Args = {
  appId?: string;
  title?: string;
  files?: Record<string, string | null>;
  data?: Record<string, { listId: string; write?: "none" | "page" | "handler"; read?: "none" | "own" | "aggregate"; columns?: string[]; sender?: string }>;
  fromSkill?: string;
};

export const APP_GUIDE =
  "HOW APPS WORK. The page is one document built from index.html: local <script src> and <link rel=stylesheet> files are inlined; it runs sandboxed on a separate origin " +
  "with NO network except its own API, no localStorage/cookies, no alert/confirm, no external scripts, fonts or images (use inline SVG or data: URLs), and inline on*= attributes are blocked (use addEventListener). " +
  "Files outside server/ are PUBLIC (the visitor can read them all). Files in server/ are PRIVATE: never sent to the browser. " +
  "In the page's JS, a global `onespace` gives: onespace.json('data/x.json') / onespace.file(path) — a public data file (no fetch); " +
  "await onespace.call('<handler>', payload) — runs server/<handler>.py and returns its response; " +
  "await onespace.append('<alias>', {<column name>: value}) — adds a row (only if data[alias].write='page'); " +
  "await onespace.mine('<alias>') — rows this visitor added (read='own'); await onespace.stats('<alias>') — counts/averages per column (read='aggregate'); " +
  "onespace.visitor = {signedIn, name}; onespace.lists[alias].columns = [{name,type,options}]. All calls throw Error(message) on failure: show it. " +
  "A HANDLER is server/<name>.py with `def handle(request):` (Python 3, standard library + pandas/numpy, no network, 10 s). request = {payload (what the page sent; untrusted: validate it), " +
  "visitor: {signedIn, name, rows (rows this visitor already added via this page)}, test}. It reads private files by plain name from its working dir, e.g. json.load(open('key.json')) for server/key.json. " +
  "It returns {\"response\": <JSON for the page>, \"rows\": [{\"list\": \"<alias>\", \"cells\": {<column name>: value}}]}; rows are written only to aliases with write='handler' or 'page', only to granted columns, with select values exactly one of the column's options. " +
  "Anything the visitor must not see or forge — answer keys, scores, prices, rules, validation — lives ONLY in server/ and is computed by a handler with write='handler'. " +
  "Never copy it into public files: e.g. a quiz keeps its questions and options in a public data file or the JS WITHOUT the correct answer (no index, flag or field that reveals it), and the key only in server/; " +
  "the page sends the visitor's choices and shows what the handler returns (score, level, corrections). ";

export const write_app: AppTool<Args> = {
  name: "write_app",
  label: "يكتب ملفات التطبيق…",
  requiresConfirmation: true,
  description:
    "Builds a small web app that people open from a link: a quiz or placement test, survey, registration, calculator, booking or sign-up, checklist, any interactive page. " +
    "Use it (not create_artifact, not a form) whenever people must answer, enter, choose or compute something. Work like a developer: " +
    "1) create_list for where results go (one column per value to keep: text/number/select…, plus a person column «المرسل» if sign-in identity matters); " +
    "2) write_app with all files and data (the list grants); 3) test_app with realistic steps (fill every field, submit, expect the result text) and fix what it reports with write_app (appId + only the changed files) until it passes; " +
    "4) publish_output with the appId. Without appId it creates a new app (title + files with index.html); with appId it writes a new version: files you pass are created/replaced, a file set to null is deleted, others stay. " +
    "data = { <alias>: { listId, write: 'none'|'page'|'handler', read: 'none'|'own'|'aggregate', columns?: [column names allowed], sender?: person column the server fills with the signed-in visitor } } — " +
    "the user approves exactly these grants when publishing; ask for the least the app needs. fromSkill: start a new app from the files of a saved skill's app. " +
    "Write the user-facing text in the user's language, right-to-left (dir=rtl) for Arabic, clean and mobile-friendly. " +
    APP_GUIDE,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      appId: { type: "string", description: "The app to change (omit to create one)." },
      title: { type: "string", maxLength: 200 },
      files: { type: "object", description: "{ path: full file content, or null to delete }. Paths like index.html, app.js, style.css, data/questions.json, server/mark.py, server/key.json.", additionalProperties: { type: ["string", "null"] } },
      data: {
        type: "object",
        description: "The lists the app may use, by alias (replaces the app's grants when given).",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          required: ["listId"],
          properties: {
            listId: { type: "string" },
            write: { type: "string", enum: ["none", "page", "handler"] },
            read: { type: "string", enum: ["none", "own", "aggregate"] },
            columns: { type: "array", items: { type: "string" } },
            sender: { type: "string" },
          },
        },
      },
      fromSkill: { type: "string", description: "A skill's /name whose saved app files to start from (new app only)." },
    },
  },
  async run(t: ToolContext, a: Args): Promise<ToolResult> {
    const files = a?.files && typeof a.files === "object" ? Object.fromEntries(Object.entries(a.files).map(([k, x]) => [String(k), x === null ? null : String(x)])) : {};
    if (!a?.appId && !files["index.html"] && !a?.fromSkill) throw new Error("تطبيق جديد يحتاج files فيها index.html");
    const r = await t.ctx.runMutation(internal.apps.writeFromTool, {
      userId: t.userId,
      scopeSpaceIds: t.scopeSpaceIds as string[],
      threadId: t.threadId,
      ...(a?.appId ? { appId: String(a.appId) } : {}),
      ...(a?.title ? { title: String(a.title) } : {}),
      files,
      ...(a?.data && typeof a.data === "object" ? { data: a.data } : {}),
      ...(a?.fromSkill ? { fromSkill: String(a.fromSkill).slice(0, 60) } : {}),
    });
    if (!r.ok) throw new Error(r.error);
    const head = r.created ? `أُنشئ التطبيق (appId=${r.artifactId}، النسخة 1).` : `حُفظت النسخة ${r.version} من التطبيق (appId=${r.artifactId}).`;
    const lines = [
      head,
      "الملفات:",
      ...r.files,
      r.grants.length ? `صلاحياته على القوائم: ${r.grants.join("؛ ")}` : "لا يكتب في أي قائمة ولا يقرأ منها.",
      r.handlers.length ? `معالجات الخادم: ${r.handlers.join("، ")}` : "",
      r.warnings.length ? `تنبيهات أصلحها:\n- ${r.warnings.join("\n- ")}` : "",
      "التالي: test_app بخطوات واقعية، ثم أصلح ما يظهر.",
    ].filter(Boolean);
    return {
      content: lines.join("\n"),
      display: r.created ? `أُنشئ التطبيق «${a?.title ?? ""}» (${r.files.length} ملفات).` : `حُدّث التطبيق (النسخة ${r.version}، ${Object.keys(files).length} ملفات).`,
      artifactIds: [r.artifactId],
      spaceIds: [r.spaceId],
      undo: r.created ? { deleteArtifacts: [r.artifactId] } : { restore: { artifactId: r.artifactId, version: r.previous } },
    };
  },
};
