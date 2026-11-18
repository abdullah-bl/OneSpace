// Side panel for one generated output. Markdown and HTML are untrusted, so both are shown only
// inside the fully sandboxed frame (src/sandbox.ts); tables are rendered by React (escaped) and
// can be exported as CSV/XLSX.

import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import { useAction, useMutation, useQuery } from "onebase/react";
import { api, errorText, formatDate, type SpaceInfo } from "./lib";
import { frameAttributes } from "./sandbox";

type Opened = { _id: string; title: string; kind: "markdown" | "html" | "table"; version: number; currentVersion: number; content: string; sha256: string; classification: string };

export function saveBase64(fileName: string, mime: string, base64: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SandboxedFrame({ html, title }: { html: string; title: string }) {
  const attrs = useMemo(() => frameAttributes(html), [html]);
  return <iframe title={title} className="h-[60vh] w-full rounded-lg border border-slate-200 bg-white" {...attrs} />;
}

export function ArtifactPanel({ artifactId, spaces, onClose }: { artifactId: string; spaces: SpaceInfo[]; onClose: () => void }) {
  const meta = useQuery(api.artifacts.versions, { artifactId: artifactId as any });
  const open = useMutation(api.artifacts.open);
  const exportTable = useAction(api.artifacts.exportTable);
  const move = useMutation(api.artifacts.move);
  const requestTransfer = useMutation(api.artifacts.requestTransfer);
  const [version, setVersion] = useState<number | null>(null);
  const [doc, setDoc] = useState<Opened | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const current = meta?.artifact.currentVersion;
  const wanted = version ?? current;

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

  const writable = spaces.filter((s) => s.canWrite && s._id !== meta?.artifact.spaceId);
  return (
    <aside className="card flex flex-col gap-3 p-4">
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <h2 className="font-semibold">{meta?.artifact.title ?? "…"}</h2>
          <div className="text-xs text-slate-500">
            {meta && `${KIND_LABEL[meta.artifact.kind]} · النسخة ${wanted} من ${current}`}
            {meta?.artifact.classification === "sensitive" && <span className="ms-2 rounded bg-amber-100 px-1.5 text-amber-800">مبني على مساحة حسّاسة</span>}
          </div>
        </div>
        {meta && meta.versions.length > 1 && (
          <select className="input" value={wanted} onChange={(e) => setVersion(Number(e.target.value))}>
            {meta.versions.map((v) => (
              <option key={v.version} value={v.version}>
                النسخة {v.version} — {formatDate(v.createdAt)}
              </option>
            ))}
          </select>
        )}
        <button className="btn-ghost" onClick={onClose}>
          ✕
        </button>
      </div>
      {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {note && <p className="rounded-lg bg-teal-50 p-2 text-sm text-teal-800">{note}</p>}
      {doc && doc.kind === "markdown" && <SandboxedFrame title={doc.title} html={marked.parse(doc.content, { async: false }) as string} />}
      {doc && doc.kind === "html" && (
        <>
          <p className="text-xs text-slate-500">صفحة مولَّدة تُعرض معزولة: بلا سكربتات ولا اتصال بالشبكة ولا وصول لجلستك.</p>
          <SandboxedFrame title={doc.title} html={doc.content} />
        </>
      )}
      {doc && doc.kind === "table" && <TableView content={doc.content} />}
      {doc?.kind === "table" && (
        <div className="flex gap-2">
          {(["csv", "xlsx"] as const).map((format) => (
            <button
              key={format}
              className="btn-ghost"
              onClick={() =>
                run(async () => {
                  const r = await exportTable({ artifactId: artifactId as any, version: wanted, format });
                  saveBase64(r.fileName, r.mime, r.base64);
                })
              }
            >
              تصدير {format.toUpperCase()}
            </button>
          ))}
        </div>
      )}
      {doc && <div className="text-[10px] text-slate-400" dir="ltr">sha256 {doc.sha256}</div>}
      {meta && writable.length > 0 && (
        <select
          className="input"
          value=""
          onChange={(e) => {
            const to = e.target.value;
            if (!to) return;
            const target = spaces.find((s) => s._id === to);
            if (meta.artifact.classification === "sensitive") {
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
          }}
        >
          <option value="">نقل إلى مساحة…</option>
          {writable.map((s) => (
            <option key={s._id} value={s._id}>
              {s.kind === "personal" ? "مساحتي" : s.name}
            </option>
          ))}
        </select>
      )}
    </aside>
  );
}

const KIND_LABEL: Record<string, string> = { markdown: "مستند", html: "صفحة HTML", table: "جدول" };

function TableView({ content }: { content: string }) {
  const t = useMemo(() => {
    try {
      return JSON.parse(content) as { columns: string[]; rows: unknown[][] };
    } catch {
      return { columns: [], rows: [] };
    }
  }, [content]);
  return (
    <div className="max-h-[60vh] overflow-auto rounded-lg border border-slate-200">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-slate-50">
          <tr>
            {t.columns.map((c, i) => (
              <th key={i} className="th">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.rows.map((r, i) => (
            <tr key={i} className="border-t border-slate-100">
              {t.columns.map((_, j) => (
                <td key={j} className="td">
                  {r[j] === null || r[j] === undefined ? "" : String(r[j])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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
    <div className="grid gap-4 lg:grid-cols-[1fr_1.3fr]">
      <div className="space-y-3">
        {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        {transfers && transfers.length > 0 && (
          <div className="card space-y-2 p-3">
            <div className="text-sm font-semibold">طلبات نقل مخرجات خارج المساحة</div>
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
        <div className="card divide-y divide-slate-100">
          {list?.map((a) => (
            <div key={a._id} className={`flex items-center gap-2 p-3 text-sm ${openId === a._id ? "bg-teal-50" : ""}`}>
              <button className="flex-1 text-start" onClick={() => setOpenId(a._id)}>
                <div className="font-semibold">{a.title}</div>
                <div className="text-xs text-slate-500">
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
          {list?.length === 0 && <div className="p-3 text-sm text-slate-400">لا مخرجات في هذه المساحة بعد. ينشئها الوكيل من المحادثة.</div>}
        </div>
      </div>
      {openId && <ArtifactPanel key={openId} artifactId={openId} spaces={spaces} onClose={() => setOpenId(null)} />}
    </div>
  );
}
