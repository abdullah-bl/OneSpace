// Workspace admin: agents (Phase 6, redesigned). An agent is a role: when it's used (the router reads
// that), how it works (instructions), how it answers (open / documents only), and where it looks.
// Tools are «كل الأدوات» by default: a tool never grants access by itself (it runs as the employee,
// writes to shared places wait for «نفّذ», and the employee's level caps tools), so hand-picking
// is only for agents that must not do something. Edits go to a draft; «جرّب» runs the draft on test
// questions as the admin; «انشر» makes it the next version. Every change is audited and any
// earlier version can be published again.

import { useEffect, useState, type ReactNode } from "react";
import { useAction, useMutation, useQuery } from "onebase/react";
import { api, errorText, formatDate, type SpaceInfo } from "./lib";
import { Icon } from "./icons";
import { Menu, type MenuItem } from "./ui";

type Config = {
  name: string;
  description: string;
  instructions: string;
  toolMode?: "all" | "custom";
  allowedTools: string[];
  dataScope: "everyone" | "member" | "all";
  modelRole: "main" | "fast";
  maxSteps: number;
  visibility: { kind: "workspace" | "spaces"; spaceIds: string[] };
  grounding?: "open" | "documents";
};

const EMPTY: Config = {
  name: "",
  description: "",
  instructions: "",
  toolMode: "all",
  allowedTools: [],
  dataScope: "all",
  modelRole: "main",
  maxSteps: 4,
  visibility: { kind: "workspace", spaceIds: [] },
  grounding: "open",
};

const SCOPES: { value: Config["dataScope"]; title: string; detail: string }[] = [
  { value: "all", title: "ما يقرؤه الموظف", detail: "كل ما يملك قراءته، ويضيّقه بالإشارة @ إلى ملف أو مساحة" },
  { value: "member", title: "مساحاته فقط", detail: "مساحته الخاصة والمساحات التي هو عضو فيها" },
  { value: "everyone", title: "المنشور للجميع فقط", detail: "مساحات «للجميع» مثل الأنظمة واللوائح" },
];

type AgentRow = NonNullable<ReturnType<typeof useQuery<typeof api.agents.list>>>[number];

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
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="page-title">الوكلاء</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">يختار المساعد الوكيل المناسب لكل طلب تلقائياً من «متى يُستخدم». كل وكيل يعمل بصلاحيات الموظف نفسه ولا يوسّعها.</p>
        </div>
        <button className="btn-primary" onClick={() => setSelected("new")}>
          <Icon name="plus" /> وكيل جديد
        </button>
      </header>
      {error && <p className="alert-negative mb-4">{error}</p>}

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <aside className="shrink-0 space-y-2 lg:sticky lg:top-6 lg:w-64">
          {agents?.map((a) => {
            const cfg = (a.live ?? a.draft) as Config | null;
            const on = selected === a._id;
            return (
              <button
                key={a._id}
                onClick={() => setSelected(a._id)}
                className={`flex w-full items-start gap-3 rounded-xl border p-3 text-start transition-colors ${on ? "border-primary bg-primary-soft" : "border-line bg-surface hover:border-control"}`}
              >
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${on ? "bg-primary text-white" : "bg-active text-muted"}`}>
                  <Icon name="bot" size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{cfg?.name}</span>
                    {a.isDefault && <span className="badge-primary">افتراضي</span>}
                  </span>
                  <span className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted">{cfg?.description || "—"}</span>
                  <span className="mt-1.5 flex flex-wrap gap-1">
                    {a.version ? <span className="badge">النسخة {a.version}</span> : <span className="badge-warning">لم يُنشر</span>}
                    {a.draft && a.version > 0 && <span className="badge-warning">مسودة</span>}
                    {!a.enabled && <span className="badge-negative">معطّل</span>}
                  </span>
                </span>
              </button>
            );
          })}
          {agents && !["default", "policies", "grades", "analysis"].every((k) => agents.some((a) => a.key === k)) && (
            <button className="btn-ghost w-full justify-center text-xs" onClick={() => void seed({}).catch((e) => setError(errorText(e)))}>
              أضف الوكلاء المبدئيين
            </button>
          )}
        </aside>

        <section className="min-w-0 flex-1">
          {selected === "new" && <Editor key="new" agent={null} onCreated={(id) => setSelected(id)} />}
          {current && <Editor key={current._id} agent={current} onCreated={() => {}} />}
        </section>
      </div>
    </div>
  );
}

/** A titled block of the editor. */
function Section({ title, hint, children, aside }: { title: string; hint?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-rule py-5 first:border-t-0 first:pt-0">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium">{title}</h3>
          {hint && <p className="mt-0.5 text-xs leading-5 text-muted">{hint}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Two or three mutually exclusive choices shown as cards. */
function Choice<T extends string>({ value, options, onChange }: { value: T; options: { value: T; title: string; detail: string; badge?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className={`grid gap-2 ${options.length === 3 ? "@2xl:grid-cols-3" : "@lg:grid-cols-2"}`} role="radiogroup">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`rounded-xl border p-3 text-start transition-colors ${on ? "border-primary bg-primary-soft" : "border-line hover:border-control"}`}
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${on ? "border-primary" : "border-control"}`}>{on && <span className="h-2 w-2 rounded-full bg-primary" />}</span>
              {o.title}
              {o.badge && <span className="badge-positive ms-auto">{o.badge}</span>}
            </span>
            <span className="mt-1 block ps-6 text-xs leading-5 text-muted">{o.detail}</span>
          </button>
        );
      })}
    </div>
  );
}

function Editor({ agent, onCreated }: { agent: AgentRow | null; onCreated: (id: string) => void }) {
  const [tab, setTab] = useState<"setup" | "test" | "versions">("setup");
  const create = useMutation(api.agents.create);
  const saveDraft = useMutation(api.agents.saveDraft);
  const discard = useMutation(api.agents.discardDraft);
  const publish = useMutation(api.agents.publish);
  const setEnabled = useMutation(api.agents.setEnabled);
  const setDefault = useMutation(api.agents.setDefault);
  const initial = () => ({ ...EMPTY, ...((agent?.draft ?? agent?.live ?? EMPTY) as Config), toolMode: ((agent?.draft ?? agent?.live) as Config | undefined)?.toolMode ?? (agent ? "custom" : "all") });
  const [form, setForm] = useState<Config>(initial);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial());

  useEffect(() => setForm(initial()), [agent?._id, agent?.version, JSON.stringify(agent?.draft ?? null)]);

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
  const name = agent ? ((agent.live ?? agent.draft) as Config | null)?.name : "وكيل جديد";

  const actions: MenuItem[] = [];
  if (agent) {
    if (!agent.isDefault && agent.live && agent.enabled) actions.push({ label: "اجعله الافتراضي", icon: "check", onSelect: () => void run(() => setDefault({ agentId: agent._id }), "صار الوكيل الافتراضي") });
    if (agent.draft && agent.live) actions.push({ label: "تجاهل المسودة", icon: "retry", onSelect: () => confirm("تجاهل المسودة والعودة للنسخة المنشورة؟") && void run(() => discard({ agentId: agent._id })) });
    if (!agent.isDefault) actions.push({ label: agent.enabled ? "تعطيل الوكيل" : "تفعيل الوكيل", icon: agent.enabled ? "pause" : "play", danger: agent.enabled, onSelect: () => void run(() => setEnabled({ agentId: agent._id, enabled: !agent.enabled })) });
  }

  return (
    <div className="card @container">
      <div className="space-y-3 px-5 pt-5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-bold">{name}</h2>
            <p className="mt-1 text-xs text-muted">
              {!agent ? "يُحفظ كمسودة لا يراها الموظفون حتى تنشره." : agent.version ? `يستخدم الموظفون النسخة ${agent.version}${agent.draft ? "، وعندك مسودة لم تُنشر" : ""}.` : "لم يُنشر بعد، فلا يراه الموظفون."}
            </p>
          </div>
          {actions.length > 0 && <Menu label="خيارات الوكيل" items={actions} />}
        </div>
        {agent && (
          <nav className="tabs">
            {(
              [
                ["setup", "الإعداد"],
                ["test", "التجربة"],
                ["versions", "النسخ"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} className={tab === k ? "tab-active" : "tab"} onClick={() => setTab(k)}>
                {label}
              </button>
            ))}
          </nav>
        )}
      </div>

      {tab === "setup" && (
        <>
          <div className="px-5 pt-5">
            <AiDraft form={form} onDraft={(d) => setForm((f) => ({ ...f, ...d, modelRole: f.modelRole ?? "main" }))} onError={setError} onNote={setNote} />
            <Section title="الأساس">
              <label className="block text-sm">
                <span className="label">الاسم</span>
                <input className="input w-full" value={form.name} maxLength={80} onChange={(e) => set("name", e.target.value)} placeholder="محلل العقود" />
              </label>
              <label className="block text-sm">
                <span className="label">متى يُستخدم</span>
                <textarea className="textarea w-full" rows={2} dir="auto" value={form.description} maxLength={500} onChange={(e) => set("description", e.target.value)} placeholder="حين يطلب الموظف مراجعة عقد أو استخراج مدده وغراماته" />
                <span className="mt-1 block text-xs text-faint">يقرؤه المساعد ليختار هذا الوكيل تلقائياً، فاكتبه جملة واضحة عن نوع الطلبات.</span>
              </label>
            </Section>

            <Section title="التعليمات" hint="كيف يعمل وكيف يكتب. تُضاف بعد قواعد النظام الثابتة (الاستشهاد، والامتناع، وتجاهل الأوامر داخل الملفات)، ولا تمنح أي صلاحية.">
              <textarea className="textarea min-h-44 w-full leading-7" dir="auto" value={form.instructions} maxLength={8000} onChange={(e) => set("instructions", e.target.value)} placeholder="أنت… ابدأ بـ… اذكر المصدر… لا تفعل…" />
            </Section>

            <Section title="الأدوات" hint="الأدوات لا توسّع الصلاحيات: تعمل بصلاحيات الموظف، وما يكتب في مكان مشترك ينتظر «نفّذ»، ومستوى الموظف يحدد ما يتاح له.">
              <Choice
                value={form.toolMode ?? "custom"}
                onChange={(v) => set("toolMode", v)}
                options={[
                  { value: "all", title: "كل الأدوات", detail: "يستخدم ما يحتاجه الطلب، ويشمل ما يُضاف للنظام لاحقاً.", badge: "موصى به" },
                  { value: "custom", title: "أدوات محددة", detail: "لوكيل يجب ألا يفعل أشياء بعينها، مثل وكيل للأنظمة لا ينشئ ملفات." },
                ]}
              />
              <ToolList form={form} onChange={(tools) => set("allowedTools", tools)} />
            </Section>

            <Section title="طريقة الإجابة">
              <Choice
                value={form.grounding ?? "documents"}
                onChange={(v) => set("grounding", v)}
                options={[
                  { value: "open", title: "مساعد عام", detail: "يجيب عن أي سؤال، ويرجع إلى المستندات ويستشهد بها حين يتعلق السؤال بها." },
                  { value: "documents", title: "من المستندات فقط", detail: "لا يجيب إلا بما في المستندات، ويعتذر إن لم يجده. للأنظمة والسياسات." },
                ]}
              />
            </Section>

            <Section title="أين يبحث" hint="ضمن ما يملك الموظف قراءته دائماً.">
              <Choice value={form.dataScope} onChange={(v) => set("dataScope", v)} options={SCOPES.map((s) => ({ value: s.value, title: s.title, detail: s.detail }))} />
            </Section>

            <Advanced form={form} set={set} />
          </div>

          <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 rounded-b-[inherit] border-t border-line bg-surface/95 px-5 py-3 backdrop-blur">
            {error ? <p className="min-w-0 flex-1 text-sm text-negative">{error}</p> : note ? <p className="min-w-0 flex-1 text-sm text-positive">{note}</p> : <p className="min-w-0 flex-1 text-xs text-muted">{dirty ? "تغييرات غير محفوظة" : agent?.draft ? "المسودة محفوظة، جرّبها ثم انشرها." : "لا تغييرات"}</p>}
            {!agent ? (
              <button className="btn-primary" disabled={busy || !form.name.trim()} onClick={() => void run(async () => onCreated((await create({ config: form as any })) as string), "حُفظ كمسودة. جرّبه ثم انشره.")}>
                حفظ كمسودة
              </button>
            ) : (
              <>
                <button className="btn-secondary" disabled={busy || !dirty} onClick={() => void run(() => saveDraft({ agentId: agent._id, config: form as any }), "حُفظت المسودة")}>
                  حفظ المسودة
                </button>
                <button
                  className="btn-primary"
                  disabled={busy || dirty || !agent.draft}
                  title={dirty ? "احفظ المسودة أولاً" : !agent.draft ? "لا مسودة لنشرها" : ""}
                  onClick={() => confirm("نشر المسودة؟ يستخدمها الموظفون من سؤالهم التالي.") && void run(() => publish({ agentId: agent._id }), "نُشرت نسخة جديدة")}
                >
                  انشر
                </button>
              </>
            )}
          </div>
        </>
      )}
      {agent && tab === "test" && (
        <div className="p-5">
          <TestPanel agent={agent} />
        </div>
      )}
      {agent && tab === "versions" && (
        <div className="p-5">
          <History agentId={agent._id} />
        </div>
      )}
    </div>
  );
}

/** «صمّم / حسّن بالذكاء الاصطناعي»: fills the form only; nothing is saved or published. */
function AiDraft({ form, onDraft, onError, onNote }: { form: Config; onDraft: (d: Partial<Config>) => void; onError: (e: string) => void; onNote: (n: string) => void }) {
  const draftWithAI = useAction(api.agentDrafts.draftWithAI);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const improving = !!form.instructions.trim();
  const go = async () => {
    setBusy(true);
    onError("");
    try {
      const d = await draftWithAI({ goal, ...(improving ? { current: { name: form.name, description: form.description, instructions: form.instructions, allowedTools: form.toolMode === "all" ? [] : form.allowedTools } } : {}) });
      onDraft(d as Partial<Config>);
      setGoal("");
      onNote("عُبّئت الحقول بمسودة من الذكاء الاصطناعي. راجعها ثم احفظها وجرّبها قبل النشر.");
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-5 flex items-center gap-2 rounded-xl border border-line bg-sunken p-1.5 ps-3 focus-within:border-primary">
      <Icon name="bot" size={17} className="shrink-0 text-primary" />
      <input
        className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
        value={goal}
        dir="auto"
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (goal.trim() || improving) && !busy && void go()}
        placeholder={improving ? "حسّن بالذكاء الاصطناعي: ما الذي تريد تغييره؟ (اختياري)" : "صف الوكيل ويكتبه الذكاء الاصطناعي: يراجع عقود المشتريات ويستخرج المدد والغرامات"}
        aria-label="وصف للذكاء الاصطناعي"
      />
      <button className="btn-primary shrink-0" disabled={busy || (!goal.trim() && !improving)} onClick={() => void go()}>
        {busy ? "يكتب…" : improving ? "حسّن" : "صمّم"}
      </button>
    </div>
  );
}

/** The registry, grouped: reads run directly, writes are proposed or run by tier. */
function ToolList({ form, onChange }: { form: Config; onChange: (tools: string[]) => void }) {
  const tools = useQuery(api.agents.toolRegistry);
  if (!tools) return null;
  const all = (form.toolMode ?? "custom") === "all";
  const groups = [
    { title: "قراءة وبحث", hint: "تعمل مباشرة", items: tools.filter((t) => !t.requiresConfirmation) },
    { title: "إنشاء وتنفيذ", hint: "في مساحة الموظف الخاصة تُنفَّذ مع إمكان التراجع، وفي المشتركة تنتظر «نفّذ»", items: tools.filter((t) => t.requiresConfirmation) },
  ];
  const on = (n: string) => all || form.allowedTools.includes(n);
  return (
    <div className={`grid gap-3 @2xl:grid-cols-2 ${all ? "opacity-60" : ""}`}>
      {groups.map((g) => (
        <div key={g.title} className="rounded-xl border border-line">
          <div className="border-b border-rule px-3 py-2">
            <div className="text-xs font-medium">{g.title}</div>
            <div className="text-[11px] leading-4 text-faint">{g.hint}</div>
          </div>
          <ul className="divide-y divide-rule">
            {g.items.map((t) => (
              <li key={t.name}>
                <label className={`flex items-center gap-2.5 px-3 py-2 text-sm ${all ? "" : "cursor-pointer hover:bg-sunken"}`} title={t.description}>
                  <input
                    type="checkbox"
                    disabled={all}
                    checked={on(t.name)}
                    onChange={() => onChange(form.allowedTools.includes(t.name) ? form.allowedTools.filter((x) => x !== t.name) : [...form.allowedTools, t.name])}
                  />
                  <span className="min-w-0">{t.label.replace(/…$/, "")}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Advanced({ form, set }: { form: Config; set: <K extends keyof Config>(k: K, v: Config[K]) => void }) {
  const sharedSpaces = useQuery(api.admin.spaces);
  const toggleSpace = (id: string) =>
    set("visibility", { kind: "spaces", spaceIds: form.visibility.spaceIds.includes(id) ? form.visibility.spaceIds.filter((s) => s !== id) : [...form.visibility.spaceIds, id] });
  return (
    <details className="group border-t border-rule py-5">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
        <Icon name="down" size={14} className="text-muted transition-transform group-open:rotate-180" />
        إعدادات متقدمة
        <span className="meta font-normal">
          {form.modelRole === "main" ? "النموذج الرئيس" : "النموذج السريع"} · {form.maxSteps} جولات · {form.visibility.kind === "workspace" ? "لكل مساحة العمل" : `${form.visibility.spaceIds.length} مساحات`}
        </span>
      </summary>
      <div className="mt-4 space-y-4">
        <div className="grid gap-3 @lg:grid-cols-2">
          <label className="text-sm">
            <span className="label">النموذج</span>
            <select className="input w-full" value={form.modelRole} onChange={(e) => set("modelRole", e.target.value as Config["modelRole"])}>
              <option value="main">الرئيس (أدق)</option>
              <option value="fast">السريع (أخف)</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="label">أقصى جولات الأدوات للإجابة</span>
            <input className="input num w-full" type="number" min={1} max={8} value={form.maxSteps} onChange={(e) => set("maxSteps", Number(e.target.value))} />
          </label>
        </div>
        <div className="space-y-2 text-sm">
          <span className="label">من يمكن أن يُختار له</span>
          <Choice
            value={form.visibility.kind}
            onChange={(k) => set("visibility", { kind: k, spaceIds: k === "workspace" ? [] : form.visibility.spaceIds })}
            options={[
              { value: "workspace", title: "كل مساحة العمل", detail: "أي موظف" },
              { value: "spaces", title: "أعضاء مساحات محددة", detail: "من يقرأ إحدى المساحات المختارة" },
            ]}
          />
          {form.visibility.kind === "spaces" && (
            <div className="flex flex-wrap gap-2">
              {sharedSpaces?.map((sp) => (
                <label key={sp._id} className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${form.visibility.spaceIds.includes(sp._id) ? "border-primary bg-primary-soft" : "border-line"}`}>
                  <input type="checkbox" className="sr-only" checked={form.visibility.spaceIds.includes(sp._id)} onChange={() => toggleSpace(sp._id)} />
                  {form.visibility.spaceIds.includes(sp._id) && <Icon name="check" size={12} />}
                  {sp.name}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
    </details>
  );
}

/** «التجربة»: the draft (or the published version if there is no draft) on the admin's questions. */
function TestPanel({ agent }: { agent: AgentRow }) {
  const results = useQuery(api.agents.testResults, { agentId: agent._id });
  const setQuestions = useMutation(api.agents.setTestQuestions);
  const runTests = useMutation(api.agents.runTests);
  const [text, setText] = useState(agent.testQuestions.join("\n"));
  const [error, setError] = useState("");
  const saved = text.split("\n").map((q) => q.trim()).filter(Boolean);
  const dirty = JSON.stringify(saved) !== JSON.stringify(agent.testQuestions);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{agent.draft ? "يجرّب المسودة غير المنشورة" : "يجرّب النسخة المنشورة"} بصلاحياتك أنت. سؤال في كل سطر (حتى 10).</p>
      <textarea className="textarea min-h-28 w-full" dir="auto" placeholder="ما مدة إجازة الأمومة؟" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex gap-2">
        <button className="btn-secondary" disabled={!dirty} onClick={() => void setQuestions({ agentId: agent._id, questions: saved }).catch((e) => setError(errorText(e)))}>
          حفظ الأسئلة
        </button>
        <button
          className="btn-primary"
          disabled={dirty || !agent.testQuestions.length}
          title={dirty ? "احفظ الأسئلة أولاً" : ""}
          onClick={() => {
            setError("");
            void runTests({ agentId: agent._id }).catch((e) => setError(errorText(e)));
          }}
        >
          <Icon name="play" size={14} /> جرّب
        </button>
      </div>
      {error && <p className="alert-negative">{error}</p>}
      <div className="space-y-2">
        {results?.map((r) => (
          <div key={r.threadId} className="rounded-xl border border-line p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{r.question}</span>
              <span className="meta ms-auto">{formatDate(r.at)}</span>
            </div>
            {r.toolRuns.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {r.toolRuns.map((t, i) => (
                  <span key={i} className={t.ok ? "badge" : "badge-negative"} title={t.summary}>
                    {t.name}
                    {t.ok ? "" : " · رُفضت"}
                  </span>
                ))}
              </div>
            )}
            {r.answer && <div className="mt-2 whitespace-pre-wrap leading-7 text-muted">{r.answer}</div>}
            {r.error && <div className="mt-2 text-negative">{r.error}</div>}
            {r.citations.length > 0 && <div className="meta mt-2">المصادر: {r.citations.map((c) => `[${c.n}] ${c.fileName}`).join("، ")}</div>}
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
  if (!versions) return null;
  if (!versions.length) return <p className="text-sm text-muted">لم يُنشر بعد.</p>;
  return (
    <div className="space-y-2">
      {error && <p className="alert-negative">{error}</p>}
      <ol className="space-y-2">
        {versions.map((v) => {
          const cfg = v.config as Config;
          return (
            <li key={v.version} className="rounded-xl border border-line p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">النسخة {v.version}</span>
                {v.current && <span className="badge-primary">الحالية</span>}
                {v.revertedFrom !== null && <span className="meta">(من النسخة {v.revertedFrom})</span>}
                <span className="meta">
                  {formatDate(v.publishedAt)} · {v.publishedBy ?? "—"} · {cfg.toolMode === "all" ? "كل الأدوات" : `${cfg.allowedTools.length} أدوات`}
                </span>
                {!v.current && (
                  <button className="btn-ghost ms-auto text-xs" onClick={() => confirm(`نشر محتوى النسخة ${v.version} كنسخة جديدة؟`) && void revert({ agentId, version: v.version }).catch((e) => setError(errorText(e)))}>
                    استرجع
                  </button>
                )}
              </div>
              <details className="mt-1">
                <summary className="meta cursor-pointer">التعليمات</summary>
                <pre className="mt-1 whitespace-pre-wrap font-[inherit] text-xs leading-6 text-muted">{cfg.instructions || "—"}</pre>
              </details>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
