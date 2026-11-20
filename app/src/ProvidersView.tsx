// «مزوّدو النماذج» (admin console): the model servers, and which model plays each role.
// Backend: onebase/providers.ts. API keys are write-only: the page shows only whether one is set.

import { useState } from "react";
import { useAction, useMutation, useQuery } from "onebase/react";
import { api, errorText, formatDate } from "./lib";
import { Icon } from "./icons";
import { ask, EmptyState, Menu, PageHeader, tell } from "./ui";

type Role = "main" | "fast" | "vision" | "decide";
const ROLES: { key: Role; title: string; detail: string }[] = [
  { key: "main", title: "النموذج الرئيس", detail: "المحادثة والأدوات والتحليل" },
  { key: "fast", title: "النموذج السريع", detail: "العناوين واختيار الوكيل ومستوى «أساسي»" },
  { key: "vision", title: "نموذج الرؤية", detail: "قراءة الصور والملفات الممسوحة" },
  { key: "decide", title: "نموذج القرار", detail: "قرارات صغيرة قبل الإجابة وبعدها. اختر نموذجاً صغيراً سريعاً" },
];
/** Models that can't chat, by their usual names: shown with a tag and not offered for a role. */
function special(model: string): string | null {
  const m = model.toLowerCase();
  if (/embed|bge-|e5-|gte-|nomic-embed/.test(m)) return "تضمين";
  if (/rerank/.test(m)) return "ترتيب";
  if (/tts|whisper|speech|audio|phonon/.test(m)) return "صوت";
  if (/ltx|diffusion|sdxl|flux/.test(m)) return "صور/فيديو";
  return null;
}

const PRESETS = [
  { label: "llama.cpp / vLLM", url: "http://localhost:8000/v1" },
  { label: "Ollama", url: "http://localhost:11434/v1" },
  { label: "OpenAI متوافق", url: "https://api.example.com/v1" },
];

type Data = NonNullable<ReturnType<typeof useQuery<typeof api.providers.list>>>;
type Provider = Data["providers"][number];

export function ProvidersView() {
  const data = useQuery(api.providers.list);
  const [editing, setEditing] = useState<Provider | "new" | null>(null);
  const [error, setError] = useState("");

  return (
    <div>
      <PageHeader
        title="مزوّدو النماذج"
        subtitle="خوادم النماذج التي تعمل عليها المنصة (أي خادم متوافق مع OpenAI: llama.cpp أو vLLM أو Ollama أو خدمة مستضافة)، وأي نموذج يؤدي كل دور. ما لم تختره يبقى على إعدادات الخادم."
        actions={
          editing === null && (
            <button className="btn-primary" onClick={() => setEditing("new")}>
              <Icon name="plus" /> مزوّد جديد
            </button>
          )
        }
      />
      {error && <p className="alert-negative mb-4">{error}</p>}
      {data === undefined ? (
        <p className="text-sm text-muted">جارٍ التحميل…</p>
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="section-title mb-3">الأدوار</h2>
            <div className="grid gap-3 @2xl:grid-cols-2 @5xl:grid-cols-4">
              {ROLES.map((r) => (
                <RoleCard key={r.key} role={r} data={data} onError={setError} />
              ))}
              <EmbedCard data={data} onError={setError} />
            </div>
            {data.embed.mismatch && <ReindexBanner indexedWith={data.embed.indexedWith} onError={setError} />}
          </section>

          <Decisions data={data} onError={setError} />

          <section>
            <h2 className="section-title mb-3">المزوّدون</h2>
            {editing && <ProviderForm key={editing === "new" ? "new" : editing._id} provider={editing === "new" ? null : editing} onDone={() => setEditing(null)} />}
            {data.providers.length === 0 && !editing ? (
              <EmptyState icon="chip" title="لا مزوّدين مضافين" action={<button className="btn-primary" onClick={() => setEditing("new")}>أضف مزوّداً</button>}>
                تعمل المنصة الآن بالنماذج المضبوطة في إعدادات الخادم.
              </EmptyState>
            ) : (
              <ul className="space-y-2">
                {data.providers.map((p) => (
                  <ProviderRow key={p._id} p={p} roles={data.roles} data={data} onEdit={() => setEditing(p)} onError={setError} />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

const DECISIONS: { key: "route" | "cite" | "guard"; title: string; detail: string }[] = [
  { key: "route", title: "توجيه الطلب", detail: "هل يحتاج الطلب البحث في الملفات، وبأي سؤال بحث. عند الإيقاف: القاعدة الثابتة." },
  { key: "cite", title: "فحص الاستشهادات", detail: "بعد الإجابة: هل يذكر المقطع المستشهد به ما قيل؟ يضع علامة على الاستشهاد المشكوك فيه ولا يغيّر النص." },
  { key: "guard", title: "فحص النص الخارجي", detail: "المهارات المستوردة والملفات المرفوعة وردود النماذج العامة: ينبّه إن وُجد نص موجّه للمساعد، ولا يمنع شيئاً." },
];

/** plans/12: each decision can be turned off, which returns it to the code it replaced. */
function Decisions({ data, onError }: { data: Data; onError: (e: string) => void }) {
  const setDecision = useMutation(api.providers.setDecision);
  return (
    <section>
      <h2 className="section-title mb-1">قرارات نموذج القرار</h2>
      <p className="mb-3 text-xs text-muted">قرارات صغيرة يتخذها نموذج القرار بدل قواعد ثابتة. لا تمنح صلاحية أبداً: إن تأخر النموذج أو أخطأ عاد القرار إلى القاعدة.</p>
      <ul className="card divide-y divide-rule">
        {DECISIONS.map((d) => (
          <li key={d.key} className="flex items-start gap-3 px-4 py-3 text-sm">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{d.title}</p>
              <p className="text-xs text-muted">{d.detail}</p>
            </div>
            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={data.decisions[d.key]}
                onChange={(e) => {
                  onError("");
                  setDecision({ kind: d.key, on: e.target.checked }).catch((x) => onError(errorText(x)));
                }}
              />
              {data.decisions[d.key] ? "يعمل" : "متوقف"}
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RoleCard({ role, data, onError }: { role: (typeof ROLES)[number]; data: Data; onError: (e: string) => void }) {
  const setRole = useMutation(api.providers.setRole);
  const cur = data.roles[role.key];
  const env = data.env[role.key];
  const [providerId, setProviderId] = useState<string>(cur?.providerId ?? "");
  const [model, setModel] = useState(cur?.model ?? "");
  const [open, setOpen] = useState(false);
  const p = data.providers.find((x) => x._id === (open ? providerId : cur?.providerId));
  const save = async () => {
    onError("");
    try {
      await setRole({ role: role.key, providerId: providerId || null, model: providerId ? model : undefined });
      setOpen(false);
    } catch (e) {
      onError(errorText(e));
    }
  };
  return (
    <div className="card p-4">
      <p className="font-medium">{role.title}</p>
      <p className="text-xs text-muted">{role.detail}</p>
      {!open ? (
        <>
          <p className="mt-3 truncate text-sm" dir="auto">
            {cur && p ? (
              <>
                <span className="font-medium">{cur.model}</span> <span className="text-muted">· {p.name}</span>
              </>
            ) : role.key === "decide" && data.decideFollowsFast ? (
              <span className="text-muted">مثل النموذج السريع</span>
            ) : env.configured ? (
              <>
                <span className="font-medium" dir="ltr">
                  {env.model}
                </span>{" "}
                <span className="text-muted">· إعدادات الخادم</span>
              </>
            ) : (
              <span className="text-negative">غير مضبوط</span>
            )}
          </p>
          <button
            className="btn-ghost mt-2 h-8 px-2 text-xs"
            onClick={() => {
              setProviderId(cur?.providerId ?? "");
              setModel(cur?.model ?? "");
              setOpen(true);
            }}
          >
            غيّر
          </button>
        </>
      ) : (
        <div className="mt-3 space-y-2">
          <select className="input w-full text-sm" value={providerId} onChange={(e) => (setProviderId(e.target.value), setModel(""))}>
            <option value="">إعدادات الخادم{env.configured ? ` (${env.model})` : ""}</option>
            {data.providers
              .filter((x) => x.enabled)
              .map((x) => (
                <option key={x._id} value={x._id}>
                  {x.name}
                </option>
              ))}
          </select>
          {providerId &&
            (p?.models.length ? (
              <select className="input w-full text-sm" dir="ltr" value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">اختر نموذجاً…</option>
                {p.models
                  .filter((m) => !special(m))
                  .map((m) => (
                    <option key={m}>{m}</option>
                  ))}
              </select>
            ) : (
              <input className="input w-full text-sm" dir="ltr" placeholder="اسم النموذج (افحص المزوّد لعرض قائمته)" value={model} onChange={(e) => setModel(e.target.value)} />
            ))}
          <div className="flex gap-2">
            <button className="btn-primary h-8 text-xs" disabled={!!providerId && !model.trim()} onClick={() => void save()}>
              احفظ
            </button>
            <button className="btn-ghost h-8 text-xs" onClick={() => setOpen(false)}>
              إلغاء
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProviderRow({ p, roles: roles_, data: data_, onEdit, onError }: { p: Provider; roles: Data["roles"]; data: Data; onEdit: () => void; onError: (e: string) => void }) {
  const check = useAction(api.providers.check);
  const save = useMutation(api.providers.save);
  const remove = useMutation(api.providers.remove);
  const setRole = useMutation(api.providers.setRole);
  const setEmbedding = useAction(api.providers.setEmbedding);
  const [busy, setBusy] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [filter, setFilter] = useState("");
  const used = ROLES.filter((r) => roles_[r.key]?.providerId === p._id).map((r) => r.title);
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
    <li className="card p-4">
     <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${p.enabled ? "bg-active" : "bg-sunken text-faint"}`}>
        <Icon name="chip" size={16} />
      </span>
      <div className="min-w-56 flex-1">
        <p className="flex flex-wrap items-center gap-1.5 font-medium">
          {p.name}
          {!p.enabled && <span className="badge">معطّل</span>}
          {used.map((u) => (
            <span key={u} className="badge-primary">
              {u}
            </span>
          ))}
        </p>
        <p className="truncate text-xs text-muted" dir="ltr">
          {p.baseUrl}
          {p.hasKey ? " · 🔑" : ""}
        </p>
        <p className="mt-0.5 text-xs">
          {!p.lastCheck ? (
            <span className="text-muted">لم يُفحص بعد</span>
          ) : p.lastCheck.ok ? (
            <span className="text-positive">
              يعمل · {formatDate(p.lastCheck.at)}
            </span>
          ) : (
            <span className="text-negative">
              {p.lastCheck.error} · {formatDate(p.lastCheck.at)}
            </span>
          )}
        </p>
      </div>
      {p.models.length > 0 && (
        <button className="btn-ghost h-8 text-xs" aria-expanded={showModels} onClick={() => setShowModels(!showModels)}>
          النماذج <span className="num">{p.models.length}</span> <Icon name={showModels ? "up" : "down"} size={14} />
        </button>
      )}
      <button className="btn-secondary h-8 text-xs" disabled={busy} onClick={() => void run(() => check({ providerId: p._id }))}>
        {busy ? "يفحص…" : "افحص"}
      </button>
      <Menu
        label={`خيارات ${p.name}`}
        items={[
          { label: "تعديل", icon: "pencil", onSelect: onEdit },
          { label: p.enabled ? "تعطيل" : "تفعيل", icon: p.enabled ? "pause" : "play", onSelect: () => void run(() => save({ providerId: p._id, name: p.name, baseUrl: p.baseUrl, enabled: !p.enabled })) },
          "divider",
          {
            label: "حذف",
            icon: "x",
            danger: true,
            onSelect: () =>
              void ask(`حذف المزوّد «${p.name}»؟`, { danger: true, confirmLabel: "حذف" }).then((ok) => {
                if (ok) void run(() => remove({ providerId: p._id }));
              }),
          },
        ]}
      />
     </div>
      {showModels && (
        <div className="mt-3 border-t border-rule pt-3">
          {p.models.length > 8 && <input className="input mb-2 h-8 w-full max-w-xs text-sm" dir="ltr" placeholder="ابحث في النماذج…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
          <ul className="grid gap-1 @2xl:grid-cols-2">
            {p.models
              .filter((m) => !filter || m.toLowerCase().includes(filter.toLowerCase()))
              .map((m) => {
                const roles = ROLES.filter((r) => roles_[r.key]?.providerId === p._id && roles_[r.key]?.model === m);
                return (
                  <li key={m} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-active">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" dir="ltr" title={m}>
                      {m}
                    </span>
                    {roles.map((r) => (
                      <span key={r.key} className="badge-primary">
                        {r.title.replace("النموذج ", "").replace("نموذج ", "")}
                      </span>
                    ))}
                    {data_.embed.choice?.providerId === p._id && data_.embed.choice.model === m && <span className="badge-primary">التضمين</span>}
                    {special(m) && <span className="badge">{special(m)}</span>}
                    {p.enabled && special(m) === "تضمين" && (
                      <Menu
                        label={`استخدم ${m}`}
                        items={[
                          {
                            label: "استخدمه للتضمين (البحث في الملفات)",
                            icon: "check" as const,
                            disabled: data_.embed.choice?.providerId === p._id && data_.embed.choice.model === m,
                            onSelect: () =>
                              void run(async () => {
                                const r = await setEmbedding({ providerId: p._id, model: m });
                                if (r.needsReindex) await tell("تغيّر نموذج التضمين", "البحث في الملفات متوقف حتى تعيد الفهرسة: اضغط «أعد الفهرسة» أعلى الصفحة.");
                              }),
                          },
                        ]}
                      />
                    )}
                    {p.enabled && !special(m) && (
                      <Menu
                        label={`استخدم ${m}`}
                        items={ROLES.map((r) => ({
                          label: `استخدمه كـ${r.title}`,
                          icon: "check" as const,
                          disabled: roles.some((x) => x.key === r.key),
                          onSelect: () => void run(() => setRole({ role: r.key, providerId: p._id, model: m })),
                        }))}
                      />
                    )}
                  </li>
                );
              })}
          </ul>
        </div>
      )}
    </li>
  );
}

function ProviderForm({ provider, onDone }: { provider: Provider | null; onDone: () => void }) {
  const save = useMutation(api.providers.save);
  const check = useAction(api.providers.check);
  const [form, setForm] = useState({ name: provider?.name ?? "", baseUrl: provider?.baseUrl ?? "", apiKey: "", clearKey: false });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const id = (await save({ providerId: provider?._id, name: form.name, baseUrl: form.baseUrl, apiKey: form.apiKey || undefined, clearKey: form.clearKey, enabled: provider?.enabled ?? true })) as string;
      const r = await check({ providerId: id });
      if (!r.ok) setError(`حُفظ، لكن الفحص فشل: ${r.error}`);
      else onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="card mb-4 space-y-4 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="font-medium">{provider ? `تعديل «${provider.name}»` : "مزوّد جديد"}</p>
      {!provider && (
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button type="button" key={p.label} className="h-7 rounded-full border border-line px-3 text-xs hover:border-control" onClick={() => setForm((f) => ({ ...f, name: f.name || p.label, baseUrl: p.url }))}>
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="label">الاسم</span>
          <input className="input w-full" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="خادم النماذج الداخلي" required />
        </label>
        <label className="block text-sm">
          <span className="label">العنوان</span>
          <input className="input w-full" dir="ltr" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="http://10.0.0.5:8000/v1" required />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="label">مفتاح API {provider?.hasKey && <span className="text-xs text-muted">(محفوظ؛ اتركه فارغاً لإبقائه)</span>}</span>
          <input className="input w-full" dir="ltr" type="password" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={provider?.hasKey ? "••••••••" : "اختياري"} />
          {provider?.hasKey && (
            <label className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={form.clearKey} onChange={(e) => setForm({ ...form, clearKey: e.target.checked })} /> احذف المفتاح المحفوظ
            </label>
          )}
          <span className="mt-1 block text-xs text-faint">يُحفظ في الخادم لاتصالاته فقط، ولا يظهر بعد الحفظ لأحد.</span>
        </label>
      </div>
      {error && <p className="text-sm text-negative">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onDone}>
          {error.startsWith("حُفظ") ? "إغلاق" : "إلغاء"}
        </button>
        <button className="btn-primary" disabled={busy}>
          {busy ? "يحفظ ويفحص…" : "احفظ وافحص"}
        </button>
      </div>
    </form>
  );
}

function EmbedCard({ data, onError }: { data: Data; onError: (e: string) => void }) {
  const setEmbedding = useAction(api.providers.setEmbedding);
  const cur = data.embed.choice;
  const p = cur ? data.providers.find((x) => x._id === cur.providerId) : null;
  const [open, setOpen] = useState(false);
  const [providerId, setProviderId] = useState<string>(cur?.providerId ?? "");
  const [model, setModel] = useState(cur?.model ?? "");
  const [busy, setBusy] = useState(false);
  const chosen = data.providers.find((x) => x._id === providerId);
  const embedModels = chosen ? chosen.models.filter((m) => special(m) === "تضمين") : [];
  const save = async () => {
    onError("");
    setBusy(true);
    try {
      const r = await setEmbedding({ providerId: providerId || null, model: providerId ? model : undefined });
      setOpen(false);
      if (r.needsReindex) await tell("تغيّر نموذج التضمين", "البحث في الملفات متوقف حتى تعيد الفهرسة: اضغط «أعد الفهرسة» أعلى الصفحة.");
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card p-4">
      <p className="font-medium">نموذج التضمين</p>
      <p className="text-xs text-muted">البحث في الملفات · <span className="num">{data.embed.dimensions}</span> بُعداً</p>
      {!open ? (
        <>
          <p className="mt-3 truncate text-sm" dir="auto">
            {cur && p ? (
              <>
                <span className="font-medium">{cur.model}</span> <span className="text-muted">· {p.name}</span>
              </>
            ) : data.embed.env.configured ? (
              <>
                <span className="font-medium" dir="ltr">
                  {data.embed.env.model}
                </span>{" "}
                <span className="text-muted">· إعدادات الخادم</span>
              </>
            ) : (
              <span className="text-negative">غير مضبوط: البحث في الملفات متوقف</span>
            )}
          </p>
          <button
            className="btn-ghost mt-2 h-8 px-2 text-xs"
            onClick={() => {
              setProviderId(cur?.providerId ?? "");
              setModel(cur?.model ?? "");
              setOpen(true);
            }}
          >
            غيّر
          </button>
        </>
      ) : (
        <div className="mt-3 space-y-2">
          <select className="input w-full text-sm" value={providerId} onChange={(e) => (setProviderId(e.target.value), setModel(""))}>
            <option value="">إعدادات الخادم{data.embed.env.configured ? ` (${data.embed.env.model})` : ""}</option>
            {data.providers
              .filter((x) => x.enabled)
              .map((x) => (
                <option key={x._id} value={x._id}>
                  {x.name}
                </option>
              ))}
          </select>
          {providerId &&
            (embedModels.length ? (
              <select className="input w-full text-sm" dir="ltr" value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">اختر نموذج تضمين…</option>
                {embedModels.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input className="input w-full text-sm" dir="ltr" placeholder="اسم نموذج التضمين" value={model} onChange={(e) => setModel(e.target.value)} />
            ))}
          <p className="text-[11px] leading-4 text-muted">يُجرَّب النموذج قبل الحفظ: يجب أن يعطي {data.embed.dimensions} بُعداً. وتغييره يتطلب إعادة الفهرسة.</p>
          <div className="flex gap-2">
            <button className="btn-primary h-8 text-xs" disabled={busy || (!!providerId && !model.trim())} onClick={() => void save()}>
              {busy ? "يجرّب…" : "جرّب واحفظ"}
            </button>
            <button className="btn-ghost h-8 text-xs" onClick={() => setOpen(false)}>
              إلغاء
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReindexBanner({ indexedWith, onError }: { indexedWith: string | null; onError: (e: string) => void }) {
  const reindex = useMutation(api.providers.reindex);
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm">
      <span className="min-w-0 flex-1">
        <span className="font-medium">الفهرس مبني بنموذج آخر{indexedWith ? ` (${indexedWith})` : ""}.</span> البحث في الملفات وفهرسة الجديد متوقفان حتى تعيد فهرسة كل الملفات بالنموذج الحالي.
      </span>
      <button
        className="btn-primary h-8 text-xs"
        disabled={busy}
        onClick={() =>
          void ask("إعادة فهرسة كل الملفات بنموذج التضمين الحالي؟ قد تستغرق وقتاً، ويعود البحث لكل ملف حين تنتهي فهرسته.", { confirmLabel: "أعد الفهرسة" }).then(async (ok) => {
            if (!ok) return;
            setBusy(true);
            try {
              const n = await reindex({});
              await tell("بدأت إعادة الفهرسة", `${n} ملفاً في الطابور.`);
            } catch (e) {
              onError(errorText(e));
            } finally {
              setBusy(false);
            }
          })
        }
      >
        {busy ? "يبدأ…" : "أعد الفهرسة"}
      </button>
    </div>
  );
}
