// «التحليلات»: the analyses the assistant ran for me (run_analysis in the sandbox), newest first:
// which files went in, how it went, what came out, and the chat it came from. New analyses are
// asked for in a chat; the code itself stays out of sight unless opened under «التفاصيل».
// Runs are private to their owner (analysis:myRuns / analysis:getRun).

import { useState } from "react";
import { useMutation, useQuery } from "onebase/react";
import { ArtifactDock, OutputChip } from "./ArtifactPanel";
import { api, formatDate, type SpaceInfo } from "./lib";
import { Icon } from "./icons";
import { startChatWith } from "./ChatView";
import { EmptyState, PageHeader } from "./ui";

type Run = NonNullable<ReturnType<typeof useQuery<typeof api.analysis.myRuns>>>[number];
type State = "ok" | "failed" | "running";

function stateOf(r: Run): State {
  if (r.status === "running") return "running";
  return r.status === "done" && !r.exit?.timedOut && !r.exit?.oomKilled && !r.exit?.error && (r.exit?.code ?? 0) === 0 ? "ok" : "failed";
}

function why(r: Run): string {
  if (r.exit?.timedOut) return "تجاوز الحد الزمني";
  if (r.exit?.oomKilled) return "تجاوز حد الذاكرة";
  if (r.exit?.error) return r.exit.error;
  return "انتهى بخطأ في الكود";
}

const SUGGEST = ["حلّل ملف الموظفين وأعطني أهم الأرقام", "ارسم توزيع الموظفين حسب القسم", "قارن بين ملفي المشتريات للعامين"];

export function AnalysisView({ spaces }: { spaces: SpaceInfo[] }) {
  const runs = useQuery(api.analysis.myRuns);
  const [filter, setFilter] = useState<"all" | "ok" | "failed">("all");
  const [openArtifact, setOpenArtifact] = useState<string | null>(null);
  const counts = { all: runs?.length ?? 0, ok: 0, failed: 0 };
  for (const r of runs ?? []) {
    const st = stateOf(r);
    if (st !== "running") counts[st]++;
  }
  const shown = (runs ?? []).filter((r) => filter === "all" || stateOf(r) === filter);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="التحليلات"
        subtitle="ما حلّله المساعد لك: الملفات التي استخدمها، والنتيجة، والمخرجات. يعمل التحليل في بيئة معزولة بلا إنترنت، على الملفات التي تختارها فقط."
        actions={
          <button className="btn-primary" onClick={() => startChatWith({ text: "حلّل " })}>
            <Icon name="plus" /> تحليل جديد
          </button>
        }
      />
      {runs === undefined ? (
        <p className="text-sm text-muted">جارٍ التحميل…</p>
      ) : runs.length === 0 ? (
        <EmptyState icon="table" title="لا تحليلات بعد">
          <p>اطلب التحليل في محادثة، وأرفق الملف. مثلاً:</p>
          <div className="mt-3 flex flex-wrap justify-center gap-1.5">
            {SUGGEST.map((t) => (
              <button key={t} className="h-8 rounded-full border border-line px-3 text-xs hover:border-control" onClick={() => startChatWith({ text: t })}>
                {t}
              </button>
            ))}
          </div>
        </EmptyState>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-1" role="tablist">
            {(
              [
                ["all", "الكل"],
                ["ok", "نجح"],
                ["failed", "تعثّر"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={filter === k} className={`h-8 rounded-full border px-3 text-xs ${filter === k ? "border-ink bg-ink text-surface" : "border-line hover:border-control"}`} onClick={() => setFilter(k)}>
                {label} <span className="num opacity-70">{counts[k]}</span>
              </button>
            ))}
          </div>
          <ul className="space-y-2">
            {shown.map((r) => (
              <RunCard key={r._id} r={r} spaces={spaces} onOpenArtifact={setOpenArtifact} />
            ))}
          </ul>
        </>
      )}
      {openArtifact && <ArtifactDock key={openArtifact} artifactId={openArtifact} spaces={spaces} onClose={() => setOpenArtifact(null)} mode="overlay" />}
    </div>
  );
}

function RunCard({ r, spaces, onOpenArtifact }: { r: Run; spaces: SpaceInfo[]; onOpenArtifact: (id: string) => void }) {
  const [details, setDetails] = useState(false);
  const st = stateOf(r);
  const space = spaces.find((s) => s._id === r.spaceId);
  // Output files that also became artifacts are shown once, as artifacts.
  const files = r.artifactIds.length ? r.outputs.filter((o: any) => !/\.(csv|xlsx|md|html|txt|png|jpe?g|svg)$/i.test(o.name)) : r.outputs;
  return (
    <li className="card p-4">
      <div className="flex flex-wrap items-start gap-3">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${st === "ok" ? "bg-positive" : st === "running" ? "bg-warning" : "bg-negative"}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            {r.inputs.length ? (
              <>
                على <span className="font-medium">{r.inputs.map((i: any) => i.name).join("، ")}</span>
              </>
            ) : (
              <span className="font-medium">بلا ملفات</span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {formatDate(r.createdAt)}
            {r.exit ? ` · ${(r.exit.durationMs / 1000).toFixed(1)} ث` : ""}
            {space ? ` · حُفظت في ${space.kind === "personal" ? "مساحتي" : space.name}` : r.spaceId ? " · في مساحة لم تعد متاحة لك" : ""}
          </p>
          {st === "failed" && <p className="mt-1 text-xs text-negative">تعثّر: {why(r)}</p>}
          {st === "running" && <p className="mt-1 text-xs text-muted">يعمل الآن…</p>}
        </div>
        {r.thread && (
          <a href={`#/chat/${r.thread.id}`} className="btn-ghost h-8 max-w-56 px-2 text-xs" title={r.thread.title}>
            <Icon name="chat" size={14} /> <span className="truncate">{r.thread.title}</span>
          </a>
        )}
      </div>
      {(r.artifactIds.length > 0 || files.length > 0) && (
        <div className="mt-3 flex flex-wrap gap-1.5 ps-5">
          {r.artifactIds.map((id: string) => (
            <OutputChip key={id} artifactId={id} onOpen={onOpenArtifact} />
          ))}
          {files.map((o: any) => (
            <FileChip key={o.fileId} fileId={o.fileId} name={o.name} />
          ))}
        </div>
      )}
      <div className="mt-2 ps-5">
        <button className="text-xs text-muted hover:text-ink" aria-expanded={details} onClick={() => setDetails(!details)}>
          {details ? "إخفاء التفاصيل" : "التفاصيل"}
        </button>
        {details && <RunDetails runId={r._id} />}
      </div>
    </li>
  );
}

function FileChip({ fileId, name }: { fileId: string; name: string }) {
  const requestDownload = useMutation(api.files.requestDownload);
  return (
    <button className="flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs hover:border-control" onClick={async () => window.open(await requestDownload({ fileId: fileId as any, inline: true }), "_blank", "noopener")}>
      <Icon name="download" size={14} className="text-muted" /> {name}
    </button>
  );
}

/** What the run printed, its error, and the code the assistant wrote (for whoever wants to check it). */
function RunDetails({ runId }: { runId: string }) {
  const run = useQuery(api.analysis.getRun, { runId });
  if (!run) return <p className="mt-2 text-xs text-muted">جارٍ التحميل…</p>;
  return (
    <div className="mt-2 space-y-2 text-xs">
      {run.stdout?.trim() && (
        <div>
          <p className="mb-1 text-muted">ما طبعه التحليل</p>
          <pre className="max-h-64 overflow-auto rounded-lg bg-sunken p-3" dir="ltr">
            {run.stdout}
          </pre>
        </div>
      )}
      {run.status !== "done" && run.stderr?.trim() && (
        <div>
          <p className="mb-1 text-muted">الخطأ</p>
          <pre className="max-h-48 overflow-auto rounded-lg bg-negative-soft p-3 text-negative" dir="ltr">
            {run.stderr.split("\n").slice(-20).join("\n")}
          </pre>
        </div>
      )}
      {run.code && (
        <details>
          <summary className="cursor-pointer text-muted hover:text-ink">الكود الذي كتبه المساعد (Python)</summary>
          <pre className="mt-1 max-h-80 overflow-auto rounded-lg bg-sunken p-3" dir="ltr">
            {run.code}
          </pre>
        </details>
      )}
    </div>
  );
}
