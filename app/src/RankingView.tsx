// المفاضلة: criteria (versioned, approved), runs (draft → approval), results and a justification
// page per student. All numbers come from the server's ranking function; nothing is computed here.

import { useState } from "react";
import { useAction, useMutation, useQuery } from "onebase/react";
import { api, errorText, formatDate, type SpaceInfo } from "./lib";

type Dir = "desc" | "asc";
type CriterionForm = { field: string; label: string; weight: number; direction: Dir; min: number; max: number };
type SpecForm = { name: string; description?: string; idField: string; nameField: string; criteria: CriterionForm[]; tieBreak: { field: string; direction: Dir }[] };

const EMPTY: SpecForm = {
  name: "",
  idField: "رقم الهوية",
  nameField: "الاسم",
  criteria: [{ field: "", label: "", weight: 100, direction: "desc", min: 0, max: 100 }],
  tieBreak: [],
};

const short = (h: string) => h.slice(0, 10);
const StatusBadge = ({ status }: { status: string }) =>
  status === "approved" ? <span className="rounded-full bg-teal-50 px-2 py-0.5 text-xs text-teal-800">معتمدة</span> : <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">مسودة</span>;

export function RankingView({ spaces }: { spaces: SpaceInfo[] }) {
  const [spaceId, setSpaceId] = useState(spaces.find((s) => s.kind === "shared")?._id ?? spaces[0]?._id ?? "");
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [student, setStudent] = useState<string | null>(null);
  const space = spaces.find((s) => s._id === spaceId);
  if (!space) return <div className="text-sm text-slate-500">لا توجد مساحات</div>;
  const canApprove = space.canManage || space.kind === "personal";

  if (openRun && student) return <Justification runId={openRun} studentKey={student} onBack={() => setStudent(null)} />;
  if (openRun) return <RunDetail runId={openRun} canApprove={canApprove} canWrite={space.canWrite} onBack={() => setOpenRun(null)} onStudent={setStudent} onOpen={setOpenRun} />;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">⚖️ المفاضلة</h1>
        <select className="input" value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
          {spaces.map((s) => (
            <option key={s._id} value={s._id}>
              {s.kind === "personal" ? "🔒 مساحتي" : s.name}
            </option>
          ))}
        </select>
      </header>
      <p className="text-sm text-slate-500">
        الترتيب يحسبه النظام بمعادلة ثابتة ومعلنة من معايير معتمدة، والنموذج لا يرتّب ولا يقترح أوزاناً. كل تشغيل يحفظ لقطة البيانات ببصمتها، ويبقى مسودة حتى يعتمده مدير المساحة، والمعتمد لا يُعدَّل.
      </p>
      <CriteriaPanel space={space} canApprove={canApprove} />
      <RunsPanel space={space} canApprove={canApprove} onOpen={setOpenRun} />
    </div>
  );
}

function useRunner() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function CriteriaPanel({ space, canApprove }: { space: SpaceInfo; canApprove: boolean }) {
  const list = useQuery(api.ranking.listCriteria, { spaceId: space._id });
  const create = useMutation(api.ranking.createCriteria);
  const update = useMutation(api.ranking.updateCriteria);
  const approve = useMutation(api.ranking.approveCriteria);
  const newVersion = useMutation(api.ranking.newCriteriaVersion);
  const [editing, setEditing] = useState<{ id: string | null; form: SpecForm } | null>(null);
  const { busy, error, run } = useRunner();

  return (
    <section className="card space-y-3 p-4">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">المعايير</h2>
        {space.canWrite && !editing && (
          <button className="btn-ghost ms-auto" onClick={() => setEditing({ id: null, form: structuredClone(EMPTY) })}>
            + معايير جديدة
          </button>
        )}
      </div>
      {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {editing && (
        <CriteriaForm
          value={editing.form}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(form) =>
            run(async () => {
              if (editing.id) await update({ criteriaId: editing.id, ...form });
              else await create({ spaceId: space._id, ...form });
              setEditing(null);
            })
          }
        />
      )}
      {list?.length === 0 && <p className="text-sm text-slate-400">لا معايير بعد</p>}
      {list?.map((c: any) => (
        <div key={c._id} className="rounded-lg border border-slate-200 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{c.name}</span>
            <span className="text-xs text-slate-500">النسخة {c.version}</span>
            <StatusBadge status={c.status} />
            <span className="text-xs text-slate-400" dir="ltr">#{short(c.specHash)}</span>
            <div className="ms-auto flex gap-1">
              {c.status === "draft" && space.canWrite && (
                <button className="btn-ghost" disabled={busy} onClick={() => setEditing({ id: c._id, form: { name: c.name, description: c.description ?? undefined, idField: c.idField, nameField: c.nameField, criteria: c.criteria, tieBreak: c.tieBreak } })}>
                  تعديل
                </button>
              )}
              {c.status === "draft" && canApprove && (
                <button className="btn-primary" disabled={busy} onClick={() => run(() => approve({ criteriaId: c._id }))}>
                  اعتماد
                </button>
              )}
              {c.status === "approved" && space.canWrite && (
                <button className="btn-ghost" disabled={busy} onClick={() => run(() => newVersion({ criteriaId: c._id }))}>
                  نسخة جديدة
                </button>
              )}
            </div>
          </div>
          <div className="mt-1 text-xs text-slate-600">
            {c.criteria.map((x: any) => `${x.label} (${x.weight}، ${x.direction === "desc" ? "الأعلى أفضل" : "الأقل أفضل"}، ${x.min}–${x.max})`).join(" · ")}
            {c.tieBreak.length > 0 && <> — كسر التعادل: {c.tieBreak.map((t: any) => `${t.field} ${t.direction === "desc" ? "↓" : "↑"}`).join("، ")}</>}
          </div>
        </div>
      ))}
    </section>
  );
}

function CriteriaForm({ value, busy, onSave, onCancel }: { value: SpecForm; busy: boolean; onSave: (f: SpecForm) => void; onCancel: () => void }) {
  const [f, setF] = useState<SpecForm>(value);
  const setC = (i: number, patch: Partial<CriterionForm>) => setF({ ...f, criteria: f.criteria.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const total = f.criteria.reduce((a, c) => a + (Number(c.weight) || 0), 0);
  return (
    <form
      className="space-y-2 rounded-lg bg-slate-50 p-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ ...f, criteria: f.criteria.map((c) => ({ ...c, label: c.label || c.field, weight: Number(c.weight), min: Number(c.min), max: Number(c.max) })) });
      }}
    >
      <div className="flex flex-wrap gap-2">
        <input className="input flex-1" placeholder="اسم المعايير" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        <input className="input w-40" placeholder="عمود المعرّف" value={f.idField} onChange={(e) => setF({ ...f, idField: e.target.value })} required />
        <input className="input w-40" placeholder="عمود الاسم" value={f.nameField} onChange={(e) => setF({ ...f, nameField: e.target.value })} required />
      </div>
      <div className="text-xs text-slate-500">المعايير (اسم العمود كما في ملف البيانات). مجموع الأوزان: {total}</div>
      {f.criteria.map((c, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1">
          <input className="input w-36" placeholder="العمود" value={c.field} onChange={(e) => setC(i, { field: e.target.value })} required />
          <input className="input w-36" placeholder="التسمية" value={c.label} onChange={(e) => setC(i, { label: e.target.value })} />
          <label className="text-xs">الوزن</label>
          <input className="input w-20" type="number" step="any" value={c.weight} onChange={(e) => setC(i, { weight: e.target.value as any })} dir="ltr" />
          <select className="input" value={c.direction} onChange={(e) => setC(i, { direction: e.target.value as Dir })}>
            <option value="desc">الأعلى أفضل</option>
            <option value="asc">الأقل أفضل</option>
          </select>
          <label className="text-xs">من</label>
          <input className="input w-20" type="number" step="any" value={c.min} onChange={(e) => setC(i, { min: e.target.value as any })} dir="ltr" />
          <label className="text-xs">إلى</label>
          <input className="input w-20" type="number" step="any" value={c.max} onChange={(e) => setC(i, { max: e.target.value as any })} dir="ltr" />
          <button type="button" className="btn-danger" onClick={() => setF({ ...f, criteria: f.criteria.filter((_, j) => j !== i) })}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="btn-ghost" onClick={() => setF({ ...f, criteria: [...f.criteria, { field: "", label: "", weight: 10, direction: "desc", min: 0, max: 100 }] })}>
        + معيار
      </button>
      <div className="text-xs text-slate-500">كسر التعادل (بالترتيب)</div>
      {f.tieBreak.map((t, i) => (
        <div key={i} className="flex items-center gap-1">
          <input className="input w-36" placeholder="العمود" value={t.field} onChange={(e) => setF({ ...f, tieBreak: f.tieBreak.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) })} required />
          <select className="input" value={t.direction} onChange={(e) => setF({ ...f, tieBreak: f.tieBreak.map((x, j) => (j === i ? { ...x, direction: e.target.value as Dir } : x)) })}>
            <option value="desc">الأعلى أولاً</option>
            <option value="asc">الأقل أولاً</option>
          </select>
          <button type="button" className="btn-danger" onClick={() => setF({ ...f, tieBreak: f.tieBreak.filter((_, j) => j !== i) })}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="btn-ghost" onClick={() => setF({ ...f, tieBreak: [...f.tieBreak, { field: "", direction: "desc" }] })}>
        + قاعدة كسر تعادل
      </button>
      <div className="flex gap-2">
        <button className="btn-primary" disabled={busy}>
          حفظ كمسودة
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel}>
          إلغاء
        </button>
      </div>
    </form>
  );
}

function RunsPanel({ space, canApprove, onOpen }: { space: SpaceInfo; canApprove: boolean; onOpen: (id: string) => void }) {
  const criteria = useQuery(api.ranking.listCriteria, { spaceId: space._id });
  const files = useQuery(api.files.list, { spaceId: space._id as any });
  const runs = useQuery(api.ranking.listRuns, { spaceId: space._id });
  const recordSets = useQuery(api.records.sets, { spaceId: space._id as any });
  const createRun = useAction(api.ranking.createRun);
  const approveRun = useMutation(api.ranking.approveRun);
  const [criteriaId, setCriteriaId] = useState("");
  // "file:<id>" or "records:<id>": a CSV/XLSX file or an imported record set, both in this space.
  const [source, setSource] = useState("");
  const { busy, error, run } = useRunner();
  const approved = criteria?.filter((c: any) => c.status === "approved") ?? [];
  const tables = files?.filter((x: any) => /\.(csv|xlsx|txt)$/i.test(x.name)) ?? [];
  const sets = recordSets?.filter((x: any) => x.currentVersion > 0) ?? [];
  const sourceArgs = () => {
    const [kind, id] = [source.slice(0, source.indexOf(":")), source.slice(source.indexOf(":") + 1)];
    return kind === "records" ? { recordSetId: id } : { fileId: id };
  };

  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-semibold">التشغيلات</h2>
      {space.canWrite && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select className="input" value={criteriaId} onChange={(e) => setCriteriaId(e.target.value)}>
            <option value="">المعايير المعتمدة…</option>
            {approved.map((c: any) => (
              <option key={c._id} value={c._id}>
                {c.name} — النسخة {c.version}
              </option>
            ))}
          </select>
          <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">مصدر البيانات…</option>
            {tables.length > 0 && (
              <optgroup label="ملف (CSV / XLSX)">
                {tables.map((x: any) => (
                  <option key={x._id} value={`file:${x._id}`}>
                    {x.name} (ن{x.version})
                  </option>
                ))}
              </optgroup>
            )}
            {sets.length > 0 && (
              <optgroup label="سجلات مستوردة (أسماء الأعمدة كما في Excel)">
                {sets.map((x: any) => (
                  <option key={x._id} value={`records:${x._id}`}>
                    {x.name} (النسخة الحالية {x.currentVersion})
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button className="btn-primary" disabled={busy || !criteriaId || !source} onClick={() => run(async () => onOpen(await createRun({ criteriaId, ...sourceArgs() })))}>
            احسب الترتيب
          </button>
        </div>
      )}
      {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <table className="w-full">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">التاريخ</th>
            <th className="th">المعايير</th>
            <th className="th">البيانات</th>
            <th className="th">العدد</th>
            <th className="th">الحالة</th>
            <th className="th"></th>
          </tr>
        </thead>
        <tbody>
          {runs?.length === 0 && (
            <tr>
              <td className="td text-slate-400" colSpan={6}>
                لا تشغيلات بعد
              </td>
            </tr>
          )}
          {runs?.map((r: any) => (
            <tr key={r._id} className="border-t border-slate-100">
              <td className="td text-xs text-slate-500">{formatDate(r.createdAt)}</td>
              <td className="td">
                {r.criteriaName} <span className="text-xs text-slate-500">ن{r.criteriaVersion}</span>
              </td>
              <td className="td text-xs">
                {r.source?.name} <span className="text-slate-400" dir="ltr">#{short(r.snapshotHash)}</span>
              </td>
              <td className="td">{r.count}</td>
              <td className="td">
                <StatusBadge status={r.status} />
              </td>
              <td className="td text-end">
                <button className="btn-ghost" onClick={() => onOpen(r._id)}>
                  عرض
                </button>
                {r.status === "draft" && canApprove && (
                  <button className="btn-primary" disabled={busy} onClick={() => run(() => approveRun({ rankingRunId: r._id }))}>
                    اعتماد
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function RunDetail({ runId, canApprove, canWrite, onBack, onStudent, onOpen }: { runId: string; canApprove: boolean; canWrite: boolean; onBack: () => void; onStudent: (k: string) => void; onOpen: (id: string) => void }) {
  const r = useQuery(api.ranking.getRun, { rankingRunId: runId });
  const approveRun = useMutation(api.ranking.approveRun);
  const rerun = useAction(api.ranking.rerun);
  const { busy, error, run } = useRunner();
  if (!r) return <div className="text-sm text-slate-500">جارٍ التحميل…</div>;
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <button className="btn-ghost px-0" onClick={onBack}>
        → رجوع
      </button>
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">
          {r.criteriaName} <span className="text-sm text-slate-500">النسخة {r.criteriaVersion}</span>
        </h1>
        <StatusBadge status={r.status} />
        <div className="ms-auto flex gap-1">
          {r.status === "draft" && canApprove && (
            <button className="btn-primary" disabled={busy} onClick={() => run(() => approveRun({ rankingRunId: r._id }))}>
              اعتماد المفاضلة
            </button>
          )}
          {canWrite && (
            <button className="btn-ghost" disabled={busy} onClick={() => run(async () => onOpen(await rerun({ rankingRunId: r._id })))}>
              إعادة الحساب على اللقطة نفسها
            </button>
          )}
        </div>
      </header>
      {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <RunMeta r={r} />
      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">الترتيب</th>
              <th className="th">المعرّف</th>
              <th className="th">الاسم</th>
              {r.criteria.map((c: any) => (
                <th key={c.field} className="th">
                  {c.label} ({c.weight})
                </th>
              ))}
              <th className="th">المجموع</th>
            </tr>
          </thead>
          <tbody>
            {r.results.map((x: any) => (
              <tr key={x.key} className="cursor-pointer border-t border-slate-100 hover:bg-teal-50" onClick={() => onStudent(x.key)} title="صفحة التبرير">
                <td className="td font-semibold">{x.rank}</td>
                <td className="td" dir="ltr">
                  {x.key}
                </td>
                <td className="td">{x.name}</td>
                {x.points.map((p: number, i: number) => (
                  <td key={i} className="td tabular-nums">
                    {p}
                  </td>
                ))}
                <td className="td font-semibold tabular-nums">{x.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RunMeta({ r }: { r: any }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-slate-50 p-3 text-xs text-slate-600 md:grid-cols-4">
      <dt>البيانات</dt>
      <dd>
        {r.source?.kind === "records" ? "سجلات: " : ""}
        {r.source?.name} (النسخة {r.source?.version})
      </dd>
      <dt>بصمة اللقطة</dt>
      <dd dir="ltr" className="font-mono">
        {short(r.snapshotHash)}
      </dd>
      <dt>بصمة المعايير</dt>
      <dd dir="ltr" className="font-mono">
        {short(r.criteriaHash)}
      </dd>
      <dt>بصمة النتائج</dt>
      <dd dir="ltr" className="font-mono">
        {short(r.resultsHash)}
      </dd>
      <dt>حُسبت</dt>
      <dd>
        {formatDate(r.createdAt)} — {r.createdByName}
      </dd>
      <dt>الاعتماد</dt>
      <dd>{r.approvedAt ? `${formatDate(r.approvedAt)} — ${r.approvedByName}` : "لم تُعتمد بعد"}</dd>
      {r.correctsRunId && (
        <>
          <dt>تصحيح لتشغيل</dt>
          <dd dir="ltr" className="font-mono">
            {short(r.correctsRunId)}
          </dd>
        </>
      )}
    </dl>
  );
}

function Justification({ runId, studentKey, onBack }: { runId: string; studentKey: string; onBack: () => void }) {
  const j = useQuery(api.ranking.justification, { rankingRunId: runId, key: studentKey });
  if (!j) return <div className="text-sm text-slate-500">جارٍ التحميل…</div>;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex gap-2 print:hidden">
        <button className="btn-ghost px-0" onClick={onBack}>
          → رجوع
        </button>
        <button className="btn-ghost ms-auto" onClick={() => window.print()}>
          🖨 طباعة
        </button>
      </div>
      <header className="card p-4">
        <div className="text-sm text-slate-500">صفحة تبرير الترتيب</div>
        <h1 className="text-xl font-semibold">{j.student.name}</h1>
        <div className="mt-2 flex flex-wrap gap-4 text-sm">
          <span>
            الترتيب: <b className="text-lg">{j.student.rank}</b> من {j.student.of}
            {j.student.sharedWith > 0 && <span className="text-slate-500"> (متساوٍ مع {j.student.sharedWith})</span>}
          </span>
          <span>
            المجموع: <b className="text-lg">{j.student.total}</b> من {j.student.maxTotal}
          </span>
          <StatusBadge status={j.run.status} />
        </div>
      </header>
      <section className="card p-4">
        <h2 className="mb-2 font-semibold">بياناته كما في اللقطة</h2>
        <table className="w-full text-sm">
          <tbody>
            {j.data.map((d: any) => (
              <tr key={d.field} className="border-t border-slate-100">
                <td className="td w-1/3 text-slate-500">{d.field}</td>
                <td className="td">{d.value === null ? "—" : String(d.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card space-y-2 p-4 text-sm">
        <h2 className="font-semibold">المعادلة</h2>
        <p className="text-slate-600">{j.formula}</p>
        <ul className="space-y-1">
          {j.breakdown.map((b: any) => (
            <li key={b.field} className="rounded bg-slate-50 px-2 py-1">
              {/* the math reads left to right even inside Arabic text */}
              {b.label}:{" "}
              <bdi dir="ltr" className="font-mono text-xs">
                {b.explanation.slice(b.label.length + 2)}
              </bdi>
              {b.clamped && <span className="text-xs text-amber-700"> (القيمة {String(b.raw)} حُصرت في المدى)</span>}
            </li>
          ))}
        </ul>
        <p className="font-semibold">
          المجموع:{" "}
          <bdi dir="ltr" className="font-mono">
            {j.totalLine}
          </bdi>
        </p>
        {j.tieBreak.length > 0 && <p className="text-xs text-slate-500">قيم كسر التعادل: {j.tieBreak.map((t: any) => `${t.field} = ${t.value ?? "—"}`).join("، ")}</p>}
      </section>
      <section className="card p-4">
        <h2 className="mb-2 font-semibold">التشغيل</h2>
        <div className="mb-2 text-sm">
          {j.run.criteriaName} — النسخة {j.run.criteriaVersion}
        </div>
        <RunMeta r={j.run} />
      </section>
    </div>
  );
}
