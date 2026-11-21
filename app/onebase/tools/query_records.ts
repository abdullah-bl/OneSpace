import { internal } from "../_generated/api";
import type { AppTool } from "./types";

/** A row as { column header: value }, in the set's column order. */
export function byHeader(columns: { key: string; header: string }[], data: Record<string, unknown>) {
  return Object.fromEntries(columns.map((c) => [c.header, data[c.key] ?? null]));
}

type Args = { recordSetId?: string; subjectRef?: string; filters?: Record<string, string | number | boolean>; limit?: number };

/**
 * Structured records for members of the records' space (any person in them). Someone who is not
 * a member gets nothing, whatever the arguments: the check is on the user, not on the request.
 * Goes through records.queryRecords, the one query path (a second source plugs in behind it).
 */
export const query_records: AppTool<Args> = {
  name: "query_records",
  label: "يستعلم في السجلات…",
  description:
    "Query structured records (trainees, courses, grades…) in record sets of spaces the user is a member of. " +
    "Filter by record set, by a person's national id / employee number (subjectRef), or by column values. " +
    "For the user's own records use my_records instead.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      recordSetId: { type: "string" },
      subjectRef: { type: "string", description: "National id or employee number of the person to look up." },
      filters: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] }, description: "column header -> value (text matches by substring)." },
      limit: { type: "number", minimum: 1, maximum: 200 },
    },
  },
  async run(t, args) {
    const filters = args.filters && typeof args.filters === "object" ? args.filters : undefined;
    const r = await t.ctx.runMutation(internal.records.queryForUser, {
      userId: t.userId,
      scopeSpaceIds: t.scopeSpaceIds,
      recordSetId: args.recordSetId ? String(args.recordSetId) : undefined,
      subjectRef: args.subjectRef ? String(args.subjectRef) : undefined,
      filters,
      limit: typeof args.limit === "number" ? args.limit : undefined,
    });
    if (r.sets.length === 0) return { content: "لا توجد سجلات متاحة لك في نطاق هذه المحادثة.", spaceIds: [] };
    // Rows by column header: keys of sets created from a file are generated (c1, c2…) and mean nothing to the model.
    return {
      content: JSON.stringify(
        r.sets.map((s) => ({
          recordSetId: s.recordSetId,
          name: s.setName,
          version: s.version,
          columns: s.columns.map((c) => ({ header: c.header, type: c.type })),
          total: s.total,
          rows: s.rows.map((row) => ({ recordId: row.recordId, rowNo: row.rowNo, data: byHeader(s.columns, row.data) })),
        })),
      ),
      spaceIds: [...new Set(r.sets.map((s) => s.spaceId))],
    };
  },
};
