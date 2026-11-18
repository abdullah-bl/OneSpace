// Agent tool: run Python analysis code in the sandbox on files the user picked.
//
// Permission model: the model only supplies code + fileIds (+ an optional target space). Every
// file is checked with access.ts for *this user* and must be inside the turn's scope; the target
// must be writable; sensitive inputs keep their outputs in their space. Only the checked files'
// bytes are sent to sandbox-runner (which has no network and no database). Outputs come back as
// regular files in the target space, and each output the side panel can show (table, markdown,
// html, image; lib/outputArtifacts.ts) also becomes a Phase 4 artifact with
// `artifactVersions.runId = runId`, in the same space; the tool returns their ids in `artifactIds`.

import { OneBaseError } from "onebase/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { artifactForOutput } from "../lib/outputArtifacts";
import { callSandbox, SandboxUnavailable } from "../lib/sandboxClient";
import type { AppTool, ToolContext, ToolResult } from "./types";

export type RunAnalysisArgs = { code: string; fileIds: string[]; targetSpaceId?: string; timeoutSeconds?: number };

/** Server-side limits for one run; the runner clamps them again to its own ceilings. */
export const RUN_LIMITS = { timeoutMs: 60_000, memoryMb: 1024, cpus: 1, pids: 64, outputMb: 20 };
const MAX_INPUT_BYTES = 100 * 1024 * 1024;
/** At most this many outputs per run also become artifacts (the rest stay files only). */
const MAX_ARTIFACTS = 20;

export type AnalysisOutcome = {
  runId: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  oomKilled: boolean;
  error?: string;
  stdout: string;
  stderr: string;
  targetSpaceId: string;
  targetName: string;
  inputSpaceIds: string[];
  inputs: { fileId: string; name: string }[];
  outputs: { fileId: string; name: string; size: number; sha256: string }[];
  artifactIds: string[];
};

export async function executeAnalysis(t: Pick<ToolContext, "ctx" | "userId" | "scopeSpaceIds" | "threadId" | "agentId">, args: RunAnalysisArgs): Promise<AnalysisOutcome> {
  const { ctx } = t;
  if (typeof args?.code !== "string" || !Array.isArray(args.fileIds)) throw new OneBaseError("code و fileIds مطلوبة");
  const timeoutMs = Math.min(Math.max(Math.round((Number(args.timeoutSeconds) || RUN_LIMITS.timeoutMs / 1000) * 1000), 1000), RUN_LIMITS.timeoutMs);
  const limits = { ...RUN_LIMITS, timeoutMs };
  const begun = await ctx.runMutation(internal.analysis.begin, {
    userId: t.userId,
    fileIds: args.fileIds.map(String),
    scopeSpaceIds: t.scopeSpaceIds.map(String),
    targetSpaceId: args.targetSpaceId,
    code: args.code,
    limits,
    threadId: t.threadId,
    agentId: t.agentId,
  });
  const runId = begun.runId as Id<"runs">;
  try {
    // Export: only the files `begin` approved, read by storage id inside OneBase.
    const files: { name: string; b64: string }[] = [];
    const inputSha256: string[] = [];
    let total = 0;
    for (const input of begun.inputs) {
      const blob = await ctx.storage.get(input.storageId);
      if (!blob) throw new SandboxUnavailable(`تعذّر قراءة الملف ${input.name}`);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      total += bytes.length;
      if (total > MAX_INPUT_BYTES) throw new SandboxUnavailable("حجم الملفات أكبر من الحد المسموح");
      files.push({ name: input.name, b64: Buffer.from(bytes).toString("base64") });
      inputSha256.push(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
    }
    const res = await callSandbox({ code: args.code, files, limits });
    const outputs = [];
    const artifacts = [];
    for (const f of res.files ?? []) {
      const bytes = Buffer.from(f.b64, "base64");
      const storageId = await ctx.storage.store(new Blob([bytes]));
      const art = artifactForOutput(f.name, new Uint8Array(bytes));
      if (art && artifacts.length < MAX_ARTIFACTS) artifacts.push({ output: outputs.length, ...art });
      outputs.push({ storageId, name: f.name, size: bytes.length, sha256: f.sha256 });
    }
    const { files: saved, artifactIds } = await ctx.runMutation(internal.analysis.finish, {
      runId,
      inputSha256,
      result: {
        ok: res.ok,
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        oomKilled: res.oomKilled,
        durationMs: res.durationMs,
        outputTruncated: res.outputTruncated,
        ...(res.error ? { error: res.error } : {}),
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? "",
        runtime: res.runtime,
        limits: res.limits,
      },
      outputs,
      artifacts,
    });
    return {
      runId,
      ok: res.ok && saved.length === outputs.length,
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      oomKilled: res.oomKilled,
      error: res.error,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      targetSpaceId: begun.targetSpaceId,
      targetName: begun.targetName,
      inputSpaceIds: begun.inputSpaceIds,
      inputs: begun.inputs.map((i) => ({ fileId: i.fileId, name: i.name })),
      outputs: saved,
      artifactIds,
    };
  } catch (e) {
    const message = e instanceof SandboxUnavailable ? e.message : "فشل التشغيل";
    await ctx.runMutation(internal.analysis.fail, { runId, error: message });
    if (e instanceof SandboxUnavailable) throw new OneBaseError(message);
    throw e;
  }
}

function clip(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} حرفاً إضافياً)` : s;
}

export function summarize(r: AnalysisOutcome): string {
  const lines = [`تشغيل ${r.runId}: ${r.ok ? "نجح" : "فشل"}`];
  if (r.timedOut) lines.push("توقف: تجاوز الحد الزمني");
  if (r.oomKilled) lines.push("توقف: تجاوز حد الذاكرة");
  if (r.error) lines.push(`خطأ: ${r.error}`);
  if (r.exitCode !== null && r.exitCode !== 0) lines.push(`رمز الخروج: ${r.exitCode}`);
  lines.push(`المدخلات: ${r.inputs.map((i) => i.name).join("، ") || "لا شيء"}`);
  if (r.stdout.trim()) lines.push("المخرج النصي:", clip(r.stdout.trim(), 20_000));
  if (!r.ok && r.stderr.trim()) lines.push("الأخطاء:", clip(r.stderr.trim().split("\n").slice(-30).join("\n"), 6000));
  if (r.outputs.length) lines.push(`ملفات المخرجات (حُفظت في ${r.targetName}):`, ...r.outputs.map((o) => `- ${o.name} (fileId: ${o.fileId}, ${o.size} بايت)`));
  if (r.artifactIds.length) lines.push(`مخرجات معروضة في اللوحة الجانبية: ${r.artifactIds.map((id) => `artifactId=${id}`).join("، ")}`);
  return lines.join("\n");
}

export const runAnalysisTool: AppTool<RunAnalysisArgs> = {
  name: "run_analysis",
  label: "يشغّل التحليل في بيئة معزولة…",
  description:
    "Runs Python 3 code (pandas, numpy, matplotlib, openpyxl; Arabic fonts; `import onespace` for onespace.ar() / onespace.arabic_plots()) " +
    "in an isolated sandbox with no network. The chosen files are available read-only under /input/<file name>. " +
    "Write result files (charts, tables) to /output/; they are saved as files in the target space, and CSV/XLSX tables, .md, .html, .txt and images " +
    "also open in the side panel (their ids come back as artifactIds). Print a short summary to stdout. " +
    "Only files the user can read can be used. Never use this tool to rank or score people: ranking has its own approved criteria.",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "Python 3 code to run." },
      fileIds: { type: "array", items: { type: "string" }, maxItems: 20, description: "Ids of the files to place in /input." },
      targetSpaceId: { type: "string", description: "Space to save /output files in: the inputs' space or the user's personal space (inputs from several spaces: personal; a sensitive space: that space). Default: the inputs' space if writable, else the personal space." },
      timeoutSeconds: { type: "number", minimum: 1, maximum: 60 },
    },
    required: ["code", "fileIds"],
    additionalProperties: false,
  },
  requiresConfirmation: true,
  answerAfterRun: true,
  async run(t: ToolContext, args: RunAnalysisArgs): Promise<ToolResult> {
    const r = await executeAnalysis(t, args);
    return {
      content: summarize(r),
      artifactIds: r.artifactIds,
      spaceIds: [...new Set([...r.inputSpaceIds, r.targetSpaceId])],
      undo: { deleteFiles: r.outputs.map((o) => o.fileId), deleteArtifacts: r.artifactIds },
    };
  },
};
