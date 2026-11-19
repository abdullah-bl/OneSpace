// «استيراد مهارة»: a ready-made skill (SKILL.md, or a .zip of its folder from skills.sh or GitHub)
// read by the server into a draft (skills:parseImport), shown here to review — name, description,
// instructions, each file (drop what you don't want) and what was skipped — then saved by the
// caller (into «مهاراتي», or proposed/added to a space's skills).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAction } from "onebase/react";
import { api, errorText } from "./lib";
import { Icon } from "./icons";
import { SkillFiles, useFileEdits, type SkillFile } from "./SkillFiles";

export type ImportDraft = { name: string; title: string; description: string; instructions: string; files: SkillFile[]; skipped: { path: string; reason: string }[] };
type Save = (d: { name: string; title: string; description: string; instructions: string; files: SkillFile[] }) => Promise<unknown>;

const toBase64 = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/** The button; opens the review panel once a file is read. */
/**
 * The button; opens the review panel once a file is read. `panelTarget`: the id of an element to show
 * the panel in (a page header's actions are too narrow for it); inline otherwise.
 */
export function SkillImport({ onSave, saveLabel = "احفظ المهارة", className = "btn-secondary", panelTarget }: { onSave: Save; saveLabel?: string; className?: string; panelTarget?: string }) {
  const parse = useAction(api.skills.parseImport);
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const edits = useFileEdits();

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      setDraft((await parse({ fileName: file.name, dataBase64: await toBase64(file) })) as ImportDraft);
      edits.reset();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const save = async () => {
    if (!draft) return;
    setError("");
    setBusy(true);
    try {
      await onSave({ name: draft.name, title: draft.title, description: draft.description, instructions: draft.instructions, files: draft.files.filter((f) => !edits.removed.includes(f.name)) });
      setDraft(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const set = (k: "name" | "title" | "description", v: string) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => setTarget(panelTarget ? document.getElementById(panelTarget) : null), [panelTarget, draft]);
  const place = (panel: ReactNode) => (target ? createPortal(panel, target) : panel);

  return (
    <>
      <input ref={input} type="file" accept=".md,.markdown,.zip" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} aria-label="ملف المهارة" />
      {!draft && (
        <button className={className} disabled={busy} onClick={() => input.current?.click()} title="SKILL.md، أو ملف zip لمجلد المهارة (من skills.sh أو GitHub)">
          <Icon name="download" size={14} /> {busy ? "يقرأ الملف…" : "استيراد مهارة"}
        </button>
      )}
      {error && !draft && <p className="text-xs text-negative">{error}</p>}
      {draft &&
        place(
        <section className="card mb-6 w-full animate-rise space-y-2.5 p-3 text-sm">
          <p className="text-xs text-muted">راجع المهارة قبل حفظها. هي تعليمات فقط: لا تمنح صلاحية، وسكربتاتها لا تعمل إلا في البيئة المعزولة بعد «نفّذ».</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="label">الاسم (يُكتب بعد /)</span>
              <input className="input h-8 w-full" dir="ltr" value={draft.name} maxLength={40} onChange={(e) => set("name", e.target.value.replace(/\s+/g, "-"))} />
            </label>
            <label className="block">
              <span className="label">العنوان</span>
              <input className="input h-8 w-full" dir="auto" value={draft.title} maxLength={80} onChange={(e) => set("title", e.target.value)} />
            </label>
          </div>
          <label className="block">
            <span className="label">متى تُستخدم</span>
            <input className="input h-8 w-full" dir="auto" value={draft.description} maxLength={300} onChange={(e) => set("description", e.target.value)} />
          </label>
          <details>
            <summary className="cursor-pointer text-xs text-muted">التعليمات ({draft.instructions.length} حرفاً)</summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-sunken p-2 text-[11px] leading-5" dir="auto">
              {draft.instructions}
            </pre>
          </details>
          <SkillFiles files={draft.files} removed={edits.removed} onToggle={edits.toggle} />
          {draft.skipped.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs text-faint">لم يُستورد {draft.skipped.length} ملفاً</summary>
              <ul className="mt-1 space-y-0.5 text-[11px] text-faint">
                {draft.skipped.map((s) => (
                  <li key={s.path}>
                    <span dir="ltr">{s.path}</span>: {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex gap-2">
            <button className="btn-primary h-8" disabled={busy || !draft.name.trim()} onClick={() => void save()}>
              {saveLabel}
            </button>
            <button className="btn-ghost h-8" onClick={() => setDraft(null)}>
              إلغاء
            </button>
          </div>
          {error && <p className="text-xs text-negative">{error}</p>}
        </section>,
        )}
    </>
  );
}
