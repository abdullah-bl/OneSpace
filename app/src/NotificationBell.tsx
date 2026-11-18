// The in-app bell: live unread count and feed from notifications.ts (my own feed only).

import { useState } from "react";
import { useMutation, useQuery } from "onebase/react";
import { api, formatDate } from "./lib";

export function NotificationBell({ onOpenTask }: { onOpenTask: (taskId: string) => void }) {
  const unread = useQuery(api.notifications.unreadCount) ?? 0;
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button className="btn-ghost relative px-2" title="الإشعارات" aria-label={`الإشعارات (${unread} غير مقروءة)`} onClick={() => setOpen(!open)}>
        🔔
        {unread > 0 && <span className="absolute -top-1 -start-1 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] leading-4 text-white">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && <Feed onClose={() => setOpen(false)} onOpenTask={onOpenTask} />}
    </div>
  );
}

function Feed({ onClose, onOpenTask }: { onClose: () => void; onOpenTask: (taskId: string) => void }) {
  const items = useQuery(api.notifications.list, {});
  const markAllRead = useMutation(api.notifications.markAllRead);
  return (
    <div className="card absolute start-0 top-9 z-20 w-80 overflow-hidden shadow-lg">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
        <span className="text-sm font-semibold">الإشعارات</span>
        <button className="btn-ghost px-1 text-xs" onClick={() => void markAllRead({})}>تعليم الكل كمقروء</button>
      </div>
      <ul className="max-h-96 overflow-y-auto">
        {items === undefined && <li className="p-3 text-xs text-slate-400">جارٍ التحميل…</li>}
        {items?.length === 0 && <li className="p-3 text-xs text-slate-400">لا إشعارات.</li>}
        {items?.map((n) => (
          <li key={n.id}>
            <button
              className={`block w-full border-b border-slate-50 px-3 py-2 text-start text-sm hover:bg-slate-50 ${n.read ? "text-slate-500" : "bg-teal-50/50"}`}
              onClick={() => {
                if (n.taskId) onOpenTask(n.taskId);
                onClose();
              }}
            >
              <div className={n.read ? "" : "font-semibold"}>{n.title}</div>
              {n.body && <div className="truncate text-xs text-slate-500">{n.body}</div>}
              <div className="text-[10px] text-slate-400">{formatDate(n.createdAt)}</div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
