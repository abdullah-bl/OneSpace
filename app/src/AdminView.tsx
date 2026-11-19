// Admin console pages for people and spaces (AdminConsole.tsx): «الموظفون» (activate, role,
// identifiers, disable) and «المساحات» (shared spaces, their managers and flags). An admin sees a
// space's existence and managers here, never its files unless they're a member.

import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "onebase/react";
import { api, errorText, formatDate, STATUS_LABELS } from "./lib";
import { Icon } from "./icons";
import { ask, EmptyState, Menu, PageHeader, type MenuItem } from "./ui";

function useRun() {
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return { error, setError, run };
}

const initial = (s: string | null | undefined) => (s ?? "؟").trim().charAt(0);

type AdminUser = NonNullable<ReturnType<typeof useQuery<typeof api.admin.users>>>[number];

const ROLE_LABELS: Record<string, string> = { admin: "مدير مساحة العمل", member: "موظف" };

export function UsersAdmin() {
  const users = useQuery(api.admin.users);
  const activate = useMutation(api.admin.activate);
  const disable = useMutation(api.admin.disable);
  const { error, setError, run } = useRun();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "pending" | "active" | "disabled">("all");
  const [editing, setEditing] = useState<string | null>(null);
  const counts = { all: users?.length ?? 0, pending: 0, active: 0, disabled: 0 };
  for (const u of users ?? []) counts[u.status as "pending" | "active" | "disabled"]++;
  const needle = q.trim().toLowerCase();
  const shown = (users ?? []).filter(
    (u) => (filter === "all" || u.status === filter) && (!needle || `${u.name ?? ""} ${u.email ?? ""} ${u.employeeNo ?? ""} ${u.nationalId ?? ""}`.toLowerCase().includes(needle)),
  );
  const editUser = editing ? users?.find((u) => u._id === editing) : undefined;

  return (
    <div>
      <PageHeader title="الموظفون" subtitle="من ينشئ حساباً يبقى «بانتظار التفعيل» ولا يرى شيئاً حتى تفعّله. تأكد من هوية صاحب البريد قبل التفعيل." />
      {error && <p className="alert-negative mb-4">{error}</p>}
      {counts.pending > 0 && filter !== "pending" && (
        <button className="mb-4 flex w-full items-center gap-3 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-start text-sm" onClick={() => setFilter("pending")}>
          <Icon name="user" className="shrink-0 text-warning" />
          <span className="flex-1 font-medium">{counts.pending} حساب بانتظار التفعيل</span>
          <span className="text-xs text-muted">اعرضها</span>
        </button>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full min-w-0 sm:w-auto sm:max-w-xs sm:flex-1">
          <Icon name="search" className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-faint" />
          <input className="input w-full ps-9" type="search" placeholder="ابحث بالاسم أو البريد أو الرقم" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="-mx-1 flex max-w-full gap-1 overflow-x-auto px-1" role="tablist">
          {(
            [
              ["all", "الكل"],
              ["pending", "بانتظار التفعيل"],
              ["active", "مفعّل"],
              ["disabled", "معطّل"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={filter === k}
              className={`h-8 shrink-0 whitespace-nowrap rounded-full border px-3 text-xs ${filter === k ? "border-ink bg-ink text-surface" : k === "pending" && counts.pending ? "border-warning/40 text-warning hover:border-warning" : "border-line hover:border-control"}`}
              onClick={() => setFilter(k)}
            >
              {label} <span className="num opacity-70">{counts[k]}</span>
            </button>
          ))}
        </div>
      </div>

      {users === undefined ? (
        <p className="text-sm text-muted">جارٍ التحميل…</p>
      ) : shown.length === 0 ? (
        <EmptyState icon="users" title={needle ? "لا نتائج" : filter === "pending" ? "لا حسابات بانتظار التفعيل" : "لا أحد هنا"} />
      ) : (
        <ul className="card divide-y divide-rule overflow-hidden">
          {shown.map((u) => {
            const who = u.name ?? u.email ?? "";
            const items: MenuItem[] = [{ label: "تعديل الدور والأرقام", icon: "pencil", onSelect: () => setEditing(u._id) }];
            if (u.status === "active")
              items.push("divider", {
                label: "تعطيل الحساب",
                icon: "lock",
                danger: true,
                onSelect: () =>
                  void ask(`تعطيل حساب ${who}؟ يفقد الوصول فوراً.`, { danger: true, confirmLabel: "تعطيل" }).then((ok) => {
                    if (ok) void run(() => disable({ userId: u._id as any }));
                  }),
              });
            const ids = [u.employeeNo && `رقم وظيفي ${u.employeeNo}`, u.nationalId && `هوية ${u.nationalId}`].filter(Boolean) as string[];
            return (
              <li key={u._id} className={`flex items-center gap-3 px-4 py-3 ${u.status === "pending" ? "bg-warning-soft/40" : ""}`}>
                <span className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-medium ${u.status === "active" ? "bg-active" : "bg-sunken text-muted"}`} aria-hidden>
                  {initial(u.name ?? u.email)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={`font-medium ${u.status === "disabled" ? "text-muted" : ""}`}>{u.name ?? "—"}</span>
                    {u.status === "active" && u.workspaceRole && <span className={u.workspaceRole === "admin" ? "badge-primary" : "badge"}>{ROLE_LABELS[u.workspaceRole]}</span>}
                    {u.status === "pending" && <span className="badge-warning">{STATUS_LABELS.pending}</span>}
                    {u.status === "disabled" && <span className="badge-negative">{STATUS_LABELS.disabled}</span>}
                  </p>
                  <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted">
                    <span dir="ltr" className="max-w-full truncate">
                      {u.email}
                    </span>
                    <span>أُنشئ {formatDate(u.createdAt)}</span>
                  </p>
                  {ids.length > 0 && (
                    <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-faint">
                      {ids.map((t) => (
                        <span key={t} className="num">
                          {t}
                        </span>
                      ))}
                    </p>
                  )}
                </div>
                {u.status !== "active" && (
                  <button className={`${u.status === "pending" ? "btn-primary" : "btn-secondary"} h-8 shrink-0`} onClick={() => run(() => activate({ userId: u._id as any }))} title={`تفعيل حساب ${who}`}>
                    {u.status === "disabled" ? "أعد التفعيل" : "فعّل"}
                  </button>
                )}
                <Menu className="shrink-0" label={`خيارات ${who}`} items={items} />
              </li>
            );
          })}
        </ul>
      )}
      {editUser && <EditUserDialog key={editUser._id} user={editUser} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** Role (active accounts only) and the identifiers my_records matches on. Saves only what changed. */
function EditUserDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const setRole = useMutation(api.admin.setRole);
  const setIdentifiers = useMutation(api.admin.setIdentifiers);
  const [role, setRoleValue] = useState(user.workspaceRole ?? "member");
  const [nationalId, setNationalId] = useState(user.nationalId ?? "");
  const [employeeNo, setEmployeeNo] = useState(user.employeeNo ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canRole = user.status === "active" && !!user.workspaceRole;
  const save = async () => {
    setError("");
    setBusy(true);
    try {
      const patch: { nationalId?: string | null; employeeNo?: string | null } = {};
      if (nationalId.trim() !== (user.nationalId ?? "")) patch.nationalId = nationalId.trim() || null;
      if (employeeNo.trim() !== (user.employeeNo ?? "")) patch.employeeNo = employeeNo.trim() || null;
      if (Object.keys(patch).length) await setIdentifiers({ userId: user._id as any, ...patch });
      if (canRole && role !== user.workspaceRole) await setRole({ userId: user._id as any, role: role as any });
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={user.name ?? "—"} subtitle={<span dir="ltr">{user.email}</span>} error={error} busy={busy} onSubmit={save} onClose={onClose}>
        <div className="mt-4 space-y-3">
          <label className="block text-sm">
            <span className="label">الدور</span>
            {canRole ? (
              <select className="input w-full" value={role} onChange={(e) => setRoleValue(e.target.value as typeof role)}>
                <option value="member">{ROLE_LABELS.member}</option>
                <option value="admin">{ROLE_LABELS.admin}</option>
              </select>
            ) : (
              <span className="block text-xs text-muted">يُحدَّد الدور بعد تفعيل الحساب.</span>
            )}
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="label">الرقم الوظيفي</span>
              <input className="input w-full" dir="ltr" inputMode="numeric" value={employeeNo} onChange={(e) => setEmployeeNo(e.target.value)} autoFocus />
            </label>
            <label className="block text-sm">
              <span className="label">رقم الهوية</span>
              <input className="input w-full" dir="ltr" inputMode="numeric" value={nationalId} onChange={(e) => setNationalId(e.target.value)} />
            </label>
          </div>
          <p className="text-xs text-muted">تُطابَق بهما سجلات الموظف في «بياناتي». يضعهما المدير فقط؛ اترك الحقل فارغاً لحذفه.</p>
        </div>
    </Sheet>
  );
}

/** Modal form: centred card on desktop, bottom sheet on phones. Escape or a backdrop click closes it. */
function Sheet({
  title,
  subtitle,
  error,
  busy,
  submitLabel = "حفظ",
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  error?: string;
  busy?: boolean;
  submitLabel?: string;
  onSubmit: () => void | Promise<void>;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[100] grid place-items-end bg-black/30 backdrop-blur-[2px] sm:place-items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        className="card max-h-[90dvh] w-full animate-rise overflow-y-auto rounded-b-none p-5 shadow-xl sm:max-w-md sm:rounded-b-lg"
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
      >
        <p id="sheet-title" className="font-medium">
          {title}
        </p>
        {subtitle && <p className="truncate text-xs text-muted">{subtitle}</p>}
        {error && <p className="alert-negative mt-3">{error}</p>}
        {children}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            إلغاء
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "جارٍ الحفظ…" : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

type AdminSpace = NonNullable<ReturnType<typeof useQuery<typeof api.admin.spaces>>>[number];

export function SpacesAdmin() {
  const users = useQuery(api.admin.users);
  const spaces = useQuery(api.admin.spaces);
  const [dialog, setDialog] = useState<"new" | string | null>(null);
  const [q, setQ] = useState("");
  const active = users?.filter((u) => u.status === "active" && u.workspaceRole) ?? [];
  const needle = q.trim();
  const shown = (spaces ?? []).filter((s) => !needle || s.name.includes(needle) || s.managers.some((m) => m.name.includes(needle)));
  const editing = dialog && dialog !== "new" ? spaces?.find((s) => s._id === dialog) : undefined;

  return (
    <div>
      <PageHeader
        title="المساحات"
        subtitle="ترى هنا وجود المساحة ومديرها فقط. لا ترى ملفاتها ما لم تكن عضواً فيها."
        actions={
          <button className="btn-primary" onClick={() => setDialog("new")}>
            <Icon name="plus" /> مساحة جديدة
          </button>
        }
      />
      {(spaces?.length ?? 0) > 6 && (
        <div className="relative mb-3 sm:max-w-xs">
          <Icon name="search" className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-faint" />
          <input className="input w-full ps-9" type="search" placeholder="ابحث باسم المساحة أو مديرها" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      {spaces === undefined ? (
        <p className="text-sm text-muted">جارٍ التحميل…</p>
      ) : spaces.length === 0 ? (
        <EmptyState icon="folder" title="لا مساحات مشتركة بعد" action={<button className="btn-primary" onClick={() => setDialog("new")}>أنشئ أول مساحة</button>}>
          المساحة المشتركة مكان ملفات فريق ومهامه ومحادثاته.
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState icon="folder" title="لا نتائج" />
      ) : (
        <ul className="card divide-y divide-rule overflow-hidden">
          {shown.map((s) => (
            <li key={s._id} className="flex items-center gap-3 px-4 py-3">
              <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${s.everyone ? "bg-primary-soft text-primary" : s.sensitive ? "bg-warning-soft text-warning" : "bg-active text-muted"}`} aria-hidden>
                <Icon name={s.everyone ? "globe" : s.sensitive ? "lock" : "folder"} size={16} />
              </span>
              <button className="min-w-0 flex-1 text-start" onClick={() => setDialog(s._id)} title="إعدادات المساحة">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium">{s.name}</span>
                  {s.everyone && <span className="badge-primary">للجميع</span>}
                  {s.sensitive && <span className="badge-warning">حسّاسة</span>}
                  {s.iAmMember && <span className="badge">أنت عضو</span>}
                </p>
                <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted">
                  <span className={s.managers.length ? "" : "text-warning"}>{s.managers.length ? `${s.managers.length > 1 ? "المديرون" : "المدير"}: ${s.managers.map((m) => m.name).join("، ")}` : "بلا مدير"}</span>
                  <span>
                    <span className="num">{s.memberCount}</span> {s.memberCount === 1 ? "عضو" : "أعضاء"}
                  </span>
                </p>
              </button>
              <Menu className="shrink-0" label={`خيارات ${s.name}`} items={[{ label: "إعدادات المساحة", icon: "pencil", onSelect: () => setDialog(s._id) }]} />
            </li>
          ))}
        </ul>
      )}
      {dialog === "new" && <SpaceDialog active={active} onClose={() => setDialog(null)} />}
      {editing && <SpaceDialog key={editing._id} space={editing} active={active} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** Create a shared space, or edit one: name, flags, and add a manager. Saves only what changed. */
function SpaceDialog({ space, active, onClose }: { space?: AdminSpace; active: { _id: string; name: string | null; email: string | null }[]; onClose: () => void }) {
  const createSpace = useMutation(api.admin.createSharedSpace);
  const setManager = useMutation(api.admin.setSpaceManager);
  const updateSpace = useMutation(api.admin.updateSpace);
  const [name, setName] = useState(space?.name ?? "");
  const [managerId, setManagerId] = useState("");
  const [everyone, setEveryone] = useState(space?.everyone ?? false);
  const [sensitive, setSensitive] = useState(space?.sensitive ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const managerIds = new Set<string>(space?.managers.map((m) => m.userId) ?? []);
  const candidates = active.filter((u) => !managerIds.has(u._id));
  const save = async () => {
    setError("");
    setBusy(true);
    try {
      if (!space) await createSpace({ name, managerId: managerId as any, everyone, sensitive });
      else {
        const patch: { name?: string; everyone?: boolean; sensitive?: boolean } = {};
        if (name.trim() && name.trim() !== space.name) patch.name = name.trim();
        if (everyone !== space.everyone) patch.everyone = everyone;
        if (sensitive !== space.sensitive) patch.sensitive = sensitive;
        if (Object.keys(patch).length) await updateSpace({ spaceId: space._id as any, ...patch });
        if (managerId) await setManager({ spaceId: space._id as any, userId: managerId as any });
      }
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      title={space ? "إعدادات المساحة" : "مساحة مشتركة جديدة"}
      subtitle={space ? <span className="num">{space.memberCount} {space.memberCount === 1 ? "عضو" : "أعضاء"}</span> : undefined}
      error={error}
      busy={busy}
      submitLabel={space ? "حفظ" : "إنشاء"}
      onSubmit={save}
      onClose={onClose}
    >
      <div className="mt-4 space-y-4">
        <label className="block text-sm">
          <span className="label">الاسم</span>
          <input className="input w-full" placeholder="الشؤون المالية" value={name} onChange={(e) => setName(e.target.value)} required autoFocus={!space} />
        </label>
        <div className="text-sm">
          <span className="label">{space ? "المديرون" : "المدير"}</span>
          {space && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {space.managers.length ? (
                space.managers.map((m) => (
                  <span key={m.userId} className="badge h-6 px-2 text-xs">
                    {m.name}
                  </span>
                ))
              ) : (
                <span className="text-xs text-warning">لا مدير لهذه المساحة بعد.</span>
              )}
            </div>
          )}
          <select className="input w-full" aria-label={space ? "أضف مديراً" : "المدير"} value={managerId} onChange={(e) => setManagerId(e.target.value)} required={!space}>
            <option value="">{space ? "أضف مديراً…" : "اختر موظفاً…"}</option>
            {candidates.map((u) => (
              <option key={u._id} value={u._id}>
                {u.name ?? u.email}
              </option>
            ))}
          </select>
          {space && <span className="mt-1 block text-xs text-muted">يُضاف مديراً إلى جانب المديرين الحاليين. إزالة مدير تتم من داخل المساحة.</span>}
        </div>
        <div className="grid gap-2">
          <Toggle checked={everyone} onChange={setEveryone} title="للجميع" detail="يقرؤها كل الموظفين، مثل الأنظمة واللوائح" />
          <Toggle checked={sensitive} onChange={setSensitive} title="حسّاسة" detail="مخرجاتها لا تُنقل خارجها إلا بموافقة مديرها" />
        </div>
      </div>
    </Sheet>
  );
}

function Toggle({ checked, onChange, title, detail }: { checked: boolean; onChange: (v: boolean) => void; title: string; detail: string }) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${checked ? "border-primary bg-primary-soft" : "border-line hover:border-control"}`}>
      <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted">{detail}</span>
      </span>
    </label>
  );
}
