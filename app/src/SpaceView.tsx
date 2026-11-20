// A space is a project (UX redesign): the page opens on what you do with it — start a chat that
// knows the space (its instructions and files), and pick up your earlier chats in it — with the
// space's knowledge beside it (instructions, files, members) and its tasks. The secondary work of
// a space (all files, outputs, records, templates and documents, members, its audit log) sits in
// the tabs. Chats in a space are private to whoever started them.

import { useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "onebase/react";
import { api, badge, errorText, formatDate, formatSize, ROLE_LABELS, spaceName, uploadBytes, type SpaceInfo } from "./lib";
import { Icon } from "./icons";
import { AuditTable } from "./AuditView";
import { STATUS, TaskBoard } from "./TasksView";
import { Menu, type MenuItem, ask } from "./ui";
import { SpaceInstructions } from "./SpaceInstructions";
import { SpaceMemory } from "./MemoryView";
import { SpaceSkills } from "./SpaceSkills";
import { OutputsTab } from "./ArtifactPanel";
import { RecordsTab } from "./RecordsView";
import { DocumentsTab } from "./DocumentsView";
import { SpaceLists } from "./ListView";
import { askAboutFile, Page, relTime, startChatWith } from "./ChatView";

/** "المساحات": my personal space and the shared spaces I can read. */
export function SpacesPage({ spaces }: { spaces: SpaceInfo[] }) {
  const personal = spaces.filter((s) => s.kind === "personal");
  const shared = spaces.filter((s) => s.kind === "shared");
  const row = (s: SpaceInfo) => {
    const b = badge(s);
    return (
      <li key={s._id}>
        <a href={`#/space/${s._id}`} className="flex min-h-[64px] items-center gap-3 border-b border-rule px-2 py-3 hover:bg-sunken">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-raised text-ink">
            <Icon name={b.icon} size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-medium">{spaceName(s)}</span>
            <span className="block truncate text-xs text-muted">
              {b.label} · {ROLE_LABELS[s.myRole] ?? s.myRole}
              {s.sensitive ? " · حسّاسة: كل فتح يُسجَّل" : ""}
            </span>
          </span>
          <Icon name="chevron" size={16} className="text-muted" />
        </a>
      </li>
    );
  };
  return (
    <Page title="المساحات" sub="كل مساحة مشروع: تعليمات وملفات يعرفها المساعد، ومحادثاتك فيها، ومهامها.">
      <div className="max-w-[760px]">
        <ul>{personal.map(row)}</ul>
        <h2 className="mt-8 section-title">المساحات المشتركة</h2>
        <p className="text-sm text-muted num">{shared.length ? `${shared.length} مساحة` : "لم تُضف إلى أي مساحة مشتركة بعد. يضيفك مدير المساحة."}</p>
        <ul className="mt-2">{shared.map(row)}</ul>
      </div>
    </Page>
  );
}

type Tab = { id: string; label: string; show: boolean };

export function SpaceView({ space, spaces, tab, go }: { space: SpaceInfo; spaces: SpaceInfo[]; tab: string; go: (p: string) => void }) {
  // Tasks are for the space's named members (not "everyone" readers); the server enforces it too.
  const hasTasks = space.kind === "shared" && ["manager", "member", "reader"].includes(space.myRole);
  const shared = space.kind === "shared";
  const tabs: Tab[] = [
    { id: "overview", label: "المحادثات", show: true },
    { id: "files", label: "الملفات", show: true },
    { id: "tasks", label: "المهام", show: hasTasks },
    { id: "lists", label: "القوائم", show: true },
    { id: "outputs", label: "المخرجات", show: true },
    { id: "records", label: "السجلات", show: shared },
    { id: "documents", label: "القوالب والمستندات", show: shared },
    { id: "members", label: "الأعضاء", show: shared },
    { id: "audit", label: "سجل المساحة", show: shared && space.canManage },
  ];
  const current = tabs.find((t) => t.id === tab && t.show)?.id ?? "overview";
  const b = badge(space);
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 lg:px-8 lg:py-9">
      <header className="flex flex-wrap items-start gap-4">
        <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl ${space.kind === "personal" ? "bg-primary-soft text-primary" : "bg-active text-ink"}`}>
          <Icon name={space.kind === "personal" ? "user" : "folder"} size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="page-title">{spaceName(space)}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            <span className="inline-flex items-center gap-1">
              <Icon name={b.icon} size={13} /> {b.label}
            </span>
            <span aria-hidden="true">·</span>
            <span>{ROLE_LABELS[space.myRole] ?? space.myRole}</span>
            {space.kind === "personal" && (
              <>
                <span aria-hidden="true">·</span>
                <span>لا يراها أحد غيرك</span>
              </>
            )}
            {space.sensitive && <span className="badge-warning">حسّاسة: كل فتح وتنزيل يُسجَّل</span>}
          </div>
        </div>
        {current !== "overview" && (
          <button className="btn-primary" onClick={() => startChatWith({ spaceId: space._id })}>
            <Icon name="plus" /> محادثة في المساحة
          </button>
        )}
      </header>
      <nav className="tabs mt-5" aria-label="أقسام المساحة">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <a
              key={t.id}
              href={`#/space/${space._id}${t.id === "overview" ? "" : "/" + t.id}`}
              className={current === t.id ? "tab-active" : "tab"}
              aria-current={current === t.id ? "page" : undefined}
            >
              {t.label}
            </a>
          ))}
      </nav>
      <div className="mt-6">
        {current === "overview" && <Overview space={space} hasTasks={hasTasks} go={go} />}
        {current === "files" && <FilesPanel space={space} spaces={spaces} />}
        {current === "lists" && <SpaceLists spaceId={space._id} go={go} />}
        {current === "outputs" && <OutputsTab space={space} spaces={spaces} />}
        {current === "records" && shared && <RecordsTab space={space} />}
        {current === "documents" && shared && <DocumentsTab space={space} />}
        {current === "members" && shared && <MembersPanel space={space} />}
        {current === "audit" && space.canManage && <AuditTable args={{ spaceId: space._id }} />}
        {current === "tasks" && hasTasks && <TaskBoard space={space} />}
      </div>
    </div>
  );
}

const fileIcon = (name: string) => (/\.(csv|xlsx?|json)$/i.test(name) ? "table" : /\.(png|jpe?g|gif|webp|svg)$/i.test(name) ? "eye" : "file");
const CHATS_SHOWN = 8;

/** The project page: start or continue a chat here; the space's knowledge and tasks beside it. */
function Overview({ space, hasTasks, go }: { space: SpaceInfo; hasTasks: boolean; go: (p: string) => void }) {
  const threads = useQuery(api.chat.spaceThreads, { spaceId: space._id });
  const files = useQuery(api.files.list, { spaceId: space._id as any });
  const ingest = useQuery(api.ingest.statuses, { spaceId: space._id as any });
  const tasks = useQuery(api.tasks.board, hasTasks ? { spaceId: space._id as any } : "skip");
  const members = useQuery(api.spaces.members, space.kind === "shared" ? { spaceId: space._id as any } : "skip");
  const [allChats, setAllChats] = useState(false);
  const openTasks = (tasks ?? []).filter((t: any) => t.status !== "done");
  const ready = (files ?? []).filter((f) => (ingest?.find((x) => x.fileId === f._id)?.state ?? "ready") === "ready");
  // Quick starts from what's in the space: its newest ready files, and a whole-space summary.
  const quick = [
    ...(ready.length > 1 ? [{ label: "ما الجديد في ملفات المساحة؟", text: "ما أهم ما في ملفات هذه المساحة؟ لخّصه في نقاط مع المصادر." }] : []),
    ...ready
      .filter((f) => fileIcon(f.name) !== "eye")
      .slice(0, 2)
      .map((f) => (fileIcon(f.name) === "table" ? { label: `حلّل ${f.name}`, text: "حلّل بيانات هذا الملف وأعطني أهم الأرقام والملاحظات ", file: f } : { label: `لخّص ${f.name}`, text: "لخّص هذا الملف وأبرز أهم ما فيه ", file: f })),
  ];
  const shownChats = allChats ? threads : threads?.slice(0, CHATS_SHOWN);
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="min-w-0">
        <button
          className="group flex w-full items-center gap-3 rounded-xl border border-control bg-surface px-4 py-4 text-start shadow-[0_2px_10px_rgba(0,0,0,0.04)] transition-colors hover:border-ink"
          onClick={() => startChatWith({ spaceId: space._id })}
        >
          <Icon name="chat" size={18} className="text-muted" />
          <span className="flex-1 text-muted">{space.kind === "personal" ? "اسأل عن ملفاتك أو اطلب أي شيء…" : "ابدأ محادثة تعرف تعليمات المساحة وملفاتها…"}</span>
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-white transition-transform group-hover:scale-105">
            <Icon name="send" size={16} />
          </span>
        </button>
        {quick.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {quick.map((q) => (
              <button
                key={q.label}
                className="flex h-8 max-w-full items-center gap-1.5 rounded-full border border-line px-3 text-sm text-muted transition-colors hover:border-control hover:text-ink"
                onClick={() =>
                  startChatWith({
                    spaceId: space._id,
                    text: q.text.trim(),
                    mentions: "file" in q && q.file ? [{ kind: "file", id: q.file._id, name: q.file.name, spaceId: space._id }] : [],
                  })
                }
              >
                <Icon name={"file" in q && q.file ? fileIcon(q.file.name) : "search"} size={13} />
                <span className="truncate">{q.label}</span>
              </button>
            ))}
          </div>
        )}

        <div className="mt-8 flex items-baseline gap-2">
          <h2 className="section-title">محادثاتك هنا</h2>
          {threads && <span className="meta num">{threads.length}</span>}
          <span className="meta ms-auto inline-flex items-center gap-1">
            {space.kind === "shared" ? (
              <>
                <Icon name="users" size={12} /> المشتركة للأعضاء، والخاصة لك
              </>
            ) : (
              <>
                <Icon name="lock" size={12} /> لا يراها غيرك
              </>
            )}
          </span>
        </div>
        {threads?.length === 0 && (
          <p className="mt-3 rounded-xl border border-dashed border-control p-5 text-center text-sm text-muted">
            لا محادثات بعد. كل محادثة تبدؤها هنا تعرف {space.kind === "personal" ? "ملفاتك" : "تعليمات المساحة وملفاتها، وتُشارك مع أعضاء المساحة إلا إن جعلتها خاصة"}.
          </p>
        )}
        {!!threads?.length && (
          <ul className="card mt-3 divide-y divide-rule overflow-hidden">
            {shownChats!.map((t) => (
              <li key={t.threadId}>
                <a href={`#/chat/${t.threadId}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-sunken">
                  <Icon name={t.scheduled ? "clock" : t.shared ? "users" : space.kind === "shared" ? "lock" : "chat"} size={16} className="shrink-0 text-faint" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{t.title}</span>
                    {t.scheduled ? (
                      <span className="block text-xs text-muted">مهمة مجدولة</span>
                    ) : space.kind === "shared" ? (
                      <span className="block text-xs text-muted">{t.shared ? (t.mine ? "مشتركة · بدأتها أنت" : `مشتركة · بدأها ${t.ownerName ?? "زميل"}`) : "خاصة بك"}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-xs text-muted num">{relTime(t.lastAt)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
        {threads && threads.length > CHATS_SHOWN && (
          <button className="btn-ghost mt-2 text-sm text-muted" onClick={() => setAllChats(!allChats)}>
            {allChats ? "أقل" : `عرض الكل (${threads.length})`}
          </button>
        )}
      </section>

      <aside className="space-y-4">
        {space.kind === "shared" ? (
          <Panel title="التعليمات" hint="يقرؤها المساعد في كل محادثة هنا">
            <SpaceInstructions space={space} />
          </Panel>
        ) : null}
        {space.kind === "shared" ? (
          <>
            <Panel title="مهارات المساحة" hint="طرق عمل الفريق: اكتب / في المحادثة">
              <SpaceSkills spaceId={space._id} />
            </Panel>
            <Panel title="ذاكرة المساحة" hint="قرارات الفريق واصطلاحاته ومصطلحاته">
              <SpaceMemory spaceId={space._id} />
            </Panel>
          </>
        ) : (
          <section className="rounded-xl bg-sunken p-4 text-sm">
            <div className="flex items-center gap-2 font-medium">
              <Icon name="lock" size={15} /> مساحتك الخاصة
            </div>
            <p className="mt-1.5 leading-6 text-muted">لا يراها أحد غيرك، بمن فيهم مدير مساحة العمل. ما يُنشئه المساعد لك يُحفظ هنا. للمشاركة انقل الملف أو انسخه إلى مساحة مشتركة.</p>
            <a href="#/memory" className="mt-2 inline-flex items-center gap-1 text-primary hover:underline">
              <Icon name="memory" size={14} /> ما يتذكّره المساعد عنك
            </a>
          </section>
        )}
        <Panel
          title="الملفات"
          count={files?.length}
          action={
            <a href={`#/space/${space._id}/files`} className="btn-ghost h-7 px-2 text-xs">
              {space.canWrite ? (
                <>
                  <Icon name="plus" size={13} /> رفع
                </>
              ) : (
                "الكل"
              )}
            </a>
          }
        >
          {files?.length === 0 && <p className="text-sm text-muted">لا ملفات بعد{space.canWrite ? ". ارفع ملفات ليعرفها المساعد." : "."}</p>}
          <ul className="-mx-2">
            {files?.slice(0, 6).map((f) => {
              const st = ingest?.find((x) => x.fileId === f._id);
              const pending = st && st.state !== "ready";
              return (
                <li key={f._id} className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-sunken">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-active text-muted">
                    <Icon name={fileIcon(f.name)} size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm" title={f.name}>
                      {f.name}
                    </span>
                    <span className="block text-[11px] text-faint num">
                      {pending ? st!.label : `${formatSize(f.size)} · ${relTime(f.updatedAt)}`}
                    </span>
                  </span>
                  {!pending && (
                    <button className="btn-ghost h-7 shrink-0 px-2 text-xs opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100" onClick={() => askAboutFile(f._id, f.name, space._id)} aria-label={`اسأل عن ${f.name}`}>
                      <Icon name="chat" size={13} /> اسأل
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {files && files.length > 6 && (
            <a href={`#/space/${space._id}/files`} className="mt-2 block text-xs text-muted hover:text-ink num">
              عرض الكل ({files.length})
            </a>
          )}
        </Panel>
        {hasTasks && (
          <Panel
            title="المهام المفتوحة"
            count={tasks ? openTasks.length : undefined}
            action={
              <a href={`#/space/${space._id}/tasks`} className="btn-ghost h-7 px-2 text-xs">
                اللوحة
              </a>
            }
          >
            {tasks && openTasks.length === 0 && <p className="text-sm text-muted">لا مهام مفتوحة.</p>}
            <ul className="-mx-2">
              {openTasks.slice(0, 5).map((t: any) => (
                <li key={t._id}>
                  <button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-start text-sm hover:bg-sunken" onClick={() => go(`/tasks/${t._id}`)}>
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${STATUS[t.status]?.tone ?? ""}`}>{STATUS[t.status]?.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
        )}
        {members && members.length > 0 && (
          <Panel
            title="الأعضاء"
            count={members.length}
            action={
              <a href={`#/space/${space._id}/members`} className="btn-ghost h-7 px-2 text-xs">
                الكل
              </a>
            }
          >
            <ul className="flex flex-wrap gap-1.5">
              {members.slice(0, 12).map((m) => (
                <li key={m.userId} className="flex items-center gap-1.5 rounded-full bg-sunken py-0.5 pe-2.5 ps-0.5 text-xs" title={ROLE_LABELS[m.role]}>
                  <span className="grid h-5 w-5 place-items-center rounded-full bg-active text-[10px]">{(m.name ?? m.email ?? "؟").charAt(0)}</span>
                  {m.name ?? m.email}
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </aside>
    </div>
  );
}

function Panel({ title, hint, count, action, children }: { title: string; hint?: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="card p-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">
            {title}
            {count !== undefined && <span className="ms-1.5 text-xs font-normal text-muted num">{count}</span>}
          </h2>
          {hint && <p className="text-[11px] text-faint">{hint}</p>}
        </div>
        <span className="ms-auto">{action}</span>
      </div>
      {children}
    </section>
  );
}

function FilesPanel({ space, spaces }: { space: SpaceInfo; spaces: SpaceInfo[] }) {
  const files = useQuery(api.files.list, { spaceId: space._id as any });
  const ingest = useQuery(api.ingest.statuses, { spaceId: space._id as any });
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const create = useMutation(api.files.create);
  const uploadVersion = useMutation(api.files.uploadVersion);
  const requestDownload = useMutation(api.files.requestDownload);
  const remove = useMutation(api.files.remove);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [transfer, setTransfer] = useState<{ fileId: string; name: string } | null>(null);
  const [openVersions, setOpenVersions] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const versionInput = useRef<HTMLInputElement>(null);
  const versionTarget = useRef<string | null>(null);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy("");
    }
  };

  const download = (fileId: string, version?: number, inline = false) =>
    run("download", async () => {
      const link = await requestDownload({ fileId: fileId as any, version, inline });
      if (inline) window.open(link, "_blank", "noopener");
      else window.location.assign(link);
    });

  return (
    <div className="space-y-3">
      {space.canWrite && (
        <div className="flex items-center gap-2">
          <button className="btn-primary" disabled={!!busy} onClick={() => input.current?.click()}>
            رفع ملفات
          </button>
          {busy && <span className="text-xs text-muted">جارٍ التنفيذ…</span>}
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const list = [...(e.target.files ?? [])];
              e.target.value = "";
              void run("upload", async () => {
                for (const file of list) {
                  const storageId = await uploadBytes(() => generateUploadUrl({}), file);
                  await create({ storageId: storageId as any, name: file.name, spaceId: space._id as any });
                }
              });
            }}
          />
          <input
            ref={versionInput}
            type="file"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              const fileId = versionTarget.current;
              if (!file || !fileId) return;
              void run("version", async () => {
                const storageId = await uploadBytes(() => generateUploadUrl({}), file);
                await uploadVersion({ fileId: fileId as any, storageId: storageId as any });
              });
            }}
          />
        </div>
      )}
      {error && <p className="rounded-lg bg-negative-soft p-2 text-sm text-negative">{error}</p>}
      {/* No overflow-hidden: each row's ⋯ menu must be able to open past the card. */}
      <div className="card">
        <table className="w-full">
          <thead className="border-b border-line">
            <tr>
              <th className="th">الاسم</th>
              <th className="th hidden sm:table-cell">الحجم</th>
              <th className="th hidden md:table-cell">آخر تعديل</th>
              <th className="th w-px"></th>
            </tr>
          </thead>
          <tbody>
            {files === undefined && (
              <tr>
                <td className="td text-faint" colSpan={4}>جارٍ التحميل…</td>
              </tr>
            )}
            {files?.length === 0 && (
              <tr>
                <td className="td text-faint" colSpan={4}>لا ملفات بعد</td>
              </tr>
            )}
            {files?.map((f) => (
              <FileRow
                key={f._id}
                f={f}
                ingest={ingest?.find((x) => x.fileId === f._id)}
                space={space}
                showVersions={openVersions === f._id}
                onToggleVersions={() => setOpenVersions(openVersions === f._id ? null : f._id)}
                onDownload={(v, inline) => download(f._id, v, inline)}
                onNewVersion={() => {
                  versionTarget.current = f._id;
                  versionInput.current?.click();
                }}
                onTransfer={() => setTransfer({ fileId: f._id, name: f.name })}
                onDelete={() => {
                  void ask(`حذف "${f.name}" وكل نسخه؟ لا يمكن التراجع.`, { danger: true, confirmLabel: "حذف" }).then((ok) => { if (ok) void run("delete", () => remove({ fileId: f._id as any })); })
                }}
              />
            ))}
          </tbody>
        </table>
      </div>
      {transfer && <TransferDialog file={transfer} from={space} spaces={spaces} onClose={() => setTransfer(null)} />}
    </div>
  );
}

function FileRow(props: {
  f: { _id: string; name: string; size: number; version: number; updatedAt: number; uploadedByName: string | null; mime: string };
  ingest?: { state: string; label: string; error: string | null; note: string | null; ocr: boolean; steering?: string | null };
  space: SpaceInfo;
  showVersions: boolean;
  onToggleVersions: () => void;
  onDownload: (version?: number, inline?: boolean) => void;
  onNewVersion: () => void;
  onTransfer: () => void;
  onDelete: () => void;
}) {
  const { f, space } = props;
  const versions = useQuery(api.files.versions, props.showVersions ? { fileId: f._id as any } : "skip");
  const previewable = /^(image\/|application\/pdf|text\/plain)/.test(f.mime);
  const ready = props.ingest?.state === "ready";
  const icon = /\.(csv|xlsx?|json)$/i.test(f.name) ? "table" : f.mime.startsWith("image/") ? "eye" : "file";
  const items: MenuItem[] = [
    ...(previewable ? [{ label: "فتح", icon: "eye" as const, onSelect: () => props.onDownload(undefined, true) }] : []),
    { label: "تنزيل", icon: "download", onSelect: () => props.onDownload() },
    ...(f.version > 1 ? [{ label: props.showVersions ? "إخفاء النسخ السابقة" : `النسخ السابقة (${f.version})`, icon: "clock" as const, onSelect: props.onToggleVersions }] : []),
    ...(space.canWrite ? [{ label: "رفع نسخة جديدة", icon: "retry" as const, onSelect: props.onNewVersion }] : []),
    { label: "نقل أو نسخ إلى مساحة", icon: "folder", onSelect: props.onTransfer },
    ...(space.canWrite ? (["divider", { label: "حذف", icon: "x", danger: true, onSelect: props.onDelete }] as MenuItem[]) : []),
  ];
  return (
    <>
      <tr className="group border-t border-rule transition-colors first:border-t-0 hover:bg-sunken">
        <td className="td">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-active text-muted">
              <Icon name={icon} size={16} />
            </span>
            <div className="min-w-0">
              <button className="block max-w-full truncate text-start font-medium hover:underline" title={previewable ? "فتح" : "تنزيل"} onClick={() => props.onDownload(undefined, previewable)}>
                {f.name}
              </button>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                <IngestBadge fileId={f._id} ingest={props.ingest} canWrite={space.canWrite} />
                {f.version > 1 && (
                  <button className="badge hover:bg-active" onClick={props.onToggleVersions} title="النسخ السابقة">
                    النسخة {f.version}
                  </button>
                )}
                <span className="num sm:hidden">{formatSize(f.size)}</span>
              </div>
            </div>
          </div>
        </td>
        <td className="td hidden text-sm text-muted num sm:table-cell">{formatSize(f.size)}</td>
        <td className="td hidden text-sm text-muted md:table-cell" title={formatDate(f.updatedAt)}>
          <span className="num">{relTime(f.updatedAt)}</span>
          {f.uploadedByName && <span className="block text-xs text-faint">{f.uploadedByName}</span>}
        </td>
        <td className="td">
          <div className="flex items-center justify-end gap-1">
            {ready && (
              <button className="btn-ghost h-8 px-2.5 text-sm" title="محادثة جديدة عن هذا الملف" onClick={() => askAboutFile(f._id, f.name, space._id)}>
                <Icon name="chat" size={15} /> اسأل
              </button>
            )}
            <Menu label={`خيارات ${f.name}`} items={items} />
          </div>
        </td>
      </tr>
      {props.showVersions && (
        <tr className="bg-sunken">
          <td className="td" colSpan={4}>
            <div className="space-y-1">
              {versions?.map((v) => (
                <div key={v.version} className="flex items-center gap-3 text-xs">
                  <span className="font-bold">نسخة {v.version}</span>
                  <span>{v.name}</span>
                  <span className="text-muted">{formatSize(v.size)}</span>
                  <span className="text-muted">{formatDate(v.uploadedAt)}</span>
                  <button className="text-ink hover:underline" onClick={() => props.onDownload(v.version)}>تنزيل</button>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function TransferDialog({ file, from, spaces, onClose }: { file: { fileId: string; name: string }; from: SpaceInfo; spaces: SpaceInfo[]; onClose: () => void }) {
  const targets = spaces.filter((s) => s._id !== from._id && s.canWrite);
  const [to, setTo] = useState(targets[0]?._id ?? "");
  const [error, setError] = useState("");
  const move = useMutation(api.files.move);
  const copy = useMutation(api.files.copy);
  const target = targets.find((t) => t._id === to);
  const audience = !target
    ? ""
    : target.kind === "personal"
      ? "أنت فقط."
      : target.everyone
        ? `كل موظفي مساحة العمل (المساحة "${target.name}" للجميع).`
        : `أعضاء المساحة "${target.name}" فقط.`;
  const act = async (fn: (args: { fileId: any; toSpaceId: any }) => Promise<unknown>) => {
    try {
      await fn({ fileId: file.fileId as any, toSpaceId: to as any });
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="card w-full max-w-md space-y-3 p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="section-title">نقل أو نسخ "{file.name}"</h2>
        {targets.length === 0 ? (
          <p className="text-sm text-muted">لا توجد مساحة أخرى تملك صلاحية الكتابة فيها.</p>
        ) : (
          <>
            <select className="input w-full" value={to} onChange={(e) => setTo(e.target.value)}>
              {targets.map((t) => (
                <option key={t._id} value={t._id}>
                  {badge(t).icon} {t.kind === "personal" ? "مساحتي" : t.name}
                </option>
              ))}
            </select>
            <p className="rounded-lg bg-raised p-2 text-sm text-ink">بعد النقل أو النسخ سيرى الملف: {audience}</p>
            {from.sensitive && <p className="rounded-lg bg-warning-soft p-2 text-sm text-warning">الملف في مساحة حسّاسة: إخراجه منها لمديرها فقط، ويُسجَّل.</p>}
          </>
        )}
        {error && <p className="text-sm text-negative">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>إلغاء</button>
          {targets.length > 0 && from.canWrite && <button className="btn-ghost" onClick={() => act(move)}>نقل</button>}
          {targets.length > 0 && <button className="btn-primary" onClick={() => act(copy)}>نسخ</button>}
        </div>
      </div>
    </div>
  );
}

function MembersPanel({ space }: { space: SpaceInfo }) {
  const members = useQuery(api.spaces.members, { spaceId: space._id as any });
  const candidates = useQuery(api.spaces.candidates, space.canManage ? { spaceId: space._id as any } : "skip");
  const add = useMutation(api.spaces.addMember);
  const setRole = useMutation(api.spaces.setMemberRole);
  const remove = useMutation(api.spaces.removeMember);
  const [pick, setPick] = useState("");
  const [role, setNewRole] = useState<"member" | "reader" | "manager">("member");
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <div className="space-y-3">
      {space.everyone && <p className="text-sm text-muted">مساحة للجميع: كل موظفي مساحة العمل يقرؤونها. الأعضاء المسمَّون أدناه يكتبون حسب أدوارهم.</p>}
      {space.canManage && (
        <div className="card flex flex-wrap items-center gap-2 p-3">
          <select className="input" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">اختر موظفاً…</option>
            {candidates?.map((c) => (
              <option key={c.userId} value={c.userId}>
                {c.name ?? c.email}
              </option>
            ))}
          </select>
          <select className="input" value={role} onChange={(e) => setNewRole(e.target.value as any)}>
            <option value="member">عضو (قراءة ورفع وتعديل)</option>
            <option value="reader">قارئ</option>
            <option value="manager">مدير المساحة</option>
          </select>
          <button className="btn-primary" disabled={!pick} onClick={() => run(async () => { await add({ spaceId: space._id as any, userId: pick as any, role }); setPick(""); })}>
            إضافة
          </button>
        </div>
      )}
      {error && <p className="rounded-lg bg-negative-soft p-2 text-sm text-negative">{error}</p>}
      <div className="card divide-y divide-rule">
        {members?.map((m) => (
          <div key={m.userId} className="flex items-center gap-3 p-3 text-sm">
            <div className="flex-1">
              <div className="font-bold">{m.name ?? m.email}</div>
              <div className="text-xs text-muted" dir="ltr">{m.email}</div>
            </div>
            {space.canManage ? (
              <>
                <select className="input" value={m.role} onChange={(e) => run(() => setRole({ spaceId: space._id as any, userId: m.userId as any, role: e.target.value as any }))}>
                  <option value="manager">مدير المساحة</option>
                  <option value="member">عضو</option>
                  <option value="reader">قارئ</option>
                </select>
                <button className="btn-danger" onClick={() => void ask(`إزالة ${m.name ?? m.email} من المساحة؟ يفقد الوصول فوراً.`, { danger: true, confirmLabel: "إزالة" }).then((ok) => { if (ok) void run(() => remove({ spaceId: space._id as any, userId: m.userId as any })); })}>
                  إزالة
                </button>
              </>
            ) : (
              <span className="text-xs text-muted">{ROLE_LABELS[m.role]}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Ingest state for the AI index: قيد المعالجة · جاهز · فشل (with the reason and a retry), and an OCR mark. */
function IngestBadge({ fileId, ingest, canWrite }: { fileId: string; ingest?: { state: string; label: string; error: string | null; note: string | null; ocr: boolean; steering?: string | null }; canWrite: boolean }) {
  const retry = useMutation(api.ingest.retry);
  if (!ingest) return null;
  const color =
    ingest.state === "ready" ? "bg-positive-soft text-positive" : ingest.state === "failed" ? "bg-negative-soft text-negative" : ingest.state === "skipped" ? "bg-raised text-muted" : "bg-raised text-ink";
  return (
    <span className="inline-flex items-center gap-1 align-middle text-[11px] font-normal">
      {/* "Ready" is the normal state: only the other states are worth a badge. */}
      {ingest.state !== "ready" && (
        <span className={`rounded px-1.5 ${color}`} title={ingest.error ?? ingest.note ?? ""}>
          {ingest.label}
        </span>
      )}
      {ingest.ocr && <span className="rounded bg-warning-soft px-1.5 text-warning" title="بعض الصفحات قُرئت آلياً من صورة (OCR)، فدقتها أقل">OCR</span>}
      {ingest.steering && (
        <span className="rounded bg-warning-soft px-1.5 text-warning" title={`يقرأ المساعد هذا الملف بيانات لا تعليمات. النص: «${ingest.steering}»`}>
          فيه نص موجّه للمساعد
        </span>
      )}
      {ingest.state === "failed" && ingest.error && <span className="text-negative">{ingest.error}</span>}
      {ingest.state === "failed" && canWrite && (
        <button className="text-ink hover:underline" onClick={() => void retry({ fileId: fileId as any })}>
          إعادة المحاولة
        </button>
      )}
    </span>
  );
}
