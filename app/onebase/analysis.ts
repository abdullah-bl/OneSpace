// Sandbox analysis runs. The sandbox never talks to the database (plans/02 rule 7): `begin`
// exports only files the user can read (access.ts) and that are in the turn's scope, `finish`
// stores what came back from /output as files in the chosen space after checking write access
// again, and also as Phase 4 artifacts (artifactVersions.runId) for the outputs the side panel can
// show. The target space follows Phase 4's placement rule (artifacts.ts `place`), so a run's files
// and artifacts always live together. Every export and every run is audited, and each run is a
// row in `runs`.

import { scheduleIngest } from "./ingest";
import { OneBaseError, v } from "onebase/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { actorFor, assertCan, Denied, readableSpaceIds, requireActive, requireUserId } from "./access";
import { homeSpaceOf, insertArtifact, normalizeContent, place, type Source } from "./artifacts";
import { writeAudit } from "./audit";
import { inputsPreamble } from "./skills";
import { artifactKind } from "./outputsSchema";
import { executeAnalysis, runAnalysisTool } from "./tools/run_analysis";
import type { ToolResult } from "./tools/types";

export const MAX_INPUT_FILES = 20;
export const MAX_CODE_CHARS = 100_000;

const limitsV = v.object({ timeoutMs: v.number(), memoryMb: v.number(), cpus: v.number(), pids: v.number(), outputMb: v.number() });

function sha256(text: string) {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** Output file names: no directories, no control characters. */
function outputName(name: string) {
  const n = name.replace(/[\\/]/g, "_").replace(/[\u0000-\u001f]/g, "_").trim().slice(0, 255);
  return n || "output";
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  html: "text/html",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export const mimeFor = (name: string) => MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/**
 * Checks everything before any byte leaves OneBase, records the run, audits the export.
 * Inputs: each file readable by the user AND in the turn's scope. Target: writable by the user.
 * Outputs built on a sensitive space stay in that space unless the user manages it (plans/02 rule 4).
 */
export const begin = internalMutation({
  args: {
    userId: v.id("users"),
    fileIds: v.array(v.string()),
    scopeSpaceIds: v.array(v.string()),
    targetSpaceId: v.optional(v.string()),
    code: v.string(),
    limits: limitsV,
    threadId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    // A skill's saved script (plans/09 §2): INPUTS = the files' paths in fileIds order is prepended.
    skill: v.optional(v.object({ id: v.string(), name: v.string(), version: v.number(), script: v.string() })),
  },
  handler: async (ctx, a) => {
    const actor = await actorFor(ctx, a.userId);
    if (!actor) throw new Denied();
    if (!a.code.trim()) throw new OneBaseError("لا يوجد كود للتشغيل");
    const ids = [...new Set(a.fileIds)];
    if (ids.length > MAX_INPUT_FILES) throw new OneBaseError(`الحد ${MAX_INPUT_FILES} ملفاً لكل تشغيل`);
    const scope = new Set(a.scopeSpaceIds);
    const files: { file: Doc<"files">; space: Doc<"spaces"> }[] = [];
    for (const id of ids) {
      const fid = ctx.db.normalizeId("files", id);
      const file = fid ? await ctx.db.get(fid) : null;
      if (!file || file.status !== "active") throw new Denied();
      const { space } = await assertCan(ctx, a.userId, file.spaceId, "read");
      if (!scope.has(space._id)) throw new Denied();
      files.push({ file, space });
    }
    // Where the outputs (files and artifacts) go: Phase 4's placement rule (artifacts.ts `place`,
    // plans/02 rule 4): one input space → it (if writable) or personal; several → personal; a
    // sensitive one → that space only, unless the user manages it (then any writable target,
    // still classified sensitive); write access on the target, and in the turn's scope.
    const sources: Source[] = files.map(({ file, space }) => ({ type: "file", id: file._id, spaceId: space._id }));
    const { space: target } = await place(ctx, actor, sources, new Set(), a.targetSpaceId, scope, { managerMayExport: true, home: await homeSpaceOf(ctx, actor.userId, a.threadId) });
    const code = a.skill ? inputsPreamble(files.map(({ file }) => file.name)) + a.code : a.code;
    if (code.length > MAX_CODE_CHARS) throw new OneBaseError("الكود طويل جداً");
    const codeHash = sha256(code);
    const runId = await ctx.db.insert("runs", {
      kind: "sandbox",
      userId: a.userId,
      spaceId: target._id,
      status: "running",
      code,
      codeHash,
      inputs: files.map(({ file, space }) => ({ fileId: file._id, name: file.name, sha256: null, size: file.size, spaceId: space._id })), // hex hash of the exported bytes is set by finish
      outputs: [],
      limits: a.limits,
      threadId: a.threadId,
      agentId: a.agentId,
      ...(a.skill ? { skill: a.skill } : {}),
      createdAt: Date.now(),
    });
    for (const { file, space } of files) {
      await writeAudit(ctx, { userId: a.userId, action: "sandbox.export", resourceType: "file", resourceId: file._id, spaceId: space._id, detail: { fileName: file.name, runId, sha256: file.sha256 } });
    }
    await writeAudit(ctx, { userId: a.userId, action: "sandbox.run", resourceType: "run", resourceId: runId, spaceId: target._id, detail: { runId, inputs: files.length, codeHash, agentId: a.agentId ?? null, ...(a.skill ? { skill: a.skill.name, skillVersion: a.skill.version } : {}) } });
    return {
      runId,
      code,
      targetSpaceId: target._id,
      targetName: target.kind === "personal" ? "مساحتي" : target.name,
      inputSpaceIds: [...new Set(files.map((f) => f.space._id as string))],
      inputs: files.map(({ file }) => ({ fileId: file._id as string, storageId: file.storageId, name: file.name, size: file.size })),
    };
  },
});

const resultV = v.object({
  ok: v.boolean(),
  exitCode: v.union(v.number(), v.null()),
  timedOut: v.boolean(),
  oomKilled: v.boolean(),
  durationMs: v.number(),
  outputTruncated: v.boolean(),
  error: v.optional(v.string()),
  stdout: v.string(),
  stderr: v.string(),
  runtime: v.optional(v.string()),
  limits: v.optional(limitsV),
});

/**
 * Stores the outputs as files in the target space (write re-checked now), creates an artifact
 * (artifactVersions.runId = this run) for each output the side panel can show, and closes the run.
 *
 * Artifacts land in the run's target space, which `begin` chose with Phase 4's `place()`, so
 * files and artifacts of one run are always together. Classification follows artifacts.ts:
 * sensitive (origin = that space) when the target or an input space is sensitive. Sources = the
 * input files as they were at export time (space recorded by `begin`).
 */
export const finish = internalMutation({
  args: {
    runId: v.id("runs"),
    /** Hex SHA-256 of the exact bytes sent to the sandbox, in input order. */
    inputSha256: v.array(v.string()),
    result: resultV,
    outputs: v.array(v.object({ storageId: v.id("_storage"), name: v.string(), size: v.number(), sha256: v.string() })),
    /** Viewable outputs (lib/outputArtifacts.ts), by index into `outputs`. */
    artifacts: v.optional(v.array(v.object({ output: v.number(), kind: artifactKind, content: v.string() }))),
  },
  handler: async (ctx, { runId, inputSha256, result, outputs, artifacts }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status !== "running") throw new Denied();
    let canWrite = true;
    try {
      await assertCan(ctx, run.userId, run.spaceId, "write");
    } catch {
      canWrite = false;
    }
    const saved: { fileId: string; name: string; sha256: string; size: number }[] = [];
    const artifactIds: string[] = [];
    if (canWrite) {
      const now = Date.now();
      for (const o of outputs) {
        const name = outputName(o.name);
        const mime = mimeFor(name);
        const fileId = await ctx.db.insert("files", {
          spaceId: run.spaceId,
          storageId: o.storageId,
          name,
          mime,
          size: o.size,
          sha256: o.sha256,
          version: 1,
          uploadedBy: run.userId,
          ingest: "pending",
          status: "active",
          updatedAt: now,
        });
        await ctx.db.insert("fileVersions", { fileId, version: 1, storageId: o.storageId, name, mime, size: o.size, sha256: o.sha256, uploadedBy: run.userId, uploadedAt: now });
        await writeAudit(ctx, { userId: run.userId, action: "file.upload", resourceType: "file", resourceId: fileId, spaceId: run.spaceId, detail: { fileName: name, size: o.size, via: "sandbox", runId } });
        // Like an upload: index it, so the assistant can read and search what it made.
        await scheduleIngest(ctx, fileId);
        saved.push({ fileId, name, sha256: o.sha256, size: o.size });
      }
      if (artifacts?.length) {
        const target = (await ctx.db.get(run.spaceId))!;
        const inputSpaces = (await Promise.all([...new Set(run.inputs.map((i) => i.spaceId).filter((s): s is Id<"spaces"> => !!s))].map((id) => ctx.db.get(id)))).filter(Boolean) as Doc<"spaces">[];
        const origin = target.sensitive ? target : (inputSpaces.find((s) => s.sensitive) ?? null);
        const sources: Source[] = run.inputs.filter((i) => i.fileId && i.spaceId).map((i) => ({ type: "file", id: i.fileId!, spaceId: i.spaceId! }));
        for (const art of artifacts) {
          const file = saved[art.output];
          if (!file) continue;
          let content: string;
          try {
            content = normalizeContent(art.kind, art.content);
          } catch {
            continue; // too large / malformed for an artifact: the output stays a file only
          }
          const artifactId = await insertArtifact(ctx, {
            spaceId: run.spaceId,
            ownerId: run.userId,
            kind: art.kind,
            title: file.name,
            content,
            sources,
            classification: origin ? "sensitive" : "normal",
            originSpaceId: origin?._id,
            threadId: run.threadId,
            runId,
            via: "sandbox",
          });
          artifactIds.push(artifactId);
        }
      }
    } else {
      for (const o of outputs) await ctx.storage.delete(o.storageId);
    }
    const error = canWrite ? result.error : "لم تعد تملك صلاحية الكتابة في مساحة المخرجات";
    await ctx.db.patch(runId, {
      status: result.ok && canWrite ? "done" : "failed",
      inputs: run.inputs.map((input, i) => ({ ...input, sha256: inputSha256[i] ?? input.sha256 })),
      outputs: saved,
      artifactIds,
      exit: { code: result.exitCode, timedOut: result.timedOut, oomKilled: result.oomKilled, durationMs: result.durationMs, outputTruncated: result.outputTruncated, ...(error ? { error } : {}) },
      stdout: result.stdout.slice(0, 64 * 1024),
      stderr: result.stderr.slice(0, 64 * 1024),
      runtime: result.runtime,
      ...(result.limits ? { limits: result.limits } : {}),
      finishedAt: Date.now(),
    });
    return { files: saved, artifactIds };
  },
});

/** Marks a run failed when the sandbox could not be reached at all. */
export const fail = internalMutation({
  args: { runId: v.id("runs"), error: v.string() },
  handler: async (ctx, { runId, error }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status !== "running") return;
    await ctx.db.patch(runId, { status: "failed", exit: { code: null, timedOut: false, oomKilled: false, durationMs: 0, outputTruncated: false, error }, finishedAt: Date.now() });
  },
});

export const scopeFor = internalQuery({
  args: { userId: v.id("users") },
  handler: (ctx, { userId }) => readableSpaceIds(ctx, userId),
});

/**
 * The UI entry point: the user picked the code, the files and the target space and pressed
 * "شغّل" (that press is the confirmation run_analysis requires). Scope = everything they can read.
 */
export const run = action({
  args: { code: v.string(), fileIds: v.array(v.string()), targetSpaceId: v.optional(v.string()), timeoutSeconds: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const scopeSpaceIds = await ctx.runQuery(internal.analysis.scopeFor, { userId });
    const r = await executeAnalysis({ ctx, userId, scopeSpaceIds }, args);
    return {
      runId: r.runId,
      ok: r.ok,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      oomKilled: r.oomKilled,
      error: r.error ?? null,
      stdout: r.stdout,
      stderr: r.stderr,
      targetSpaceId: r.targetSpaceId,
      outputs: r.outputs,
      artifactIds: r.artifactIds,
    };
  },
});

/** Calls the agent tool exactly as the agent loop will: run() with a ToolContext. For tests and the Phase 6 loop. */
export const runToolAs = internalAction({
  args: { userId: v.id("users"), scopeSpaceIds: v.optional(v.array(v.string())), args: v.any(), threadId: v.optional(v.string()), agentId: v.optional(v.string()) },
  handler: async (ctx, { userId, scopeSpaceIds, args, threadId, agentId }): Promise<ToolResult> => {
    const scope: string[] = scopeSpaceIds ?? (await ctx.runQuery(internal.analysis.scopeFor, { userId }));
    return await runAnalysisTool.run({ ctx, userId, scopeSpaceIds: scope as Id<"spaces">[], threadId, agentId }, args);
  },
});

/** My own sandbox runs (a run can name input files from spaces others can't read, so runs are private). */
export const myRuns = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireActive(ctx);
    const rows = await ctx.db.query("runs").withIndex("by_user", (q) => q.eq("userId", me.userId)).order("desc").take(50);
    const titles = new Map<string, string>();
    for (const r of rows) {
      if (!r.threadId || titles.has(r.threadId)) continue;
      const t = await ctx.db.query("threadMeta").withIndex("by_thread", (q) => q.eq("threadId", r.threadId!)).unique();
      if (t && t.userId === me.userId && !t.test) titles.set(r.threadId, t.title || "محادثة");
    }
    return rows
      .filter((r) => r.kind === "sandbox")
      .map((r) => ({
        _id: r._id,
        thread: r.threadId && titles.has(r.threadId) ? { id: r.threadId, title: titles.get(r.threadId)! } : null,
        status: r.status,
        spaceId: r.spaceId,
        createdAt: r.createdAt,
        inputs: r.inputs.map((i) => ({ fileId: i.fileId ?? null, name: i.name })),
        outputs: r.outputs,
        artifactIds: r.artifactIds ?? [],
        exit: r.exit ?? null,
      }));
  },
});

export const getRun = query({
  args: { runId: v.string() },
  handler: async (ctx, { runId }) => {
    const me = await requireActive(ctx);
    const id = ctx.db.normalizeId("runs", runId);
    const run = id ? await ctx.db.get(id) : null;
    if (!run || run.userId !== me.userId || run.kind !== "sandbox") throw new Denied();
    return run;
  },
});
