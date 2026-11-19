// A skill's files (plans/09 §2): the Python kept from the chat it was saved from (rerun as is on
// new files) and the example output whose shape is kept. Shown in «مهاراتي» and «مهارات المساحة»;
// in the editor each can be removed (saved with the skill as keepFiles).

import { useState } from "react";

export type SkillFile = { name: string; kind: "script" | "example" | "reference"; content: string; inputs?: string[] };

const KIND = { script: "سكربت", example: "نموذج المخرج", reference: "مرجع" } as const;

export function SkillFiles({ files, removed, onToggle }: { files: SkillFile[]; removed?: string[]; onToggle?: (name: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!files.length) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted">{onToggle ? "يُحفظ مع المهارة:" : "مع المهارة:"}</p>
      <ul className="space-y-1.5">
        {files.map((f) => {
          const gone = removed?.includes(f.name);
          return (
            <li key={f.name} className="rounded-md border border-line text-xs">
              <div className="flex items-center gap-2 px-2 py-1.5">
                <button className={`min-w-0 flex-1 text-start ${gone ? "text-faint line-through" : ""}`} onClick={() => setOpen(open === f.name ? null : f.name)} aria-expanded={open === f.name}>
                  <span className="font-medium" dir="ltr">
                    {f.name}
                  </span>
                  <span className="ms-2 text-muted">{KIND[f.kind]}</span>
                  {f.kind === "script" && f.inputs?.length ? <span className="ms-2 text-faint">كُتب على: {f.inputs.join("، ")}</span> : null}
                </button>
                {onToggle && (
                  <button className="btn-ghost h-6 px-2 text-xs" onClick={() => onToggle(f.name)}>
                    {gone ? "أبقه" : "احذفه"}
                  </button>
                )}
              </div>
              {open === f.name && (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-line bg-sunken p-2 text-[11px] leading-5" dir={f.kind === "script" || /\.(json|ya?ml|py|sh|js|ts|sql)$/.test(f.name) ? "ltr" : "auto"}>
                  {f.content}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
      {files.some((f) => f.kind === "script") && !onToggle && <p className="text-[11px] leading-5 text-faint">يشغّل المساعد السكربت نفسه على الملفات الجديدة، فتخرج الأرقام من الكود نفسه كل مرة.</p>}
    </div>
  );
}

/** The editor's state for files: which to drop, and keepFiles to send on save. */
export function useFileEdits() {
  const [removed, setRemoved] = useState<string[]>([]);
  const toggle = (name: string) => setRemoved((r) => (r.includes(name) ? r.filter((x) => x !== name) : [...r, name]));
  const keep = (files: SkillFile[] | undefined) => (removed.length ? { keepFiles: (files ?? []).map((f) => f.name).filter((n) => !removed.includes(n)) } : {});
  return { removed, toggle, keep, reset: () => setRemoved([]) };
}
