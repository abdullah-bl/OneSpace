import { getAuthUserId } from "onebase/server";
import { query } from "./_generated/server";
import { actorFor, statusOf } from "./access";

/**
 * Who am I. The only function a pending or disabled account gets an answer from, and the
 * answer is about itself only: its status, never any workspace data.
 */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    if (!user) return null;
    const actor = await actorFor(ctx, userId);
    return {
      _id: user._id,
      name: user.name ?? null,
      email: user.email ?? null,
      status: statusOf(user),
      workspaceRole: actor?.role ?? null,
      workspaceName: actor?.workspace.name ?? null,
    };
  },
});
