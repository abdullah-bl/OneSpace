// Structured records of a space: the manager starts a record set from an Excel file (plans/17:
// the file's columns are read, the manager chooses), later files are validated, previewed, then
// imported all-or-nothing as a new dated version; members browse the rows.

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
      {space.canManage && space.kind === "shared" && <NewSetFromFile spaceId={space._id} />}
      {sets?.length === 0 && <p className="text-sm text-faint">لا توجد سجلات في هذه المساحة.</p>}
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

type Kind = keyof typeof TYPES;
type Analysis = {
  ok: boolean;
  errors: string[];
  name: string;
  rowCount: number;
  columns: { header: string; type: Kind; required: boolean; idLike: boolean; samples: string[] }[];
  owner: { header: string; kind: "nationalId" | "employeeNo"; matched: number; distinct: number } | null;
  uniqueBy: string[];
};
type Choice = { header: string; use: boolean; type: Kind; required: boolean };

/**
 * A record set starts from the manager's own Excel file (plans/17): the file's columns are shown
 * with guessed types; the manager unticks what they don't want, confirms the owner column and
 * what must not repeat, and one click creates the set and imports the file. Nothing to type.
 */
function NewSetFromFile({ spaceId }: { spaceId: string }) {
  const analyze = useAction(api.records.analyzeFile);
  const create = useAction(api.records.createFromFile);
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [a, setA] = useState<Analysis | null>(null);
  const [name, setName] = useState("");
  const [cols, setCols] = useState<Choice[]>([]);
  const [owner, setOwner] = useState("");
  const [kind, setKind] = useState<"nationalId" | "employeeNo">("nationalId");
  const [unique, setUnique] = useState<string[]>([]);
  const [editUnique, setEditUnique] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [done, setDone] = useState("");
  const [inputKey, setInputKey] = useState(0);

  const reset = () => {
    setFile(null);
    setA(null);
    setErrors([]);
    setEditUnique(false);
    setInputKey((k) => k + 1);
  };
  const used = cols.filter((c) => c.use);
  const label = (headers: string[]) => headers.join(" + ");

  return (
    <div className="card space-y-3 p-3">
      <div>
        <div className="text-sm font-bold">سجل جديد من ملف Excel</div>
        <p className="text-xs text-muted">ارفع الملف كما هو. نقرأ أعمدته، وتختار ما تعتمده منها.</p>
      </div>
      <input
        key={inputKey}
        type="file"
        aria-label="ملف Excel"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          setA(null);
          setErrors([]);
          setDone("");
          if (!f) return;
          setBusy(true);
          try {
            const data = await fileBase64(f);
            const r = (await analyze({ spaceId: spaceId as any, fileName: f.name, dataBase64: data })) as Analysis;
            setFile({ name: f.name, data });
            setA(r);
            if (!r.ok) return setErrors(r.errors);
            setName(r.name);
            setCols(r.columns.map((c) => ({ header: c.header, use: true, type: c.type, required: c.required })));
            setOwner(r.owner?.header ?? "");
            setKind(r.owner?.kind ?? "nationalId");
            setUnique(r.uniqueBy);
          } catch (err) {
            setErrors([errorText(err)]);
          } finally {
            setBusy(false);
          }
        }}
      />
      {busy && <p className="text-sm text-muted">جارٍ القراءة…</p>}
      {done && <p className="rounded-lg bg-positive-soft p-2 text-sm text-positive">{done}</p>}
      {a?.ok && file && (
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setErrors([]);
            setBusy(true);
            try {
              const r = await create({
                spaceId: spaceId as any,
                name,
                fileName: file.name,
                dataBase64: file.data,
                columns: used.map(({ header, type, required }) => ({ header, type, required })),
                ownerHeader: owner,
                ownerKind: kind,
                uniqueBy: unique.filter((h) => used.some((c) => c.header === h)),
              });
              if (!r.ok) return setErrors(r.errors);
              reset();
              setDone(`أُنشئ «${name}» واستُورد ${r.rowCount} صف.`);
            } catch (err) {
              setErrors([errorText(err)]);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="block text-sm">
            <span className="label">اسم السجل</span>
            <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>

          <div className="text-xs text-muted">{a.rowCount} صف. اختر الأعمدة التي تعتمدها:</div>
          <div className="overflow-auto rounded border border-line">
            <table className="w-full text-sm">
              <thead className="bg-sunken">
                <tr>
                  <th className="th">اعتمد</th>
                  <th className="th">العمود</th>
                  <th className="th">أمثلة</th>
                  <th className="th">النوع</th>
                  <th className="th">إلزامي</th>
                </tr>
              </thead>
              <tbody>
                {cols.map((c, i) => {
                  const info = a.columns[i]!;
                  const set = (patch: Partial<Choice>) => setCols(cols.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                  return (
                    <tr key={c.header} className={`border-t border-rule ${c.use ? "" : "opacity-50"}`}>
                      <td className="td">
                        <input type="checkbox" aria-label={`اعتمد ${c.header}`} checked={c.use} disabled={c.header === owner} onChange={(e) => set({ use: e.target.checked })} />
                      </td>
                      <td className="td font-medium">{c.header}</td>
                      <td className="td text-xs text-muted">{info.samples.join("، ")}</td>
                      <td className="td">
                        <select className="input h-8" aria-label={`نوع ${c.header}`} value={c.type} disabled={!c.use || c.header === owner} onChange={(e) => set({ type: e.target.value as Kind })}>
                          {Object.entries(TYPES).map(([k, l]) => (
                            <option key={k} value={k}>
                              {l}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="td">
                        <input type="checkbox" aria-label={`${c.header} إلزامي`} checked={c.required || c.header === owner} disabled={!c.use || c.header === owner} onChange={(e) => set({ required: e.target.checked })} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="space-y-1 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="label m-0">صاحب السجل</span>
              <select
                className="input h-8"
                aria-label="عمود صاحب السجل"
                value={owner}
                onChange={(e) => {
                  setOwner(e.target.value);
                  setCols(cols.map((c) => (c.header === e.target.value ? { ...c, use: true } : c)));
                  setUnique([e.target.value, ...unique.filter((h) => h !== owner && h !== e.target.value)]);
                }}
                required
              >
                <option value="">اختر العمود…</option>
                {a.columns.map((c) => (
                  <option key={c.header} value={c.header}>
                    {c.header}
                  </option>
                ))}
              </select>
              <select className="input h-8" aria-label="نوع الرقم" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="nationalId">رقم الهوية</option>
                <option value="employeeNo">الرقم الوظيفي</option>
              </select>
            </div>
            {a.owner && a.owner.header === owner && (
              <p className="text-xs text-muted num">
                يطابق {a.owner.matched} من {a.owner.distinct} موظفاً لهم حسابات. يرى كل منهم سطوره في «بياناتي».
              </p>
            )}
            {!a.owner && <p className="text-xs text-warning">لم نجد عموداً فيه أرقام هوية أو أرقام وظيفية. اختر العمود الذي يحدد صاحب كل سطر.</p>}
          </div>

          {owner && (
            <div className="space-y-1 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span>
                  لا يتكرر: <b>{label(unique.filter((h) => used.some((c) => c.header === h)))}</b>
                </span>
                <button type="button" className="btn-ghost h-7 text-xs" onClick={() => setEditUnique(!editUnique)}>
                  {editUnique ? "تم" : "تغيير"}
                </button>
              </div>
              {editUnique && (
                <div className="flex flex-wrap gap-3 text-xs">
                  {used.map((c) => (
                    <label key={c.header} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={unique.includes(c.header) || c.header === owner}
                        disabled={c.header === owner}
                        onChange={(e) => setUnique(e.target.checked ? [...unique, c.header] : unique.filter((h) => h !== c.header))}
                      />
                      {c.header}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <button className="btn-primary" disabled={busy || !owner || !name.trim()}>
              أنشئ واستورد
            </button>
            <button type="button" className="btn-ghost" onClick={reset}>
              إلغاء
            </button>
          </div>
        </form>
      )}
      {errors.length > 0 && (
        <div className="rounded-lg bg-negative-soft p-2 text-sm text-negative">
          <div className="font-bold">{a?.ok ? "لم يُنشأ شيء:" : "تعذّرت قراءة الملف:"}</div>
          <ul className="list-disc ps-5">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

type SetInfo = { _id: string; name: string; columns: { key: string; header: string; type: string }[]; currentVersion: number };

function SetView({ set, canManage }: { set: SetInfo; canManage: boolean }) {
  const rows = useQuery(api.records.rows, { recordSetId: set._id as any });
  const imports = useQuery(api.records.imports, { recordSetId: set._id as any });
  return (
    <div className="space-y-3">
      {canManage && <ImportBox set={set} />}
      <div className="text-sm text-muted">
        النسخة الحالية: {set.currentVersion || "—"} · {rows?.total ?? 0} صف
      </div>
      <div className="card max-h-[50vh] overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-sunken">
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
              <tr key={r.recordId} className="border-t border-rule">
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
          <summary className="cursor-pointer text-muted">سجل الاستيراد ({imports.length})</summary>
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
      <div className="text-sm font-bold">استيراد من Excel</div>
      <p className="text-xs text-muted">الأعمدة المطلوبة: {set.columns.map((c) => c.header).join("، ")}. أي خطأ يرفض الملف كله، وكل استيراد ناجح نسخة جديدة مؤرّخة.</p>
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
      {busy && <p className="text-sm text-muted">جارٍ الفحص…</p>}
      {result && !result.ok && (
        <div className="rounded-lg bg-negative-soft p-2 text-sm text-negative">
          <div className="font-bold">رُفض الملف ولن يُستورد منه شيء:</div>
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
          <div className="max-h-60 overflow-auto rounded border border-line">
            <table className="w-full text-xs">
              <thead className="bg-sunken">
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
                  <tr key={i} className="border-t border-rule">
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
      {message && <p className="text-sm text-muted">{message}</p>}
    </div>
  );
}
