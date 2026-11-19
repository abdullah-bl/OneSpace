import { httpRouter } from "onebase/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { requireUserId } from "./access";
import { registerDocumentRoutes } from "./documentsHttp";
import { registerPublicationRoutes } from "./publicationsHttp";

const http = httpRouter();

const SAFE_INLINE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain|audio\/|video\/)/;

function contentDisposition(kind: "inline" | "attachment", name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const denied = () =>
  new Response("غير موجود أو لا تملك صلاحية الوصول إليه", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/**
 * GET /download?t=<one-time ticket>              (from files.requestDownload; works as a plain link)
 * GET /download?fileId=<id>[&v=<n>][&inline=1]   with Authorization: Bearer <session token>
 * Either way access is checked again here (assertCan read) and sensitive spaces are audited.
 */
http.route({
  path: "/download",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    let grant: { storageId: string; name: string; mime: string; size: number; inline: boolean } | null = null;
    try {
      const ticket = url.searchParams.get("t");
      if (ticket) {
        grant = await ctx.runMutation(internal.files.redeemTicket, { token: ticket });
      } else {
        const userId = await requireUserId(ctx);
        const fileId = url.searchParams.get("fileId") ?? "";
        const v = url.searchParams.get("v");
        grant = await ctx.runMutation(internal.files.authorizeDownload, {
          userId,
          fileId,
          version: v ? Number(v) : undefined,
          inline: url.searchParams.get("inline") === "1",
        });
      }
    } catch {
      grant = null;
    }
    if (!grant) return denied();
    const blob = await ctx.storage.get(grant.storageId as any);
    if (!blob) return denied();
    const inline = grant.inline && SAFE_INLINE.test(grant.mime);
    const type = inline && grant.mime.startsWith("text/") && !/charset=/i.test(grant.mime) ? `${grant.mime}; charset=utf-8` : grant.mime;
    return new Response(blob, {
      headers: {
        "Content-Type": inline ? type : "application/octet-stream",
        "Content-Length": String(blob.size),
        "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", grant.name),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      },
    });
  }),
});

// Phase 4: issued documents (/document) and public verification (/verify).
registerDocumentRoutes(http);
// plans/11: published pages, on the content origin only.
registerPublicationRoutes(http);

export default http;
