// "الإشارات": where colleagues mentioned me (mentions.ts): in a task comment (shown while I can
// still see the task; opens the task) or in their chat of a shared space (only that message's
// text, shown while I can still read the space; opens the space, never their private chat).

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
          <li className="rounded-lg border border-dashed border-control p-4 text-sm text-muted">لم يُشر إليك أحد بعد. حين يكتب زميل @اسمك في تعليق على مهمة أو في محادثة داخل مساحة مشتركة، تظهر هنا.</li>
        )}
        {items?.map((m) => (
          <li key={m.id}>
            <button
              className="flex w-full items-start gap-3 border-b border-rule px-2 py-3 text-start hover:bg-sunken"
              onClick={() => {
                if (!m.read) void markRead({ ids: [m.id] });
                go(m.source === "chat" ? `/space/${m.spaceId}` : `/tasks/${m.taskId}`);
              }}
            >
              <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${m.read ? "bg-transparent" : "bg-ink"}`} aria-label={m.read ? undefined : "غير مقروءة"} />
              <span className="min-w-0 flex-1">
                <span className={`block ${m.read ? "" : "font-medium"}`}>
                  {m.source === "chat" ? <>{m.by ?? "زميل"} أشار إليك في محادثة</> : <>{m.by ?? "زميل"} أشار إليك في «{m.taskTitle}»</>}
                </span>
                <span className="mt-0.5 block whitespace-pre-line text-sm text-ink">{m.excerpt}</span>
                <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                  <span className="badge">{m.source === "chat" ? "محادثة" : "مهمة"}</span>
                  {m.spaceName}
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted num">{relTime(m.createdAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Page>
  );
}
