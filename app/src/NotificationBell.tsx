// The in-app bell: live unread count and feed from notifications.ts (my own feed only). A task
// notification opens the task; a scheduled task's result opens its chat.

import { useState } from "react";
import { useMutation, useQuery } from "onebase/react";
import { api } from "./lib";
import { Icon } from "./icons";
import { relTime } from "./ChatView";

export function NotificationBell({ go }: { go: (path: string) => void }) {
  const unread = useQuery(api.notifications.unreadCount) ?? 0;
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button className="btn-ghost relative w-9 px-0" title="الإشعارات" aria-label={`الإشعارات (${unread} غير مقروءة)`} onClick={() => setOpen(!open)}>
        <Icon name="bell" size={18} />
        {unread > 0 && <span className="absolute end-0.5 top-0.5 min-w-4 rounded-full bg-negative px-1 text-center text-[11px] leading-4 text-white num">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && <Feed onClose={() => setOpen(false)} go={go} />}
    </div>
  );
}

function Feed({ onClose, go }: { onClose: () => void; go: (path: string) => void }) {
  const items = useQuery(api.notifications.list, {});
  const markAllRead = useMutation(api.notifications.markAllRead);
  return (
    <div className="fixed inset-x-2 top-14 z-30 overflow-hidden rounded-lg border border-line bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.08)] lg:absolute lg:inset-x-auto lg:end-auto lg:start-0 lg:top-10 lg:w-80">
      <div className="flex items-center justify-between border-b border-rule px-3 py-2">
        <span className="text-sm font-medium">الإشعارات</span>
        <button className="btn-ghost h-8 px-2 text-xs" onClick={() => void markAllRead({})}>
          تعليم الكل كمقروء
        </button>
      </div>
      <ul className="max-h-96 overflow-y-auto">
        {items === undefined && <li className="p-3 text-xs text-muted">جارٍ التحميل…</li>}
        {items?.length === 0 && <li className="p-3 text-xs text-muted">لا إشعارات.</li>}
        {items?.map((n) => (
          <li key={n.id}>
            <button
              className="block w-full border-b border-rule px-3 py-2 text-start text-sm hover:bg-active"
              onClick={() => {
                if (n.threadId) go(`/chat/${n.threadId}`);
                else if (n.scheduleId) go("/schedules");
                else if (n.taskId) go(`/tasks/${n.taskId}`);
                else if (n.spaceId) go(`/space/${n.spaceId}`);
                onClose();
              }}
            >
              <div className="flex items-start gap-2">
                {!n.read && <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-ink" aria-label="غير مقروء" />}
                <div className="min-w-0 flex-1">
                  <div className={n.read ? "" : "font-medium"}>{n.title}</div>
                  {n.body && <div className="truncate text-xs text-muted">{n.body}</div>}
                  <div className="text-xs text-muted">{relTime(n.createdAt)}</div>
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
