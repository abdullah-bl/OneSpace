// The chat (UX redesign): one conversation column like Claude. A new chat starts from the empty
// state (a few starters) or from a space; the composer has attachments (uploaded to the space or
// to "مساحتي"), a quiet agent picker and an "@" list of files and spaces. Mentioning a
// file or a space narrows that question to it (the server intersects; it never widens). In a
// shared space's chat "@" also lists its members: each one picked is told this message's text
// (never the chat or the answer), and the assistant answers as usual.
// Answers stream, render as Markdown with small citation chips that open the source, and can be
// copied or retried. Write tools arrive as proposal cards ("نفّذ"); their outputs open in a side
// panel. Threads opened from a task, test threads and scheduled-task threads use the same screen.

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAction, useMutation, useQuery } from "onebase/react";
import { ArtifactDock, OutputChip } from "./ArtifactPanel";
import { Menu, Popover, PopoverItem, ask, askText, tell } from "./ui";
import { openSkillDraft } from "./SkillsView";
import { Icon, type IconName } from "./icons";
import { api, errorText, uploadBytes, type SpaceInfo } from "./lib";
import { CITE_CHECK, renderAnswer } from "./markdown";
import { SummaryDivider, type ChatSummaryInfo } from "./ChatSummary";
import { HandoffLine, TeamMessage, type TeamTo } from "./TeamMessage";

export type Scope = { kind: "all" | "space" | "file"; id?: string; label?: string };
// "person": a named member of this shared space's chat, told this one message (mentions.mentionInChat).
type Mention = { kind: "file" | "space" | "agent" | "person" | "assistant"; id: string; name: string; spaceId?: string };
type Citation = { n: number; fileId: string; fileName: string; page?: number; section?: string; quote: string; check?: "unrelated" | "contradicts" };
type Proposal = { id: string; tool: string; label: string; args: any; state: string; expiresAt: number; result: string | null; display: string | null; artifactIds: string[]; tier: number | null; auto: boolean; mine?: boolean };
type Step = { label: string; state: "running" | "done" | "failed"; ms: number | null; detail: string | null };
type Msg = { id: string; role: "user" | "assistant"; text: string; citations: Citation[]; toolRuns: { name: string; label: string; ok: boolean; summary: string }[]; abstained: boolean; feedback: "up" | "down" | null; proposals: Proposal[]; skill: { agentId: string; name: string; routed: boolean } | null; userSkill: string | null; attached?: { kind: "file" | "space"; name: string }[]; steps: Step[]; parts?: Part[]; ms: number | null; author?: string | null; mine?: boolean; team?: { to: TeamTo[]; viaAssistant?: boolean } | null; handoffOf?: string | null; forName?: string | null };
type Part = { agent: string; goal: string; text: string; ok: boolean; ms: number };

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
  const [effort, setEffortState] = useState<Effort>(savedEffort);
  const setEffort = (e: Effort) => {
    setEffortState(e);
    try {
      localStorage.setItem("onespace.effort", e);
    } catch {}
  };
  const [error, setError] = useState("");
  const [artifact, setArtifact] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const homeSpace = threadId ? (data?.spaceId ?? null) : (spaceId ?? null);
  const space = homeSpace ? spaces.find((s) => s._id === homeSpace) : undefined;
  // plans/14: a new chat in a shared space is shared with its members unless I make it private.
  const canShareNew = !threadId && space?.kind === "shared" && space.canWrite;
  const [newShared, setNewShared] = useState(true);
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

  const submit = async (text: string, mentions: Mention[], skill?: SkillRef | null, toAssistant?: boolean) => {
    setError("");
    try {
      let id = threadId;
      if (!id) id = (await createThread({ agentId: draftAgent, ...(homeSpace ? { spaceId: homeSpace, shared: !!canShareNew && newShared } : {}) })) as string;
      const scope = mentions.filter((m): m is Mention & { kind: "file" | "space" } => m.kind === "file" || m.kind === "space");
      const people = mentions.filter((m) => m.kind === "person").map((m) => m.id);
      await send({ threadId: id, text, mentions: scope.map((m) => ({ kind: m.kind, id: m.id })), ...(people.length ? { people } : {}), ...(toAssistant !== undefined ? { to: toAssistant ? ("assistant" as const) : ("team" as const) } : {}), ...(skill ? { skillId: skill.id } : {}), effort });
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
            {data?.shared && (
              <span className="flex shrink-0 items-center gap-1 rounded bg-raised px-2 py-0.5 text-xs text-muted" title="يراها أعضاء المساحة ويسألون فيها">
                <Icon name="users" size={13} /> مشتركة{data.ownerName ? ` · بدأها ${data.ownerName}` : ""}
              </span>
            )}
            {data?.scheduled && <span className="shrink-0 rounded px-2 py-0.5 text-xs text-muted bg-raised">مهمة مجدولة</span>}
            {data?.test && <span className="shrink-0 rounded bg-warning-soft px-2 py-0.5 text-xs text-warning">اختبار مسودة الوكيل</span>}
            {data && data.scope.kind === "file" && <span className="shrink-0 rounded bg-raised px-2 py-0.5 text-xs text-muted">ملف: {data.scopeLabel}</span>}
            <span className="ms-auto" />
            {data?.noMemory && (
              <span className="flex shrink-0 items-center gap-1 rounded bg-raised px-2 py-0.5 text-xs text-muted" title="لا يقرأ المساعد الذاكرة ولا يحفظ فيها في هذه المحادثة">
                <Icon name="memory" size={13} /> بلا ذاكرة
              </span>
            )}
            <ThreadMenu
              threadId={threadId!}
              title={data?.title ?? ""}
              pinned={!!data?.pinned}
              noMemory={!!data?.noMemory}
              access={{ isOwner: data?.isOwner ?? true, shared: !!data?.shared, shareable: !!data?.shareable, canManage: !!data?.canManage }}
              go={go}
              onDeleted={() => go(homeSpace ? `/space/${homeSpace}` : "/")}
            />
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
                  {canShareNew
                    ? newShared
                      ? "يراها أعضاء المساحة ويسألون فيها، وتعرف تعليمات المساحة وملفاتها. لا يدخلها شيء من ذاكرتك أو سجلاتك الخاصة."
                      : "تُرى هذه المحادثة لك وحدك، وتعرف تعليمات المساحة وملفاتها. اكتب @ لتحدد ملفاً بعينه."
                    : space
                    ? "تُرى هذه المحادثة لك وحدك، وتعرف تعليمات المساحة وملفاتها. اكتب @ لتحدد ملفاً بعينه."
                    : "بماذا أساعدك اليوم؟ اسأل عن أي شيء، أو اطلب كتابة أو ترجمة أو تلخيصاً. اكتب @ لتحدد ملفاً أو مساحة، و/ لمهاراتك."}
                </p>
                {canShareNew && (
                  <div className="mt-3 inline-flex rounded-lg border border-line bg-surface p-0.5 text-sm" role="radiogroup" aria-label="من يرى المحادثة">
                    {[
                      { on: true, icon: "users" as const, label: "مشتركة مع المساحة" },
                      { on: false, icon: "lock" as const, label: "خاصة بي" },
                    ].map((o) => (
                      <button
                        key={o.label}
                        role="radio"
                        aria-checked={newShared === o.on}
                        className={`flex h-8 items-center gap-1.5 rounded-md px-3 ${newShared === o.on ? "bg-active text-ink" : "text-muted hover:text-ink"}`}
                        onClick={() => setNewShared(o.on)}
                      >
                        <Icon name={o.icon} size={14} /> {o.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {data?.agent?.error && <div className="rounded-md bg-warning-soft p-3 text-sm text-warning">{data.agent.error}</div>}
            {messages.map((m) => (
              <Fragment key={m.id}>
                <MessageView m={m} canWrite={data?.canWrite ?? true} busy={working} isLast={m.id === lastAssistant && !working} onRetry={() => threadId && retry({ threadId }).catch((e) => setError(errorText(e)))} onReask={(id) => threadId && setAgent({ threadId, agentId: id as any }).then(() => retry({ threadId })).catch((e) => setError(errorText(e)))} onOpenArtifact={setArtifact} />
                {threadId && data?.summary && data.summary.afterId === m.id && <SummaryDivider threadId={threadId} summary={data.summary as ChatSummaryInfo} canWrite={!!data.canWrite} />}
              </Fragment>
            ))}
            {turn && threadId && <TurnStatus threadId={threadId} turn={turn} onRetry={() => retry({ threadId }).catch((e) => setError(errorText(e)))} />}
            {empty && <Composer key="new" spaces={spaces} space={space} agentId={agentId} onAgent={changeAgent} effort={effort} onEffort={setEffort} working={false} onSubmit={submit} initial={draft} starters go={go} shared={!!canShareNew && newShared} />}
          </div>
        </div>
        {!empty && (
          <div className="shrink-0 px-4 pb-4">
            <div className="mx-auto w-full max-w-[760px]">
              {error && <p className="mb-2 text-sm text-negative">{error}</p>}
              {data && !data.canWrite ? (
                <p className="flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-control p-4 text-center text-sm text-muted">
                  <Icon name="eye" size={15} /> دورك في المساحة قارئ: تقرأ المحادثة ولا تسأل فيها.
                </p>
              ) : (
              <Composer key={threadId} spaces={spaces} space={space} agentId={agentId} onAgent={data?.test ? undefined : changeAgent} effort={effort} onEffort={setEffort} working={working} onStop={() => threadId && void stopTurn({ threadId }).catch((e) => setError(errorText(e)))} onSubmit={submit} shared={!!data?.shared} />
              )}
            </div>
          </div>
        )}
        {empty && error && <p className="px-4 pb-4 text-center text-sm text-negative">{error}</p>}
      </div>
      {artifact && <ArtifactDock key={artifact} artifactId={artifact} spaces={spaces} onClose={() => setArtifact(null)} />}
    </div>
  );
}

type ThreadAccess = { isOwner: boolean; shared: boolean; shareable: boolean; canManage: boolean };

function ThreadMenu({ threadId, title, pinned, noMemory, access, onDeleted, go }: { threadId: string; title: string; pinned: boolean; noMemory: boolean; access: ThreadAccess; onDeleted: () => void; go: (path: string) => void }) {
  const setShared = useMutation(api.chat.setShared);
  const rename = useMutation(api.chat.rename);
  const setNoMemory = useMutation(api.chat.setNoMemory);
  const setPinned = useMutation(api.chat.setPinned);
  const delThread = useMutation(api.chat.deleteThread);
  const draftSkill = useAction(api.skills.draftFromThread);
  const [drafting, setDrafting] = useState(false);
  const share = async () => {
    const ok = await ask("مشاركة المحادثة مع أعضاء المساحة؟ سيرون المحادثة كاملة من أولها ويسألون فيها.", { confirmLabel: "شارك" });
    if (ok) await setShared({ threadId, shared: true }).catch((e) => void tell(errorText(e)));
  };
  const unshare = async () => {
    const ok = await ask(access.isOwner ? "جعل المحادثة خاصة بك؟ لن يراها أعضاء المساحة بعد الآن." : "إخفاء المحادثة عن أعضاء المساحة؟ تبقى لمن بدأها وحده.", { confirmLabel: "اجعلها خاصة" });
    if (ok) await setShared({ threadId, shared: false }).catch((e) => void tell(errorText(e)));
  };
  const del = () =>
    void ask(access.shared ? "حذف هذه المحادثة نهائياً؟ تُحذف عند كل أعضاء المساحة." : "حذف هذه المحادثة نهائياً؟", { danger: true, confirmLabel: "حذف" }).then((ok) => {
      if (ok) void delThread({ threadId }).then(onDeleted).catch((e) => void tell(errorText(e)));
    });
  // A colleague's shared chat: they can only make it private (a manager) or delete it.
  if (!access.isOwner)
    return access.canManage ? (
      <Menu
        label="خيارات المحادثة"
        icon="dots"
        items={[
          { label: "إخفاؤها عن المساحة", icon: "lock", onSelect: () => void unshare() },
          { label: "حذف المحادثة", danger: true, onSelect: del },
        ]}
      />
    ) : null;
  return (
    <Menu
      label={drafting ? "يكتب مسودة المهارة…" : "خيارات المحادثة"}
      icon={drafting ? "clock" : "dots"}
      items={[
        ...(access.shareable
          ? [
              access.shared
                ? { label: "اجعلها خاصة بي", icon: "lock" as const, onSelect: () => void unshare() }
                : { label: "شاركها مع أعضاء المساحة", icon: "users" as const, hint: "يرونها كاملة ويسألون فيها", onSelect: () => void share() },
              "divider" as const,
            ]
          : []),
        {
          label: "اصنع مهارة من المحادثة",
          icon: "bot",
          hint: "يكتبها الذكاء الاصطناعي",
          disabled: drafting,
          onSelect: () => {
            setDrafting(true);
            draftSkill({ threadId })
              .then((d) => openSkillDraft({ ...d, fromThreadId: threadId }, go))
              .catch((e) => void tell(errorText(e)))
              .finally(() => setDrafting(false));
          },
        },
        "divider",
        { label: pinned ? "إلغاء التثبيت" : "تثبيت في الأعلى", icon: "pin", onSelect: () => void setPinned({ threadId, pinned: !pinned }).catch((e) => void tell(errorText(e))) },
        {
          label: noMemory ? "شغّل الذاكرة في هذه المحادثة" : "محادثة بلا ذاكرة",
          icon: "memory",
          hint: noMemory ? undefined : "لا يقرأ الذاكرة ولا يحفظ فيها",
          onSelect: () => void setNoMemory({ threadId, on: !noMemory }).catch((e) => void tell(errorText(e))),
        },
        {
          label: "إعادة التسمية",
          icon: "pencil",
          onSelect: () =>
            void askText("عنوان المحادثة", title).then((t) => {
              if (t) void rename({ threadId, title: t });
            }),
        },
        { label: "حذف المحادثة", danger: true, onSelect: del },
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
  effort: Effort;
  onEffort: (e: Effort) => void;
  working: boolean;
  onStop?: () => void;
  onSubmit: (text: string, mentions: Mention[], skill?: SkillRef | null, toAssistant?: boolean) => Promise<boolean>;
  initial?: { mentions: Mention[]; text?: string; skill?: SkillRef } | null;
  starters?: boolean;
  shared?: boolean; // a shared space chat (plans/14): its members read it, so @person links to it
  go?: (path: string) => void;
}) {
  // Mentioned files and spaces live in the chips above the text, not in the text itself.
  const [text, setText] = useState(props.initial?.text ?? "");
  const [mentions, setMentions] = useState<Mention[]>(props.initial?.mentions ?? []);
  const [uploads, setUploads] = useState<{ fileId: string; spaceId: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  // "/": my skills. One per message; its "/name" stays in the text.
  const [slash, setSlash] = useState<string | null>(null);
  const [skill, setSkill] = useState<SkillRef | null>(props.initial?.skill ?? null);
  // Mine, and this chat's space skills (plans/09 §2).
  const mySkills = useQuery(api.skills.forChat, slash !== null || skill ? (props.space?.kind === "shared" ? { spaceId: props.space._id } : {}) : "skip");
  const skillItems = useMemo(() => {
    if (slash === null || !mySkills) return [];
    const q = slash.toLowerCase();
    return mySkills.filter((s) => !q || s.name.toLowerCase().includes(q) || s.title.toLowerCase().includes(q)).slice(0, 8);
  }, [slash, mySkills]);
  // My level (plans/08 §D): whether «تفكير عميق» is allowed and how many questions are left today.
  const level = useQuery(api.levels.mine);
  const left = level && level.dailyQuestions > 0 ? Math.max(0, level.dailyQuestions - level.usedToday) : null;
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
    // plans/16: in a shared chat the assistant answers only when called: @المساعد comes first.
    const q = (query ?? "").trim();
    const callAssistant = props.shared && !mentions.some((m) => m.kind === "assistant") && (!q || "المساعد".includes(q) || "مساعد".startsWith(q) || "assistant".startsWith(q.toLowerCase()));
    return [
      ...(callAssistant ? [{ kind: "assistant" as const, id: "assistant", name: "المساعد", detail: "" }] : []),
      ...suggestions.people.map((x) => ({ kind: "person" as const, id: x.id, name: x.name, detail: x.detail })),
      ...suggestions.files.map((x) => ({ kind: "file" as const, id: x.id, name: x.name, detail: x.detail })),
      ...suggestions.spaces.map((x) => ({ kind: "space" as const, id: x.id, name: x.name, detail: x.detail })),
      ...suggestions.agents.map((x) => ({ kind: "agent" as const, id: x.id, name: x.name, detail: x.detail })),
    ] as (Mention & { detail: string })[];
  }, [suggestions, query, props.shared, mentions]);
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

  /** «إضافة» → «@» / «/»: types the trigger at the caret (with a space before it if needed) and opens its list. */
  const insertTrigger = (ch: "@" | "/") => {
    const el = ta.current!;
    const caret = el.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const ins = (before && !/\s$/.test(before) ? " " : "") + ch;
    const next = before + ins + text.slice(caret);
    const at = caret + ins.length;
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
      updateQuery(next, at);
    });
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
    // The typed "@query" is replaced by a chip: nothing of it stays in the text.
    const before = text.slice(0, caret).replace(/(^|\s)@([^\s@]{0,40})$/, "$1");
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
    // Every chip counts (× on a chip removes it).
    const kept = mentions.filter((m) => m.kind !== "agent" && m.kind !== "assistant");
    // Same for the skill: deleting its "/name" from the text drops it.
    const used = skill && q.includes(`/${skill.name}`) ? skill : null;
    const ok = await props.onSubmit(q, kept, used, props.shared ? mentions.some((m) => m.kind === "assistant") || CALLS_ASSISTANT.test(q) : undefined);
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
      } catch (err) {
        setUploadError(errorText(err));
      }
    }
  };

  const visibleMentions = mentions.filter((m) => m.kind !== "agent");
  // plans/16: in a shared chat, a message naming people goes to them; the assistant answers only if asked too.
  const named = props.shared ? visibleMentions.filter((m) => m.kind === "person") : [];
  const calling = !!props.shared && (visibleMentions.some((m) => m.kind === "assistant") || CALLS_ASSISTANT.test(text));

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
          <div className="absolute inset-x-2 bottom-full z-20 mb-2 max-h-72 animate-pop overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-[0_8px_24px_rgba(0,0,0,0.08)]" role="listbox" aria-label="المهارات">
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
                {s.space && <span className="badge shrink-0">المساحة</span>}
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
        {props.shared && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-xs text-muted">
            <Icon name={calling ? "bot" : "users"} size={13} />
            <span>
              {calling
                ? `يرد المساعد ويشتغل باسمك وبصلاحياتك${named.length ? `، ويصل إشعار لـ${named.map((m) => m.name).join("، ")}` : ""}`
                : named.length
                  ? `تُرسل إلى ${named.map((m) => m.name).join("، ")}، ولن يرد المساعد. اكتب @المساعد ليرد`
                  : "رسالة للفريق، ولن يرد المساعد. اكتب @المساعد ليرد"}
            </span>
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
                  <Icon name={m.kind === "file" ? "file" : m.kind === "person" ? "user" : m.kind === "assistant" ? "bot" : "folder"} size={14} />
                  <span className="truncate">{m.name}</span>
                  {up && st?.state !== "ready" && <span className="shrink-0 text-muted">{st?.state === "failed" ? "تعذّرت القراءة" : "يجهّز…"}</span>}
                  <button
                    className="grid h-5 w-5 place-items-center rounded hover:bg-control"
                    aria-label={`إزالة ${m.name}`}
                    onClick={() => {
                      setMentions((ms) => ms.filter((x) => x.id !== m.id));
                      setUploads((u) => u.filter((x) => x.fileId !== m.id));
                    }}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </span>
              );
            })}
          </div>
        )}
        {visibleMentions.some((m) => m.kind === "person") && (
          <p className="px-3 pt-1.5 text-xs text-muted">
            {props.shared ? (
              <>تصل إشارة إلى {visibleMentions.filter((m) => m.kind === "person").map((m) => m.name).join("، ")} في «الإشارات» تفتح هذه المحادثة المشتركة.</>
            ) : (
              <>يصل نص هذه الرسالة وحده إلى {visibleMentions.filter((m) => m.kind === "person").map((m) => m.name).join("، ")} في «الإشارات». المحادثة والإجابة تبقيان خاصتين بك.</>
            )}
          </p>
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
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "u" && uploadTarget) return e.preventDefault(), fileInput.current?.click();
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
          <Popover label="إضافة" trigger={<Icon name="plus" size={18} />} triggerClass="btn-ghost w-9 rounded-lg px-0">
            {(close) => (
              <>
                <PopoverItem
                  icon="clip"
                  title="إرفاق ملفات أو صور"
                  description={uploadTarget ? `تُحفظ في ${uploadTarget.kind === "personal" ? "مساحتي" : uploadTarget.name}` : "لا تملك مساحة تُحفظ فيها"}
                  hint="Ctrl+U"
                  disabled={!uploadTarget}
                  onSelect={() => (close(), fileInput.current?.click())}
                />
                <PopoverItem icon="at" title="إشارة إلى ملف أو مساحة" description="ليجيب منها وحدها" hint="@" onSelect={() => (close(), insertTrigger("@"))} />
                <PopoverItem icon="bot" title="استخدام مهارة" description="تعليماتك المحفوظة لهذا الطلب" hint="/" onSelect={() => (close(), insertTrigger("/"))} />
              </>
            )}
          </Popover>
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
          <EffortPicker value={props.effort} onChange={props.onEffort} level={level} />
          {/* The agent is chosen per question; a picker shows only on a chat pinned to one (to unpin it). */}
          {props.onAgent && props.agentId && <AgentPicker value={props.agentId} onChange={props.onAgent} />}
          <span className="ms-auto text-xs text-muted">{pending.length ? "ينتظر تجهيز الملف…" : left !== null && left <= 10 ? (left > 0 ? `باقي ${left} من أسئلة اليوم` : `بلغت حدّ اليوم في مستوى «${level!.name}»`) : ""}</span>
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
        // A starter is a request for the assistant: in a shared chat it calls it (plans/16).
        if (props.shared) setMentions((ms) => (ms.some((m) => m.kind === "assistant") ? ms : [{ kind: "assistant", id: "assistant", name: "المساعد" }, ...ms]));
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

/** Same rule as the server (chat.callsAssistant): «@المساعد» or «@ai» typed in the text calls the assistant. */
const CALLS_ASSISTANT = /(^|[\s(«"'])@(المساعد|مساعد|ai|assistant)(?=$|[\s،,.:؛؟?!)»"'])/i;

const KIND_LABEL: Record<string, string> = { file: "ملف", space: "مساحة", agent: "وكيل", person: "زميل", assistant: "يرد ويشتغل باسمك" };

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
          <Icon name={it.kind === "file" ? "file" : it.kind === "space" ? "folder" : it.kind === "person" ? "user" : "bot"} size={16} className="text-muted" />
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
type Effort = "auto" | "fast" | "deep";
const EFFORTS: { value: Effort; label: string; hint: string }[] = [
  { value: "auto", label: "تلقائي", hint: "يقرر المساعد متى يفكّر قبل الإجابة بحسب الطلب" },
  { value: "fast", label: "سريع", hint: "يجيب مباشرة دون تفكير مسبق" },
  { value: "deep", label: "تفكير عميق", hint: "يفكّر قبل كل إجابة: أدق للتحليل والمقارنة، وأبطأ" },
];
function savedEffort(): Effort {
  try {
    const v = localStorage.getItem("onespace.effort");
    return v === "fast" || v === "deep" ? v : "auto";
  } catch {
    return "auto";
  }
}

/** Thinking level (like Claude's): «تلقائي» by default, remembered on this device. */
function EffortPicker({ value, onChange, level }: { value: Effort; onChange: (e: Effort) => void; level?: { name: string; deep: boolean; model: string } }) {
  // A level without thinking runs «تفكير عميق» as «تلقائي» without it (the server enforces this too).
  const noDeep = level ? !level.deep : false;
  if (noDeep && value === "deep") value = "auto";
  const cur = EFFORTS.find((e) => e.value === value) ?? EFFORTS[0]!;
  return (
    <Popover
      label="مستوى التفكير"
      align="start"
      width="w-72"
      triggerClass={`flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs transition-colors hover:bg-active ${value === "deep" ? "text-primary" : "text-muted"}`}
      trigger={
        <>
          <Icon name="bulb" size={16} />
          <span className={value === "deep" ? "" : "text-ink"}>{cur.label}</span>
          <Icon name="down" size={12} />
        </>
      }
    >
      {(close) => (
        <>
          <div className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted">مستوى التفكير</div>
          {EFFORTS.map((e) => (
            <PopoverItem
              key={e.value}
              title={e.label}
              description={e.value === "deep" && noDeep ? `غير متاح في مستوى «${level!.name}»` : e.hint}
              checked={e.value === value}
              disabled={e.value === "deep" && noDeep}
              onSelect={() => (onChange(e.value), close())}
            />
          ))}
        </>
      )}
    </Popover>
  );
}

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

function TurnStatus({ threadId, turn, onRetry }: { threadId: string; turn: { state: string; label: string | null; streamId: string | null; error: string | null; ahead: number; steps?: Step[]; mine?: boolean }; onRetry: () => void }) {
  const stream = useQuery(api.chat.stream, turn.streamId && turn.state === "running" ? { threadId, streamId: turn.streamId } : "skip");
  if (turn.state === "failed")
    return (
      <div className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm ${turn.error === "أوقفتَ الإجابة قبل أن تبدأ" ? "bg-sunken text-muted" : "bg-negative-soft text-negative"}`}>
        <span className="flex-1">{turn.error === "أوقفتَ الإجابة قبل أن تبدأ" ? turn.error : `تعذّر إكمال الإجابة: ${turn.error}`}</span>
        {turn.mine !== false && (
          <button className="btn-ghost h-8 text-negative" onClick={onRetry}>
            <Icon name="retry" size={14} /> أعد المحاولة
          </button>
        )}
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

function MessageView({ m, isLast, canWrite, busy, onRetry, onReask, onOpenArtifact }: { m: Msg; isLast: boolean; canWrite: boolean; busy?: boolean; onRetry: () => void; onReask?: (agentId: string) => void; onOpenArtifact: (id: string) => void }) {
  const feedback = useMutation(api.chat.feedback);
  const [showSteps, setShowSteps] = useState(false);
  const [showParts, setShowParts] = useState(false);
  const requestDownload = useMutation(api.files.requestDownload);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const byN = useMemo(() => new Map(m.citations.map((c) => [c.n, c])), [m.citations]);
  const checks = useMemo(() => new Map(m.citations.filter((c) => c.check).map((c) => [c.n, c.check!])), [m.citations]);
  const html = useMemo(() => (m.role === "assistant" ? renderAnswer(m.text, new Set(byN.keys()), checks) : ""), [m.text, byN, checks, m.role]);

  if (m.role === "user" && m.team) return <TeamMessage messageId={m.id} author={m.author ?? null} mine={!!m.mine} text={m.text ?? ""} to={m.team.to} viaAssistant={!!m.team.viaAssistant} canWrite={canWrite} busy={!!busy} />;
  if (m.role === "user" && m.handoffOf) return <HandoffLine by={m.mine ? null : (m.author ?? "زميل")} />;
  if (m.role === "user")
    return (
      <div className="flex animate-rise flex-col items-start gap-1.5">
        {m.author && <span className="text-xs font-medium text-muted">{m.mine ? "أنت" : m.author}</span>}
        {m.attached?.length ? (
          <div className="flex max-w-[85%] flex-wrap gap-1.5">
            {m.attached.map((a, i) => (
              <span key={i} className="flex h-7 max-w-[260px] items-center gap-1.5 rounded-md border border-line bg-surface px-2 text-xs text-muted">
                <Icon name={a.kind === "file" ? "file" : "folder"} size={13} />
                <span className="truncate">{a.name}</span>
              </span>
            ))}
          </div>
        ) : null}
        <UserText text={m.text ?? ""} />
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
      {m.forName && (
        <p className="flex items-center gap-1.5 text-xs text-muted" title="اشتغل المساعد بصلاحيات صاحب الطلب">
          <Icon name="bot" size={13} /> {m.mine ? "المساعد · بطلبك" : `المساعد · بطلب من ${m.forName}`}
        </p>
      )}
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
                  {c.check && <span className={`mt-0.5 block text-xs ${c.check === "contradicts" ? "text-negative" : "text-warning"}`}>{CITE_CHECK[c.check]}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1 text-xs text-muted">
        <IconButton label={copied ? "نُسخ" : "نسخ"} icon="copy" onClick={() => void navigator.clipboard?.writeText(m.text).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))} />
        {isLast && canWrite && m.mine !== false && <IconButton label="أعد المحاولة" icon="retry" onClick={onRetry} />}
        {m.mine !== false && (
          <>
            <IconButton label="إجابة مفيدة" icon="thumbUp" on={m.feedback === "up"} onClick={() => void feedback({ messageId: m.id, value: m.feedback === "up" ? null : "up" })} />
            <IconButton label="إجابة غير مفيدة" icon="thumbDown" on={m.feedback === "down"} onClick={() => void feedback({ messageId: m.id, value: m.feedback === "down" ? null : "down" })} />
          </>
        )}
        {sourceFiles.length > 0 && (
          <button className="ms-1 flex h-8 items-center gap-1 rounded-md px-2 hover:bg-active" onClick={() => setShowSources(!showSources)} aria-expanded={showSources}>
            <Icon name="file" size={14} />
            {sourceFiles.length === 1 ? sourceFiles[0]!.fileName : `${sourceFiles.length} مصادر`}
          </button>
        )}
        {copied && <span>نُسخ</span>}
        <span className="ms-auto flex items-center gap-1">
          {(m.parts?.length ?? 0) > 0 && (
            <button className="flex h-8 items-center gap-1 rounded-md px-2 hover:bg-active" onClick={() => setShowParts(!showParts)} aria-expanded={showParts} title="قُسّم الطلب على عدة وكلاء ثم جُمعت نتائجهم">
              <Icon name="users" size={14} />
              {m.parts!.length} وكلاء
            </button>
          )}
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
      {showParts && (m.parts?.length ?? 0) > 0 && <PartList parts={m.parts!} />}
      {error && <p className="text-xs text-negative">{error}</p>}
    </div>
  );
}

/** The parts a split request was worked in (plans/08 §A): each agent's own result, collapsed. */
function PartList({ parts }: { parts: Part[] }) {
  return (
    <div className="space-y-2">
      {parts.map((p, i) => (
        <details key={i} className="animate-fade rounded-lg border border-line bg-surface">
          <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
            <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs ${p.ok ? "bg-positive-soft text-positive" : "bg-negative-soft text-negative"}`}>{i + 1}</span>
            <span className="min-w-0 flex-1 truncate">{p.goal}</span>
            <span className="badge shrink-0">
              <Icon name="bot" size={12} /> {p.agent}
            </span>
            <span className="meta num shrink-0">{secs(p.ms)}</span>
          </summary>
          <div className="md border-t border-rule px-3 py-2 text-sm" dangerouslySetInnerHTML={{ __html: renderAnswer(p.text, new Set()) }} />
        </details>
      ))}
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
  if (p.tool === "notify_colleague") {
    if (Array.isArray(a.people)) out.push(`إلى: ${a.people.join("، ")}`);
    if (a.message) out.push(`الرسالة: ${String(a.message).slice(0, 300)}`);
    return out;
  }
  if (p.tool === "publish_output") {
    out.push(`لمن: ${a.audience === "public" ? "أي أحد معه الرابط (بلا تسجيل دخول)" : a.audience === "workspace" ? "كل الموظفين" : "أعضاء المساحة"}`);
    if (typeof a.version === "number") out.push(`النسخة: ${a.version}`);
    if (Array.isArray(a.grants)) out.push(...(a.grants.length ? a.grants.map((g: string) => `يستطيع التطبيق: ${g}`) : ["التطبيق لا يكتب في أي قائمة ولا يقرأ منها"]));
    else if (a.form) out.push("نموذج تُحفظ ردوده في قائمة");
    return out;
  }
  if (p.tool === "propose_record_set") {
    const sm = a.summary;
    if (!sm) return out;
    if (sm.errors?.length) return [...out, ...sm.errors.map((e: string) => `تعذّر: ${e}`)];
    if (a.name) out.push(`السجل: ${a.name}`);
    if (sm.space) out.push(`في المساحة: ${sm.space}`);
    out.push(`الصفوف: ${sm.rows}`);
    const TYPE: Record<string, string> = { text: "نص", number: "رقم", date: "تاريخ", boolean: "نعم/لا" };
    out.push(`الأعمدة: ${sm.columns.map((c: any) => `${c.header} (${TYPE[c.type] ?? c.type})`).join("، ")}`);
    out.push(sm.owner ? `صاحب السطر: ${sm.owner.header} — يطابق ${sm.owner.matched} من ${sm.owner.distinct} موظفاً لهم حسابات` : "لا يوجد عمود لأرقام الهوية أو الأرقام الوظيفية");
    if (sm.uniqueBy?.length) out.push(`لا يتكرر: ${sm.uniqueBy.join(" + ")}`);
    return out;
  }
  if (p.tool === "fill_template" && a.summary) {
    const sm = a.summary;
    if (sm.error) return [`تعذّر: ${sm.error}`];
    out.push(`القالب: ${sm.template}`);
    out.push(`المسودات: ${sm.count}`);
    if (sm.existing) out.push(`لها مستند من هذا القالب: ${sm.existing} (لن تتكرر)`);
    if (sm.people?.length) out.push(`لمن: ${sm.people.join("، ")}${sm.count > sm.people.length ? ` و${sm.count - sm.people.length} غيرهم` : ""}`);
    out.push("تذهب لمدير المساحة ليعتمدها ويصدرها.");
    return out;
  }
  if (p.tool === "write_app") {
    const files = a.files && typeof a.files === "object" ? Object.keys(a.files) : [];
    if (files.length) out.push(`الملفات: ${files.join("، ")}`);
    if (a.data && typeof a.data === "object") out.push(`القوائم: ${Object.keys(a.data).join("، ")}`);
    return out;
  }
  if (a.skill) out.push(`سكربت المهارة: /${a.skill}${a.script ? ` (${a.script})` : ""}`);
  if (Array.isArray(a.fileIds)) out.push(`الملفات: ${a.fileIds.length}`);
  if (a.templateId) out.push(`القالب: ${a.templateId}`);
  if (a.recordId) out.push(`السجل: ${a.recordId}`);
  if (a.artifactId) out.push(`المخرج: ${a.artifactId}`);
  return out;
}

/** Under a publish card: open the page, try it (nothing saved), copy the link, see the replies. */
function PublishedLinks({ url, listId }: { url: string; listId?: string }) {
  const [copied, setCopied] = useState(false);
  if (!url) return null;
  return (
    <>
      <a className="btn-secondary h-8" href={url} target="_blank" rel="noopener noreferrer">
        <Icon name="globe" size={14} /> افتح الصفحة
      </a>
      <a className="btn-secondary h-8" href={`${url}?preview=1`} target="_blank" rel="noopener noreferrer" title="تفتح الصفحة والنموذج، وما ترسله لا يُحفظ">
        <Icon name="eye" size={14} /> جرّبها
      </a>
      <button className="btn-secondary h-8" onClick={() => void navigator.clipboard?.writeText(url).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}>
        <Icon name={copied ? "check" : "copy"} size={14} /> {copied ? "نُسخ" : "انسخ الرابط"}
      </button>
      {listId && (
        <a className="btn-secondary h-8" href={`#/list/${listId}`}>
          <Icon name="table" size={14} /> الردود
        </a>
      )}
    </>
  );
}

/**
 * How a waiting action reads on its card: what it is (noun, not the running label), what «نفّذ»
 * will do, and the button's own verb. Tools not listed use their label and «نفّذ».
 */
/** A command or name in Latin letters inside Arabic text: isolated so it doesn't flip («/name»). */
const Ltr = ({ children }: { children: ReactNode }) => (
  <bdi dir="ltr" className="rounded bg-raised px-1 font-mono text-[0.92em]">
    {children}
  </bdi>
);

const ACTION_VIEW: Record<string, { icon: IconName; title: (a: any) => ReactNode; effect?: (a: any) => ReactNode; confirm: string; shown?: string[] }> = {
  create_skill: {
    icon: "bulb",
    title: (a) => <>مهارة جديدة: {a.title || a.name}</>,
    effect: (a) =>
      a.scope === "space" ? (
        "تُحفظ لكل أعضاء مساحة المحادثة، ويعتمدها مديرها إن لم تكن مديرها."
      ) : (
        <>
          تُحفظ في «مهاراتي»، وتستدعيها متى شئت بكتابة <Ltr>/{a.name ?? "اسمها"}</Ltr>
        </>
      ),
    confirm: "احفظ المهارة",
    shown: ["title"],
  },
  remember: { icon: "memory", title: () => "حفظ في الذاكرة", effect: () => "يتذكّره المساعد في محادثاتك القادمة، وتستطيع حذفه من «الذاكرة».", confirm: "احفظ" },
  create_artifact: { icon: "file", title: (a) => `مخرج جديد${a.title ? `: ${a.title}` : ""}`, effect: () => "يُنشأ المخرج ويُفتح في اللوحة الجانبية.", confirm: "أنشئه", shown: ["title"] },
  update_artifact: { icon: "pencil", title: (a) => `تعديل المخرج${a.title ? `: ${a.title}` : ""}`, effect: () => "تُحفظ نسخة جديدة، وتبقى السابقة في سجل النسخ.", confirm: "احفظ التعديل", shown: ["title"] },
  create_list: { icon: "table", title: (a) => `قائمة جديدة${a.title ? `: ${a.title}` : ""}`, confirm: "أنشئ القائمة", shown: ["title"] },
  update_list: { icon: "table", title: () => "تحديث القائمة", confirm: "حدّث القائمة" },
  export_document: { icon: "download", title: () => "تصدير مستند", confirm: "صدّر" },
  fill_template: { icon: "file", title: (a) => (a.summary?.count > 1 ? `مسودات مستندات: ${a.summary.count}` : "تعبئة قالب"), confirm: "أنشئ المسودات" },
  propose_record_set: { icon: "table", title: (a) => `سجل جديد من ملف${a.name ? `: ${a.name}` : ""}`, effect: () => "يُنشأ السجل بكل أعمدة الملف ويُستورد الملف نسخةً أولى. يُعدَّل لاحقاً من تبويب «السجلات».", confirm: "أنشئ السجل" },
  run_analysis: { icon: "code", title: () => "تشغيل تحليل", effect: () => "يعمل الكود في بيئة معزولة على الملفات المذكورة فقط.", confirm: "شغّل" },
  publish_output: { icon: "globe", title: (a) => `نشر صفحة${a.title ? `: ${a.title}` : ""}`, confirm: "انشر", shown: ["title"] },
};

/** Field names as the person reads them; ids and internal fields are left to «البيانات الخام». */
const ARG_LABEL: Record<string, string> = {
  name: "الاسم",
  title: "العنوان",
  description: "متى تُستخدم",
  instructions: "التعليمات",
  text: "النص",
  content: "المحتوى",
  code: "الكود",
  note: "ملاحظة",
};
const HIDDEN_ARG = /(^|_)(id|ids)$|Id$|Ids$|^scope$|^kind$|^runIds$/;

/** The readable preview of an action: short fields inline, long text rendered and folded. */
function ActionArgs({ args, skip = [] }: { args: any; skip?: string[] }) {
  const [raw, setRaw] = useState(false);
  const fields = Object.entries(args ?? {}).filter(([k, v]) => ARG_LABEL[k] && !skip.includes(k) && typeof v === "string" && v.trim() && !HIDDEN_ARG.test(k)) as [string, string][];
  const short = fields.filter(([k, v]) => v.length <= 160 && !v.includes("\n") && k !== "code");
  const long = fields.filter((f) => !short.includes(f));
  return (
    <div className="mt-3 space-y-3 border-t border-rule pt-3">
      {short.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {short.map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-muted">{ARG_LABEL[k]}</dt>
              <dd className="text-ink" dir="auto">
                {/^[\x20-\x7e]+$/.test(v) ? <Ltr>{v}</Ltr> : v}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
      {long.map(([k, v]) => (
        <div key={k}>
          <p className="mb-1 text-xs text-muted">{ARG_LABEL[k]}</p>
          {k === "code" ? (
            <pre className="max-h-64 overflow-auto rounded-md bg-sunken p-3 font-mono text-[11px] leading-5" dir="ltr">
              {v}
            </pre>
          ) : (
            <div className="md md-compact max-h-64 overflow-auto rounded-md bg-sunken px-3 py-2" dir="auto" dangerouslySetInnerHTML={{ __html: renderAnswer(v, new Set()) }} />
          )}
        </div>
      ))}
      <button className="text-xs text-faint hover:text-muted" onClick={() => setRaw(!raw)} aria-expanded={raw}>
        {raw ? "أخفِ البيانات الخام" : "البيانات الخام"}
      </button>
      {raw && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-sunken p-2 text-[11px]" dir="ltr">
          {JSON.stringify(args, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** «ينتهي بعد 23 ساعة»: the full date stays in the tooltip. */
function expiresIn(at: number) {
  const m = Math.max(0, Math.round((at - Date.now()) / 60_000));
  if (m < 60) return `ينتهي بعد ${m} دقيقة`;
  const h = Math.round(m / 60);
  if (h < 48) return `ينتهي بعد ${h} ساعة`;
  return `ينتهي بعد ${Math.round(h / 24)} أيام`;
}

function ProposalCard({ p, onOpenArtifact }: { p: Proposal; onOpenArtifact: (id: string) => void }) {
  const confirm = useAction(api.chat.confirmProposal);
  const cancel = useMutation(api.chat.cancelProposal);
  const undo = useMutation(api.chat.undo);
  const [kept, setKept] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = p.state === "pending";
  const [open, setOpen] = useState(pending);
  const st = PROPOSAL_STATE[p.state] ?? { label: p.state, tone: "bg-raised" };
  const view = ACTION_VIEW[p.tool];
  const title = view?.title(p.args ?? {}) ?? p.label.replace(/…$/, "");
  const summary = proposalSummary(p).filter((l) => !l.startsWith("العنوان:") || !view);
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
    <div className={`rounded-lg border bg-surface text-sm ${pending ? "border-warning/40 shadow-sm" : "border-line"}`}>
      <div className="flex items-start gap-3 p-3">
        <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md ${pending ? "bg-warning-soft text-warning" : "bg-raised text-muted"}`}>
          <Icon name={view?.icon ?? "play"} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium" dir="auto">
              {title}
            </span>
            <span className={`rounded px-2 py-0.5 text-xs ${st.tone}`}>{p.auto && p.state === "executed" ? "نُفّذ تلقائياً" : pending ? (p.mine === false ? "ينتظر موافقة من طلبه" : "ينتظر موافقتك") : st.label}</span>
            {p.auto && p.state === "executed" && <span className="meta">{p.tool === "notify_colleague" ? "في هذه المحادثة" : "في مساحتك الخاصة"}</span>}
            {p.tier === 3 && pending && <span className="badge-warning">حسّاس أو رسمي</span>}
          </div>
          {pending && view?.effect && <p className="mt-1 text-xs text-muted">{view.effect(p.args ?? {})}</p>}
          {summary.length > 0 && (
            <ul className="mt-1 text-xs text-muted">
              {summary.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
        </div>
        <button className="btn-ghost h-8 shrink-0 px-2 text-xs" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "أخفِ المعاينة" : "معاينة"}
          <Icon name={open ? "up" : "down"} size={13} />
        </button>
      </div>
      {open && (
        <div className="px-3 pb-1">
          <ActionArgs args={p.args} skip={view?.shown} />
        </div>
      )}
      <div className="px-3 pb-3">
        {p.state === "executed" && p.display ? (
          <p className="mt-1 text-sm text-ink">{p.display.replace(/\s*#\/list\/\w+$/, "").replace(/\s*https?:\/\/\S+\/p\/[\w-]+$/, "")}</p>
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
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {p.auto && p.state === "executed" && p.mine !== false && (
            <button className="btn-secondary h-8" disabled={busy} onClick={() => void run(async () => setKept(((await undo({ proposalId: p.id })) as { kept: string[] }).kept))}>
              <Icon name="retry" size={14} /> تراجع
            </button>
          )}
          {pending && p.mine !== false && (
            <>
              <button className="btn-primary h-8" disabled={busy} onClick={() => void run(() => confirm({ proposalId: p.id }))}>
                <Icon name="check" size={14} /> {busy ? "يُنفَّذ…" : (view?.confirm ?? "نفّذ")}
              </button>
              <button className="btn-ghost h-8" disabled={busy} onClick={() => void run(() => cancel({ proposalId: p.id }))}>
                لا، شكراً
              </button>
              <span className="ms-auto text-xs text-faint num" title={new Date(p.expiresAt).toLocaleString("ar-SA-u-nu-latn", { dateStyle: "medium", timeStyle: "short" })}>
                {expiresIn(p.expiresAt)}
              </span>
            </>
          )}
          {p.artifactIds.map((id) => (
            <OutputChip key={id} artifactId={id} onOpen={onOpenArtifact} />
          ))}
          {p.state === "executed" && p.tool === "publish_output" && /\/p\/[\w-]+/.test(p.display ?? "") && <PublishedLinks url={(p.display ?? "").match(/https?:\/\/\S+\/p\/[\w-]+/)?.[0] ?? ""} listId={p.args?.form?.listId} />}
          {p.state === "executed" && /#\/list\/\w+$/.test(p.display ?? "") && (
            <a className="btn-secondary h-8" href={(p.display ?? "").match(/#\/list\/\w+$/)![0]}>
              <Icon name="table" size={14} /> افتح القائمة
            </a>
          )}
        </div>
        {error && <p className="mt-1 text-xs text-negative">{error}</p>}
        {kept.length > 0 && <p className="mt-1 text-xs text-muted">بقي ما نُقل خارج مساحتك منذ ذلك: {kept.join("، ")}</p>}
      </div>
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
              {t.pinned && <Icon name="pin" size={14} className="shrink-0 text-primary" aria-label="مثبّتة" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px]">{t.title}</span>
                <span className="block truncate text-xs text-muted">
                  {[t.spaceName, t.shared ? (t.mine ? "مشتركة" : `مشتركة · بدأها ${t.ownerName ?? "زميل"}`) : null, t.taskId ? "مهمة" : null, t.scheduled ? "مهمة مجدولة" : null].filter(Boolean).join(" · ") || "محادثة حرّة"}
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

/** A question bubble. A long paste (a document, a skill) is folded to its first lines, with «عرض الكل». */
const FOLD_CHARS = 900;
const FOLD_LINES = 14;
function UserText({ text }: { text: string }) {
  const lines = text.split("\n");
  const long = text.length > FOLD_CHARS * 1.4 || lines.length > FOLD_LINES * 1.5;
  const [open, setOpen] = useState(false);
  const shown = !long || open ? text : lines.slice(0, FOLD_LINES).join("\n").slice(0, FOLD_CHARS);
  return (
    <div className="max-w-[85%] rounded-2xl rounded-ss-md bg-raised px-4 py-2.5 text-[15px] leading-7">
      <div className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${long && !open ? "max-h-[22rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]" : ""}`} dir="auto">
        {shown}
      </div>
      {long && (
        <button className="mt-1 text-xs font-medium text-primary hover:underline" onClick={() => setOpen(!open)}>
          {open ? "اطوِ النص" : `عرض الكل (${text.length} حرف)`}
        </button>
      )}
    </div>
  );
}
