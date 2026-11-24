// The home screen under the question box: what's waiting for me and what I worked on, so I can
// pick it up without hunting through the menu. Open tasks first (they have dates), then my lists,
// the latest scheduled runs and my latest work. A card with nothing in it isn't shown, so a new
// employee sees only the question box and the suggestions.

import type { ReactNode } from "react";
import { useQuery } from "onebase/react";
import { Icon, type IconName } from "./icons";
import { api } from "./lib";
import { relTime } from "./ChatView";
import { STATUS } from "./TasksView";

const SHOWN = 4;
const DAY = 86_400_000;
const KIND: Record<string, { label: string; icon: IconName }> = {
  markdown: { label: "مستند", icon: "file" },
  html: { label: "صفحة", icon: "code" },
  table: { label: "جدول", icon: "table" },
  app: { label: "تطبيق", icon: "code" },
  slides: { label: "عرض شرائح", icon: "play" },
  image: { label: "صورة", icon: "file" },
};

/** «فارغة / صف واحد / صفّان / 3 صفوف / 11 صفاً»: a list's size as Arabic counts it. */
const rowsAr = (n: number) => (n === 0 ? "فارغة" : n === 1 ? "صف واحد" : n === 2 ? "صفّان" : n <= 10 ? `${n} صفوف` : `${n} صفاً`);

/** «متأخرة يومين», «اليوم», «غداً», «بعد ٣ أيام»: the due date as it matters today. */
function dueWords(due: number): { text: string; late: boolean } {
  const start = (t: number) => new Date(new Date(t).toDateString()).getTime();
  const n = Math.round((start(due) - start(Date.now())) / DAY);
  if (n < 0) return { text: n === -1 ? "متأخرة يوماً" : n === -2 ? "متأخرة يومين" : `متأخرة ${-n} أيام`, late: true };
  if (n === 0) return { text: "اليوم", late: true };
  if (n === 1) return { text: "غداً", late: false };
  return { text: n === 2 ? "بعد يومين" : `بعد ${n} أيام`, late: false };
}

function Card({ icon, title, count, all, children }: { icon: IconName; title: string; count?: number; all: { href: string; label: string }; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-line bg-surface">
      <header className="flex items-center gap-2 px-4 pt-3 pb-1">
        <Icon name={icon} size={15} className="text-muted" />
        <h2 className="text-sm font-medium">{title}</h2>
        {count !== undefined && <span className="meta num">{count}</span>}
        <a href={all.href} className="ms-auto text-xs text-muted hover:text-ink">
          {all.label}
        </a>
      </header>
      <ul className="px-1.5 pb-1.5">{children}</ul>
    </section>
  );
}

function Row({ href, onClick, icon, title, meta, tone }: { href?: string; onClick?: () => void; icon: IconName; title: string; meta: ReactNode; tone?: string }) {
  const body = (
    <>
      <Icon name={icon} size={14} className="mt-0.5 shrink-0 text-faint" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm" dir="auto">
          {title}
        </span>
        <span className={`block truncate text-xs ${tone ?? "text-muted"}`}>{meta}</span>
      </span>
    </>
  );
  const cls = "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-start transition-colors hover:bg-sunken";
  return <li>{href ? <a href={href} className={cls}>{body}</a> : <button className={cls} onClick={onClick}>{body}</button>}</li>;
}

export function HomeCards({ onOpenArtifact }: { onOpenArtifact: (id: string) => void }) {
  const tasks = useQuery(api.tasks.mine) as { _id: string; title: string; status: string; due: number | null; spaceName: string }[] | undefined;
  const lists = useQuery(api.lists.recent) as { _id: string; title: string; rowCount: number; spaceName: string; updatedAt: number }[] | undefined;
  const schedules = useQuery(api.schedules.mine) as { _id: string; title: string; lastRunAt: number | null; lastStatus: string | null; threadId?: string; spaceName: string | null }[] | undefined;
  const works = useQuery(api.artifacts.mine, {}) as { _id: string; title: string; kind: string; spaceName: string; updatedAt: number }[] | undefined;

  // Open first, the late and soonest at the top; undated after them.
  const open = (tasks ?? []).filter((t) => t.status !== "done").sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity));
  const runs = (schedules ?? []).filter((s) => s.lastRunAt).sort((a, b) => b.lastRunAt! - a.lastRunAt!);
  const recentLists = lists ?? [];
  const recentWork = works ?? [];
  if (!open.length && !runs.length && !recentLists.length && !recentWork.length) return null;

  return (
    <div className="mt-8 grid gap-3 sm:grid-cols-2 animate-fade">
      {open.length > 0 && (
        <Card icon="tasks" title="مهامي المفتوحة" count={open.length} all={{ href: "#/tasks", label: "كل المهام" }}>
          {open.slice(0, SHOWN).map((t) => {
            const due = t.due ? dueWords(t.due) : null;
            return (
              <Row
                key={t._id}
                href={`#/tasks/${t._id}`}
                icon="tasks"
                title={t.title}
                tone={due?.late ? "text-negative" : undefined}
                meta={[STATUS[t.status]?.label ?? t.status, due?.text, t.spaceName].filter(Boolean).join(" · ")}
              />
            );
          })}
        </Card>
      )}
      {recentLists.length > 0 && (
        <Card icon="table" title="قوائمي" all={{ href: "#/lists", label: "كل القوائم" }}>
          {recentLists.slice(0, SHOWN).map((l) => (
            <Row key={l._id} href={`#/list/${l._id}`} icon="table" title={l.title} meta={`${rowsAr(l.rowCount)} · ${l.spaceName} · ${relTime(l.updatedAt)}`} />
          ))}
        </Card>
      )}
      {runs.length > 0 && (
        <Card icon="clock" title="آخر التشغيلات المجدولة" all={{ href: "#/schedules", label: "المجدولة" }}>
          {runs.slice(0, SHOWN).map((r) => (
            <Row
              key={r._id}
              href={r.threadId ? `#/chat/${r.threadId}` : "#/schedules"}
              icon="clock"
              title={r.title}
              tone={r.lastStatus === "failed" ? "text-negative" : undefined}
              meta={[r.lastStatus === "failed" ? "تعذّر آخر تشغيل" : r.lastStatus === "running" ? "يعمل الآن" : "نجح", relTime(r.lastRunAt!), r.spaceName].filter(Boolean).join(" · ")}
            />
          ))}
        </Card>
      )}
      {recentWork.length > 0 && (
        <Card icon="file" title="أعمالي الأخيرة" all={{ href: "#/works", label: "كل الأعمال" }}>
          {recentWork.slice(0, SHOWN).map((w) => (
            <Row key={w._id} onClick={() => onOpenArtifact(w._id)} icon={KIND[w.kind]?.icon ?? "file"} title={w.title} meta={`${KIND[w.kind]?.label ?? "مخرج"} · ${w.spaceName} · ${relTime(w.updatedAt)}`} />
          ))}
        </Card>
      )}
    </div>
  );
}
