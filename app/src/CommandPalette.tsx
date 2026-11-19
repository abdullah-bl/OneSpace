// Global search (Ctrl+K / ⌘K, or «ابحث» in the sidebar): pages, help articles, and the caller's
// chats, spaces, files, tasks and skills (onebase/palette.ts), plus «اسأل المساعد» with the text.
// Arrow keys move, Enter opens, Escape closes.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "onebase/react";
import { api } from "./lib";
import { Icon, type IconName } from "./icons";
import { ADMIN_PAGES } from "./AdminConsole";
import { ARTICLES, matches } from "./HelpView";
import { startChatWith } from "./ChatView";

type Item = { key: string; group: string; icon: IconName; title: string; detail?: string; run: () => void };

const PAGES: { title: string; path: string; icon: IconName; words?: string }[] = [
  { title: "محادثة جديدة", path: "/new", icon: "plus", words: "سؤال جديد" },
  { title: "المحادثات", path: "/chats", icon: "chat" },
  { title: "المساحات", path: "/spaces", icon: "folder" },
  { title: "المهام", path: "/tasks", icon: "tasks" },
  { title: "المهام المجدولة", path: "/schedules", icon: "clock", words: "جدولة تكرار" },
  { title: "الإشارات", path: "/mentions", icon: "at" },
  { title: "ذاكرتي", path: "/memory", icon: "memory", words: "ذاكرة تذكر تفضيلات" },
  { title: "مهاراتي", path: "/skills", icon: "bulb", words: "مهارة /" },
  { title: "بياناتي", path: "/me", icon: "user", words: "سجلاتي" },
  { title: "أعمالي", path: "/works", icon: "file", words: "مخرجات مستندات جداول صفحات رسوم تحليل" },
  { title: "مركز المساعدة", path: "/help", icon: "help", words: "مساعدة شرح دليل" },
];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .trim();

export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K" || e.code === "KeyK")) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("onespace:search", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("onespace:search", onOpen);
    };
  }, []);
  return [open, setOpen] as const;
}

export function CommandPalette({ onClose, go, isAdmin }: { onClose: () => void; go: (p: string) => void; isAdmin: boolean }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 150);
    return () => clearTimeout(t);
  }, [q]);
  const found = useQuery(api.palette.find, debounced.trim().length >= 2 ? { q: debounced } : "skip");

  const items = useMemo(() => {
    const out: Item[] = [];
    const nq = norm(q);
    const open = (path: string) => () => {
      onClose();
      go(path);
    };
    if (nq) {
      out.push({
        key: "ask",
        group: "",
        icon: "send",
        title: `اسأل المساعد: «${q.trim()}»`,
        run: () => {
          onClose();
          startChatWith({ text: q.trim() });
        },
      });
    }
    const pages = [...PAGES.map((p) => ({ ...p, words: p.words ?? "" })), ...(isAdmin ? [{ title: "إدارة المنصة", path: "/admin", icon: "gear" as IconName, words: "ادارة مدير" }, ...ADMIN_PAGES.map((p) => ({ title: p.label, path: `/admin/${p.key}`, icon: p.icon, words: `ادارة ${p.hint}` }))] : [])];
    for (const p of pages.filter((p) => !nq || norm(`${p.title} ${p.words}`).includes(nq)).slice(0, nq ? 5 : 20)) out.push({ key: `page:${p.path}`, group: "الصفحات", icon: p.icon, title: p.title, run: open(p.path) });
    if (nq && found) {
      for (const c of found.chats) out.push({ key: `chat:${c.threadId}`, group: "المحادثات", icon: "chat", title: c.title, run: open(`/chat/${c.threadId}`) });
      for (const f of found.files)
        out.push({
          key: `file:${f._id}`,
          group: "الملفات",
          icon: "file",
          title: f.name,
          detail: f.spaceName,
          run: () => {
            onClose();
            go(`/space/${f.spaceId}/files`);
          },
        });
      for (const s of found.spaces) out.push({ key: `space:${s._id}`, group: "المساحات", icon: "folder", title: s.name, run: open(`/space/${s._id}`) });
      for (const t of found.tasks) out.push({ key: `task:${t._id}`, group: "المهام", icon: "tasks", title: t.title, detail: t.spaceName, run: open(`/tasks/${t._id}`) });
      for (const s of found.skills)
        out.push({
          key: `skill:${s._id}`,
          group: "مهاراتي",
          icon: "bulb",
          title: `/${s.name}`,
          detail: s.title,
          run: () => {
            onClose();
            startChatWith({ text: `/${s.name} `, skill: { id: s._id, name: s.name } });
          },
        });
    }
    if (nq) for (const a of ARTICLES.filter((a) => (isAdmin || !a.adminOnly) && matches(a, q)).slice(0, 4)) out.push({ key: `help:${a.id}`, group: "مركز المساعدة", icon: "help", title: a.title, detail: a.summary, run: open(`/help/${a.id}`) });
    return out;
  }, [q, found, isAdmin]);

  useEffect(() => setActive(0), [q, found]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(a + 1, items.length - 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
    else if (e.key === "Enter") (e.preventDefault(), items[active]?.run());
    else if (e.key === "Escape") (e.preventDefault(), onClose());
  };

  let lastGroup: string | null = null;
  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center bg-black/30 p-4 pt-[10vh] backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="البحث" className="card flex max-h-[70vh] w-full max-w-xl animate-rise flex-col overflow-hidden shadow-xl">
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Icon name="search" className="shrink-0 text-muted" />
          <input
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none"
            placeholder="ابحث في المحادثات والملفات والمساحات والمهام… أو اكتب سؤالك"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[active] ? `palette-${active}` : undefined}
          />
          <kbd className="hidden rounded border border-line px-1.5 text-[11px] text-muted sm:block">Esc</kbd>
        </div>
        <ul id="palette-list" ref={listRef} role="listbox" className="min-h-0 flex-1 overflow-y-auto p-2">
          {items.map((it, i) => {
            const header = it.group && it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <li key={it.key}>
                {header && <p className="px-3 pb-1 pt-3 text-[11px] font-medium text-faint">{header}</p>}
                <button
                  id={`palette-${i}`}
                  data-i={i}
                  role="option"
                  aria-selected={i === active}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-start text-sm ${i === active ? "bg-active" : ""}`}
                  onMouseMove={() => setActive(i)}
                  onClick={it.run}
                >
                  <Icon name={it.icon} size={16} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{it.title}</span>
                  {it.detail && <span className="max-w-[40%] shrink-0 truncate text-xs text-muted">{it.detail}</span>}
                </button>
              </li>
            );
          })}
          {q.trim().length >= 2 && debounced === q && found && items.length <= 1 && <li className="px-3 py-4 text-center text-sm text-muted">لا نتائج بالاسم. اضغط Enter ليبحث المساعد في محتوى الملفات.</li>}
        </ul>
        <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-muted">
          <span>↑↓ للتنقل</span>
          <span>Enter للفتح</span>
          <span className="ms-auto">Ctrl K</span>
        </div>
      </div>
    </div>
  );
}

