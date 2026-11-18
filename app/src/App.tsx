import { Component, useState, type ReactNode } from "react";
import { useAuthActions, useOnebaseAuth, useQuery } from "onebase/react";
import { api, badge, errorText, ROLE_LABELS, STATUS_LABELS } from "./lib";
import { SpaceView } from "./SpaceView";
import { AdminView } from "./AdminView";
import { AuditView } from "./AuditView";
import { MyTasksView } from "./TasksView";
import { NotificationBell } from "./NotificationBell";

export function App() {
  const { isLoading, isAuthenticated } = useOnebaseAuth();
  if (isLoading) return <Centered>جارٍ التحميل…</Centered>;
  if (!isAuthenticated) return <Login />;
  return <Gate />;
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-slate-500">{children}</div>;
}

function Login() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex h-full items-center justify-center p-6">
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
        <div>
          <h1 className="text-2xl font-semibold text-teal-800">مساحة</h1>
          <p className="text-sm text-slate-500">{flow === "signIn" ? "تسجيل الدخول" : "إنشاء حساب — يُفعَّل بعد موافقة مدير مساحة العمل"}</p>
        </div>
        {flow === "signUp" && <input className="input w-full" name="name" placeholder="الاسم" required />}
        <input className="input w-full" name="email" type="email" placeholder="البريد الإلكتروني" dir="ltr" required />
        <input className="input w-full" name="password" type="password" placeholder="كلمة المرور (8 أحرف على الأقل)" dir="ltr" minLength={8} required />
        {error && <p className="text-sm text-red-700">{error}</p>}
        <button className="btn-primary w-full justify-center" disabled={busy}>
          {flow === "signIn" ? "دخول" : "إنشاء الحساب"}
        </button>
        <button type="button" className="btn-ghost w-full justify-center" onClick={() => setFlow(flow === "signIn" ? "signUp" : "signIn")}>
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
      <div className="flex h-full items-center justify-center p-6">
        <div className="card max-w-md space-y-3 p-6 text-center">
          <div className="text-4xl">⏳</div>
          <h1 className="text-lg font-semibold">{me.status === "disabled" ? "الحساب معطّل" : "حسابك بانتظار التفعيل"}</h1>
          <p className="text-sm text-slate-600">
            {me.status === "disabled"
              ? "عطّل مدير مساحة العمل هذا الحساب. تواصل معه إن كان ذلك خطأ."
              : "سجّلت الدخول بنجاح، لكن لا يظهر لك شيء حتى يضيفك مدير مساحة العمل."}
          </p>
          <p className="text-xs text-slate-400" dir="ltr">{me.email}</p>
          <button className="btn-ghost" onClick={() => void signOut()}>
            تسجيل الخروج
          </button>
        </div>
      </div>
    );
  }
  return <Shell me={me} />;
}

type Route = { kind: "space"; id: string } | { kind: "admin" } | { kind: "audit" } | { kind: "tasks"; taskId: string | null };

function Shell({ me }: { me: { name: string | null; email: string | null; workspaceRole: string | null; workspaceName: string | null } }) {
  const spaces = useQuery(api.spaces.mine);
  const { signOut } = useAuthActions();
  const [route, setRoute] = useState<Route | null>(null);
  const isAdmin = me.workspaceRole === "admin";
  // A space I lose access to (removed, space deleted) drops out of the list: fall back to my own space.
  const stale = route?.kind === "space" && spaces !== undefined && !spaces.some((s) => s._id === route.id);
  const current: Route | null = route && !stale ? route : spaces?.[0] ? { kind: "space", id: spaces[0]._id } : null;
  const personal = spaces?.filter((s) => s.kind === "personal") ?? [];
  const shared = spaces?.filter((s) => s.kind === "shared") ?? [];
  const managesAny = shared.some((s) => s.canManage);

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-e border-slate-200 bg-white">
        <div className="border-b border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold text-teal-800">مساحة</div>
            <NotificationBell onOpenTask={(taskId) => setRoute({ kind: "tasks", taskId })} />
          </div>
          <div className="text-xs text-slate-500">{me.workspaceName}</div>
        </div>
        <nav className="flex-1 space-y-4 overflow-y-auto p-3">
          <div className="space-y-1">
            <NavItem active={current?.kind === "tasks"} onClick={() => setRoute({ kind: "tasks", taskId: null })}>
              ✅ مهامي
            </NavItem>
            {personal.map((s) => (
              <NavItem key={s._id} active={current?.kind === "space" && current.id === s._id} onClick={() => setRoute({ kind: "space", id: s._id })}>
                🔒 مساحتي
              </NavItem>
            ))}
          </div>
          <div>
            <div className="mb-1 px-2 text-xs font-semibold text-slate-400">المساحات المشتركة</div>
            {shared.length === 0 && <div className="px-2 text-xs text-slate-400">لم تُضف لأي مساحة بعد</div>}
            <div className="space-y-1">
              {shared.map((s) => (
                <NavItem key={s._id} active={current?.kind === "space" && current.id === s._id} onClick={() => setRoute({ kind: "space", id: s._id })}>
                  <span>{badge(s).icon}</span>
                  <span className="truncate">{s.name}</span>
                  {s.sensitive && <span title="حسّاسة: كل فتح وتنزيل يُسجَّل" className="ms-auto rounded bg-amber-100 px-1.5 text-[10px] text-amber-800">حسّاسة</span>}
                </NavItem>
              ))}
            </div>
          </div>
          {(isAdmin || managesAny) && (
            <div className="space-y-1 border-t border-slate-100 pt-3">
              {isAdmin && (
                <NavItem active={current?.kind === "admin"} onClick={() => setRoute({ kind: "admin" })}>
                  ⚙️ إدارة مساحة العمل
                </NavItem>
              )}
              <NavItem active={current?.kind === "audit"} onClick={() => setRoute({ kind: "audit" })}>
                📜 سجل التدقيق
              </NavItem>
            </div>
          )}
        </nav>
        <div className="border-t border-slate-200 p-3 text-sm">
          <div className="font-semibold">{me.name ?? me.email}</div>
          <div className="text-xs text-slate-500">{ROLE_LABELS[me.workspaceRole ?? ""] ?? STATUS_LABELS.active}</div>
          <button className="btn-ghost mt-2 px-0" onClick={() => void signOut()}>
            تسجيل الخروج
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto p-6">
        <ErrorBoundary key={JSON.stringify(current)}>
          {current?.kind === "space" && spaces && <SpaceView spaceId={current.id} spaces={spaces} />}
          {current?.kind === "admin" && <AdminView />}
          {current?.kind === "audit" && <AuditView isAdmin={isAdmin} spaces={spaces ?? []} />}
          {current?.kind === "tasks" && <MyTasksView openTaskId={current.taskId} onOpenTask={(taskId) => setRoute({ kind: "tasks", taskId })} />}
        </ErrorBoundary>
      </main>
    </div>
  );
}

function NavItem({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm ${active ? "bg-teal-50 font-semibold text-teal-800" : "hover:bg-slate-100"}`}>
      {children}
    </button>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    if (this.state.error) return <div className="card p-6 text-sm text-red-700">{errorText(this.state.error)}</div>;
    return this.props.children;
  }
}
