// Phase 3 UI: "مهامي" (my tasks across all my spaces), a per-space task board, and the task
// detail panel. Every permission decision is the server's (tasks.ts); the flags it returns
// (canManage, isAssignee, canAttach, nextStatuses) only decide which buttons to show.

import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "onebase/react";
import { ArtifactPanel } from "./ArtifactPanel";
import { api, errorText, formatDate, type SpaceInfo } from "./lib";
import { Page } from "./ChatView";
import { SchedulesPanel } from "./SchedulesView";

export const STATUS: Record<string, { label: string; tone: string }> = {
  new: { label: "جديدة", tone: "bg-neutral-100 text-neutral-700" },
  inProgress: { label: "قيد العمل", tone: "bg-neutral-100 text-neutral-800" },
  review: { label: "مراجعة", tone: "bg-amber-100 text-amber-800" },
  done: { label: "منجزة", tone: "bg-emerald-100 text-emerald-800" },
};
const STATUS_ORDER = ["new", "inProgress", "review", "done"] as const;

export const PRIORITY: Record<string, { label: string; tone: string }> = {
  low: { label: "منخفضة", tone: "text-neutral-500" },
  normal: { label: "عادية", tone: "text-neutral-700" },
  high: { label: "عالية", tone: "text-orange-700" },
  urgent: { label: "عاجلة", tone: "text-red-700 font-semibold" },
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
  assigneeName: string | null;
  assigneeActive: boolean;
  linkCount: number;
};

function Pill({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "bg-neutral-100" };
  return <span className={`rounded-full px-2 py-0.5 text-xs ${s.tone}`}>{s.label}</span>;
}

function Due({ due, status }: { due: number | null; status: string }) {
  if (!due) return null;
  const late = status !== "done" && due < Date.now();
  return <span className={`text-xs ${late ? "font-semibold text-red-700" : "text-neutral-500"}`}>{new Date(due).toLocaleDateString("ar-SA-u-nu-latn")}</span>;
}

function TaskCard({ t, showSpace, onOpen }: { t: TaskRow; showSpace?: boolean; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="card block w-full space-y-1 p-3 text-start hover:border-neutral-400">
      <div className="flex items-start justify-between gap-2">
        <span className="font-semibold">{t.title}</span>
        <span className={`shrink-0 text-xs ${PRIORITY[t.priority]?.tone ?? ""}`}>{PRIORITY[t.priority]?.label}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        {showSpace && <span>{t.spaceName}</span>}
        {!showSpace && <span className={t.assigneeActive ? "" : "text-red-700"}>{t.assigneeName ?? "—"}{!t.assigneeActive && " (لم يعد عضواً)"}</span>}
        <Due due={t.due} status={t.status} />
        {t.linkCount > 0 && <span>{t.linkCount}</span>}
      </div>
    </button>
  );
}

/**
 * "المهام" (UX redesign): one page — tasks assigned to me, tasks by space, and my scheduled tasks
 * (SchedulesView.tsx). A task id in the address opens its detail.
 */
export function TasksPage({ tab, taskId, go, spaces }: { tab: "mine" | "scheduled"; taskId: string | null; go: (p: string) => void; spaces: SpaceInfo[] }) {
  const [view, setView] = useState<"mine" | "spaces">("mine");
  if (taskId)
    return (
      <div className="mx-auto w-full max-w-[1100px] px-4 py-6 lg:px-8 lg:py-9">
        <TaskDetail taskId={taskId} onClose={() => go("/tasks")} />
      </div>
    );
  const taskSpaces = spaces.filter((s) => s.kind === "shared" && ["manager", "member", "reader"].includes(s.myRole));
  return (
    <Page title="المهام">
      <nav className="-mt-2 mb-6 flex gap-1 border-b border-line" aria-label="أقسام المهام">
        {[
          { id: "mine", label: "مسندة إليّ", on: tab === "mine" && view === "mine", go: () => (setView("mine"), tab !== "mine" && go("/tasks")) },
          { id: "spaces", label: "حسب المساحة", on: tab === "mine" && view === "spaces", go: () => (setView("spaces"), tab !== "mine" && go("/tasks")) },
          { id: "scheduled", label: "المجدولة", on: tab === "scheduled", go: () => go("/schedules") },
        ].map((t) => (
          <button key={t.id} onClick={t.go} className={`-mb-px border-b-2 px-3 py-2 text-sm ${t.on ? "border-ink font-medium" : "border-transparent text-muted hover:text-ink"}`} aria-current={t.on ? "page" : undefined}>
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "scheduled" ? (
        <SchedulesPanel spaces={spaces} />
      ) : view === "mine" ? (
        <MyTasksView openTaskId={null} onOpenTask={(id) => go(id ? `/tasks/${id}` : "/tasks")} />
      ) : (
        <div className="space-y-8">
          {taskSpaces.length === 0 && <p className="rounded-lg border border-dashed border-control p-4 text-sm text-muted">لست عضواً مسمّى في أي مساحة مشتركة، فلا مهام تُعرض هنا.</p>}
          {taskSpaces.map((s) => (
            <section key={s._id}>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-medium">{s.name}</h2>
                <a href={`#/space/${s._id}/tasks`} className="ms-auto text-xs text-muted hover:text-ink">
                  لوحة المساحة
                </a>
              </div>
              <SpaceTaskList spaceId={s._id} go={go} />
            </section>
          ))}
        </div>
      )}
    </Page>
  );
}

function SpaceTaskList({ spaceId, go }: { spaceId: string; go: (p: string) => void }) {
  const tasks = useQuery(api.tasks.board, { spaceId: spaceId as any });
  const open = (tasks ?? []).filter((t) => t.status !== "done");
  if (tasks === undefined) return <p className="py-2 text-sm text-muted">جارٍ التحميل…</p>;
  if (!open.length) return <p className="py-2 text-sm text-muted">لا مهام مفتوحة.</p>;
  return (
    <ul className="mt-1">
      {open.map((t) => (
        <li key={t._id}>
          <button className="flex min-h-[48px] w-full items-center gap-3 border-b border-rule px-2 text-start hover:bg-[#fbfbfa]" onClick={() => go(`/tasks/${t._id}`)}>
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            <span className="hidden shrink-0 text-xs text-muted sm:block">{t.assigneeName ?? "—"}</span>
            <Pill status={t.status} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** "مهامي": everything assigned to me, grouped by status. */
export function MyTasksView({ openTaskId, onOpenTask }: { openTaskId: string | null; onOpenTask: (id: string | null) => void }) {
  const tasks = useQuery(api.tasks.mine);
  const [showDone, setShowDone] = useState(false);
  if (openTaskId) return <TaskDetail taskId={openTaskId} onClose={() => onOpenTask(null)} />;
  const open = (tasks ?? []).filter((t) => t.status !== "done");
  const done = (tasks ?? []).filter((t) => t.status === "done");
  return (
    <div className="space-y-4">
      {tasks === undefined && <div className="text-sm text-neutral-400">جارٍ التحميل…</div>}
      {tasks && open.length === 0 && <div className="card p-6 text-center text-sm text-neutral-500">لا مهام مفتوحة لك الآن.</div>}
      {STATUS_ORDER.filter((s) => s !== "done").map((s) => {
        const rows = open.filter((t) => t.status === s);
        if (!rows.length) return null;
        return (
          <section key={s} className="space-y-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><Pill status={s} /> {rows.length}</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {rows.map((t) => <TaskCard key={t._id} t={t} showSpace onOpen={() => onOpenTask(t._id)} />)}
            </div>
          </section>
        );
      })}
      {done.length > 0 && (
        <section className="space-y-2">
          <button className="btn-ghost px-0" onClick={() => setShowDone(!showDone)}>{showDone ? "▾" : "▸"} المنجزة ({done.length})</button>
          {showDone && <div className="grid gap-2 sm:grid-cols-2">{done.map((t) => <TaskCard key={t._id} t={t} showSpace onOpen={() => onOpenTask(t._id)} />)}</div>}
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
    <div className="space-y-3">
      {space.canManage && (creating ? <NewTaskForm space={space} onDone={() => setCreating(false)} /> : <button className="btn-primary" onClick={() => setCreating(true)}>مهمة جديدة</button>)}
      {tasks === undefined && <div className="text-sm text-neutral-400">جارٍ التحميل…</div>}
      {tasks && tasks.length === 0 && <div className="card p-6 text-center text-sm text-neutral-500">لا مهام في هذه المساحة بعد.</div>}
      {tasks && tasks.length > 0 && (
        <div className="grid gap-3 md:grid-cols-4">
          {STATUS_ORDER.map((s) => (
            <div key={s} className="space-y-2 rounded-lg bg-neutral-100/70 p-2">
              <div className="flex items-center gap-2 px-1 text-sm font-semibold"><Pill status={s} /> <span className="text-neutral-400">{tasks.filter((t) => t.status === s).length}</span></div>
              {tasks.filter((t) => t.status === s).map((t) => <TaskCard key={t._id} t={t} onOpen={() => setOpenId(t._id)} />)}
            </div>
          ))}
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
  return (
    <form
      className="card grid gap-2 p-4 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const due = String(fd.get("due") || "");
        setBusy(true);
        setError("");
        try {
          await create({
            spaceId: space._id as any,
            title: String(fd.get("title")),
            body: String(fd.get("body") || "") || undefined,
            assigneeId: String(fd.get("assignee")) as any,
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
      <input className="input sm:col-span-2" name="title" placeholder="عنوان المهمة" required maxLength={200} />
      <textarea className="input sm:col-span-2" name="body" placeholder="التفاصيل (اختياري)" rows={3} />
      <label className="text-xs text-neutral-500">
        المسؤول
        <select className="input mt-1 w-full" name="assignee" required defaultValue="">
          <option value="" disabled>اختر عضواً…</option>
          {(people ?? []).map((p) => <option key={p.userId} value={p.userId}>{p.name ?? p.userId}</option>)}
        </select>
      </label>
      <label className="text-xs text-neutral-500">
        الأولوية
        <select className="input mt-1 w-full" name="priority" defaultValue="normal">
          {Object.entries(PRIORITY).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
        </select>
      </label>
      <label className="text-xs text-neutral-500">
        الموعد (اختياري)
        <input className="input mt-1 w-full" type="date" name="due" />
      </label>
      <div className="flex items-end gap-2">
        <button className="btn-primary" disabled={busy}>إسناد</button>
        <button type="button" className="btn-ghost" onClick={onDone}>إلغاء</button>
      </div>
      {error && <p className="text-sm text-red-700 sm:col-span-2">{error}</p>}
      <p className="text-xs text-neutral-400 sm:col-span-2">تُسند المهمة لمدير أو عضو في هذه المساحة فقط، ويصله إشعار.</p>
    </form>
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

  if (task === undefined) return <div className="text-sm text-neutral-400">جارٍ التحميل…</div>;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <button className="btn-ghost px-0" onClick={onClose}>→ رجوع</button>
      <div className="card space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{task.title}</h1>
          <Pill status={task.status} />
          <span className={`text-xs ${PRIORITY[task.priority]?.tone ?? ""}`}>أولوية {PRIORITY[task.priority]?.label}</span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500">
          <span>{task.spaceName}</span>
          <span className={task.assigneeActive ? "" : "text-red-700"}>{task.assigneeName ?? "—"}{!task.assigneeActive && " (لم يعد عضواً)"}</span>
          <span>أنشأها {task.createdByName ?? "—"} · {formatDate(task.createdAt)}</span>
          <Due due={task.due} status={task.status} />
        </div>
        {task.body && <p className="whitespace-pre-wrap text-sm">{task.body}</p>}
        <div className="flex flex-wrap gap-2 border-t border-neutral-100 pt-3">
          {task.nextStatuses.map((s) => (
            <button key={s} className={s === "done" ? "btn-primary" : "btn-ghost border border-neutral-200"} disabled={busy} onClick={() => run(() => setStatus({ taskId: task._id, status: s }))}>
              {moveLabel(task.status, s)}
            </button>
          ))}
          {task.status !== "done" && (
            <a className="btn-ghost border border-neutral-400 text-neutral-900" href={chatUrlForTask(task._id)} onClick={(e) => openTaskChat(e, task._id)} title="يفتح محادثتك الخاصة بهذه المهمة: نطاقها مساحة المهمة، وسياقها تعليمات المساحة ونص المهمة">
              اعمل عليها مع الوكيل
            </a>
          )}
          {task.canManage && (
            <button className="btn-danger ms-auto" disabled={busy} onClick={() => confirm("حذف المهمة وتعليقاتها؟") && run(async () => { await remove({ taskId: task._id }); onClose(); })}>
              حذف
            </button>
          )}
        </div>
        {task.canManage && <ManageTask task={task} />}
        {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      </div>

      <Section
        title="المرفقات"
        action={
          task.canAttach && (
            <span className="flex gap-1">
              <button className="btn-ghost" onClick={() => setPicking(picking === "file" ? "" : "file")}>إرفاق ملف من المساحة</button>
              <button className="btn-ghost" onClick={() => setPicking(picking === "artifact" ? "" : "artifact")}>إرفاق مخرج</button>
            </span>
          )
        }
      >
        {picking === "file" && <FilePicker spaceId={task.spaceId} exclude={task.links.map((l) => l.id)} onPick={(id) => run(async () => { await addLink({ taskId: task._id, type: "file", id }); setPicking(""); })} />}
        {picking === "artifact" && <ArtifactPicker spaceId={task.spaceId} exclude={task.links.map((l) => l.id)} onPick={(id) => run(async () => { await addLink({ taskId: task._id, type: "artifact", id }); setPicking(""); })} />}
        {task.links.length === 0 && <div className="text-sm text-neutral-400">لا مرفقات.</div>}
        <ul className="space-y-1">
          {task.links.map((l) => (
            <li key={l.type + l.id} className="flex items-center gap-2 text-sm">
              <span>{l.type === "file" ? "" : ""}</span>
              {l.available ? (
                l.type === "file" ? (
                  <button className="text-neutral-900 hover:underline" onClick={() => run(async () => window.open(await requestDownload({ fileId: l.id as any, inline: true }), "_blank", "noopener"))}>{l.name}</button>
                ) : (
                  <button className="text-neutral-900 hover:underline" onClick={() => setOpenArtifact(l.id)}>
                    {l.name}
                    {l.sensitive && <span className="ms-1 text-xs text-red-700">(حسّاس)</span>}
                  </button>
                )
              ) : (
                <span className="text-neutral-400">غير متاح (نُقل خارج المساحة أو حُذف)</span>
              )}
              <span className="text-xs text-neutral-400">{l.addedByName}</span>
              {task.canAttach && <button className="btn-ghost ms-auto text-xs" onClick={() => run(() => removeLink({ taskId: task._id, type: l.type, id: l.id }))}>إزالة</button>}
            </li>
          ))}
        </ul>
        {openArtifact && <ArtifactPanel key={openArtifact} artifactId={openArtifact} spaces={spaces ?? []} onClose={() => setOpenArtifact(null)} />}
      </Section>

      <Section title="التعليقات">
        {task.comments.length === 0 && <div className="text-sm text-neutral-400">لا تعليقات.</div>}
        <ul className="space-y-2">
          {task.comments.map((c) => (
            <li key={c._id} className="rounded-lg bg-neutral-50 p-2 text-sm">
              <div className="text-xs text-neutral-500">{c.authorName} · {formatDate(c.createdAt)}</div>
              <div className="whitespace-pre-wrap">{c.body}</div>
            </li>
          ))}
        </ul>
        {task.canComment && (
          <CommentBox taskId={task._id} busy={busy} text={text} setText={setText} onSend={(mentions) => run(async () => { await comment({ taskId: task._id, body: text, mentions }); setText(""); })} />
        )}
      </Section>
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
                <span className="grid h-6 w-6 place-items-center rounded-full bg-[#e3e1dc] text-xs">{p.name.charAt(0)}</span>
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
        <button className="btn-primary" disabled={busy || !text.trim()}>
          إرسال
        </button>
      </form>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="card space-y-2 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
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
    <div className="rounded-lg border border-neutral-200 p-2">
      <div className="mb-1 text-xs text-neutral-500">ملفات هذه المساحة (ارفع المخرج في المساحة أولاً من تبويب الملفات)</div>
      {files && choices.length === 0 && <div className="text-xs text-neutral-400">لا ملفات أخرى.</div>}
      <div className="flex flex-wrap gap-1">
        {choices.map((f) => <button key={f._id} className="btn-ghost border border-neutral-200 text-xs" onClick={() => onPick(f._id)}>{f.name}</button>)}
      </div>
    </div>
  );
}

/** Outputs (Phase 4 artifacts) of this space only; the server checks the space again on add and on read. */
function ArtifactPicker({ spaceId, exclude, onPick }: { spaceId: string; exclude: string[]; onPick: (artifactId: string) => void }) {
  const artifacts = useQuery(api.artifacts.list, { spaceId: spaceId as any });
  const choices = (artifacts ?? []).filter((a) => !exclude.includes(a._id));
  return (
    <div className="rounded-lg border border-neutral-200 p-2">
      <div className="mb-1 text-xs text-neutral-500">مخرجات هذه المساحة</div>
      {artifacts && choices.length === 0 && <div className="text-xs text-neutral-400">لا مخرجات أخرى.</div>}
      <div className="flex flex-wrap gap-1">
        {choices.map((a) => <button key={a._id} className="btn-ghost border border-neutral-200 text-xs" onClick={() => onPick(a._id)}>{a.title}</button>)}
      </div>
    </div>
  );
}

function ManageTask({ task }: { task: { _id: string; spaceId: string; assigneeId: string; priority: string; due: number | null } }) {
  const people = useQuery(api.tasks.assignees, { spaceId: task.spaceId as any });
  const assign = useMutation(api.tasks.assign);
  const update = useMutation(api.tasks.update);
  const [error, setError] = useState("");
  const wrap = (p: Promise<unknown>) => p.catch((e) => setError(errorText(e)));
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-neutral-50 p-2 text-xs">
      <span className="text-neutral-500">إدارة:</span>
      <select className="input py-1 text-xs" value={task.assigneeId} onChange={(e) => wrap(assign({ taskId: task._id as any, assigneeId: e.target.value as any }))}>
        {!people?.some((p) => p.userId === task.assigneeId) && <option value={task.assigneeId}>— المسؤول الحالي —</option>}
        {(people ?? []).map((p) => <option key={p.userId} value={p.userId}>{p.name ?? p.userId}</option>)}
      </select>
      <select className="input py-1 text-xs" value={task.priority} onChange={(e) => wrap(update({ taskId: task._id as any, priority: e.target.value as any }))}>
        {Object.entries(PRIORITY).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
      </select>
      <input
        className="input py-1 text-xs"
        type="date"
        value={task.due ? new Date(task.due).toISOString().slice(0, 10) : ""}
        onChange={(e) => wrap(update({ taskId: task._id as any, due: e.target.value ? new Date(e.target.value + "T23:59:00").getTime() : null }))}
      />
      {error && <span className="text-red-700">{error}</span>}
    </div>
  );
}
