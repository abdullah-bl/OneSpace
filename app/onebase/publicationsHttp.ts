// The content origin (plans/11): GET /p/<slug> serves a published output, and only when the request
// came to PUBLISH_ORIGIN's host; on the app's own host /p/ answers 404, so a published page never
// shares the app's origin. The page carries the same rules as the in-app frame (src/sandbox.ts):
// a sandbox CSP with an opaque origin, no request may leave it, and only our own hashed script runs.
//
//   no cookie, no ticket  → 302 to the app's #/open/<slug> (sign in, access check, ticket)
//   ?t=<ticket>           → one use; sets a cookie for this page only, 303 to the clean URL
//   cookie                → access checked again, the page served
// Missing, forbidden, revoked and expired all look the same: the app's «غير متاح».

import type { HttpRouter } from "onebase/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { appOrigin, publishOrigin } from "./publications";
import { tableToMarkdown } from "./lib/docExport";
import { renderAnswer } from "../src/markdown";
import { ARTIFACT_CSP, BASE_STYLE, TABLE_TOOLS, stripMeta } from "../src/sandbox";
import { bundlePage, type PageConfig } from "./lib/appFiles";
import { runHandler } from "./lib/appHandler";

const SLUG = /^[A-Za-z0-9_-]{12,40}$/;
const COOKIE = "os_pub";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The request's host as the browser saw it (a proxy in front sets X-Forwarded-Host). */
function requestHost(request: Request) {
  return (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host).split(",")[0]!.trim().toLowerCase();
}

function cookieOf(request: Request, name: string) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

/** The client's address (a proxy in front sets X-Forwarded-For), for public pages' rate limits. */
function clientIp(request: Request) {
  return (request.headers.get("x-forwarded-for")?.split(",")[0] ?? request.headers.get("x-real-ip") ?? "direct").trim().slice(0, 64) || "direct";
}

const busy = () => new Response("طلبات كثيرة؛ حاول بعد دقيقة.", { status: 429, headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "60", "Cache-Control": "no-store" } });
const doneCookie = (slug: string) => `os_d_${slug.replace(/[^A-Za-z0-9]/g, "")}`;

const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/** The in-app frame's CSP, plus: forms may post to this origin's /f/ (no script needed), never framed. */
const pageCsp = (origin: string) => `${ARTIFACT_CSP.replace("form-action 'none'", `form-action ${origin}/f/`)}; frame-ancestors 'none'; sandbox allow-scripts allow-forms`;

const PAGE_STYLE = `body{max-width:860px;margin:0 auto;padding:24px 16px 48px}
.os-pub-foot{margin-top:40px;padding-top:12px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px}
.os-form{margin-top:32px;padding:20px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc}
.os-form h2{margin:0 0 12px;font-size:18px}.os-field{display:block;margin:0 0 14px}.os-field>span{display:block;margin-bottom:4px;font-weight:600;font-size:14px}
.os-field input:not([type=checkbox]),.os-field select,.os-field textarea{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;background:#fff}
.os-field textarea{min-height:72px}.os-req{color:#dc2626}.os-check{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px}
.os-send{padding:9px 20px;border:0;border-radius:8px;background:#1d4ed8;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.os-note{padding:12px 14px;border-radius:8px;margin:0 0 14px;font-size:14px}.os-ok{background:#dcfce7;color:#166534}.os-bad{background:#fef3c7;color:#92400e}`;

type FormView = { fields: { key: string; name: string; type: string; options?: string[]; required: boolean }[]; state: string; token: string; thanks: string; preview?: boolean } | null;
type PreviewResult = "none" | null;

const NOTES: Record<string, string> = {
  required: "أكمل الحقول المطلوبة ثم أرسل.",
  invalid: "في القيم ما لا يقبله النموذج؛ راجعها ثم أرسل.",
  busy: "أرسلت ردوداً كثيرة الآن؛ حاول بعد دقيقة.",
  stale: "انتهت صلاحية الصفحة المفتوحة؛ أعد تحميلها ثم أرسل.",
  closed: "أُغلق هذا النموذج.",
  full: "اكتمل عدد الردود المطلوب لهذا النموذج.",
  answered: "أرسلت ردك على هذا النموذج من قبل. شكراً لك.",
};

function fieldHtml(f: NonNullable<FormView>["fields"][number]) {
  const name = `f_${esc(f.key)}`;
  const req = f.required ? " required" : "";
  const label = `${esc(f.name)}${f.required ? ' <b class="os-req">*</b>' : ""}`;
  if (f.type === "check") return `<label class="os-field os-check"><input type="checkbox" name="${name}" value="1"> ${label}</label>`;
  let input: string;
  if (f.type === "status" || f.type === "select") input = `<select name="${name}"${req}><option value="">—</option>${(f.options ?? []).map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
  else if (f.type === "number") input = `<input type="number" step="any" name="${name}"${req}>`;
  else if (f.type === "date") input = `<input type="date" name="${name}"${req}>`;
  else input = `<textarea name="${name}" maxlength="2000"${req}></textarea>`;
  return `<label class="os-field"><span>${label}</span>${input}</label>`;
}

function formHtml(slug: string, form: FormView, note: string | null, previewed: PreviewResult = null) {
  if (!form) return "";
  const head = `<h2>شاركنا رأيك</h2>`;
  if (form.preview) {
    const banner = `<p class="os-note os-bad">معاينة: هذه صفحتك كما يراها غيرك. ما ترسله هنا لا يُحفظ ولا يُحسب رداً.</p>`;
    const got = previewed ? `<p class="os-note os-ok">وصل الرد (للتجربة، ولم يُحفظ).</p>` : "";
    const msg = note && NOTES[note] ? `<p class="os-note os-bad">${NOTES[note]}</p>` : "";
    return `<form class="os-form" method="post" action="/f/${esc(slug)}?preview=1">${head}${banner}${got}${msg}<input type="hidden" name="_t" value="${esc(form.token)}">${form.fields.map(fieldHtml).join("")}<button class="os-send" type="submit">أرسل (تجربة)</button></form>`;
  }
  if (note === "sent") return `<section class="os-form">${head}<p class="os-note os-ok">${esc(form.thanks)}</p></section>`;
  if (form.state !== "open") return `<section class="os-form">${head}<p class="os-note os-bad">${NOTES[form.state]}</p></section>`;
  const msg = note && NOTES[note] ? `<p class="os-note os-bad">${NOTES[note]}</p>` : "";
  return `<form class="os-form" method="post" action="/f/${esc(slug)}">${head}${msg}<input type="hidden" name="_t" value="${esc(form.token)}">${form.fields.map(fieldHtml).join("")}<button class="os-send" type="submit">أرسل</button></form>`;
}

export function pageHtml(p: { title: string; kind: string; content: string; spaceName: string; form?: FormView }, slug = "", note: string | null = null, previewed: PreviewResult = null) {
  const body = p.kind === "html" ? stripMeta(p.content) : renderAnswer(p.kind === "table" ? tableToMarkdown(p.content) : p.content, new Set());
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${esc(p.title)}</title><style>${BASE_STYLE}${PAGE_STYLE}</style></head><body>${body}${formHtml(slug, p.form ?? null, note, previewed)}<p class="os-pub-foot">نُشر من مساحة${p.spaceName ? ` · ${esc(p.spaceName)}` : ""}</p><script>${TABLE_TOOLS}</script></body></html>`;
}

function appResponse(origin: string, files: Record<string, string>, cfg: PageConfig, title: string, spaceName: string, isPublic: boolean) {
  const { html, csp } = bundlePage(files, cfg, { title, footer: `${cfg.test ? "تجربة: ما يُرسل هنا لا يُحفظ · " : ""}نُشر من مساحة${spaceName ? ` · ${spaceName}` : ""}`, origin });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": isPublic ? "no-cache" : "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  });
}

/** The data API's answers: JSON any (opaque, sandboxed) page may read; nothing is sent with credentials. */
const apiJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export function registerPublicationRoutes(http: HttpRouter) {
  // A test link (plans/13 §4): a draft app, or a publication's «جرّبها», with every write dry-run.
  http.route({
    pathPrefix: "/t/",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const origin = publishOrigin();
      if (!origin || requestHost(request) !== new URL(origin).host) return notFound();
      const token = new URL(request.url).pathname.slice(3).replace(/\/+$/, "");
      if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return notFound();
      const t = await ctx.runQuery(internal.apps.testPage, { token });
      if (!t) return new Response("انتهت صلاحية رابط التجربة.", { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
      return appResponse(origin, t.files, { api: `${origin}/a/test`, token, visitor: t.visitor, lists: t.lists, test: true }, t.title, "", false);
    }),
  });

  // An app's data API (plans/13 §2–3): append, mine, stats, call. The body is text/plain JSON (no preflight).
  http.route({
    pathPrefix: "/a/",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const origin = publishOrigin();
      if (!origin || requestHost(request) !== new URL(origin).host) return notFound();
      const target = new URL(request.url).pathname.slice(3).replace(/\/+$/, "");
      if (target !== "test" && !SLUG.test(target)) return notFound();
      if (Number(request.headers.get("content-length") ?? 0) > 64 * 1024) return apiJson({ ok: false, error: "الطلب أكبر من المسموح" }, 413);
      let body: any;
      try {
        const text = await request.text();
        if (text.length > 64 * 1024) return apiJson({ ok: false, error: "الطلب أكبر من المسموح" }, 413);
        body = JSON.parse(text);
      } catch {
        return apiJson({ ok: false, error: "طلب غير صالح" }, 400);
      }
      const token = String(body?.t ?? "").slice(0, 200);
      const op = String(body?.op ?? "");
      const ip = clientIp(request);
      if (op === "call") {
        const handler = String(body?.handler ?? "").slice(0, 40);
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(handler)) return apiJson({ ok: false, error: "اسم معالج غير صالح" }, 400);
        const start = await ctx.runMutation(internal.apps.handlerStart, { target, token, ip, handler });
        if (!start.ok) return apiJson({ ok: false, error: start.error }, start.status);
        const outcome = await runHandler(start.files, handler, { payload: body?.payload ?? null, visitor: start.visitor, test: start.test });
        const r = await ctx.runMutation(internal.apps.handlerFinish, { target, token, handler, payload: body?.payload ?? null, outcome });
        return r.ok ? apiJson({ ok: true, value: r.value }) : apiJson({ ok: false, error: r.error }, r.status);
      }
      if (op !== "append" && op !== "mine" && op !== "stats") return apiJson({ ok: false, error: `عملية غير معروفة: ${op}` }, 400);
      const r = await ctx.runMutation(internal.apps.apiData, { target, token, ip, op, list: String(body?.list ?? "").slice(0, 40), ...(op === "append" ? { row: body?.row && typeof body.row === "object" ? body.row : {} } : {}) });
      return r.ok ? apiJson({ ok: true, value: r.value }) : apiJson({ ok: false, error: r.error }, r.status);
    }),
  });

  http.route({
    pathPrefix: "/p/",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const origin = publishOrigin();
      const app = appOrigin();
      if (!origin || !app || requestHost(request) !== new URL(origin).host) return notFound();
      const url = new URL(request.url);
      const slug = url.pathname.slice(3).replace(/\/+$/, "");
      if (!SLUG.test(slug)) return notFound();
      const preview = url.searchParams.get("preview") === "1";
      const toApp = () => new Response(null, { status: 302, headers: { Location: `${app}/#/open/${slug}${preview ? "/preview" : ""}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

      const ticket = url.searchParams.get("t");
      if (ticket) {
        const r = await ctx.runMutation(internal.publications.redeemTicket, { slug, token: ticket.slice(0, 200) });
        if (!r) return toApp();
        const secure = origin.startsWith("https:") ? "; Secure" : "";
        return new Response(null, {
          status: 303,
          headers: {
            Location: `/p/${slug}${preview ? "?preview=1" : ""}`,
            "Set-Cookie": `${COOKIE}=${r.session}; Path=/p/${slug}; Max-Age=${r.maxAge}; HttpOnly; SameSite=Lax${secure}`,
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        });
      }
      const session = cookieOf(request, COOKIE);
      let page = session ? await ctx.runMutation(internal.publications.pageForSession, { slug, session: session.slice(0, 200), preview }) : null;
      let isPublic = false;
      if (!page && !preview) {
        // No session: a public page opens for anyone (plans/11 step 3); anything else goes through the app.
        const pub = await ctx.runMutation(internal.publications.publicPage, { slug, ip: clientIp(request) });
        if (pub && "busy" in pub) return busy();
        if (pub) {
          page = pub;
          isPublic = true;
          // «One reply per reader» for someone not signed in: this browser already sent one.
          if (pub.form && pub.form.state === "open" && cookieOf(request, doneCookie(slug)) && url.searchParams.get("sent") === null) page = { ...pub, form: { ...pub.form, state: "answered" } };
        }
      }
      if (!page) return toApp();
      if ("app" in page && page.app) {
        // An app (plans/13): one bundled document, its scripts by hash, its only connection its own API.
        const a = page.app;
        return appResponse(origin, a.files, { api: `${origin}/a/${a.test ? "test" : slug}`, token: a.token, visitor: a.visitor, lists: a.lists, test: a.test }, page.title, page.spaceName, isPublic);
      }
      const note = url.searchParams.get("sent") ? "sent" : url.searchParams.get("err");
      const previewed: PreviewResult = url.searchParams.get("ps") === "none" ? "none" : null;
      return new Response(pageHtml(page as Parameters<typeof pageHtml>[0], slug, note && /^[a-z]{3,12}$/.test(note) ? note : null, previewed), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": pageCsp(origin),
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Cache-Control": isPublic ? "no-cache" : "private, no-store",
          "X-Robots-Tag": "noindex, nofollow",
          "Cross-Origin-Opener-Policy": "same-origin",
        },
      });
    }),
  });

  // A form under a published page: posted from the page (no script), with the page's form token.
  http.route({
    pathPrefix: "/f/",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const origin = publishOrigin();
      const app = appOrigin();
      if (!origin || !app || requestHost(request) !== new URL(origin).host) return notFound();
      const slug = new URL(request.url).pathname.slice(3).replace(/\/+$/, "");
      if (!SLUG.test(slug)) return notFound();
      if (Number(request.headers.get("content-length") ?? 0) > 64 * 1024) return notFound();
      let data: FormData;
      try {
        data = await request.formData();
      } catch {
        return notFound();
      }
      const values: Record<string, string> = {};
      for (const [k, val] of data.entries()) if (k.startsWith("f_") && typeof val === "string") values[k.slice(2, 40)] = val.slice(0, 2000);
      const preview = new URL(request.url).searchParams.get("preview") === "1";
      const r = await ctx.runMutation(internal.publications.submitForm, { slug, token: String(data.get("_t") ?? "").slice(0, 200), values, preview });
      let to: string;
      let setCookie: string | null = null;
      if (r === "expired" && !preview) {
        // Not a signed-in session's token: maybe an anonymous reply on a public page.
        const pr = await ctx.runMutation(internal.publications.submitPublicForm, { slug, token: String(data.get("_t") ?? "").slice(0, 200), values, ip: clientIp(request), done: !!cookieOf(request, doneCookie(slug)) });
        if (pr !== "gone") {
          if (typeof pr === "string") to = `/p/${slug}?err=${pr}`;
          else {
            to = `/p/${slug}?sent=1`;
            setCookie = `${doneCookie(slug)}=1; Path=/; Max-Age=31536000; SameSite=Lax${origin.startsWith("https:") ? "; Secure" : ""}`;
          }
          return new Response(null, { status: 303, headers: { Location: to, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...(setCookie ? { "Set-Cookie": setCookie } : {}) } });
        }
      }
      if (r === "expired") to = `${app}/#/open/${slug}`;
      else if (typeof r === "string") to = `/p/${slug}?${preview ? "preview=1&" : ""}err=${r}`;
      else if (r) to = `/p/${slug}?preview=1&ps=none`;
      else to = `/p/${slug}?sent=1`;
      return new Response(null, { status: 303, headers: { Location: to, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    }),
  });
}
