import { useState } from "react";
import { useQuery } from "onebase/react";
import { api, formatDate, type SpaceInfo } from "./lib";

const ACTION_LABELS: Record<string, string> = {
  "workspace.bootstrap": "تهيئة مساحة العمل",
  "user.activate": "تفعيل موظف",
  "user.reenable": "إعادة تفعيل موظف",
  "user.disable": "تعطيل موظف",
  "user.role": "تغيير دور في مساحة العمل",
  "space.create": "إنشاء مساحة",
  "space.create_personal": "إنشاء مساحة خاصة",
  "space.update": "تعديل إعدادات مساحة",
  "member.add": "إضافة عضو",
  "member.remove": "إزالة عضو",
  "member.role": "تغيير دور عضو",
  "file.upload": "رفع ملف",
  "file.version": "نسخة جديدة",
  "file.delete": "حذف ملف",
  "file.move_out": "نقل ملف إلى خارج المساحة",
  "file.move_in": "نقل ملف إلى المساحة",
  "file.copy_out": "نسخ ملف من المساحة",
  "file.copy_in": "نسخ ملف إلى المساحة",
  "file.open": "فتح ملف حسّاس",
  "file.download": "تنزيل ملف حسّاس",
  "ai.turn": "سؤال للمساعد استخدم محتوى المساحة",
};

/** Workspace admin: everything with filters. Space manager: pick one of the spaces they manage. */
export function AuditView({ isAdmin, spaces }: { isAdmin: boolean; spaces: SpaceInfo[] }) {
  const adminSpaces = useQuery(api.admin.spaces, isAdmin ? {} : "skip");
  const users = useQuery(api.admin.users, isAdmin ? {} : "skip");
  const managed = spaces.filter((s) => s.canManage);
  const spaceOptions = isAdmin ? [...spaces.filter((s) => s.kind === "personal"), ...(adminSpaces ?? []).map((s) => ({ _id: s._id, name: s.name }))] : managed;
  const [spaceId, setSpaceId] = useState(isAdmin ? "" : (managed[0]?._id ?? ""));
  const [userId, setUserId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const args = {
    ...(spaceId ? { spaceId } : {}),
    ...(userId ? { userId } : {}),
    ...(from ? { from: new Date(from).getTime() } : {}),
    ...(to ? { to: new Date(to).getTime() + 86_400_000 - 1 } : {}),
  };
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <h1 className="text-xl font-semibold">سجل التدقيق</h1>
      <p className="text-sm text-slate-500">من فعل ماذا، وفي أي مساحة، ومتى. لا يعرض محتوى الملفات، وأسماء الملفات في المساحات التي لا تقرؤها مخفية.</p>
      <div className="card flex flex-wrap items-end gap-2 p-3 text-sm">
        <label className="space-y-1">
          <div className="text-xs text-slate-500">المساحة</div>
          <select className="input" value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
            {isAdmin && <option value="">كل المساحات</option>}
            {spaceOptions.map((s) => (
              <option key={s._id} value={s._id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {isAdmin && (
          <label className="space-y-1">
            <div className="text-xs text-slate-500">المستخدم</div>
            <select className="input" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">الكل</option>
              {users?.map((u) => (
                <option key={u._id} value={u._id}>
                  {u.name ?? u.email}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="space-y-1">
          <div className="text-xs text-slate-500">من</div>
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="space-y-1">
          <div className="text-xs text-slate-500">إلى</div>
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {isAdmin || spaceId ? <AuditTable args={args} /> : <p className="text-sm text-slate-500">لا تدير أي مساحة.</p>}
    </div>
  );
}

export function AuditTable({ args }: { args: Record<string, unknown> }) {
  const rows = useQuery(api.audit.list, args as any);
  return (
    <div className="card overflow-x-auto">
      <table className="w-full">
        <thead className="bg-slate-50">
          <tr>
            <th className="th">الوقت</th>
            <th className="th">المستخدم</th>
            <th className="th">الإجراء</th>
            <th className="th">المساحة</th>
            <th className="th">التفاصيل</th>
          </tr>
        </thead>
        <tbody>
          {rows === undefined && (
            <tr>
              <td className="td text-slate-400" colSpan={5}>جارٍ التحميل…</td>
            </tr>
          )}
          {rows?.length === 0 && (
            <tr>
              <td className="td text-slate-400" colSpan={5}>لا سجلات</td>
            </tr>
          )}
          {rows?.map((r) => (
            <tr key={r._id} className="border-t border-slate-100">
              <td className="td whitespace-nowrap text-xs text-slate-500">{formatDate(r.at)}</td>
              <td className="td">{r.userName ?? "—"}</td>
              <td className="td">{ACTION_LABELS[r.action] ?? r.action}</td>
              <td className="td">{r.spaceName ?? "—"}</td>
              <td className="td text-xs text-slate-600">
                {Object.entries(r.detail)
                  .filter(([, v]) => v !== null)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" · ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
