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
  audience: "space" | "workspace" | "public";
  state: "live" | "pending" | "revoked";
  views: number;
  createdAt: number;
  url: string | null;
  mine?: boolean;
  personal?: boolean;
  spaceName?: string;
  by?: string;
  form: {
    listId: string;
    fields: { key: string; required: boolean }[];
    replies: number;
    thanks: string;
    closesAt: number | null;
    maxReplies: number | null;
    onePerReader: boolean;
    recordSender: boolean;
  } | null;
  listTitle?: string | null;
  /** An app (plans/13): rows it added, and what it may do with lists, in words. */
  app?: { rows: number } | null;
  appGrants?: string[] | null;
};

type ListOption = { _id: string; title: string; columns: { key: string; name: string; type: string; options: string[] }[] };

/** An app publication's grants, as the publish card listed them. */
export function AppGrants({ grants, rows }: { grants: string[]; rows?: number }) {
  return (
    <div className="space-y-1 rounded-md bg-surface px-2 py-1.5 text-xs">
      <p className="font-medium">
        <Icon name="code" size={13} className="me-1 inline text-primary" />
        صلاحيات التطبيق{rows !== undefined ? <span className="font-normal text-muted"> · {rows} صفاً أضافها</span> : null}
      </p>
      {grants.length ? (
        <ul className="list-inside list-disc text-muted">
          {grants.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">لا يكتب في أي قائمة ولا يقرأ منها.</p>
      )}
    </div>
  );
}

/** Under a publication: the form that sends replies into a list of the same space (plans/11 step 2). */
function FormSettings({ p }: { p: Pub }) {
  const [editing, setEditing] = useState(false);
  const addFeedback = useMutation(api.publications.addFeedbackForm);
  const setForm = useMutation(api.publications.setForm);
  if (p.app) return <AppGrants grants={p.appGrants ?? []} rows={p.app.rows} />;
  if (editing) return <FormEditor p={p} onDone={() => setEditing(false)} />;
  if (!p.form)
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted">نموذج تحت الصفحة:</span>
        <button className="btn-ghost h-7 px-2 text-xs" onClick={() => void run(addFeedback({ publicationId: p._id }))}>
          <Icon name="plus" size={13} /> نموذج ملاحظات
        </button>
        <button className="btn-ghost h-7 px-2 text-xs" onClick={() => setEditing(true)}>
          اربطه بقائمة…
        </button>
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface px-2 py-1.5 text-xs">
      <Icon name="table" size={13} className="text-primary" />
      <span className="min-w-0 flex-1">
        يرسل الردود إلى{" "}
        <a className="font-medium text-primary hover:underline" href={`#/list/${p.form.listId}`}>
          «{p.listTitle ?? "قائمة"}»
        </a>{" "}
        · <span className="num">{p.form.replies}</span> رد{p.form.maxReplies ? ` من ${p.form.maxReplies}` : ""}
        {p.form.closesAt ? ` · يُغلق ${formatDate(p.form.closesAt)}` : ""}
      </span>
      <button className="btn-ghost h-7 px-2 text-xs" onClick={() => setEditing(true)}>
        عدّل
      </button>
      <button className="btn-ghost h-7 px-2 text-xs text-negative" onClick={() => void ask("حذف النموذج من الصفحة؟ تبقى الردود في القائمة.", { confirmLabel: "احذف" }).then((ok) => ok && run(setForm({ publicationId: p._id, form: null })))}>
        احذفه
      </button>
    </div>
  );
}

function FormEditor({ p, onDone }: { p: Pub; onDone: () => void }) {
  const lists = useQuery(api.publications.formOptions, { publicationId: p._id }) as ListOption[] | undefined;
  const setForm = useMutation(api.publications.setForm);
  const [listId, setListId] = useState(p.form?.listId ?? "");
  const [fields, setFields] = useState<Record<string, { on: boolean; required: boolean }>>(() => Object.fromEntries((p.form?.fields ?? []).map((f) => [f.key, { on: true, required: f.required }])));
  const [thanks, setThanks] = useState(p.form?.thanks ?? "");
  const [onePerReader, setOne] = useState(p.form?.onePerReader ?? true);
  const [recordSender, setSender] = useState(p.form?.recordSender ?? true);
  const [maxReplies, setMax] = useState(p.form?.maxReplies ? String(p.form.maxReplies) : "");
  const [closes, setCloses] = useState(p.form?.closesAt ? new Date(p.form.closesAt).toISOString().slice(0, 10) : "");
  const [error, setError] = useState("");
  const list = lists?.find((l) => l._id === listId);
  useEffect(() => {
    // A newly picked list: every column on, none required.
    if (list && !list.columns.some((c) => fields[c.key])) setFields(Object.fromEntries(list.columns.map((c) => [c.key, { on: true, required: false }])));
  }, [listId, lists]);
  if (!lists) return <p className="text-xs text-muted">جارٍ التحميل…</p>;
  const save = async () => {
    setError("");
    try {
      await setForm({
        publicationId: p._id,
        form: {
          listId,
          fields: (list?.columns ?? []).filter((c) => fields[c.key]?.on).map((c) => ({ key: c.key, required: !!fields[c.key]?.required })),
          recordSender,
          onePerReader,
          ...(thanks.trim() ? { thanks } : {}),
          ...(Number(maxReplies) > 0 ? { maxReplies: Number(maxReplies) } : {}),
          ...(closes ? { closesAt: new Date(`${closes}T23:59:59`).getTime() } : {}),
        },
      });
      onDone();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="space-y-2 rounded-md border border-line bg-surface p-3 text-xs">
      {lists.length === 0 ? (
        <p className="text-muted">لا قوائم في مساحة هذا المنشور. أنشئ قائمة بالأعمدة التي تريد أن يجيب عنها القارئ، أو اختر «نموذج ملاحظات».</p>
      ) : (
        <>
          <label className="flex items-center gap-2">
            <span className="text-muted">الردود إلى:</span>
            <select className="input h-8 w-auto text-xs" value={listId} onChange={(e) => setListId(e.target.value)}>
              <option value="">اختر قائمة…</option>
              {lists.map((l) => (
                <option key={l._id} value={l._id}>
                  {l.title}
                </option>
              ))}
            </select>
          </label>
          {list && (
            <ul className="space-y-1">
              {list.columns.map((c) => (
                <li key={c.key} className="flex items-center gap-3">
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <input type="checkbox" checked={!!fields[c.key]?.on} onChange={(e) => setFields((f) => ({ ...f, [c.key]: { on: e.target.checked, required: !!f[c.key]?.required } }))} />
                    {c.name}
                  </label>
                  <label className={`flex items-center gap-1 ${fields[c.key]?.on ? "" : "opacity-40"}`}>
                    <input type="checkbox" disabled={!fields[c.key]?.on} checked={!!fields[c.key]?.required} onChange={(e) => setFields((f) => ({ ...f, [c.key]: { on: true, required: e.target.checked } }))} />
                    مطلوب
                  </label>
                </li>
              ))}
            </ul>
          )}
          <input className="input h-8 w-full text-xs" value={thanks} maxLength={500} onChange={(e) => setThanks(e.target.value)} placeholder="رسالة بعد الإرسال (اختياري)" />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={onePerReader} onChange={(e) => setOne(e.target.checked)} /> رد واحد لكل شخص
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={recordSender} onChange={(e) => setSender(e.target.checked)} /> سجّل اسم المرسل
            </label>
            <label className="flex items-center gap-1.5">
              حد الردود <input className="input h-7 w-20 text-xs" inputMode="numeric" value={maxReplies} onChange={(e) => setMax(e.target.value.replace(/\D/g, ""))} placeholder="—" />
            </label>
            <label className="flex items-center gap-1.5">
              يُغلق في <input type="date" className="input h-7 w-auto text-xs" value={closes} onChange={(e) => setCloses(e.target.value)} />
            </label>
          </div>
        </>
      )}
      <div className="flex gap-2">
        <button className="btn-primary h-8 text-xs" disabled={!listId} onClick={() => void save()}>
          احفظ النموذج
        </button>
        <button className="btn-ghost h-8 text-xs" onClick={onDone}>
          إلغاء
        </button>
      </div>
      {error && <p className="text-negative">{error}</p>}
    </div>
  );
}

const AUDIENCE: Record<Pub["audience"], string> = { space: "أعضاء المساحة", workspace: "كل الموظفين", public: "أي أحد معه الرابط" };
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
          <a className="btn-ghost h-8 text-xs" href={p.url} target="_blank" rel="noopener noreferrer">
            افتح
          </a>
          {(p.mine ?? true) && (p.form || p.app) && (
            <a className="btn-ghost h-8 text-xs" href={`${p.url}?preview=1`} target="_blank" rel="noopener noreferrer" title="ما ترسله في المعاينة لا يُحفظ">
              جرّبها
            </a>
          )}
        </div>
      )}
      {(p.mine ?? true) && <FormSettings p={p} />}
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
    | { enabled: boolean; canPublish: boolean; needsApproval: boolean; audiences: Pub["audience"][]; spaceName: string; personal: boolean; publications: Pub[]; appGrants: string[] | null }
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
              {data.appGrants && <AppGrants grants={data.appGrants} />}
              <p className="text-xs text-muted">{audience === "public" ? "يفتحه أي أحد معه الرابط بلا تسجيل دخول، حتى من خارج الجهة. لا تنشر للعامة بيانات أشخاص أو بيانات داخلية." : "من يفتح الرابط؟ يدخل بحسابه، ولا يرى غير هذه الصفحة."}</p>
              <div className="flex flex-wrap gap-2">
                {data.audiences.map((a) => (
                  <label key={a} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-xs ${audience === a ? "border-primary bg-primary-soft" : "border-line"}`}>
                    <input type="radio" name="audience" className="accent-[var(--color-primary)]" checked={audience === a} onChange={() => setAudience(a)} />
                    {a === "space" ? (data.personal ? "أنا فقط" : `أعضاء «${data.spaceName}»`) : a === "public" ? "أي أحد معه الرابط" : "كل الموظفين"}
                  </label>
                ))}
              </div>
              {data.audiences.length === 1 && !data.personal && <p className="text-xs text-faint">مخرجات المساحات الحساسة تُنشر لأعضاء مساحتها فقط.</p>}
              <button
                className="btn-primary h-8"
                onClick={() =>
                  void (audience === "public" ? ask("نشر للعامة: يفتحه أي أحد معه الرابط بلا تسجيل دخول. هل الصفحة خالية من البيانات الشخصية والداخلية؟", { confirmLabel: "انشر للعامة" }) : Promise.resolve(true))
                    .then((ok) => {
                      if (!ok) throw new Error("");
                      return publish({ artifactId, audience });
                    })
                    .then((r) => setMsg(r.state === "pending" ? "أُرسل لمدير المساحة ليعتمده، ويعمل الرابط بعد اعتماده." : "نُشر. انسخ الرابط وأرسله."))
                    .catch((e) => e instanceof Error && !e.message ? undefined : setMsg(errorText(e)))
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
              افتح أي مخرج (صفحة، مستند، جدول) واختر «انشر برابط…» من قائمته، ليصير له رابط ترسله لزملائك.
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
export function OpenPublication({ slug, preview = false }: { slug: string; preview?: boolean }) {
  const openTicket = useMutation(api.publications.openTicket);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    openTicket({ slug })
      .then((url: string) => window.location.replace(preview ? `${url}&preview=1` : url))
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
