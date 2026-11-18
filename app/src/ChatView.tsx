// The chat (UX redesign): one conversation column like Claude. A new chat starts from the empty
// state (a few starters) or from a space; the composer has attachments (uploaded to the space or
// to "مساحتي"), a quiet agent picker and an "@" list of files and spaces. Mentioning a
// file or a space narrows that question to it (the server intersects; it never widens).
// Answers stream, render as Markdown with small citation chips that open the source, and can be
// copied or retried. Write tools arrive as proposal cards ("نفّذ"); their outputs open in a side
// panel. Threads opened from a task, test threads and scheduled-task threads use the same screen.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAction, useMutation, useQuery } from "onebase/react";
import { ArtifactDock, OutputChip } from "./ArtifactPanel";
import { Menu } from "./ui";
import { openSkillDraft } from "./SkillsView";
import { Icon } from "./icons";
import { api, errorText, uploadBytes, type SpaceInfo } from "./lib";
import { renderAnswer } from "./markdown";

export type Scope = { kind: "all" | "space" | "file"; id?: string; label?: string };
type Mention = { kind: "file" | "space" | "agent"; id: string; name: string; spaceId?: string };
type Citation = { n: number; fileId: string; fileName: string; page?: number; section?: string; quote: string };
type Proposal = { id: string; tool: string; label: string; args: any; state: string; expiresAt: number; result: string | null; display: string | null; artifactIds: string[]; tier: number | null; auto: boolean };
type Step = { label: string; state: "running" | "done" | "failed"; ms: number | null; detail: string | null };
type Msg = { id: string; role: "user" | "assistant"; text: string; citations: Citation[]; toolRuns: { name: string; label: string; ok: boolean; summary: string }[]; abstained: boolean; feedback: "up" | "down" | null; proposals: Proposal[]; skill: { agentId: string; name: string; routed: boolean } | null; userSkill: string | null; steps: Step[]; ms: number | null };

// "اسأل عن هذا الملف" and other entry points hand a draft to the next new chat.
type SkillRef = { id: string; name: string };
let pendingDraft: { spaceId?: string; mentions: Mention[]; text?: string; skill?: SkillRef } | null = null;
export function startChatWith(draft: { spaceId?: string; mentions?: Mention[]; text?: string; skill?: SkillRef }) {
  pendingDraft = { spaceId: draft.spaceId, mentions: draft.mentions ?? [], text: draft.text, skill: draft.skill };
  window.location.hash = draft.spaceId ? `#/space/${draft.spaceId}/new` : "#/new";
}
/** Opens a new chat in the file's space with the file already mentioned. */
export function askAboutFile(fileId: string, name: string, spaceId?: string) {
  startChatWith({ spaceId, mentions: [{ kind: "file", id: fileId, name, spaceId }] });
}

type Starter = { title: string; text?: string; mention?: Mention; skill?: SkillRef; threadId?: string; personal?: boolean };

/** A larger pool than fits on screen: a different few on every visit. */
const GENERAL: Starter[] = [
  { title: "اكتب خطاباً رسمياً", text: "اكتب خطاباً رسمياً موجهاً إلى " },
  { title: "لخّص ملفاً من ملفاتي", text: "لخّص لي الملف @" },
  { title: "ترجم نصاً", text: "ترجم النص التالي إلى الإنجليزية:\n" },
  { title: "اسأل عن الأنظمة واللوائح", text: "ما الذي تنص عليه سياسة " },
  { title: "صُغ رداً على بريد", text: "اكتب رداً مهنياً مختصراً على هذا البريد:\n" },
  { title: "اكتب محضر اجتماع", text: "حوّل هذه الملاحظات إلى محضر اجتماع بالقرارات والمهام والمسؤولين:\n" },
  { title: "حسّن صياغة نص", text: "حسّن صياغة النص التالي بلغة رسمية واضحة:\n" },
  { title: "اكتب مذكرة داخلية", text: "اكتب مذكرة داخلية بخصوص " },
  { title: "حلّل جدول بيانات", text: "حلّل بيانات @" },
  { title: "جهّز عرضاً تقديمياً", text: "جهّز عرضاً تقديمياً من خمس شرائح عن " },
  { title: "اكتب تقريراً أسبوعياً", text: "اكتب تقريراً أسبوعياً مختصراً عن الإنجازات والعوائق والخطوات القادمة:\n" },
  { title: "قارن بين ملفين", text: "قارن بين @" },
];
const BY_TIME: Record<"morning" | "evening", Starter[]> = {
  morning: [{ title: "رتّب أولويات يومي", text: "ساعدني أرتب أولويات اليوم، هذه مهامي:\n" }],
  evening: [{ title: "لخّص ما أنجزته اليوم", text: "اكتب ملخصاً لما أنجزته اليوم من هذه النقاط:\n" }],
};

/** «صباح الخير» until noon, «مساء الخير» after, with the user's first name. */
export function greeting(name: string | null | undefined, now = new Date()) {
  const h = now.getHours();
  const part = h >= 4 && h < 12 ? "صباح الخير" : "مساء الخير";
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first && !first.includes("@") ? `${part}، ${first}` : part;
}

/** Seeded shuffle: stable while the page is open, different on the next visit. */
function shuffle<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let x = Math.floor(seed * 2 ** 31) || 1;
  for (let i = a.length - 1; i > 0; i--) {
    x = (x * 48271) % 2147483647;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function useStarters(spaceId: string | undefined): Starter[] {
  const [seed] = useState(() => Math.random());
  const mine = useQuery(api.home.suggestions, spaceId ? { spaceId } : {});
  return useMemo(() => {
    const personal: Starter[] = (mine ?? []).map((s) =>
      s.kind === "file"
        ? { title: s.title, text: s.text, mention: { kind: "file", id: s.file.id, name: s.file.name, spaceId: s.file.spaceId }, personal: true }
        : s.kind === "skill"
          ? { title: s.title, text: s.text, skill: s.skill, personal: true }
          : { title: s.title, threadId: s.threadId, personal: true },
    );
    const h = new Date().getHours();
    const general = shuffle([...GENERAL, ...BY_TIME[h >= 4 && h < 12 ? "morning" : "evening"]], seed);
    // Up to two of the user's own (in a varying order), the rest general.
    const own = shuffle(personal, seed).slice(0, 2);
    return [...own, ...general].slice(0, 4);
  }, [mine, seed]);
}

export function ChatScreen({ threadId, spaceId, spaces, go }: { threadId: string | null; spaceId?: string | null; spaces: SpaceInfo[]; go: (path: string) => void }) {
  const data = useQuery(api.chat.messages, threadId ? { threadId } : "skip");
  const createThread = useMutation(api.chat.createThread);
  const send = useMutation(api.chat.send);
  const retry = useMutation(api.chat.retry);
  const stopTurn = useMutation(api.chat.stop);
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

  const submit = async (text: string, mentions: Mention[], skill?: SkillRef | null) => {
    setError("");
    try {
      let id = threadId;
      if (!id) id = (await createThread({ agentId: draftAgent, ...(homeSpace ? { spaceId: homeSpace } : {}) })) as string;
      await send({ threadId: id, text, mentions: mentions.map((m) => ({ kind: m.kind, id: m.id })), ...(skill ? { skillId: skill.id } : {}) });
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
  const me = useQuery(api.account.me, empty ? {} : "skip");
  const title = empty ? (space ? `محادثة جديدة في ${space.kind === "personal" ? "مساحتي" : space.name}` : me === undefined ? "\u00a0" : greeting(me?.name)) : (data?.title ?? "…");

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
            {data?.test && <span className="shrink-0 rounded bg-warning-soft px-2 py-0.5 text-xs text-warning">اختبار مسودة الوكيل</span>}
            {data && data.scope.kind === "file" && <span className="shrink-0 rounded bg-raised px-2 py-0.5 text-xs text-muted">ملف: {data.scopeLabel}</span>}
            <span className="ms-auto" />
            <ThreadMenu threadId={threadId!} title={data?.title ?? ""} go={go} onDeleted={() => go(homeSpace ? `/space/${homeSpace}` : "/")} />
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
                <h1 className="overflow-hidden pb-1 text-[clamp(28px,2.4vw+18px,44px)] leading-tight font-bold tracking-tight"><span key={title} className="block animate-mask">{title}</span></h1>
                <p className="mt-2 text-muted">
                  {space
                    ? "تُرى هذه المحادثة لك وحدك، وتعرف تعليمات المساحة وملفاتها. اكتب @ لتحدد ملفاً بعينه."
                    : "بماذا أساعدك اليوم؟ اسأل عن أي شيء، أو اطلب كتابة أو ترجمة أو تلخيصاً. اكتب @ لتحدد ملفاً أو مساحة، و/ لمهاراتك."}
                </p>
              </div>
            )}
            {data?.agent?.error && <div className="rounded-md bg-warning-soft p-3 text-sm text-warning">{data.agent.error}</div>}
            {messages.map((m) => (
              <MessageView key={m.id} m={m} isLast={m.id === lastAssistant && !working} onRetry={() => threadId && retry({ threadId }).catch((e) => setError(errorText(e)))} onReask={(id) => threadId && setAgent({ threadId, agentId: id as any }).then(() => retry({ threadId })).catch((e) => setError(errorText(e)))} onOpenArtifact={setArtifact} />
            ))}
            {turn && threadId && <TurnStatus threadId={threadId} turn={turn} onRetry={() => retry({ threadId }).catch((e) => setError(errorText(e)))} />}
            {empty && <Composer key="new" spaces={spaces} space={space} agentId={agentId} onAgent={changeAgent} working={false} onSubmit={submit} initial={draft} starters go={go} />}
          </div>
        </div>
        {!empty && (
          <div className="shrink-0 px-4 pb-4">
            <div className="mx-auto w-full max-w-[760px]">
              {error && <p className="mb-2 text-sm text-negative">{error}</p>}
              <Composer key={threadId} spaces={spaces} space={space} agentId={agentId} onAgent={data?.test ? undefined : changeAgent} working={working} onStop={() => threadId && void stopTurn({ threadId }).catch((e) => setError(errorText(e)))} onSubmit={submit} />
            </div>
          </div>
        )}
        {empty && error && <p className="px-4 pb-4 text-center text-sm text-negative">{error}</p>}
      </div>
      {artifact && <ArtifactDock key={artifact} artifactId={artifact} spaces={spaces} onClose={() => setArtifact(null)} />}
    </div>
  );
}

function ThreadMenu({ threadId, title, onDeleted, go }: { threadId: string; title: string; onDeleted: () => void; go: (path: string) => void }) {
  const rename = useMutation(api.chat.rename);
  const del = useMutation(api.chat.deleteThread);
  const draftSkill = useAction(api.skills.draftFromThread);
  const [drafting, setDrafting] = useState(false);
  return (
    <Menu
      label={drafting ? "يكتب مسودة المهارة…" : "خيارات المحادثة"}
      icon={drafting ? "clock" : "dots"}
      items={[
        {
          label: "اصنع مهارة من المحادثة",
          icon: "bot",
          hint: "يكتبها الذكاء الاصطناعي",
          disabled: drafting,
          onSelect: () => {
            setDrafting(true);
            draftSkill({ threadId })
              .then((d) => openSkillDraft({ ...d, fromThreadId: threadId }, go))
              .catch((e) => alert(errorText(e)))
              .finally(() => setDrafting(false));
          },
        },
        "divider",
        {
          label: "إعادة التسمية",
          icon: "pencil",
          onSelect: () => {
            const t = prompt("عنوان المحادثة", title);
            if (t?.trim()) void rename({ threadId, title: t });
          },
        },
        { label: "حذف المحادثة", danger: true, onSelect: () => confirm("حذف هذه المحادثة نهائياً؟") && void del({ threadId }).then(onDeleted) },
      ]}
    />
  );
}

function Starters({ spaceId, onPick }: { spaceId?: string; onPick: (s: Starter) => void }) {
  const starters = useStarters(spaceId);
  return (
    <div className="mt-4 grid gap-2 sm:grid-cols-2">
      {starters.map((s) => (
        <button
          key={s.title}
          className="flex items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-start text-sm hover:border-control hover:bg-sunken animate-fade"
          onClick={() => onPick(s)}
        >
          {s.personal && <Icon name={s.threadId ? "chat" : s.skill ? "bot" : "file"} size={15} className="shrink-0 text-faint" />}
          <span className="min-w-0 truncate">{s.title}</span>
        </button>
      ))}
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
  onStop?: () => void;
  onSubmit: (text: string, mentions: Mention[], skill?: SkillRef | null) => Promise<boolean>;
  initial?: { mentions: Mention[]; text?: string; skill?: SkillRef } | null;
  starters?: boolean;
  go?: (path: string) => void;
}) {
  const [text, setText] = useState(props.initial?.text ?? (props.initial?.mentions.length ? props.initial.mentions.map((m) => `@${m.name} `).join("") : ""));
  const [mentions, setMentions] = useState<Mention[]>(props.initial?.mentions ?? []);
  const [uploads, setUploads] = useState<{ fileId: string; spaceId: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  // "/": my skills. One per message; its "/name" stays in the text.
  const [slash, setSlash] = useState<string | null>(null);
  const [skill, setSkill] = useState<SkillRef | null>(props.initial?.skill ?? null);
  const mySkills = useQuery(api.skills.list, slash !== null || skill ? {} : "skip");
  const skillItems = useMemo(() => {
    if (slash === null || !mySkills) return [];
    const q = slash.toLowerCase();
    return mySkills.filter((s) => !q || s.name.toLowerCase().includes(q) || s.title.toLowerCase().includes(q)).slice(0, 8);
  }, [slash, mySkills]);
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
    const before = value.slice(0, caret);
    const m = /(^|\s)@([^\s@]{0,40})$/.exec(before);
    setQuery(m ? m[2]! : null);
    const sl = /(^|\s)\/([^\s/]{0,40})$/.exec(before);
    setSlash(!m && sl ? sl[2]! : null);
    setActive(0);
  };

  const pickSkill = (s: { _id: string; name: string }) => {
    const el = ta.current!;
    const caret = el.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/\/([^\s/]{0,40})$/, `/${s.name} `);
    const next = before + text.slice(caret);
    setText(next);
    setSlash(null);
    setSkill({ id: s._id, name: s.name });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
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
    // Same for the skill: deleting its "/name" from the text drops it.
    const used = skill && q.includes(`/${skill.name}`) ? skill : null;
    const ok = await props.onSubmit(q, kept, used);
    setBusy(false);
    if (ok) {
      setText("");
      setMentions([]);
      setUploads([]);
      setSkill(null);
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
        {slash !== null && mySkills && (
          <div className="absolute inset-x-2 bottom-full z-20 mb-2 max-h-72 animate-pop overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)]" role="listbox" aria-label="مهاراتي">
            {skillItems.map((s, i) => (
              <button
                key={s._id}
                role="option"
                aria-selected={i === active}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-start text-sm ${i === active ? "bg-active" : "hover:bg-active"}`}
                onMouseDown={(e) => (e.preventDefault(), pickSkill(s))}
              >
                <span className="font-medium text-primary" dir="ltr">
                  /{s.name}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted">{s.title}</span>
                <span className="max-w-[40%] shrink-0 truncate text-xs text-faint">{s.description}</span>
              </button>
            ))}
            {skillItems.length === 0 && (
              <a className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-muted hover:bg-active" href="#/skills">
                <Icon name="plus" size={14} /> {mySkills.length ? "لا مهارة بهذا الاسم. أنشئ واحدة" : "لا مهارات بعد. أنشئ أول مهارة"}
              </a>
            )}
          </div>
        )}
        {(visibleMentions.length > 0 || skill) && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {skill && (
              <span className="flex h-7 items-center gap-1.5 rounded-md bg-primary-soft ps-2 pe-1 text-xs text-primary">
                <span className="font-medium" dir="ltr">
                  /{skill.name}
                </span>
                <span>مهارتك</span>
                <button
                  className="grid h-5 w-5 place-items-center rounded hover:bg-surface"
                  aria-label={`إزالة /${skill.name}`}
                  onClick={() => {
                    setText((t) => t.replace(`/${skill.name} `, "").replace(`/${skill.name}`, ""));
                    setSkill(null);
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              </span>
            )}
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
          className="block max-h-60 w-full resize-none bg-transparent px-4 pt-3 focus-visible:outline-none text-[15px] leading-7 outline-none placeholder:text-faint"
          placeholder={props.space ? "اكتب رسالتك… (@ لملف من المساحة، / لمهارة)" : "اكتب رسالتك… (@ لملف أو مساحة، / لمهارة)"}
          aria-label="الرسالة"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            updateQuery(e.target.value, e.target.selectionStart);
          }}
          onClick={(e) => updateQuery(text, e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (slash !== null && skillItems.length) {
              if (e.key === "ArrowDown") return e.preventDefault(), setActive((a) => (a + 1) % skillItems.length);
              if (e.key === "ArrowUp") return e.preventDefault(), setActive((a) => (a - 1 + skillItems.length) % skillItems.length);
              if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), pickSkill(skillItems[active]!);
              if (e.key === "Escape") return e.preventDefault(), setSlash(null);
            }
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
          {props.working && props.onStop ? (
            <button className="btn-secondary w-9 animate-pop rounded-lg px-0" aria-label="إيقاف" title="إيقاف الإجابة" onClick={props.onStop}>
              <Icon name="stop" size={16} />
            </button>
          ) : (
            <button className="btn-primary w-9 rounded-lg px-0" aria-label="إرسال" disabled={busy || props.working || !text.trim() || pending.length > 0} onClick={() => void submit()}>
              <Icon name="send" size={18} />
            </button>
          )}
        </div>
      </div>
      {uploadError && <p className="mt-2 text-sm text-negative">{uploadError}</p>}
      {props.starters && <Starters spaceId={props.space?._id} onPick={(s) => {
        if (s.threadId) return props.go?.(`/chat/${s.threadId}`);
        const t = s.text ?? "";
        setText(t);
        if (s.mention) setMentions((ms) => (ms.some((m) => m.id === s.mention!.id) ? ms : [...ms, s.mention!]));
        if (s.skill) setSkill(s.skill);
        requestAnimationFrame(() => {
          const el = ta.current!;
          el.focus();
          el.setSelectionRange(t.length, t.length);
          if (!s.mention) updateQuery(t, t.length);
        });
      }} />}
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
  // No pick = «تلقائي»: the router chooses the agent for each question (plans/07 §C). A pick pins it.
  const current = agents.find((a) => a._id === value);
  return (
    <label className="relative flex h-9 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-active" title={current?.description ?? "يختار المساعد الوكيل المناسب لنوع كل طلب"}>
      <Icon name="bot" size={16} />
      <select className="cursor-pointer appearance-none bg-transparent pe-4 text-xs text-ink outline-none" aria-label="الوكيل" value={current ? current._id : ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">تلقائي</option>
        {agents.map((a) => (
          <option key={a._id} value={a._id}>
            {a.name}
          </option>
        ))}
      </select>
      <Icon name="down" size={12} className="pointer-events-none absolute end-1.5" />
    </label>
  );
}

// ---------------------------------------------------------------- messages

const secs = (ms: number | null) => (ms === null ? "" : ms < 1000 ? `${ms} م.ث` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} ث`);

/** The step timeline (plans/07 §D): what the assistant did, in order, with times. */
function StepList({ steps }: { steps: Step[] }) {
  return (
    <ol className="space-y-1 border-s-2 border-line ps-3">
      {steps.map((st, i) => (
        <li key={i} className="flex animate-fade items-center gap-2 text-xs">
          <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full ${st.state === "failed" ? "bg-negative-soft text-negative" : st.state === "running" ? "bg-primary-soft text-primary" : "bg-positive-soft text-positive"}`}>
            {st.state === "running" ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" /> : <Icon name={st.state === "failed" ? "x" : "check"} size={10} />}
          </span>
          <span className={st.state === "running" ? "text-ink" : "text-muted"}>{st.label.replace(/…$/, "")}</span>
          {st.detail && <span className="truncate text-faint">{st.detail}</span>}
          {st.ms !== null && <span className="meta num ms-auto">{secs(st.ms)}</span>}
        </li>
      ))}
    </ol>
  );
}

function TurnStatus({ threadId, turn, onRetry }: { threadId: string; turn: { state: string; label: string | null; streamId: string | null; error: string | null; ahead: number; steps?: Step[] }; onRetry: () => void }) {
  const stream = useQuery(api.chat.stream, turn.streamId && turn.state === "running" ? { threadId, streamId: turn.streamId } : "skip");
  if (turn.state === "failed")
    return (
      <div className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm ${turn.error === "أوقفتَ الإجابة قبل أن تبدأ" ? "bg-sunken text-muted" : "bg-negative-soft text-negative"}`}>
        <span className="flex-1">{turn.error === "أوقفتَ الإجابة قبل أن تبدأ" ? turn.error : `تعذّر إكمال الإجابة: ${turn.error}`}</span>
        <button className="btn-ghost h-8 text-negative" onClick={onRetry}>
          <Icon name="retry" size={14} /> أعد المحاولة
        </button>
      </div>
    );
  if (turn.state === "queued") return <p className="text-sm text-muted">في الانتظار{turn.ahead > 0 ? `، أمامك ${turn.ahead}` : ""}…</p>;
  return (
    <div>
      {turn.steps && turn.steps.length > 0 && !stream?.text && (
        <div className="mb-2">
          <StepList steps={turn.steps} />
        </div>
      )}
      {stream?.text ? <div className="md caret" dangerouslySetInnerHTML={{ __html: renderAnswer(stream.text, new Set()) }} /> : null}
      <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        {turn.label ?? "…"}
      </p>
    </div>
  );
}

function MessageView({ m, isLast, onRetry, onReask, onOpenArtifact }: { m: Msg; isLast: boolean; onRetry: () => void; onReask?: (agentId: string) => void; onOpenArtifact: (id: string) => void }) {
  const feedback = useMutation(api.chat.feedback);
  const [showSteps, setShowSteps] = useState(false);
  const requestDownload = useMutation(api.files.requestDownload);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const byN = useMemo(() => new Map(m.citations.map((c) => [c.n, c])), [m.citations]);
  const html = useMemo(() => (m.role === "assistant" ? renderAnswer(m.text, new Set(byN.keys())) : ""), [m.text, byN, m.role]);

  if (m.role === "user")
    return (
      <div className="flex animate-rise justify-start">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-ss-md bg-raised px-4 py-2.5 text-[15px] leading-7" dir="auto">
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
    <div className="animate-rise group space-y-3">
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
                <span className="cite-num mt-0.5 grid h-[18px] min-w-[18px] place-items-center rounded bg-primary-soft px-1 text-[11px] font-bold text-data num">{c.n}</span>
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
        <span className="ms-auto flex items-center gap-1">
          {m.steps?.length > 0 && (
            <button className="flex h-8 items-center gap-1 rounded-md px-2 hover:bg-active" onClick={() => setShowSteps(!showSteps)} aria-expanded={showSteps}>
              <Icon name="tasks" size={14} />
              {m.steps.length} {m.steps.length === 1 ? "خطوة" : "خطوات"}
              {m.ms ? <span className="num text-faint">· {secs(m.ms)}</span> : null}
            </button>
          )}
          {m.userSkill && (
            <span className="badge-primary" dir="ltr" title="مهارتك المطبّقة على هذا الطلب">
              /{m.userSkill}
            </span>
          )}
          {m.skill && <SkillChip skill={m.skill} onReask={isLast ? onReask : undefined} />}
        </span>
      </div>
      {showSteps && m.steps?.length > 0 && <StepList steps={m.steps} />}
      {error && <p className="text-xs text-negative">{error}</p>}
    </div>
  );
}

/** Which agent answered; on the last answer, a menu to answer again with another one (pins it). */
function SkillChip({ skill, onReask }: { skill: { agentId: string; name: string; routed: boolean }; onReask?: (agentId: string) => void }) {
  const agents = useQuery(api.agents.available, onReask ? {} : "skip");
  const label = `${skill.name}${skill.routed ? " · تلقائي" : ""}`;
  if (!onReask || !agents || agents.length < 2)
    return (
      <span className="badge" title={skill.routed ? "اختار المساعد هذا الوكيل لهذا الطلب" : "الوكيل المثبّت لهذه المحادثة"}>
        <Icon name="bot" size={12} /> {label}
      </span>
    );
  return (
    <Menu
      label="الوكيل"
      icon="bot"
      text={label}
      items={agents
        .filter((a) => a._id !== skill.agentId)
        .map((a) => ({ label: `أعد الإجابة بوكيل «${a.name}»`, hint: a.isDefault ? "الافتراضية" : undefined, onSelect: () => onReask(a._id) }))}
    />
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
  pending: { label: "بانتظار تأكيدك", tone: "bg-warning-soft text-warning" },
  running: { label: "يُنفَّذ…", tone: "bg-raised text-ink" },
  executed: { label: "نُفّذ", tone: "bg-positive-soft text-positive" },
  failed: { label: "تعذّر التنفيذ", tone: "bg-negative-soft text-negative" },
  cancelled: { label: "أُلغي", tone: "bg-raised text-muted" },
  expired: { label: "انتهت صلاحيته", tone: "bg-raised text-muted" },
  undone: { label: "تُراجع عنه", tone: "bg-raised text-muted" },
};

function proposalSummary(p: Proposal): string[] {
  const a = p.args ?? {};
  const out: string[] = [];
  if (a.title) out.push(`العنوان: ${a.title}`);
  if (a.kind) out.push(`النوع: ${a.kind}`);
  if (a.format) out.push(`الصيغة: ${({ docx: "Word", pdf: "PDF", pptx: "PowerPoint" } as Record<string, string>)[a.format] ?? a.format}`);
  if (Array.isArray(a.fileIds)) out.push(`الملفات: ${a.fileIds.length}`);
  if (a.templateId) out.push(`القالب: ${a.templateId}`);
  if (a.recordId) out.push(`السجل: ${a.recordId}`);
  if (a.artifactId) out.push(`المخرج: ${a.artifactId}`);
  return out;
}

function ProposalCard({ p, onOpenArtifact }: { p: Proposal; onOpenArtifact: (id: string) => void }) {
  const confirm = useAction(api.chat.confirmProposal);
  const cancel = useMutation(api.chat.cancelProposal);
  const undo = useMutation(api.chat.undo);
  const [kept, setKept] = useState<string[]>([]);
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
        <span className={`rounded px-2 py-0.5 text-xs ${st.tone}`}>{p.auto && p.state === "executed" ? "نُفّذ تلقائياً" : st.label}</span>
        {p.auto && p.state === "executed" && <span className="meta">في مساحتك الخاصة</span>}
        {p.tier === 3 && p.state === "pending" && <span className="badge-warning">حسّاس أو رسمي</span>}
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
      {p.state === "executed" && p.display ? (
        <p className="mt-1 text-sm text-ink">{p.display}</p>
      ) : p.result &&
        (p.state === "executed" ? (
          <details className="mt-1 text-xs text-muted">
            <summary className="cursor-pointer">الناتج</summary>
            <pre className="mt-1 max-h-72 overflow-auto rounded bg-raised p-2 font-mono text-[11px] leading-5" dir="ltr">
              {p.result}
            </pre>
          </details>
        ) : (
          <p className="mt-1 whitespace-pre-wrap text-xs text-muted">{p.result}</p>
        ))}
      <div className="mt-2 flex flex-wrap gap-2">
        {p.auto && p.state === "executed" && (
          <button className="btn-secondary h-8" disabled={busy} onClick={() => void run(async () => setKept(((await undo({ proposalId: p.id })) as { kept: string[] }).kept))}>
            <Icon name="retry" size={14} /> تراجع
          </button>
        )}
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
          <OutputChip key={id} artifactId={id} onOpen={onOpenArtifact} />
        ))}
      </div>
      {error && <p className="mt-1 text-xs text-negative">{error}</p>}
      {kept.length > 0 && <p className="mt-1 text-xs text-muted">بقي ما نُقل خارج مساحتك منذ ذلك: {kept.join("، ")}</p>}
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
        <h1 className="page-title">المحادثات</h1>
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
            <a href={`#/chat/${t.threadId}`} className="flex min-h-[60px] items-center gap-3 border-b border-rule px-2 py-2 hover:bg-sunken">
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
        <h1 className="page-title">{title}</h1>
        <span className="ms-auto flex gap-2">{actions}</span>
      </div>
      {sub && <p className="mt-1 text-muted">{sub}</p>}
      <div className="mt-6">{children}</div>
    </div>
  );
}
