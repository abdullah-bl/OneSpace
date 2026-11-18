import { plugin } from "bun";
import { defineComponents } from "onebase/components";
// @onebase/teams and @onebase/notifications, installed from GitHub as part of the
// onebase-components monorepo (bun can not install a subdirectory of a git repo, so packages are
// imported by their path inside the repo).
import { teams } from "onebase-components/packages/teams/src/index.ts";
import * as email from "onebase-components/packages/email/src/index.ts";

// @onebase/notifications imports its sibling "@onebase/email" by package name, which only
// resolves inside the monorepo's own workspace. Provide it as a virtual module (the same
// mechanism onebase uses for "onebase/server") and load notifications after it is registered.
// tsconfig.json maps the same name for the typechecker. Upstream issue: see README.
plugin({
  name: "onespace-onebase-email",
  setup(build) {
    build.module("@onebase/email", () => ({ exports: email, loader: "object" }));
  },
});
const { notifications } = await import("onebase-components/packages/notifications/src/index.ts");

// The workspace (department) is one team: admin = workspace admin, member = employee.
// Space membership (manager|member|reader) is in the app's own spaceMembers table.
// notes: the in-app notification feed, one subject per user id. No email channel (on-prem,
// nothing leaves the server); the app only exposes it through notifications.ts wrappers.
export default defineComponents({
  workspace: teams({ roles: ["admin", "member"], manageRole: "admin", joinRole: "member" }),
  notes: notifications({ retentionMs: 90 * 86_400_000 }),
});
