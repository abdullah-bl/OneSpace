// HTTP routes for official documents, registered from http.ts:
//   GET  /document?t=<one-time ticket>   the issued PDF (ticket from documents:requestDownload)
//   GET  /verify[?code=XXXX-XXXX-XXXX]   public verification page (no sign-in), plain HTML, no script
//   POST /verify  (body = the PDF)       JSON: is this exact file one we issued? (by sha256)
// Storage ids never leave the server; the PDF is streamed from ctx.storage.get.

import type { HttpRouter } from "onebase/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { sha256Hex } from "./recordSources";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
};

function page(body: string) {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>التحقق من مستند</title>
<style>body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:24px}main{max-width:560px;margin:auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px}
h1{font-size:20px;color:#115e59;margin-top:0}input{font:inherit;padding:8px;border:1px solid #cbd5e1;border-radius:8px;width:60%}button{font:inherit;padding:8px 14px;border:0;border-radius:8px;background:#0f766e;color:#fff}
.ok{background:#f0fdfa;border:1px solid #99f6e4;padding:12px;border-radius:8px}.bad{background:#fef2f2;border:1px solid #fecaca;padding:12px;border-radius:8px}code{direction:ltr;unicode-bidi:embed;word-break:break-all;font-size:12px}</style></head>
<body><main><h1>التحقق من مستند رسمي</h1>${body}</main></body></html>`;
}

export function registerDocumentRoutes(http: HttpRouter) {
  http.route({
    path: "/document",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const token = new URL(request.url).searchParams.get("t") ?? "";
      let grant: { storageId: string; name: string } | null = null;
      try {
        grant = token ? await ctx.runMutation(internal.documents.redeemTicket, { token }) : null;
      } catch {
        grant = null;
      }
      const blob = grant ? await ctx.storage.get(grant.storageId as any) : null;
      if (!grant || !blob) return new Response("غير موجود أو لا تملك صلاحية الوصول إليه", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
      return new Response(blob, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": String(blob.size),
          "Content-Disposition": `inline; filename="${grant.name.replace(/[^\x20-\x7e]/g, "_")}"`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    }),
  });

  http.route({
    path: "/verify",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const code = new URL(request.url).searchParams.get("code") ?? "";
      const form = `<form method="get" action="/verify"><p>أدخل رمز التحقق المطبوع على المستند:</p><input name="code" dir="ltr" value="${esc(code.slice(0, 40))}" placeholder="XXXX-XXXX-XXXX"> <button>تحقق</button></form>`;
      if (!code) return new Response(page(form), { headers: PAGE_HEADERS });
      const r: any = await ctx.runQuery(internal.documents.verifyByCodeInternal, { code: code.slice(0, 40) });
      const result = r.valid
        ? `<div class="ok"><p><b>مستند صحيح صادر من المنصة.</b></p><p>النوع: ${esc(r.templateName)}<br>الرقم التسلسلي: <code>${esc(r.serial)}</code><br>تاريخ الإصدار: <code>${new Date(r.issuedAt).toISOString().slice(0, 10)}</code><br>بصمة الملف (sha256): <code>${esc(r.sha256)}</code></p><p>طابق البصمة مع بصمة الملف الذي بين يديك.</p></div>`
        : `<div class="bad"><b>لا يوجد مستند صادر بهذا الرمز.</b></div>`;
      return new Response(page(result + form), { status: r.valid ? 200 : 404, headers: PAGE_HEADERS });
    }),
  });

  http.route({
    path: "/verify",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > 20 * 1024 * 1024) return Response.json({ valid: false }, { status: 400 });
      const sha256 = sha256Hex(bytes);
      const r = await ctx.runQuery(internal.documents.verifyBySha, { sha256 });
      return Response.json({ ...r, sha256 }, { status: r.valid ? 200 : 404, headers: { "Cache-Control": "no-store" } });
    }),
  });
}
