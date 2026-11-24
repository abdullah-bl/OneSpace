// «اعمل عليها مع المساعد» opened an empty chat: the employee didn't know whether the assistant had
// started or was waiting for them. Now a task's chat opens on the task (what, where, by when) with a
// request already written in the box from the task itself, which they can edit and send, and a few
// other ready requests to pick instead. Nothing is sent on its own.

import { Icon } from "./icons";
import { STATUS, PRIORITY } from "./TasksView";

export type TaskInfo = { _id: string; title: string; body: string | null; status: string; priority: string; due: number | null; spaceName: string; mine: boolean; manages: boolean };

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Ready requests for this task, the first one written into the box. */
export function taskDrafts(t: TaskInfo): { label: string; text: string }[] {
  const brief = t.body ? `\nالمطلوب: ${t.body}` : "";
  const due = t.due ? `\nالموعد: ${day(t.due)}` : "";
  const out = [
    {
      label: "ابدأ معي",
      text: `أعمل على المهمة «${t.title}» في «${t.spaceName}».${brief}${due}\nساعدني أبدأ: ضع خطة مختصرة بالخطوات، واذكر ما يلزمني من ملفات المساحة، ثم جهّز أول مسودة لما هو مطلوب.`,
    },
    { label: "خطة بالخطوات", text: `ضع خطة عمل بالخطوات لإنجاز المهمة «${t.title}»${t.due ? ` قبل ${day(t.due)}` : ""}، مع من يفعل ماذا وما يلزم من ملفات المساحة.${brief}` },
    { label: "مسودة المطلوب", text: `جهّز مسودة أولى لما تطلبه المهمة «${t.title}» كمخرج أعدّله بعدها.${brief}` },
    { label: "الملفات ذات الصلة", text: `ما الملفات في «${t.spaceName}» المتعلقة بالمهمة «${t.title}»؟ لخّص المهم منها مع المصادر.` },
  ];
  if (t.manages) out.push({ label: "وضع المهمة", text: `وش وضع المهمة «${t.title}»؟ لخّص حالتها والتعليقات والمرفقات وما بقي عليها.` });
  return out;
}

/** The task at the top of its chat until the first question is sent. */
export function TaskStart({ task, picked, onPick }: { task: TaskInfo; picked: number; onPick: (i: number) => void }) {
  const drafts = taskDrafts(task);
  const st = STATUS[task.status];
  const pr = PRIORITY[task.priority];
  return (
    <div className="animate-rise space-y-4">
      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="flex items-center gap-2 text-xs text-muted">
          <Icon name="tasks" size={14} /> مهمة في «{task.spaceName}»
          <a href={`#/tasks/${task._id}`} className="ms-auto text-primary hover:underline">
            افتح المهمة
          </a>
        </div>
        <h2 className="mt-1.5 text-lg font-bold leading-snug" dir="auto">
          {task.title}
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          {st && <span className={`rounded-full px-2 py-0.5 ${st.tone}`}>{st.label}</span>}
          {pr && task.priority !== "normal" && <span className={`rounded-full px-2 py-0.5 ${pr.tone}`}>{pr.label}</span>}
          {task.due && <span className="rounded-full bg-raised px-2 py-0.5 text-muted num">الموعد {day(task.due)}</span>}
          {task.mine && <span className="rounded-full bg-raised px-2 py-0.5 text-muted">مسندة إليك</span>}
        </div>
        {task.body && (
          <p className="mt-3 line-clamp-4 whitespace-pre-wrap text-sm leading-7 text-muted" dir="auto">
            {task.body}
          </p>
        )}
      </div>
      <div>
        <p className="text-sm text-muted">المساعد لم يبدأ بعد. كتبنا لك طلباً من المهمة في الصندوق أدناه: عدّله كما تريد ثم أرسله، أو اختر طلباً آخر.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {drafts.map((d, i) => (
            <button
              key={d.label}
              className={`flex h-8 items-center rounded-full border px-3 text-sm transition-colors ${i === picked ? "border-ink bg-active text-ink" : "border-line text-muted hover:border-control hover:text-ink"}`}
              aria-pressed={i === picked}
              onClick={() => onPick(i)}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
