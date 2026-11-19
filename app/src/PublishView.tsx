// «النشر» (plans/11, step 1): publish an output at a fixed link for its space or the whole
// workspace (PublishBox, in the output panel), «منشوراتي» (#/published), and #/open/<slug>, where
// the app checks the reader and sends them on to the content origin with a one-time ticket.
// Every permission decision is the server's (onebase/publications.ts).

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "onebase/react";
import { api, errorText, formatDate } from "./lib";
import { Icon } from "./icons";
import { ask, EmptyState, PageHeader, tell } from "./ui";

type Pub = {
  _id: string;
  slug: string;
  title: string;
  artifactId: string;
  version: number;
  currentVersion: number | null;
  audience: "space" | "workspace";
  state: "live" | "pending" | "revoked";
  views: number;
  createdAt: number;
  url: string | null;
  mine?: boolean;
  personal?: boolean;
  spaceName?: string;
  by?: string;
};

const AUDIENCE: Record<Pub["audience"], string> = { space: "أعضاء المساحة", workspace: "كل الموظفين" };
const run = (p: Promise<unknown>) => p.catch((e) => void tell(errorText(e)));

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="btn-secondary h-8 text-xs" onClick={() => void navigator.clipboard?.writeText(url).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}>
      <Icon name={copied ? "check" : "copy"} size={14} /> {copied ? "نُسخ" : "انسخ الرابط"}
    </button>
  );
}

function PubRow({ p, showTitle }: { p: Pub; showTitle?: boolean }) {
  const update = useMutation(api.publications.update);
  const revoke = useMutation(api.publications.revoke);
  const stale = p.currentVersion !== null && p.currentVersion !== p.version;
  return (
    <li className="space-y-2 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {showTitle && <span className="min-w-0 flex-1 truncate font-medium">{p.title}</span>}
        <span className={`rounded-full px-2 py-0.5 text-xs ${p.state === "live" ? "bg-positive-soft text-positive" : "bg-warning-soft text-warning"}`}>{p.state === "live" ? "منشور" : "بانتظار المدير"}</span>
        <span className="text-xs text-muted">
          {p.personal && p.audience === "space" ? "أنا فقط" : AUDIENCE[p.audience]}
          {p.spaceName ? ` · ${p.spaceName}` : ""} · النسخة {p.version} · {p.views} مشاهدة
        </span>
      </div>
      {p.url && (
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-sunken px-2 py-1 text-xs" dir="ltr">
            {p.url}
          </code>
          <CopyLink url={p.url} />
        </div>
      )}
      {(p.mine ?? true) && (
        <div className="flex flex-wrap gap-2">
          {stale && (
            <button className="btn-ghost h-7 px-2 text-xs" onClick={() => void run(update({ publicationId: p._id }))}>
              حدّث إلى النسخة {p.currentVersion}
            </button>
          )}
          <button
            className="btn-ghost h-7 px-2 text-xs text-negative"
            onClick={() => void ask("إيقاف النشر؟ يتوقف الرابط فوراً.", { danger: true, confirmLabel: "أوقف" }).then((ok) => ok && run(revoke({ publicationId: p._id })))}
          >
            أوقف النشر
          </button>
        </div>
      )}
    </li>
  );
}

/** In the output panel: publish this output, and its links. */
export function PublishBox({ artifactId, onClose }: { artifactId: string; onClose: () => void }) {
  const data = useQuery(api.publications.forArtifact, { artifactId }) as
    | { enabled: boolean; canPublish: boolean; needsApproval: boolean; audiences: Pub["audience"][]; spaceName: string; personal: boolean; publications: Pub[] }
    | undefined;
  const publish = useMutation(api.publications.publish);
  const [audience, setAudience] = useState<Pub["audience"]>("space");
  const [msg, setMsg] = useState("");
  if (!data) return null;
  return (
    <section className="shrink-0 animate-fade space-y-2 border-b border-line bg-sunken/40 px-4 py-3 text-sm">
      <div className="flex items-center gap-2">
        <Icon name="globe" size={16} className="text-primary" />
        <span className="font-medium">النشر برابط</span>
        <button className="btn-ghost ms-auto h-7 w-7 px-0" aria-label="إغلاق" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {!data.enabled ? (
        <p className="text-xs leading-6 text-muted">النشر غير مفعّل على هذا الخادم بعد. يحتاج مدير المنصة إلى ضبط نطاق منفصل للصفحات المنشورة (PUBLISH_ORIGIN).</p>
      ) : (
        <>
          {data.publications.length > 0 && <ul className="divide-y divide-rule">{data.publications.map((p) => <PubRow key={p._id} p={p} />)}</ul>}
          {data.canPublish && (
            <div className="space-y-2 pt-1">
              <p className="text-xs text-muted">من يفتح الرابط؟ يدخل بحسابه، ولا يرى غير هذه الصفحة.</p>
              <div className="flex flex-wrap gap-2">
                {data.audiences.map((a) => (
                  <label key={a} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-xs ${audience === a ? "border-primary bg-primary-soft" : "border-line"}`}>
                    <input type="radio" name="audience" className="accent-[var(--color-primary)]" checked={audience === a} onChange={() => setAudience(a)} />
                    {a === "space" ? (data.personal ? "أنا فقط" : `أعضاء «${data.spaceName}»`) : "كل الموظفين"}
                  </label>
                ))}
              </div>
              {data.audiences.length === 1 && !data.personal && <p className="text-xs text-faint">مخرجات المساحات الحساسة تُنشر لأعضاء مساحتها فقط.</p>}
              <button
                className="btn-primary h-8"
                onClick={() =>
                  void publish({ artifactId, audience })
                    .then((r) => setMsg(r.state === "pending" ? "أُرسل لمدير المساحة ليعتمده، ويعمل الرابط بعد اعتماده." : "نُشر. انسخ الرابط وأرسله."))
                    .catch((e) => setMsg(errorText(e)))
                }
              >
                {data.needsApproval ? "اطلب النشر" : "انشر"}
              </button>
              {msg && <p className="text-xs text-muted">{msg}</p>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** #/published: «منشوراتي», and what waits for my approval in spaces I manage. */
export function PublishedPage() {
  const data = useQuery(api.publications.mine) as { enabled: boolean; mine: Pub[]; pending: Pub[] } | undefined;
  const review = useMutation(api.publications.review);
  return (
    <div className="mx-auto w-full max-w-[860px] px-4 py-6 lg:py-9">
      <PageHeader title="منشوراتي" subtitle="مخرجات نشرتها برابط. لا يفتح الرابط إلا من سمحت له، بعد أن يدخل بحسابه." />
      {data === undefined ? (
        <p className="text-sm text-muted">جارٍ التحميل…</p>
      ) : (
        <div className="space-y-6">
          {data.pending.length > 0 && (
            <section>
              <h2 className="section-title mb-2">بانتظار اعتمادك</h2>
              <ul className="card divide-y divide-rule px-4">
                {data.pending.map((p) => (
                  <li key={p._id} className="flex flex-wrap items-center gap-2 py-3 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{p.title}</span>
                      <span className="text-xs text-muted">
                        {p.by} · {p.spaceName} · {AUDIENCE[p.audience]} · {formatDate(p.createdAt)}
                      </span>
                    </span>
                    <button className="btn-primary h-8 text-xs" onClick={() => void run(review({ publicationId: p._id, approve: true }))}>
                      اعتمد
                    </button>
                    <button className="btn-ghost h-8 text-xs" onClick={() => void run(review({ publicationId: p._id, approve: false }))}>
                      ارفض
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.mine.length === 0 ? (
            <EmptyState icon="globe" title="لم تنشر شيئاً بعد">
              افتح أي مخرج (صفحة، مستند، جدول) واختر «انشر…» من قائمته، ليصير له رابط ترسله لزملائك.
            </EmptyState>
          ) : (
            <ul className="card divide-y divide-rule px-4">
              {data.mine.map((p) => (
                <PubRow key={p._id} p={p} showTitle />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** #/open/<slug>: check the reader, then go to the page on the content origin with a one-time ticket. */
export function OpenPublication({ slug }: { slug: string }) {
  const openTicket = useMutation(api.publications.openTicket);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    openTicket({ slug })
      .then((url: string) => window.location.replace(url))
      .catch(() => setFailed(true));
  }, [slug]);
  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      {failed ? (
        <>
          <h1 className="page-title">غير متاح</h1>
          <p className="mt-2 text-sm text-muted">هذه الصفحة غير موجودة، أو أوقف ناشرها نشرها، أو لا تملك صلاحية فتحها.</p>
          <a className="btn-secondary mt-4 inline-flex" href="#/">
            الرئيسية
          </a>
        </>
      ) : (
        <p className="text-sm text-muted">يفتح الصفحة…</p>
      )}
    </div>
  );
}
