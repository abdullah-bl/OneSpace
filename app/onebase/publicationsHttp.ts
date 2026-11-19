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

type FormView = { fields: { key: string; name: string; type: string; options?: string[]; required: boolean }[]; state: string; token: string; thanks: string } | null;

const NOTES: Record<string, string> = {
  required: "أكمل الحقول المطلوبة ثم أرسل.",
  invalid: "في القيم ما لا يقبله النموذج؛ راجعها ثم أرسل.",
  busy: "أرسلت ردوداً كثيرة الآن؛ حاول بعد دقيقة.",
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

function formHtml(slug: string, form: FormView, note: string | null) {
  if (!form) return "";
  const head = `<h2>شاركنا رأيك</h2>`;
  if (note === "sent") return `<section class="os-form">${head}<p class="os-note os-ok">${esc(form.thanks)}</p></section>`;
  if (form.state !== "open") return `<section class="os-form">${head}<p class="os-note os-bad">${NOTES[form.state]}</p></section>`;
  const msg = note && NOTES[note] ? `<p class="os-note os-bad">${NOTES[note]}</p>` : "";
  return `<form class="os-form" method="post" action="/f/${esc(slug)}">${head}${msg}<input type="hidden" name="_t" value="${esc(form.token)}">${form.fields.map(fieldHtml).join("")}<button class="os-send" type="submit">أرسل</button></form>`;
}

export function pageHtml(p: { title: string; kind: string; content: string; spaceName: string; form?: FormView }, slug = "", note: string | null = null) {
  const body = p.kind === "html" ? stripMeta(p.content) : renderAnswer(p.kind === "table" ? tableToMarkdown(p.content) : p.content, new Set());
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${esc(p.title)}</title><style>${BASE_STYLE}${PAGE_STYLE}</style></head><body>${body}${formHtml(slug, p.form ?? null, note)}<p class="os-pub-foot">نُشر من مساحة${p.spaceName ? ` · ${esc(p.spaceName)}` : ""}</p><script>${TABLE_TOOLS}</script></body></html>`;
}

export function registerPublicationRoutes(http: HttpRouter) {
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
      const toApp = () => new Response(null, { status: 302, headers: { Location: `${app}/#/open/${slug}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

      const ticket = url.searchParams.get("t");
      if (ticket) {
        const r = await ctx.runMutation(internal.publications.redeemTicket, { slug, token: ticket.slice(0, 200) });
        if (!r) return toApp();
        const secure = origin.startsWith("https:") ? "; Secure" : "";
        return new Response(null, {
          status: 303,
          headers: {
            Location: `/p/${slug}`,
            "Set-Cookie": `${COOKIE}=${r.session}; Path=/p/${slug}; Max-Age=${r.maxAge}; HttpOnly; SameSite=Lax${secure}`,
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        });
      }
      const session = cookieOf(request, COOKIE);
      const page = session ? await ctx.runMutation(internal.publications.pageForSession, { slug, session: session.slice(0, 200) }) : null;
      if (!page) return toApp();
      const note = url.searchParams.get("sent") ? "sent" : url.searchParams.get("err");
      return new Response(pageHtml(page, slug, note && /^[a-z]{3,12}$/.test(note) ? note : null), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": pageCsp(origin),
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "private, no-store",
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
      const err = await ctx.runMutation(internal.publications.submitForm, { slug, token: String(data.get("_t") ?? "").slice(0, 200), values });
      const to = err === "expired" ? `${app}/#/open/${slug}` : `/p/${slug}?${err ? `err=${err}` : "sent=1"}`;
      return new Response(null, { status: 303, headers: { Location: to, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    }),
  });
}
