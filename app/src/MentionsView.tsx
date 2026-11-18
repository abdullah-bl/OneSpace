// "الإشارات": where colleagues mentioned me in task comments (mentions.ts). Shown only while I can
// still see the task; opening one marks it read and opens the task.

import { useMutation, useQuery } from "onebase/react";
import { api } from "./lib";
import { Page, relTime } from "./ChatView";

export function MentionsPage({ go }: { go: (path: string) => void }) {
  const items = useQuery(api.mentions.inbox, {});
  const markRead = useMutation(api.mentions.markRead);
  const unread = (items ?? []).filter((m) => !m.read).length;
  return (
    <Page
      title="الإشارات"
      sub={items ? (unread ? `${unread} غير مقروءة من ${items.length}` : `${items.length} إشارة، كلها مقروءة`) : " "}
      actions={
        unread > 0 && (
          <button className="btn-secondary" onClick={() => void markRead({})}>
            تعليم الكل كمقروء
          </button>
        )
      }
    >
      <ul className="max-w-[760px]">
        {items === undefined && <li className="py-3 text-sm text-muted">جارٍ التحميل…</li>}
        {items?.length === 0 && (
          <li className="rounded-lg border border-dashed border-control p-4 text-sm text-muted">لم يُشر إليك أحد بعد. حين يكتب زميل @اسمك في تعليق على مهمة، تظهر هنا.</li>
        )}
        {items?.map((m) => (
          <li key={m.id}>
            <button
              className="flex w-full items-start gap-3 border-b border-rule px-2 py-3 text-start hover:bg-[#fbfbfa]"
              onClick={() => {
                if (!m.read) void markRead({ ids: [m.id] });
                go(`/tasks/${m.taskId}`);
              }}
            >
              <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${m.read ? "bg-transparent" : "bg-ink"}`} aria-label={m.read ? undefined : "غير مقروءة"} />
              <span className="min-w-0 flex-1">
                <span className={`block ${m.read ? "" : "font-medium"}`}>
                  {m.by ?? "زميل"} أشار إليك في «{m.taskTitle}»
                </span>
                <span className="mt-0.5 block text-sm text-[#3d3d3d]">{m.excerpt}</span>
                <span className="mt-0.5 block text-xs text-muted">{m.spaceName}</span>
              </span>
              <span className="shrink-0 text-xs text-muted num">{relTime(m.createdAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Page>
  );
}
