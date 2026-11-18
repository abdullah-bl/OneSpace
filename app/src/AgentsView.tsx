// Workspace admin: agents (Phase 6). An agent is instructions + tools picked from the code
// registry + a data scope + who may use it. Edits go to a draft; "جرّب الوكيل" runs the draft on
// test questions (as the admin); "انشر" makes it the next version. Every change is audited and any
// earlier version can be published again.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "onebase/react";
import { api, errorText, formatDate, type SpaceInfo } from "./lib";

type Config = {
  name: string;
  description: string;
  instructions: string;
  allowedTools: string[];
  dataScope: "everyone" | "member" | "all";
  modelRole: "main" | "fast";
  maxSteps: number;
  visibility: { kind: "workspace" | "spaces"; spaceIds: string[] };
};

const EMPTY: Config = {
  name: "",
  description: "",
  instructions: "",
  allowedTools: ["search_documents", "read_file"],
  dataScope: "all",
  modelRole: "main",
  maxSteps: 4,
  visibility: { kind: "workspace", spaceIds: [] },
};

const SCOPES: Record<Config["dataScope"], string> = {
  everyone: "مساحات «للجميع» فقط",
  member: "المساحات التي المستخدم عضو فيها",
  all: "ما يختاره المستخدم من مساحاته",
};

export function AgentsView(_props: { spaces: SpaceInfo[] }) {
  const agents = useQuery(api.agents.list);
  const seed = useMutation(api.agents.seedStarterAgents);
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [error, setError] = useState("");
  const current = agents?.find((a) => a._id === selected) ?? null;

  useEffect(() => {
    if (selected === null && agents?.length) setSelected(agents[0]!._id);
  }, [agents, selected]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 lg:flex-row">
      <aside className="shrink-0 space-y-2 lg:w-64">
        <h1 className="text-xl font-semibold">الوكلاء</h1>
        <p className="text-xs text-slate-500">كل وكيل يعمل بهوية المستخدم وصلاحياته، ولا يوسّعها. تختار أدواته من الموجود في النظام.</p>
        <button className="btn-primary w-full justify-center" onClick={() => setSelected("new")}>
          ＋ وكيل جديد
        </button>
        <div className="card p-1">
          {agents?.map((a) => {
            const cfg = a.draft ?? a.live;
            return (
              <button key={a._id} className={`block w-full rounded-lg px-2 py-1.5 text-start text-sm ${selected === a._id ? "bg-teal-50" : "hover:bg-slate-100"}`} onClick={() => setSelected(a._id)}>
                <div className="flex items-center gap-1">
                  <span className="truncate font-semibold">{(a.live ?? cfg)?.name}</span>
                  {a.isDefault && <span className="rounded bg-teal-100 px-1 text-[10px] text-teal-800">افتراضي</span>}
                </div>
                <div className="flex gap-1 text-[11px] text-slate-500">
                  <span>{a.version ? `النسخة ${a.version}` : "لم يُنشر"}</span>
                  {a.draft && <span className="text-amber-700">· مسودة</span>}
                  {!a.enabled && <span className="text-red-700">· معطّل</span>}
                </div>
              </button>
            );
          })}
        </div>
        {agents && !["default", "policies", "grades", "analysis"].every((k) => agents.some((a) => a.key === k)) && (
          <button className="btn-ghost w-full justify-center text-xs" onClick={() => void seed({}).catch((e) => setError(errorText(e)))}>
            أضف الوكلاء المبدئيين
          </button>
        )}
      </aside>
      <section className="min-w-0 flex-1 space-y-4">
        {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        {selected === "new" && <Editor key="new" agent={null} onCreated={(id) => setSelected(id)} />}
        {current && <Editor key={current._id} agent={current} onCreated={() => {}} />}
      </section>
    </div>
  );
}

type AgentRow = NonNullable<ReturnType<typeof useQuery<typeof api.agents.list>>>[number];

function Editor({ agent, onCreated }: { agent: AgentRow | null; onCreated: (id: string) => void }) {
  const tools = useQuery(api.agents.toolRegistry);
  const sharedSpaces = useQuery(api.admin.spaces);
  const create = useMutation(api.agents.create);
  const saveDraft = useMutation(api.agents.saveDraft);
  const discard = useMutation(api.agents.discardDraft);
  const publish = useMutation(api.agents.publish);
  const setEnabled = useMutation(api.agents.setEnabled);
  const setDefault = useMutation(api.agents.setDefault);
  const [form, setForm] = useState<Config>(() => ((agent?.draft ?? agent?.live ?? EMPTY) as Config));
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const base = (agent?.draft ?? agent?.live ?? EMPTY) as Config;
  const dirty = JSON.stringify(form) !== JSON.stringify(base);

  useEffect(() => setForm((agent?.draft ?? agent?.live ?? EMPTY) as Config), [agent?._id, agent?.version, JSON.stringify(agent?.draft ?? null)]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await fn();
      if (done) setNote(done);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const set = <K extends keyof Config>(k: K, v: Config[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggleTool = (name: string) => set("allowedTools", form.allowedTools.includes(name) ? form.allowedTools.filter((t) => t !== name) : [...form.allowedTools, name]);
  const toggleSpace = (id: string) =>
    set("visibility", { kind: "spaces", spaceIds: form.visibility.spaceIds.includes(id) ? form.visibility.spaceIds.filter((s) => s !== id) : [...form.visibility.spaceIds, id] });

  return (
    <>
      <div className="card space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">{agent ? (agent.live ?? agent.draft)?.name : "وكيل جديد"}</h2>
          {agent && <span className="text-xs text-slate-500">{agent.version ? `المنشور: النسخة ${agent.version}` : "لم يُنشر بعد (لا يراه الموظفون)"}</span>}
          {agent?.draft && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">مسودة غير منشورة</span>}
          {agent && (
            <span className="ms-auto flex gap-2">
              {!agent.isDefault && agent.live && agent.enabled && (
                <button className="btn-ghost text-xs" disabled={busy} onClick={() => void run(() => setDefault({ agentId: agent._id }), "صار الوكيل الافتراضي")}>
                  اجعله الافتراضي
                </button>
              )}
              {!agent.isDefault && (
                <button className={agent.enabled ? "btn-danger text-xs" : "btn-primary text-xs"} disabled={busy} onClick={() => void run(() => setEnabled({ agentId: agent._id, enabled: !agent.enabled }))}>
                  {agent.enabled ? "تعطيل" : "تفعيل"}
                </button>
              )}
            </span>
          )}
        </div>
        {agent?.live && agent.draft && <p className="text-xs text-slate-500">الموظفون يستخدمون النسخة المنشورة حتى تنشر المسودة.</p>}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-slate-600">الاسم</span>
            <input className="input w-full" value={form.name} maxLength={80} onChange={(e) => set("name", e.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-slate-600">الوصف (يراه الموظف في القائمة)</span>
            <input className="input w-full" value={form.description} maxLength={500} onChange={(e) => set("description", e.target.value)} />
          </label>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="text-slate-600">التعليمات</span>
          <textarea className="input min-h-[8rem] w-full" value={form.instructions} maxLength={8000} onChange={(e) => set("instructions", e.target.value)} />
          <span className="block text-xs text-slate-400">تُضاف بعد قواعد النظام الثابتة (الاستشهاد، الامتناع، تجاهل الأوامر داخل الملفات). لا تمنح أي صلاحية: الأدوات تفحص صلاحية الموظف بنفسها.</span>
        </label>

        <div className="space-y-1 text-sm">
          <span className="text-slate-600">الأدوات المسموحة ({form.allowedTools.length})</span>
          <div className="grid gap-1 sm:grid-cols-2">
            {tools?.map((t) => (
              <label key={t.name} className="flex items-start gap-2 rounded-lg border border-slate-200 p-2" title={t.description}>
                <input type="checkbox" checked={form.allowedTools.includes(t.name)} onChange={() => toggleTool(t.name)} />
                <span>
                  <span className="font-semibold">{t.label.replace(/…$/, "")}</span> <span className="text-xs text-slate-400" dir="ltr">{t.name}</span>
                  {t.requiresConfirmation && <span className="ms-1 rounded bg-amber-50 px-1 text-[10px] text-amber-800">يحتاج «نفّذ»</span>}
                </span>
              </label>
            ))}
          </div>
          {!form.allowedTools.includes("search_documents") && <p className="text-xs text-slate-400">بلا أداة البحث لا يبحث الوكيل في المستندات قبل الإجابة.</p>}
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="text-slate-600">نطاق البيانات</span>
            <select className="input w-full" value={form.dataScope} onChange={(e) => set("dataScope", e.target.value as Config["dataScope"])}>
              {Object.entries(SCOPES).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-slate-600">النموذج</span>
            <select className="input w-full" value={form.modelRole} onChange={(e) => set("modelRole", e.target.value as Config["modelRole"])}>
              <option value="main">الرئيسي</option>
              <option value="fast">السريع</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-slate-600">أقصى عدد خطوات</span>
            <input className="input w-full" type="number" min={1} max={8} value={form.maxSteps} onChange={(e) => set("maxSteps", Number(e.target.value))} />
          </label>
        </div>

        <div className="space-y-1 text-sm">
          <span className="text-slate-600">من يستخدمه</span>
          <div className="flex gap-4">
            <label className="flex items-center gap-1">
              <input type="radio" checked={form.visibility.kind === "workspace"} onChange={() => set("visibility", { kind: "workspace", spaceIds: [] })} /> كل مساحة العمل
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" checked={form.visibility.kind === "spaces"} onChange={() => set("visibility", { kind: "spaces", spaceIds: form.visibility.spaceIds })} /> أعضاء مساحات محددة
            </label>
          </div>
          {form.visibility.kind === "spaces" && (
            <div className="flex flex-wrap gap-2">
              {sharedSpaces?.map((sp) => (
                <label key={sp._id} className="flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-xs">
                  <input type="checkbox" checked={form.visibility.spaceIds.includes(sp._id)} onChange={() => toggleSpace(sp._id)} />
                  {sp.name}
                </label>
              ))}
            </div>
          )}
        </div>

        {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        {note && <p className="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-800">{note}</p>}
        <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
          {!agent ? (
            <button className="btn-primary" disabled={busy || !form.name.trim()} onClick={() => void run(async () => onCreated((await create({ config: form as any })) as string), "حُفظ كمسودة. جرّبه ثم انشره.")}>
              حفظ كمسودة
            </button>
          ) : (
            <>
              <button className="btn-ghost border border-slate-200" disabled={busy || !dirty} onClick={() => void run(() => saveDraft({ agentId: agent._id, config: form as any }), "حُفظت المسودة")}>
                حفظ المسودة
              </button>
              <button
                className="btn-primary"
                disabled={busy || dirty || !agent.draft}
                title={dirty ? "احفظ المسودة أولاً" : ""}
                onClick={() => confirm("نشر المسودة؟ يستخدمها الموظفون من سؤالهم التالي.") && void run(() => publish({ agentId: agent._id }), "نُشرت نسخة جديدة")}
              >
                انشر
              </button>
              {agent.draft && agent.live && (
                <button className="btn-ghost" disabled={busy} onClick={() => confirm("تجاهل المسودة والعودة للنسخة المنشورة؟") && void run(() => discard({ agentId: agent._id }))}>
                  تجاهل المسودة
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {agent && <TestPanel agent={agent} />}
      {agent && <History agentId={agent._id} />}
    </>
  );
}

/** "جرّب الوكيل": the draft (or the published version if there is no draft) on the admin's questions. */
function TestPanel({ agent }: { agent: AgentRow }) {
  const results = useQuery(api.agents.testResults, { agentId: agent._id });
  const setQuestions = useMutation(api.agents.setTestQuestions);
  const runTests = useMutation(api.agents.runTests);
  const [text, setText] = useState(agent.testQuestions.join("\n"));
  const [error, setError] = useState("");
  const saved = text.split("\n").map((q) => q.trim()).filter(Boolean);
  const dirty = JSON.stringify(saved) !== JSON.stringify(agent.testQuestions);
  return (
    <div className="card space-y-3 p-4">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold">🧪 جرّب الوكيل</h3>
        <span className="text-xs text-slate-500">{agent.draft ? "يجرّب المسودة غير المنشورة" : "يجرّب النسخة المنشورة"} بصلاحياتك أنت</span>
      </div>
      <textarea className="input min-h-[5rem] w-full" placeholder="سؤال اختبار في كل سطر (حتى 10)" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex gap-2">
        <button className="btn-ghost border border-slate-200" disabled={!dirty} onClick={() => void setQuestions({ agentId: agent._id, questions: saved }).catch((e) => setError(errorText(e)))}>
          حفظ الأسئلة
        </button>
        <button
          className="btn-primary"
          disabled={dirty || !agent.testQuestions.length}
          onClick={() => {
            setError("");
            void runTests({ agentId: agent._id }).catch((e) => setError(errorText(e)));
          }}
        >
          جرّب الوكيل
        </button>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="space-y-2">
        {results?.map((r) => (
          <div key={r.threadId} className="rounded-lg border border-slate-200 p-2 text-sm">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span>{formatDate(r.at)}</span>
              <span>{r.state === "done" ? "✅" : r.state === "failed" ? "⚠️" : "⏳"}</span>
              {r.toolRuns.length > 0 && <span title={r.toolRuns.map((t) => `${t.name}: ${t.summary}`).join("\n")}>🔧 {r.toolRuns.map((t) => `${t.name}${t.ok ? "" : "✗"}`).join("، ")}</span>}
            </div>
            <div className="font-semibold">{r.question}</div>
            {r.answer && <div className="whitespace-pre-wrap text-slate-700">{r.answer}</div>}
            {r.error && <div className="text-red-700">{r.error}</div>}
            {r.citations.length > 0 && <div className="text-xs text-slate-400">المصادر: {r.citations.map((c) => `[${c.n}] ${c.fileName}`).join("، ")}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function History({ agentId }: { agentId: string }) {
  const versions = useQuery(api.agents.versions, { agentId });
  const revert = useMutation(api.agents.revert);
  const [error, setError] = useState("");
  if (!versions?.length) return null;
  return (
    <div className="card space-y-2 p-4">
      <h3 className="font-semibold">النسخ المنشورة</h3>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <table className="w-full text-sm">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">النسخة</th>
            <th className="th">نُشرت</th>
            <th className="th">بواسطة</th>
            <th className="th">الأدوات</th>
            <th className="th"></th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.version} className="border-t border-slate-100">
              <td className="td">
                {v.version}
                {v.current && <span className="ms-1 rounded bg-teal-50 px-1 text-[10px] text-teal-800">الحالية</span>}
                {v.revertedFrom !== null && <span className="ms-1 text-xs text-slate-400">(من {v.revertedFrom})</span>}
              </td>
              <td className="td text-xs">{formatDate(v.publishedAt)}</td>
              <td className="td text-xs">{v.publishedBy ?? "—"}</td>
              <td className="td text-xs" dir="ltr">{v.config.allowedTools.join(", ")}</td>
              <td className="td">
                {!v.current && (
                  <button className="btn-ghost text-xs" onClick={() => confirm(`نشر محتوى النسخة ${v.version} كنسخة جديدة؟`) && void revert({ agentId, version: v.version }).catch((e) => setError(errorText(e)))}>
                    استرجع
                  </button>
                )}
                <details className="text-xs text-slate-400">
                  <summary className="cursor-pointer">التعليمات</summary>
                  <pre className="whitespace-pre-wrap">{v.config.instructions || "—"}</pre>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
