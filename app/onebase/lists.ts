// «القوائم» (plans/10): live tables in a space, like a Notion database. A list has typed columns
// (text, number, date, status, select, person, check) and rows edited in place. The assistant
// builds and updates them in a chat (tools/create_list, update_list, read_list), so «رتّب مهامي»
// gives a list to tick off and come back to, not a static table.
//
// Access is the space's: read → see it; write (owner of a personal space, a member or manager of a
// shared one) → edit rows and columns, create lists; deleting a list: its creator or a manager.
// Every lookup answers "not found" alike for missing and forbidden.

import { OneBaseError, v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { assertCan, currentSpaceRole, Denied, readableSpaceIds, requireActive, roleAllows } from "./access";
import { writeAudit } from "./audit";
import { maskSecrets } from "./lib/secrets";

type Ctx = QueryCtx | MutationCtx;
export type ColumnType = Doc<"lists">["columns"][number]["type"];
type Column = Doc<"lists">["columns"][number];
type Cell = string | number | boolean | null;

export const COLUMN_TYPES: ColumnType[] = ["text", "number", "date", "status", "select", "person", "check"];
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 500;
const COLUMN_NAME_MAX = 60;
const MAX_COLUMNS = 20;
const MAX_OPTIONS = 30;
const CELL_MAX = 2000;
export const MAX_ROWS = 2000;
const MAX_LISTS_PER_SPACE = 200;
export const DEFAULT_STATUS = ["لم تبدأ", "قيد التنفيذ", "منجزة"];
const DONE_RE = /^(منجزة|منجز|تم|مكتملة|مكتمل|done|completed?)$/i;

// ---------------------------------------------------------------- access

async function readList(ctx: Ctx, userId: Id<"users">, listId: string) {
  const id = ctx.db.normalizeId("lists", listId);
  const list = id ? await ctx.db.get(id) : null;
  if (!list) throw new Denied();
  const { space, role } = await assertCan(ctx, userId, list.spaceId, "read");
  return { list, space, role, canWrite: roleAllows(role, "write"), canDelete: list.ownerId === userId || role === "owner" || role === "manager" };
}

async function writeList(ctx: Ctx, userId: Id<"users">, listId: string) {
  const r = await readList(ctx, userId, listId);
  if (!r.canWrite) throw new Denied();
  return r;
}

async function rowOf(ctx: Ctx, userId: Id<"users">, rowId: string) {
  const id = ctx.db.normalizeId("listRows", rowId);
  const row = id ? await ctx.db.get(id) : null;
  if (!row) throw new Denied();
  return { row, ...(await writeList(ctx, userId, row.listId)) };
}

/** Who a person cell may name: the people who can read the space (a personal space: its owner). */
async function peopleOf(ctx: Ctx, space: Doc<"spaces">) {
  const ids: Id<"users">[] = space.kind === "personal" ? [space.ownerId!] : (await ctx.db.query("spaceMembers").withIndex("by_space_user", (q) => q.eq("spaceId", space._id)).collect()).map((m) => m.userId);
  const out: { userId: string; name: string }[] = [];
  for (const id of ids) {
    if (!id) continue;
    if (space.kind !== "personal" && !(await currentSpaceRole(ctx, id, space))) continue;
    const u = await ctx.db.get(id);
    if (u) out.push({ userId: id, name: u.name ?? u.email ?? "" });
  }
  return out;
}

// ---------------------------------------------------------------- cleaning

function cleanTitle(t: unknown) {
  const s = String(t ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, TITLE_MAX);
  if (!s) throw new OneBaseError("اكتب اسماً للقائمة");
  return s;
}

/** Columns as sent (keys kept for existing ones, new ones get the next key). */
function cleanColumns(cols: { key?: string; name: string; type: string; options?: string[] }[], nextKey: number) {
  if (!Array.isArray(cols) || !cols.length) throw new OneBaseError("القائمة تحتاج عموداً واحداً على الأقل");
  if (cols.length > MAX_COLUMNS) throw new OneBaseError(`الحد ${MAX_COLUMNS} عموداً`);
  const seen = new Set<string>();
  const out: Column[] = [];
  for (const c of cols) {
    const name = String(c?.name ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, COLUMN_NAME_MAX);
    if (!name) throw new OneBaseError("عمود بلا اسم");
    if (seen.has(name)) throw new OneBaseError(`عمودان باسم «${name}»`);
    seen.add(name);
    const type = (COLUMN_TYPES.includes(c.type as ColumnType) ? c.type : "text") as ColumnType;
    let key = typeof c.key === "string" && /^c\d+$/.test(c.key) ? c.key : "";
    if (!key) key = `c${nextKey++}`;
    const col: Column = { key, name, type };
    if (type === "status" || type === "select") {
      const opts = [...new Set((c.options ?? []).map((o) => String(o).trim().slice(0, 60)).filter(Boolean))].slice(0, MAX_OPTIONS);
      col.options = opts.length ? opts : type === "status" ? DEFAULT_STATUS : [];
    }
    out.push(col);
  }
  if (new Set(out.map((c) => c.key)).size !== out.length) throw new OneBaseError("مفاتيح الأعمدة مكررة");
  return { columns: out, nextKey };
}

const toDigits = (s: string) => s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[٫]/g, ".").replace(/[٬,]/g, "");

/**
 * One cell, checked against its column. `grow`: a status/select value not in the options is added
 * (the assistant's path); otherwise it is refused. Person cells take a user id or a name of
 * someone who can read the space.
 */
function cleanCell(col: Column, raw: unknown, people: { userId: string; name: string }[], grow: boolean): Cell {
  if (raw === null || raw === undefined || raw === "") return null;
  switch (col.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(toDigits(String(raw).trim()));
      if (!Number.isFinite(n)) throw new OneBaseError(`«${col.name}» يقبل أرقاماً فقط`);
      return n;
    }
    case "check":
      return raw === true || raw === "true" || raw === 1 || raw === "1" || raw === "نعم" || raw === "✓";
    case "date": {
      const s = toDigits(String(raw).trim()).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new OneBaseError(`«${col.name}»: التاريخ بصيغة YYYY-MM-DD`);
      return s;
    }
    case "status":
    case "select": {
      const s = String(raw).trim().slice(0, 60);
      if (col.options?.includes(s)) return s;
      if (!grow) throw new OneBaseError(`«${s}» ليست من خيارات «${col.name}»`);
      if ((col.options?.length ?? 0) >= MAX_OPTIONS) throw new OneBaseError(`«${col.name}»: الحد ${MAX_OPTIONS} خياراً`);
      col.options = [...(col.options ?? []), s];
      return s;
    }
    case "person": {
      const s = String(raw).trim();
      const partial = s.length >= 2 ? people.filter((p) => p.name.includes(s)) : [];
      const hit = people.find((p) => p.userId === s) ?? people.find((p) => p.name === s) ?? (partial.length === 1 ? partial[0] : undefined);
      if (!hit && partial.length > 1) throw new OneBaseError(`«${s}» يطابق أكثر من شخص: ${partial.map((p) => p.name).join("، ")}`);
      if (!hit) throw new OneBaseError(`«${s}» ليس ممن يرون هذه المساحة`);
      return hit.userId;
    }
    default:
      return maskSecrets(String(raw).replace(/\u0000/g, "")).slice(0, CELL_MAX);
  }
}

/** Cells keyed by column key (the UI) or by column name (the assistant). Unknown columns are refused. */
function cleanCells(columns: Column[], cells: Record<string, unknown>, people: { userId: string; name: string }[], grow: boolean) {
  const out: Record<string, Cell> = {};
  for (const [k, raw] of Object.entries(cells ?? {})) {
    const col = columns.find((c) => c.key === k) ?? columns.find((c) => c.name === k);
    if (!col) throw new OneBaseError(`لا يوجد عمود «${k}». الأعمدة: ${columns.map((c) => c.name).join("، ")}`);
    out[col.key] = cleanCell(col, raw, people, grow);
  }
  return out;
}

async function touch(ctx: MutationCtx, list: Doc<"lists">, patch: Partial<Doc<"lists">> = {}) {
  await ctx.db.patch(list._id, { ...patch, updatedAt: Date.now() });
}

async function rowsOf(ctx: Ctx, listId: Id<"lists">) {
  return ctx.db.query("listRows").withIndex("by_list", (q) => q.eq("listId", listId)).collect();
}

function summary(l: Doc<"lists">) {
  return { _id: l._id, title: l.title, description: l.description ?? "", rowCount: l.rowCount, updatedAt: l.updatedAt, spaceId: l.spaceId };
}

// ---------------------------------------------------------------- core (UI and tools share these)

async function insertList(
  ctx: MutationCtx,
  userId: Id<"users">,
  spaceId: string,
  a: { title: string; description?: string; columns?: { key?: string; name: string; type: string; options?: string[] }[]; rows?: Record<string, unknown>[]; sourceThreadId?: string; grow?: boolean },
) {
  const { space } = await assertCan(ctx, userId, spaceId, "write");
  const count = (await ctx.db.query("lists").withIndex("by_space", (q) => q.eq("spaceId", space._id)).collect()).length;
  if (count >= MAX_LISTS_PER_SPACE) throw new OneBaseError(`الحد ${MAX_LISTS_PER_SPACE} قائمة في المساحة`);
  const cols = a.columns?.length ? a.columns : [{ name: "المهمة", type: "text" }, { name: "الحالة", type: "status" }, { name: "الموعد", type: "date" }];
  const { columns, nextKey } = cleanColumns(cols, 1);
  const rows = (a.rows ?? []).slice(0, MAX_ROWS);
  const people = rows.length ? await peopleOf(ctx, space) : [];
  const cleaned = rows.map((r) => cleanCells(columns, r, people, a.grow ?? false)); // may grow options before insert
  const now = Date.now();
  const id = await ctx.db.insert("lists", {
    spaceId: space._id,
    ownerId: userId,
    title: cleanTitle(a.title),
    ...(a.description?.trim() ? { description: a.description.trim().slice(0, DESCRIPTION_MAX) } : {}),
    columns,
    view: "table",
    nextKey,
    rowCount: cleaned.length,
    ...(a.sourceThreadId ? { sourceThreadId: a.sourceThreadId } : {}),
    createdAt: now,
    updatedAt: now,
  });
  const rowIds: string[] = [];
  for (const [i, cells] of cleaned.entries()) rowIds.push(await ctx.db.insert("listRows", { listId: id, cells, order: i + 1, createdBy: userId, updatedBy: userId, createdAt: now, updatedAt: now }));
  await writeAudit(ctx, { userId, action: "list.create", resourceType: "list", resourceId: id, spaceId: space._id, detail: { rows: cleaned.length } });
  return { id, space, rowIds };
}

async function deleteList(ctx: MutationCtx, userId: Id<"users">, list: Doc<"lists">, via?: string) {
  for (const r of await rowsOf(ctx, list._id)) await ctx.db.delete(r._id);
  // A published page whose form wrote to this list loses the form (plans/11); the page stays.
  for (const p of await ctx.db.query("publications").withIndex("by_space", (q) => q.eq("spaceId", list.spaceId)).collect()) {
    if (p.form?.listId === list._id) await ctx.db.patch(p._id, { form: undefined, updatedAt: Date.now() });
  }
  await ctx.db.delete(list._id);
  await writeAudit(ctx, { userId, action: "list.delete", resourceType: "list", resourceId: list._id, spaceId: list.spaceId, detail: { title: list.title, via: via ?? null } });
}

type Change = {
  add?: Record<string, unknown>[];
  update?: { rowId: string; cells: Record<string, unknown> }[];
  remove?: string[];
};

/** Rows added, changed and removed in one go; returns what «تراجع» needs to put it back. */
async function applyChanges(ctx: MutationCtx, userId: Id<"users">, list: Doc<"lists">, space: Doc<"spaces">, c: Change, grow: boolean) {
  const columns = list.columns.map((x) => ({ ...x, options: x.options ? [...x.options] : undefined }));
  const people = await peopleOf(ctx, space);
  const rows = await rowsOf(ctx, list._id);
  const byId = new Map(rows.map((r) => [r._id as string, r]));
  const now = Date.now();
  const added: string[] = [];
  const restore: { rowId?: string; cells: Record<string, Cell>; order: number }[] = [];
  let count = rows.length;
  for (const u of c.update ?? []) {
    const row = byId.get(String(u.rowId));
    if (!row) throw new OneBaseError(`لا يوجد صف ${u.rowId} في «${list.title}»`);
    const cells = cleanCells(columns, u.cells ?? {}, people, grow);
    restore.push({ rowId: row._id, cells: row.cells, order: row.order });
    await ctx.db.patch(row._id, { cells: { ...row.cells, ...cells }, updatedBy: userId, updatedAt: now });
  }
  for (const id of c.remove ?? []) {
    const row = byId.get(String(id));
    if (!row) throw new OneBaseError(`لا يوجد صف ${id} في «${list.title}»`);
    restore.push({ cells: row.cells, order: row.order });
    await ctx.db.delete(row._id);
    count--;
  }
  let order = rows.reduce((m, r) => Math.max(m, r.order), 0);
  for (const cellsIn of c.add ?? []) {
    if (count >= MAX_ROWS) throw new OneBaseError(`الحد ${MAX_ROWS} صف للقائمة`);
    const cells = cleanCells(columns, cellsIn ?? {}, people, grow);
    added.push(await ctx.db.insert("listRows", { listId: list._id, cells, order: ++order, createdBy: userId, updatedBy: userId, createdAt: now, updatedAt: now }));
    count++;
  }
  const grew = JSON.stringify(columns) !== JSON.stringify(list.columns);
  await touch(ctx, list, { rowCount: count, ...(grew ? { columns } : {}) });
  return { added, restore };
}

/**
 * A form reply (publications.ts): one row added as `userId`, who may not be able to write in the
 * list's space. The caller has checked the reader and the form; cells only of the form's columns.
 */
export async function appendFromForm(ctx: MutationCtx, listId: Id<"lists">, cells: Record<string, unknown>, userId: Id<"users">, senderKey?: string) {
  const list = await ctx.db.get(listId);
  if (!list) throw new OneBaseError("القائمة المرتبطة بالنموذج حُذفت");
  const space = await ctx.db.get(list.spaceId);
  if (!space) throw new OneBaseError("القائمة المرتبطة بالنموذج حُذفت");
  const rowId = (await applyChanges(ctx, userId, list, space, { add: [cells] }, false)).added[0]!;
  // The sender may be someone outside the list's space (a workspace page): set as is, not checked
  // against the space's people like a typed person cell.
  if (senderKey && list.columns.some((c) => c.key === senderKey && c.type === "person")) {
    const row = await ctx.db.get(rowId as Id<"listRows">);
    if (row) await ctx.db.patch(row._id, { cells: { ...row.cells, [senderKey]: userId } });
  }
  return rowId;
}

/** Adds a column (the form's «المرسل») if the list has none of that name and type; returns its key. */
export async function ensureColumn(ctx: MutationCtx, list: Doc<"lists">, name: string, type: ColumnType) {
  const hit = list.columns.find((c) => c.name === name && c.type === type);
  if (hit) return hit.key;
  const { columns, nextKey } = cleanColumns([...list.columns, { name: list.columns.some((c) => c.name === name) ? `${name} (النموذج)` : name, type }], list.nextKey);
  await touch(ctx, list, { columns, nextKey });
  return columns.at(-1)!.key;
}

export { cleanCells as cleanListCells, peopleOf as listPeople };

// ---------------------------------------------------------------- queries

export const forSpace = query({
  args: { spaceId: v.string() },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    const { space, role } = await assertCan(ctx, me.userId, spaceId, "read");
    const rows = await ctx.db.query("lists").withIndex("by_space", (q) => q.eq("spaceId", space._id)).order("desc").collect();
    return { canWrite: roleAllows(role, "write"), lists: rows.map(summary) };
  },
});

/** «القوائم»: every list I can read, most recently changed first. */
export const recent = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireActive(ctx);
    const out: (ReturnType<typeof summary> & { spaceName: string; personal: boolean })[] = [];
    for (const sid of await readableSpaceIds(ctx, me.userId)) {
      const space = await ctx.db.get(sid);
      if (!space) continue;
      const rows = await ctx.db.query("lists").withIndex("by_space", (q) => q.eq("spaceId", sid)).order("desc").take(100);
      for (const l of rows) out.push({ ...summary(l), spaceName: space.kind === "personal" ? "مساحتي" : space.name, personal: space.kind === "personal" });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200);
  },
});

/** The space's people, plus anyone a person cell names who isn't one of them (a form's sender). */
async function withSenders(ctx: Ctx, people: { userId: string; name: string }[], list: Doc<"lists">, rows: Doc<"listRows">[]) {
  const known = new Set(people.map((p) => p.userId));
  const keys = list.columns.filter((c) => c.type === "person").map((c) => c.key);
  const out = [...people];
  for (const r of rows)
    for (const k of keys) {
      const id = r.cells[k];
      if (typeof id !== "string" || known.has(id)) continue;
      known.add(id);
      const nid = ctx.db.normalizeId("users", id);
      const u = nid ? await ctx.db.get(nid) : null;
      if (u) out.push({ userId: id, name: u.name ?? u.email ?? "" });
    }
  return out;
}

export const get = query({
  args: { listId: v.string() },
  handler: async (ctx, { listId }) => {
    const me = await requireActive(ctx);
    const { list, space, canWrite, canDelete } = await readList(ctx, me.userId, listId);
    const rows = await rowsOf(ctx, list._id);
    return {
      list: { _id: list._id, title: list.title, description: list.description ?? "", columns: list.columns, view: list.view, updatedAt: list.updatedAt },
      rows: rows.map((r) => ({ _id: r._id, cells: r.cells, order: r.order })),
      space: { _id: space._id, name: space.kind === "personal" ? "مساحتي" : space.name, personal: space.kind === "personal" },
      people: await withSenders(ctx, await peopleOf(ctx, space), list, rows),
      canWrite,
      canDelete,
    };
  },
});

// ---------------------------------------------------------------- mutations (the list page)

const columnInput = v.object({ key: v.optional(v.string()), name: v.string(), type: v.string(), options: v.optional(v.array(v.string())) });

export const create = mutation({
  args: { spaceId: v.string(), title: v.string(), description: v.optional(v.string()), columns: v.optional(v.array(columnInput)) },
  handler: async (ctx, a) => {
    const me = await requireActive(ctx);
    return (await insertList(ctx, me.userId, a.spaceId, a)).id;
  },
});

export const updateMeta = mutation({
  args: { listId: v.string(), title: v.optional(v.string()), description: v.optional(v.string()), view: v.optional(v.union(v.literal("table"), v.literal("board"))) },
  handler: async (ctx, a) => {
    const me = await requireActive(ctx);
    const { list } = await writeList(ctx, me.userId, a.listId);
    await touch(ctx, list, {
      ...(a.title !== undefined ? { title: cleanTitle(a.title) } : {}),
      ...(a.description !== undefined ? { description: a.description.trim().slice(0, DESCRIPTION_MAX) } : {}),
      ...(a.view ? { view: a.view } : {}),
    });
  },
});

/** The whole column set (rename, retype, reorder, add, drop). Values of a dropped column are cleared. */
export const setColumns = mutation({
  args: { listId: v.string(), columns: v.array(columnInput) },
  handler: async (ctx, { listId, columns: input }) => {
    const me = await requireActive(ctx);
    const { list } = await writeList(ctx, me.userId, listId);
    const { columns, nextKey } = cleanColumns(input, list.nextKey);
    const before = new Map(list.columns.map((c) => [c.key, c]));
    const keys = new Set(columns.map((c) => c.key));
    // A changed type or a dropped column: clear the values that no longer fit.
    const stale = list.columns.filter((c) => !keys.has(c.key) || before.get(c.key)!.type !== columns.find((x) => x.key === c.key)!.type).map((c) => c.key);
    if (stale.length) {
      for (const r of await rowsOf(ctx, list._id)) {
        if (!stale.some((k) => k in r.cells)) continue;
        const cells = { ...r.cells };
        for (const k of stale) delete cells[k];
        await ctx.db.patch(r._id, { cells });
      }
    }
    await touch(ctx, list, { columns, nextKey });
    await writeAudit(ctx, { userId: me.userId, action: "list.columns", resourceType: "list", resourceId: list._id, spaceId: list.spaceId, detail: { columns: columns.length } });
  },
});

export const remove = mutation({
  args: { listId: v.string() },
  handler: async (ctx, { listId }) => {
    const me = await requireActive(ctx);
    const { list, canDelete } = await readList(ctx, me.userId, listId);
    if (!canDelete) throw new Denied();
    await deleteList(ctx, me.userId, list);
  },
});

export const addRow = mutation({
  args: { listId: v.string(), cells: v.optional(v.record(v.string(), v.any())) },
  handler: async (ctx, { listId, cells }) => {
    const me = await requireActive(ctx);
    const { list, space } = await writeList(ctx, me.userId, listId);
    return (await applyChanges(ctx, me.userId, list, space, { add: [cells ?? {}] }, false)).added[0];
  },
});

export const updateRow = mutation({
  args: { rowId: v.string(), cells: v.record(v.string(), v.any()) },
  handler: async (ctx, { rowId, cells }) => {
    const me = await requireActive(ctx);
    const { row, list, space } = await rowOf(ctx, me.userId, rowId);
    await applyChanges(ctx, me.userId, list, space, { update: [{ rowId: row._id, cells }] }, false);
  },
});

export const removeRow = mutation({
  args: { rowId: v.string() },
  handler: async (ctx, { rowId }) => {
    const me = await requireActive(ctx);
    const { row, list, space } = await rowOf(ctx, me.userId, rowId);
    await applyChanges(ctx, me.userId, list, space, { remove: [row._id] }, false);
  },
});

// ---------------------------------------------------------------- the assistant's tools

/** Where a new list goes: the chat's space if it is in scope and writable, else my personal space. */
async function placeFor(ctx: Ctx, userId: Id<"users">, threadId: string | undefined, scopeSpaceIds: string[]) {
  if (threadId) {
    const meta = await ctx.db.query("threadMeta").withIndex("by_thread", (q) => q.eq("threadId", threadId)).unique();
    const here = meta && meta.userId === userId ? (meta.spaceId ?? (meta.scope.kind === "space" && meta.scope.id ? ctx.db.normalizeId("spaces", meta.scope.id) : null)) : null;
    if (here && scopeSpaceIds.includes(here)) {
      try {
        return (await assertCan(ctx, userId, here, "write")).space;
      } catch {
        // not writable here: fall back to the personal space
      }
    }
  }
  const personal = (await ctx.db.query("spaces").withIndex("by_owner", (q) => q.eq("ownerId", userId)).collect()).find((s) => s.kind === "personal");
  if (!personal) throw new OneBaseError("لا توجد مساحة خاصة");
  return personal;
}

/** Tier for create_list (tiers.ts): where it will land. */
export async function placeForTier(ctx: QueryCtx, userId: Id<"users">, threadId: string | undefined, scopeSpaceIds: string[]) {
  return placeFor(ctx, userId, threadId, scopeSpaceIds);
}

/** A list the tool may touch: in this turn's scope, and readable (writable when `write`). */
async function toolList(ctx: Ctx, userId: Id<"users">, listId: string, scopeSpaceIds: string[], write: boolean) {
  const r = write ? await writeList(ctx, userId, listId) : await readList(ctx, userId, listId);
  if (!scopeSpaceIds.includes(r.list.spaceId)) throw new Denied();
  return r;
}

const tryTool = async <T>(f: () => Promise<T>) => {
  try {
    return { ok: true as const, ...(await f()) };
  } catch (e) {
    return { ok: false as const, error: e instanceof Denied ? "القائمة غير موجودة أو لا تملك تعديلها" : e instanceof Error ? e.message : String(e) };
  }
};

export const createFromTool = internalMutation({
  args: {
    userId: v.id("users"),
    threadId: v.optional(v.string()),
    scopeSpaceIds: v.array(v.string()),
    title: v.string(),
    description: v.optional(v.string()),
    columns: v.array(v.object({ name: v.string(), type: v.string(), options: v.optional(v.array(v.string())) })),
    rows: v.array(v.record(v.string(), v.any())),
  },
  handler: async (ctx, a) =>
    tryTool(async () => {
      const target = await placeFor(ctx, a.userId, a.threadId, a.scopeSpaceIds);
      const r = await insertList(ctx, a.userId, target._id, { ...a, sourceThreadId: a.threadId, grow: true });
      return { id: r.id as string, spaceId: target._id as string, spaceName: target.kind === "personal" ? "مساحتي" : target.name, rows: r.rowIds.length };
    }),
});

export const updateFromTool = internalMutation({
  args: {
    userId: v.id("users"),
    scopeSpaceIds: v.array(v.string()),
    listId: v.string(),
    add: v.optional(v.array(v.record(v.string(), v.any()))),
    update: v.optional(v.array(v.object({ rowId: v.string(), cells: v.record(v.string(), v.any()) }))),
    remove: v.optional(v.array(v.string())),
  },
  handler: async (ctx, a) =>
    tryTool(async () => {
      const { list, space } = await toolList(ctx, a.userId, a.listId, a.scopeSpaceIds, true);
      const r = await applyChanges(ctx, a.userId, list, space, a, true);
      return { id: list._id as string, title: list.title, spaceId: list.spaceId as string, added: r.added, restore: r.restore, changed: (a.update?.length ?? 0) + (a.remove?.length ?? 0) };
    }),
});

/** read_list: the rows as text the model can act on (row ids included), by id or by title. */
export const readForTool = internalQuery({
  args: { userId: v.id("users"), scopeSpaceIds: v.array(v.string()), listId: v.optional(v.string()), title: v.optional(v.string()) },
  handler: async (ctx, a) =>
    tryTool(async () => {
      let id = a.listId;
      if (!id && a.title) {
        const t = a.title.trim();
        for (const sid of a.scopeSpaceIds) {
          const nid = ctx.db.normalizeId("spaces", sid);
          if (!nid) continue;
          const hit = (await ctx.db.query("lists").withIndex("by_space", (q) => q.eq("spaceId", nid)).collect()).find((l) => l.title === t || l.title.includes(t));
          if (hit) {
            id = hit._id;
            break;
          }
        }
      }
      if (!id) throw new OneBaseError("لم أجد قائمة بهذا الاسم");
      const { list, space } = await toolList(ctx, a.userId, id, a.scopeSpaceIds, false);
      const people = new Map((await peopleOf(ctx, space)).map((p) => [p.userId, p.name]));
      const show = (c: Column, x: Cell | undefined) => (x === null || x === undefined ? "" : c.type === "person" ? (people.get(String(x)) ?? "؟") : c.type === "check" ? (x ? "✓" : "✗") : String(x).replace(/\|/g, "/").replace(/\n/g, " "));
      const rows = await rowsOf(ctx, list._id);
      const head = `| rowId | ${list.columns.map((c) => `${c.name} (${c.type}${c.options?.length ? `: ${c.options.join("/")}` : ""})`).join(" | ")} |`;
      const lines = rows.slice(0, 500).map((r) => `| ${r._id} | ${list.columns.map((c) => show(c, r.cells[c.key])).join(" | ")} |`);
      return {
        text: `القائمة «${list.title}» (listId=${list._id}، في ${space.kind === "personal" ? "مساحتي" : `«${space.name}»`}، ${rows.length} صف)${list.description ? `\n${list.description}` : ""}\n${head}\n${lines.join("\n")}${rows.length > 500 ? `\n(و${rows.length - 500} صفاً آخر)` : ""}`,
      };
    }),
});

/** One line per list of the chat's space (and my own), for the system prompt; read_list loads one. */
export async function listIndex(ctx: QueryCtx, userId: Id<"users">, spaceIds: Id<"spaces">[]): Promise<string | null> {
  const lines: string[] = [];
  for (const sid of spaceIds) {
    const space = await ctx.db.get(sid);
    if (!space) continue;
    const rows = await ctx.db.query("lists").withIndex("by_space", (q) => q.eq("spaceId", sid)).order("desc").take(15);
    for (const l of rows) lines.push(`- «${l.title}» (listId=${l._id}، ${l.rowCount} صف، في ${space.kind === "personal" ? "مساحتي" : `«${space.name}»`})`);
  }
  if (!lines.length) return null;
  return `القوائم الحية هنا (جداول يحدّثها الموظف ويتابعها؛ اقرأ واحدة بـ read_list وعدّلها بـ update_list بدل كتابة جدول جديد):\n${lines.slice(0, 20).join("\n")}`;
}

/** «تراجع» for list changes the assistant made in my personal space. */
export async function undoLists(ctx: MutationCtx, userId: Id<"users">, u: { deleteLists?: string[]; listId?: string; deleteRows?: string[]; restoreRows?: { rowId?: string; cells: Record<string, Cell>; order: number }[] }) {
  const mine = async (spaceId: Id<"spaces">) => {
    const space = await ctx.db.get(spaceId);
    return !!space && space.kind === "personal" && space.ownerId === userId;
  };
  for (const raw of u.deleteLists ?? []) {
    const id = ctx.db.normalizeId("lists", raw);
    const list = id ? await ctx.db.get(id) : null;
    if (list && (await mine(list.spaceId))) await deleteList(ctx, userId, list, "undo");
  }
  if (!u.listId) return;
  const id = ctx.db.normalizeId("lists", u.listId);
  const list = id ? await ctx.db.get(id) : null;
  if (!list || !(await mine(list.spaceId))) return;
  let count = list.rowCount;
  for (const raw of u.deleteRows ?? []) {
    const rid = ctx.db.normalizeId("listRows", raw);
    const row = rid ? await ctx.db.get(rid) : null;
    if (row && row.listId === list._id) {
      await ctx.db.delete(row._id);
      count--;
    }
  }
  const now = Date.now();
  for (const r of u.restoreRows ?? []) {
    const rid = r.rowId ? ctx.db.normalizeId("listRows", r.rowId) : null;
    const row = rid ? await ctx.db.get(rid) : null;
    if (row && row.listId === list._id) await ctx.db.patch(row._id, { cells: r.cells, updatedBy: userId, updatedAt: now });
    else if (!r.rowId) {
      await ctx.db.insert("listRows", { listId: list._id, cells: r.cells, order: r.order, createdBy: userId, updatedBy: userId, createdAt: now, updatedAt: now });
      count++;
    }
  }
  await touch(ctx, list, { rowCount: count });
}

export const isDone = (s: Cell | undefined) => typeof s === "string" && DONE_RE.test(s.trim());
