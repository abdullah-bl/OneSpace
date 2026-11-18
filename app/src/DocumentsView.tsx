// Templates and official documents of a space. Managers write template versions and approve
// them; members draft documents from (approved template, record); a manager approves; the
// requester or a manager issues. The text of a document only ever comes from the template
// and the record.

import { useState } from "react";
import { useAction, useMutation, useQuery } from "onebase/react";
import { api, errorText, formatDate, type SpaceInfo } from "./lib";

const STATUS: Record<string, string> = { draft: "مسودة بانتظار الاعتماد", approved: "معتمدة", issued: "صادرة", rejected: "مرفوضة" };

export function DocumentsTab({ space }: { space: SpaceInfo }) {
  const templates = useQuery(api.templates.list, { spaceId: space._id as any });
  const docs = useQuery(api.documents.list, { spaceId: space._id as any });
  const approve = useMutation(api.documents.approve);
  const reject = useMutation(api.documents.reject);
  const issue = useAction(api.documents.issue);
  const requestDownload = useMutation(api.documents.requestDownload);
  const [error, setError] = useState("");
  const run = (fn: () => Promise<unknown>) => {
    setError("");
    fn().catch((e) => setError(errorText(e)));
  };
  return (
    <div className="space-y-6">
      {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <section className="space-y-2">
        <h2 className="font-semibold">القوالب</h2>
        {space.canManage && <TemplateEditor spaceId={space._id} />}
        <div className="card divide-y divide-slate-100">
          {templates?.map((t) => <TemplateRow key={t._id} t={t} canManage={space.canManage} />)}
          {templates?.length === 0 && <div className="p-3 text-sm text-slate-400">لا قوالب بعد.</div>}
        </div>
      </section>
      {space.canWrite && templates && templates.some((t) => t.approvedVersion) && <RequestForm templates={templates.filter((t) => t.approvedVersion)} />}
      <section className="space-y-2">
        <h2 className="font-semibold">المستندات</h2>
        <div className="card overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
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
                <tr key={d._id} className="border-t border-slate-100 align-top">
                  <td className="td">
                    {d.templateName} <span className="text-xs text-slate-400">ن{d.templateVersion}</span>
                  </td>
                  <td className="td text-xs">
                    {Object.values(d.data).join(" · ")}
                    <div className="text-slate-400">طلبها {d.requestedByName} — {formatDate(d.requestedAt)}</div>
                  </td>
                  <td className="td">{STATUS[d.status]}</td>
                  <td className="td text-xs">
                    {d.approvedByName && <div>اعتمدها {d.approvedByName}</div>}
                    {d.serial && (
                      <div dir="ltr" className="text-start">
                        {d.serial} · {d.verifyCode}
                      </div>
                    )}
                    {d.sha256 && <div className="truncate text-[10px] text-slate-400" dir="ltr" title={d.sha256}>sha256 {d.sha256.slice(0, 16)}…</div>}
                  </td>
                  <td className="td whitespace-nowrap">
                    {d.status === "draft" && space.canManage && (
                      <>
                        <button className="btn-primary" onClick={() => confirm("اعتماد هذا المستند؟ يُسجَّل اسمك كمعتمد.") && run(() => approve({ documentId: d._id as any }))}>
                          اعتماد
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
          {docs?.length === 0 && <div className="p-3 text-sm text-slate-400">لا مستندات بعد.</div>}
        </div>
        <p className="text-xs text-slate-500">
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
        <div className="font-semibold">{t.name}</div>
        <div className="text-xs text-slate-500">
          آخر نسخة {t.currentVersion} · المعتمدة: {t.approvedVersion ?? "لا يوجد"}
        </div>
      </div>
      {canManage && t.approvedVersion !== t.currentVersion && (
        <button className="btn-primary" onClick={() => approveVersion({ templateId: t._id as any, version: t.currentVersion }).catch((e) => setError(errorText(e)))}>
          اعتماد النسخة {t.currentVersion}
        </button>
      )}
      {error && <span className="text-red-700">{error}</span>}
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
          <div className="text-xs text-slate-500">الحقول وربطها بالأعمدة (البيانات تأتي من السجل، لا يكتبها أحد):</div>
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
                ✕
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
        <summary className="cursor-pointer text-sm text-slate-500">التخطيط (JSON: مواضع النصوص والحقول بالنقاط)</summary>
        <textarea className="input mt-2 h-60 w-full font-mono text-xs" dir="ltr" value={layout || suggestion || ""} onChange={(e) => setLayout(e.target.value)} />
      </details>
      <div className="flex gap-2">
        <button className="btn-primary">حفظ كنسخة جديدة</button>
        <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
          إلغاء
        </button>
      </div>
      <p className="text-xs text-slate-500">النسخة المحفوظة لا تُستخدم حتى تعتمدها.</p>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </form>
  );
}

function RequestForm({ templates }: { templates: { _id: string; name: string; recordSetId: string | null }[] }) {
  const [templateId, setTemplateId] = useState(templates[0]?._id ?? "");
  const t = templates.find((x) => x._id === templateId);
  const rows = useQuery(api.records.rows, t?.recordSetId ? { recordSetId: t.recordSetId as any } : "skip");
  const request = useMutation(api.documents.request);
  const [recordId, setRecordId] = useState("");
  const [message, setMessage] = useState("");
  return (
    <section className="card flex flex-wrap items-center gap-2 p-3 text-sm">
      <span className="font-semibold">طلب مستند:</span>
      <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
        {templates.map((x) => (
          <option key={x._id} value={x._id}>
            {x.name}
          </option>
        ))}
      </select>
      <select className="input max-w-sm" value={recordId} onChange={(e) => setRecordId(e.target.value)}>
        <option value="">السجل…</option>
        {rows?.rows.map((r) => (
          <option key={r.recordId} value={r.recordId}>
            {Object.values(r.data).filter((x) => x !== null).join(" · ")}
          </option>
        ))}
      </select>
      <button
        className="btn-primary"
        disabled={!recordId}
        onClick={() =>
          request({ templateId: templateId as any, recordId: recordId as any })
            .then((r) => setMessage(r.existing ? "المستند موجود مسبقاً" : "أُنشئت مسودة بانتظار اعتماد مدير المساحة"))
            .catch((e) => setMessage(errorText(e)))
        }
      >
        إنشاء مسودة
      </button>
      {message && <span>{message}</span>}
    </section>
  );
}
