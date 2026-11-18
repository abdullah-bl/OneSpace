// The space as a "project": optional instructions (used as context by the agent from Phase 2),
// edited by the space's manager, read by everyone who can read the space.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "onebase/react";
import { api, errorText, formatDate, type SpaceInfo } from "./lib";

export function SpaceInstructions({ space }: { space: SpaceInfo }) {
  const info = useQuery(api.spaces.get, { spaceId: space._id as any });
  const save = useMutation(api.spaces.setInstructions);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => setText(info?.instructions ?? ""), [info?.instructions]);
  if (info === undefined) return <div className="text-sm text-slate-400">جارٍ التحميل…</div>;
  if (!space.canManage) {
    return (
      <div className="card p-4 text-sm">
        {info.instructions ? <p className="whitespace-pre-wrap">{info.instructions}</p> : <p className="text-slate-400">لا تعليمات لهذه المساحة.</p>}
      </div>
    );
  }
  return (
    <form
      className="card space-y-2 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setMsg("");
        try {
          await save({ spaceId: space._id as any, instructions: text });
          setMsg("حُفظت");
        } catch (err) {
          setMsg(errorText(err));
        }
      }}
    >
      <p className="text-xs text-slate-500">تعليمات اختيارية تجعل المساحة "مشروعاً": يقرؤها الأعضاء ويعمل بها الوكيل في محادثات هذه المساحة.</p>
      <textarea className="input w-full" rows={8} value={text} onChange={(e) => setText(e.target.value)} maxLength={20000} placeholder="مثال: اكتب بلغة رسمية، واعتمد على لائحة المشتريات المحدّثة…" />
      <div className="flex items-center gap-3">
        <button className="btn-primary">حفظ</button>
        {msg && <span className="text-xs text-slate-500">{msg}</span>}
        {info.instructionsUpdatedAt && <span className="text-xs text-slate-400">آخر تعديل {formatDate(info.instructionsUpdatedAt)}</span>}
      </div>
    </form>
  );
}
