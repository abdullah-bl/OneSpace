// "بياناتي": records about the signed-in employee, matched on the national id / employee
// number the workspace admin put on the account, plus certificates issued to them.

import { useMutation, useQuery } from "onebase/react";
import { api, errorText, formatDate } from "./lib";
import { useState } from "react";

export function MyRecordsView() {
  const mine = useQuery(api.records.mine);
  const requestDownload = useMutation(api.documents.requestDownload);
  const [error, setError] = useState("");
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <h1 className="page-title">بياناتي</h1>
      <p className="text-sm text-muted">سجلات عنك أدخلتها الإدارات (دورات، نتائج، شهادات). تُطابق برقمك المسجّل على حسابك من مدير مساحة العمل.</p>
      {error && <p className="rounded-lg bg-negative-soft p-2 text-sm text-negative">{error}</p>}
      {mine && !mine.hasIdentity && <div className="card p-4 text-sm">لا يوجد رقم هوية أو رقم وظيفي على حسابك بعد. يضيفه مدير مساحة العمل.</div>}
      {mine?.documents && mine.documents.length > 0 && (
        <section className="space-y-2">
          <h2 className="section-title">شهاداتي</h2>
          <div className="card divide-y divide-rule">
            {mine.documents.map((d) => (
              <div key={d._id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
                <div className="flex-1">
                  <div className="font-bold">{d.templateName}</div>
                  <div className="text-xs text-muted" dir="ltr">
                    {d.serial} · {d.verifyCode} · {d.issuedAt ? formatDate(d.issuedAt) : ""}
                  </div>
                </div>
                <button
                  className="btn-ghost"
                  onClick={() =>
                    requestDownload({ documentId: d._id as any })
                      .then((url) => window.open(url, "_blank", "noopener"))
                      .catch((e) => setError(errorText(e)))
                  }
                >
                  تنزيل PDF
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      {mine?.sets.map((s) => (
        <section key={s.recordSetId} className="space-y-2">
          <h2 className="section-title">{s.setName}</h2>
          <div className="card overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-sunken">
                <tr>
                  {s.columns.map((c) => (
                    <th key={c.key} className="th">
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r) => (
                  <tr key={r.recordId} className="border-t border-rule">
                    {s.columns.map((c) => (
                      <td key={c.key} className="td">
                        {r.data[c.key] === null || r.data[c.key] === undefined ? "" : String(r.data[c.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      {mine && mine.hasIdentity && mine.sets.length === 0 && mine.documents.length === 0 && <p className="text-sm text-faint">لا توجد سجلات باسمك.</p>}
    </div>
  );
}

/** Admin screen cell: national id / employee number of an account. */
export function IdentifiersCell({ userId, nationalId, employeeNo, onError }: { userId: string; nationalId: string | null; employeeNo: string | null; onError: (m: string) => void }) {
  const setIdentifiers = useMutation(api.admin.setIdentifiers);
  const save = (field: "nationalId" | "employeeNo", value: string, old: string | null) => {
    const v = value.trim();
    if (v === (old ?? "")) return;
    setIdentifiers({ userId: userId as any, [field]: v || null } as any).catch((e) => onError(errorText(e)));
  };
  return (
    <div className="flex flex-col gap-1">
      <input className="input w-32 text-xs" dir="ltr" placeholder="رقم الهوية" defaultValue={nationalId ?? ""} onBlur={(e) => save("nationalId", e.target.value, nationalId)} />
      <input className="input w-32 text-xs" dir="ltr" placeholder="الرقم الوظيفي" defaultValue={employeeNo ?? ""} onBlur={(e) => save("employeeNo", e.target.value, employeeNo)} />
    </div>
  );
}
