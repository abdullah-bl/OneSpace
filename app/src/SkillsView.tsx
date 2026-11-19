// «مهاراتي»: the user's own skills, used in the chat box with "/name" (plans/07). Each is
// instructions the user owns; the AI can draft one from a finished chat («اصنع مهارة من
// المحادثة» in the chat menu), and the draft opens here to review before saving.

import { useEffect, useState } from "react";
import { SkillFiles, useFileEdits, type SkillFile } from "./SkillFiles";
import { SkillImport } from "./SkillImport";
import { useMutation, useQuery } from "onebase/react";
import { api, errorText, formatDate } from "./lib";
import { Icon } from "./icons";
import { EmptyState, PageHeader, ask } from "./ui";

export type SkillDraft = { name: string; title: string; description: string; instructions: string; fromThreadId?: string };
type Skill = SkillDraft & { _id: string; source: string; uses: number; updatedAt: number; files: SkillFile[] };

/** A draft handed over from the chat («اصنع مهارة من المحادثة»), picked up once by the page. */
let pendingDraft: SkillDraft | null = null;
export function openSkillDraft(d: SkillDraft, go: (path: string) => void) {
  pendingDraft = d;
  go("/skills");
}

const EMPTY: SkillDraft = { name: "", title: "", description: "", instructions: "" };

export function SkillsView({ onTry }: { onTry: (skill: { id: string; name: string }) => void }) {
  const skills = useQuery(api.skills.list) as Skill[] | undefined;
  const create = useMutation(api.skills.create);
  const update = useMutation(api.skills.update);
  const remove = useMutation(api.skills.remove);
  const [editing, setEditing] = useState<(SkillDraft & { _id?: string; files?: SkillFile[] }) | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const fileEdits = useFileEdits();
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (pendingDraft) {
      setEditing(pendingDraft);
      setNote("مسودة من المحادثة: راجعها وعدّلها ثم احفظها. يُحفظ معها الكود الذي نجح في المحادثة وآخر مخرج كتبه المساعد، إن وُجدا.");
      pendingDraft = null;
    }
  }, []);

  const save = async () => {
    if (!editing) return;
    setError("");
    try {
      const { _id, fromThreadId, files, ...fields } = editing;
      if (_id) await update({ skillId: _id, ...fields, ...fileEdits.keep(files) });
      else await create({ ...fields, ...(fromThreadId ? { fromThreadId } : {}) });
      setNote(`حُفظت /${editing.name.replace(/^\//, "")}. اكتب / في المحادثة لاستخدامها.`);
      setEditing(null);
      fileEdits.reset();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const set = (k: keyof SkillDraft, v: string) => setEditing((e) => (e ? { ...e, [k]: v } : e));

  return (
    <div className="mx-auto w-full max-w-[860px] px-4 py-6 lg:py-9">
      <PageHeader
        title="مهاراتي"
        subtitle="طرق عملك المحفوظة. اكتب / في مربع المحادثة واختر مهارة لتطبّق تعليماتها على طلبك. الوكيل المناسب يُختار تلقائياً."
        actions={
          <>
            <SkillImport
              panelTarget="skill-import-panel"
              onSave={async (d) => {
                await create(d);
                setNote(`استُوردت /${d.name}. اكتب / في المحادثة لاستخدامها، أو يختارها المساعد حين يناسبها الطلب.`);
              }}
            />
            <button className="btn-primary" onClick={() => (setEditing({ ...EMPTY }), setNote(""))}>
              <Icon name="plus" /> مهارة جديدة
            </button>
          </>
        }
      />
      <div id="skill-import-panel" />
      {error && <p className="alert-negative mb-3">{error}</p>}
      {note && <p className="alert-info mb-3 animate-fade">{note}</p>}

      {editing && (
        <section className="card mb-6 animate-rise space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="label">الاسم (يُكتب بعد /)</span>
              <div className="flex items-center rounded-md border border-control bg-surface focus-within:border-primary">
                <span className="ps-3 text-faint" dir="ltr">
                  /
                </span>
                <input className="h-9 w-full bg-transparent px-1 text-sm outline-none" value={editing.name} maxLength={40} onChange={(e) => set("name", e.target.value.replace(/\s+/g, "-"))} placeholder="خطاب-رسمي" />
              </div>
            </label>
            <label className="text-sm">
              <span className="label">العنوان</span>
              <input className="input w-full" value={editing.title} maxLength={80} onChange={(e) => set("title", e.target.value)} placeholder="خطاب رسمي بصيغة الإدارة" />
            </label>
          </div>
          <label className="block text-sm">
            <span className="label">متى تُستخدم</span>
            <input className="input w-full" value={editing.description} maxLength={300} onChange={(e) => set("description", e.target.value)} placeholder="حين أطلب خطاباً لجهة خارجية" />
          </label>
          <label className="block text-sm">
            <span className="label">التعليمات</span>
            <textarea className="textarea min-h-48 w-full leading-7" dir="auto" value={editing.instructions} maxLength={16000} onChange={(e) => set("instructions", e.target.value)} placeholder="ابدأ بـ«سعادة…»، ثم الموضوع في سطر، ثم فقرتين قصيرتين…" />
          </label>
          {editing.files && <SkillFiles files={editing.files} removed={fileEdits.removed} onToggle={fileEdits.toggle} />}
          <div className="flex gap-2">
            <button className="btn-primary" onClick={() => void save()} disabled={!editing.name.trim() || !editing.instructions.trim()}>
              حفظ
            </button>
            <button className="btn-ghost" onClick={() => setEditing(null)}>
              إلغاء
            </button>
          </div>
        </section>
      )}

      {skills && skills.length === 0 && !editing && (
        <EmptyState icon="bot" title="لا مهارات بعد" action={<button className="btn-secondary" onClick={() => setEditing({ ...EMPTY })}>اكتب أول مهارة</button>}>
          أنشئ مهارة بنفسك، أو افتح محادثة أعجبتك نتيجتها واختر «اصنع مهارة من المحادثة» من قائمتها لتكتبها لك.
        </EmptyState>
      )}

      {skills && skills.length > 0 && (
        <ul className="card divide-y divide-rule">
          {skills.map((s) => (
            <li key={s._id} className="flex flex-wrap items-center gap-3 p-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-primary-soft font-bold text-primary" dir="ltr">
                /
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium" dir="ltr">
                    /{s.name}
                  </span>
                  <span className="truncate text-sm text-muted">{s.title}</span>
                  {s.source === "chat" && <span className="badge">من محادثة</span>}
                  {s.files.length > 0 && (
                    <button className="badge" onClick={() => setOpen(open === s._id ? null : s._id)} aria-expanded={open === s._id}>
                      {s.files.length} {s.files.length === 1 ? "ملف" : "ملفات"}
                    </button>
                  )}
                </div>
                <div className="meta truncate">
                  {s.description || "—"} · استُخدمت {s.uses} · {formatDate(s.updatedAt)}
                </div>
                {open === s._id && (
                  <div className="mt-2">
                    <SkillFiles files={s.files} />
                  </div>
                )}
              </div>
              <button className="btn-ghost" onClick={() => onTry({ id: s._id, name: s.name })}>
                استخدمها
              </button>
              <button className="btn-ghost" onClick={() => (setEditing({ ...s }), fileEdits.reset(), setNote(""))}>
                تعديل
              </button>
              <button className="btn-danger" onClick={() => void ask(`حذف /${s.name}؟`, { danger: true, confirmLabel: "حذف" }).then((ok) => { if (ok) void remove({ skillId: s._id }).catch((e) => setError(errorText(e))); })}>
                حذف
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
