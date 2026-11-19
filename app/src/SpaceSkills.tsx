// «مهارات المساحة» (plans/09 §2): the space's saved ways of working, run by any member with
// /name or picked by the assistant from their description. Managers add, edit and approve;
// members propose (or share one of «مهاراتي»). Backend: onebase/skills.ts.

import { useState } from "react";
import { useMutation, useQuery } from "onebase/react";
import { api, errorText } from "./lib";
import { Icon } from "./icons";
import { ask, Menu, tell } from "./ui";
import { SkillFiles, useFileEdits, type SkillFile } from "./SkillFiles";

type Draft = { name: string; title: string; description: string; instructions: string };
type Row = Draft & { _id: string; uses: number; version: number; by: string; mine: boolean; files: SkillFile[] };
const EMPTY: Draft = { name: "", title: "", description: "", instructions: "" };

export function SpaceSkills({ spaceId }: { spaceId: string }) {
  const data = useQuery(api.skills.space, { spaceId }) as { canManage: boolean; canPropose: boolean; skills: Row[]; proposals: Row[] } | undefined;
  const mine = useQuery(api.skills.list) as Row[] | undefined;
  const add = useMutation(api.skills.addSpace);
  const update = useMutation(api.skills.updateSpace);
  const remove = useMutation(api.skills.removeSpace);
  const review = useMutation(api.skills.reviewSpace);
  const share = useMutation(api.skills.shareToSpace);
  const [editing, setEditing] = useState<(Draft & { _id?: string; files?: SkillFile[] }) | null>(null);
  const fileEdits = useFileEdits();
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  if (data === undefined) return <p className="text-sm text-muted">جارٍ التحميل…</p>;
  const run = (p: Promise<unknown>) => p.catch((e) => void tell(errorText(e)));
  const canAdd = data.canManage || data.canPropose;
  const set = (k: keyof Draft, v: string) => setEditing((e) => (e ? { ...e, [k]: v } : e));

  const save = async () => {
    if (!editing) return;
    setMsg("");
    try {
      const { _id, files, ...fields } = editing;
      if (_id) await update({ skillId: _id, ...fields, ...fileEdits.keep(files) });
      else {
        const r = await add({ spaceId, ...fields });
        if (r.state === "proposed") setMsg("أُرسلت لمديري المساحة لاعتمادها");
      }
      setEditing(null);
      fileEdits.reset();
    } catch (e) {
      setMsg(errorText(e));
    }
  };

  const item = (s: Row, proposal: boolean) => (
    <li key={s._id} className={proposal ? "rounded-lg border border-dashed border-line p-2" : "group"}>
      <div className="flex items-start gap-2">
        <button className="min-w-0 flex-1 text-start" onClick={() => setOpen(open === s._id ? null : s._id)} aria-expanded={open === s._id}>
          <span className="font-medium" dir="ltr">
            /{s.name}
          </span>
          <span className="ms-2 text-muted">{s.title !== s.name ? s.title : ""}</span>
          {s.description && <span className="block text-xs leading-5 text-faint">{s.description}</span>}
          {s.files.length > 0 && <span className="text-[11px] text-muted">{s.files.map((f) => f.name).join(" · ")}</span>}
        </button>
        {!proposal && data.canManage && (
          <Menu
            label="خيارات"
            className="opacity-60 group-hover:opacity-100"
            items={[
              { label: "تعديل", icon: "pencil", onSelect: () => (fileEdits.reset(), setEditing({ _id: s._id, name: s.name, title: s.title, description: s.description, instructions: s.instructions, files: s.files })) },
              {
                label: "احذف",
                icon: "x",
                danger: true,
                onSelect: () => void ask(`حذف /${s.name} من المساحة؟`, { danger: true, confirmLabel: "حذف" }).then((ok) => ok && run(remove({ skillId: s._id }))),
              },
            ]}
          />
        )}
      </div>
      {open === s._id && (
        <div className="mt-1.5 space-y-2">
          <p className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-sunken p-2 text-xs leading-6" dir="auto">
            {s.instructions}
          </p>
          <SkillFiles files={s.files} />
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
        <span>{s.mine ? "أنت" : s.by}</span>
        {!proposal && (
          <span>
            · استُخدمت {s.uses} · النسخة {s.version}
          </span>
        )}
        {proposal && (
          <>
            <span className="ms-auto" />
            {data.canManage && (
              <button className="btn-secondary h-7 px-2 text-xs" onClick={() => void run(review({ skillId: s._id, approve: true }))}>
                اعتمد
              </button>
            )}
            {s.mine && !data.canManage && (
              <button className="btn-ghost h-7 px-2 text-xs" onClick={() => (fileEdits.reset(), setEditing({ _id: s._id, name: s.name, title: s.title, description: s.description, instructions: s.instructions, files: s.files }))}>
                عدّل
              </button>
            )}
            <button className="btn-ghost h-7 px-2 text-xs" onClick={() => void run(data.canManage ? review({ skillId: s._id, approve: false }) : remove({ skillId: s._id }))}>
              {data.canManage ? "ارفض" : "اسحب"}
            </button>
          </>
        )}
      </div>
    </li>
  );

  return (
    <div className="text-sm">
      {data.skills.length === 0 && data.proposals.length === 0 && !editing && (
        <p className="leading-6 text-muted">
          {canAdd
            ? "طرق عمل الفريق المحفوظة: يستخدمها الأعضاء بكتابة / ويختارها المساعد حين يناسبها الطلب. أسهل طريقة: أنجز المهمة في محادثة هنا ثم قل «احفظها مهارة للمساحة»."
            : "لا مهارات في هذه المساحة بعد."}
        </p>
      )}
      {data.skills.length > 0 && <ul className="space-y-2.5">{data.skills.map((s) => item(s, false))}</ul>}
      {data.proposals.length > 0 && (
        <div className="mt-3 border-t border-rule pt-3">
          <p className="mb-1.5 text-xs font-medium text-muted">{data.canManage ? "مقترحات بانتظار اعتمادك" : "مقترحاتك بانتظار المدير"}</p>
          <ul className="space-y-1.5">{data.proposals.map((s) => item(s, true))}</ul>
        </div>
      )}

      {editing && (
        <div className="mt-3 space-y-2 border-t border-rule pt-3">
          <div className="flex items-center rounded-md border border-control bg-surface focus-within:border-primary">
            <span className="ps-3 text-faint" dir="ltr">
              /
            </span>
            <input className="h-8 w-full bg-transparent px-1 text-sm outline-none" aria-label="الاسم" value={editing.name} maxLength={40} onChange={(e) => set("name", e.target.value.replace(/\s+/g, "-"))} placeholder="مفاضلة-المتقدمين" />
          </div>
          <input className="input h-8 w-full" aria-label="العنوان" value={editing.title} maxLength={80} onChange={(e) => set("title", e.target.value)} placeholder="العنوان" />
          <input className="input h-8 w-full" aria-label="متى تُستخدم" value={editing.description} maxLength={300} onChange={(e) => set("description", e.target.value)} placeholder="متى تُستخدم (يقرؤه المساعد ليختارها)" />
          <textarea className="textarea min-h-32 w-full text-xs leading-6" aria-label="التعليمات" dir="auto" value={editing.instructions} maxLength={16000} onChange={(e) => set("instructions", e.target.value)} placeholder="الخطوات، الصيغة، ما يجب تجنبه…" />
          {editing.files && <SkillFiles files={editing.files} removed={fileEdits.removed} onToggle={fileEdits.toggle} />}
          <div className="flex gap-2">
            <button className="btn-primary h-8" onClick={() => void save()} disabled={!editing.name.trim() || !editing.instructions.trim()}>
              {editing._id || data.canManage ? "احفظ" : "اقترح"}
            </button>
            <button className="btn-ghost h-8" onClick={() => setEditing(null)}>
              إلغاء
            </button>
          </div>
        </div>
      )}

      {canAdd && !editing && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className="btn-secondary h-8" onClick={() => (setEditing({ ...EMPTY }), setMsg(""))}>
            <Icon name="plus" size={14} /> {data.canManage ? "مهارة جديدة" : "اقترح مهارة"}
          </button>
          {mine && mine.length > 0 && (
            <select
              className="input h-8 w-auto text-xs"
              aria-label="شارك من مهاراتي"
              value=""
              onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                setMsg("");
                share({ skillId: id, spaceId })
                  .then((r) => setMsg(r.state === "proposed" ? "أُرسلت لمديري المساحة لاعتمادها" : "أُضيفت إلى المساحة"))
                  .catch((err) => setMsg(errorText(err)));
              }}
            >
              <option value="">شارك من «مهاراتي»…</option>
              {mine.map((s) => (
                <option key={s._id} value={s._id}>
                  /{s.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {msg && <p className="mt-2 text-xs text-muted">{msg}</p>}
    </div>
  );
}
