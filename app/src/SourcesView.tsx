// «مصادر البيانات» (admin console): databases, internal systems (REST) and search engines that
// agents can read from with the query_source tool. Backend: onebase/dataSources.ts. Connection
// strings and auth headers are write-only; the list shows them masked.

import { useState } from "react";
import { useAction, useMutation, useQuery } from "onebase/react";
import { api, errorText, formatDate, type SpaceInfo } from "./lib";
import { Icon, type IconName } from "./icons";
import { ask, EmptyState, Menu, PageHeader } from "./ui";

type Kind = "postgres" | "mysql" | "sqlite" | "http" | "search" | "mcp";
const KINDS: { key: Kind; title: string; detail: string; icon: IconName; url: string }[] = [
  { key: "postgres", title: "PostgreSQL", detail: "قاعدة بيانات", icon: "database", url: "postgres://reader:password@db.local:5432/hr" },
  { key: "mysql", title: "MySQL / MariaDB", detail: "قاعدة بيانات", icon: "database", url: "mysql://reader:password@db.local:3306/erp" },
  { key: "sqlite", title: "SQLite", detail: "ملف قاعدة بيانات على الخادم", icon: "database", url: "sqlite:///data/reports.db" },
  { key: "http", title: "نظام مستقل (REST)", detail: "اتصال مباشر بواجهة نظام داخلي", icon: "globe", url: "https://hr.internal/api/v1" },
  { key: "search", title: "محرك بحث", detail: "SearxNG أو أي بحث يعيد JSON", icon: "search", url: "http://searx.local/search" },
  { key: "mcp", title: "خادم MCP", detail: "أدوات نظام عبر Model Context Protocol (HTTP)", icon: "chip", url: "https://mcp.internal/mcp" },
];
const isDb = (k: Kind) => k === "postgres" || k === "mysql" || k === "sqlite";

type Data = NonNullable<ReturnType<typeof useQuery<typeof api.dataSources.list>>>;
type Source = Data["sources"][number];

export function SourcesView({ spaces }: { spaces: SpaceInfo[] }) {
  const data = useQuery(api.dataSources.list);
  const [editing, setEditing] = useState<Source | "new" | null>(null);
  const [error, setError] = useState("");

  if (editing) return <SourceForm key={editing === "new" ? "new" : editing._id} source={editing === "new" ? null : editing} spaces={spaces} onDone={() => setEditing(null)} />;
  return (
    <div>
      <PageHeader
        title="مصادر البيانات"
        subtitle="أنظمة وقواعد بيانات يقرأ منها المساعد بيانات حيّة، للقراءة فقط. يصل إليها الموظف إن كانت متاحة له وسمح بها مستواه، ويُسجَّل كل استعلام في سجل التدقيق."
        actions={
          <button className="btn-primary" onClick={() => setEditing("new")}>
            <Icon name="plus" /> مصدر جديد
          </button>
        }
      />
      {error && <p className="alert-negative mb-4">{error}</p>}
      {data === undefined ? (
        <p className="text-sm text-muted">جارٍ التحميل…</p>
      ) : data.sources.length === 0 ? (
        <EmptyState icon="database" title="لا مصادر بعد" action={<button className="btn-primary" onClick={() => setEditing("new")}>اربط أول مصدر</button>}>
          اربط قاعدة بيانات الموارد البشرية أو نظام المالية أو محرك بحث داخلي، ليجيب المساعد منها مباشرة.
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {data.sources.map((s) => (
            <SourceRow key={s._id} s={s} spaces={spaces} onEdit={() => setEditing(s)} onError={setError} />
          ))}
        </ul>
      )}
      <div className="mt-6 rounded-lg bg-sunken p-4 text-xs leading-6 text-muted">
        <p className="font-medium text-ink">كيف يبقى آمناً</p>
        <ul className="mt-1 list-disc ps-5">
          <li>قواعد البيانات: استعلام SELECT واحد فقط داخل معاملة للقراءة فقط وبمهلة 15 ثانية وعدد صفوف محدود. استخدم حساباً بصلاحية قراءة فقط أيضاً.</li>
          <li>الأنظمة: طلبات GET فقط تحت العنوان والمسارات التي تحددها.</li>
          <li>كلمات المرور والمفاتيح تبقى في الخادم، لا يراها الموظف ولا النموذج.</li>
        </ul>
      </div>
    </div>
  );
}

function SourceRow({ s, spaces, onEdit, onError }: { s: Source; spaces: SpaceInfo[]; onEdit: () => void; onError: (e: string) => void }) {
  const check = useAction(api.dataSources.check);
  const remove = useMutation(api.dataSources.remove);
  const [busy, setBusy] = useState(false);
  const kind = KINDS.find((k) => k.key === s.kind)!;
  const who = s.visibility.kind === "workspace" ? "كل مساحة العمل" : s.visibility.spaceIds.map((id) => spaces.find((x) => x._id === id)?.name ?? "مساحة").join("، ");
  const run = async (fn: () => Promise<unknown>) => {
    onError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="card flex flex-wrap items-start gap-x-4 gap-y-2 p-4">
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${s.enabled ? "bg-active" : "bg-sunken text-faint"}`}>
        <Icon name={kind.icon} size={16} />
      </span>
      <div className="min-w-56 flex-1">
        <p className="flex flex-wrap items-center gap-1.5 font-medium">
          {s.name} <span className="badge">{kind.title}</span>
          {!s.enabled && <span className="badge">معطّل</span>}
        </p>
        <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted">{s.description}</p>
        <p className="mt-1 text-xs text-muted">
          لمن: {who} · المستويات: {s.levels.length ? s.levels.join("، ") : "لا مستوى يسمح به"}
        </p>
        <p className="mt-0.5 text-xs">
          {!s.lastCheck ? (
            <span className="text-muted">لم يُفحص بعد</span>
          ) : s.lastCheck.ok ? (
            <span className="text-positive">متصل · {formatDate(s.lastCheck.at)}</span>
          ) : (
            <span className="text-negative">
              {s.lastCheck.error} · {formatDate(s.lastCheck.at)}
            </span>
          )}
        </p>
      </div>
      <button className="btn-secondary h-8 text-xs" disabled={busy} onClick={() => void run(() => check({ sourceId: s._id }))}>
        {busy ? "يفحص…" : "افحص الاتصال"}
      </button>
      <Menu
        label={`خيارات ${s.name}`}
        items={[
          { label: "تعديل", icon: "pencil", onSelect: onEdit },
          "divider",
          {
            label: "حذف",
            icon: "x",
            danger: true,
            onSelect: () =>
              void ask(`حذف المصدر «${s.name}»؟ لن يصل إليه المساعد بعد الآن.`, { danger: true, confirmLabel: "حذف" }).then((ok) => {
                if (ok) void run(() => remove({ sourceId: s._id }));
              }),
          },
        ]}
      />
    </li>
  );
}

function SourceForm({ source, spaces, onDone }: { source: Source | null; spaces: SpaceInfo[]; onDone: () => void }) {
  const save = useMutation(api.dataSources.save);
  const check = useAction(api.dataSources.check);
  const shared = spaces.filter((s) => s.kind === "shared");
  const [f, setF] = useState({
    kind: (source?.kind ?? "postgres") as Kind,
    name: source?.name ?? "",
    description: source?.description ?? "",
    url: "",
    headerName: source?.headerName ?? "",
    headerValue: "",
    clearHeader: false,
    paths: (source?.paths ?? []).join("\n"),
    tools: source?.tools ?? ([] as string[]),
    schemaHint: source?.schemaHint ?? "",
    rowLimit: source?.rowLimit ?? 100,
    visibility: (source?.visibility ?? { kind: "workspace", spaceIds: [] }) as { kind: "workspace" | "spaces"; spaceIds: string[] },
    enabled: source?.enabled ?? true,
  });
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedId, setSavedId] = useState<string | undefined>(source?._id);
  // MCP: the server's tools, from the last check (or the ones already allowed).
  const [available, setAvailable] = useState<string[]>(() => [...new Set([...(source?.tools ?? []), ...(source?.kind === "mcp" ? (source.schemaHint.match(/^[^\s:]+(?=:)/gm) ?? []) : [])])]);
  const kind = KINDS.find((k) => k.key === f.kind)!;
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const submit = async (andCheck: boolean) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const id = (await save({
        sourceId: savedId,
        name: f.name,
        kind: f.kind,
        description: f.description,
        url: f.url || undefined,
        headerName: f.headerName || undefined,
        headerValue: f.headerValue || undefined,
        clearHeader: f.clearHeader,
        paths: f.paths.split(/\n|,/).map((p) => p.trim()).filter(Boolean),
        tools: f.tools,
        schemaHint: f.schemaHint,
        rowLimit: Number(f.rowLimit),
        visibility: f.visibility as any,
        enabled: f.enabled,
      })) as string;
      if (!andCheck) return onDone();
      const r = await check({ sourceId: id });
      if (!r.ok) setError(`حُفظ، لكن الاتصال فشل: ${r.error}`);
      else if (f.kind === "mcp" && r.tools && !f.tools.length) {
        setSavedId(id);
        setAvailable(r.tools);
        if (!f.schemaHint.trim() && r.schemaHint) set("schemaHint", r.schemaHint);
        setNote(`متصل: ${r.tools.length} أداة. اختر ما يُسمح للمساعد باستدعائه، ثم احفظ.`);
      } else {
        if (!f.schemaHint.trim() && r.schemaHint) set("schemaHint", r.schemaHint);
        setNote("حُفظ والاتصال يعمل.");
        setTimeout(onDone, 700);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button className="btn-ghost mb-3 h-8 px-2 text-sm" onClick={onDone}>
        <Icon name="next" size={14} /> مصادر البيانات
      </button>
      <h1 className="page-title mb-5">{source ? source.name : "مصدر بيانات جديد"}</h1>
      <form
        className="card space-y-6 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(true);
        }}
      >
        <fieldset>
          <legend className="mb-2 font-medium">النوع</legend>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {KINDS.map((k) => (
              <button type="button" key={k.key} onClick={() => set("kind", k.key)} className={`flex items-start gap-3 rounded-lg border p-3 text-start ${f.kind === k.key ? "border-primary bg-primary-soft" : "border-line hover:border-control"}`} aria-pressed={f.kind === k.key}>
                <Icon name={k.icon} className={`mt-0.5 ${f.kind === k.key ? "text-primary" : "text-muted"}`} />
                <span>
                  <span className="block text-sm font-medium">{k.title}</span>
                  <span className="block text-xs text-muted">{k.detail}</span>
                </span>
              </button>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="label">الاسم</span>
            <input className="input w-full" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="نظام الموارد البشرية" required />
          </label>
          <label className="block text-sm">
            <span className="label">أقصى عدد للصفوف في كل استعلام</span>
            <input className="input w-full num" type="number" min={1} max={1000} value={f.rowLimit} onChange={(e) => set("rowLimit", Number(e.target.value))} />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="label">ماذا يحوي ومتى يُستخدم</span>
            <textarea className="textarea w-full" rows={2} value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="بيانات الموظفين: الأقسام، والإجازات وأرصدتها، وتواريخ التعيين. للأسئلة عن رصيد إجازة أو عدد موظفي قسم." required />
            <span className="mt-1 block text-xs text-faint">يقرؤه المساعد ليعرف متى يرجع إلى هذا المصدر.</span>
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="label">{isDb(f.kind) ? "نص الاتصال" : "العنوان"} {source && <span className="text-xs text-muted">(الحالي: <span dir="ltr">{source.url}</span>؛ اتركه فارغاً لإبقائه)</span>}</span>
            <input className="input w-full" dir="ltr" type={isDb(f.kind) && f.kind !== "sqlite" ? "password" : "text"} autoComplete="off" value={f.url} onChange={(e) => set("url", e.target.value)} placeholder={kind.url} required={!source} />
            {isDb(f.kind) && f.kind !== "sqlite" && <span className="mt-1 block text-xs text-faint">استخدم مستخدماً بصلاحية قراءة فقط. يُحفظ في الخادم ولا يظهر بعد الحفظ.</span>}
            {f.kind === "search" && <span className="mt-1 block text-xs text-faint">يُضاف ?q=…&amp;format=json تلقائياً، أو ضع {"{q}"} في العنوان مكان نص البحث.</span>}
          </label>
          {!isDb(f.kind) && (
            <>
              <label className="block text-sm">
                <span className="label">ترويسة المصادقة (اختياري)</span>
                <input className="input w-full" dir="ltr" value={f.headerName} onChange={(e) => set("headerName", e.target.value)} placeholder="Authorization" />
              </label>
              <label className="block text-sm">
                <span className="label">قيمتها {source?.hasHeader && <span className="text-xs text-muted">(محفوظة)</span>}</span>
                <input className="input w-full" dir="ltr" type="password" autoComplete="off" value={f.headerValue} onChange={(e) => set("headerValue", e.target.value)} placeholder={source?.hasHeader ? "••••••••" : "Bearer …"} />
                {source?.hasHeader && (
                  <label className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
                    <input type="checkbox" checked={f.clearHeader} onChange={(e) => set("clearHeader", e.target.checked)} /> احذف القيمة المحفوظة
                  </label>
                )}
              </label>
            </>
          )}
          {f.kind === "mcp" && (
            <fieldset className="block text-sm sm:col-span-2">
              <legend className="label">الأدوات المسموحة</legend>
              {available.length ? (
                <div className="grid gap-1 rounded-lg border border-line p-2 sm:grid-cols-2">
                  {available.map((t) => (
                    <label key={t} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-active">
                      <input type="checkbox" checked={f.tools.includes(t)} onChange={(e) => set("tools", e.target.checked ? [...f.tools, t] : f.tools.filter((x) => x !== t))} />
                      <code className="text-xs" dir="ltr">
                        {t}
                      </code>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted">افحص الاتصال لعرض أدوات الخادم.</p>
              )}
              <span className="mt-1 block text-xs text-faint">لا يضمن MCP أن الأداة للقراءة فقط: اختر الأدوات التي تقرأ فقط. ما لا تختاره لا يُستدعى.</span>
            </fieldset>
          )}
          {f.kind === "http" && (
            <label className="block text-sm sm:col-span-2">
              <span className="label">المسارات المسموحة (سطر لكل مسار؛ فارغ = كل ما تحت العنوان)</span>
              <textarea className="textarea w-full" dir="ltr" rows={2} value={f.paths} onChange={(e) => set("paths", e.target.value)} placeholder={"employees\nleave-balances"} />
            </label>
          )}
          <label className="block text-sm sm:col-span-2">
            <span className="label">{isDb(f.kind) ? "الجداول والأعمدة" : f.kind === "http" ? "نقاط الواجهة ومعناها" : f.kind === "mcp" ? "الأدوات ووصفها" : "ملاحظات للمساعد"}</span>
            <textarea className="textarea w-full font-mono text-xs" dir="ltr" rows={5} value={f.schemaHint} onChange={(e) => set("schemaHint", e.target.value)} placeholder={isDb(f.kind) ? "تُملأ تلقائياً عند فحص الاتصال. احذف ما لا يلزم، وأضف شرحاً للأعمدة الغامضة." : "GET employees/{id} → بيانات الموظف\nGET leave-balances?employee={id} → رصيد الإجازات"} />
            <span className="mt-1 block text-xs text-faint">يراه المساعد ليكتب استعلاماً صحيحاً. لا تضع فيه كلمات مرور.</span>
          </label>
        </div>

        <fieldset>
          <legend className="mb-2 font-medium">لمن</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                ["workspace", "كل مساحة العمل", "كل موظف يسمح مستواه بهذا المصدر"],
                ["spaces", "أعضاء مساحات محددة", "مثل فريق الموارد البشرية وحده"],
              ] as const
            ).map(([k, t, d]) => (
              <button type="button" key={k} onClick={() => set("visibility", { kind: k, spaceIds: f.visibility.spaceIds })} aria-pressed={f.visibility.kind === k} className={`rounded-lg border p-3 text-start ${f.visibility.kind === k ? "border-primary bg-primary-soft" : "border-line hover:border-control"}`}>
                <span className="block text-sm font-medium">{t}</span>
                <span className="block text-xs text-muted">{d}</span>
              </button>
            ))}
          </div>
          {f.visibility.kind === "spaces" && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {shared.map((s) => {
                const on = f.visibility.spaceIds.includes(s._id);
                return (
                  <button type="button" key={s._id} aria-pressed={on} onClick={() => set("visibility", { kind: "spaces", spaceIds: on ? f.visibility.spaceIds.filter((x) => x !== s._id) : [...f.visibility.spaceIds, s._id] })} className={`h-8 rounded-full border px-3 text-xs ${on ? "border-primary bg-primary-soft text-primary" : "border-line"}`}>
                    {s.name}
                  </button>
                );
              })}
              {shared.length === 0 && <span className="text-xs text-muted">لست عضواً في أي مساحة مشتركة.</span>}
            </div>
          )}
          <p className="mt-2 text-xs text-muted">والمستويات تحدد أيضاً من يصل إليه: من صفحة «المستويات».</p>
        </fieldset>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.enabled} onChange={(e) => set("enabled", e.target.checked)} /> مفعّل
        </label>

        {error && <p className="text-sm text-negative">{error}</p>}
        {note && <p className="text-sm text-positive">{note}</p>}
        <div className="flex flex-wrap justify-end gap-2 border-t border-rule pt-4">
          <button type="button" className="btn-ghost" onClick={onDone}>
            إلغاء
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void submit(false)}>
            احفظ فقط
          </button>
          <button className="btn-primary" disabled={busy}>
            {busy ? "يحفظ ويفحص…" : "احفظ وافحص الاتصال"}
          </button>
        </div>
      </form>
    </div>
  );
}
