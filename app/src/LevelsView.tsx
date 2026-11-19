// «المستويات» (admin, plans/08 §D): like Claude's plans, set per employee. Each level says which
// model, whether «تفكير عميق» is allowed, which tools, how many agents a request may be split
// across, and how many questions a day. Everyone without a level of their own gets the default;
// with no levels at all, nobody is limited.

import { useState } from "react";
import { useMutation, useQuery } from "onebase/react";
import { api, errorText } from "./lib";
import { Icon } from "./icons";
import { EmptyState, PageHeader, ask } from "./ui";

type Draft = { levelId?: string; name: string; description: string; model: "main" | "fast"; deep: boolean; tools: string[] | null; sources: string[] | null; spaceIds: string[]; subagents: number; dailyQuestions: number };
const NEW: Draft = { name: "", description: "", model: "main", deep: false, tools: null, sources: null, spaceIds: [], subagents: 0, dailyQuestions: 100 };

export function LevelsView() {
  const data = useQuery(api.levels.list);
  const save = useMutation(api.levels.save);
  const remove = useMutation(api.levels.remove);
  const setDefault = useMutation(api.levels.setDefault);
  const assign = useMutation(api.levels.assign);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const run = (p: Promise<unknown>) => p.then(() => setError("")).catch((e) => setError(errorText(e)));

  if (!data) return null;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setEditing((e) => (e ? { ...e, [k]: v } : e));
  const def = data.levels.find((l) => l.isDefault);
  const summary = (l: (typeof data.levels)[number]) =>
    [
      l.model === "fast" ? "النموذج السريع فقط" : l.deep ? "النموذج الرئيس + تفكير عميق" : "النموذج الرئيس",
      l.tools ? `${l.tools.length} أدوات` : "كل أدوات الوكيل",
      ...(l.spaceIds.length ? [`لأعضاء ${l.spaceIds.map((id) => data.spaces.find((x) => x._id === id)?.name ?? "مساحة").join("، ")}`] : []),
      ...(data.sources.length ? [l.sources ? (l.sources.length ? `${l.sources.length} من مصادر البيانات` : "بلا مصادر بيانات") : "كل مصادر البيانات"] : []),
      l.subagents >= 2 ? `حتى ${l.subagents} وكلاء للطلب` : "وكيل واحد للطلب",
      l.dailyQuestions ? `${l.dailyQuestions} سؤالاً يومياً` : "بلا حد يومي",
    ].join(" · ");

  return (
    <div className="space-y-6">
      <PageHeader
        title="المستويات وحدود الاستخدام"
        subtitle="ما يحصل عليه كل موظف: النموذج، والتفكير العميق، والأدوات، ومصادر البيانات، وتقسيم الطلب على عدة وكلاء، وعدد الأسئلة في اليوم. من ليس له مستوى يأخذ المستوى الافتراضي، وبلا مستويات لا قيود على أحد."
        actions={
          <button className="btn-primary" onClick={() => setEditing({ ...NEW })}>
            <Icon name="plus" /> مستوى جديد
          </button>
        }
      />
      {error && <p className="alert-negative">{error}</p>}

      {editing && (
        <section className="card animate-rise space-y-4 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="label">الاسم</span>
              <input className="input w-full" value={editing.name} maxLength={40} onChange={(e) => set("name", e.target.value)} placeholder="أساسي" />
            </label>
            <label className="text-sm">
              <span className="label">الوصف</span>
              <input className="input w-full" value={editing.description} maxLength={300} onChange={(e) => set("description", e.target.value)} placeholder="لعموم الموظفين" />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm">
              <span className="label">النموذج</span>
              <select className="input w-full" value={editing.model} onChange={(e) => set("model", e.target.value as Draft["model"])}>
                <option value="main">الرئيس (أدق)</option>
                <option value="fast">السريع فقط (أخف)</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="label">تقسيم الطلب على وكلاء</span>
              <select className="input w-full" value={editing.subagents} onChange={(e) => set("subagents", Number(e.target.value))}>
                <option value={0}>لا</option>
                {Array.from({ length: data.maxSubagents - 1 }, (_, i) => i + 2).map((n) => (
                  <option key={n} value={n}>
                    حتى {n} وكلاء
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="label">أسئلة في اليوم (0 = بلا حد)</span>
              <input className="input w-full num" type="number" min={0} max={10000} value={editing.dailyQuestions} onChange={(e) => set("dailyQuestions", Number(e.target.value))} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={editing.deep && editing.model === "main"} disabled={editing.model === "fast"} onChange={(e) => set("deep", e.target.checked)} />
            يسمح بـ«تفكير عميق» {editing.model === "fast" && <span className="meta">(النموذج السريع لا يفكّر)</span>}
          </label>
          <fieldset className="space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={editing.tools === null} onChange={(e) => set("tools", e.target.checked ? null : data.tools.map((t) => t.name))} />
              كل أدوات الوكيل الذي يُختار
            </label>
            {editing.tools !== null && (
              <div className="grid gap-1 ps-6 sm:grid-cols-2">
                {data.tools.map((t) => (
                  <label key={t.name} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={editing.tools!.includes(t.name)}
                      onChange={(e) => set("tools", e.target.checked ? [...editing.tools!, t.name] : editing.tools!.filter((x) => x !== t.name))}
                    />
                    {t.label}
                    {t.writes && <span className="badge">كتابة</span>}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          {data.spaces.length > 0 && (
            <fieldset className="space-y-2 text-sm">
              <legend className="mb-1 font-medium">مستوى فريق</legend>
              <p className="text-xs text-muted">يأخذه أعضاء هذه المساحات تلقائياً، ما لم يكن لأحدهم مستوى خاص. ومن كان في أكثر من فريق يأخذ الأسخى.</p>
              <div className="flex flex-wrap gap-1.5">
                {data.spaces.map((sp) => {
                  const on = editing.spaceIds.includes(sp._id);
                  return (
                    <button type="button" key={sp._id} aria-pressed={on} onClick={() => set("spaceIds", on ? editing.spaceIds.filter((x) => x !== sp._id) : [...editing.spaceIds, sp._id])} className={`h-8 rounded-full border px-3 text-xs ${on ? "border-primary bg-primary-soft text-primary" : "border-line hover:border-control"}`}>
                      {sp.name}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}
          {data.sources.length > 0 && (
            <fieldset className="space-y-2 text-sm">
              <legend className="mb-1 font-medium">مصادر البيانات</legend>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={editing.sources === null} onChange={(e) => set("sources", e.target.checked ? null : [])} />
                كل المصادر المتاحة للموظف
              </label>
              {editing.sources !== null && (
                <div className="grid gap-1 ps-6 sm:grid-cols-2">
                  {data.sources.map((d) => (
                    <label key={d._id} className="flex items-center gap-2">
                      <input type="checkbox" checked={editing.sources!.includes(d._id)} onChange={(e) => set("sources", e.target.checked ? [...editing.sources!, d._id] : editing.sources!.filter((x) => x !== d._id))} />
                      {d.name}
                      {!d.enabled && <span className="badge">معطّل</span>}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
          )}
          <div className="flex gap-2">
            <button
              className="btn-primary"
              disabled={!editing.name.trim()}
              onClick={() =>
                void save({ ...(editing.levelId ? { levelId: editing.levelId } : {}), name: editing.name, description: editing.description, model: editing.model, deep: editing.deep, tools: editing.tools, sources: editing.sources, spaceIds: editing.spaceIds, subagents: editing.subagents, dailyQuestions: editing.dailyQuestions })
                  .then(() => (setEditing(null), setError("")))
                  .catch((e) => setError(errorText(e)))
              }
            >
              حفظ
            </button>
            <button className="btn-ghost" onClick={() => setEditing(null)}>
              إلغاء
            </button>
          </div>
        </section>
      )}

      {data.levels.length === 0 && !editing ? (
        <EmptyState icon="users" title="لا مستويات بعد" action={<button className="btn-secondary" onClick={() => setEditing({ ...NEW })}>أنشئ أول مستوى</button>}>
          الآن لا قيود على أحد. أول مستوى تنشئه يصبح الافتراضي لكل من ليس له مستوى.
        </EmptyState>
      ) : (
        <ul className="card divide-y divide-rule">
          {data.levels.map((l) => (
            <li key={l._id} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{l.name}</span>
                  {l.isDefault && <span className="badge-primary">الافتراضي</span>}
                  <span className="meta">{l.members} موظف</span>
                </div>
                <div className="meta">{summary(l)}</div>
                {l.description && <div className="text-sm text-muted">{l.description}</div>}
              </div>
              {!l.isDefault && (
                <button className="btn-ghost" onClick={() => run(setDefault({ levelId: l._id }))}>
                  اجعله الافتراضي
                </button>
              )}
              <button className="btn-ghost" onClick={() => setEditing({ levelId: l._id, name: l.name, description: l.description, model: l.model, deep: l.deep, tools: l.tools, sources: l.sources, spaceIds: l.spaceIds, subagents: l.subagents, dailyQuestions: l.dailyQuestions })}>
                تعديل
              </button>
              <button className="btn-danger" onClick={() => void ask(`حذف مستوى «${l.name}»؟ يعود موظفوه إلى المستوى الافتراضي.`, { danger: true, confirmLabel: "حذف" }).then((ok) => { if (ok) void run(remove({ levelId: l._id })); })}>
                حذف
              </button>
            </li>
          ))}
        </ul>
      )}

      {data.levels.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">الموظفون</h2>
          <p className="text-xs text-muted">مستوى كل موظف واستخدامه اليوم (يتجدد الحد منتصف الليل).</p>
          <ul className="card divide-y divide-rule">
            {data.users.map((u) => (
              <li key={u._id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{u.name}</span>
                {u.effective.via === "team" && !u.levelId && <span className="badge">من فريقه: {u.effective.name}</span>}
                <Usage used={u.usedToday} limit={u.effective.dailyQuestions} />
                <select className="input w-56" aria-label={`مستوى ${u.name}`} value={u.levelId ?? ""} onChange={(e) => run(assign({ userId: u._id, levelId: e.target.value || null }))}>
                  <option value="">{!u.levelId && u.effective.via === "team" ? `تلقائي («${u.effective.name}» من فريقه)` : def ? `الافتراضي («${def.name}»)` : "بلا قيود"}</option>
                  {data.levels.map((l) => (
                    <option key={l._id} value={l._id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Usage({ used, limit }: { used: number; limit: number }) {
  if (!limit) return <span className="w-28 text-xs text-muted num">{used} اليوم</span>;
  const pct = Math.min(100, Math.round((used / limit) * 100));
  return (
    <span className="flex w-28 items-center gap-2" title={`${used} من ${limit} سؤالاً اليوم`}>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
        <span className={`block h-full rounded-full ${pct >= 100 ? "bg-negative" : pct >= 80 ? "bg-warning" : "bg-primary"}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="text-xs text-muted num">
        {used}/{limit}
      </span>
    </span>
  );
}
