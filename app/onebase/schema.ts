import { defineSchema, defineTable } from "onebase/server";
import { v } from "onebase/values";

export const userStatus = v.union(v.literal("pending"), v.literal("active"), v.literal("disabled"));
export const memberRole = v.union(v.literal("manager"), v.literal("member"), v.literal("reader"));

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
  })
    .index("email", ["email"])
    .index("by_status", ["status"]),

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
    source: v.object({ kind: v.literal("file"), fileId: v.string(), version: v.number(), name: v.string(), sha256: v.union(v.string(), v.null()) }),
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
});
