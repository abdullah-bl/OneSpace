import { defineSchema, defineTable } from "onebase/server";
import { v } from "onebase/values";
import { outputsTables } from "./outputsSchema";
import { agentsTables } from "./agentsSchema";

export const userStatus = v.union(v.literal("pending"), v.literal("active"), v.literal("disabled"));
export const memberRole = v.union(v.literal("manager"), v.literal("member"), v.literal("reader"));
export const taskStatus = v.union(v.literal("new"), v.literal("inProgress"), v.literal("review"), v.literal("done"));
export const taskPriority = v.union(v.literal("low"), v.literal("normal"), v.literal("high"), v.literal("urgent"));
// A task link: a file or a Phase 4 artifact, always in the task's own space (tasks.ts).
export const taskLinkType = v.union(v.literal("file"), v.literal("artifact"));
// Where a ranking snapshot came from (lib/records.ts): a CSV/XLSX file version, or one import
// version of a Phase 4 record set. sha256 = the file's / the imported Excel file's hash.
export const snapshotSource = v.union(
  v.object({ kind: v.literal("file"), fileId: v.string(), version: v.number(), name: v.string(), sha256: v.union(v.string(), v.null()) }),
  v.object({ kind: v.literal("records"), recordSetId: v.string(), version: v.number(), name: v.string(), sha256: v.union(v.string(), v.null()) }),
);

export default defineSchema({
  // The built-in auth fields plus OneSpace's account status. A missing status counts as
  // "pending" (fail-closed): only a workspace admin can make an account active.
  users: defineTable({
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    image: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    status: v.optional(userStatus),
    employeeNo: v.optional(v.string()),
    nationalId: v.optional(v.string()), // set by the workspace admin only; my_records matches on it (Phase 4)
  })
    .index("email", ["email"])
    .index("by_status", ["status"])
    .index("by_employeeNo", ["employeeNo"])
    .index("by_nationalId", ["nationalId"]),

  // The single workspace (the department). Its members and their admin|member roles live in
  // the @onebase/teams component under `teamId`.
  workspaces: defineTable({
    teamId: v.string(),
    name: v.string(),
    createdAt: v.number(),
  }).index("by_team", ["teamId"]),

  spaces: defineTable({
    workspaceId: v.id("workspaces"),
    name: v.string(),
    kind: v.union(v.literal("personal"), v.literal("shared")),
    ownerId: v.optional(v.id("users")), // personal spaces only
    everyone: v.boolean(), // every active workspace member is a reader
    sensitive: v.boolean(), // every open/download is audited
    createdBy: v.optional(v.id("users")),
    createdAt: v.number(),
    // Phase 3: the space as a "project". Optional instructions for the agent, edited by a manager.
    instructions: v.optional(v.string()),
    instructionsUpdatedAt: v.optional(v.number()),
  })
    .index("by_owner", ["ownerId"])
    .index("by_workspace_kind", ["workspaceId", "kind"]),

  spaceMembers: defineTable({
    spaceId: v.id("spaces"),
    userId: v.id("users"),
    role: memberRole,
    addedBy: v.optional(v.id("users")),
    addedAt: v.number(),
  })
    .index("by_space_user", ["spaceId", "userId"])
    .index("by_user", ["userId"]),

  files: defineTable({
    spaceId: v.id("spaces"),
    storageId: v.id("_storage"),
    name: v.string(),
    mime: v.string(),
    size: v.number(),
    sha256: v.union(v.string(), v.null()),
    version: v.number(),
    uploadedBy: v.id("users"),
    ingest: v.union(v.literal("pending"), v.literal("processing"), v.literal("ready"), v.literal("failed")),
    status: v.union(v.literal("active"), v.literal("superseded")),
    updatedAt: v.number(),
  })
    .index("by_space", ["spaceId"])
    .index("by_storage", ["storageId"]),

  fileVersions: defineTable({
    fileId: v.id("files"),
    version: v.number(),
    storageId: v.id("_storage"),
    name: v.string(),
    mime: v.string(),
    size: v.number(),
    sha256: v.union(v.string(), v.null()),
    uploadedBy: v.id("users"),
    uploadedAt: v.number(),
  })
    .index("by_file_version", ["fileId", "version"])
    .index("by_storage", ["storageId"]),

  // One-time, short-lived download tickets: a mutation checks access and issues one; the
  // /download HTTP route consumes it and checks access again before streaming the bytes.
  downloadTickets: defineTable({
    tokenHash: v.string(),
    userId: v.id("users"),
    fileId: v.id("files"),
    version: v.optional(v.number()),
    inline: v.boolean(),
    expiresAt: v.number(),
  })
    .index("by_hash", ["tokenHash"])
    .index("by_expiry", ["expiresAt"]),

  // Phase 3: a task lives in one shared space and is assigned to one of its members (manager or
  // member). Links point at things in the same space only (checked when added and again when read).
  // threadId is the chat thread opened for the task (Phase 2); a generic string until chat exists.
  tasks: defineTable({
    spaceId: v.id("spaces"),
    title: v.string(),
    body: v.optional(v.string()),
    createdBy: v.id("users"),
    assigneeId: v.id("users"),
    due: v.optional(v.number()),
    priority: taskPriority,
    status: taskStatus,
    links: v.array(v.object({ type: taskLinkType, id: v.string(), addedBy: v.id("users"), addedAt: v.number() })),
    threadId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    closedAt: v.optional(v.number()),
  })
    .index("by_space", ["spaceId"])
    .index("by_assignee", ["assigneeId"]),

  taskComments: defineTable({
    taskId: v.id("tasks"),
    authorId: v.id("users"),
    body: v.string(),
    createdAt: v.number(),
  }).index("by_task", ["taskId", "createdAt"]),

  // ---- Phase 5: sandbox runs and ranking ----

  // Every sandbox execution and every ranking calculation: what ran, on which inputs (hashes),
  // what came out, with which limits, and how it ended.
  runs: defineTable({
    kind: v.union(v.literal("sandbox"), v.literal("ranking")),
    userId: v.id("users"),
    spaceId: v.id("spaces"), // where the outputs went
    status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
    code: v.optional(v.string()),
    codeHash: v.string(),
    inputs: v.array(v.object({ fileId: v.optional(v.string()), name: v.string(), sha256: v.union(v.string(), v.null()), size: v.number(), spaceId: v.optional(v.id("spaces")) })),
    outputs: v.array(v.object({ fileId: v.string(), name: v.string(), sha256: v.string(), size: v.number() })),
    artifactIds: v.optional(v.array(v.string())), // Phase 4 artifacts created from the outputs (artifactVersions.runId = this run)
    limits: v.optional(v.object({ timeoutMs: v.number(), memoryMb: v.number(), cpus: v.number(), pids: v.number(), outputMb: v.number() })),
    exit: v.optional(
      v.object({
        code: v.union(v.number(), v.null()),
        timedOut: v.boolean(),
        oomKilled: v.boolean(),
        durationMs: v.number(),
        outputTruncated: v.boolean(),
        error: v.optional(v.string()),
      }),
    ),
    stdout: v.optional(v.string()),
    stderr: v.optional(v.string()),
    runtime: v.optional(v.string()),
    threadId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    rankingRunId: v.optional(v.string()),
    createdAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId", "createdAt"])
    .index("by_space", ["spaceId", "createdAt"]),

  // Versioned ranking criteria. A version is edited while draft; once approved it never changes
  // and a change is a new version (same seriesId, version + 1).
  rankingCriteria: defineTable({
    spaceId: v.id("spaces"),
    seriesId: v.string(),
    version: v.number(),
    name: v.string(),
    description: v.optional(v.string()),
    idField: v.string(),
    nameField: v.string(),
    criteria: v.array(
      v.object({
        field: v.string(),
        label: v.string(),
        weight: v.number(),
        direction: v.union(v.literal("desc"), v.literal("asc")),
        min: v.number(),
        max: v.number(),
      }),
    ),
    tieBreak: v.array(v.object({ field: v.string(), direction: v.union(v.literal("desc"), v.literal("asc")) })),
    status: v.union(v.literal("draft"), v.literal("approved")),
    specHash: v.string(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    approvedBy: v.optional(v.id("users")),
    approvedAt: v.optional(v.number()),
  })
    .index("by_space", ["spaceId"])
    .index("by_series", ["seriesId", "version"]),

  // The exact input of a ranking: the parsed table, stored as canonical JSON with its hash.
  rankingSnapshots: defineTable({
    spaceId: v.id("spaces"),
    source: snapshotSource,
    storageId: v.id("_storage"),
    sha256: v.string(),
    fields: v.array(v.string()),
    rowCount: v.number(),
    createdBy: v.id("users"),
    createdAt: v.number(),
  }).index("by_space", ["spaceId"]),

  // draft → approved by a human (space manager). Approved runs are never changed: a correction
  // is a new run (correctsRunId) on the same or a new snapshot/criteria version.
  rankingRuns: defineTable({
    spaceId: v.id("spaces"),
    criteriaId: v.id("rankingCriteria"),
    criteriaVersion: v.number(),
    criteriaHash: v.string(),
    snapshotId: v.id("rankingSnapshots"),
    snapshotHash: v.string(),
    resultsHash: v.string(),
    algorithm: v.string(),
    count: v.number(),
    status: v.union(v.literal("draft"), v.literal("approved")),
    correctsRunId: v.optional(v.id("rankingRuns")),
    createdBy: v.id("users"),
    createdAt: v.number(),
    approvedBy: v.optional(v.id("users")),
    approvedAt: v.optional(v.number()),
  }).index("by_space", ["spaceId", "createdAt"]),

  // One row per student per run: rank, total and the per-criterion breakdown.
  rankingResults: defineTable({
    rankingRunId: v.id("rankingRuns"),
    key: v.string(),
    name: v.string(),
    rank: v.number(),
    total: v.number(),
    breakdown: v.array(
      v.object({
        field: v.string(),
        label: v.string(),
        weight: v.number(),
        direction: v.union(v.literal("desc"), v.literal("asc")),
        min: v.number(),
        max: v.number(),
        raw: v.union(v.string(), v.number(), v.null()),
        value: v.union(v.number(), v.null()),
        normalized: v.number(),
        points: v.number(),
        missing: v.boolean(),
        clamped: v.boolean(),
      }),
    ),
    tieBreak: v.array(v.object({ field: v.string(), direction: v.union(v.literal("desc"), v.literal("asc")), value: v.union(v.number(), v.null()) })),
  })
    .index("by_run_rank", ["rankingRunId", "rank"])
    .index("by_run_key", ["rankingRunId", "key"]),

  // Append-only: nothing in the app patches or deletes these rows.
  auditLog: defineTable({
    at: v.number(),
    userId: v.optional(v.id("users")),
    action: v.string(),
    resourceType: v.string(),
    resourceId: v.optional(v.string()),
    spaceId: v.optional(v.id("spaces")),
    detail: v.optional(v.record(v.string(), v.union(v.string(), v.number(), v.boolean(), v.null()))),
  })
    .index("by_at", ["at"])
    .index("by_space_at", ["spaceId", "at"])
    .index("by_user_at", ["userId", "at"]),

  // Phase 4: artifacts, records, templates, issued documents (see outputsSchema.ts).
  ...outputsTables,

  // Phase 6: agents, their versions, write-tool proposals (see agentsSchema.ts).
  ...agentsTables,

  // ---- Phase 2: RAG and chat ----

  // Ingestion details per file (files.ingest holds the state the file list shows).
  fileIndex: defineTable({
    fileId: v.id("files"),
    spaceId: v.id("spaces"),
    version: v.number(),
    state: v.union(v.literal("pending"), v.literal("processing"), v.literal("ready"), v.literal("failed"), v.literal("skipped")),
    step: v.optional(v.string()), // "extract" | "embed": shown while processing
    error: v.optional(v.string()),
    kind: v.optional(v.string()), // pdf | docx | sheet | text | image | unsupported
    ocr: v.boolean(), // some pages were read by the vision model (lower accuracy)
    ocrPages: v.optional(v.number()),
    pages: v.optional(v.number()),
    chunks: v.optional(v.number()),
    note: v.optional(v.string()),
    workflowId: v.optional(v.string()),
    entryId: v.optional(v.string()), // the rag entry currently holding this file's vectors
    updatedAt: v.number(),
  }).index("by_file", ["fileId"]),

  // The chunks of every indexed file, with a normalized "shadow" copy for Arabic keyword search
  // (the rag component holds the vectors). Searched only with a spaceId filter (= namespace).
  chunks: defineTable({
    fileId: v.id("files"),
    spaceId: v.id("spaces"),
    version: v.number(),
    ordinal: v.number(),
    text: v.string(),
    shadow: v.string(),
    hash: v.string(),
    section: v.optional(v.string()),
    page: v.optional(v.number()),
    pageEnd: v.optional(v.number()),
  })
    .index("by_file", ["fileId", "ordinal"])
    .index("by_file_hash", ["fileId", "hash"])
    .searchIndex("search_shadow", { searchField: "shadow", filterFields: ["spaceId", "fileId"] }),

  // Thread ownership and scope (the agent component doesn't check who owns a thread).
  threadMeta: defineTable({
    threadId: v.string(),
    userId: v.id("users"),
    title: v.string(),
    scope: v.object({ kind: v.union(v.literal("all"), v.literal("space"), v.literal("file")), id: v.optional(v.string()) }),
    agentId: v.optional(v.string()), // Phase 6: the picked agent (none = the default agent)
    taskId: v.optional(v.string()), // Phase 6: opened from a task ("اعمل عليها مع الوكيل")
    test: v.optional(v.boolean()), // an admin's "جرّب الوكيل" run: hidden from the chat list
    agentDraft: v.optional(v.boolean()), // test runs use the agent's unpublished draft
    // UX redesign: a chat started inside a space belongs to it (listed on the space page, scoped
    // to it, with its instructions and file list as context). Still private to its owner.
    spaceId: v.optional(v.id("spaces")),
    titlePending: v.optional(v.boolean()), // the fast model names the chat after its first answer
    scheduleId: v.optional(v.string()), // the results thread of a scheduled task (schedules.ts)
    createdAt: v.number(),
    lastAt: v.number(),
  })
    .index("by_thread", ["threadId"])
    .index("by_user", ["userId", "lastAt"])
    .index("by_user_space", ["userId", "spaceId", "lastAt"]),

  // Structured citations, tool runs and feedback for an assistant message.
  messageMeta: defineTable({
    messageId: v.string(),
    threadId: v.string(),
    userId: v.id("users"),
    citations: v.array(
      v.object({ n: v.number(), fileId: v.string(), fileName: v.string(), page: v.optional(v.number()), section: v.optional(v.string()), quote: v.string() }),
    ),
    toolRuns: v.array(v.object({ name: v.string(), label: v.string(), args: v.any(), ok: v.boolean(), summary: v.string() })),
    abstained: v.boolean(),
    feedback: v.optional(v.union(v.literal("up"), v.literal("down"))),
    usage: v.optional(v.object({ prompt: v.number(), completion: v.number() })),
    ms: v.optional(v.number()),
    agentId: v.optional(v.string()),
    agentVersion: v.optional(v.number()),
  })
    .index("by_message", ["messageId"])
    .index("by_thread", ["threadId"])
    .index("by_feedback", ["feedback"]),

  // One row per question: queued (waiting for a GPU slot) → running → done | failed.
  turns: defineTable({
    threadId: v.string(),
    userId: v.id("users"),
    state: v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("failed")),
    label: v.optional(v.string()), // the running tool's label, e.g. "يبحث في المستندات…"
    agentId: v.optional(v.string()),
    agentVersion: v.optional(v.number()),
    streamId: v.optional(v.string()),
    messageId: v.optional(v.string()),
    error: v.optional(v.string()),
    // @mentions in the question: files/spaces that narrow this turn's scope (never widen it).
    mentions: v.optional(v.array(v.object({ kind: v.union(v.literal("file"), v.literal("space")), id: v.string() }))),
    scheduleId: v.optional(v.string()), // a scheduled run (schedules.ts)
    queuedAt: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_thread", ["threadId", "queuedAt"])
    .index("by_state", ["state", "queuedAt"]),

  // ---- UX redesign: mentions inbox and scheduled tasks ----

  // "@person" in a task comment. Shown in the mentioned person's "الإشارات" list only while they
  // can still view the task (checked on every read, like notifications).
  mentions: defineTable({
    userId: v.id("users"), // who was mentioned
    byId: v.id("users"),
    taskId: v.id("tasks"),
    spaceId: v.id("spaces"),
    commentId: v.id("taskComments"),
    excerpt: v.string(),
    createdAt: v.number(),
    readAt: v.optional(v.number()),
  })
    .index("by_user", ["userId", "createdAt"])
    .index("by_comment", ["commentId"]),

  // A prompt that runs on a recurrence as its creator (permissions re-checked on every run), with
  // an agent and an optional space scope. Results land in the creator's own thread (threadId);
  // write tools only ever become pending proposals there.
  schedules: defineTable({
    userId: v.id("users"),
    title: v.string(),
    prompt: v.string(),
    agentId: v.optional(v.string()),
    spaceId: v.optional(v.id("spaces")),
    recurrence: v.object({
      kind: v.union(v.literal("daily"), v.literal("weekly"), v.literal("monthly"), v.literal("cron")),
      time: v.optional(v.string()), // "HH:MM", workspace time
      weekday: v.optional(v.number()), // 0 = Sunday
      monthDay: v.optional(v.number()), // 1..28
      cron: v.optional(v.string()), // 5 fields, workspace time
    }),
    enabled: v.boolean(),
    stoppedReason: v.optional(v.string()),
    nextRunAt: v.number(),
    lastRunAt: v.optional(v.number()),
    lastTurnId: v.optional(v.string()),
    lastStatus: v.optional(v.union(v.literal("running"), v.literal("done"), v.literal("failed"))),
    runs: v.number(),
    threadId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId", "createdAt"])
    .index("by_due", ["enabled", "nextRunAt"]),

  aiSettings: defineTable({ key: v.string(), value: v.any(), updatedAt: v.number() }).index("by_key", ["key"]),
});
