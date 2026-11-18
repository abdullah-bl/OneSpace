// Run analysis code in the sandbox on files the user picks from their spaces. The server checks
// every file again (access.ts); this screen only offers what files:list already shows the user.

import { useState } from "react";
import { useAction, useMutation, useQuery } from "onebase/react";
import { ArtifactDock, OutputChip } from "./ArtifactPanel";
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

const spaceLabel = (s: SpaceInfo) => (s.kind === "personal" ? "مساحتي" : s.name);

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
        <h1 className="page-title">التحليل</h1>
        <p className="text-sm text-muted">
          يُشغَّل الكود في حاوية معزولة بلا شبكة، ولا يصل إلا للملفات التي تختارها هنا (للقراءة فقط في ‎/input‎). ما يُكتب في ‎/output‎ يُحفظ ملفاتٍ في المساحة التي تختارها.
        </p>
      </header>

      <section className="card space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-bold">الملفات</span>
          <select className="input" value={browse} onChange={(e) => setBrowse(e.target.value)}>
            {spaces.map((s) => (
              <option key={s._id} value={s._id}>
                {spaceLabel(s)}
              </option>
            ))}
          </select>
        </div>
        <div className="max-h-48 overflow-y-auto rounded-lg border border-line">
          {files === undefined && <div className="p-2 text-sm text-faint">جارٍ التحميل…</div>}
          {files?.length === 0 && <div className="p-2 text-sm text-faint">لا ملفات في هذه المساحة</div>}
          {files?.map((file: any) => (
            <label key={file._id} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-sunken">
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
              <span className="ms-auto text-xs text-faint">{formatSize(file.size)}</span>
            </label>
          ))}
        </div>
        {pickedList.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {pickedList.map(([id, p]) => (
              <span key={id} className="rounded-full bg-raised px-2 py-0.5 text-xs text-ink">
                {p.name}
                <button
                  className="ms-1 text-faint"
                  onClick={() =>
                    setPicked((x) => {
                      const n = { ...x };
                      delete n[id];
                      return n;
                    })
                  }
                >
                  إزالة
                </button>
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="card space-y-3 p-4">
        <div className="text-sm font-bold">الكود (Python)</div>
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
            {busy ? "يعمل…" : "شغّل"}
          </button>
        </div>
        {error && <p className="rounded-lg bg-negative-soft p-2 text-sm text-negative">{error}</p>}
      </section>

      {result && <RunResult r={result} spaces={spaces} />}
      <RecentRuns spaces={spaces} />
    </div>
  );
}

function Status({ exit, status }: { exit: any; status?: string }) {
  if (exit?.timedOut) return <span className="text-warning">تجاوز الحد الزمني</span>;
  if (exit?.oomKilled) return <span className="text-warning">تجاوز حد الذاكرة</span>;
  if (status === "running") return <span className="text-muted">يعمل…</span>;
  if (status === "done" || (exit && exit.code === 0 && !exit.error)) return <span className="text-ink">نجح</span>;
  return <span className="text-negative">فشل{exit?.error ? `: ${exit.error}` : ""}</span>;
}

function OutputLink({ fileId, name }: { fileId: string; name: string }) {
  const requestDownload = useMutation(api.files.requestDownload);
  return (
    <button className="btn-ghost px-1 text-ink" onClick={async () => window.open(await requestDownload({ fileId: fileId as any, inline: true }), "_blank", "noopener")}>
      {name}
    </button>
  );
}

/** An artifact made from a run output; opens in the side panel (sandboxed rendering). */
function RunResult({ r, spaces }: { r: any; spaces: SpaceInfo[] }) {
  const space = spaces.find((s) => s._id === r.targetSpaceId);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <section className="card space-y-2 p-4 text-sm">
      <div className="flex items-center gap-2 font-bold">
        النتيجة: <Status exit={{ code: r.exitCode, timedOut: r.timedOut, oomKilled: r.oomKilled, error: r.error }} status={r.ok ? "done" : "failed"} />
      </div>
      {r.stdout && <pre className="max-h-80 overflow-auto rounded-lg bg-ink p-3 text-xs text-surface" dir="ltr">{r.stdout}</pre>}
      {!r.ok && r.stderr && <pre className="max-h-60 overflow-auto rounded-lg bg-negative-soft p-3 text-xs text-negative" dir="ltr">{r.stderr}</pre>}
      {r.outputs.length > 0 && (
        <div>
          <div className="text-xs text-muted">المخرجات (حُفظت في {space ? spaceLabel(space) : "المساحة"}):</div>
          <div className="flex flex-wrap gap-1">
            {r.outputs.map((o: any) => (
              <OutputLink key={o.fileId} fileId={o.fileId} name={o.name} />
            ))}
          </div>
        </div>
      )}
      {r.artifactIds?.length > 0 && (
        <div>
          <div className="text-xs text-muted">تُعرض في لوحة المخرجات:</div>
          <div className="flex flex-wrap gap-1">
            {r.artifactIds.map((id: string) => (
              <OutputChip key={id} artifactId={id} onOpen={setOpenId} />
            ))}
          </div>
        </div>
      )}
      {openId && <ArtifactDock key={openId} artifactId={openId} spaces={spaces} onClose={() => setOpenId(null)} mode="overlay" />}
    </section>
  );
}

function RecentRuns({ spaces }: { spaces: SpaceInfo[] }) {
  const runs = useQuery(api.analysis.myRuns);
  if (!runs?.length) return null;
  return (
    <section className="card overflow-hidden">
      <div className="border-b border-line px-4 py-2 text-sm font-bold">تشغيلاتي الأخيرة</div>
      <table className="w-full">
        <tbody>
          {runs.map((r: any) => (
            <tr key={r._id} className="border-t border-rule align-top">
              <td className="td whitespace-nowrap text-xs text-muted">{formatDate(r.createdAt)}</td>
              <td className="td">
                <Status exit={r.exit} status={r.status} />
              </td>
              <td className="td text-xs">{r.inputs.map((i: any) => i.name).join("، ") || "—"}</td>
              <td className="td text-xs">
                {r.outputs.map((o: any) => (
                  <OutputLink key={o.fileId} fileId={o.fileId} name={o.name} />
                ))}
                {spaces.find((s) => s._id === r.spaceId) ? null : <span className="text-faint">(مساحة لم تعد متاحة)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
