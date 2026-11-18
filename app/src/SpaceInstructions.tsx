// The space's instructions (the "project" brief the assistant follows in the space's chats),
// edited by the space's manager, read by everyone who can read the space. Shown inside the
// space page's side panel.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "onebase/react";
import { api, errorText, formatDate, type SpaceInfo } from "./lib";

export function SpaceInstructions({ space }: { space: SpaceInfo }) {
  const info = useQuery(api.spaces.get, { spaceId: space._id as any });
  const save = useMutation(api.spaces.setInstructions);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => setText(info?.instructions ?? ""), [info?.instructions]);
  if (info === undefined) return <div className="text-sm text-muted">جارٍ التحميل…</div>;
  if (!editing) {
    return (
      <div className="text-sm">
        {info.instructions ? <p className="line-clamp-6 whitespace-pre-wrap text-[#3d3d3d]">{info.instructions}</p> : <p className="text-muted">لا تعليمات لهذه المساحة{space.canManage ? ". أضف ما يجب أن يعرفه المساعد هنا: الأسلوب، والمراجع المعتمدة، وما يُتجنّب." : "."}</p>}
        {space.canManage && (
          <button className="btn-secondary mt-3 h-8" onClick={() => setEditing(true)}>
            {info.instructions ? "تعديل التعليمات" : "إضافة تعليمات"}
          </button>
        )}
        {msg && <span className="ms-2 text-xs text-muted">{msg}</span>}
      </div>
    );
  }
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setMsg("");
        try {
          await save({ spaceId: space._id as any, instructions: text });
          setMsg("حُفظت");
          setEditing(false);
        } catch (err) {
          setMsg(errorText(err));
        }
      }}
    >
      <label className="block text-xs text-muted" htmlFor={`instr-${space._id}`}>
        يعمل بها المساعد في كل محادثات هذه المساحة.
      </label>
      <textarea id={`instr-${space._id}`} className="input h-auto w-full py-2" rows={8} value={text} onChange={(e) => setText(e.target.value)} maxLength={20000} placeholder="مثال: اكتب بلغة رسمية، واعتمد على لائحة المشتريات المحدّثة." />
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary h-8">حفظ</button>
        <button type="button" className="btn-ghost h-8" onClick={() => (setEditing(false), setText(info.instructions ?? ""))}>
          إلغاء
        </button>
        {msg && <span className="text-xs text-negative">{msg}</span>}
        {info.instructionsUpdatedAt && <span className="text-xs text-muted">آخر تعديل {formatDate(info.instructionsUpdatedAt)}</span>}
      </div>
    </form>
  );
}
