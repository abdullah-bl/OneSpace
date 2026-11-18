// The shell (UX redesign, app/UX.md): a Claude-like sidebar — "محادثة جديدة", then المحادثات,
// المساحات, المهام and الإشارات, the recent chats — and a user menu at the bottom holding what is
// rarely used (بياناتي, التحليل, المفاضلة, and for admins/managers الإدارة, الوكلاء, سجل التدقيق).
// Routes live in the URL hash so back/forward and links work: #/new, #/chat/<id>, #/chats,
// #/spaces, #/space/<id>[/<tab>|/new], #/tasks[/<taskId>], #/schedules, #/mentions, #/me, …

import { Component, useEffect, useState, type ReactNode } from "react";
import { useAuthActions, useMutation, useOnebaseAuth, useQuery } from "onebase/react";
import { api, errorText, ROLE_LABELS, spaceName, type SpaceInfo } from "./lib";
import { Icon, Mark, type IconName } from "./icons";
import { ChatScreen, ChatsPage, relTime } from "./ChatView";
import { SpaceView, SpacesPage } from "./SpaceView";
import { TasksPage } from "./TasksView";
import { MentionsPage } from "./MentionsView";
import { NotificationBell } from "./NotificationBell";
import { AdminView } from "./AdminView";
import { AuditView } from "./AuditView";
import { AnalysisView } from "./AnalysisView";
import { RankingView } from "./RankingView";
import { MyRecordsView } from "./MyRecordsView";
import { AgentsView } from "./AgentsView";

export function App() {
  const { isLoading, isAuthenticated } = useOnebaseAuth();
  if (isLoading) return <Centered>جارٍ التحميل…</Centered>;
  if (!isAuthenticated) return <Login />;
  return <Gate />;
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-muted">{children}</div>;
}

function Login() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex h-full items-center justify-center p-4">
      <form
        className="card w-full max-w-sm space-y-4 p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          setBusy(true);
          setError("");
          try {
            await signIn("password", { flow, email: form.get("email"), password: form.get("password"), ...(flow === "signUp" ? { name: form.get("name") } : {}) });
          } catch (err) {
            setError(flow === "signIn" ? "البريد أو كلمة المرور غير صحيحة" : errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex items-center gap-2">
          <Mark size={28} />
          <h1 className="text-xl font-medium">مساحة</h1>
        </div>
        <p className="text-sm text-muted">{flow === "signIn" ? "مساعد الإدارة: محادثات، ومساحات العمل، والمهام." : "إنشاء حساب: يُفعَّل بعد موافقة مدير مساحة العمل."}</p>
        {flow === "signUp" && (
          <label className="block space-y-1 text-sm">
            <span>الاسم</span>
            <input className="input w-full" name="name" required />
          </label>
        )}
        <label className="block space-y-1 text-sm">
          <span>البريد الإلكتروني</span>
          <input className="input w-full" name="email" type="email" dir="ltr" required />
        </label>
        <label className="block space-y-1 text-sm">
          <span>كلمة المرور</span>
          <input className="input w-full" name="password" type="password" dir="ltr" minLength={8} required />
        </label>
        {error && <p className="text-sm text-negative">{error}</p>}
        <button className="btn-primary w-full" disabled={busy}>
          {flow === "signIn" ? "دخول" : "إنشاء الحساب"}
        </button>
        <button type="button" className="btn-ghost w-full" onClick={() => setFlow(flow === "signIn" ? "signUp" : "signIn")}>
          {flow === "signIn" ? "ليس لديك حساب؟ أنشئ حساباً" : "لديك حساب؟ سجّل الدخول"}
        </button>
      </form>
    </div>
  );
}

function Gate() {
  const me = useQuery(api.account.me);
  const { signOut } = useAuthActions();
  if (me === undefined) return <Centered>جارٍ التحميل…</Centered>;
  if (me === null) return <Centered>انتهت الجلسة</Centered>;
  if (me.status !== "active" || !me.workspaceRole) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="card max-w-md space-y-3 p-6">
          <h1 className="text-lg font-medium">{me.status === "disabled" ? "الحساب معطّل" : "حسابك بانتظار التفعيل"}</h1>
          <p className="text-sm text-muted">
            {me.status === "disabled" ? "عطّل مدير مساحة العمل هذا الحساب. تواصل معه إن كان ذلك خطأ." : "سجّلت الدخول بنجاح، لكن لا يظهر لك شيء حتى يضيفك مدير مساحة العمل."}
          </p>
          <p className="text-xs text-muted" dir="ltr">
            {me.email}
          </p>
          <button className="btn-secondary" onClick={() => void signOut()}>
            تسجيل الخروج
          </button>
        </div>
      </div>
    );
  }
  return <Shell me={me} />;
}

// ---------------------------------------------------------------- routing

function readHash(): string[] {
  const h = window.location.hash.replace(/^#\/?/, "");
  return h ? h.split("/").map(decodeURIComponent) : [];
}

function useRoute(): [string[], (path: string) => void] {
  const [parts, setParts] = useState(readHash);
  useEffect(() => {
    // Old links: /chat?taskId=… ("اعمل عليها مع الوكيل" from Phase 6).
    const taskId = new URLSearchParams(window.location.search).get("taskId");
    if (taskId) {
      window.history.replaceState(null, "", `/#/task-chat/${encodeURIComponent(taskId)}`);
      setParts(readHash());
    }
    const on = () => setParts(readHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [parts, (path: string) => (window.location.hash = "#" + path)];
}

type Me = { name: string | null; email: string | null; workspaceRole: string | null; workspaceName: string | null };

function Shell({ me }: { me: Me }) {
  const spaces = useQuery(api.spaces.mine);
  const [route, go] = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const isAdmin = me.workspaceRole === "admin";
  const managesAny = !!spaces?.some((s) => s.kind === "shared" && s.canManage);

  // TasksView's "اعمل عليها مع الوكيل" dispatches this event.
  useEffect(() => {
    const onTask = (e: Event) => go(`/task-chat/${(e as CustomEvent<string>).detail}`);
    window.addEventListener("onespace:task-chat", onTask);
    return () => window.removeEventListener("onespace:task-chat", onTask);
  }, []);
  useEffect(() => setMenuOpen(false), [route.join("/")]);

  const [head, a, b] = route;
  const section = head === "chat" || head === "new" || !head ? "chat" : head === "space" ? "spaces" : head;
  const sidebar = <Sidebar me={me} spaces={spaces ?? []} route={route} section={section} go={go} isAdmin={isAdmin} managesAny={managesAny} />;

  let screen: ReactNode;
  if (!spaces) screen = <Centered>جارٍ التحميل…</Centered>;
  else if (!head || head === "new") screen = <ChatScreen key={`new-${route.join("/")}`} threadId={null} spaces={spaces} go={go} />;
  else if (head === "chat" && a) screen = <ChatScreen key={a} threadId={a} spaces={spaces} go={go} />;
  else if (head === "task-chat" && a) screen = <TaskChat taskId={a} go={go} />;
  else if (head === "chats") screen = <ChatsPage go={go} />;
  else if (head === "spaces") screen = <SpacesPage spaces={spaces} />;
  else if (head === "space" && a) {
    const space = spaces.find((s) => s._id === a);
    if (!space) screen = <NotAvailable />;
    else if (b === "new") screen = <ChatScreen key={`new-space-${a}`} threadId={null} spaceId={a} spaces={spaces} go={go} />;
    else screen = <SpaceView key={a} space={space} spaces={spaces} tab={b ?? "overview"} go={go} />;
  } else if (head === "tasks") screen = <TasksPage tab="mine" taskId={a ?? null} go={go} spaces={spaces} />;
  else if (head === "schedules") screen = <TasksPage tab="scheduled" taskId={null} go={go} spaces={spaces} />;
  else if (head === "mentions") screen = <MentionsPage go={go} />;
  else if (head === "me") screen = <Wide><MyRecordsView /></Wide>;
  else if (head === "analysis") screen = <Wide><AnalysisView spaces={spaces} /></Wide>;
  else if (head === "ranking") screen = <Wide><RankingView spaces={spaces} /></Wide>;
  else if (head === "admin" && isAdmin) screen = <Wide><AdminView /></Wide>;
  else if (head === "agents" && isAdmin) screen = <Wide><AgentsView spaces={spaces} /></Wide>;
  else if (head === "audit" && (isAdmin || managesAny)) screen = <Wide><AuditView isAdmin={isAdmin} spaces={spaces} /></Wide>;
  else screen = <NotAvailable />;

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* Phone and tablet: a 48px bar; the sidebar opens as a full-screen sheet. */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-ground px-2 lg:hidden">
        <button className="btn-ghost w-10 px-0" aria-label="القائمة" onClick={() => setMenuOpen(true)}>
          <Icon name="menu" size={20} />
        </button>
        <a href="#/" className="flex items-center gap-2 font-medium">
          <Mark size={22} /> مساحة
        </a>
        <span className="ms-auto" />
        <NotificationBell go={go} />
        <button className="btn-ghost w-10 px-0" aria-label="محادثة جديدة" onClick={() => go("/new")}>
          <Icon name="plus" size={20} />
        </button>
      </div>
      {menuOpen && (
        <div className="fixed inset-0 z-40 flex bg-ground lg:hidden">
          <div className="flex w-full flex-col">{sidebar}</div>
          <button className="btn-ghost absolute end-2 top-2 w-10 px-0" aria-label="إغلاق القائمة" onClick={() => setMenuOpen(false)}>
            <Icon name="x" size={20} />
          </button>
        </div>
      )}
      <aside className="hidden w-[264px] shrink-0 flex-col border-e border-line lg:flex">{sidebar}</aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface">
        <ErrorBoundary key={route.join("/")}>{screen}</ErrorBoundary>
      </main>
    </div>
  );
}

function Wide({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1100px] px-4 py-6 lg:px-8 lg:py-9">{children}</div>;
}

function NotAvailable() {
  return (
    <Wide>
      <h1 className="text-2xl font-medium">غير متاح</h1>
      <p className="mt-2 text-muted">هذه الصفحة غير موجودة أو لا تملك صلاحية الوصول إليها.</p>
      <a className="btn-secondary mt-4" href="#/">
        محادثة جديدة
      </a>
    </Wide>
  );
}

/** "اعمل عليها مع الوكيل": opens (or creates) my thread for the task, then shows it. */
function TaskChat({ taskId, go }: { taskId: string; go: (p: string) => void }) {
  const open = useMutation(api.chat.openTaskThread);
  const [error, setError] = useState("");
  useEffect(() => {
    open({ taskId })
      .then((id) => window.location.replace(`#/chat/${id as string}`))
      .catch((err) => setError(errorText(err)));
  }, [taskId]);
  return error ? (
    <Wide>
      <p className="text-negative">{error}</p>
      <button className="btn-secondary mt-3" onClick={() => go("/tasks")}>
        المهام
      </button>
    </Wide>
  ) : (
    <Centered>يفتح محادثة المهمة…</Centered>
  );
}

// ---------------------------------------------------------------- sidebar

function Sidebar(props: { me: Me; spaces: SpaceInfo[]; route: string[]; section: string; go: (p: string) => void; isAdmin: boolean; managesAny: boolean }) {
  const { me, route, section, go } = props;
  const threads = useQuery(api.chat.threads, {});
  const mentionsUnread = useQuery(api.mentions.unreadCount) ?? 0;
  const myTasks = useQuery(api.tasks.mine);
  const openTasks = (myTasks ?? []).filter((t) => t.status !== "done").length;
  const current = route[0] === "chat" ? route[1] : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        <Mark size={24} />
        <span className="min-w-0">
          <span className="block text-[15px] font-medium leading-5">مساحة</span>
          <span className="block truncate text-xs text-muted">{me.workspaceName}</span>
        </span>
        <span className="ms-auto hidden lg:block">
          <NotificationBell go={go} />
        </span>
      </div>
      <div className="px-3">
        <button className="btn-primary h-10 w-full justify-start gap-2 px-3" onClick={() => go("/new")}>
          <Icon name="plus" size={18} /> محادثة جديدة
        </button>
      </div>
      <nav className="mt-3 space-y-0.5 px-3" aria-label="التنقل">
        <NavLink href="#/chats" icon="chat" on={section === "chats"}>
          المحادثات
        </NavLink>
        <NavLink href="#/spaces" icon="folder" on={section === "spaces"}>
          المساحات
        </NavLink>
        <NavLink href="#/tasks" icon="tasks" on={section === "tasks" || section === "schedules"} count={openTasks}>
          المهام
        </NavLink>
        <NavLink href="#/mentions" icon="at" on={section === "mentions"} count={mentionsUnread}>
          الإشارات
        </NavLink>
      </nav>
      <div className="mt-5 flex min-h-0 flex-1 flex-col">
        <div className="flex items-center px-6 pb-1 text-xs text-muted">
          الأخيرة
          {threads && threads.length > 12 && (
            <a href="#/chats" className="ms-auto hover:text-ink">
              عرض الكل
            </a>
          )}
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {threads?.length === 0 && <li className="px-3 py-2 text-xs text-muted">لا محادثات بعد.</li>}
          {threads?.slice(0, 30).map((t) => (
            <li key={t.threadId}>
              <a
                href={`#/chat/${t.threadId}`}
                className={`flex h-8 items-center gap-2 rounded-md px-3 text-sm ${current === t.threadId ? "bg-active text-ink" : "text-[#3d3d3d] hover:bg-active"}`}
                title={`${t.title}${t.spaceName ? ` · ${t.spaceName}` : ""} · ${relTime(t.lastAt)}`}
              >
                <span className="truncate">{t.title}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
      <UserMenu {...props} />
    </div>
  );
}

function NavLink({ href, icon, on, count, children }: { href: string; icon: IconName; on: boolean; count?: number; children: ReactNode }) {
  return (
    <a href={href} className={`flex h-9 items-center gap-2.5 rounded-md px-3 text-sm ${on ? "bg-active font-medium text-ink" : "text-[#3d3d3d] hover:bg-active"}`} aria-current={on ? "page" : undefined}>
      <Icon name={icon} size={16} />
      {children}
      {!!count && <span className="ms-auto text-xs text-muted num">{count}</span>}
    </a>
  );
}

function UserMenu({ me, isAdmin, managesAny, go }: { me: Me; isAdmin: boolean; managesAny: boolean; go: (p: string) => void }) {
  const { signOut } = useAuthActions();
  const [open, setOpen] = useState(false);
  const item = (label: string, path: string) => (
    <button
      key={path}
      className="block w-full rounded-md px-3 py-2 text-start text-sm hover:bg-active"
      onClick={() => {
        setOpen(false);
        go(path);
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="relative shrink-0 border-t border-line p-3">
      {open && (
        <div className="absolute inset-x-3 bottom-full z-20 mb-1 rounded-lg border border-line bg-surface p-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)]" role="menu">
          {item("بياناتي", "/me")}
          {item("المهام المجدولة", "/schedules")}
          {item("التحليل", "/analysis")}
          {item("المفاضلة", "/ranking")}
          {(isAdmin || managesAny) && <div className="my-1 border-t border-rule" />}
          {isAdmin && item("إدارة مساحة العمل", "/admin")}
          {isAdmin && item("الوكلاء", "/agents")}
          {(isAdmin || managesAny) && item("سجل التدقيق", "/audit")}
          <div className="my-1 border-t border-rule" />
          <button className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-start text-sm hover:bg-active" onClick={() => void signOut()}>
            <Icon name="logout" size={16} /> تسجيل الخروج
          </button>
        </div>
      )}
      <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start hover:bg-active" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#e3e1dc] text-sm font-medium">{(me.name ?? me.email ?? "؟").trim().charAt(0)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{me.name ?? me.email}</span>
          <span className="block truncate text-xs text-muted">{ROLE_LABELS[me.workspaceRole ?? ""] ?? "موظف"}</span>
        </span>
        <Icon name="up" size={14} className="text-muted" />
      </button>
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    if (this.state.error)
      return (
        <div className="mx-auto max-w-[760px] p-6">
          <p className="rounded-md bg-[#ffedea] p-3 text-sm text-[#831c1e]">{errorText(this.state.error)}</p>
        </div>
      );
    return this.props.children;
  }
}

export { spaceName };
