// Phase 4 tables (outputs, records, templates, official documents), spread into schema.ts.
// Kept in their own file so the phases' schema edits don't collide.

import { defineTable } from "onebase/server";
import { v } from "onebase/values";

export const cellValue = v.union(v.string(), v.number(), v.boolean(), v.null());
export const artifactKind = v.union(v.literal("markdown"), v.literal("html"), v.literal("table"));
export const subjectKind = v.union(v.literal("nationalId"), v.literal("employeeNo"));
export const columnType = v.union(v.literal("text"), v.literal("number"), v.literal("date"), v.literal("boolean"));
export const columnDef = v.object({ key: v.string(), header: v.string(), type: columnType, required: v.boolean() });
export const artifactSource = v.object({
  type: v.union(v.literal("file"), v.literal("recordSet"), v.literal("artifact")),
  id: v.string(),
  spaceId: v.id("spaces"),
});

export const outputsTables = {
  // Generated outputs (side panel). Each lives in one space: the space of its sources, or the
  // owner's personal space. classification "sensitive" = built on a sensitive space; it only
  // leaves that space (originSpaceId) through a transfer approved by that space's manager.
  artifacts: defineTable({
    spaceId: v.id("spaces"),
    ownerId: v.id("users"),
    kind: artifactKind,
    title: v.string(),
    currentVersion: v.number(),
    sourceThreadId: v.optional(v.string()),
    sources: v.array(artifactSource),
    classification: v.union(v.literal("normal"), v.literal("sensitive")),
    originSpaceId: v.optional(v.id("spaces")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_space", ["spaceId"])
    .index("by_owner", ["ownerId"]),

  // Content is kept inline (markdown/html text, or a JSON table) so queries can return it
  // without handing out storage ids; sha256 fingerprints each version.
  artifactVersions: defineTable({
    artifactId: v.id("artifacts"),
    version: v.number(),
    content: v.string(),
    sha256: v.string(),
    size: v.number(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    runId: v.optional(v.string()),
    note: v.optional(v.string()),
  }).index("by_artifact_version", ["artifactId", "version"]),

  // A request to move a sensitive-sourced artifact out of its origin space. Only a manager of
  // the origin space decides it.
  artifactTransfers: defineTable({
    artifactId: v.id("artifacts"),
    fromSpaceId: v.id("spaces"),
    toSpaceId: v.id("spaces"),
    requestedBy: v.id("users"),
    requestedAt: v.number(),
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected")),
    decidedBy: v.optional(v.id("users")),
    decidedAt: v.optional(v.number()),
  })
    .index("by_from_status", ["fromSpaceId", "status"])
    .index("by_artifact", ["artifactId"]),

  // Structured records (trainees, courses, grades): typed columns defined by the space manager.
  // Rows are real rows, not text chunks. subjectColumn holds the national id or employee number
  // that links a row to its subject's account (set on the account by the workspace admin).
  recordSets: defineTable({
    workspaceId: v.id("workspaces"),
    spaceId: v.id("spaces"),
    name: v.string(),
    columns: v.array(columnDef),
    subjectColumn: v.string(),
    subjectKind,
    uniqueBy: v.array(v.string()),
    currentVersion: v.number(), // 0 = nothing imported yet
    createdBy: v.id("users"),
    createdAt: v.number(),
  }).index("by_space", ["spaceId"]),

  // One row per import: a dated version. The source is pluggable ("excel" now, an existing
  // system later; see recordSources.ts).
  recordImports: defineTable({
    recordSetId: v.id("recordSets"),
    spaceId: v.id("spaces"),
    version: v.number(),
    source: v.object({ kind: v.string(), name: v.string(), sha256: v.string(), storageId: v.optional(v.id("_storage")) }),
    rowCount: v.number(),
    importedBy: v.id("users"),
    importedAt: v.number(),
  }).index("by_set_version", ["recordSetId", "version"]),

  records: defineTable({
    recordSetId: v.id("recordSets"),
    spaceId: v.id("spaces"),
    version: v.number(),
    rowNo: v.number(),
    subjectRef: v.string(),
    data: v.record(v.string(), cellValue),
  })
    .index("by_set_version", ["recordSetId", "version"])
    .index("by_subject", ["subjectRef"]),

  // Official document templates: a fixed layout (+ optional fixed background PDF), a fields
  // schema, and a binding of each field to a record-set column. Every edit is a new version;
  // only the approved version can be used.
  templates: defineTable({
    workspaceId: v.id("workspaces"),
    spaceId: v.id("spaces"),
    name: v.string(),
    kind: v.literal("certificate"),
    currentVersion: v.number(),
    approvedVersion: v.optional(v.number()),
    createdBy: v.id("users"),
    createdAt: v.number(),
  }).index("by_space", ["spaceId"]),

  templateVersions: defineTable({
    templateId: v.id("templates"),
    version: v.number(),
    layout: v.string(), // JSON, see pdf.ts (TemplateLayout)
    bodyStorageId: v.optional(v.id("_storage")), // fixed background PDF (a private copy of the bytes)
    bodySha256: v.optional(v.string()),
    fieldsSchema: v.array(v.object({ key: v.string(), label: v.string() })),
    dataBinding: v.object({ recordSetId: v.id("recordSets"), fields: v.record(v.string(), v.string()) }),
    sha256: v.string(), // fingerprint of the whole definition
    createdBy: v.id("users"),
    createdAt: v.number(),
    approvedBy: v.optional(v.id("users")),
    approvedAt: v.optional(v.number()),
  }).index("by_template_version", ["templateId", "version"]),

  // draft (data snapshot taken from the record by code) -> approved (a space manager)
  // -> issued (serial, verification code, sha256 of the rendered PDF). Or rejected.
  issuedDocuments: defineTable({
    workspaceId: v.id("workspaces"),
    spaceId: v.id("spaces"),
    templateId: v.id("templates"),
    templateVersion: v.number(),
    recordSetId: v.id("recordSets"),
    recordId: v.id("records"),
    recordVersion: v.number(),
    subjectKind,
    subjectRef: v.string(),
    data: v.record(v.string(), v.string()),
    dataHash: v.string(),
    status: v.union(v.literal("draft"), v.literal("approved"), v.literal("issued"), v.literal("rejected")),
    requestedBy: v.id("users"),
    requestedAt: v.number(),
    threadId: v.optional(v.string()),
    approvedBy: v.optional(v.id("users")),
    approvedAt: v.optional(v.number()),
    rejectedBy: v.optional(v.id("users")),
    issuedBy: v.optional(v.id("users")),
    issuedAt: v.optional(v.number()),
    serial: v.optional(v.string()),
    serialNo: v.optional(v.number()),
    verifyCode: v.optional(v.string()),
    sha256: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    size: v.optional(v.number()),
  })
    .index("by_space", ["spaceId"])
    .index("by_key", ["templateId", "templateVersion", "recordId", "dataHash"])
    .index("by_subject", ["subjectRef"])
    .index("by_code", ["verifyCode"])
    .index("by_sha256", ["sha256"])
    .index("by_serialNo", ["serialNo"]),

  // One-time download tickets for issued documents (same scheme as downloadTickets).
  documentTickets: defineTable({
    tokenHash: v.string(),
    userId: v.id("users"),
    documentId: v.id("issuedDocuments"),
    expiresAt: v.number(),
  })
    .index("by_hash", ["tokenHash"])
    .index("by_expiry", ["expiresAt"]),
};
