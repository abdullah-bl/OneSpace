// Admin console pages for people and spaces (AdminConsole.tsx): «الموظفون» (activate, role,
// identifiers, disable) and «المساحات» (shared spaces, their managers and flags). An admin sees a
// space's existence and managers here, never its files unless they're a member.

import { useEffect, useState } from "react";
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
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
    <div className="fixed inset-0 z-[100] grid place-items-end bg-black/30 backdrop-blur-[2px] sm:place-items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-user-title"
        className="card w-full animate-rise rounded-b-none p-5 shadow-xl sm:max-w-md sm:rounded-b-lg"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p id="edit-user-title" className="font-medium">
          {user.name ?? "—"}
        </p>
        <p className="truncate text-xs text-muted">
          <span dir="ltr">{user.email}</span>
        </p>
        {error && <p className="alert-negative mt-3">{error}</p>}
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
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            إلغاء
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "جارٍ الحفظ…" : "حفظ"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function SpacesAdmin() {
  const users = useQuery(api.admin.users);
  const spaces = useQuery(api.admin.spaces);
  const createSpace = useMutation(api.admin.createSharedSpace);
  const setManager = useMutation(api.admin.setSpaceManager);
  const updateSpace = useMutation(api.admin.updateSpace);
  const { error, run } = useRun();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", managerId: "", everyone: false, sensitive: false });
  const [q, setQ] = useState("");
  const active = users?.filter((u) => u.status === "active" && u.workspaceRole) ?? [];
  const shown = (spaces ?? []).filter((s) => !q.trim() || s.name.includes(q.trim()));

  return (
    <div>
      <PageHeader
        title="المساحات"
        subtitle="ترى هنا وجود المساحة ومديرها فقط. لا ترى ملفاتها ما لم تكن عضواً فيها."
        actions={
          !creating && (
            <button className="btn-primary" onClick={() => setCreating(true)}>
              <Icon name="plus" /> مساحة جديدة
            </button>
          )
        }
      />
      {error && <p className="alert-negative mb-4">{error}</p>}
      {creating && (
        <form
          className="card mb-5 space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await createSpace({ name: form.name, managerId: form.managerId as any, everyone: form.everyone, sensitive: form.sensitive });
              setForm({ name: "", managerId: "", everyone: false, sensitive: false });
              setCreating(false);
            });
          }}
        >
          <p className="font-medium">مساحة مشتركة جديدة</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="label">الاسم</span>
              <input className="input w-full" placeholder="الشؤون المالية" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
            </label>
            <label className="block text-sm">
              <span className="label">المدير</span>
              <select className="input w-full" value={form.managerId} onChange={(e) => setForm({ ...form, managerId: e.target.value })} required>
                <option value="">اختر موظفاً…</option>
                {active.map((u) => (
                  <option key={u._id} value={u._id}>
                    {u.name ?? u.email}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Toggle checked={form.everyone} onChange={(v) => setForm({ ...form, everyone: v })} title="للجميع" detail="يقرؤها كل الموظفين، مثل الأنظمة واللوائح" />
            <Toggle checked={form.sensitive} onChange={(v) => setForm({ ...form, sensitive: v })} title="حسّاسة" detail="مخرجاتها لا تُنقل خارجها إلا بموافقة مديرها" />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>
              إلغاء
            </button>
            <button className="btn-primary">إنشاء</button>
          </div>
        </form>
      )}
      {(spaces?.length ?? 0) > 6 && (
        <div className="relative mb-3 sm:max-w-xs">
          <Icon name="search" className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-faint" />
          <input className="input w-full ps-9" placeholder="ابحث باسم المساحة" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      {spaces === undefined ? (
        <p className="text-sm text-muted">جارٍ التحميل…</p>
      ) : spaces.length === 0 ? (
        <EmptyState icon="folder" title="لا مساحات مشتركة بعد" action={<button className="btn-primary" onClick={() => setCreating(true)}>أنشئ أول مساحة</button>}>
          المساحة المشتركة مكان ملفات فريق ومهامه ومحادثاته.
        </EmptyState>
      ) : (
        <ul className="card divide-y divide-rule">
          {shown.map((s) => (
            <li key={s._id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-active text-muted">
                <Icon name={s.everyone ? "globe" : s.sensitive ? "lock" : "folder"} size={16} />
              </span>
              <div className="min-w-48 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 font-medium">
                  {s.name}
                  {s.everyone && <span className="badge-primary">للجميع</span>}
                  {s.sensitive && <span className="badge-warning">حسّاسة</span>}
                </p>
                <p className="text-xs text-muted">
                  المدير: {s.managers.map((m) => m.name).join("، ") || "—"} · <span className="num">{s.memberCount}</span> عضو
                </p>
              </div>
              <select className="input h-8 w-auto text-sm" aria-label="تعيين مدير" value="" onChange={(e) => e.target.value && run(() => setManager({ spaceId: s._id as any, userId: e.target.value as any }))}>
                <option value="">تعيين مدير…</option>
                {active.map((u) => (
                  <option key={u._id} value={u._id}>
                    {u.name ?? u.email}
                  </option>
                ))}
              </select>
              <Menu
                label={`خيارات ${s.name}`}
                items={[
                  { label: s.everyone ? "اجعلها للأعضاء فقط" : "اجعلها للجميع", icon: "globe", onSelect: () => void run(() => updateSpace({ spaceId: s._id as any, everyone: !s.everyone })) },
                  { label: s.sensitive ? "أزل وسم «حسّاسة»" : "اجعلها حسّاسة", icon: "lock", onSelect: () => void run(() => updateSpace({ spaceId: s._id as any, sensitive: !s.sensitive })) },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
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
