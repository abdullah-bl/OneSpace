// Output (artifact) panel, plans/07 §B. Full height beside the chat on desktop (draggable divider,
// width remembered), a full-screen sheet on tablets and phones. One toolbar row: close, title,
// version stepper, preview/edit, download menu, overflow menu. Markdown and HTML are untrusted,
// so they are shown only inside the fully sandboxed frame (src/sandbox.ts); tables are rendered by
// React (escaped). Each save of an edit is a new version; every output downloads as Word / PDF /
// PowerPoint (rendered by the server's sandbox), tables also as CSV / XLSX.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { marked } from "marked";
import { useAction, useMutation, useQuery } from "onebase/react";
import { api, errorText, formatDate, type SpaceInfo } from "./lib";
import { frameAttributes } from "./sandbox";
import { Icon, type IconName } from "./icons";
import { EmptyState, Menu, type MenuItem } from "./ui";

type Kind = "markdown" | "html" | "table";
type Opened = { _id: string; title: string; kind: Kind; version: number; currentVersion: number; content: string; sha256: string; classification: string };
type Format = "docx" | "pdf" | "pptx";

const KIND_LABEL: Record<string, string> = { markdown: "مستند", html: "صفحة HTML", table: "جدول" };
const KIND_ICON: Record<string, IconName> = { markdown: "file", html: "code", table: "table" };
const FORMAT_LABEL: Record<Format, string> = { docx: "Word", pdf: "PDF", pptx: "PowerPoint" };
/** What each kind can download as (mirrors onebase/lib/docExport.ts formatsFor). */
const DOC_FORMATS: Record<Kind, Format[]> = { markdown: ["docx", "pdf", "pptx"], table: ["docx", "pdf", "pptx"], html: ["pdf"] };

export function saveBase64(fileName: string, mime: string, base64: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SandboxedFrame({ html, title, className = "h-[60vh]" }: { html: string; title: string; className?: string }) {
  const attrs = useMemo(() => frameAttributes(html), [html]);
  return <iframe title={title} className={`w-full bg-white ${className}`} {...attrs} />;
}

/** A compact link to an output (chat, tasks, analysis): type icon, title, version. */
export function OutputChip({ artifactId, onOpen }: { artifactId: string; onOpen: (id: string) => void }) {
  const meta = useQuery(api.artifacts.versions, { artifactId: artifactId as any });
  const a = meta?.artifact;
  return (
    <button
      className="inline-flex max-w-full animate-pop items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-start text-sm transition-colors hover:border-control hover:bg-sunken"
      onClick={() => onOpen(artifactId)}
    >
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary-soft text-primary">
        <Icon name={KIND_ICON[a?.kind ?? "markdown"] ?? "file"} size={15} />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium">{a?.title ?? "مخرج"}</span>
        <span className="meta block">{a ? `${KIND_LABEL[a.kind]} · النسخة ${a.currentVersion}` : "…"}</span>
      </span>
    </button>
  );
}

const WIDTH_KEY = "onespace.outputPanelWidth";
function readWidth() {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return v >= 0.3 && v <= 0.72 ? v : 0.5;
  } catch {
    return 0.5;
  }
}

/**
 * Where the panel lives. "split": beside the content in a flex row (the chat), with a draggable
 * divider on desktop. "overlay": a sheet over the page from the inline end (tasks, analysis, space
 * outputs). Below lg both are a full-screen sheet.
 */
export function ArtifactDock({ artifactId, spaces, onClose, mode = "split" }: { artifactId: string; spaces: SpaceInfo[]; onClose: () => void; mode?: "split" | "overlay" }) {
  const [width, setWidth] = useState(readWidth);
  const dock = useRef<HTMLDivElement>(null);
  const drag = (e: React.PointerEvent) => {
    const row = dock.current?.parentElement;
    if (!row) return;
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    const rtl = getComputedStyle(row).direction === "rtl";
    let last = width;
    const move = (ev: PointerEvent) => {
      const px = rtl ? ev.clientX - rect.left : rect.right - ev.clientX;
      last = Math.min(0.72, Math.max(0.3, px / rect.width));
      setWidth(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      try {
        localStorage.setItem(WIDTH_KEY, String(last));
      } catch {}
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  if (mode === "overlay") {
    return (
      <div className="fixed inset-0 z-40 flex">
        <button className="hidden flex-1 animate-fade bg-ink/20 lg:block" aria-label="إغلاق" onClick={onClose} />
        <div className="h-full w-full animate-slide-in border-s border-line bg-surface shadow-[0_0_40px_rgba(0,0,0,0.12)] lg:w-[min(820px,62vw)]">
          <ArtifactPanel key={artifactId} artifactId={artifactId} spaces={spaces} onClose={onClose} />
        </div>
      </div>
    );
  }
  return (
    <div
      ref={dock}
      style={{ "--pw": `${Math.round(width * 1000) / 10}%` } as CSSProperties}
      className="fixed inset-0 z-40 flex animate-slide-in bg-surface lg:static lg:z-auto lg:w-(--pw) lg:shrink-0"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="غيّر عرض اللوحة"
        onPointerDown={drag}
        className="group relative hidden w-1.5 shrink-0 cursor-col-resize bg-line transition-colors hover:bg-primary lg:block"
      >
        <span className="absolute inset-y-0 -inset-x-1.5" />
      </div>
      <div className="min-w-0 flex-1">
        <ArtifactPanel key={artifactId} artifactId={artifactId} spaces={spaces} onClose={onClose} />
      </div>
    </div>
  );
}

export function ArtifactPanel({ artifactId, spaces, onClose }: { artifactId: string; spaces: SpaceInfo[]; onClose: () => void }) {
  const meta = useQuery(api.artifacts.versions, { artifactId: artifactId as any });
  const open = useMutation(api.artifacts.open);
  const exportTable = useAction(api.artifacts.exportTable);
  const exportDocument = useAction(api.artifacts.exportDocument);
  const edit = useMutation(api.artifacts.edit);
  const remove = useMutation(api.artifacts.remove);
  const move = useMutation(api.artifacts.move);
  const requestTransfer = useMutation(api.artifacts.requestTransfer);
  const [version, setVersion] = useState<number | null>(null);
  const [doc, setDoc] = useState<Opened | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const current = meta?.artifact.currentVersion;
  const wanted = version ?? current;
  const versions = meta?.versions ?? [];

  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    open({ artifactId: artifactId as any, version: wanted })
      .then((d) => alive && setDoc(d as Opened))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [artifactId, wanted]);

  // Escape closes the panel (not while editing: it would drop the draft).
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && draft === null && !document.fullscreenElement && !(e.target as HTMLElement)?.closest?.('[role="menu"]') && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [draft, onClose]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setError("");
    setNote("");
    try {
      await fn();
      if (ok) setNote(ok);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const home = spaces.find((s) => s._id === meta?.artifact.spaceId);
  const canWrite = !!home?.canWrite;
  const canEdit = canWrite && (doc?.kind === "markdown" || doc?.kind === "html") && wanted === current;
  const writable = spaces.filter((s) => s.canWrite && s._id !== meta?.artifact.spaceId);
  const kind = (doc?.kind ?? meta?.artifact.kind ?? "markdown") as Kind;
  const preview = useMemo(() => (doc && doc.kind === "markdown" ? (marked.parse(draft ?? doc.content, { async: false }) as string) : doc?.kind === "html" ? (draft ?? doc.content) : ""), [doc, draft]);

  const download = (format: Format | "csv" | "xlsx") =>
    run(async () => {
      setBusy(format);
      try {
        const r = format === "csv" || format === "xlsx" ? await exportTable({ artifactId: artifactId as any, version: wanted, format }) : await exportDocument({ artifactId: artifactId as any, version: wanted, format });
        saveBase64(r.fileName, r.mime, r.base64);
      } finally {
        setBusy(null);
      }
    });
  const save = () =>
    run(async () => {
      await edit({ artifactId: artifactId as any, content: draft ?? "" });
      setDraft(null);
      setVersion(null);
    }, "حُفظت نسخة جديدة");
  const moveTo = (to: string) => {
    const target = spaces.find((s) => s._id === to);
    if (meta?.artifact.classification === "sensitive") {
      void run(async () => {
        try {
          await move({ artifactId: artifactId as any, toSpaceId: to as any });
        } catch {
          await requestTransfer({ artifactId: artifactId as any, toSpaceId: to as any });
          throw new Error("هذا المخرج مبني على مساحة حسّاسة: أُرسل طلب النقل لمديرها");
        }
      }, "نُقل المخرج");
    } else if (confirm(`نقل المخرج إلى "${target?.kind === "personal" ? "مساحتي" : target?.name}"؟ سيراه أعضاؤها.`)) {
      void run(() => move({ artifactId: artifactId as any, toSpaceId: to as any }), "نُقل المخرج");
    }
  };

  const downloads: MenuItem[] = [
    ...DOC_FORMATS[kind].map((f): MenuItem => ({ label: FORMAT_LABEL[f], icon: "file", hint: f === "pptx" ? "شرائح" : undefined, onSelect: () => void download(f) })),
    ...(kind === "table" ? (["divider", { label: "Excel", icon: "table", onSelect: () => void download("xlsx") }, { label: "CSV", icon: "table", onSelect: () => void download("csv") }] as MenuItem[]) : []),
  ];
  const more: MenuItem[] = [
    { label: details ? "إخفاء التفاصيل" : "التفاصيل", icon: "eye", onSelect: () => setDetails(!details) },
    ...(kind !== "table" ? [{ label: "ملء الشاشة", icon: "expand", onSelect: () => void body.current?.requestFullscreen?.() } as MenuItem] : []),
    ...(writable.length ? (["divider", ...writable.map((s): MenuItem => ({ label: `نقل إلى ${s.kind === "personal" ? "مساحتي" : s.name}`, icon: "folder", onSelect: () => moveTo(s._id) }))] as MenuItem[]) : []),
    ...(canWrite
      ? (["divider", { label: "حذف المخرج", danger: true, onSelect: () => confirm(`حذف «${meta?.artifact.title}» بكل نسخه؟`) && void run(async () => (await remove({ artifactId: artifactId as any }), onClose())) }] as MenuItem[])
      : []),
  ];
  const idx = versions.findIndex((v) => v.version === wanted);
  const older = idx >= 0 ? versions[idx + 1] : undefined;
  const newer = idx > 0 ? versions[idx - 1] : undefined;

  return (
    <section className="panel h-full" aria-label={meta?.artifact.title ?? "مخرج"}>
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-2">
        <button className="btn-icon" aria-label="إغلاق" title="إغلاق (Esc)" onClick={onClose}>
          <Icon name="x" size={17} />
        </button>
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary-soft text-primary">
          <Icon name={KIND_ICON[kind] ?? "file"} size={15} />
        </span>
        <div className="ms-1 min-w-0 flex-1">
          <h2 className="truncate text-sm font-bold">{meta?.artifact.title ?? "…"}</h2>
          <div className="flex items-center gap-1.5">
            <span className="meta">{KIND_LABEL[kind]}</span>
            {meta?.artifact.classification === "sensitive" && <span className="badge-warning">حسّاس</span>}
            {wanted !== current && <span className="badge">نسخة سابقة</span>}
          </div>
        </div>
        {versions.length > 1 && (
          <div className="flex items-center rounded-md border border-line" aria-label="النسخ">
            <button className="btn-icon h-8 w-8" disabled={!older || draft !== null} aria-label="النسخة الأقدم" title="الأقدم" onClick={() => older && setVersion(older.version)}>
              <Icon name="next" size={15} />
            </button>
            <span className="num px-1 text-xs text-muted">
              {wanted}/{current}
            </span>
            <button className="btn-icon h-8 w-8" disabled={!newer || draft !== null} aria-label="النسخة الأحدث" title="الأحدث" onClick={() => newer && setVersion(newer.version === current ? null : newer.version)}>
              <Icon name="chevron" size={15} />
            </button>
          </div>
        )}
        {canEdit && (
          <div className="hidden items-center rounded-md bg-raised p-0.5 sm:flex" role="tablist" aria-label="العرض">
            <button role="tab" aria-selected={draft === null} className={`flex h-7 items-center gap-1 rounded px-2 text-xs ${draft === null ? "bg-surface font-medium shadow-sm" : "text-muted"}`} onClick={() => (draft === null || draft === doc?.content || confirm("تجاهل التعديلات غير المحفوظة؟")) && setDraft(null)}>
              <Icon name="eye" size={14} /> معاينة
            </button>
            <button role="tab" aria-selected={draft !== null} className={`flex h-7 items-center gap-1 rounded px-2 text-xs ${draft !== null ? "bg-surface font-medium shadow-sm" : "text-muted"}`} onClick={() => draft === null && doc && setDraft(doc.content)}>
              <Icon name="pencil" size={14} /> تعديل
            </button>
          </div>
        )}
        {canEdit && draft === null && (
          <button className="btn-icon sm:hidden" aria-label="تعديل" onClick={() => doc && setDraft(doc.content)}>
            <Icon name="pencil" size={16} />
          </button>
        )}
        <Menu label={busy ? "يجهّز الملف…" : "تنزيل"} icon="download" items={downloads.map((m) => (m === "divider" ? m : { ...m, disabled: !!busy }))} />
        <Menu label="المزيد" items={more} />
      </header>

      {(error || note || busy) && (
        <div className="shrink-0 px-3 pt-2">
          {error && <p className="alert-negative">{error}</p>}
          {note && !error && <p className="alert-info animate-fade">{note}</p>}
          {busy && <p className="alert-info animate-fade">يجهّز ملف {FORMAT_LABEL[busy as Format] ?? busy.toUpperCase()}…</p>}
        </div>
      )}

      <div ref={body} className="@container relative min-h-0 flex-1 bg-surface">
        {!doc && !error && <div className="grid h-full place-items-center text-sm text-faint">يفتح…</div>}
        {doc && kind === "table" && <TableView content={doc.content} />}
        {doc && kind !== "table" && draft === null && <SandboxedFrame title={doc.title} html={preview} className="h-full" />}
        {doc && draft !== null && (
          <div className="grid h-full @3xl:grid-cols-2">
            <textarea
              className="h-full w-full resize-none border-0 bg-sunken p-4 text-[14px] leading-7 outline-none @3xl:border-e @3xl:border-line"
              dir="auto"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              aria-label="نص المخرج"
            />
            <SandboxedFrame title="معاينة" html={preview} className="hidden h-full @3xl:block" />
          </div>
        )}
      </div>

      {draft !== null && (
        <footer className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2">
          <button className="btn-primary" onClick={() => void save()} disabled={draft === doc?.content}>
            حفظ كنسخة {(current ?? 0) + 1}
          </button>
          <button className="btn-ghost" onClick={() => (draft === doc?.content || confirm("تجاهل التعديلات غير المحفوظة؟")) && setDraft(null)}>
            إلغاء
          </button>
          <span className="meta ms-auto">{draft === doc?.content ? "لا تغييرات" : "تعديلات غير محفوظة"}</span>
        </footer>
      )}

      {details && doc && (
        <footer className="shrink-0 animate-fade space-y-1 border-t border-line px-4 py-3 text-xs text-muted">
          <div>
            النسخة {doc.version} من {current} · {formatDate(versions.find((v) => v.version === doc.version)?.createdAt ?? Date.now())} · {meta?.artifact.sourceCount ?? 0} مصدر
          </div>
          {versions.find((v) => v.version === doc.version)?.note && <div>ملاحظة: {versions.find((v) => v.version === doc.version)?.note}</div>}
          <div className="truncate text-faint" dir="ltr">
            sha256 {doc.sha256}
          </div>
        </footer>
      )}
    </section>
  );
}

const normAr = (x: string) => x.toLowerCase().replace(/[\u064B-\u0652\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي");

/** A table output: search across all cells, click a column to sort (numbers as numbers). */
function TableView({ content }: { content: string }) {
  const t = useMemo(() => {
    try {
      return JSON.parse(content) as { columns: string[]; rows: unknown[][] };
    } catch {
      return { columns: [], rows: [] };
    }
  }, [content]);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  const rows = useMemo(() => {
    const needle = normAr(q.trim());
    let out = needle ? t.rows.filter((r) => normAr(r.map(cell).join(" ")).includes(needle)) : t.rows;
    if (sort) {
      const num = (v: unknown) => {
        const n = typeof v === "number" ? v : parseFloat(cell(v).replace(/[,\s]/g, ""));
        return Number.isFinite(n) ? n : null;
      };
      out = [...out].sort((a, b) => {
        const x = a[sort.col], y = b[sort.col];
        const nx = num(x), ny = num(y);
        return (nx !== null && ny !== null ? nx - ny : cell(x).localeCompare(cell(y), "ar")) * sort.dir;
      });
    }
    return out;
  }, [t, q, sort]);
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-rule px-3 py-2">
        <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line px-2.5 focus-within:border-primary">
          <Icon name="search" size={14} className="text-faint" />
          <input className="min-w-0 flex-1 bg-transparent text-sm outline-none" value={q} onChange={(e) => setQ(e.target.value)} placeholder="بحث في الجدول…" aria-label="بحث في الجدول" />
        </div>
        <span className="meta num shrink-0">
          {rows.length === t.rows.length ? `${t.rows.length} صفاً` : `${rows.length} من ${t.rows.length}`}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-sunken">
            <tr>
              {t.columns.map((c, i) => (
                <th key={i} className="th p-0">
                  <button
                    className="flex w-full items-center gap-1 px-3 py-2 text-start hover:bg-active"
                    onClick={() => setSort((s) => (s?.col === i ? (s.dir === 1 ? { col: i, dir: -1 } : null) : { col: i, dir: 1 }))}
                    aria-sort={sort?.col === i ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
                    title="اضغط للترتيب"
                  >
                    {c}
                    {sort?.col === i && <Icon name={sort.dir === 1 ? "up" : "down"} size={12} />}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-rule">
                {t.columns.map((_, j) => (
                  <td key={j} className="td">
                    {cell(r[j])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="p-4 text-center text-sm text-muted">لا نتائج لـ«{q}».</p>}
      </div>
    </div>
  );
}

/** The outputs of one space, with the side panel. */
export function OutputsTab({ space, spaces }: { space: SpaceInfo; spaces: SpaceInfo[] }) {
  const list = useQuery(api.artifacts.list, { spaceId: space._id as any });
  const transfers = useQuery(api.artifacts.transfers, space.canManage ? { spaceId: space._id as any } : "skip");
  const decide = useMutation(api.artifacts.decideTransfer);
  const remove = useMutation(api.artifacts.remove);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState("");
  return (
    <div>
      <div className="space-y-3">
        {error && <p className="alert-negative">{error}</p>}
        {transfers && transfers.length > 0 && (
          <div className="card space-y-2 p-3">
            <div className="text-sm font-bold">طلبات نقل مخرجات خارج المساحة</div>
            {transfers.map((t) => (
              <div key={t._id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="flex-1">
                  «{t.artifactTitle}» إلى {t.toSpaceName} — {t.requestedByName}
                </span>
                <button className="btn-primary" onClick={() => decide({ transferId: t._id as any, approve: true }).catch((e) => setError(errorText(e)))}>
                  موافقة
                </button>
                <button className="btn-ghost" onClick={() => decide({ transferId: t._id as any, approve: false }).catch((e) => setError(errorText(e)))}>
                  رفض
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="card divide-y divide-rule">
          {list?.map((a) => (
            <div key={a._id} className={`flex items-center gap-2 p-3 text-sm ${openId === a._id ? "bg-raised" : ""}`}>
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary-soft text-primary">
                <Icon name={KIND_ICON[a.kind] ?? "file"} size={15} />
              </span>
              <button className="flex-1 text-start" onClick={() => setOpenId(a._id)}>
                <div className="font-medium">{a.title}</div>
                <div className="text-xs text-muted">
                  {KIND_LABEL[a.kind]} · النسخة {a.currentVersion} · {formatDate(a.updatedAt)}
                </div>
              </button>
              {space.canWrite && (
                <button className="btn-ghost text-xs" onClick={() => confirm(`حذف «${a.title}» بكل نسخه؟`) && remove({ artifactId: a._id as any }).catch((e) => setError(errorText(e)))}>
                  حذف
                </button>
              )}
            </div>
          ))}
          {list?.length === 0 && (
            <div className="p-3">
              <EmptyState icon="file" title="لا مخرجات بعد">
                ينشئها الوكيل من المحادثة: مستندات وجداول وصفحات، تُعدَّل هنا وتُنزَّل بصيغة Word أو PDF أو PowerPoint.
              </EmptyState>
            </div>
          )}
        </div>
      </div>
      {openId && <ArtifactDock key={openId} artifactId={openId} spaces={spaces} onClose={() => setOpenId(null)} mode="overlay" />}
    </div>
  );
}
