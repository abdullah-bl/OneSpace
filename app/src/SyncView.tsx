// «مزامنة المجلدات» (admin console): server folders (e.g. a mounted network share under SYNC_ROOT)
// copied into shared spaces on a schedule. Backend: onebase/folderSync.ts.

import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "onebase/react";
import { api, errorText, formatDate, type SpaceInfo } from "./lib";
import { Icon } from "./icons";
import { ask, EmptyState, Menu, PageHeader } from "./ui";

type Data = NonNullable<ReturnType<typeof useQuery<typeof api.folderSync.list>>>;
type Sync = Data["syncs"][number];

const EVERY = [
  [15, "كل 15 دقيقة"],
  [60, "كل ساعة"],
  [360, "كل 6 ساعات"],
  [1440, "يومياً"],
] as const;

export function SyncView({ spaces }: { spaces: SpaceInfo[] }) {
  const data = useQuery(api.folderSync.list);
  const [editing, setEditing] = useState<Sync | "new" | null>(null);
  const [error, setError] = useState("");
  if (data === undefined) return <p className="text-sm text-muted">جارٍ التحميل…</p>;
  if (editing) return <SyncForm key={editing === "new" ? "new" : editing._id} sync={editing === "new" ? null : editing} data={data} spaces={spaces} onDone={() => setEditing(null)} />;
  return (
    <div>
      <PageHeader
        title="مزامنة المجلدات"
        subtitle="انسخ مجلداً من الخادم (مثل مجلد شبكة مشترك) إلى مساحة مشتركة بشكل دوري، ليبحث المساعد في مستنداته ويستشهد بها. الجديد يُضاف، والمعدَّل يصبح نسخة جديدة، ولا يُحذف شيء من المساحة."
        actions={
          data.root && (
            <button className="btn-primary" onClick={() => setEditing("new")}>
              <Icon name="plus" /> مزامنة جديدة
            </button>
          )
        }
      />
      {error && <p className="alert-negative mb-4">{error}</p>}
      {!data.root ? (
        <div className="card space-y-2 p-5 text-sm">
          <p className="font-medium">المزامنة غير مفعّلة على هذا الخادم</p>
          <p className="text-muted">
            اضبط المتغير <code dir="ltr">SYNC_ROOT</code> على المجلد الذي تُركَّب فيه المجلدات المشتركة (مثلاً <code dir="ltr">/mnt/shares</code>)، ثم أعد تشغيل الخادم. لا يُقرأ شيء خارج هذا المجلد. راجع دليل الإعداد لطريقة تركيب مجلد شبكة.
          </p>
        </div>
      ) : data.syncs.length === 0 ? (
        <EmptyState icon="folder" title="لا مزامنات بعد" action={<button className="btn-primary" onClick={() => setEditing("new")}>أضف مزامنة</button>}>
          المجلد الجذر: <code dir="ltr">{data.root}</code>
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {data.syncs.map((s) => (
            <SyncRow key={s._id} s={s} onEdit={() => setEditing(s)} onError={setError} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SyncRow({ s, onEdit, onError }: { s: Sync; onEdit: () => void; onError: (e: string) => void }) {
  const runNow = useAction(api.folderSync.runNow);
  const remove = useMutation(api.folderSync.remove);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    onError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const lr = s.lastRun;
  return (
    <li className="card flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${s.enabled ? "bg-active" : "bg-sunken text-faint"}`}>
        <Icon name="folder" size={16} />
      </span>
      <div className="min-w-56 flex-1">
        <p className="flex flex-wrap items-center gap-1.5 font-medium">
          <code dir="ltr">/{s.path}</code>
          <Icon name="next" size={12} className="text-faint" />
          {s.spaceName}
          {!s.enabled && <span className="badge">متوقفة</span>}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {EVERY.find(([m]) => m === s.intervalMinutes)?.[1] ?? `كل ${s.intervalMinutes} دقيقة`} · <span className="num">{s.files}</span> ملفاً مُزامناً{s.recursive ? " · مع المجلدات الفرعية" : ""}
        </p>
        <p className="mt-0.5 text-xs">
          {s.running ? (
            <span className="text-muted">تعمل الآن…</span>
          ) : !lr ? (
            <span className="text-muted">لم تعمل بعد</span>
          ) : lr.error ? (
            <span className="text-negative">
              {lr.error} · {formatDate(lr.at)}
            </span>
          ) : (
            <span className="text-positive">
              {formatDate(lr.at)}: أُضيف {lr.added}، حُدّث {lr.updated}، دون تغيير {lr.unchanged}
              {lr.skipped ? `، تُخطّي ${lr.skipped}` : ""}
            </span>
          )}
        </p>
      </div>
      <button className="btn-secondary h-8 text-xs" disabled={busy || !!s.running} onClick={() => void run(() => runNow({ syncId: s._id }))}>
        {busy ? "يزامن…" : "زامن الآن"}
      </button>
      <Menu
        label="خيارات المزامنة"
        items={[
          { label: "تعديل", icon: "pencil", onSelect: onEdit },
          "divider",
          {
            label: "حذف المزامنة",
            icon: "x",
            danger: true,
            onSelect: () =>
              void ask("حذف هذه المزامنة؟ تبقى الملفات التي نُسخت في المساحة.", { danger: true, confirmLabel: "حذف" }).then((ok) => {
                if (ok) void run(() => remove({ syncId: s._id }));
              }),
          },
        ]}
      />
    </li>
  );
}

function SyncForm({ sync, data, spaces, onDone }: { sync: Sync | null; data: Data; spaces: SpaceInfo[]; onDone: () => void }) {
  const save = useMutation(api.folderSync.save);
  const browse = useAction(api.folderSync.browse);
  const writable = spaces.filter((s) => s.kind === "shared" && s.canWrite);
  const [f, setF] = useState({
    spaceId: sync?.spaceId ?? writable[0]?._id ?? "",
    path: sync?.path ?? "",
    extensions: (sync?.extensions.length ? sync.extensions : data.defaultExtensions).join(" "),
    recursive: sync?.recursive ?? true,
    intervalMinutes: sync?.intervalMinutes ?? 60,
    enabled: sync?.enabled ?? true,
  });
  const [dir, setDir] = useState<{ path: string; folders: string[]; files: number } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const open = (path: string) =>
    browse({ path })
      .then((d) => (setDir(d), setF((x) => ({ ...x, path: d.path }))))
      .catch((e) => setError(errorText(e)));
  useEffect(() => void open(f.path), []);

  return (
    <div>
      <button className="btn-ghost mb-3 h-8 px-2 text-sm" onClick={onDone}>
        <Icon name="next" size={14} /> مزامنة المجلدات
      </button>
      <h1 className="page-title mb-5">{sync ? "تعديل المزامنة" : "مزامنة جديدة"}</h1>
      <form
        className="card space-y-5 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          save({ syncId: sync?._id, spaceId: f.spaceId, path: f.path, extensions: f.extensions.split(/[\s,]+/), recursive: f.recursive, intervalMinutes: f.intervalMinutes, enabled: f.enabled })
            .then(onDone)
            .catch((e) => setError(errorText(e)))
            .finally(() => setBusy(false));
        }}
      >
        <div>
          <p className="label">المجلد</p>
          <div className="rounded-lg border border-line">
            <div className="flex items-center gap-1 border-b border-line px-3 py-2 text-sm" dir="ltr">
              <button type="button" className="text-primary hover:underline" onClick={() => void open("")}>
                {data.root}
              </button>
              {dir?.path &&
                dir.path.split("/").map((part, i, all) => (
                  <span key={i} className="flex items-center gap-1">
                    <span className="text-faint">/</span>
                    <button type="button" className="text-primary hover:underline" onClick={() => void open(all.slice(0, i + 1).join("/"))}>
                      {part}
                    </button>
                  </span>
                ))}
              <span className="ms-auto text-xs text-muted">{dir ? `${dir.files} ملف` : ""}</span>
            </div>
            <ul className="max-h-56 overflow-y-auto p-1">
              {dir?.folders.map((name) => (
                <li key={name}>
                  <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-active" dir="ltr" onClick={() => void open(dir.path ? `${dir.path}/${name}` : name)}>
                    <Icon name="folder" size={14} className="text-muted" /> {name}
                  </button>
                </li>
              ))}
              {dir && dir.folders.length === 0 && <li className="px-2 py-1.5 text-xs text-muted">لا مجلدات فرعية</li>}
            </ul>
          </div>
          <p className="mt-1 text-xs text-muted">
            يُزامَن: <code dir="ltr">{data.root}/{f.path}</code>
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="label">إلى المساحة</span>
            <select className="input w-full" value={f.spaceId} onChange={(e) => setF({ ...f, spaceId: e.target.value })} required>
              {writable.length === 0 && <option value="">لا مساحة مشتركة تكتب فيها</option>}
              {writable.map((s) => (
                <option key={s._id} value={s._id}>
                  {s.name}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-faint">يرى الملفات أعضاء المساحة: اختر مساحة يحق لأعضائها رؤية المجلد كله.</span>
          </label>
          <label className="block text-sm">
            <span className="label">التكرار</span>
            <select className="input w-full" value={f.intervalMinutes} onChange={(e) => setF({ ...f, intervalMinutes: Number(e.target.value) })}>
              {EVERY.map(([m, l]) => (
                <option key={m} value={m}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="label">أنواع الملفات</span>
            <input className="input w-full" dir="ltr" value={f.extensions} onChange={(e) => setF({ ...f, extensions: e.target.value })} />
          </label>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.recursive} onChange={(e) => setF({ ...f, recursive: e.target.checked })} /> مع المجلدات الفرعية
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> مفعّلة
          </label>
        </div>
        {error && <p className="text-sm text-negative">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-rule pt-4">
          <button type="button" className="btn-ghost" onClick={onDone}>
            إلغاء
          </button>
          <button className="btn-primary" disabled={busy || !f.spaceId}>
            احفظ
          </button>
        </div>
      </form>
    </div>
  );
}
