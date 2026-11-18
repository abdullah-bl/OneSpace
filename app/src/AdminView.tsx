import { useState } from "react";
import { useMutation, useQuery } from "onebase/react";
import { api, errorText, formatDate, STATUS_LABELS } from "./lib";
import { IdentifiersCell } from "./MyRecordsView";

export function AdminView() {
  const users = useQuery(api.admin.users);
  const spaces = useQuery(api.admin.spaces);
  const activate = useMutation(api.admin.activate);
  const disable = useMutation(api.admin.disable);
  const setRole = useMutation(api.admin.setRole);
  const createSpace = useMutation(api.admin.createSharedSpace);
  const setManager = useMutation(api.admin.setSpaceManager);
  const updateSpace = useMutation(api.admin.updateSpace);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", managerId: "", everyone: false, sensitive: false });
  const active = users?.filter((u) => u.status === "active" && u.workspaceRole) ?? [];

  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <h1 className="page-title">إدارة مساحة العمل</h1>
      {error && <p className="rounded-lg bg-negative-soft p-2 text-sm text-negative">{error}</p>}

      <section className="space-y-2">
        <h2 className="section-title">الموظفون</h2>
        <p className="text-sm text-muted">من ينشئ حساباً يبقى "بانتظار التفعيل" ولا يرى شيئاً حتى تفعّله هنا. تأكد من هوية صاحب البريد قبل التفعيل.</p>
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead className="bg-sunken">
              <tr>
                <th className="th">الاسم</th>
                <th className="th">البريد</th>
                <th className="th">الحالة</th>
                <th className="th">الدور</th>
                <th className="th" title="تُطابَق بها سجلات الموظف (بياناتي). يضعها المدير فقط">الهوية / الوظيفي</th>
                <th className="th">أُنشئ</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {users?.map((u) => (
                <tr key={u._id} className="border-t border-rule">
                  <td className="td font-bold">{u.name ?? "—"}</td>
                  <td className="td text-xs" dir="ltr">{u.email}</td>
                  <td className="td">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${u.status === "active" ? "bg-raised text-ink" : u.status === "pending" ? "bg-warning-soft text-warning" : "bg-raised text-muted"}`}>
                      {STATUS_LABELS[u.status]}
                    </span>
                  </td>
                  <td className="td">
                    {u.status === "active" && u.workspaceRole ? (
                      <select className="input" value={u.workspaceRole} onChange={(e) => run(() => setRole({ userId: u._id as any, role: e.target.value as any }))}>
                        <option value="member">موظف</option>
                        <option value="admin">مدير مساحة العمل</option>
                      </select>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="td">
                    <IdentifiersCell key={`${u.nationalId}|${u.employeeNo}`} userId={u._id} nationalId={u.nationalId} employeeNo={u.employeeNo} onError={setError} />
                  </td>
                  <td className="td text-xs text-muted">{formatDate(u.createdAt)}</td>
                  <td className="td">
                    {u.status === "active" ? (
                      <button className="btn-danger" onClick={() => confirm(`تعطيل حساب ${u.name ?? u.email}؟ يفقد الوصول فوراً.`) && run(() => disable({ userId: u._id as any }))}>
                        تعطيل
                      </button>
                    ) : (
                      <button className="btn-primary" onClick={() => run(() => activate({ userId: u._id as any }))}>
                        {u.status === "disabled" ? "إعادة تفعيل" : "إضافة لمساحة العمل"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="section-title">المساحات المشتركة</h2>
        <p className="text-sm text-muted">ترى هنا وجود المساحة ومديرها فقط. لا ترى ملفاتها ما لم تكن عضواً فيها.</p>
        <form
          className="card flex flex-wrap items-end gap-2 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await createSpace({ name: form.name, managerId: form.managerId as any, everyone: form.everyone, sensitive: form.sensitive });
              setForm({ name: "", managerId: "", everyone: false, sensitive: false });
            });
          }}
        >
          <input className="input" placeholder="اسم المساحة" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <select className="input" value={form.managerId} onChange={(e) => setForm({ ...form, managerId: e.target.value })} required>
            <option value="">مدير المساحة…</option>
            {active.map((u) => (
              <option key={u._id} value={u._id}>
                {u.name ?? u.email}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={form.everyone} onChange={(e) => setForm({ ...form, everyone: e.target.checked })} /> للجميع
          </label>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={form.sensitive} onChange={(e) => setForm({ ...form, sensitive: e.target.checked })} /> حسّاسة
          </label>
          <button className="btn-primary">إنشاء</button>
        </form>
        <div className="card divide-y divide-rule">
          {spaces?.map((s) => (
            <div key={s._id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
              <div className="min-w-40 flex-1">
                <div className="font-bold">
                  {s.everyone ? "" : ""} {s.name}
                </div>
                <div className="text-xs text-muted">
                  المدير: {s.managers.map((m) => m.name).join("، ") || "—"} · {s.memberCount} عضو
                </div>
              </div>
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={s.everyone} onChange={(e) => run(() => updateSpace({ spaceId: s._id as any, everyone: e.target.checked }))} /> للجميع
              </label>
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={s.sensitive} onChange={(e) => run(() => updateSpace({ spaceId: s._id as any, sensitive: e.target.checked }))} /> حسّاسة
              </label>
              <select className="input" value="" onChange={(e) => e.target.value && run(() => setManager({ spaceId: s._id as any, userId: e.target.value as any }))}>
                <option value="">تعيين مدير…</option>
                {active.map((u) => (
                  <option key={u._id} value={u._id}>
                    {u.name ?? u.email}
                  </option>
                ))}
              </select>
            </div>
          ))}
          {spaces?.length === 0 && <div className="p-3 text-sm text-faint">لا مساحات مشتركة بعد</div>}
        </div>
      </section>
    </div>
  );
}
