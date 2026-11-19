// «ذاكرتي» (plans/09): what the assistant remembers about me, mine alone. I can add, edit and
// forget anything, accept or dismiss what it suggests, and wipe it all. Backend: onebase/memory.ts.

import { useState } from "react";
import { useMutation, useQuery } from "onebase/react";
import { api, errorText } from "./lib";
import { Icon } from "./icons";
import { relTime } from "./ChatView";
import { ask, askText, EmptyState, Menu, PageHeader, tell } from "./ui";

type Kind = "fact" | "preference" | "decision" | "term";
export const MEMORY_KINDS: { key: Kind; label: string }[] = [
  { key: "fact", label: "معلومة" },
  { key: "preference", label: "تفضيل" },
  { key: "decision", label: "قرار" },
  { key: "term", label: "مصطلح" },
];
const kindLabel = (k: string) => MEMORY_KINDS.find((x) => x.key === k)?.label ?? "معلومة";

export function MemoryView() {
  const data = useQuery(api.memory.mine);
  const add = useMutation(api.memory.add);
  const update = useMutation(api.memory.update);
  const remove = useMutation(api.memory.remove);
  const review = useMutation(api.memory.review);
  const clear = useMutation(api.memory.clearMine);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<Kind>("preference");
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  if (data === undefined) return <p className="text-sm text-muted">جارٍ التحميل…</p>;
  const run = (p: Promise<unknown>) => p.catch((e) => void tell(errorText(e)));
  const items = q.trim() ? data.items.filter((m) => m.text.includes(q.trim())) : data.items;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="ذاكرتي"
        subtitle="ما يتذكّره المساعد عنك وعن طريقة عملك، ليخصّص إجاباته دون أن تعيد الشرح كل مرة. لك وحدك: لا يراها أحد غيرك، ولا مدير المنصة."
        actions={
          data.items.length + data.suggestions.length > 0 && (
            <Menu
              label="خيارات الذاكرة"
              items={[
                {
                  label: "امسح الذاكرة كلها",
                  icon: "x",
                  danger: true,
                  onSelect: () =>
                    void ask("مسح كل ما يتذكّره المساعد عنك؟ لا يمكن التراجع.", { danger: true, confirmLabel: "امسح" }).then((ok) => {
                      if (ok) void run(clear({}));
                    }),
                },
              ]}
            />
          )
        }
      />

      {!data.enabled && <p className="alert-warning mb-4 text-sm">الذاكرة غير مفعّلة في مستواك: المساعد لا يقرأ هذه القائمة ولا يضيف إليها. تبقى محفوظة هنا، ويمكنك حذفها.</p>}

      <form
        className="card mb-5 flex flex-wrap items-end gap-2 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          add({ text, kind })
            .then(() => setText(""))
            .catch((err) => setError(errorText(err)));
        }}
      >
        <label className="min-w-0 flex-1 text-sm">
          <span className="label">أضف ما تريد أن يتذكّره</span>
          <input className="input w-full" value={text} maxLength={300} onChange={(e) => setText(e.target.value)} placeholder="مثال: أعمل في إدارة التدريب، وأفضّل الخطابات الرسمية بالتاريخ الهجري" />
        </label>
        <select className="input w-auto" aria-label="النوع" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {MEMORY_KINDS.filter((k) => k.key !== "term").map((k) => (
            <option key={k.key} value={k.key}>
              {k.label}
            </option>
          ))}
        </select>
        <button className="btn-primary" disabled={text.trim().length < 3}>
          <Icon name="plus" /> أضف
        </button>
        {error && <p className="w-full text-sm text-negative">{error}</p>}
        <p className="w-full text-xs text-faint">أو قل في أي محادثة: «تذكّر أن…». لا تُحفظ كلمات المرور ولا أرقام الهوية والحسابات.</p>
      </form>

      {data.suggestions.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-medium">اقتراحات من محادثاتك</h2>
          <p className="mb-2 text-xs text-muted">لاحظها المساعد في رسائلك. لا تُستخدم حتى توافق عليها.</p>
          <ul className="space-y-2">
            {data.suggestions.map((m) => (
              <li key={m._id} className="card flex flex-wrap items-center gap-3 border-dashed p-3">
                <span className="min-w-0 flex-1 text-sm leading-6" dir="auto">
                  {m.text}
                </span>
                {m.threadId && (
                  <a href={`#/chat/${m.threadId}`} className="text-xs text-muted hover:text-ink">
                    من المحادثة
                  </a>
                )}
                <button className="btn-secondary h-8 text-xs" onClick={() => void run(review({ memoryId: m._id, accept: true }))}>
                  <Icon name="check" size={14} /> احفظ
                </button>
                <button className="btn-ghost h-8 text-xs" onClick={() => void run(review({ memoryId: m._id, accept: false }))}>
                  تجاهل
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-medium">
            ما يتذكّره <span className="num text-muted">({data.items.length})</span>
          </h2>
          {data.items.length > 8 && <input className="input ms-auto h-8 w-56 text-sm" placeholder="ابحث في الذاكرة…" value={q} onChange={(e) => setQ(e.target.value)} />}
        </div>
        {data.items.length === 0 ? (
          <EmptyState icon="memory" title="لا شيء بعد">
            اطلب منه في أي محادثة: «تذكّر أنني أفضّل الإجابات المختصرة»، أو أضف هنا.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-rule rounded-xl border border-line">
            {items.map((m) => (
              <li key={m._id} className="flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5 shrink-0 rounded bg-sunken px-1.5 py-0.5 text-[11px] text-muted">{kindLabel(m.kind)}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-6 [overflow-wrap:anywhere]" dir="auto">
                    {m.text}
                  </p>
                  <p className="mt-0.5 text-xs text-faint">
                    {m.how === "manual" ? "أضفتها" : m.how === "auto" ? "اقترحها المساعد ووافقت" : "طلبت حفظها"} · {relTime(m.updatedAt)}
                    {m.origin && ` · تظهر ما دمت تقرأ «${m.origin}»`}
                    {m.uses > 0 && <span className="num"> · استُخدمت {m.uses}</span>}
                  </p>
                </div>
                <Menu
                  label="خيارات"
                  items={[
                    {
                      label: "تعديل",
                      icon: "pencil",
                      onSelect: () =>
                        void askText("عدّل ما يتذكّره", m.text).then((t) => {
                          if (t && t !== m.text) void run(update({ memoryId: m._id, text: t }));
                        }),
                    },
                    ...(m.threadId ? [{ label: "افتح المحادثة", icon: "chat" as const, onSelect: () => (location.hash = `#/chat/${m.threadId}`) }] : []),
                    "divider" as const,
                    { label: "انسَ هذا", icon: "x", danger: true, onSelect: () => void run(remove({ memoryId: m._id })) },
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-faint">
          لا تريد ذاكرة في محادثة معيّنة؟ اختر «محادثة بلا ذاكرة» من قائمة المحادثة <Icon name="dots" size={12} className="inline" />.
        </p>
      </section>
    </div>
  );
}

/** «ذاكرة المساحة»: the space's decisions, conventions and terms (managers write, members propose). */
export function SpaceMemory({ spaceId }: { spaceId: string }) {
  const data = useQuery(api.memory.space, { spaceId });
  const add = useMutation(api.memory.addSpace);
  const remove = useMutation(api.memory.remove);
  const update = useMutation(api.memory.update);
  const review = useMutation(api.memory.review);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<Kind>("decision");
  const [msg, setMsg] = useState("");
  if (data === undefined) return <p className="text-sm text-muted">جارٍ التحميل…</p>;
  const run = (p: Promise<unknown>) => p.catch((e) => void tell(errorText(e)));
  const canAdd = data.canManage || data.canPropose;
  return (
    <div className="text-sm">
      {data.items.length === 0 && data.proposals.length === 0 && (
        <p className="text-muted">
          {data.canManage ? "أضف قرارات الفريق واصطلاحاته ومصطلحاته، فيلتزم بها المساعد في كل محادثة هنا." : "لا شيء في ذاكرة هذه المساحة بعد."}
        </p>
      )}
      {data.items.length > 0 && (
        <ul className="space-y-1.5">
          {data.items.map((m) => (
            <li key={m._id} className="group flex items-start gap-2">
              <span className="mt-0.5 shrink-0 rounded bg-sunken px-1.5 text-[11px] text-muted">{kindLabel(m.kind)}</span>
              <span className="min-w-0 flex-1 leading-6 [overflow-wrap:anywhere]" dir="auto">
                {m.text}
              </span>
              {data.canManage && (
                <Menu
                  label="خيارات"
                  className="opacity-60 group-hover:opacity-100"
                  items={[
                    {
                      label: "تعديل",
                      icon: "pencil",
                      onSelect: () =>
                        void askText("عدّل", m.text).then((t) => {
                          if (t && t !== m.text) void run(update({ memoryId: m._id, text: t }));
                        }),
                    },
                    { label: "احذف", icon: "x", danger: true, onSelect: () => void run(remove({ memoryId: m._id })) },
                  ]}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {data.proposals.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-rule pt-3">
          <p className="text-xs font-medium text-muted">{data.canManage ? "مقترحات بانتظار موافقتك" : "مقترحاتك بانتظار المدير"}</p>
          {data.proposals.map((m) => (
            <div key={m._id} className="rounded-lg border border-dashed border-line p-2">
              <p className="leading-6" dir="auto">
                {m.text}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                {m.by && <span className="text-faint">{m.mine ? "أنت" : m.by}</span>}
                <span className="ms-auto" />
                {data.canManage && (
                  <button className="btn-secondary h-7 px-2 text-xs" onClick={() => void run(review({ memoryId: m._id, accept: true }))}>
                    اعتمد
                  </button>
                )}
                <button className="btn-ghost h-7 px-2 text-xs" onClick={() => void run(data.canManage ? review({ memoryId: m._id, accept: false }) : remove({ memoryId: m._id }))}>
                  {data.canManage ? "ارفض" : "اسحب"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {canAdd &&
        (adding ? (
          <form
            className="mt-3 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              setMsg("");
              add({ spaceId, text, kind })
                .then((r) => {
                  setText("");
                  setAdding(false);
                  setMsg(r.state === "proposed" ? "أُرسل لمديري المساحة" : "");
                })
                .catch((err) => setMsg(errorText(err)));
            }}
          >
            <textarea className="input h-auto w-full py-2" rows={2} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} placeholder="مثال: الميزانية تُكتب بالألف ريال" />
            <div className="flex flex-wrap items-center gap-2">
              <select className="input h-8 w-auto text-xs" aria-label="النوع" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                {MEMORY_KINDS.map((k) => (
                  <option key={k.key} value={k.key}>
                    {k.label}
                  </option>
                ))}
              </select>
              <button className="btn-primary h-8" disabled={text.trim().length < 3}>
                {data.canManage ? "أضف" : "اقترح"}
              </button>
              <button type="button" className="btn-ghost h-8" onClick={() => setAdding(false)}>
                إلغاء
              </button>
            </div>
          </form>
        ) : (
          <button className="btn-secondary mt-3 h-8" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} /> {data.canManage ? "أضف إلى الذاكرة" : "اقترح إضافة"}
          </button>
        ))}
      {msg && <p className="mt-2 text-xs text-muted">{msg}</p>}
    </div>
  );
}
