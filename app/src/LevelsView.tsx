// «المستويات» (admin, plans/08 §D): like Claude's plans, set per employee. Each level says which
// model, whether «تفكير عميق» is allowed, which tools, how many agents a request may be split
// across, and how many questions a day. Everyone without a level of their own gets the default;
// with no levels at all, nobody is limited.

import { useState } from "react";
import { useMutation, useQuery } from "onebase/react";
import { api, errorText } from "./lib";
import { Icon } from "./icons";
import { EmptyState, PageHeader } from "./ui";

type Draft = { levelId?: string; name: string; description: string; model: "main" | "fast"; deep: boolean; tools: string[] | null; subagents: number; dailyQuestions: number };
const NEW: Draft = { name: "", description: "", model: "main", deep: false, tools: null, subagents: 0, dailyQuestions: 100 };

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
      l.subagents >= 2 ? `حتى ${l.subagents} وكلاء للطلب` : "وكيل واحد للطلب",
      l.dailyQuestions ? `${l.dailyQuestions} سؤالاً يومياً` : "بلا حد يومي",
    ].join(" · ");

  return (
    <div className="space-y-6">
      <PageHeader
        title="المستويات"
        subtitle="ما يحصل عليه كل موظف: النموذج، والتفكير العميق، والأدوات، وتقسيم الطلب على عدة وكلاء، وعدد الأسئلة في اليوم. من ليس له مستوى يأخذ المستوى الافتراضي، وبلا مستويات لا قيود على أحد."
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
          <div className="flex gap-2">
            <button
              className="btn-primary"
              disabled={!editing.name.trim()}
              onClick={() =>
                void save({ ...(editing.levelId ? { levelId: editing.levelId } : {}), name: editing.name, description: editing.description, model: editing.model, deep: editing.deep, tools: editing.tools, subagents: editing.subagents, dailyQuestions: editing.dailyQuestions })
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
              <button className="btn-ghost" onClick={() => setEditing({ levelId: l._id, name: l.name, description: l.description, model: l.model, deep: l.deep, tools: l.tools, subagents: l.subagents, dailyQuestions: l.dailyQuestions })}>
                تعديل
              </button>
              <button className="btn-danger" onClick={() => confirm(`حذف مستوى «${l.name}»؟ يعود موظفوه إلى المستوى الافتراضي.`) && run(remove({ levelId: l._id }))}>
                حذف
              </button>
            </li>
          ))}
        </ul>
      )}

      {data.levels.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">الموظفون</h2>
          <ul className="card divide-y divide-rule">
            {data.users.map((u) => (
              <li key={u._id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{u.name}</span>
                <select className="input w-56" aria-label={`مستوى ${u.name}`} value={u.levelId ?? ""} onChange={(e) => run(assign({ userId: u._id, levelId: e.target.value || null }))}>
                  <option value="">{def ? `الافتراضي («${def.name}»)` : "بلا قيود"}</option>
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
