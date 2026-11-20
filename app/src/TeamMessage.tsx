// A message between colleagues in a shared chat (plans/16): «@محمد خلّص التقرير» goes to Mohammed,
// not to the assistant. Everyone sees who it's for and what each person did with it; the person
// named sees a card: hand it to the assistant (it works as them, and the answer is in the chat for
// everyone), take it themselves, or mark it done. Backend: chat:handoff.

import { useState } from "react";
import { useMutation } from "onebase/react";
import { api, errorText } from "./lib";
import { Icon } from "./icons";

export type TeamTo = { userId: string; name: string; state: "pending" | "assistant" | "self" | "done"; mine: boolean };

const STATE: Record<TeamTo["state"], (name: string) => string> = {
  pending: (n) => `بانتظار ${n}`,
  assistant: (n) => `سلّمها ${n} للمساعد`,
  self: (n) => `يتولاها ${n}`,
  done: (n) => `أنهاها ${n}`,
};
const TONE: Record<TeamTo["state"], string> = { pending: "badge", assistant: "badge-primary", self: "badge-primary", done: "badge-positive" };

export function TeamMessage({ messageId, author, mine, text, to, canWrite, busy }: { messageId: string; author: string | null; mine: boolean; text: string; to: TeamTo[]; canWrite: boolean; busy: boolean }) {
  const handoff = useMutation(api.chat.handoff);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const me = to.find((t) => t.mine);
  const act = async (action: "assistant" | "self" | "done") => {
    setError("");
    setWorking(true);
    try {
      await handoff({ messageId, action });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className="flex animate-rise flex-col items-start gap-1.5">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted">
        <Icon name="users" size={13} />
        {mine ? "أنت" : (author ?? "زميل")} ← {to.map((t) => (t.mine ? "أنت" : t.name)).join("، ")}
      </span>
      <div className="max-w-[85%] rounded-2xl rounded-ss-md border border-line bg-surface px-4 py-2.5 text-[15px] leading-7">
        <div className="whitespace-pre-wrap [overflow-wrap:anywhere]" dir="auto">
          {text}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {to.map((t) => (
          <span key={t.userId} className={TONE[t.state]}>
            {STATE[t.state](t.mine ? "أنت" : t.name)}
          </span>
        ))}
      </div>
      {me && me.state !== "done" && (
        <div className="card mt-1 w-full max-w-[85%] space-y-2 p-3 text-sm">
          <p className="text-xs text-muted">
            {me.state === "pending" ? "هذا الطلب موجّه لك. اختر ما تفعله به:" : me.state === "assistant" ? "سلّمته للمساعد، وإجابته في المحادثة للجميع." : "تتولاه بنفسك."}
          </p>
          <div className="flex flex-wrap gap-2">
            {me.state === "pending" && canWrite && (
              <button className="btn-primary h-8 text-xs" disabled={working || busy} onClick={() => void act("assistant")} title="يشتغل المساعد عليها بصلاحياتك، وتظهر النتيجة في المحادثة للجميع">
                <Icon name="bot" size={13} /> خلّ المساعد يشتغل عليها
              </button>
            )}
            {me.state === "pending" && (
              <button className="btn-secondary h-8 text-xs" disabled={working} onClick={() => void act("self")}>
                أتولاها بنفسي
              </button>
            )}
            <button className="btn-ghost h-8 text-xs" disabled={working} onClick={() => void act("done")}>
              <Icon name="check" size={13} /> تمت
            </button>
          </div>
          {busy && me.state === "pending" && canWrite && <p className="text-[11px] text-faint">المساعد مشغول بطلب آخر في هذه المحادثة؛ انتظر حتى ينتهي.</p>}
          {error && <p className="text-xs text-negative">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** The question that hands a colleague's message to the assistant: one quiet line, not a bubble. */
export function HandoffLine({ by }: { by: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      <Icon name="bot" size={13} />
      <span>{by} سلّم الطلب للمساعد</span>
    </div>
  );
}
