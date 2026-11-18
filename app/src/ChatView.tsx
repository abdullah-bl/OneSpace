// The chat (UX redesign): one conversation column like Claude. A new chat starts from the empty
// state (a few starters) or from a space; the composer has attachments (uploaded to the space or
// to "مساحتي"), a quiet agent picker and an "@" list of files, spaces and agents. Mentioning a
// file or a space narrows that question to it (the server intersects; it never widens).
// Answers stream, render as Markdown with small citation chips that open the source, and can be
// copied or retried. Write tools arrive as proposal cards ("نفّذ"); their outputs open in a side
// panel. Threads opened from a task, test threads and scheduled-task threads use the same screen.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAction, useMutation, useQuery } from "onebase/react";
import { ArtifactPanel } from "./ArtifactPanel";
import { Icon } from "./icons";
import { api, errorText, uploadBytes, type SpaceInfo } from "./lib";
import { renderAnswer } from "./markdown";

export type Scope = { kind: "all" | "space" | "file"; id?: string; label?: string };
type Mention = { kind: "file" | "space" | "agent"; id: string; name: string; spaceId?: string };
type Citation = { n: number; fileId: string; fileName: string; page?: number; section?: string; quote: string };
type Proposal = { id: string; tool: string; label: string; args: any; state: string; expiresAt: number; result: string | null; artifactIds: string[] };
type Msg = { id: string; role: "user" | "assistant"; text: string; citations: Citation[]; toolRuns: { name: string; label: string; ok: boolean; summary: string }[]; abstained: boolean; feedback: "up" | "down" | null; proposals: Proposal[] };

// "اسأل عن هذا الملف" and other entry points hand a draft to the next new chat.
let pendingDraft: { spaceId?: string; mentions: Mention[]; text?: string } | null = null;
export function startChatWith(draft: { spaceId?: string; mentions?: Mention[]; text?: string }) {
  pendingDraft = { spaceId: draft.spaceId, mentions: draft.mentions ?? [], text: draft.text };
  window.location.hash = draft.spaceId ? `#/space/${draft.spaceId}/new` : "#/new";
}
/** Opens a new chat in the file's space with the file already mentioned. */
export function askAboutFile(fileId: string, name: string, spaceId?: string) {
  startChatWith({ spaceId, mentions: [{ kind: "file", id: fileId, name, spaceId }] });
}

const STARTERS = [
  { title: "اكتب خطاباً رسمياً", text: "اكتب خطاباً رسمياً موجهاً إلى " },
  { title: "لخّص ملفاً من ملفاتي", text: "لخّص لي الملف @" },
  { title: "ترجم نصاً", text: "ترجم النص التالي إلى الإنجليزية:\n" },
  { title: "اسأل عن الأنظمة واللوائح", text: "ما الذي تنص عليه سياسة " },
];

export function ChatScreen({ threadId, spaceId, spaces, go }: { threadId: string | null; spaceId?: string | null; spaces: SpaceInfo[]; go: (path: string) => void }) {
  const data = useQuery(api.chat.messages, threadId ? { threadId } : "skip");
  const createThread = useMutation(api.chat.createThread);
  const send = useMutation(api.chat.send);
  const retry = useMutation(api.chat.retry);
  const setAgent = useMutation(api.chat.setAgent);
  const [draft] = useState(() => {
    const d = !threadId ? pendingDraft : null;
    pendingDraft = null;
    return d;
  });
  const [draftAgent, setDraftAgent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [artifact, setArtifact] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const homeSpace = threadId ? (data?.spaceId ?? null) : (spaceId ?? null);
  const space = homeSpace ? spaces.find((s) => s._id === homeSpace) : undefined;
  const turn = data?.turn ?? null;
  const working = !!turn && (turn.state === "queued" || turn.state === "running");
  const agentId = threadId ? ((data?.agentId as string | null) ?? null) : draftAgent;
  const messages = (data?.messages ?? []) as Msg[];
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")?.id;

  // Follow the conversation while it grows (only when already near the bottom).
  const stick = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const submit = async (text: string, mentions: Mention[]) => {
    setError("");
    try {
      let id = threadId;
      if (!id) id = (await createThread({ agentId: draftAgent, ...(homeSpace ? { spaceId: homeSpace } : {}) })) as string;
      await send({ threadId: id, text, mentions: mentions.map((m) => ({ kind: m.kind, id: m.id })) });
      stick.current = true;
      if (!threadId) go(`/chat/${id}`);
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    }
  };

  const changeAgent = async (id: string | null) => {
    setError("");
    if (!threadId) return setDraftAgent(id);
    try {
      await setAgent({ threadId, agentId: id });
    } catch (err) {
      setError(errorText(err));
    }
  };

  const empty = !threadId;
  const title = empty ? (space ? `محادثة جديدة في ${space.kind === "personal" ? "مساحتي" : space.name}` : "بماذا أساعدك اليوم؟") : (data?.title ?? "…");

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {!empty && (
          <header className="flex h-14 shrink-0 items-center gap-3 px-4 lg:px-6">
            <h1 className="min-w-0 truncate text-base font-medium">{title}</h1>
            {data?.spaceName && (
              <a href={`#/space/${data.spaceId}`} className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-active">
                <Icon name="folder" size={14} />
                {data.spaceName}
              </a>
            )}
            {data?.task && (
              <a href={`#/tasks/${data.task._id}`} className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-active">
                <Icon name="tasks" size={14} />
                {data.task.title}
              </a>
            )}
            {data?.scheduled && <span className="shrink-0 rounded px-2 py-0.5 text-xs text-muted bg-raised">مهمة مجدولة</span>}
            {data?.test && <span className="shrink-0 rounded bg-[#fffbeb] px-2 py-0.5 text-xs text-[#92400e]">اختبار مسودة الوكيل</span>}
            {data && data.scope.kind === "file" && <span className="shrink-0 rounded bg-raised px-2 py-0.5 text-xs text-muted">ملف: {data.scopeLabel}</span>}
            <span className="ms-auto" />
            <ThreadMenu threadId={threadId!} title={data?.title ?? ""} onDeleted={() => go(homeSpace ? `/space/${homeSpace}` : "/")} />
          </header>
        )}
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className={`mx-auto w-full max-w-[760px] px-4 ${empty ? "flex min-h-full flex-col justify-center py-10" : "space-y-6 pb-6 pt-2"}`}>
            {empty && (
              <div className="mb-6">
                <h1 className="text-2xl font-medium tracking-tight">{title}</h1>
                <p className="mt-2 text-muted">
                  {space
                    ? "تُرى هذه المحادثة لك وحدك، وتعرف تعليمات المساحة وملفاتها. اكتب @ لتحدد ملفاً بعينه."
                    : "اسأل عن أي شيء، أو اطلب كتابة أو ترجمة أو تلخيصاً. حين يكون سؤالك عن ملفاتك يرجع إليها ويذكر المصدر. اكتب @ لتحدد ملفاً أو مساحة."}
                </p>
              </div>
            )}
            {data?.agent?.error && <div className="rounded-md bg-[#fffbeb] p-3 text-sm text-[#92400e]">{data.agent.error}</div>}
            {messages.map((m) => (
              <MessageView key={m.id} m={m} isLast={m.id === lastAssistant && !working} onRetry={() => threadId && retry({ threadId }).catch((e) => setError(errorText(e)))} onOpenArtifact={setArtifact} />
            ))}
            {turn && threadId && <TurnStatus threadId={threadId} turn={turn} onRetry={() => retry({ threadId }).catch((e) => setError(errorText(e)))} />}
            {empty && <Composer key="new" spaces={spaces} space={space} agentId={agentId} onAgent={changeAgent} working={false} onSubmit={submit} initial={draft} starters />}
          </div>
        </div>
        {!empty && (
          <div className="shrink-0 px-4 pb-4">
            <div className="mx-auto w-full max-w-[760px]">
              {error && <p className="mb-2 text-sm text-negative">{error}</p>}
              <Composer key={threadId} spaces={spaces} space={space} agentId={agentId} onAgent={data?.test ? undefined : changeAgent} working={working} onSubmit={submit} />
            </div>
          </div>
        )}
        {empty && error && <p className="px-4 pb-4 text-center text-sm text-negative">{error}</p>}
      </div>
      {artifact && (
        <div className="fixed inset-0 z-30 overflow-y-auto bg-ground p-3 xl:static xl:z-auto xl:w-[480px] xl:shrink-0 xl:border-s xl:border-line xl:bg-surface">
          <ArtifactPanel key={artifact} artifactId={artifact} spaces={spaces} onClose={() => setArtifact(null)} />
        </div>
      )}
    </div>
  );
}

function ThreadMenu({ threadId, title, onDeleted }: { threadId: string; title: string; onDeleted: () => void }) {
  const rename = useMutation(api.chat.rename);
  const del = useMutation(api.chat.deleteThread);
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button className="btn-ghost w-9 px-0" aria-label="خيارات المحادثة" onClick={() => setOpen(!open)}>
        <Icon name="dots" size={18} />
      </button>
      {open && (
        <div className="absolute end-0 top-10 z-20 w-44 rounded-lg border border-line bg-surface p-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)]" onMouseLeave={() => setOpen(false)}>
          <button
            className="block w-full rounded-md px-3 py-2 text-start text-sm hover:bg-active"
            onClick={() => {
              setOpen(false);
              const t = prompt("عنوان المحادثة", title);
              if (t?.trim()) void rename({ threadId, title: t });
            }}
          >
            إعادة التسمية
          </button>
          <button
            className="block w-full rounded-md px-3 py-2 text-start text-sm text-negative hover:bg-[#ffedea]"
            onClick={() => {
              setOpen(false);
              if (confirm("حذف هذه المحادثة نهائياً؟")) void del({ threadId }).then(onDeleted);
            }}
          >
            حذف المحادثة
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- composer

function Composer(props: {
  spaces: SpaceInfo[];
  space?: SpaceInfo;
  agentId: string | null;
  onAgent?: (id: string | null) => void;
  working: boolean;
  onSubmit: (text: string, mentions: Mention[]) => Promise<boolean>;
  initial?: { mentions: Mention[]; text?: string } | null;
  starters?: boolean;
}) {
  const [text, setText] = useState(props.initial?.text ?? (props.initial?.mentions.length ? props.initial.mentions.map((m) => `@${m.name} `).join("") : ""));
  const [mentions, setMentions] = useState<Mention[]>(props.initial?.mentions ?? []);
  const [uploads, setUploads] = useState<{ fileId: string; spaceId: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const createFile = useMutation(api.files.create);
  const personal = props.spaces.find((s) => s.kind === "personal");
  const uploadTarget = props.space?.canWrite ? props.space : personal;
  const ingest = useQuery(api.ingest.statuses, uploads.length && uploadTarget ? { spaceId: uploadTarget._id as any } : "skip");
  const suggestions = useQuery(api.mentions.suggest, query !== null ? { q: query, ...(props.space ? { spaceId: props.space._id } : {}) } : "skip");
  const items: Mention[] = useMemo(() => {
    if (!suggestions) return [];
    return [
      ...suggestions.files.map((x) => ({ kind: "file" as const, id: x.id, name: x.name, detail: x.detail })),
      ...suggestions.spaces.map((x) => ({ kind: "space" as const, id: x.id, name: x.name, detail: x.detail })),
      ...suggestions.agents.map((x) => ({ kind: "agent" as const, id: x.id, name: x.name, detail: x.detail })),
    ] as (Mention & { detail: string })[];
  }, [suggestions]);
  const pending = uploads.filter((u) => {
    const st = ingest?.find((x) => x.fileId === u.fileId)?.state;
    return !st || st === "pending" || st === "processing";
  });

  useEffect(() => {
    if (props.starters) ta.current?.focus();
  }, []);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [text]);

  const updateQuery = (value: string, caret: number) => {
    const m = /(^|\s)@([^\s@]{0,40})$/.exec(value.slice(0, caret));
    setQuery(m ? m[2]! : null);
    setActive(0);
  };

  const pick = (item: Mention) => {
    const el = ta.current!;
    const caret = el.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([^\s@]{0,40})$/, `@${item.name} `);
    const next = before + text.slice(caret);
    setText(next);
    setQuery(null);
    if (item.kind === "agent") props.onAgent?.(item.id);
    setMentions((ms) => (ms.some((m) => m.id === item.id) ? ms : [...ms, item]));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };

  const submit = async () => {
    const q = text.trim();
    if (!q || busy || props.working || pending.length) return;
    setBusy(true);
    // A mention whose "@name" was deleted from the text no longer counts.
    const kept = mentions.filter((m) => m.kind !== "agent" && q.includes(`@${m.name}`));
    const ok = await props.onSubmit(q, kept);
    setBusy(false);
    if (ok) {
      setText("");
      setMentions([]);
      setUploads([]);
    }
  };

  const attach = async (files: File[]) => {
    if (!uploadTarget) return;
    setUploadError("");
    for (const file of files) {
      try {
        const storageId = await uploadBytes(() => generateUploadUrl({}), file);
        const fileId = (await createFile({ storageId: storageId as any, name: file.name, spaceId: uploadTarget._id as any })) as string;
        const m: Mention = { kind: "file", id: fileId, name: file.name, spaceId: uploadTarget._id };
        setUploads((u) => [...u, { fileId, spaceId: uploadTarget._id, name: file.name }]);
        setMentions((ms) => [...ms, m]);
        setText((t) => (t && !t.endsWith(" ") && !t.endsWith("\n") ? t + " " : t) + `@${file.name} `);
      } catch (err) {
        setUploadError(errorText(err));
      }
    }
  };

  const visibleMentions = mentions.filter((m) => m.kind !== "agent");

  return (
    <div>
      <div
        className="relative rounded-lg border border-control bg-surface shadow-[0_2px_10px_rgba(0,0,0,0.04)] focus-within:border-ink"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void attach([...e.dataTransfer.files]);
        }}
      >
        {query !== null && items.length > 0 && (
          <MentionList items={items as (Mention & { detail: string })[]} active={active} onPick={pick} />
        )}
        {visibleMentions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {visibleMentions.map((m) => {
              const up = uploads.find((u) => u.fileId === m.id);
              const st = up ? ingest?.find((x) => x.fileId === m.id) : null;
              return (
                <span key={m.id} className="flex h-7 max-w-[260px] items-center gap-1.5 rounded-md bg-raised ps-2 pe-1 text-xs">
                  <Icon name={m.kind === "file" ? "file" : "folder"} size={14} />
                  <span className="truncate">{m.name}</span>
                  {up && st?.state !== "ready" && <span className="shrink-0 text-muted">{st?.state === "failed" ? "تعذّرت القراءة" : "يجهّز…"}</span>}
                  <button
                    className="grid h-5 w-5 place-items-center rounded hover:bg-control"
                    aria-label={`إزالة ${m.name}`}
                    onClick={() => {
                      setMentions((ms) => ms.filter((x) => x.id !== m.id));
                      setUploads((u) => u.filter((x) => x.fileId !== m.id));
                      setText((t) => t.replace(`@${m.name} `, "").replace(`@${m.name}`, ""));
                    }}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </span>
              );
            })}
          </div>
        )}
        <textarea
          ref={ta}
          rows={props.starters ? 3 : 1}
          dir="auto"
          className="block max-h-60 w-full resize-none bg-transparent px-4 pt-3 focus-visible:outline-none text-[15px] leading-7 outline-none placeholder:text-[#6b6b6b]"
          placeholder={props.space ? "اكتب رسالتك… (@ لملف من المساحة)" : "اكتب رسالتك… (@ لملف أو مساحة أو وكيل)"}
          aria-label="الرسالة"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            updateQuery(e.target.value, e.target.selectionStart);
          }}
          onClick={(e) => updateQuery(text, e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (query !== null && items.length) {
              if (e.key === "ArrowDown") return e.preventDefault(), setActive((a) => (a + 1) % items.length);
              if (e.key === "ArrowUp") return e.preventDefault(), setActive((a) => (a - 1 + items.length) % items.length);
              if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), pick(items[active]!);
              if (e.key === "Escape") return e.preventDefault(), setQuery(null);
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <button className="btn-ghost w-9 px-0" title={uploadTarget ? `إرفاق ملف (يُحفظ في ${uploadTarget.kind === "personal" ? "مساحتي" : uploadTarget.name})` : "إرفاق ملف"} aria-label="إرفاق ملف" onClick={() => fileInput.current?.click()} disabled={!uploadTarget}>
            <Icon name="clip" size={18} />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const list = [...(e.target.files ?? [])];
              e.target.value = "";
              void attach(list);
            }}
          />
          <button
            className="btn-ghost w-9 px-0"
            aria-label="إشارة إلى ملف أو مساحة"
            title="إشارة (@)"
            onClick={() => {
              const el = ta.current!;
              const next = text + (text && !/\s$/.test(text) ? " @" : "@");
              setText(next);
              setQuery("");
              requestAnimationFrame(() => (el.focus(), el.setSelectionRange(next.length, next.length)));
            }}
          >
            <Icon name="at" size={18} />
          </button>
          {props.onAgent && <AgentPicker value={props.agentId} onChange={props.onAgent} />}
          <span className="ms-auto text-xs text-muted">{pending.length ? "ينتظر تجهيز الملف…" : ""}</span>
          <button className="btn-primary w-9 rounded-lg px-0" aria-label="إرسال" disabled={busy || props.working || !text.trim() || pending.length > 0} onClick={() => void submit()}>
            <Icon name="send" size={18} />
          </button>
        </div>
      </div>
      {uploadError && <p className="mt-2 text-sm text-negative">{uploadError}</p>}
      {props.starters && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {STARTERS.map((s) => (
            <button
              key={s.title}
              className="rounded-lg border border-line bg-surface px-4 py-3 text-start text-sm hover:border-control hover:bg-[#fbfbfa]"
              onClick={() => {
                setText(s.text);
                requestAnimationFrame(() => {
                  const el = ta.current!;
                  el.focus();
                  el.setSelectionRange(s.text.length, s.text.length);
                  updateQuery(s.text, s.text.length);
                });
              }}
            >
              {s.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { file: "ملف", space: "مساحة", agent: "وكيل" };

function MentionList({ items, active, onPick }: { items: (Mention & { detail: string })[]; active: number; onPick: (m: Mention) => void }) {
  return (
    <div className="absolute inset-x-2 bottom-full z-20 mb-2 max-h-72 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)]" role="listbox" aria-label="إشارات">
      {items.map((it, i) => (
        <button
          key={`${it.kind}-${it.id}`}
          role="option"
          aria-selected={i === active}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-start text-sm ${i === active ? "bg-active" : "hover:bg-active"}`}
          onMouseDown={(e) => (e.preventDefault(), onPick(it))}
        >
          <Icon name={it.kind === "file" ? "file" : it.kind === "space" ? "folder" : "bot"} size={16} className="text-muted" />
          <span className="min-w-0 flex-1 truncate">{it.name}</span>
          <span className="max-w-[45%] shrink-0 truncate text-xs text-muted">
            {KIND_LABEL[it.kind]}
            {it.detail ? ` · ${it.detail}` : ""}
          </span>
        </button>
      ))}
    </div>
  );
}

/** A quiet agent choice: the default first. */
function AgentPicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const agents = useQuery(api.agents.available);
  if (!agents?.length) return null;
  const current = agents.find((a) => a._id === value) ?? agents.find((a) => a.isDefault);
  return (
    <label className="relative flex h-9 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-active" title={current?.description ?? ""}>
      <Icon name="bot" size={16} />
      <select className="cursor-pointer appearance-none bg-transparent pe-4 text-xs text-ink outline-none" aria-label="الوكيل" value={current && !current.isDefault ? current._id : ""} onChange={(e) => onChange(e.target.value || null)}>
        {agents.map((a) => (
          <option key={a._id} value={a.isDefault ? "" : a._id}>
            {a.name}
          </option>
        ))}
      </select>
      <Icon name="down" size={12} className="pointer-events-none absolute end-1.5" />
    </label>
  );
}

// ---------------------------------------------------------------- messages

function TurnStatus({ threadId, turn, onRetry }: { threadId: string; turn: { state: string; label: string | null; streamId: string | null; error: string | null; ahead: number }; onRetry: () => void }) {
  const stream = useQuery(api.chat.stream, turn.streamId && turn.state === "running" ? { threadId, streamId: turn.streamId } : "skip");
  if (turn.state === "failed")
    return (
      <div className="flex items-center gap-3 rounded-md bg-[#ffedea] px-3 py-2 text-sm text-[#831c1e]">
        <span className="flex-1">تعذّر إكمال الإجابة: {turn.error}</span>
        <button className="btn-ghost h-8 text-[#831c1e]" onClick={onRetry}>
          <Icon name="retry" size={14} /> أعد المحاولة
        </button>
      </div>
    );
  if (turn.state === "queued") return <p className="text-sm text-muted">في الانتظار{turn.ahead > 0 ? `، أمامك ${turn.ahead}` : ""}…</p>;
  return (
    <div>
      {stream?.text ? <div className="md caret" dangerouslySetInnerHTML={{ __html: renderAnswer(stream.text, new Set()) }} /> : null}
      <p className="mt-1 text-xs text-muted">{turn.label ?? "…"}</p>
    </div>
  );
}

function MessageView({ m, isLast, onRetry, onOpenArtifact }: { m: Msg; isLast: boolean; onRetry: () => void; onOpenArtifact: (id: string) => void }) {
  const feedback = useMutation(api.chat.feedback);
  const requestDownload = useMutation(api.files.requestDownload);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const byN = useMemo(() => new Map(m.citations.map((c) => [c.n, c])), [m.citations]);
  const html = useMemo(() => (m.role === "assistant" ? renderAnswer(m.text, new Set(byN.keys())) : ""), [m.text, byN, m.role]);

  if (m.role === "user")
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-[#ebeae6] px-4 py-2.5 text-[15px] leading-7" dir="auto">
          {m.text}
        </div>
      </div>
    );

  const open = async (c: Citation) => {
    setError("");
    try {
      const pdfLike = /\.pdf$/i.test(c.fileName);
      const link = await requestDownload({ fileId: c.fileId as any, inline: pdfLike });
      if (pdfLike) window.open(link + (c.page ? `#page=${c.page}` : ""), "_blank", "noopener");
      else window.location.assign(link);
    } catch (err) {
      setError(errorText(err));
    }
  };
  const sourceFiles = [...new Map(m.citations.map((c) => [c.fileId, c])).values()];

  return (
    <div className="group space-y-3">
      <div
        className="md"
        dir="auto"
        onClick={(e) => {
          const n = (e.target as HTMLElement).closest("[data-cite]")?.getAttribute("data-cite");
          const c = n ? byN.get(Number(n)) : undefined;
          if (c) void open(c);
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {m.proposals?.length > 0 && (
        <div className="space-y-2">
          {m.proposals.map((p) => (
            <ProposalCard key={p.id} p={p} onOpenArtifact={onOpenArtifact} />
          ))}
        </div>
      )}
      {showSources && (
        <ul className="space-y-1 rounded-lg border border-line bg-surface p-2">
          {m.citations.map((c) => (
            <li key={c.n}>
              <button className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-active" onClick={() => void open(c)} title={c.quote}>
                <span className="cite-num mt-0.5 grid h-[18px] min-w-[18px] place-items-center rounded bg-[#e8eef8] px-1 text-[11px] font-semibold text-data num">{c.n}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{c.fileName}{c.page ? ` · ص ${c.page}` : ""}</span>
                  <span className="line-clamp-2 text-xs text-muted">{c.quote.split("\n").slice(1).join(" ")}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1 text-xs text-muted">
        <IconButton label={copied ? "نُسخ" : "نسخ"} icon="copy" onClick={() => void navigator.clipboard?.writeText(m.text).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))} />
        {isLast && <IconButton label="أعد المحاولة" icon="retry" onClick={onRetry} />}
        <IconButton label="إجابة مفيدة" icon="thumbUp" on={m.feedback === "up"} onClick={() => void feedback({ messageId: m.id, value: m.feedback === "up" ? null : "up" })} />
        <IconButton label="إجابة غير مفيدة" icon="thumbDown" on={m.feedback === "down"} onClick={() => void feedback({ messageId: m.id, value: m.feedback === "down" ? null : "down" })} />
        {sourceFiles.length > 0 && (
          <button className="ms-1 flex h-8 items-center gap-1 rounded-md px-2 hover:bg-active" onClick={() => setShowSources(!showSources)} aria-expanded={showSources}>
            <Icon name="file" size={14} />
            {sourceFiles.length === 1 ? sourceFiles[0]!.fileName : `${sourceFiles.length} مصادر`}
          </button>
        )}
        {copied && <span>نُسخ</span>}
      </div>
      {error && <p className="text-xs text-negative">{error}</p>}
    </div>
  );
}

function IconButton({ label, icon, onClick, on }: { label: string; icon: "copy" | "retry" | "thumbUp" | "thumbDown"; onClick: () => void; on?: boolean }) {
  return (
    <button className={`grid h-8 w-8 place-items-center rounded-md hover:bg-active ${on ? "bg-active text-ink" : ""}`} aria-label={label} title={label} onClick={onClick}>
      <Icon name={icon} size={15} />
    </button>
  );
}

const PROPOSAL_STATE: Record<string, { label: string; tone: string }> = {
  pending: { label: "بانتظار تأكيدك", tone: "bg-[#fffbeb] text-[#92400e]" },
  running: { label: "يُنفَّذ…", tone: "bg-raised text-ink" },
  executed: { label: "نُفّذ", tone: "bg-[#dcfae5] text-[#04250e]" },
  failed: { label: "تعذّر التنفيذ", tone: "bg-[#ffedea] text-[#831c1e]" },
  cancelled: { label: "أُلغي", tone: "bg-raised text-muted" },
  expired: { label: "انتهت صلاحيته", tone: "bg-raised text-muted" },
};

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
  const st = PROPOSAL_STATE[p.state] ?? { label: p.state, tone: "bg-raised" };
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
    <div className="rounded-lg border border-line bg-surface p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{p.label.replace(/…$/, "")}</span>
        <span className={`rounded px-2 py-0.5 text-xs ${st.tone}`}>{st.label}</span>
        {p.state === "pending" && <span className="ms-auto text-xs text-muted num">حتى {new Date(p.expiresAt).toLocaleString("ar-SA-u-nu-latn", { dateStyle: "short", timeStyle: "short" })}</span>}
      </div>
      {proposalSummary(p).length > 0 && (
        <ul className="mt-1 text-xs text-muted">
          {proposalSummary(p).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <details className="mt-1 text-xs text-muted">
        <summary className="cursor-pointer">التفاصيل</summary>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-raised p-2 text-[11px]" dir="ltr">
          {JSON.stringify(p.args, null, 2)}
        </pre>
      </details>
      {p.result && <p className="mt-1 whitespace-pre-wrap text-xs text-muted">{p.result}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {p.state === "pending" && (
          <>
            <button className="btn-primary h-8" disabled={busy} onClick={() => void run(() => confirm({ proposalId: p.id }))}>
              نفّذ
            </button>
            <button className="btn-secondary h-8" disabled={busy} onClick={() => void run(() => cancel({ proposalId: p.id }))}>
              إلغاء
            </button>
          </>
        )}
        {p.artifactIds.map((id) => (
          <button key={id} className="btn-secondary h-8" onClick={() => onOpenArtifact(id)}>
            <Icon name="panel" size={14} /> افتح المخرج
          </button>
        ))}
      </div>
      {error && <p className="mt-1 text-xs text-negative">{error}</p>}
    </div>
  );
}

/** "المحادثات": every chat of mine, searchable. */
export function ChatsPage({ go }: { go: (path: string) => void }) {
  const [q, setQ] = useState("");
  const threads = useQuery(api.chat.threads, { q });
  return (
    <div className="mx-auto w-full max-w-[760px] px-4 py-6 lg:py-9">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-medium">المحادثات</h1>
        <button className="btn-primary ms-auto" onClick={() => go("/new")}>
          <Icon name="plus" /> محادثة جديدة
        </button>
      </div>
      <label className="relative mt-5 block">
        <Icon name="search" className="pointer-events-none absolute start-3 top-2.5 text-muted" />
        <input className="input h-10 w-full ps-9" placeholder="ابحث في عناوين محادثاتك" value={q} onChange={(e) => setQ(e.target.value)} aria-label="بحث في المحادثات" />
      </label>
      <p className="mt-4 text-xs text-muted num">{threads ? `${threads.length} محادثة` : " "}</p>
      <ul className="mt-2">
        {threads === undefined && <li className="py-3 text-sm text-muted">جارٍ التحميل…</li>}
        {threads?.length === 0 && <li className="rounded-lg border border-dashed border-control p-4 text-sm text-muted">{q ? "لا محادثات بهذا العنوان." : "لم تبدأ أي محادثة بعد."}</li>}
        {threads?.map((t) => (
          <li key={t.threadId}>
            <a href={`#/chat/${t.threadId}`} className="flex min-h-[60px] items-center gap-3 border-b border-rule px-2 py-2 hover:bg-[#fbfbfa]">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px]">{t.title}</span>
                <span className="block truncate text-xs text-muted">
                  {[t.spaceName, t.taskId ? "مهمة" : null, t.scheduled ? "مهمة مجدولة" : null].filter(Boolean).join(" · ") || "محادثة حرّة"}
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted num">{relTime(t.lastAt)}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function relTime(ms: number) {
  const d = Date.now() - ms;
  if (d < 60_000) return "الآن";
  if (d < 3600_000) return `قبل ${Math.floor(d / 60_000)} د`;
  if (d < 86_400_000) return `قبل ${Math.floor(d / 3600_000)} س`;
  if (d < 7 * 86_400_000) return `قبل ${Math.floor(d / 86_400_000)} يوم`;
  return new Date(ms).toLocaleDateString("ar-SA-u-nu-latn", { day: "numeric", month: "short" });
}

export function Page({ title, sub, actions, children }: { title: string; sub?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 lg:px-8 lg:py-9">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-medium">{title}</h1>
        <span className="ms-auto flex gap-2">{actions}</span>
      </div>
      {sub && <p className="mt-1 text-muted">{sub}</p>}
      <div className="mt-6">{children}</div>
    </div>
  );
}
