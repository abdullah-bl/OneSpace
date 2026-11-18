// Run analysis code in the sandbox on files the user picks from their spaces. The server checks
// every file again (access.ts); this screen only offers what files:list already shows the user.

import { useState } from "react";
import { useAction, useMutation, useQuery } from "onebase/react";
import { ArtifactPanel } from "./ArtifactPanel";
import { api, errorText, formatDate, formatSize, type SpaceInfo } from "./lib";

const SAMPLE = `import pandas as pd, matplotlib.pyplot as plt, onespace

# الملفات المختارة في /input ، والمخرجات تُكتب في /output
for name in onespace.inputs():
    print(name)

# مثال:
# df = pd.read_csv("/input/data.csv")
# print(df.describe())
# onespace.arabic_plots()
# df["الدرجة"].plot.hist(title=onespace.ar("توزيع الدرجات"))
# plt.savefig("/output/chart.png")
`;

const spaceLabel = (s: SpaceInfo) => (s.kind === "personal" ? "🔒 مساحتي" : s.name);

export function AnalysisView({ spaces }: { spaces: SpaceInfo[] }) {
  const runAnalysis = useAction(api.analysis.run);
  const [browse, setBrowse] = useState(spaces[0]?._id ?? "");
  const [picked, setPicked] = useState<Record<string, { name: string; spaceId: string }>>({});
  const [code, setCode] = useState(SAMPLE);
  const [target, setTarget] = useState("");
  const [timeout, setTimeoutS] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<any>(null);
  const files = useQuery(api.files.list, browse ? { spaceId: browse as any } : "skip");
  const writable = spaces.filter((s) => s.canWrite);
  const pickedList = Object.entries(picked);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <header>
        <h1 className="text-xl font-semibold">🧪 التحليل</h1>
        <p className="text-sm text-slate-500">
          يُشغَّل الكود في حاوية معزولة بلا شبكة، ولا يصل إلا للملفات التي تختارها هنا (للقراءة فقط في ‎/input‎). ما يُكتب في ‎/output‎ يُحفظ ملفاتٍ في المساحة التي تختارها.
        </p>
      </header>

      <section className="card space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">الملفات</span>
          <select className="input" value={browse} onChange={(e) => setBrowse(e.target.value)}>
            {spaces.map((s) => (
              <option key={s._id} value={s._id}>
                {spaceLabel(s)}
              </option>
            ))}
          </select>
        </div>
        <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200">
          {files === undefined && <div className="p-2 text-sm text-slate-400">جارٍ التحميل…</div>}
          {files?.length === 0 && <div className="p-2 text-sm text-slate-400">لا ملفات في هذه المساحة</div>}
          {files?.map((file: any) => (
            <label key={file._id} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50">
              <input
                type="checkbox"
                checked={!!picked[file._id]}
                onChange={(e) =>
                  setPicked((p) => {
                    const next = { ...p };
                    if (e.target.checked) next[file._id] = { name: file.name, spaceId: browse };
                    else delete next[file._id];
                    return next;
                  })
                }
              />
              <span className="truncate">{file.name}</span>
              <span className="ms-auto text-xs text-slate-400">{formatSize(file.size)}</span>
            </label>
          ))}
        </div>
        {pickedList.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {pickedList.map(([id, p]) => (
              <span key={id} className="rounded-full bg-teal-50 px-2 py-0.5 text-xs text-teal-800">
                {p.name}
                <button
                  className="ms-1 text-slate-400"
                  onClick={() =>
                    setPicked((x) => {
                      const n = { ...x };
                      delete n[id];
                      return n;
                    })
                  }
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="card space-y-3 p-4">
        <div className="text-sm font-semibold">الكود (Python)</div>
        <textarea className="input h-64 w-full font-mono text-xs" dir="ltr" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>حفظ المخرجات في</span>
          <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">تلقائي (مساحة الملفات إن أمكن، وإلا مساحتي؛ ملفات من عدة مساحات: مساحتي)</option>
            {writable.map((s) => (
              <option key={s._id} value={s._id}>
                {spaceLabel(s)}
              </option>
            ))}
          </select>
          <span>المهلة</span>
          <input className="input w-20" type="number" min={1} max={60} value={timeout} onChange={(e) => setTimeoutS(Number(e.target.value))} dir="ltr" />
          <span>ث</span>
          <button
            className="btn-primary ms-auto"
            disabled={busy || !code.trim()}
            onClick={async () => {
              setBusy(true);
              setError("");
              setResult(null);
              try {
                setResult(await runAnalysis({ code, fileIds: Object.keys(picked), targetSpaceId: target || undefined, timeoutSeconds: timeout }));
              } catch (err) {
                setError(errorText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "يعمل…" : "▶ شغّل"}
          </button>
        </div>
        {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      </section>

      {result && <RunResult r={result} spaces={spaces} />}
      <RecentRuns spaces={spaces} />
    </div>
  );
}

function Status({ exit, status }: { exit: any; status?: string }) {
  if (exit?.timedOut) return <span className="text-amber-700">تجاوز الحد الزمني</span>;
  if (exit?.oomKilled) return <span className="text-amber-700">تجاوز حد الذاكرة</span>;
  if (status === "running") return <span className="text-slate-500">يعمل…</span>;
  if (status === "done" || (exit && exit.code === 0 && !exit.error)) return <span className="text-teal-700">نجح</span>;
  return <span className="text-red-700">فشل{exit?.error ? `: ${exit.error}` : ""}</span>;
}

function OutputLink({ fileId, name }: { fileId: string; name: string }) {
  const requestDownload = useMutation(api.files.requestDownload);
  return (
    <button className="btn-ghost px-1 text-teal-700" onClick={async () => window.open(await requestDownload({ fileId: fileId as any, inline: true }), "_blank", "noopener")}>
      📄 {name}
    </button>
  );
}

/** An artifact made from a run output; opens in the side panel (sandboxed rendering). */
function ArtifactChip({ artifactId, onOpen }: { artifactId: string; onOpen: (id: string) => void }) {
  const meta = useQuery(api.artifacts.versions, { artifactId: artifactId as any });
  if (!meta) return null;
  return (
    <button className="btn-ghost px-1 text-teal-700" onClick={() => onOpen(artifactId)}>
      🗂 {meta.artifact.title}
    </button>
  );
}

function RunResult({ r, spaces }: { r: any; spaces: SpaceInfo[] }) {
  const space = spaces.find((s) => s._id === r.targetSpaceId);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <section className="card space-y-2 p-4 text-sm">
      <div className="flex items-center gap-2 font-semibold">
        النتيجة: <Status exit={{ code: r.exitCode, timedOut: r.timedOut, oomKilled: r.oomKilled, error: r.error }} status={r.ok ? "done" : "failed"} />
      </div>
      {r.stdout && <pre className="max-h-80 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100" dir="ltr">{r.stdout}</pre>}
      {!r.ok && r.stderr && <pre className="max-h-60 overflow-auto rounded-lg bg-red-50 p-3 text-xs text-red-800" dir="ltr">{r.stderr}</pre>}
      {r.outputs.length > 0 && (
        <div>
          <div className="text-xs text-slate-500">المخرجات (حُفظت في {space ? spaceLabel(space) : "المساحة"}):</div>
          <div className="flex flex-wrap gap-1">
            {r.outputs.map((o: any) => (
              <OutputLink key={o.fileId} fileId={o.fileId} name={o.name} />
            ))}
          </div>
        </div>
      )}
      {r.artifactIds?.length > 0 && (
        <div>
          <div className="text-xs text-slate-500">تُعرض في لوحة المخرجات:</div>
          <div className="flex flex-wrap gap-1">
            {r.artifactIds.map((id: string) => (
              <ArtifactChip key={id} artifactId={id} onOpen={setOpenId} />
            ))}
          </div>
        </div>
      )}
      {openId && <ArtifactPanel key={openId} artifactId={openId} spaces={spaces} onClose={() => setOpenId(null)} />}
    </section>
  );
}

function RecentRuns({ spaces }: { spaces: SpaceInfo[] }) {
  const runs = useQuery(api.analysis.myRuns);
  if (!runs?.length) return null;
  return (
    <section className="card overflow-hidden">
      <div className="border-b border-slate-200 px-4 py-2 text-sm font-semibold">تشغيلاتي الأخيرة</div>
      <table className="w-full">
        <tbody>
          {runs.map((r: any) => (
            <tr key={r._id} className="border-t border-slate-100 align-top">
              <td className="td whitespace-nowrap text-xs text-slate-500">{formatDate(r.createdAt)}</td>
              <td className="td">
                <Status exit={r.exit} status={r.status} />
              </td>
              <td className="td text-xs">{r.inputs.map((i: any) => i.name).join("، ") || "—"}</td>
              <td className="td text-xs">
                {r.outputs.map((o: any) => (
                  <OutputLink key={o.fileId} fileId={o.fileId} name={o.name} />
                ))}
                {spaces.find((s) => s._id === r.spaceId) ? null : <span className="text-slate-400">(مساحة لم تعد متاحة)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
