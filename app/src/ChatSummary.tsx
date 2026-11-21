// A long chat's summary (plans/15): a divider where the summary starts («ما قبل هنا يصل للمساعد
// ملخصاً»), the summary as the assistant reads it, and, for whoever may ask in the chat, an editor
// to fix or delete its lines (backend: chat:editSummary).

import { useState } from "react";
import { useMutation } from "onebase/react";
import { api, errorText, formatDate } from "./lib";
import { Icon } from "./icons";

export type Sections = { topics: string; facts: string[]; decisions: string[]; open: string[]; outputs: string[] };
export type ChatSummaryInfo = { afterId: string; covered: number; sections: Sections; edited: boolean; at: number };

const TITLES: Record<keyof Sections, string> = {
  topics: "ما دارت عليه المحادثة",
  facts: "حقائق وأرقام",
  decisions: "ما تقرر",
  open: "ما بقي مفتوحاً",
  outputs: "المخرجات المذكورة",
};
const LISTS = ["facts", "decisions", "open", "outputs"] as const;

export function SummaryDivider({ threadId, summary, canWrite }: { threadId: string; summary: ChatSummaryInfo; canWrite: boolean }) {
  const edit = useMutation(api.chat.editSummary);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<keyof Sections, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const s = summary.sections;

  const startEdit = () => {
    setError("");
    setDraft({ topics: s.topics, facts: s.facts.join("\n"), decisions: s.decisions.join("\n"), open: s.open.join("\n"), outputs: s.outputs.join("\n") });
  };
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError("");
    const lines = (t: string) => t.split("\n").map((l) => l.replace(/^\s*[-•]\s*/, "").trim()).filter(Boolean);
    try {
      await edit({ threadId, sections: { topics: draft.topics.trim(), facts: lines(draft.facts), decisions: lines(draft.decisions), open: lines(draft.open), outputs: lines(draft.outputs) } });
      setDraft(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="my-2">
      <div className="flex items-center gap-3 text-xs text-muted">
        <span className="h-px flex-1 bg-rule" />
        <span className="flex items-center gap-1.5">
          <Icon name="layers" size={13} />
          ما قبل هنا يصل للمساعد ملخصاً
        </span>
        <button className="text-primary hover:underline" aria-expanded={open} onClick={() => (setOpen(!open), setDraft(null))}>
          {open ? "أخفِ الملخص" : "اعرض الملخص"}
        </button>
        <span className="h-px flex-1 bg-rule" />
      </div>
      {open && (
        <div className="card mt-2 space-y-3 p-4 text-sm">
          <p className="text-xs text-muted">
            هذا ما يصل للمساعد عن أول <span className="num">{summary.covered}</span> رسالة بدل نصها، ويرجع لنصها عند الحاجة. حُدّث {formatDate(summary.at)}
            {summary.edited ? " · راجعه موظف" : ""}.
          </p>
          {!draft ? (
            <>
              {s.topics && (
                <div>
                  <p className="text-xs font-medium text-muted">{TITLES.topics}</p>
                  <p dir="auto">{s.topics}</p>
                </div>
              )}
              {LISTS.filter((k) => s[k].length).map((k) => (
                <div key={k}>
                  <p className="text-xs font-medium text-muted">{TITLES[k]}</p>
                  <ul className="list-disc space-y-0.5 ps-5">
                    {s[k].map((line, i) => (
                      <li key={i} dir="auto">
                        {line}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {canWrite && (
                <button className="btn-ghost h-8 px-2 text-xs" onClick={startEdit}>
                  <Icon name="pencil" size={13} /> صحّح الملخص
                </button>
              )}
            </>
          ) : (
            <>
              <label className="block">
                <span className="label">{TITLES.topics}</span>
                <textarea className="input min-h-14 w-full text-sm" dir="auto" value={draft.topics} onChange={(e) => setDraft({ ...draft, topics: e.target.value })} />
              </label>
              {LISTS.map((k) => (
                <label key={k} className="block">
                  <span className="label">{TITLES[k]} <span className="text-faint">(سطر لكل بند)</span></span>
                  <textarea className="input min-h-16 w-full text-sm" dir="auto" value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
                </label>
              ))}
              <p className="text-[11px] text-faint">تبقى سطورك في الملخص حين يُحدَّث لاحقاً، ما لم تغيّرها رسالة أحدث.</p>
              {error && <p className="text-xs text-negative">{error}</p>}
              <div className="flex gap-2">
                <button className="btn-primary h-8 text-xs" disabled={busy} onClick={() => void save()}>
                  {busy ? "يحفظ…" : "احفظ"}
                </button>
                <button className="btn-ghost h-8 text-xs" onClick={() => setDraft(null)}>
                  إلغاء
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
