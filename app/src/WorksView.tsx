// «أعمالي»: everything the assistant made for me (documents, tables, interactive pages, charts and
// images), from every chat, in one place, like Claude's Artifacts. Search reaches inside the
// content; each item opens in the side panel and links back to the chat it came from.
// Backend: artifacts:mine (my own outputs, in spaces I can still read).

import { useEffect, useState } from "react";
import { useQuery } from "onebase/react";
import { ArtifactDock } from "./ArtifactPanel";
import { api, type SpaceInfo } from "./lib";
import { Icon, type IconName } from "./icons";
import { relTime, startChatWith } from "./ChatView";
import { EmptyState, PageHeader } from "./ui";

type Kind = "markdown" | "html" | "table" | "image";
const KINDS: { key: Kind; label: string; icon: IconName }[] = [
  { key: "markdown", label: "مستندات", icon: "file" },
  { key: "table", label: "جداول", icon: "table" },
  { key: "html", label: "صفحات", icon: "code" },
  { key: "image", label: "صور ورسوم", icon: "eye" },
];
const KIND_ONE: Record<Kind, string> = { markdown: "مستند", table: "جدول", html: "صفحة", image: "صورة" };

export function WorksView({ spaces }: { spaces: SpaceInfo[] }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [kind, setKind] = useState<Kind | "">("");
  const [spaceId, setSpaceId] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  const items = useQuery(api.artifacts.mine, { ...(debounced ? { q: debounced } : {}), ...(kind ? { kind } : {}), ...(spaceId ? { spaceId } : {}) });
  const filtered = !!(debounced || kind || spaceId);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="أعمالي"
        subtitle="كل ما صنعه المساعد لك من كل المحادثات: المستندات والجداول والصفحات التفاعلية والرسوم. افتح أياً منها، أو ارجع إلى المحادثة التي جاء منها لتعدّله."
        actions={
          <button className="btn-primary" onClick={() => startChatWith({})}>
            <Icon name="plus" /> اطلب عملاً جديداً
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Icon name="search" className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-faint" />
          <input className="input w-full ps-9" placeholder="ابحث في العناوين والمحتوى…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-1" role="tablist">
          <Chip on={!kind} onClick={() => setKind("")}>
            الكل
          </Chip>
          {KINDS.map((k) => (
            <Chip key={k.key} on={kind === k.key} onClick={() => setKind(kind === k.key ? "" : k.key)}>
              {k.label}
            </Chip>
          ))}
        </div>
        <select className="input h-8 w-auto text-sm" aria-label="المساحة" value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
          <option value="">كل المساحات</option>
          {spaces.map((s) => (
            <option key={s._id} value={s._id}>
              {s.kind === "personal" ? "مساحتي" : s.name}
            </option>
          ))}
        </select>
      </div>

      {items === undefined ? (
        <p className="text-sm text-muted">جارٍ التحميل…</p>
      ) : items.length === 0 ? (
        filtered ? (
          <EmptyState icon="search" title="لا نتائج">
            جرّب كلمة أخرى أو أزل التصفية.
          </EmptyState>
        ) : (
          <EmptyState icon="file" title="لا أعمال بعد">
            <p>اطلب من المساعد مستنداً أو جدولاً أو صفحة، فيظهر هنا. مثلاً:</p>
            <div className="mt-3 flex flex-wrap justify-center gap-1.5">
              {["اكتب خطاباً رسمياً بطلب اعتماد ميزانية", "حوّل ملف الموظفين إلى صفحة قابلة للبحث", "ارسم توزيع المشتريات حسب الشهر"].map((t) => (
                <button key={t} className="h-8 rounded-full border border-line px-3 text-xs hover:border-control" onClick={() => startChatWith({ text: t })}>
                  {t}
                </button>
              ))}
            </div>
          </EmptyState>
        )
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((a) => {
            const k = KINDS.find((x) => x.key === a.kind) ?? KINDS[0]!;
            return (
              <li key={a._id} className="card flex flex-col p-4 transition-colors hover:border-control">
                <button className="flex min-w-0 items-start gap-3 text-start" onClick={() => setOpen(a._id)}>
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
                    <Icon name={k.icon} size={18} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 font-medium leading-6 [overflow-wrap:anywhere]" dir="auto">
                      {a.title}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted">
                      {KIND_ONE[a.kind as Kind]}
                      {a.currentVersion > 1 ? ` · النسخة ${a.currentVersion}` : ""} · {relTime(a.updatedAt)}
                    </span>
                  </span>
                </button>
                {a.snippet && <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted">{a.snippet}</p>}
                <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3 text-xs">
                  <span className="badge">{a.spaceName}</span>
                  {a.classification === "sensitive" && <span className="badge-warning">حسّاس</span>}
                  {a.thread && (
                    <a href={`#/chat/${a.thread.id}`} className="ms-auto flex max-w-[60%] items-center gap-1 text-muted hover:text-ink" title={a.thread.title}>
                      <Icon name="chat" size={13} /> <span className="truncate">{a.thread.title}</span>
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {open && <ArtifactDock key={open} artifactId={open} spaces={spaces} onClose={() => setOpen(null)} mode="overlay" />}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button role="tab" aria-selected={on} className={`h-8 rounded-full border px-3 text-xs ${on ? "border-ink bg-ink text-surface" : "border-line hover:border-control"}`} onClick={onClick}>
      {children}
    </button>
  );
}
