// The chat on the documents: threads, streamed answers with numbered source cards that open the
// file at the cited page, scope chips (كل ما أملك / مساحة / ملف), 👍/👎, and the queue/tool status.
// Phase 6: the agent picker (default first), proposal cards for write tools (نفّذ / إلغاء), and
// threads opened from a task ("اعمل عليها مع الوكيل").

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useAction, useMutation, useQuery } from "onebase/react";
import { ArtifactPanel } from "./ArtifactPanel";
import { api, badge, errorText, type SpaceInfo } from "./lib";

export type Scope = { kind: "all" | "space" | "file"; id?: string; label?: string };

/** Opens the chat scoped to one file ("اسأل عن هذا الملف"); App listens for this event. */
export function askAboutFile(fileId: string, name: string) {
  window.dispatchEvent(new CustomEvent("onespace:ask", { detail: { kind: "file", id: fileId, label: name } satisfies Scope }));
}

type Citation = { n: number; fileId: string; fileName: string; page?: number; section?: string; quote: string };
type Proposal = { id: string; tool: string; label: string; args: any; state: string; expiresAt: number; result: string | null; artifactIds: string[] };
type Msg = { id: string; role: "user" | "assistant"; text: string; citations: Citation[]; toolRuns: { name: string; label: string; ok: boolean; summary: string }[]; abstained: boolean; feedback: "up" | "down" | null; proposals: Proposal[] };

export function ChatView({ spaces, initialScope, taskId }: { spaces: SpaceInfo[]; initialScope?: Scope | null; taskId?: string | null }) {
  const threads = useQuery(api.chat.threads);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [draftScope, setDraftScope] = useState<Scope>(initialScope ?? { kind: "all" });
  const [draftAgent, setDraftAgent] = useState<string | null>(null);
  const [taskError, setTaskError] = useState("");
  const deleteThread = useMutation(api.chat.deleteThread);
  const openTaskThread = useMutation(api.chat.openTaskThread);

  // "اعمل عليها مع الوكيل": open (or create) my thread for this task.
  useEffect(() => {
    if (!taskId) return;
    setTaskError("");
    openTaskThread({ taskId })
      .then((id) => setThreadId(id as string))
      .catch((err) => setTaskError(errorText(err)));
  }, [taskId]);

  // A new "ask about this file" request starts a fresh conversation on that file.
  useEffect(() => {
    if (initialScope) {
      setThreadId(null);
      setDraftScope(initialScope);
    }
  }, [initialScope]);

  return (
    <div className="mx-auto flex h-full max-w-6xl gap-4">
      <aside className="hidden w-60 shrink-0 flex-col gap-2 lg:flex">
        <button className="btn-primary justify-center" onClick={() => (setThreadId(null), setDraftScope({ kind: "all" }), setDraftAgent(null))}>
          ＋ محادثة جديدة
        </button>
        <div className="card flex-1 overflow-y-auto p-1">
          {threads?.length === 0 && <div className="p-3 text-xs text-slate-400">لا محادثات بعد</div>}
          {threads?.map((t) => (
            <div key={t.threadId} className={`group flex items-center rounded-lg ${t.threadId === threadId ? "bg-teal-50" : "hover:bg-slate-100"}`}>
              <button className="flex-1 truncate px-2 py-1.5 text-start text-sm" onClick={() => setThreadId(t.threadId)} title={t.title}>
                {t.taskId ? "✅ " : t.scope.kind === "file" ? "📄 " : t.scope.kind === "space" ? "🗂️ " : ""}
                {t.title}
              </button>
              <button
                className="hidden px-2 text-xs text-slate-400 hover:text-red-700 group-hover:block"
                title="حذف المحادثة"
                onClick={() => confirm("حذف هذه المحادثة؟") && void deleteThread({ threadId: t.threadId }).then(() => t.threadId === threadId && setThreadId(null))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        {taskError && <p className="mb-2 rounded-lg bg-red-50 p-2 text-sm text-red-700">{taskError}</p>}
        <Conversation key={threadId ?? "new"} threadId={threadId} onCreated={setThreadId} spaces={spaces} draftScope={draftScope} setDraftScope={setDraftScope} draftAgent={draftAgent} setDraftAgent={setDraftAgent} />
      </section>
    </div>
  );
}

function ModelStatus() {
  const status = useAction(api.ai.status);
  const [s, setS] = useState<null | Record<string, string | boolean>>(null);
  useEffect(() => {
    let live = true;
    const tick = () => status({}).then((r) => live && setS(r as any)).catch(() => live && setS(null));
    tick();
    const t = setInterval(tick, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  if (!s) return null;
  // Phase 0 decision: rerank is required for acceptable recall, so a missing reranker is "degraded".
  const ok = s.main === "ok" && s.embed === "ok" && s.rerank === "ok";
  return (
    <span className="flex items-center gap-1 text-xs text-slate-500" title={`النموذج: ${s.main} · التضمين: ${s.embed} · الترتيب: ${s.rerank}`}>
      <span className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-500"}`} />
      {ok ? "النموذج متاح" : "النموذج غير متاح حالياً"}
    </span>
  );
}

function Conversation(props: {
  threadId: string | null;
  onCreated: (id: string) => void;
  spaces: SpaceInfo[];
  draftScope: Scope;
  setDraftScope: (s: Scope) => void;
  draftAgent: string | null;
  setDraftAgent: (id: string | null) => void;
}) {
  const { threadId } = props;
  const data = useQuery(api.chat.messages, threadId ? { threadId } : "skip");
  const createThread = useMutation(api.chat.createThread);
  const send = useMutation(api.chat.send);
  const setScope = useMutation(api.chat.setScope);
  const setAgent = useMutation(api.chat.setAgent);
  const [openArtifact, setOpenArtifact] = useState<string | null>(null);
  const agentId = threadId && data ? (data.agentId as string | null) : props.draftAgent;
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const scope: Scope = threadId && data ? { ...(data.scope as Scope), label: data.scopeLabel } : props.draftScope;
  const turn = data?.turn ?? null;
  const working = turn && (turn.state === "queued" || turn.state === "running");

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" }); // (newer browsers return a promise here: not a cleanup)
  }, [data?.messages.length, turn?.state, turn?.label]);

  const changeScope = async (s: Scope) => {
    setError("");
    if (!threadId) return props.setDraftScope(s);
    try {
      await setScope({ threadId, scope: { kind: s.kind, id: s.id } });
    } catch (err) {
      setError(errorText(err));
    }
  };

  const changeAgent = async (id: string | null) => {
    setError("");
    if (!threadId) return props.setDraftAgent(id);
    try {
      await setAgent({ threadId, agentId: id });
    } catch (err) {
      setError(errorText(err));
    }
  };

  const submit = async () => {
    const q = text.trim();
    if (!q || busy || working) return;
    setBusy(true);
    setError("");
    try {
      let id = threadId;
      if (!id) {
        id = await createThread({ scope: { kind: scope.kind, id: scope.id }, agentId: props.draftAgent });
        props.onCreated(id!);
      }
      await send({ threadId: id!, text: q });
      setText("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 pb-3">
        <h1 className="truncate text-lg font-semibold">{data?.title ?? "محادثة جديدة"}</h1>
        {data?.task && <span className="shrink-0 rounded-full bg-teal-50 px-2 py-0.5 text-xs text-teal-800">✅ مرتبطة بمهمة</span>}
        {data?.test && <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">اختبار مسودة الوكيل</span>}
        <span className="ms-auto">
          <ModelStatus />
        </span>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-4">
        {!threadId && (
          <div className="card space-y-2 p-6 text-sm text-slate-600">
            <p className="font-semibold text-slate-800">اسأل عن مستنداتك</p>
            <p>يجيب المساعد من الملفات التي يحق لك قراءتها فقط، ويذكر مصدر كل معلومة. إن لم يجد الجواب يقول ذلك بوضوح.</p>
            <p className="text-xs text-slate-400">اختر النطاق أسفل مربع الكتابة: كل ما أملك، أو مساحة محددة، أو ملف واحد.</p>
          </div>
        )}
        {data?.agent?.error && <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{data.agent.error}</div>}
        {data?.messages.map((m) => <Message key={m.id} m={m as Msg} onOpenArtifact={setOpenArtifact} />)}
        {turn && <TurnStatus threadId={threadId!} turn={turn} />}
        <div ref={bottom} />
      </div>
      <div className="card space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-3">
          {!data?.test && <AgentPicker value={agentId} onChange={changeAgent} />}
          <ScopeChips scope={scope} spaces={props.spaces} onChange={changeScope} />
        </div>
        <div className="flex items-end gap-2">
          <textarea
            className="input min-h-[2.75rem] flex-1 resize-none"
            rows={Math.min(6, Math.max(1, text.split("\n").length))}
            placeholder="اكتب سؤالك… (Enter للإرسال، Shift+Enter لسطر جديد)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <button className="btn-primary" disabled={busy || !!working || !text.trim()} onClick={() => void submit()}>
            إرسال
          </button>
        </div>
        {error && <p className="text-sm text-red-700">{error}</p>}
      </div>
      {openArtifact && <ArtifactPanel key={openArtifact} artifactId={openArtifact} spaces={props.spaces} onClose={() => setOpenArtifact(null)} />}
    </div>
  );
}

/** Manual agent choice (auto-routing is deferred): published agents I may use, the default first. */
function AgentPicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const agents = useQuery(api.agents.available);
  if (!agents?.length) return null;
  const current = agents.find((a) => a._id === value) ?? agents.find((a) => a.isDefault);
  const selected = current && !current.isDefault ? current._id : "";
  return (
    <label className="flex items-center gap-1 text-xs text-slate-400" title={current ? `${current.description}\nالأدوات: ${current.tools.join("، ")}\nالنطاق: ${current.dataScope}` : ""}>
      🤖
      <select className="rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-700" value={selected} onChange={(e) => onChange(e.target.value || null)}>
        {agents.map((a) => (
          <option key={a._id} value={a.isDefault ? "" : a._id}>
            {a.name}
            {a.isDefault ? " (افتراضي)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function ScopeChips({ scope, spaces, onChange }: { scope: Scope; spaces: SpaceInfo[]; onChange: (s: Scope) => void }) {
  const chip = (on: boolean) => `rounded-full border px-3 py-1 text-xs ${on ? "border-teal-600 bg-teal-50 font-semibold text-teal-800" : "border-slate-200 text-slate-600 hover:bg-slate-100"}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-slate-400">ابحث في:</span>
      <button className={chip(scope.kind === "all")} onClick={() => onChange({ kind: "all" })}>
        كل ما أملك
      </button>
      <select
        className={chip(scope.kind === "space")}
        value={scope.kind === "space" ? scope.id : ""}
        onChange={(e) => e.target.value && onChange({ kind: "space", id: e.target.value })}
      >
        <option value="">مساحة محددة…</option>
        {spaces.map((s) => (
          <option key={s._id} value={s._id}>
            {badge(s).icon} {s.kind === "personal" ? "مساحتي" : s.name}
          </option>
        ))}
      </select>
      {scope.kind === "file" && (
        <span className={chip(true)}>
          📄 {scope.label ?? "ملف"}
          <button className="ms-2 text-slate-400 hover:text-red-700" title="إلغاء حصر البحث في الملف" onClick={() => onChange({ kind: "all" })}>
            ✕
          </button>
        </span>
      )}
    </div>
  );
}

function TurnStatus({ threadId, turn }: { threadId: string; turn: { state: string; label: string | null; streamId: string | null; error: string | null; ahead: number } }) {
  const stream = useQuery(api.chat.stream, turn.streamId && turn.state === "running" ? { threadId, streamId: turn.streamId } : "skip");
  if (turn.state === "failed") return <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">تعذّر إكمال الإجابة: {turn.error}. أعد إرسال السؤال.</div>;
  if (turn.state === "queued")
    return (
      <Bubble role="assistant">
        <span className="text-slate-500">⏳ في الانتظار{turn.ahead > 0 ? ` — أمامك ${turn.ahead}` : ""}…</span>
      </Bubble>
    );
  return (
    <Bubble role="assistant">
      {stream?.text ? <AnswerText text={stream.text} /> : null}
      <div className="mt-1 animate-pulse text-xs text-slate-400">{turn.label ?? "…"}</div>
    </Bubble>
  );
}

function Bubble({ role, children }: { role: "user" | "assistant"; children: ReactNode }) {
  return (
    <div className={`flex ${role === "user" ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-7 ${role === "user" ? "bg-teal-700 text-white" : "card"}`}>{children}</div>
    </div>
  );
}

/** Answer text with [n] markers turned into small source chips. */
function AnswerText({ text, onCite }: { text: string; onCite?: (n: number) => void }) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    <div className="whitespace-pre-wrap">
      {parts.map((p, i) => {
        const m = /^\[(\d+)\]$/.exec(p);
        if (!m) return <Fragment key={i}>{p}</Fragment>;
        return (
          <button key={i} className="mx-0.5 rounded bg-teal-100 px-1 align-super text-[10px] font-semibold text-teal-800 hover:bg-teal-200" onClick={() => onCite?.(Number(m[1]))}>
            {m[1]}
          </button>
        );
      })}
    </div>
  );
}

const PROPOSAL_STATE: Record<string, { label: string; tone: string }> = {
  pending: { label: "بانتظار تأكيدك", tone: "bg-amber-50 text-amber-800" },
  running: { label: "يُنفَّذ…", tone: "bg-sky-50 text-sky-800" },
  executed: { label: "نُفّذ", tone: "bg-emerald-50 text-emerald-800" },
  failed: { label: "تعذّر التنفيذ", tone: "bg-red-50 text-red-700" },
  cancelled: { label: "أُلغي", tone: "bg-slate-100 text-slate-500" },
  expired: { label: "انتهت صلاحيته", tone: "bg-slate-100 text-slate-500" },
};

/** What a proposed call will do, in a few lines (the full arguments are in the details). */
function proposalSummary(p: Proposal): string[] {
  const a = p.args ?? {};
  const out: string[] = [];
  if (a.title) out.push(`العنوان: ${a.title}`);
  if (a.kind) out.push(`النوع: ${a.kind}`);
  if (Array.isArray(a.fileIds)) out.push(`الملفات: ${a.fileIds.length}`);
  if (a.templateId) out.push(`القالب: ${a.templateId}`);
  if (a.recordId) out.push(`السجل: ${a.recordId}`);
  if (a.artifactId) out.push(`المخرج: ${a.artifactId}`);
  return out;
}

function ProposalCard({ p, onOpenArtifact }: { p: Proposal; onOpenArtifact: (id: string) => void }) {
  const confirm = useAction(api.chat.confirmProposal);
  const cancel = useMutation(api.chat.cancelProposal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const st = PROPOSAL_STATE[p.state] ?? { label: p.state, tone: "bg-slate-100" };
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-lg border border-amber-200 bg-white p-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-slate-800">✍️ {p.label.replace(/…$/, "")}</span>
        <span className={`rounded-full px-2 py-0.5 ${st.tone}`}>{st.label}</span>
        {p.state === "pending" && <span className="ms-auto text-slate-400">حتى {new Date(p.expiresAt).toLocaleTimeString("ar-SA-u-nu-latn", { timeStyle: "short" })}</span>}
      </div>
      <ul className="mt-1 text-slate-600">
        {proposalSummary(p).map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <details className="mt-1 text-slate-400">
        <summary className="cursor-pointer">التفاصيل</summary>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px] text-slate-600" dir="ltr">
          {JSON.stringify(p.args, null, 2)}
        </pre>
      </details>
      {p.result && <p className="mt-1 whitespace-pre-wrap text-slate-600">{p.result}</p>}
      {p.artifactIds.map((id) => (
        <button key={id} className="btn-ghost mt-1 px-0 text-teal-800" onClick={() => onOpenArtifact(id)}>
          🧩 افتح المخرج
        </button>
      ))}
      {p.state === "pending" && (
        <div className="mt-2 flex gap-2">
          <button className="btn-primary" disabled={busy} onClick={() => void run(() => confirm({ proposalId: p.id }))}>
            نفّذ
          </button>
          <button className="btn-ghost" disabled={busy} onClick={() => void run(() => cancel({ proposalId: p.id }))}>
            إلغاء
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-red-700">{error}</p>}
    </div>
  );
}

function Message({ m, onOpenArtifact }: { m: Msg; onOpenArtifact: (id: string) => void }) {
  const feedback = useMutation(api.chat.feedback);
  const requestDownload = useMutation(api.files.requestDownload);
  const [error, setError] = useState("");
  if (m.role === "user") return <Bubble role="user">{m.text}</Bubble>;

  const open = async (c: Citation) => {
    setError("");
    try {
      const pdfLike = /\.pdf$/i.test(c.fileName);
      const link = await requestDownload({ fileId: c.fileId as any, inline: pdfLike });
      // PDF viewers jump to #page=N; other types download.
      if (pdfLike) window.open(link + (c.page ? `#page=${c.page}` : ""), "_blank", "noopener");
      else window.location.assign(link);
    } catch (err) {
      setError(errorText(err));
    }
  };
  const byN = new Map(m.citations.map((c) => [c.n, c]));
  return (
    <div className="space-y-2">
      <Bubble role="assistant">
        <AnswerText text={m.text} onCite={(n) => byN.get(n) && void open(byN.get(n)!)} />
        {m.citations.length > 0 && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {m.citations.map((c) => (
              <button key={c.n} className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-start text-xs hover:border-teal-400" onClick={() => void open(c)} title={c.quote}>
                <div className="flex items-center gap-1 font-semibold text-slate-700">
                  <span className="rounded bg-teal-100 px-1 text-teal-800">{c.n}</span>
                  <span className="truncate">{c.fileName}</span>
                  {c.page ? <span className="ms-auto shrink-0 text-slate-400">ص {c.page}</span> : null}
                </div>
                {c.section && <div className="truncate text-slate-500">{c.section}</div>}
                <div className="line-clamp-2 text-slate-400">{c.quote.split("\n").slice(1).join(" ")}</div>
              </button>
            ))}
          </div>
        )}
        <div className="mt-2 flex items-center gap-1 text-xs text-slate-400">
          {m.toolRuns.length > 0 && <span title={m.toolRuns.map((t) => `${t.label} ${t.summary}`).join("\n")}>🔎 {m.toolRuns.length}</span>}
          {m.abstained && <span className="rounded bg-amber-50 px-1.5 text-amber-700">لا جواب في المستندات</span>}
          <span className="ms-auto" />
          <button className={`rounded px-1 ${m.feedback === "up" ? "bg-emerald-100" : "hover:bg-slate-100"}`} title="إجابة مفيدة" onClick={() => void feedback({ messageId: m.id, value: m.feedback === "up" ? null : "up" })}>
            👍
          </button>
          <button className={`rounded px-1 ${m.feedback === "down" ? "bg-red-100" : "hover:bg-slate-100"}`} title="إجابة غير صحيحة أو غير مفيدة" onClick={() => void feedback({ messageId: m.id, value: m.feedback === "down" ? null : "down" })}>
            👎
          </button>
        </div>
      </Bubble>
      {m.proposals?.length > 0 && (
        <div className="flex justify-end">
          <div className="w-full max-w-[85%] space-y-2">
            {m.proposals.map((p) => (
              <ProposalCard key={p.id} p={p} onOpenArtifact={onOpenArtifact} />
            ))}
          </div>
        </div>
      )}
      {error && <p className="text-end text-xs text-red-700">{error}</p>}
    </div>
  );
}
