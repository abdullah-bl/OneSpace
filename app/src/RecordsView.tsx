// Structured records of a space: the manager defines a record set and imports Excel files
// (validated, previewed, then all-or-nothing as a new dated version); members browse the rows.

import { useState } from "react";
import { useAction, useMutation, useQuery } from "onebase/react";
import { api, errorText, formatDate, type SpaceInfo } from "./lib";

async function fileBase64(file: File) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

const TYPES = { text: "نص", number: "رقم", date: "تاريخ", boolean: "نعم/لا" } as const;

export function RecordsTab({ space }: { space: SpaceInfo }) {
  const sets = useQuery(api.records.sets, { spaceId: space._id as any });
  const [selected, setSelected] = useState<string | null>(null);
  const current = sets?.find((s) => s._id === selected) ?? sets?.[0];
  return (
    <div className="space-y-4">
      {space.canManage && space.kind === "shared" && <NewSetForm spaceId={space._id} />}
      {sets?.length === 0 && <p className="text-sm text-neutral-400">لا توجد سجلات في هذه المساحة.</p>}
      {sets && sets.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {sets.map((s) => (
            <button key={s._id} className={current?._id === s._id ? "btn-primary" : "btn-ghost"} onClick={() => setSelected(s._id)}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      {current && <SetView key={current._id} set={current} canManage={space.canManage} />}
    </div>
  );
}

function NewSetForm({ spaceId }: { spaceId: string }) {
  const createSet = useMutation(api.records.createSet);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [cols, setCols] = useState([{ key: "nid", header: "رقم الهوية", type: "text" as keyof typeof TYPES, required: true }]);
  const [subjectColumn, setSubject] = useState("nid");
  const [subjectKind, setKind] = useState<"nationalId" | "employeeNo">("nationalId");
  const [uniqueBy, setUnique] = useState<string[]>(["nid"]);
  const [error, setError] = useState("");
  if (!open)
    return (
      <button className="btn-ghost" onClick={() => setOpen(true)}>
        + مجموعة سجلات جديدة
      </button>
    );
  return (
    <form
      className="card space-y-3 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError("");
        createSet({ spaceId: spaceId as any, name, columns: cols, subjectColumn, subjectKind, uniqueBy })
          .then(() => setOpen(false))
          .catch((err) => setError(errorText(err)));
      }}
    >
      <input className="input w-full" placeholder="اسم المجموعة (مثلاً: دورات الموظفين)" value={name} onChange={(e) => setName(e.target.value)} required />
      <p className="text-xs text-neutral-500">الأعمدة كما تظهر في الصف الأول من ملف Excel. المفتاح بحروف لاتينية ويُستخدم في ربط القوالب.</p>
      {cols.map((c, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
          <input className="input w-40" placeholder="عنوان العمود في Excel" value={c.header} onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, header: e.target.value } : x)))} required />
          <input className="input w-28" dir="ltr" placeholder="key" value={c.key} onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} required />
          <select className="input" value={c.type} onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, type: e.target.value as any } : x)))}>
            {Object.entries(TYPES).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={c.required} onChange={(e) => setCols(cols.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} /> إلزامي
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" name="subject" checked={subjectColumn === c.key} onChange={() => setSubject(c.key)} /> رقم صاحب السجل
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={uniqueBy.includes(c.key)} onChange={(e) => setUnique(e.target.checked ? [...uniqueBy, c.key] : uniqueBy.filter((k) => k !== c.key))} /> يمنع التكرار
          </label>
          {cols.length > 1 && (
            <button type="button" className="btn-ghost" onClick={() => setCols(cols.filter((_, j) => j !== i))}>
              إزالة
            </button>
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-ghost" onClick={() => setCols([...cols, { key: "", header: "", type: "text", required: false }])}>
          + عمود
        </button>
        <select className="input" value={subjectKind} onChange={(e) => setKind(e.target.value as any)}>
          <option value="nationalId">عمود صاحب السجل = رقم الهوية</option>
          <option value="employeeNo">عمود صاحب السجل = الرقم الوظيفي</option>
        </select>
        <button className="btn-primary">إنشاء</button>
        <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
          إلغاء
        </button>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </form>
  );
}

type SetInfo = { _id: string; name: string; columns: { key: string; header: string; type: string }[]; currentVersion: number };

function SetView({ set, canManage }: { set: SetInfo; canManage: boolean }) {
  const rows = useQuery(api.records.rows, { recordSetId: set._id as any });
  const imports = useQuery(api.records.imports, { recordSetId: set._id as any });
  return (
    <div className="space-y-3">
      {canManage && <ImportBox set={set} />}
      <div className="text-sm text-neutral-500">
        النسخة الحالية: {set.currentVersion || "—"} · {rows?.total ?? 0} صف
      </div>
      <div className="card max-h-[50vh] overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-neutral-50">
            <tr>
              {set.columns.map((c) => (
                <th key={c.key} className="th">
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows?.rows.map((r) => (
              <tr key={r.recordId} className="border-t border-neutral-100">
                {set.columns.map((c) => (
                  <td key={c.key} className="td">
                    {r.data[c.key] === null || r.data[c.key] === undefined ? "" : String(r.data[c.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {imports && imports.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-neutral-500">سجل الاستيراد ({imports.length})</summary>
          <ul className="mt-2 space-y-1">
            {imports.map((i) => (
              <li key={i.version}>
                النسخة {i.version} — {formatDate(i.importedAt)} — {i.sourceName} — {i.rowCount} صف — {i.importedByName}
                {i.current && " (الحالية)"}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ImportBox({ set }: { set: SetInfo }) {
  const preview = useAction(api.records.previewImport);
  const commit = useAction(api.records.commitImport);
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; errors: string[]; rowCount: number; sample: Record<string, unknown>[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <div className="card space-y-2 p-3">
      <div className="text-sm font-semibold">استيراد من Excel</div>
      <p className="text-xs text-neutral-500">الأعمدة المطلوبة: {set.columns.map((c) => c.header).join("، ")}. أي خطأ يرفض الملف كله، وكل استيراد ناجح نسخة جديدة مؤرّخة.</p>
      <input
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          setResult(null);
          setMessage("");
          if (!f) return;
          setBusy(true);
          try {
            const data = await fileBase64(f);
            setFile({ name: f.name, data });
            setResult(await preview({ recordSetId: set._id as any, fileName: f.name, dataBase64: data }));
          } catch (err) {
            setMessage(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      />
      {busy && <p className="text-sm text-neutral-500">جارٍ الفحص…</p>}
      {result && !result.ok && (
        <div className="rounded-lg bg-red-50 p-2 text-sm text-red-700">
          <div className="font-semibold">رُفض الملف ولن يُستورد منه شيء:</div>
          <ul className="list-disc ps-5">
            {result.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {result?.ok && file && (
        <div className="space-y-2">
          <p className="text-sm">
            الملف سليم: {result.rowCount} صف. معاينة أول {result.sample.length}:
          </p>
          <div className="max-h-60 overflow-auto rounded border border-neutral-200">
            <table className="w-full text-xs">
              <thead className="bg-neutral-50">
                <tr>
                  {set.columns.map((c) => (
                    <th key={c.key} className="th">
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.sample.map((r, i) => (
                  <tr key={i} className="border-t border-neutral-100">
                    {set.columns.map((c) => (
                      <td key={c.key} className="td">
                        {r[c.key] === null || r[c.key] === undefined ? "" : String(r[c.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            className="btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await commit({ recordSetId: set._id as any, fileName: file.name, dataBase64: file.data });
                setMessage(`استُورد ${r.rowCount} صف كنسخة ${r.version}`);
                setResult(null);
                setFile(null);
              } catch (err) {
                setMessage(errorText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            تأكيد الاستيراد
          </button>
        </div>
      )}
      {message && <p className="text-sm text-neutral-700">{message}</p>}
    </div>
  );
}
