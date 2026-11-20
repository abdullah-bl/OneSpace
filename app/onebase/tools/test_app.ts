// Agent tool (plans/13 §4): opens the assistant's own app in a headless browser on a short-lived test
// link, runs its steps, and reports what broke. Writes are dry-run (nothing reaches a list), so it
// changes nothing and needs no card: the write → test → fix loop runs inside one answer.

import { internal } from "../_generated/api";
import { BrowserUnavailable, runInBrowser, type BrowserReport, type Step } from "../lib/browserTest";
import { publishOrigin } from "../publications";
import { appWarnings } from "../lib/appFiles";
import type { AppTool, ToolContext, ToolResult } from "./types";

type Args = { appId: string; steps?: Step[] };

const clip = (s: unknown, n: number) => {
  const t = typeof s === "string" ? s : JSON.stringify(s ?? null);
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** The report as the model reads it: verdict first, then each kind of problem, then what happened server-side. */
export function testReport(r: BrowserReport, events: any[], warnings: string[] = []): { text: string; ok: boolean } {
  const out: string[] = [];
  const serverErrors = events.filter((e) => e && e.ok === false);
  const ok = r.ok && !serverErrors.length && !warnings.length;
  out.push(
    ok
      ? "✅ نجحت التجربة: لا أخطاء في المتصفح ولا في الخادم."
      : r.ok && !serverErrors.length
        ? "⚠️ عملت الصفحة، لكن أصلح هذا قبل النشر (write_app) ثم أعد test_app:"
        : "❌ في التجربة مشاكل، أصلحها بـ write_app ثم أعد test_app:",
  );
  if (warnings.length) out.push(`تنبيهات على الملفات:\n- ${warnings.join("\n- ")}`);
  if (r.error) out.push(`خطأ في التشغيل: ${r.error}`);
  const failed = r.steps.find((s) => !s.ok);
  out.push(`الخطوات: ${r.steps.filter((s) => s.ok).length}/${r.steps.length} نجحت.`);
  if (failed) out.push(`فشلت الخطوة ${JSON.stringify(failed.step)}: ${failed.error}${failed.text ? `\nنص الصفحة عندها:\n${failed.text}` : ""}`);
  if (r.exceptions.length) out.push(`أخطاء JavaScript:\n- ${r.exceptions.join("\n- ")}`);
  const cons = r.console.filter((c) => c.level === "error" || c.level === "warning" || c.level === "warn");
  if (cons.length) out.push(`الكونسول (أخطاء وتحذيرات، ومنها مخالفات CSP):\n- ${cons.map((c) => `[${c.level}] ${c.text}`).join("\n- ")}`);
  const logs = r.console.filter((c) => c.level === "log" || c.level === "info");
  if (logs.length) out.push(`console.log:\n- ${logs.slice(0, 15).map((c) => c.text).join("\n- ")}`);
  if (r.failedRequests.length) out.push(`طلبات فشلت:\n- ${r.failedRequests.map((f) => `${f.url}: ${f.reason}`).join("\n- ")}`);
  if (r.blocked.length) out.push(`طلبات مُنعت (الصفحة لا تتصل بغير واجهتها):\n- ${r.blocked.join("\n- ")}`);
  if (events.length) {
    out.push("ما وصل إلى الخادم (بالترتيب):");
    for (const e of events) {
      const head = `- ${e.op}${e.handler ? ` ${e.handler}` : ""}${e.list ? ` «${e.list}»` : ""}: ${e.ok ? "نجح" : `فشل — ${e.error}`}${e.ms ? ` (${e.ms}ms)` : ""}`;
      const more = [
        e.payload ? `  أرسلت الصفحة: ${clip(e.payload, 400)}` : "",
        e.response ? `  ردّ المعالج: ${clip(e.response, 600)}` : "",
        e.trace ? `  Traceback:\n${String(e.trace).split("\n").slice(-15).map((l) => `    ${l}`).join("\n")}` : "",
        e.stdout ? `  print: ${clip(e.stdout, 400)}` : "",
        ...(e.wrote ?? []).map((w: any) => `  سيُضاف إلى «${w.list}» (تجربة، لم يُحفظ): ${clip(w.cells, 500)}`),
      ].filter(Boolean);
      out.push([head, ...more].join("\n"));
    }
  } else out.push("لم تتصل الصفحة بالخادم في هذه التجربة.");
  out.push(`نص الصفحة في النهاية:\n${r.text || "(فارغة)"}`);
  if (ok) out.push("إن غطّت الخطوات مسار المستخدم كاملاً وظهرت النتيجة المتوقعة فالتطبيق جاهز للنشر (publish_output).");
  return { text: out.join("\n\n"), ok };
}

export const test_app: AppTool<Args> = {
  name: "test_app",
  label: "يجرّب التطبيق في متصفح…",
  description:
    "Tests an app made with write_app in a real headless browser, like a visitor: it opens the current version on a test link, runs your steps, and returns JavaScript errors, " +
    "console output, CSP violations, failed or blocked requests, every call to the app's API with the handler's response or Python traceback, the rows that WOULD be written " +
    "(nothing is saved in a test), and the page's text. Always test before publishing, with steps that go through the whole flow (answer every question, submit, then expect the result text). " +
    "Steps (in order): {do:'fill', selector, value} · {do:'click', selector} or {do:'click', text:'button text'} · {do:'select', selector, value} (a <select> option, or the radio/option inside selector whose value or label is value) · " +
    "{do:'check', selector, value?:false} · {do:'wait', selector|text|ms} · {do:'expect', text, selector?} (fails if the text doesn't appear within ms, default 5000). " +
    "Give the inputs ids/names so selectors are simple. Fix every problem it reports with write_app and test again.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["appId"],
    properties: {
      appId: { type: "string" },
      steps: {
        type: "array",
        maxItems: 80,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["do"],
          properties: {
            do: { type: "string", enum: ["fill", "click", "select", "check", "wait", "expect"] },
            selector: { type: "string" },
            value: { type: ["string", "boolean"] },
            text: { type: "string" },
            ms: { type: "number" },
          },
        },
      },
    },
  },
  async run(t: ToolContext, a: Args): Promise<ToolResult> {
    const start = await t.ctx.runMutation(internal.apps.startTestForTool, { userId: t.userId, scopeSpaceIds: t.scopeSpaceIds as string[], appId: String(a?.appId ?? "") });
    if (!start.ok) return { content: `لم تبدأ التجربة: ${start.error}` };
    const origin = publishOrigin()!;
    const steps = (Array.isArray(a?.steps) ? a.steps : []).filter((s) => s && typeof s === "object").map((s) => ({ ...s, do: s.do })) as Step[];
    let report: BrowserReport;
    try {
      report = await runInBrowser(start.url, steps, { allow: [`${origin}/t/`, `${origin}/a/test`] });
    } catch (e) {
      await t.ctx.runMutation(internal.apps.finishTest, { token: start.token });
      return { content: `تعذّرت التجربة في المتصفح: ${e instanceof BrowserUnavailable ? e.message : e instanceof Error ? e.message : String(e)}` };
    }
    const events = await t.ctx.runMutation(internal.apps.finishTest, { token: start.token });
    const { text, ok } = testReport(report, events, appWarnings({ files: start.files, data: {} }));
    return { content: `تجربة «${start.title}» (النسخة ${start.version}):\n\n${text}`, display: ok ? `نجحت تجربة التطبيق (${report.steps.length} خطوات).` : "وجدت التجربة مشاكل؛ يصلحها المساعد." };
  },
};
