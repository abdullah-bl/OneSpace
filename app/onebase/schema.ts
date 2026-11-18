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
    agentId: v.optional(v.string()),
    taskId: v.optional(v.string()),
    createdAt: v.number(),
    lastAt: v.number(),
  })
    .index("by_thread", ["threadId"])
    .index("by_user", ["userId", "lastAt"]),

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
    streamId: v.optional(v.string()),
    messageId: v.optional(v.string()),
    error: v.optional(v.string()),
    queuedAt: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_thread", ["threadId", "queuedAt"])
    .index("by_state", ["state", "queuedAt"]),

  aiSettings: defineTable({ key: v.string(), value: v.any(), updatedAt: v.number() }).index("by_key", ["key"]),
});
