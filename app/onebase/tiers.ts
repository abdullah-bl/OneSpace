// Risk tiers for write tools (plans/07 §D). Decided by code at call time from the tool and where
// its result would land, never claimed by the model:
//   1  create-private  → the target is my own personal space and nothing sensitive is involved:
//                        runs at once, and the card offers «تراجع» (undo).
//   2  change-shared   → anything else: a card that waits for «نفّذ» (Phase 6 flow).
//   3  sensitive/official → sensitive spaces, official documents: «نفّذ» as well, marked as such.
// The same placement rules run again when the tool executes (artifacts.place); this only decides
// whether to ask first. Any doubt (unknown tool, an error resolving the target) means tier 2.

import { OneBaseError, v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";
import { actorFor, assertCan, Denied, roleAllows, spaceRoleOf } from "./access";
import { homeSpaceOf, place, resolveSources, type SourceRef } from "./artifacts";
import { placeForTier } from "./lists";
import { exportTarget } from "./tools/export_document";

export type Tier = 1 | 2 | 3;
/**
 * `refused`: the person can't do this at all, so chat.ts turns the call back to the model with the
 * reason instead of showing a «نفّذ» card that could only fail. A denied target (read-only for them,
 * or not there: one answer for both, so ids can't be probed) or a placement rule (a sensitive
 * space's outputs stay in it, …).
 */
export type Resolution = Tier | { refused: string };
export const READ_ONLY_REFUSAL = "الهدف غير موجود أو صلاحية الموظف عليه قراءة فقط";

/** Tier-1 auto-run can be switched off for a deployment (TIER1_AUTORUN=0): everything asks again. */
export const autoRunEnabled = () => process.env.TIER1_AUTORUN !== "0";

const ALWAYS_OFFICIAL = new Set(["fill_template"]);

function tierFor(userId: Id<"users">, space: Doc<"spaces">, sensitive: boolean): Tier {
  if (sensitive || space.sensitive) return 3;
  return space.kind === "personal" && space.ownerId === userId ? 1 : 2;
}

async function artifactTier(ctx: QueryCtx, userId: Id<"users">, artifactId: unknown, at: (space: Doc<"spaces">, sensitive: boolean) => Tier): Promise<Tier> {
  const id = ctx.db.normalizeId("artifacts", String(artifactId ?? ""));
  const art = id ? await ctx.db.get(id) : null;
  if (!art) return 2;
  const { space } = await assertCan(ctx, userId, art.spaceId, "write");
  return at(space, art.classification === "sensitive");
}

/** The sensitive spaces a turn read data from: its tools' spaces and its sources' files. */
async function sensitiveRead(ctx: QueryCtx, read: { spaceIds: string[]; fileIds: string[] } | undefined): Promise<Doc<"spaces">[]> {
  if (!read) return [];
  const ids = new Set<string>(read.spaceIds);
  for (const fid of read.fileIds.slice(0, 500)) {
    const id = ctx.db.normalizeId("files", fid);
    const file = id ? await ctx.db.get(id) : null;
    if (file) ids.add(file.spaceId);
  }
  const out: Doc<"spaces">[] = [];
  for (const sid of ids) {
    const id = ctx.db.normalizeId("spaces", sid);
    const space = id ? await ctx.db.get(id) : null;
    if (space?.sensitive) out.push(space);
  }
  return out;
}

function refs(sources: unknown): SourceRef[] {
  return Array.isArray(sources) ? sources.filter((s) => s && typeof s === "object").map((s: any) => ({ type: s.type, id: String(s.id) })) : [];
}

export const resolve = internalQuery({
  args: {
    userId: v.id("users"),
    tool: v.string(),
    args: v.any(),
    scopeSpaceIds: v.array(v.string()),
    threadId: v.optional(v.string()),
    // What this turn read so far: data from a sensitive space stays in it unless its manager moves it.
    read: v.optional(v.object({ spaceIds: v.array(v.string()), fileIds: v.array(v.string()) })),
  },
  handler: async (ctx, { userId, tool, args, scopeSpaceIds, threadId, read }): Promise<Resolution> => {
    if (ALWAYS_OFFICIAL.has(tool)) return 3;
    const actor = await actorFor(ctx, userId);
    if (!actor) return 2;
    const scope = new Set(scopeSpaceIds);
    const a = (args ?? {}) as Record<string, any>;
    // Where the write lands, when the tool has a place (null: personal memory, a message, a publication…).
    let target: Id<"spaces"> | null = null;
    const at = (space: Doc<"spaces">, sensitive: boolean): Tier => {
      target = space._id;
      return tierFor(userId, space, sensitive);
    };
    const tainted = await sensitiveRead(ctx, read);
    const base = await (async (): Promise<Resolution> => {
      try {
        switch (tool) {
          case "create_skill":
            // My own «مهاراتي»: tier 1 (chat.ts asks anyway unless I asked for a skill). A space's skills are shared.
            return a.scope === "space" ? 2 : 1;
          case "remember": {
            // My own memory: tier 1 (chat.ts asks anyway unless I asked for it). A space's memory is shared.
            if (a.scope !== "space") return 1;
            const { space } = await assertCan(ctx, userId, String(a.spaceId ?? ""), "read");
            target = space._id;
            return space.sensitive ? 3 : 2;
          }
          case "notify_colleague":
            // plans/16: a message in the shared chat its members already read; chat.ts asks first
            // unless the request names someone to tell.
            return 1;
          case "publish_output":
            // Public: anyone with the link, no sign-in — marked as such on the card.
            return a.audience === "public" ? 3 : 2;
          case "create_list": {
            const space = await placeForTier(ctx, userId, threadId, scopeSpaceIds);
            return at(space, false);
          }
          case "update_list": {
            const id = ctx.db.normalizeId("lists", String(a.listId ?? ""));
            const list = id ? await ctx.db.get(id) : null;
            if (!list) return 2;
            const { space } = await assertCan(ctx, userId, list.spaceId, "write");
            return at(space, false);
          }
          case "update_artifact":
            return await artifactTier(ctx, userId, a.artifactId, at);
          case "write_app": {
            // A new version of an app: where it is. A new app: where its lists are, else where a new list goes.
            if (a.appId) return await artifactTier(ctx, userId, a.appId, at);
            const first = a.data && typeof a.data === "object" ? (Object.values(a.data)[0] as any)?.listId : undefined;
            const lid = first ? ctx.db.normalizeId("lists", String(first)) : null;
            const list = lid ? await ctx.db.get(lid) : null;
            if (list) {
              const { space } = await assertCan(ctx, userId, list.spaceId, "write");
              return at(space, false);
            }
            return at(await placeForTier(ctx, userId, threadId, scopeSpaceIds), false);
          }
          case "export_document":
            if (exportTarget(a)) return await artifactTier(ctx, userId, exportTarget(a), at);
          // falls through: a new output from Markdown is placed like create_artifact (no explicit space)
          case "create_artifact": {
            const { sources, sensitiveOrigins } = await resolveSources(ctx, actor, refs(a.sources), scope);
            for (const sp of tainted) sensitiveOrigins.add(sp._id);
            const placed = await place(ctx, actor, sources, sensitiveOrigins, tool === "create_artifact" ? a.spaceId : undefined, scope, { home: await homeSpaceOf(ctx, userId, threadId) });
            return at(placed.space, placed.classification === "sensitive");
          }
          case "run_analysis": {
            const ids = Array.isArray(a.fileIds) ? [...new Set(a.fileIds.map(String))] : [];
            if (!ids.length) return 2;
            const sources = [];
            let sensitive = false;
            for (const fid of ids) {
              const id = ctx.db.normalizeId("files", fid);
              const file = id ? await ctx.db.get(id) : null;
              if (!file || file.status !== "active") return 2;
              const { space } = await assertCan(ctx, userId, file.spaceId, "read");
              if (!scope.has(space._id)) return 2;
              if (space.sensitive) sensitive = true;
              sources.push({ type: "file" as const, id: file._id, spaceId: space._id });
            }
            const placed = await place(ctx, actor, sources, new Set(), a.targetSpaceId, scope, { managerMayExport: true, home: await homeSpaceOf(ctx, userId, threadId) });
            return at(placed.space, sensitive);
          }
          default:
            return 2;
        }
      } catch (e) {
        if (e instanceof Denied) return { refused: READ_ONLY_REFUSAL };
        if (e instanceof OneBaseError) return { refused: e.message };
        return 2;
      }
    })();
    if (typeof base === "object") return base;
    // Data this turn read from a sensitive space, written anywhere else (a personal list, memory, a
    // message…): only its manager may move it, and even then with «نفّذ» (never auto-run). Measured on
    // the demo: a reader of «الموارد البشرية» got a personal list of salaries with no card.
    const outside = tainted.filter((sp) => sp._id !== target);
    if (!outside.length) return base;
    for (const sp of outside) {
      if (!roleAllows(await spaceRoleOf(ctx, userId, sp, actor), "manage"))
        return { refused: `فيه بيانات من مساحة «${sp.name}» الحساسة، وهي لا تُنقل خارجها إلا بيد مديرها؛ يمكن حفظه داخل المساحة نفسها إن كانت لك صلاحية الكتابة فيها` };
    }
    return 3;
  },
});
