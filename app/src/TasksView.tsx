// Tasks (Phase 3, redesigned): «مسندة إليّ» grouped by what to do next, tasks by space with their
// progress, a space's board, and the task page (the work on one side, its details on the other).
// Every permission decision is the server's (tasks.ts); the flags it returns (canManage,
// isAssignee, canAttach, nextStatuses) only decide which buttons to show.

import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "onebase/react";
import { ArtifactDock } from "./ArtifactPanel";
import { EmptyState, ask } from "./ui";
import { api, errorText, formatDate, type SpaceInfo } from "./lib";
import { Icon } from "./icons";
import { Page } from "./ChatView";
import { SchedulesPanel } from "./SchedulesView";

export const STATUS: Record<string, { label: string; tone: string; dot: string }> = {
  new: { label: "جديدة", tone: "bg-raised text-muted", dot: "border-control" },
  inProgress: { label: "قيد العمل", tone: "bg-primary-soft text-primary", dot: "border-primary" },
  review: { label: "مراجعة", tone: "bg-warning-soft text-warning", dot: "border-warning" },
  done: { label: "منجزة", tone: "bg-positive-soft text-positive", dot: "border-positive bg-positive" },
};
const STATUS_ORDER = ["new", "inProgress", "review", "done"] as const;

export const PRIORITY: Record<string, { label: string; tone: string; rank: number }> = {
  low: { label: "منخفضة", tone: "text-muted", rank: 0 },
  normal: { label: "عادية", tone: "text-muted", rank: 1 },
  high: { label: "عالية", tone: "text-warning", rank: 2 },
  urgent: { label: "عاجلة", tone: "text-negative font-medium", rank: 3 },
};

/** The button labels for moving a task, from the current status to the next. */
function moveLabel(from: string, to: string) {
  if (to === "inProgress") return from === "new" ? "بدء العمل" : from === "review" ? "إعادة للتعديل" : "إعادة فتح";
  if (to === "review") return "إرسال للمراجعة";
  if (to === "done") return "إغلاق المهمة";
  return STATUS[to]?.label ?? to;
}

/** "اعمل عليها مع الوكيل": a link to the task's thread (App reads ?taskId= on load; in-app clicks use an event). */
export function chatUrlForTask(taskId: string) {
  return `/chat?taskId=${encodeURIComponent(taskId)}`;
}

function openTaskChat(e: { preventDefault: () => void }, taskId: string) {
  e.preventDefault();
  window.dispatchEvent(new CustomEvent("onespace:task-chat", { detail: taskId }));
}

type TaskRow = {
  _id: string;
  title: string;
  status: string;
  priority: string;
  due: number | null;
  spaceName: string;
  assignees: Assignee[];
  linkCount: number;
};

type Assignee = { userId: string; name: string | null; active: boolean };

/** The task's assignees by name; one who is no longer a manager or member shows in red. */
function AssigneeNames({ assignees }: { assignees: Assignee[] }) {
  if (!assignees.length) return <span className="text-faint">—</span>;
  return (
    <span>
      {assignees.map((a, i) => (
        <span key={a.userId} className={a.active ? "" : "text-negative"}>
          {i > 0 && "، "}
          {a.name ?? "؟"}
          {!a.active && " (لم يعد عضواً)"}
        </span>
      ))}
    </span>
  );
}

/** Up to three initials, overlapping, then «+n». */
function AssigneeFaces({ assignees }: { assignees: Assignee[] }) {
  const shown = assignees.slice(0, 3);
  return (
    <span className="flex items-center" aria-hidden>
      {shown.map((a, i) => (
        <span key={a.userId} className={`grid h-5 w-5 place-items-center rounded-full border border-surface bg-active text-[10px] ${i ? "-ms-1.5" : ""}`}>
          {(a.name ?? "؟").charAt(0)}
        </span>
      ))}
      {assignees.length > 3 && <span className="ms-1 text-[10px] text-faint num">+{assignees.length - 3}</span>}
    </span>
  );
}

/** Multi-select of the space's managers and members (tasks:assignees): toggle chips. */
function AssigneePicker({
  people,
  value,
  onChange,
  extra = [],
}: {
  people: { userId: string; name: string | null }[] | undefined;
  value: string[];
  onChange: (next: string[]) => void;
  extra?: Assignee[]; // current assignees no longer offered (left the space): shown so they can be removed
}) {
  const offered = [...(people ?? []), ...extra.filter((a) => !people?.some((p) => p.userId === a.userId))];
  if (people === undefined) return <p className="text-xs text-muted">جارٍ التحميل…</p>;
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="المسؤولون">
      {offered.map((p) => {
        const on = value.includes(p.userId);
        return (
          <button
            key={p.userId}
            type="button"
            aria-pressed={on}
            className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${on ? "border-primary bg-primary text-primary-ink" : "border-line hover:border-control"}`}
            onClick={() => onChange(on ? value.filter((id) => id !== p.userId) : [...value, p.userId])}
          >
            {p.name ?? "؟"}
          </button>
        );
      })}
      {!offered.length && <span className="text-xs text-muted">لا أعضاء يمكن الإسناد إليهم.</span>}
    </div>
  );
}

const DAY = 86_400_000;
const dayStart = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
/** Whole days from today to the due date (negative = late). */
const daysLeft = (due: number) => Math.round((dayStart(due) - dayStart(Date.now())) / DAY);

/** The due date in words: «متأخرة ٣ أيام», «اليوم», «غداً», «بعد ٥ أيام», else the date. */
function dueText(due: number, status: string) {
  const n = daysLeft(due);
  if (status === "done") return new Date(due).toLocaleDateString("ar-SA-u-nu-latn", { day: "numeric", month: "short" });
  if (n < 0) return n === -1 ? "متأخرة يوماً" : n === -2 ? "متأخرة يومين" : `متأخرة ${-n} أيام`;
  if (n === 0) return "اليوم";
  if (n === 1) return "غداً";
  if (n <= 10) return `بعد ${n} أيام`;
  return new Date(due).toLocaleDateString("ar-SA-u-nu-latn", { day: "numeric", month: "short" });
}

function Pill({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "bg-raised" };
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${s.tone}`}>{s.label}</span>;
}

function Due({ due, status }: { due: number | null; status: string }) {
  if (!due) return null;
  const n = daysLeft(due);
  const tone = status === "done" ? "text-muted" : n < 0 ? "bg-negative-soft text-negative" : n <= 1 ? "bg-warning-soft text-warning" : "text-muted";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-xs ${tone}`} title={new Date(due).toLocaleDateString("ar-SA-u-nu-latn")}>
      <Icon name="calendar" size={12} />
      {dueText(due, status)}
    </span>
  );
}

function PriorityMark({ priority }: { priority: string }) {
  if (priority !== "high" && priority !== "urgent") return null;
  return (
    <span className={`shrink-0 text-xs ${PRIORITY[priority]!.tone}`} title={`أولوية ${PRIORITY[priority]!.label}`}>
      {priority === "urgent" ? "عاجلة" : "عالية"}
    </span>
  );
}

/** One task as a row: status ring, title, where/who, priority, due. */
function TaskRowView({ t, sub, onOpen }: { t: TaskRow; sub: ReactNode; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="group flex w-full items-center gap-3 px-3 py-3 text-start transition-colors hover:bg-sunken">
      <span className={`h-4 w-4 shrink-0 rounded-full border-2 ${STATUS[t.status]?.dot ?? "border-control"}`} title={STATUS[t.status]?.label} />
      <span className="min-w-0 flex-1">
        <span className={`block truncate ${t.status === "done" ? "text-muted line-through" : "font-medium"}`}>{t.title}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">{sub}</span>
      </span>
      <PriorityMark priority={t.priority} />
      {t.linkCount > 0 && (
        <span className="hidden shrink-0 items-center gap-0.5 text-xs text-faint sm:flex" title="مرفقات">
          <Icon name="clip" size={12} />
          {t.linkCount}
        </span>
      )}
      <Due due={t.due} status={t.status} />
      <Pill status={t.status} />
    </button>
  );
}

/** A board card (a space's columns). */
function TaskCard({ t, onOpen }: { t: TaskRow; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="block w-full space-y-2 rounded-xl border border-line bg-surface p-3 text-start shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:border-control">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-sm font-medium">{t.title}</span>
        <PriorityMark priority={t.priority} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className="flex items-center gap-1">
          <AssigneeFaces assignees={t.assignees} />
          <AssigneeNames assignees={t.assignees} />
        </span>
        <Due due={t.due} status={t.status} />
        {t.linkCount > 0 && (
          <span className="flex items-center gap-0.5 text-faint">
            <Icon name="clip" size={12} />
            {t.linkCount}
          </span>
        )}
      </div>
    </button>
  );
}

/**
 * "المهام": tasks assigned to me, tasks by space, and my scheduled tasks (SchedulesView.tsx).
 * A task id in the address opens its page.
 */
export function TasksPage({ tab, taskId, go, spaces }: { tab: "mine" | "scheduled"; taskId: string | null; go: (p: string) => void; spaces: SpaceInfo[] }) {
  const [view, setView] = useState<"mine" | "spaces">("mine");
  const mine = useQuery(api.tasks.mine);
  const schedules = useQuery(api.schedules.mine);
  if (taskId)
    return (
      <div className="mx-auto w-full max-w-[1100px] px-4 py-6 lg:px-8 lg:py-9">
        <TaskDetail taskId={taskId} onClose={() => go("/tasks")} />
      </div>
    );
  const taskSpaces = spaces.filter((s) => s.kind === "shared" && ["manager", "member", "reader"].includes(s.myRole));
  const openMine = (mine ?? []).filter((t) => t.status !== "done").length;
  const tabs = [
    { id: "mine", label: "مسندة إليّ", count: mine ? openMine : null, on: tab === "mine" && view === "mine", go: () => (setView("mine"), tab !== "mine" && go("/tasks")) },
    { id: "spaces", label: "حسب المساحة", count: null, on: tab === "mine" && view === "spaces", go: () => (setView("spaces"), tab !== "mine" && go("/tasks")) },
    { id: "scheduled", label: "المجدولة", count: schedules ? schedules.length : null, on: tab === "scheduled", go: () => go("/schedules") },
  ];
  return (
    <Page title="المهام" sub="ما أُسند إليك في المساحات، ومهامك المجدولة التي يشغّلها المساعد في وقتها.">
      <nav className="tabs -mt-2 mb-6" aria-label="أقسام المهام">
        {tabs.map((t) => (
          <button key={t.id} onClick={t.go} className={`${t.on ? "tab-active" : "tab"} flex items-center gap-1.5`} aria-current={t.on ? "page" : undefined}>
            {t.label}
            {t.count !== null && t.count > 0 && <span className={`num rounded-full px-1.5 text-[11px] ${t.on ? "bg-primary text-white" : "bg-active text-muted"}`}>{t.count}</span>}
          </button>
        ))}
      </nav>
      {tab === "scheduled" ? (
        <SchedulesPanel spaces={spaces} />
      ) : view === "mine" ? (
        <MyTasksView openTaskId={null} onOpenTask={(id) => go(id ? `/tasks/${id}` : "/tasks")} />
      ) : (
        <div className="space-y-6">
          {taskSpaces.length === 0 && (
            <EmptyState icon="folder" title="لا مساحات مشتركة">
              المهام تُسند داخل المساحات المشتركة. حين تُضاف عضواً في مساحة تظهر مهامها هنا.
            </EmptyState>
          )}
          {taskSpaces.map((s) => (
            <SpaceTaskList key={s._id} space={s} go={go} />
          ))}
        </div>
      )}
    </Page>
  );
}

function SpaceTaskList({ space, go }: { space: SpaceInfo; go: (p: string) => void }) {
  const tasks = useQuery(api.tasks.board, { spaceId: space._id as any });
  const open = (tasks ?? []).filter((t) => t.status !== "done");
  const done = (tasks ?? []).length - open.length;
  const total = (tasks ?? []).length;
  return (
    <section className="card overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 border-b border-rule px-4 py-3">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-active text-muted">
          <Icon name="folder" size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-medium">{space.name}</h2>
          {tasks !== undefined && (
            <div className="mt-1 flex items-center gap-2">
              <div className="h-1.5 w-32 overflow-hidden rounded-full bg-active">
                <div className="h-full rounded-full bg-positive transition-all" style={{ width: total ? `${(done / total) * 100}%` : "0%" }} />
              </div>
              <span className="meta num">
                {done}/{total} منجزة
              </span>
            </div>
          )}
        </div>
        <a href={`#/space/${space._id}/tasks`} className="btn-ghost text-xs">
          لوحة المساحة
        </a>
      </header>
      {tasks === undefined ? (
        <p className="px-4 py-3 text-sm text-muted">جارٍ التحميل…</p>
      ) : !open.length ? (
        <p className="px-4 py-3 text-sm text-muted">{total ? "كل المهام منجزة." : "لا مهام بعد."}</p>
      ) : (
        <div className="divide-y divide-rule">
          {open.map((t) => (
            <TaskRowView key={t._id} t={t as TaskRow} onOpen={() => go(`/tasks/${t._id}`)} sub={<AssigneeNames assignees={t.assignees} />} />
          ))}
        </div>
      )}
    </section>
  );
}

type Filter = "all" | "late" | "inProgress" | "review";
type Bucket = { key: string; title: string; rows: TaskRow[] };

/** "مهامي": what's assigned to me, grouped by when it's due; done tasks folded away. */
export function MyTasksView({ openTaskId, onOpenTask }: { openTaskId: string | null; onOpenTask: (id: string | null) => void }) {
  const tasks = useQuery(api.tasks.mine) as TaskRow[] | undefined;
  const [filter, setFilter] = useState<Filter>("all");
  const [showDone, setShowDone] = useState(false);
  const open = useMemo(() => (tasks ?? []).filter((t) => t.status !== "done"), [tasks]);
  const done = (tasks ?? []).filter((t) => t.status === "done");
  const late = open.filter((t) => t.due && daysLeft(t.due) < 0);
  const counts: Record<Filter, number> = { all: open.length, late: late.length, inProgress: open.filter((t) => t.status === "inProgress").length, review: open.filter((t) => t.status === "review").length };
  const shown = open.filter((t) => filter === "all" || (filter === "late" ? t.due && daysLeft(t.due) < 0 : t.status === filter));
  const byUrgency = (a: TaskRow, b: TaskRow) => (a.due ?? Infinity) - (b.due ?? Infinity) || PRIORITY[b.priority]!.rank - PRIORITY[a.priority]!.rank;
  const buckets: Bucket[] = [
    { key: "late", title: "متأخرة", rows: shown.filter((t) => t.due && daysLeft(t.due) < 0) },
    { key: "week", title: "هذا الأسبوع", rows: shown.filter((t) => t.due && daysLeft(t.due) >= 0 && daysLeft(t.due) <= 7) },
    { key: "later", title: "لاحقاً", rows: shown.filter((t) => t.due && daysLeft(t.due) > 7) },
    { key: "none", title: "بلا موعد", rows: shown.filter((t) => !t.due) },
  ].map((b) => ({ ...b, rows: b.rows.sort(byUrgency) }));

  if (openTaskId) return <TaskDetail taskId={openTaskId} onClose={() => onOpenTask(null)} />;
  if (tasks === undefined) return <div className="text-sm text-faint">جارٍ التحميل…</div>;
  if (!tasks.length)
    return (
      <EmptyState icon="tasks" title="لا مهام مسندة إليك">
        حين يُسند إليك مدير المساحة مهمة تظهر هنا، مرتبة بموعدها وأولويتها.
      </EmptyState>
    );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="تصفية">
        {(
          [
            ["all", "المفتوحة"],
            ["late", "المتأخرة"],
            ["inProgress", "قيد العمل"],
            ["review", "في المراجعة"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            role="radio"
            aria-checked={filter === k}
            onClick={() => setFilter(k)}
            className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors ${filter === k ? "border-ink bg-ink text-surface" : "border-line hover:border-control"} ${k === "late" && counts.late > 0 && filter !== k ? "text-negative" : ""}`}
          >
            {label}
            <span className="num text-xs opacity-70">{counts[k]}</span>
          </button>
        ))}
      </div>

      {open.length === 0 && <p className="rounded-xl border border-dashed border-control p-4 text-sm text-muted">لا مهام مفتوحة. أحسنت!</p>}
      {open.length > 0 && shown.length === 0 && <p className="text-sm text-muted">لا مهام في هذا التصنيف.</p>}
      {buckets
        .filter((b) => b.rows.length)
        .map((b) => (
          <section key={b.key}>
            <h2 className={`mb-1.5 flex items-center gap-2 text-xs font-medium ${b.key === "late" ? "text-negative" : "text-muted"}`}>
              {b.title}
              <span className="num">{b.rows.length}</span>
            </h2>
            <div className="card divide-y divide-rule overflow-hidden">
              {b.rows.map((t) => (
                <TaskRowView key={t._id} t={t} onOpen={() => onOpenTask(t._id)} sub={<span>{t.spaceName}</span>} />
              ))}
            </div>
          </section>
        ))}

      {done.length > 0 && (
        <section>
          <button className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted hover:text-ink" onClick={() => setShowDone(!showDone)} aria-expanded={showDone}>
            <Icon name="down" size={12} className={`transition-transform ${showDone ? "" : "ltr:-rotate-90 rtl:rotate-90"}`} />
            المنجزة <span className="num">{done.length}</span>
          </button>
          {showDone && (
            <div className="card divide-y divide-rule overflow-hidden">
              {done.map((t) => (
                <TaskRowView key={t._id} t={t} onOpen={() => onOpenTask(t._id)} sub={<span>{t.spaceName}</span>} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** A space's board: four columns; the manager creates tasks here. */
export function TaskBoard({ space }: { space: SpaceInfo }) {
  const tasks = useQuery(api.tasks.board, { spaceId: space._id as any });
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  if (openId) return <TaskDetail taskId={openId} onClose={() => setOpenId(null)} />;
  return (
    <div className="space-y-4">
      {space.canManage &&
        (creating ? (
          <NewTaskForm space={space} onDone={() => setCreating(false)} />
        ) : (
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" /> مهمة جديدة
          </button>
        ))}
      {tasks === undefined && <div className="text-sm text-faint">جارٍ التحميل…</div>}
      {tasks && tasks.length === 0 && !creating && (
        <EmptyState icon="tasks" title="لا مهام في هذه المساحة بعد">
          {space.canManage ? "أنشئ مهمة وأسندها لعضو في المساحة، ويصله إشعار." : "حين يُسند مدير المساحة مهمة تظهر هنا."}
        </EmptyState>
      )}
      {tasks && tasks.length > 0 && (
        <div className="grid gap-3 md:grid-cols-4">
          {STATUS_ORDER.map((s) => {
            const rows = tasks.filter((t) => t.status === s);
            return (
              <div key={s} className="space-y-2 rounded-xl bg-sunken p-2">
                <div className="flex items-center gap-2 px-1 py-1 text-sm">
                  <span className={`h-2.5 w-2.5 rounded-full border-2 ${STATUS[s]!.dot}`} />
                  <span className="font-medium">{STATUS[s]!.label}</span>
                  <span className="num text-xs text-faint">{rows.length}</span>
                </div>
                {rows.map((t) => (
                  <TaskCard key={t._id} t={t as TaskRow} onOpen={() => setOpenId(t._id)} />
                ))}
                {!rows.length && <div className="rounded-lg border border-dashed border-line py-4 text-center text-xs text-faint">—</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NewTaskForm({ space, onDone }: { space: SpaceInfo; onDone: () => void }) {
  const people = useQuery(api.tasks.assignees, { spaceId: space._id as any });
  const create = useMutation(api.tasks.create);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <form
      className="card animate-rise space-y-3 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const due = String(fd.get("due") || "");
        if (!picked.length) return setError("اختر مسؤولاً واحداً على الأقل");
        setBusy(true);
        setError("");
        try {
          await create({
            spaceId: space._id as any,
            title: String(fd.get("title")),
            body: String(fd.get("body") || "") || undefined,
            assigneeIds: picked as any,
            priority: String(fd.get("priority")) as any,
            due: due ? new Date(due + "T23:59:00").getTime() : undefined,
          });
          onDone();
        } catch (err) {
          setError(errorText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <input className="input w-full text-base font-medium" name="title" placeholder="عنوان المهمة" required maxLength={200} autoFocus />
      <textarea className="textarea w-full" name="body" placeholder="التفاصيل: المطلوب، والمصادر، ومعيار الإنجاز (اختياري)" rows={3} />
      <div className="text-sm">
        <span className="label">المسؤولون (واحد أو أكثر)</span>
        <AssigneePicker people={people} value={picked} onChange={setPicked} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="label">الأولوية</span>
          <select className="input w-full" name="priority" defaultValue="normal">
            {Object.entries(PRIORITY).map(([k, p]) => (
              <option key={k} value={k}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="label">الموعد (اختياري)</span>
          <input className="input w-full" type="date" name="due" />
        </label>
      </div>
      {error && <p className="text-sm text-negative">{error}</p>}
      <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-3">
        <span className="meta flex-1">تُسند لمديري هذه المساحة وأعضائها فقط، ويصل كلاً منهم إشعار. مهمة واحدة يشتركون فيها.</span>
        <button type="button" className="btn-ghost" onClick={onDone}>
          إلغاء
        </button>
        <button className="btn-primary" disabled={busy}>
          إسناد
        </button>
      </div>
    </form>
  );
}

/** Where the task is in its life: new → in progress → review → done. */
function Stepper({ status }: { status: string }) {
  const at = STATUS_ORDER.indexOf(status as (typeof STATUS_ORDER)[number]);
  return (
    <ol className="flex items-center gap-1" aria-label="مراحل المهمة">
      {STATUS_ORDER.map((s, i) => (
        <li key={s} className="flex flex-1 items-center gap-1">
          <span className={`flex flex-1 flex-col gap-1 ${i <= at ? "" : "opacity-50"}`}>
            <span className={`h-1 rounded-full ${i < at ? "bg-positive" : i === at ? (s === "done" ? "bg-positive" : "bg-primary") : "bg-active"}`} />
            <span className={`text-[11px] ${i === at ? "font-medium text-ink" : "text-muted"}`} aria-current={i === at ? "step" : undefined}>
              {STATUS[s]!.label}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function TaskDetail({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const task = useQuery(api.tasks.get, { taskId: taskId as any });
  const setStatus = useMutation(api.tasks.setStatus);
  const comment = useMutation(api.tasks.comment);
  const addLink = useMutation(api.tasks.addLink);
  const removeLink = useMutation(api.tasks.removeLink);
  const remove = useMutation(api.tasks.remove);
  const requestDownload = useMutation(api.files.requestDownload);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [picking, setPicking] = useState<"" | "file" | "artifact">("");
  const [openArtifact, setOpenArtifact] = useState<string | null>(null);
  const spaces = useQuery(api.spaces.mine);

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

  if (task === undefined) return <div className="text-sm text-faint">جارٍ التحميل…</div>;
  const forward = task.nextStatuses.filter((s) => STATUS_ORDER.indexOf(s as any) > STATUS_ORDER.indexOf(task.status as any));
  const back = task.nextStatuses.filter((s) => !forward.includes(s));
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <button className="btn-ghost -ms-2 text-sm text-muted" onClick={onClose}>
        <Icon name="next" size={14} className="rtl:rotate-180" /> المهام
      </button>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
        <div className="space-y-4">
          <div className="card space-y-4 p-5">
            <div>
              <div className="meta mb-1">{task.spaceName}</div>
              <h1 className="text-2xl font-bold leading-snug">{task.title}</h1>
            </div>
            <Stepper status={task.status} />
            {task.body ? <p className="whitespace-pre-wrap leading-7">{task.body}</p> : <p className="text-sm text-faint">لا تفاصيل.</p>}
            <div className="flex flex-wrap gap-2 border-t border-rule pt-4">
              {forward.map((s) => (
                <button key={s} className="btn-primary" disabled={busy} onClick={() => run(() => setStatus({ taskId: task._id, status: s }))}>
                  {s === "done" && <Icon name="check" size={15} />}
                  {moveLabel(task.status, s)}
                </button>
              ))}
              {task.status !== "done" && (
                <a className="btn-secondary" href={chatUrlForTask(task._id)} onClick={(e) => openTaskChat(e, task._id)} title="يفتح محادثتك الخاصة بهذه المهمة: نطاقها مساحة المهمة، وسياقها تعليمات المساحة ونص المهمة">
                  <Icon name="bot" size={15} /> اعمل عليها مع المساعد
                </a>
              )}
              {back.map((s) => (
                <button key={s} className="btn-ghost" disabled={busy} onClick={() => run(() => setStatus({ taskId: task._id, status: s }))}>
                  {moveLabel(task.status, s)}
                </button>
              ))}
            </div>
            {error && <p className="alert-negative">{error}</p>}
          </div>

          <Section title="التعليقات" count={task.comments.length}>
            {task.comments.length === 0 && <div className="text-sm text-faint">لا تعليقات بعد.</div>}
            <ul className="space-y-3">
              {task.comments.map((c) => (
                <li key={c._id} className="flex gap-2.5">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-active text-xs font-medium">{(c.authorName ?? "؟").charAt(0)}</span>
                  <div className="min-w-0 flex-1 rounded-xl rounded-ss-sm bg-sunken px-3 py-2 text-sm">
                    <div className="mb-0.5 flex items-center gap-2 text-xs">
                      <span className="font-medium">{c.authorName}</span>
                      <span className="text-faint">{formatDate(c.createdAt)}</span>
                    </div>
                    <div className="whitespace-pre-wrap leading-6">{c.body}</div>
                  </div>
                </li>
              ))}
            </ul>
            {task.canComment && (
              <CommentBox
                taskId={task._id}
                busy={busy}
                text={text}
                setText={setText}
                onSend={(mentions) =>
                  run(async () => {
                    await comment({ taskId: task._id, body: text, mentions });
                    setText("");
                  })
                }
              />
            )}
          </Section>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-6">
          <section className="card divide-y divide-rule text-sm">
            <Fact label="الحالة">
              <Pill status={task.status} />
            </Fact>
            <Fact label={task.assignees.length > 1 ? "المسؤولون" : "المسؤول"}>
              <AssigneeNames assignees={task.assignees} />
            </Fact>
            <Fact label="الأولوية">
              <span className={PRIORITY[task.priority]?.tone}>{PRIORITY[task.priority]?.label}</span>
            </Fact>
            <Fact label="الموعد">{task.due ? <Due due={task.due} status={task.status} /> : <span className="text-faint">—</span>}</Fact>
            <Fact label="أنشأها">
              <span className="text-muted">
                {task.createdByName ?? "—"} · {formatDate(task.createdAt)}
              </span>
            </Fact>
            {task.canManage && (
              <div className="space-y-2 p-3">
                <div className="meta">إدارة المهمة</div>
                <ManageTask task={task} />
                <button className="btn-ghost w-full justify-center text-negative" disabled={busy} onClick={() => void ask("حذف المهمة وتعليقاتها؟", { danger: true, confirmLabel: "حذف" }).then((ok) => { if (ok) void run(async () => (await remove({ taskId: task._id }), onClose())); })}>
                  حذف المهمة
                </button>
              </div>
            )}
          </section>

          <Section
            title="المرفقات"
            count={task.links.length}
            action={
              task.canAttach && (
                <span className="flex gap-1">
                  <button className={`btn-ghost h-7 px-2 text-xs ${picking === "file" ? "bg-active" : ""}`} onClick={() => setPicking(picking === "file" ? "" : "file")}>
                    + ملف
                  </button>
                  <button className={`btn-ghost h-7 px-2 text-xs ${picking === "artifact" ? "bg-active" : ""}`} onClick={() => setPicking(picking === "artifact" ? "" : "artifact")}>
                    + مخرج
                  </button>
                </span>
              )
            }
          >
            {picking === "file" && <FilePicker spaceId={task.spaceId} exclude={task.links.map((l) => l.id)} onPick={(id) => run(async () => (await addLink({ taskId: task._id, type: "file", id }), setPicking("")))} />}
            {picking === "artifact" && <ArtifactPicker spaceId={task.spaceId} exclude={task.links.map((l) => l.id)} onPick={(id) => run(async () => (await addLink({ taskId: task._id, type: "artifact", id }), setPicking("")))} />}
            {task.links.length === 0 && !picking && <div className="text-sm text-faint">لا مرفقات.</div>}
            <ul className="space-y-1">
              {task.links.map((l) => (
                <li key={l.type + l.id} className="group flex items-center gap-2 rounded-lg px-1 py-1 text-sm hover:bg-sunken">
                  <Icon name={l.type === "file" ? "file" : "panel"} size={15} className="shrink-0 text-muted" />
                  {l.available ? (
                    <button
                      className="min-w-0 flex-1 truncate text-start hover:underline"
                      title={l.addedByName ? `أضافه ${l.addedByName}` : undefined}
                      onClick={() => (l.type === "file" ? run(async () => window.open(await requestDownload({ fileId: l.id as any, inline: true }), "_blank", "noopener")) : setOpenArtifact(l.id))}
                    >
                      {l.name}
                      {l.sensitive && <span className="ms-1 text-xs text-negative">(حسّاس)</span>}
                    </button>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-faint">غير متاح (نُقل أو حُذف)</span>
                  )}
                  {task.canAttach && (
                    <button className="btn-icon h-7 w-7 opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label={`إزالة ${l.name}`} onClick={() => run(() => removeLink({ taskId: task._id, type: l.type, id: l.id }))}>
                      <Icon name="x" size={13} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {openArtifact && <ArtifactDock key={openArtifact} artifactId={openArtifact} spaces={spaces ?? []} onClose={() => setOpenArtifact(null)} mode="overlay" />}
          </Section>
        </aside>
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <span className="w-20 shrink-0 text-xs text-muted">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/**
 * A comment with "@" for people: typing @ lists the task space's members who can see the task
 * (mentions:people). A mentioned person is notified and finds it in "الإشارات". Enter sends.
 */
function CommentBox({ taskId, busy, text, setText, onSend }: { taskId: string; busy: boolean; text: string; setText: (t: string) => void; onSend: (mentions: string[]) => void }) {
  const [query, setQuery] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ userId: string; name: string }[]>([]);
  const [active, setActive] = useState(0);
  const people = useQuery(api.mentions.people, query !== null ? { taskId, q: query } : "skip") ?? [];
  const pick = (p: { userId: string; name: string }) => {
    setText(text.replace(/@([^\s@]{0,40})$/, `@${p.name} `));
    setPicked((ps) => (ps.some((x) => x.userId === p.userId) ? ps : [...ps, p]));
    setQuery(null);
  };
  const send = () => {
    if (!text.trim() || busy) return;
    onSend(picked.filter((p) => text.includes(`@${p.name}`)).map((p) => p.userId));
    setPicked([]);
  };
  return (
    <div className="relative">
      {query !== null && people.length > 0 && (
        <ul className="absolute inset-x-0 bottom-full z-20 mb-1 max-h-60 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)]" role="listbox" aria-label="أشخاص">
          {people.map((p, i) => (
            <li key={p.userId}>
              <button
                role="option"
                aria-selected={i === active}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-start text-sm ${i === active ? "bg-active" : "hover:bg-active"}`}
                onMouseDown={(e) => (e.preventDefault(), pick(p))}
              >
                <span className="grid h-6 w-6 place-items-center rounded-full bg-active text-xs">{p.name.charAt(0)}</span>
                <span className="flex-1 truncate">{p.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          className="input flex-1"
          value={text}
          aria-label="تعليق"
          onChange={(e) => {
            setText(e.target.value);
            const m = /(^|\s)@([^\s@]{0,40})$/.exec(e.target.value.slice(0, e.target.selectionStart ?? e.target.value.length));
            setQuery(m ? m[2]! : null);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (query === null || !people.length) return;
            if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => (a + 1) % people.length));
            else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => (a - 1 + people.length) % people.length));
            else if (e.key === "Enter" || e.key === "Tab") (e.preventDefault(), pick(people[active]!));
            else if (e.key === "Escape") setQuery(null);
          }}
          placeholder="اكتب تعليقاً… (@ للإشارة إلى زميل)"
          maxLength={5000}
        />
        <button className="btn-primary" disabled={busy || !text.trim()} aria-label="إرسال">
          <Icon name="send" size={16} />
        </button>
      </form>
    </div>
  );
}

function Section({ title, count, action, children }: { title: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="card space-y-3 p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {!!count && <span className="num text-xs text-faint">{count}</span>}
        <span className="ms-auto">{action}</span>
      </div>
      {children}
    </section>
  );
}

/** Files of the task's own space only: the server refuses anything else anyway. */
function FilePicker({ spaceId, exclude, onPick }: { spaceId: string; exclude: string[]; onPick: (fileId: string) => void }) {
  const files = useQuery(api.files.list, { spaceId: spaceId as any });
  const choices = (files ?? []).filter((f) => !exclude.includes(f._id));
  return (
    <div className="rounded-lg border border-line p-2">
      <div className="mb-1 text-xs text-muted">ملفات هذه المساحة (ارفع المخرج في المساحة أولاً من تبويب الملفات)</div>
      {files && choices.length === 0 && <div className="text-xs text-faint">لا ملفات أخرى.</div>}
      <div className="flex flex-wrap gap-1">
        {choices.map((f) => <button key={f._id} className="btn-ghost border border-line text-xs" onClick={() => onPick(f._id)}>{f.name}</button>)}
      </div>
    </div>
  );
}

/** Outputs (Phase 4 artifacts) of this space only; the server checks the space again on add and on read. */
function ArtifactPicker({ spaceId, exclude, onPick }: { spaceId: string; exclude: string[]; onPick: (artifactId: string) => void }) {
  const artifacts = useQuery(api.artifacts.list, { spaceId: spaceId as any });
  const choices = (artifacts ?? []).filter((a) => !exclude.includes(a._id));
  return (
    <div className="rounded-lg border border-line p-2">
      <div className="mb-1 text-xs text-muted">مخرجات هذه المساحة</div>
      {artifacts && choices.length === 0 && <div className="text-xs text-faint">لا مخرجات أخرى.</div>}
      <div className="flex flex-wrap gap-1">
        {choices.map((a) => <button key={a._id} className="btn-ghost border border-line text-xs" onClick={() => onPick(a._id)}>{a.title}</button>)}
      </div>
    </div>
  );
}

function ManageTask({ task }: { task: { _id: string; spaceId: string; assigneeIds: string[]; assignees: Assignee[]; priority: string; due: number | null } }) {
  const people = useQuery(api.tasks.assignees, { spaceId: task.spaceId as any });
  const assign = useMutation(api.tasks.assign);
  const update = useMutation(api.tasks.update);
  const [error, setError] = useState("");
  const wrap = (p: Promise<unknown>) => p.catch((e) => setError(errorText(e)));
  return (
    <div className="grid gap-2 text-xs">
      <AssigneePicker
        people={people}
        value={task.assigneeIds}
        extra={task.assignees}
        onChange={(next) => {
          setError("");
          if (!next.length) return setError("يبقى مسؤول واحد على الأقل");
          void wrap(assign({ taskId: task._id as any, assigneeIds: next as any }));
        }}
      />
      <select className="input w-full text-xs" aria-label="الأولوية" value={task.priority} onChange={(e) => wrap(update({ taskId: task._id as any, priority: e.target.value as any }))}>
        {Object.entries(PRIORITY).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
      </select>
      <input
        className="input w-full text-xs"
        aria-label="الموعد"
        type="date"
        value={task.due ? new Date(task.due).toISOString().slice(0, 10) : ""}
        onChange={(e) => wrap(update({ taskId: task._id as any, due: e.target.value ? new Date(e.target.value + "T23:59:00").getTime() : null }))}
      />
      {error && <span className="text-negative">{error}</span>}
    </div>
  );
}
