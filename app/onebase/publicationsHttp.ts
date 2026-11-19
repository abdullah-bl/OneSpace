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

const PAGE_CSP = `${ARTIFACT_CSP}; frame-ancestors 'none'; sandbox allow-scripts`;

const PAGE_STYLE = `body{max-width:860px;margin:0 auto;padding:24px 16px 48px}
.os-pub-foot{margin-top:40px;padding-top:12px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px}`;

export function pageHtml(p: { title: string; kind: string; content: string; spaceName: string }) {
  const body = p.kind === "html" ? stripMeta(p.content) : renderAnswer(p.kind === "table" ? tableToMarkdown(p.content) : p.content, new Set());
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${esc(p.title)}</title><style>${BASE_STYLE}${PAGE_STYLE}</style></head><body>${body}<p class="os-pub-foot">نُشر من مساحة${p.spaceName ? ` · ${esc(p.spaceName)}` : ""}</p><script>${TABLE_TOOLS}</script></body></html>`;
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
      return new Response(pageHtml(page), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": PAGE_CSP,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "private, no-store",
          "X-Robots-Tag": "noindex, nofollow",
          "Cross-Origin-Opener-Policy": "same-origin",
        },
      });
    }),
  });
}
