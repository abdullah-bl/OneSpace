// «إدارة المنصة»: every admin page under one roof (#/admin/<page>), grouped by what it governs —
// people (employees, levels), work (spaces), AI (agents, model providers, data sources) and
// oversight (the audit log). A side list on wide screens, a scrolling row of tabs on narrow ones.
// Space managers who aren't admins see only the audit log of their spaces.

import type { ReactNode } from "react";
import { useQuery } from "onebase/react";
import { api, type SpaceInfo } from "./lib";
import { Icon, type IconName } from "./icons";
import { SpacesAdmin, UsersAdmin } from "./AdminView";
import { AgentsView } from "./AgentsView";
import { LevelsView } from "./LevelsView";
import { AuditView } from "./AuditView";
import { ProvidersView } from "./ProvidersView";
import { SourcesView } from "./SourcesView";
import { ToolsView } from "./ToolsView";
import { SyncView } from "./SyncView";

type Page = { key: string; label: string; icon: IconName; hint: string; adminOnly?: boolean };
const GROUPS: { title: string; pages: Page[] }[] = [
  { title: "", pages: [{ key: "overview", label: "نظرة عامة", icon: "grid", hint: "ما يحتاج انتباهك", adminOnly: true }] },
  {
    title: "الأشخاص",
    pages: [
      { key: "users", label: "الموظفون", icon: "users", hint: "التفعيل والأدوار والهويات", adminOnly: true },
      { key: "levels", label: "المستويات وحدود الاستخدام", icon: "layers", hint: "النماذج والأدوات والحد اليومي لكل موظف", adminOnly: true },
    ],
  },
  {
    title: "العمل",
    pages: [
      { key: "spaces", label: "المساحات", icon: "folder", hint: "المساحات المشتركة ومديروها", adminOnly: true },
      { key: "sync", label: "مزامنة المجلدات", icon: "retry", hint: "مجلدات الشبكة إلى المساحات", adminOnly: true },
    ],
  },
  {
    title: "الذكاء الاصطناعي",
    pages: [
      { key: "agents", label: "الوكلاء", icon: "bot", hint: "أدوار المساعد وتعليماتها", adminOnly: true },
      { key: "tools", label: "الأدوات", icon: "code", hint: "ما يستطيعه المساعد ومن يستخدمه", adminOnly: true },
      { key: "providers", label: "مزوّدو النماذج", icon: "chip", hint: "خوادم النماذج وأدوارها", adminOnly: true },
      { key: "sources", label: "مصادر البيانات", icon: "database", hint: "قواعد البيانات والأنظمة والبحث", adminOnly: true },
    ],
  },
  { title: "الرقابة", pages: [{ key: "audit", label: "سجل التدقيق", icon: "shield", hint: "كل إجراء: من وماذا ومتى" }] },
];

export const ADMIN_PAGES = GROUPS.flatMap((g) => g.pages);

export function AdminConsole({ page, isAdmin, spaces, go }: { page: string; isAdmin: boolean; spaces: SpaceInfo[]; go: (p: string) => void }) {
  const visible = GROUPS.map((g) => ({ ...g, pages: g.pages.filter((p) => isAdmin || !p.adminOnly) })).filter((g) => g.pages.length);
  const all = visible.flatMap((g) => g.pages);
  const current = all.find((p) => p.key === page) ?? all[0]!;

  let body: ReactNode;
  if (current.key === "overview") body = <Overview go={go} />;
  else if (current.key === "users") body = <UsersAdmin />;
  else if (current.key === "spaces") body = <SpacesAdmin />;
  else if (current.key === "agents") body = <AgentsView spaces={spaces} />;
  else if (current.key === "levels") body = <LevelsView />;
  else if (current.key === "providers") body = <ProvidersView />;
  else if (current.key === "tools") body = <ToolsView />;
  else if (current.key === "sync") body = <SyncView spaces={spaces} />;
  else if (current.key === "sources") body = <SourcesView spaces={spaces} />;
  else body = <AuditView isAdmin={isAdmin} spaces={spaces} />;

  return (
    <div className="flex min-h-full flex-col xl:flex-row">
      <nav aria-label="أقسام الإدارة" className="sticky top-0 z-10 shrink-0 border-b border-line bg-ground/95 backdrop-blur xl:sticky xl:top-0 xl:h-dvh xl:w-60 xl:overflow-y-auto xl:border-b-0 xl:border-e">
        <div className="hidden px-5 pb-2 pt-7 xl:block">
          <p className="text-[15px] font-semibold">إدارة المنصة</p>
          <p className="mt-0.5 text-xs text-muted">لمدير مساحة العمل</p>
        </div>
        <div className="flex gap-1 overflow-x-auto px-3 py-2 [scrollbar-width:none] xl:block xl:space-y-4 xl:overflow-visible xl:py-3">
          {visible.map((g) => (
            <div key={g.title || "top"} className="contents xl:block">
              {g.title && <p className="hidden px-3 pb-1 text-[11px] font-medium text-faint xl:block">{g.title}</p>}
              <div className="contents xl:block xl:space-y-0.5">
                {g.pages.map((p) => {
                  const on = p.key === current.key;
                  return (
                    <a
                      key={p.key}
                      href={`#/admin/${p.key}`}
                      aria-current={on ? "page" : undefined}
                      className={`flex h-9 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md px-3 text-sm ${on ? "bg-active font-medium text-ink" : "text-muted hover:bg-active hover:text-ink"}`}
                    >
                      <Icon name={p.icon} size={16} />
                      {p.label}
                    </a>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </nav>
      <div className="min-w-0 flex-1">
        <div className="@container mx-auto w-full max-w-[1100px] px-4 py-6 lg:px-8 lg:py-8">{body}</div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, href, tone }: { label: string; value: ReactNode; sub?: ReactNode; href: string; tone?: "warning" | "negative" }) {
  return (
    <a href={href} className="card block p-4 transition-colors hover:border-control">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold num ${tone === "warning" ? "text-warning" : tone === "negative" ? "text-negative" : ""}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-muted">{sub}</p>}
    </a>
  );
}

function Overview({ go }: { go: (p: string) => void }) {
  const o = useQuery(api.admin.overview);
  if (!o) return <p className="text-muted">جارٍ التحميل…</p>;
  const todo: { text: string; action: string; to: string; tone: "warning" | "negative" }[] = [];
  if (o.users.pending) todo.push({ text: `${o.users.pending} حساب بانتظار التفعيل`, action: "راجع", to: "/admin/users", tone: "warning" });
  for (const d of o.agents.drafts) todo.push({ text: `«${d.name}»: ${d.unpublished ? "لم يُنشر بعد" : "مسودة لم تُنشر"}`, action: "افتح", to: "/admin/agents", tone: "warning" });
  for (const s of o.sources.failing) todo.push({ text: `مصدر البيانات «${s.name}» لا يتصل`, action: "افحص", to: "/admin/sources", tone: "negative" });
  for (const p of o.providers.failing) todo.push({ text: `مزوّد النماذج «${p.name}» لا يستجيب`, action: "افحص", to: "/admin/providers", tone: "negative" });
  if (!o.levels.total) todo.push({ text: "لا مستويات بعد: كل الموظفين بلا حدود استخدام", action: "أنشئ مستوى", to: "/admin/levels", tone: "warning" });

  return (
    <div className="space-y-8">
      <header>
        <h1 className="page-title">نظرة عامة</h1>
        <p className="mt-1.5 text-sm text-muted">حال المنصة اليوم، وما ينتظر قرارك.</p>
      </header>
      <section className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
        <Stat label="الموظفون" value={o.users.active} sub={o.users.pending ? <span className="text-warning">{o.users.pending} بانتظار التفعيل</span> : "كلهم مفعّلون"} href="#/admin/users" />
        <Stat label="أسئلة آخر 24 ساعة" value={o.activity.questions24h} sub={`من ${o.activity.people24h} موظف${o.activity.failed24h ? ` · ${o.activity.failed24h} تعثّر` : ""}`} href="#/admin/audit" tone={o.activity.failed24h ? "warning" : undefined} />
        <Stat label="الوكلاء المنشورون" value={o.agents.live} sub={`من ${o.agents.total}`} href="#/admin/agents" />
        <Stat label="المساحات المشتركة" value={o.spaces.total} sub={o.spaces.sensitive ? `${o.spaces.sensitive} حسّاسة` : undefined} href="#/admin/spaces" />
        <Stat label="مصادر البيانات" value={o.sources.total} sub={o.sources.failing.length ? <span className="text-negative">{o.sources.failing.length} لا يتصل</span> : undefined} href="#/admin/sources" />
        <Stat label="مزوّدو النماذج" value={o.providers.total || "الخادم"} sub={o.providers.total ? undefined : "من إعدادات الخادم"} href="#/admin/providers" />
        <Stat label="المستويات" value={o.levels.total} sub={o.levels.defaultName ? `الافتراضي: ${o.levels.defaultName}` : "بلا حدود"} href="#/admin/levels" />
      </section>
      <section>
        <h2 className="section-title mb-3">يحتاج انتباهك</h2>
        {todo.length ? (
          <ul className="card divide-y divide-rule">
            {todo.map((t, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-3 text-sm">
                <span className={`h-2 w-2 shrink-0 rounded-full ${t.tone === "negative" ? "bg-negative" : "bg-warning"}`} />
                <span className="min-w-0 flex-1">{t.text}</span>
                <button className="btn-secondary h-8 text-xs" onClick={() => go(t.to)}>
                  {t.action}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="card flex items-center gap-2 p-4 text-sm text-muted">
            <Icon name="check" className="text-positive" /> لا شيء ينتظرك.
          </p>
        )}
      </section>
    </div>
  );
}
