import { useRef, useState } from "react";
import { useMutation, useQuery } from "onebase/react";
import { api, badge, errorText, formatDate, formatSize, ROLE_LABELS, type SpaceInfo } from "./lib";
import { AuditTable } from "./AuditView";
import { askAboutFile } from "./ChatView";

export function SpaceView({ spaceId, spaces }: { spaceId: string; spaces: SpaceInfo[] }) {
  const space = spaces.find((s) => s._id === spaceId)!;
  const [tab, setTab] = useState<"files" | "members" | "audit">("files");
  const b = badge(space);
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{space.kind === "personal" ? "مساحتي" : space.name}</h1>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">
          {b.icon} {b.label}
        </span>
        {space.sensitive && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">حسّاسة — كل فتح وتنزيل يُسجَّل</span>}
        <span className="text-xs text-slate-500">دورك: {ROLE_LABELS[space.myRole] ?? space.myRole}</span>
      </header>
      {space.kind === "personal" && <p className="text-sm text-slate-500">لا يراها أحد غيرك، بمن فيهم مدير مساحة العمل. المشاركة تكون بنقل الملف أو نسخه لمساحة مشتركة.</p>}
      {space.kind === "shared" && (
        <div className="flex gap-1 border-b border-slate-200">
          <Tab on={tab === "files"} onClick={() => setTab("files")}>الملفات</Tab>
          <Tab on={tab === "members"} onClick={() => setTab("members")}>الأعضاء</Tab>
          {space.canManage && <Tab on={tab === "audit"} onClick={() => setTab("audit")}>سجل المساحة</Tab>}
        </div>
      )}
      {tab === "files" && <FilesPanel space={space} spaces={spaces} />}
      {tab === "members" && space.kind === "shared" && <MembersPanel space={space} />}
      {tab === "audit" && space.canManage && <AuditTable args={{ spaceId: space._id }} />}
    </div>
  );
}

function Tab({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`-mb-px border-b-2 px-3 py-2 text-sm ${on ? "border-teal-700 font-semibold text-teal-800" : "border-transparent text-slate-500"}`}>
      {children}
    </button>
  );
}

async function uploadBytes(getUrl: () => Promise<string>, file: File): Promise<string> {
  // Same-origin path: the server's --url may differ from the address the page was opened on.
  const u = new URL(await getUrl(), location.origin);
  const res = await fetch(u.pathname + u.search, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
  const body = await res.json();
  if (!body.storageId) throw new Error(body.error ?? "فشل الرفع");
  return body.storageId;
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
            ⬆️ رفع ملفات
          </button>
          {busy && <span className="text-xs text-slate-500">جارٍ التنفيذ…</span>}
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
      {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">الاسم</th>
              <th className="th">الحجم</th>
              <th className="th">النسخة</th>
              <th className="th">آخر تعديل</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {files === undefined && (
              <tr>
                <td className="td text-slate-400" colSpan={5}>جارٍ التحميل…</td>
              </tr>
            )}
            {files?.length === 0 && (
              <tr>
                <td className="td text-slate-400" colSpan={5}>لا ملفات بعد</td>
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
                  if (confirm(`حذف "${f.name}" وكل نسخه؟ لا يمكن التراجع.`)) void run("delete", () => remove({ fileId: f._id as any }));
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
  ingest?: { state: string; label: string; error: string | null; note: string | null; ocr: boolean };
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
  return (
    <>
      <tr className="border-t border-slate-100">
        <td className="td font-semibold">
          {f.name}
          <IngestBadge fileId={f._id} ingest={props.ingest} canWrite={space.canWrite} />
        </td>
        <td className="td text-slate-500">{formatSize(f.size)}</td>
        <td className="td">
          <button className="text-teal-700 underline-offset-2 hover:underline" onClick={props.onToggleVersions}>
            {f.version}
          </button>
        </td>
        <td className="td text-slate-500">
          {formatDate(f.updatedAt)}
          {f.uploadedByName && <span className="block text-xs">{f.uploadedByName}</span>}
        </td>
        <td className="td">
          <div className="flex flex-wrap justify-end gap-1">
            {props.ingest?.state === "ready" && (
              <button className="btn-ghost" title="محادثة تبحث في هذا الملف فقط" onClick={() => askAboutFile(f._id, f.name)}>💬 اسأل عن هذا الملف</button>
            )}
            <button className="btn-ghost" onClick={() => props.onDownload()}>تنزيل</button>
            {/^(image\/|application\/pdf|text\/plain)/.test(f.mime) && (
              <button className="btn-ghost" onClick={() => props.onDownload(undefined, true)}>فتح</button>
            )}
            {space.canWrite && <button className="btn-ghost" onClick={props.onNewVersion}>نسخة جديدة</button>}
            <button className="btn-ghost" onClick={props.onTransfer}>نقل / نسخ</button>
            {space.canWrite && <button className="btn-danger" onClick={props.onDelete}>حذف</button>}
          </div>
        </td>
      </tr>
      {props.showVersions && (
        <tr className="bg-slate-50">
          <td className="td" colSpan={5}>
            <div className="space-y-1">
              {versions?.map((v) => (
                <div key={v.version} className="flex items-center gap-3 text-xs">
                  <span className="font-semibold">نسخة {v.version}</span>
                  <span>{v.name}</span>
                  <span className="text-slate-500">{formatSize(v.size)}</span>
                  <span className="text-slate-500">{formatDate(v.uploadedAt)}</span>
                  <button className="text-teal-700 hover:underline" onClick={() => props.onDownload(v.version)}>تنزيل</button>
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
        <h2 className="font-semibold">نقل أو نسخ "{file.name}"</h2>
        {targets.length === 0 ? (
          <p className="text-sm text-slate-500">لا توجد مساحة أخرى تملك صلاحية الكتابة فيها.</p>
        ) : (
          <>
            <select className="input w-full" value={to} onChange={(e) => setTo(e.target.value)}>
              {targets.map((t) => (
                <option key={t._id} value={t._id}>
                  {badge(t).icon} {t.kind === "personal" ? "مساحتي" : t.name}
                </option>
              ))}
            </select>
            <p className="rounded-lg bg-teal-50 p-2 text-sm text-teal-900">بعد النقل أو النسخ سيرى الملف: {audience}</p>
            {from.sensitive && <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900">الملف في مساحة حسّاسة: إخراجه منها لمديرها فقط، ويُسجَّل.</p>}
          </>
        )}
        {error && <p className="text-sm text-red-700">{error}</p>}
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
      {space.everyone && <p className="text-sm text-slate-500">🌐 مساحة للجميع: كل موظفي مساحة العمل يقرؤونها. الأعضاء المسمَّون أدناه يكتبون حسب أدوارهم.</p>}
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
      {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <div className="card divide-y divide-slate-100">
        {members?.map((m) => (
          <div key={m.userId} className="flex items-center gap-3 p-3 text-sm">
            <div className="flex-1">
              <div className="font-semibold">{m.name ?? m.email}</div>
              <div className="text-xs text-slate-500" dir="ltr">{m.email}</div>
            </div>
            {space.canManage ? (
              <>
                <select className="input" value={m.role} onChange={(e) => run(() => setRole({ spaceId: space._id as any, userId: m.userId as any, role: e.target.value as any }))}>
                  <option value="manager">مدير المساحة</option>
                  <option value="member">عضو</option>
                  <option value="reader">قارئ</option>
                </select>
                <button className="btn-danger" onClick={() => confirm(`إزالة ${m.name ?? m.email} من المساحة؟ يفقد الوصول فوراً.`) && run(() => remove({ spaceId: space._id as any, userId: m.userId as any }))}>
                  إزالة
                </button>
              </>
            ) : (
              <span className="text-xs text-slate-500">{ROLE_LABELS[m.role]}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Ingest state for the AI index: قيد المعالجة · جاهز · فشل (with the reason and a retry), and an OCR mark. */
function IngestBadge({ fileId, ingest, canWrite }: { fileId: string; ingest?: { state: string; label: string; error: string | null; note: string | null; ocr: boolean }; canWrite: boolean }) {
  const retry = useMutation(api.ingest.retry);
  if (!ingest) return null;
  const color =
    ingest.state === "ready" ? "bg-emerald-50 text-emerald-700" : ingest.state === "failed" ? "bg-red-50 text-red-700" : ingest.state === "skipped" ? "bg-slate-100 text-slate-500" : "bg-sky-50 text-sky-700";
  return (
    <span className="ms-2 inline-flex items-center gap-1 align-middle text-[11px] font-normal">
      <span className={`rounded px-1.5 ${color}`} title={ingest.error ?? ingest.note ?? ""}>
        {ingest.label}
      </span>
      {ingest.ocr && <span className="rounded bg-amber-50 px-1.5 text-amber-700" title="بعض الصفحات قُرئت آلياً من صورة (OCR)، فدقتها أقل">OCR</span>}
      {ingest.state === "failed" && ingest.error && <span className="text-red-600">{ingest.error}</span>}
      {ingest.state === "failed" && canWrite && (
        <button className="text-teal-700 hover:underline" onClick={() => void retry({ fileId: fileId as any })}>
          إعادة المحاولة
        </button>
      )}
    </span>
  );
}
