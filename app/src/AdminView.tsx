// Admin console pages for people and spaces (AdminConsole.tsx): «الموظفون» (activate, role,
// identifiers, disable) and «المساحات» (shared spaces, their managers and flags). An admin sees a
// space's existence and managers here, never its files unless they're a member.

import { useState } from "react";
import { useMutation, useQuery } from "onebase/react";
import { api, errorText, formatDate, STATUS_LABELS } from "./lib";
import { Icon } from "./icons";
import { IdentifiersCell } from "./MyRecordsView";
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

export function UsersAdmin() {
  const users = useQuery(api.admin.users);
  const activate = useMutation(api.admin.activate);
  const disable = useMutation(api.admin.disable);
  const setRole = useMutation(api.admin.setRole);
  const { error, setError, run } = useRun();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "pending" | "active" | "disabled">("all");
  const counts = { all: users?.length ?? 0, pending: 0, active: 0, disabled: 0 };
  for (const u of users ?? []) counts[u.status as "pending" | "active" | "disabled"]++;
  const needle = q.trim().toLowerCase();
  const shown = (users ?? []).filter((u) => (filter === "all" || u.status === filter) && (!needle || `${u.name ?? ""} ${u.email ?? ""} ${u.employeeNo ?? ""}`.toLowerCase().includes(needle)));

  return (
    <div>
      <PageHeader title="الموظفون" subtitle="من ينشئ حساباً يبقى «بانتظار التفعيل» ولا يرى شيئاً حتى تفعّله. تأكد من هوية صاحب البريد قبل التفعيل." />
      {error && <p className="alert-negative mb-4">{error}</p>}
      {counts.pending > 0 && filter !== "pending" && (
        <button className="mb-4 flex w-full items-center gap-3 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-start text-sm" onClick={() => setFilter("pending")}>
          <Icon name="user" className="text-warning" />
          <span className="flex-1">
            <span className="font-medium">{counts.pending} حساب بانتظار التفعيل</span>
          </span>
          <span className="text-xs text-muted">اعرضها</span>
        </button>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Icon name="search" className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-faint" />
          <input className="input w-full ps-9" placeholder="ابحث بالاسم أو البريد أو الرقم الوظيفي" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-1" role="tablist">
          {(
            [
              ["all", "الكل"],
              ["pending", "بانتظار التفعيل"],
              ["active", "مفعّل"],
              ["disabled", "معطّل"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={filter === k} className={`h-8 rounded-full border px-3 text-xs ${filter === k ? "border-ink bg-ink text-surface" : "border-line hover:border-control"}`} onClick={() => setFilter(k)}>
              {label} <span className="num opacity-70">{counts[k]}</span>
            </button>
          ))}
        </div>
      </div>

      {users === undefined ? (
        <p className="text-sm text-muted">جارٍ التحميل…</p>
      ) : shown.length === 0 ? (
        <EmptyState icon="users" title={needle ? "لا نتائج" : "لا أحد هنا"} />
      ) : (
        <ul className="card divide-y divide-rule">
          {shown.map((u) => {
            const items: MenuItem[] =
              u.status === "active"
                ? [
                    {
                      label: "تعطيل الحساب",
                      icon: "lock",
                      danger: true,
                      onSelect: () => void ask(`تعطيل حساب ${u.name ?? u.email}؟ يفقد الوصول فوراً.`, { danger: true, confirmLabel: "تعطيل" }).then((ok) => {
                          if (ok) void run(() => disable({ userId: u._id as any }));
                        }),
                    },
                  ]
                : [];
            return (
              <li key={u._id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-medium ${u.status === "active" ? "bg-active" : "bg-sunken text-muted"}`}>{initial(u.name ?? u.email)}</span>
                <div className="min-w-48 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 font-medium">
                    {u.name ?? "—"}
                    {u.status === "pending" && <span className="badge-warning">{STATUS_LABELS[u.status]}</span>}
                    {u.status === "disabled" && <span className="badge">{STATUS_LABELS[u.status]}</span>}
                  </p>
                  <p className="text-xs text-muted">
                    <span dir="ltr">{u.email}</span> · أُنشئ {formatDate(u.createdAt)}
                  </p>
                </div>
                <div className="text-xs" title="تُطابَق بها سجلات الموظف (بياناتي). يضعها المدير فقط">
                  <IdentifiersCell key={`${u.nationalId}|${u.employeeNo}`} userId={u._id} nationalId={u.nationalId} employeeNo={u.employeeNo} onError={setError} />
                </div>
                {u.status === "active" && u.workspaceRole ? (
                  <select className="input h-8 w-auto text-sm" aria-label="الدور" value={u.workspaceRole} onChange={(e) => run(() => setRole({ userId: u._id as any, role: e.target.value as any }))}>
                    <option value="member">موظف</option>
                    <option value="admin">مدير مساحة العمل</option>
                  </select>
                ) : (
                  <button className="btn-primary h-8" onClick={() => run(() => activate({ userId: u._id as any }))}>
                    {u.status === "disabled" ? "أعد التفعيل" : "فعّل"}
                  </button>
                )}
                <span className="w-8">{items.length > 0 && <Menu label={`خيارات ${u.name ?? u.email}`} items={items} />}</span>
              </li>
            );
          })}
        </ul>
      )}
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
