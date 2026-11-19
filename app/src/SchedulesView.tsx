// Scheduled tasks (schedules.ts): a prompt that runs on a recurrence as me, with an agent and an
// optional space. Each run's answer lands in the task's own chat and I'm notified; anything that
// would change data waits there for my "نفّذ". Times are the workspace's (Riyadh).

import { useState } from "react";
import { useMutation, useQuery } from "onebase/react";
import { api, errorText, spaceName, type SpaceInfo } from "./lib";
import { Icon } from "./icons";
import { relTime } from "./ChatView";
import { EmptyState, Menu, ask } from "./ui";

const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
type Rec = { kind: "daily" | "weekly" | "monthly" | "cron"; time?: string; weekday?: number; monthDay?: number; cron?: string };
type Draft = { id?: string; title: string; prompt: string; agentId: string; spaceId: string; recurrence: Rec };
const EMPTY: Draft = { title: "", prompt: "", agentId: "", spaceId: "", recurrence: { kind: "weekly", time: "08:00", weekday: 0 } };

/** Ready-made starting points: they only fill the form. */
const TEMPLATES: { title: string; prompt: string; recurrence: Rec; hint: string }[] = [
  { title: "ملخص الأسبوع", prompt: "لخّص ما أُضيف أو تغيّر في ملفات المساحة هذا الأسبوع في نقاط، مع ذكر المصدر.", recurrence: { kind: "weekly", time: "08:00", weekday: 0 }, hint: "كل أحد 8:00" },
  { title: "مواعيد قريبة", prompt: "ما المواعيد والمهل النظامية التي تحل خلال الأيام السبعة القادمة في مستندات المساحة؟ رتّبها بالتاريخ.", recurrence: { kind: "daily", time: "07:30" }, hint: "يومياً 7:30" },
  { title: "تقرير الشهر", prompt: "أعدّ تقريراً شهرياً مختصراً عن بيانات المساحة: أهم الأرقام والتغيّر عن الشهر الماضي والملاحظات.", recurrence: { kind: "monthly", time: "09:00", monthDay: 1 }, hint: "أول كل شهر 9:00" },
];

/** «بعد ٣ ساعات», «غداً 08:00», else a short date. */
function nextIn(ms: number | null) {
  if (!ms) return "—";
  const diff = ms - Date.now();
  const time = new Date(ms).toLocaleTimeString("ar-SA-u-nu-latn", { hour: "2-digit", minute: "2-digit" });
  if (diff < 60_000) return "الآن";
  if (diff < 3_600_000) return `بعد ${Math.round(diff / 60_000)} دقيقة`;
  if (diff < 12 * 3_600_000) return `بعد ${Math.round(diff / 3_600_000)} ساعات`;
  const days = Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `اليوم ${time}`;
  if (days === 1) return `غداً ${time}`;
  return new Date(ms).toLocaleString("ar-SA-u-nu-latn", { weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function SchedulesPanel({ spaces }: { spaces: SpaceInfo[] }) {
  const items = useQuery(api.schedules.mine);
  const setEnabled = useMutation(api.schedules.setEnabled);
  const runNow = useMutation(api.schedules.runNow);
  const remove = useMutation(api.schedules.remove);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setError("");
    setNote("");
    try {
      const r: any = await fn();
      if (r && typeof r === "object" && r.error) setError(r.error);
      else if (done) setNote(done);
    } catch (err) {
      setError(errorText(err));
    }
  };
  const fromTemplate = (t: (typeof TEMPLATES)[number]) => setEditing({ ...EMPTY, title: t.title, prompt: t.prompt, recurrence: t.recurrence });
  return (
    <div className={`grid gap-6 ${editing && items?.length ? "lg:grid-cols-[minmax(0,1fr)_400px]" : ""}`}>
      <section className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-muted">يشغّلها المساعد في وقتها بصلاحياتك، وتصلك نتيجتها في محادثة خاصة بها مع إشعار. ما يغيّر البيانات ينتظر «نفّذ» يوماً.</p>
          {!editing && (
            <button className="btn-primary" onClick={() => setEditing({ ...EMPTY })}>
              <Icon name="plus" /> مهمة مجدولة
            </button>
          )}
        </div>
        {error && <p className="alert-negative">{error}</p>}
        {note && <p className="alert-info animate-fade">{note}</p>}
        {items === undefined && <p className="text-sm text-muted">جارٍ التحميل…</p>}
        {items?.length === 0 && !editing && (
          <div className="space-y-3">
            <EmptyState icon="clock" title="لا مهام مجدولة بعد">
              اطلب من المساعد شيئاً يتكرر، ويعمل وحده في الوقت الذي تحدده. ابدأ من أحد هذه:
            </EmptyState>
            <div className="grid gap-2 sm:grid-cols-3">
              {TEMPLATES.map((t) => (
                <button key={t.title} className="rounded-xl border border-line p-3 text-start transition-colors hover:border-control hover:bg-sunken" onClick={() => fromTemplate(t)}>
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <Icon name="clock" size={14} className="text-muted" />
                    {t.title}
                  </span>
                  <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted">{t.prompt}</span>
                  <span className="badge mt-2">{t.hint}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <ul className="space-y-2">
          {items?.map((s) => {
            const state = !s.enabled ? (s.stoppedReason ? "stopped" : "paused") : s.lastStatus === "failed" ? "failed" : "active";
            const chip = { active: ["badge-positive", "نشطة"], paused: ["badge", "موقوفة مؤقتاً"], stopped: ["badge-warning", "متوقفة"], failed: ["badge-negative", "فشل آخر تشغيل"] }[state] as [string, string];
            return (
              <li key={s._id} className={`card p-4 ${s.enabled ? "" : "opacity-80"}`}>
                <div className="flex items-start gap-3">
                  <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${s.enabled ? "bg-primary-soft text-primary" : "bg-active text-muted"}`}>
                    <Icon name="clock" size={17} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{s.title}</span>
                      <span className={chip[0]}>{chip[1]}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted">{s.prompt}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                      <span className="flex items-center gap-1">
                        <Icon name="retry" size={12} />
                        {s.recurrenceLabel}
                      </span>
                      <span className="flex items-center gap-1">
                        <Icon name="folder" size={12} />
                        {s.spaceName ?? (s.spaceId === null && !s.stoppedReason ? "كل ما أملك" : "—")}
                      </span>
                      {s.enabled && (
                        <span className="flex items-center gap-1 text-ink">
                          <Icon name="calendar" size={12} />
                          التالي {nextIn(s.nextRunAt)}
                        </span>
                      )}
                      <span>آخر تشغيل: {s.lastRunAt ? relTime(s.lastRunAt) : "لم تعمل بعد"}</span>
                    </div>
                    {s.stoppedReason && <p className="alert-warning mt-2 text-xs">{s.stoppedReason}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <a className="btn-secondary h-8" href={`#/chat/${s.threadId}`}>
                      النتائج
                    </a>
                    <Menu
                      label={`خيارات ${s.title}`}
                      items={[
                        { label: "شغّل الآن", icon: "play", onSelect: () => void act(() => runNow({ scheduleId: s._id }), "بدأ التشغيل. تظهر النتيجة في محادثتها.") },
                        { label: s.enabled ? "إيقاف مؤقت" : "تفعيل", icon: s.enabled ? "pause" : "play", onSelect: () => void act(() => setEnabled({ scheduleId: s._id, enabled: !s.enabled })) },
                        { label: "تعديل", icon: "pencil", onSelect: () => setEditing({ id: s._id, title: s.title, prompt: s.prompt, agentId: s.agentId ?? "", spaceId: s.spaceId ?? "", recurrence: s.recurrence as Rec }) },
                        "divider",
                        { label: "حذف", icon: "x", danger: true, onSelect: () => void ask(`حذف «${s.title}»؟ تبقى محادثة نتائجها.`, { danger: true, confirmLabel: "حذف" }).then((ok) => { if (ok) void act(() => remove({ scheduleId: s._id })); })},
                      ]}
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
      {editing && (
        <aside className={`lg:sticky lg:top-6 lg:self-start ${items?.length ? "" : "max-w-xl"}`}>
          <ScheduleForm key={editing.id ?? editing.title ?? "new"} draft={editing} spaces={spaces} onDone={() => setEditing(null)} />
        </aside>
      )}
    </div>
  );
}

function ScheduleForm({ draft, spaces, onDone }: { draft: Draft; spaces: SpaceInfo[]; onDone: () => void }) {
  const agents = useQuery(api.agents.available);
  const create = useMutation(api.schedules.create);
  const update = useMutation(api.schedules.update);
  const [d, setD] = useState<Draft>(draft);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const r = d.recurrence;
  const setR = (patch: Partial<Rec>) => setD({ ...d, recurrence: { ...r, ...patch } });
  return (
    <form
      className="card space-y-4 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        const recurrence: Rec = r.kind === "cron" ? { kind: "cron", cron: r.cron ?? "" } : { kind: r.kind, time: r.time ?? "08:00", ...(r.kind === "weekly" ? { weekday: r.weekday ?? 0 } : {}), ...(r.kind === "monthly" ? { monthDay: r.monthDay ?? 1 } : {}) };
        const args = { title: d.title, prompt: d.prompt, agentId: d.agentId || null, spaceId: d.spaceId || null, recurrence };
        try {
          if (d.id) await update({ scheduleId: d.id, ...args });
          else await create(args);
          onDone();
        } catch (err) {
          setError(errorText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="flex items-center gap-2">
        <h2 className="font-medium">{d.id ? "تعديل المهمة المجدولة" : "مهمة مجدولة جديدة"}</h2>
        <button type="button" className="btn-icon ms-auto" aria-label="إغلاق" onClick={onDone}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <Field label="الاسم">
        <input className="input w-full" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} maxLength={80} required placeholder="ملخص المشتريات الأسبوعي" />
      </Field>
      <Field label="الطلب">
        <textarea className="textarea w-full" rows={4} dir="auto" value={d.prompt} onChange={(e) => setD({ ...d, prompt: e.target.value })} maxLength={4000} required placeholder="لخّص ما أُضيف إلى ملفات المساحة هذا الأسبوع في نقاط." />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="المساحة">
          <select className="input w-full" value={d.spaceId} onChange={(e) => setD({ ...d, spaceId: e.target.value })}>
            <option value="">كل ما أملك</option>
            {spaces.map((s) => (
              <option key={s._id} value={s._id}>
                {spaceName(s)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="الوكيل">
          <select className="input w-full" value={d.agentId} onChange={(e) => setD({ ...d, agentId: e.target.value })}>
            {(agents ?? []).map((a) => (
              <option key={a._id} value={a.isDefault ? "" : a._id}>
                {a.name}
                {a.isDefault ? " (الافتراضي)" : ""}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="التكرار">
        <div className="flex rounded-lg bg-sunken p-1" role="radiogroup" aria-label="التكرار">
          {(
            [
              ["daily", "يومياً"],
              ["weekly", "أسبوعياً"],
              ["monthly", "شهرياً"],
              ["cron", "مخصص"],
            ] as const
          ).map(([k, label]) => (
            <button type="button" key={k} role="radio" aria-checked={r.kind === k} className={`h-8 flex-1 rounded-md px-2 text-sm transition-colors ${r.kind === k ? "bg-surface font-medium shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-muted hover:text-ink"}`} onClick={() => setR({ kind: k })}>
              {label}
            </button>
          ))}
        </div>
      </Field>
      {r.kind === "cron" ? (
        <Field label="تعبير cron (دقيقة ساعة يوم شهر يوم-الأسبوع)">
          <input className="input w-full" dir="ltr" value={r.cron ?? ""} onChange={(e) => setR({ cron: e.target.value })} placeholder="0 9 * * 0-4" required />
        </Field>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="الوقت">
            <input className="input w-full num" type="time" value={r.time ?? "08:00"} onChange={(e) => setR({ time: e.target.value })} required />
          </Field>
          {r.kind === "weekly" && (
            <Field label="اليوم">
              <select className="input w-full" value={r.weekday ?? 0} onChange={(e) => setR({ weekday: Number(e.target.value) })}>
                {DAYS.map((name, i) => (
                  <option key={name} value={i}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {r.kind === "monthly" && (
            <Field label="يوم الشهر">
              <input className="input w-full num" type="number" min={1} max={28} value={r.monthDay ?? 1} onChange={(e) => setR({ monthDay: Number(e.target.value) })} />
            </Field>
          )}
        </div>
      )}
      {error && <p className="text-sm text-negative">{error}</p>}
      <p className="meta">بتوقيت الرياض. تُفحص صلاحياتك في كل تشغيل، وإن فقدت الوصول تتوقف ويصلك إشعار بالسبب.</p>
      <div className="flex gap-2 border-t border-rule pt-3">
        <button className="btn-primary" disabled={busy}>
          {d.id ? "حفظ" : "جدولة"}
        </button>
        <button type="button" className="btn-ghost" onClick={onDone}>
          إلغاء
        </button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}
