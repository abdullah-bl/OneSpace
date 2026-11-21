// Templates and official documents of a space. Managers write template versions and approve
// them. Documents are issued in batches (plans/17 §4): pick rows of the template's record set
// (by default every row without a document), members create drafts, a manager approves and
// issues in one act. The text of a document only ever comes from the template and the record.

import { ask } from "./ui";
import { useState } from "react";
import { useAction, useMutation, useQuery } from "onebase/react";
import { api, errorText, formatDate, type SpaceInfo } from "./lib";

const STATUS: Record<string, string> = { draft: "مسودة بانتظار الاعتماد", approved: "معتمدة", issued: "صادرة", rejected: "مرفوضة" };

export function DocumentsTab({ space }: { space: SpaceInfo }) {
  const templates = useQuery(api.templates.list, { spaceId: space._id as any });
  const docs = useQuery(api.documents.list, { spaceId: space._id as any });
  const approveAndIssue = useAction(api.documents.approveAndIssue);
  const reject = useMutation(api.documents.reject);
  const issue = useAction(api.documents.issue);
  const requestDownload = useMutation(api.documents.requestDownload);
  const [error, setError] = useState("");
  const run = (fn: () => Promise<unknown>) => {
    setError("");
    fn().catch((e) => setError(errorText(e)));
  };
  const drafts = (docs ?? []).filter((d) => d.status === "draft");
  return (
    <div className="space-y-6">
      {error && <p className="rounded-lg bg-negative-soft p-2 text-sm text-negative">{error}</p>}
      <section className="space-y-2">
        <h2 className="section-title">القوالب</h2>
        {space.canManage && <TemplateEditor spaceId={space._id} />}
        <div className="card divide-y divide-rule">
          {templates?.map((t) => <TemplateRow key={t._id} t={t} canManage={space.canManage} />)}
          {templates?.length === 0 && <div className="p-3 text-sm text-faint">لا قوالب بعد.</div>}
        </div>
      </section>
      {space.canWrite && templates && templates.some((t) => t.approvedVersion) && <IssuePanel templates={templates.filter((t) => t.approvedVersion)} canManage={space.canManage} />}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="section-title flex-1">المستندات</h2>
          {space.canManage && drafts.length > 0 && (
            <button
              className="btn-primary"
              onClick={() =>
                void ask(`اعتماد ${drafts.length} مسودة وإصدارها؟ يُسجَّل اسمك كمعتمد لكل منها.`).then((ok) => {
                  if (ok) void run(() => approveAndIssue({ documentIds: drafts.map((d) => d._id as any) }).then(failedText));
                })
              }
            >
              اعتمد وأصدر كل المسودات ({drafts.length})
            </button>
          )}
        </div>
        <div className="card overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-sunken">
              <tr>
                <th className="th">القالب</th>
                <th className="th">البيانات</th>
                <th className="th">الحالة</th>
                <th className="th">الاعتماد والإصدار</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {docs?.map((d) => (
                <tr key={d._id} className="border-t border-rule align-top">
                  <td className="td">
                    {d.templateName} <span className="text-xs text-faint">ن{d.templateVersion}</span>
                  </td>
                  <td className="td text-xs">
                    {Object.values(d.data).join(" · ")}
                    <div className="text-faint">طلبها {d.requestedByName} — {formatDate(d.requestedAt)}</div>
                  </td>
                  <td className="td">{STATUS[d.status]}</td>
                  <td className="td text-xs">
                    {d.approvedByName && <div>اعتمدها {d.approvedByName}</div>}
                    {d.serial && (
                      <div dir="ltr" className="text-start">
                        {d.serial} · {d.verifyCode}
                      </div>
                    )}
                    {d.sha256 && <div className="truncate text-[10px] text-faint" dir="ltr" title={d.sha256}>sha256 {d.sha256.slice(0, 16)}…</div>}
                  </td>
                  <td className="td whitespace-nowrap">
                    {d.status === "draft" && space.canManage && (
                      <>
                        <button className="btn-primary" onClick={() => void ask("اعتماد هذا المستند وإصداره؟ يُسجَّل اسمك كمعتمد.").then((ok) => { if (ok) void run(() => approveAndIssue({ documentIds: [d._id as any] }).then(failedText)); })}>
                          اعتماد وإصدار
                        </button>
                        <button className="btn-ghost" onClick={() => run(() => reject({ documentId: d._id as any }))}>
                          رفض
                        </button>
                      </>
                    )}
                    {d.status === "approved" && space.canWrite && (
                      <button className="btn-primary" onClick={() => run(() => issue({ documentId: d._id as any }))}>
                        إصدار
                      </button>
                    )}
                    {d.status === "issued" && (
                      <button className="btn-ghost" onClick={() => run(async () => window.open(await requestDownload({ documentId: d._id as any }), "_blank", "noopener"))}>
                        تنزيل PDF
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {docs?.length === 0 && <div className="p-3 text-sm text-faint">لا مستندات بعد.</div>}
        </div>
        <p className="text-xs text-muted">
          يتحقق أي شخص من مستند صادر برمز التحقق في <a className="underline" href="/verify" target="_blank" rel="noopener">صفحة التحقق</a>.
        </p>
      </section>
    </div>
  );
}

function TemplateRow({ t, canManage }: { t: { _id: string; name: string; currentVersion: number; approvedVersion: number | null }; canManage: boolean }) {
  const approveVersion = useMutation(api.templates.approveVersion);
  const [error, setError] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2 p-3 text-sm">
      <div className="flex-1">
        <div className="font-bold">{t.name}</div>
        <div className="text-xs text-muted">
          آخر نسخة {t.currentVersion} · المعتمدة: {t.approvedVersion ?? "لا يوجد"}
        </div>
      </div>
      {canManage && t.approvedVersion !== t.currentVersion && (
        <button className="btn-primary" onClick={() => approveVersion({ templateId: t._id as any, version: t.currentVersion }).catch((e) => setError(errorText(e)))}>
          اعتماد النسخة {t.currentVersion}
        </button>
      )}
      {error && <span className="text-negative">{error}</span>}
    </div>
  );
}

function TemplateEditor({ spaceId }: { spaceId: string }) {
  const sets = useQuery(api.records.sets, { spaceId: spaceId as any });
  const files = useQuery(api.files.list, { spaceId: spaceId as any });
  const save = useAction(api.templates.saveVersion);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [recordSetId, setRecordSetId] = useState("");
  const [fields, setFields] = useState<{ key: string; label: string; column: string }[]>([]);
  const [layout, setLayout] = useState("");
  const [background, setBackground] = useState("");
  const [error, setError] = useState("");
  const set = sets?.find((s) => s._id === recordSetId);
  const suggestion = useQuery(api.templates.suggestLayout, open && name && fields.length ? { title: name, fields: fields.map(({ key, label }) => ({ key, label })) } : "skip");
  if (!open)
    return (
      <button className="btn-ghost" onClick={() => setOpen(true)}>
        + قالب جديد
      </button>
    );
  return (
    <form
      className="card space-y-3 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError("");
        save({
          spaceId: spaceId as any,
          name,
          layout: layout || suggestion || "",
          fieldsSchema: fields.map(({ key, label }) => ({ key, label })),
          dataBinding: { recordSetId: recordSetId as any, fields: Object.fromEntries(fields.map((f) => [f.key, f.column])) },
          backgroundFileId: (background || undefined) as any,
        })
          .then(() => setOpen(false))
          .catch((err) => setError(errorText(err)));
      }}
    >
      <input className="input w-full" placeholder="اسم القالب (يُطبع عنواناً للشهادة)" value={name} onChange={(e) => setName(e.target.value)} required />
      <select
        className="input"
        value={recordSetId}
        onChange={(e) => {
          setRecordSetId(e.target.value);
          const s = sets?.find((x) => x._id === e.target.value);
          setFields(s ? s.columns.filter((c) => c.key !== s.subjectColumn).map((c) => ({ key: c.key, label: c.header, column: c.key })) : []);
        }}
        required
      >
        <option value="">مصدر البيانات (مجموعة سجلات)…</option>
        {sets?.map((s) => (
          <option key={s._id} value={s._id}>
            {s.name}
          </option>
        ))}
      </select>
      {set && (
        <div className="space-y-1 text-sm">
          <div className="text-xs text-muted">الحقول وربطها بالأعمدة (البيانات تأتي من السجل، لا يكتبها أحد):</div>
          {fields.map((f, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className="input w-40" value={f.label} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <span>←</span>
              <select className="input" value={f.column} onChange={(e) => setFields(fields.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))}>
                {set.columns.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.header}
                  </option>
                ))}
              </select>
              <button type="button" className="btn-ghost" onClick={() => setFields(fields.filter((_, j) => j !== i))}>
                إزالة
              </button>
            </div>
          ))}
        </div>
      )}
      <select className="input" value={background} onChange={(e) => setBackground(e.target.value)}>
        <option value="">بلا خلفية (صفحة A4 أفقية)</option>
        {files
          ?.filter((x) => x.mime === "application/pdf")
          .map((x) => (
            <option key={x._id} value={x._id}>
              خلفية: {x.name}
            </option>
          ))}
      </select>
      <details>
        <summary className="cursor-pointer text-sm text-muted">التخطيط (JSON: مواضع النصوص والحقول بالنقاط)</summary>
        <textarea className="input mt-2 h-60 w-full font-mono text-xs" dir="ltr" value={layout || suggestion || ""} onChange={(e) => setLayout(e.target.value)} />
      </details>
      <div className="flex gap-2">
        <button className="btn-primary">حفظ كنسخة جديدة</button>
        <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
          إلغاء
        </button>
      </div>
      <p className="text-xs text-muted">النسخة المحفوظة لا تُستخدم حتى تعتمدها.</p>
      {error && <p className="text-sm text-negative">{error}</p>}
    </form>
  );
}

const failedText = (r: { failed: { error: string }[] }) => {
  if (r.failed.length) throw new Error(`لم يصدر ${r.failed.length}: ${[...new Set(r.failed.map((f) => f.error))].join("، ")}`);
};

const ROW_STATUS: Record<string, string> = { none: "بلا مستند", draft: "مسودة", approved: "معتمدة", issued: "صادرة" };

/**
 * Issue from the record set (plans/17 §4): the template's rows with the state of each one's
 * document, rows without one ticked. A manager approves and issues the selection in one act;
 * other members create drafts for the manager.
 */
function IssuePanel({ templates, canManage }: { templates: { _id: string; name: string }[]; canManage: boolean }) {
  const [templateId, setTemplateId] = useState(templates[0]?._id ?? "");
  const r = useQuery(api.documents.rowsForTemplate, templateId ? { templateId: templateId as any } : "skip");
  const requestMany = useMutation(api.documents.requestMany);
  const approveAndIssue = useAction(api.documents.approveAndIssue);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const selectable = (status: string) => status === "none" || (canManage && (status === "draft" || status === "approved"));
  const rows = r?.rows ?? [];
  // Until the user changes it, the selection is every row without a document.
  const selected = picked ?? new Set(rows.filter((x) => x.status === "none").map((x) => x.recordId as string));
  const chosen = rows.filter((x) => selected.has(x.recordId) && selectable(x.status));
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };

  const go = async () => {
    setError("");
    setMessage("");
    const n = chosen.length;
    if (!n) return;
    if (canManage && !(await ask(`إصدار ${n} مستند؟ يُسجَّل اسمك كمعتمد لكل منها.`))) return;
    setBusy(true);
    try {
      const fresh = chosen.filter((x) => x.status === "none").map((x) => x.recordId as any);
      const made = fresh.length ? await requestMany({ templateId: templateId as any, recordIds: fresh }) : { documents: [] as { documentId: string }[], created: 0 };
      if (!canManage) {
        setMessage(`أُنشئت ${made.created} مسودة بانتظار اعتماد مدير المساحة.`);
      } else {
        const ids = [...made.documents.map((d) => d.documentId), ...chosen.filter((x) => x.documentId).map((x) => x.documentId as string)];
        const res = await approveAndIssue({ documentIds: ids as any });
        setMessage(`صدر ${res.issued.length} مستند.`);
        failedText(res);
      }
      setPicked(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card space-y-3 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold">إصدار:</span>
        <select
          className="input"
          aria-label="القالب"
          value={templateId}
          onChange={(e) => {
            setTemplateId(e.target.value);
            setPicked(null);
          }}
        >
          {templates.map((x) => (
            <option key={x._id} value={x._id}>
              {x.name}
            </option>
          ))}
        </select>
        {r && (
          <span className="text-muted num">
            {r.counts.none > 0 ? <b className="text-ink">{r.counts.none} بلا مستند</b> : "لكل صف مستند"}
            {r.counts.draft > 0 && ` · ${r.counts.draft} مسودة`}
            {r.counts.issued > 0 && ` · ${r.counts.issued} صادرة`}
          </span>
        )}
      </div>
      {rows.length > 0 && (
        <div className="max-h-[45vh] overflow-auto rounded border border-line">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-sunken">
              <tr>
                <th className="th">
                  <input
                    type="checkbox"
                    aria-label="تحديد الكل"
                    checked={rows.filter((x) => selectable(x.status)).every((x) => selected.has(x.recordId))}
                    onChange={(e) => setPicked(new Set(e.target.checked ? rows.filter((x) => selectable(x.status)).map((x) => x.recordId as string) : []))}
                  />
                </th>
                {r!.fields.map((f) => (
                  <th key={f.key} className="th">
                    {f.label}
                  </th>
                ))}
                <th className="th">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.recordId} className="border-t border-rule">
                  <td className="td">
                    <input type="checkbox" aria-label={`تحديد الصف ${x.rowNo}`} disabled={!selectable(x.status)} checked={selectable(x.status) && selected.has(x.recordId)} onChange={(e) => toggle(x.recordId, e.target.checked)} />
                  </td>
                  {r!.fields.map((f) => (
                    <td key={f.key} className="td">
                      {x.data[f.key]}
                    </td>
                  ))}
                  <td className="td text-muted">
                    {ROW_STATUS[x.status]}
                    {x.serial && (
                      <span className="ms-1 text-faint" dir="ltr">
                        {x.serial}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary" disabled={busy || chosen.length === 0} onClick={() => void go()}>
          {busy ? "جارٍ الإصدار…" : canManage ? `اعتمد وأصدر (${chosen.length})` : `أنشئ مسودات (${chosen.length})`}
        </button>
        {!canManage && <span className="text-xs text-muted">يعتمدها مدير المساحة ثم تصدر.</span>}
        {message && <span className="text-positive">{message}</span>}
        {error && <span className="text-negative">{error}</span>}
      </div>
    </section>
  );
}
