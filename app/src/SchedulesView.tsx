// Scheduled tasks (schedules.ts): a prompt that runs on a recurrence as me, with an agent and an
// optional space. Each run's answer lands in the task's own chat and I'm notified; anything that
// would change data waits there for my "نفّذ". Times are the workspace's (Riyadh).

import { useState } from "react";
import { useMutation, useQuery } from "onebase/react";
import { api, errorText, spaceName, type SpaceInfo } from "./lib";
import { Icon } from "./icons";
import { relTime } from "./ChatView";

const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
type Rec = { kind: "daily" | "weekly" | "monthly" | "cron"; time?: string; weekday?: number; monthDay?: number; cron?: string };
type Draft = { id?: string; title: string; prompt: string; agentId: string; spaceId: string; recurrence: Rec };
const EMPTY: Draft = { title: "", prompt: "", agentId: "", spaceId: "", recurrence: { kind: "weekly", time: "08:00", weekday: 0 } };

function when(ms: number | null) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("ar-SA-u-nu-latn", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function SchedulesPanel({ spaces }: { spaces: SpaceInfo[] }) {
  const items = useQuery(api.schedules.mine);
  const setEnabled = useMutation(api.schedules.setEnabled);
  const runNow = useMutation(api.schedules.runNow);
  const remove = useMutation(api.schedules.remove);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      const r: any = await fn();
      if (r && typeof r === "object" && r.error) setError(r.error);
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section>
        <div className="flex items-center gap-2">
          <h2 className="section-title">مهامي المجدولة</h2>
          <span className="text-xs text-muted num">{items?.length ?? ""}</span>
          <button className="btn-primary ms-auto" onClick={() => setEditing({ ...EMPTY })}>
            <Icon name="plus" /> مهمة مجدولة
          </button>
        </div>
        <p className="mt-1 text-sm text-muted">تعمل بصلاحياتك وقت التشغيل، وتصلك نتيجتها في محادثة خاصة بها. أي إجراء يغيّر البيانات ينتظر تأكيدك.</p>
        {error && <p className="mt-2 text-sm text-negative">{error}</p>}
        <ul className="mt-3">
          {items === undefined && <li className="py-3 text-sm text-muted">جارٍ التحميل…</li>}
          {items?.length === 0 && (
            <li className="rounded-lg border border-dashed border-control p-4 text-sm text-muted">
              لا مهام مجدولة. مثال: «كل أحد 8:00 لخّص ما أُضيف إلى مساحة المشتريات هذا الأسبوع».
            </li>
          )}
          {items?.map((s) => (
            <li key={s._id} className="border-b border-rule py-3">
              <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{s.title}</span>
                    {!s.enabled && <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-xs text-muted">{s.stoppedReason ? "متوقفة" : "موقوفة مؤقتاً"}</span>}
                    {s.lastStatus === "failed" && <span className="shrink-0 rounded bg-negative-soft px-1.5 py-0.5 text-xs text-negative">فشل آخر تشغيل</span>}
                  </div>
                  <p className="line-clamp-2 text-sm text-ink">{s.prompt}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {s.recurrenceLabel} · {s.agentName ?? "الوكيل غير متاح"} · {s.spaceName ?? (s.spaceId === null && !s.stoppedReason ? "كل ما أملك" : "—")}
                  </p>
                  {s.stoppedReason && <p className="mt-0.5 text-xs text-warning">{s.stoppedReason}</p>}
                </div>
                <div className="shrink-0 text-end text-xs text-muted num">
                  <div>التالي: {s.enabled ? when(s.nextRunAt) : "—"}</div>
                  <div>آخر تشغيل: {s.lastRunAt ? relTime(s.lastRunAt) : "لم تعمل بعد"}</div>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <a className="btn-secondary h-8" href={`#/chat/${s.threadId}`}>
                  النتائج
                </a>
                <button className="btn-ghost h-8" onClick={() => void act(() => runNow({ scheduleId: s._id }))}>
                  <Icon name="play" size={14} /> شغّل الآن
                </button>
                <button className="btn-ghost h-8" onClick={() => void act(() => setEnabled({ scheduleId: s._id, enabled: !s.enabled }))}>
                  {s.enabled ? "إيقاف مؤقت" : "تفعيل"}
                </button>
                <button
                  className="btn-ghost h-8"
                  onClick={() => setEditing({ id: s._id, title: s.title, prompt: s.prompt, agentId: s.agentId ?? "", spaceId: s.spaceId ?? "", recurrence: s.recurrence as Rec })}
                >
                  تعديل
                </button>
                <button className="btn-danger h-8" onClick={() => confirm(`حذف «${s.title}»؟ تبقى محادثة نتائجها.`) && void act(() => remove({ scheduleId: s._id }))}>
                  حذف
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <aside>{editing ? <ScheduleForm key={editing.id ?? "new"} draft={editing} spaces={spaces} onDone={() => setEditing(null)} /> : <Help />}</aside>
    </div>
  );
}

function Help() {
  return (
    <section className="card p-4 text-sm text-ink">
      <h2 className="mb-2 text-sm font-medium">كيف تعمل</h2>
      <ul className="list-disc space-y-1.5 ps-5">
        <li>تُشغَّل في الوقت المحدد بتوقيت الرياض، كأنك أرسلت الطلب بنفسك.</li>
        <li>تُفحص صلاحياتك في كل تشغيل: إن أُزلت من المساحة أو عُطّل حسابك تتوقف، ويصلك إشعار بالسبب.</li>
        <li>تُكتب النتيجة في محادثة المهمة، ويصلك إشعار.</li>
        <li>لا يُنفَّذ أي إجراء يغيّر البيانات تلقائياً: يظهر في المحادثة بانتظار «نفّذ» لمدة يوم.</li>
      </ul>
    </section>
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
      <h2 className="text-sm font-medium">{d.id ? "تعديل المهمة المجدولة" : "مهمة مجدولة جديدة"}</h2>
      <Field label="الاسم">
        <input className="input w-full" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} maxLength={80} required placeholder="ملخص المشتريات الأسبوعي" />
      </Field>
      <Field label="الطلب">
        <textarea className="input h-auto w-full py-2" rows={4} value={d.prompt} onChange={(e) => setD({ ...d, prompt: e.target.value })} maxLength={4000} required placeholder="لخّص ما أُضيف إلى ملفات المساحة هذا الأسبوع في نقاط." />
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
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="التكرار">
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="التكرار">
          {(
            [
              ["daily", "يومياً"],
              ["weekly", "أسبوعياً"],
              ["monthly", "شهرياً"],
              ["cron", "cron"],
            ] as const
          ).map(([k, label]) => (
            <button type="button" key={k} role="radio" aria-checked={r.kind === k} className={`h-8 rounded-md px-3 text-sm ${r.kind === k ? "bg-primary text-white" : "bg-raised hover:bg-active"}`} onClick={() => setR({ kind: k })}>
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
      <div className="flex gap-2">
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
