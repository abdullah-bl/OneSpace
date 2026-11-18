import { defineComponents } from "onebase/components";
// @onebase/teams, installed from GitHub as part of the onebase-components monorepo (bun can not
// install a subdirectory of a git repo, so the package is imported by its path inside the repo).
import { teams } from "onebase-components/packages/teams/src/index.ts";

// The workspace (department) is one team: admin = workspace admin, member = employee.
// Space membership (manager|member|reader) is in the app's own spaceMembers table.
export default defineComponents({
  workspace: teams({ roles: ["admin", "member"], manageRole: "admin", joinRole: "member" }),
});
