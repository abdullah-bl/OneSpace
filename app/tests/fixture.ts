// A workspace with every kind of actor and space, built through the public API only.

import { Server, must } from "./harness";

export const PW = "password-123";
export const ACTORS = ["admin", "mgr", "mem", "rdr", "out", "pend", "dis", "anon"] as const;
export type ActorKey = (typeof ACTORS)[number];
export const SPACES = ["P_mem", "S_plain", "S_every", "S_sens"] as const;
export type SpaceKey = (typeof SPACES)[number];

// Unique names so a leak is easy to spot in any response body.
export const SPACE_NAMES: Record<Exclude<SpaceKey, "P_mem">, string> = {
  S_plain: "لجنة-المشتريات-QX71",
  S_every: "السياسات-PL22",
  S_sens: "ملفات-الطلبة-SN93",
};
export const FILE_NAMES: Record<SpaceKey, string> = {
  P_mem: "مسودة-خاصة-PF55.txt",
  S_plain: "عرض-سعر-PF56.txt",
  S_every: "سياسة-الإجازات-PF57.txt",
  S_sens: "درجات-الطلبة-PF58.txt",
};

export type Fixture = {
  s: Server;
  tokens: Record<ActorKey, string | undefined>;
  ids: Record<string, string>;
  spaces: Record<SpaceKey, string>;
  files: Record<SpaceKey, string>;
  /** Phase 3: one task per shared space (created by mgr, assigned to mem); P_mem gets a deleted task's id. */
  tasks: Record<SpaceKey, string>;
  emails: Record<string, string>;
};

export const TASK_TITLES: Record<SpaceKey, string> = {
  P_mem: "مهمة-محذوفة-TK00",
  S_plain: "مهمة-المشتريات-TK71",
  S_every: "مهمة-السياسات-TK22",
  S_sens: "مهمة-الطلبة-TK93",
};

export async function buildFixture(s: Server): Promise<Fixture> {
  const emails: Record<string, string> = {};
  const tokens = {} as Record<ActorKey, string | undefined>;
  const ids: Record<string, string> = {};
  for (const k of ["admin", "mgr", "mem", "rdr", "out", "pend", "dis", "tmp"]) {
    emails[k] = `${k}@onespace.test`;
    const r = await s.auth("signUp", emails[k]!, PW, `موظف ${k}`);
    tokens[k as ActorKey] = r.token;
    ids[k] = r.userId;
  }
  tokens.anon = undefined;
  must(await s.adminRun("admin:bootstrap", { email: emails.admin }));
  const admin = tokens.admin!;
  for (const k of ["mgr", "mem", "rdr", "out", "dis", "tmp"]) must(await s.call("mutation", "admin:activate", { userId: ids[k] }, admin));

  const spaces = {} as Record<SpaceKey, string>;
  const mine = must(await s.call("query", "spaces:mine", {}, tokens.mem));
  spaces.P_mem = mine.find((x: any) => x.kind === "personal")._id;
  spaces.S_plain = must(await s.call("mutation", "admin:createSharedSpace", { name: SPACE_NAMES.S_plain, managerId: ids.mgr }, admin));
  spaces.S_every = must(await s.call("mutation", "admin:createSharedSpace", { name: SPACE_NAMES.S_every, managerId: ids.mgr, everyone: true }, admin));
  spaces.S_sens = must(await s.call("mutation", "admin:createSharedSpace", { name: SPACE_NAMES.S_sens, managerId: ids.mgr, sensitive: true }, admin));
  for (const sp of ["S_plain", "S_every", "S_sens"] as const) {
    must(await s.call("mutation", "spaces:addMember", { spaceId: spaces[sp], userId: ids.mem, role: "member" }, tokens.mgr));
    must(await s.call("mutation", "spaces:addMember", { spaceId: spaces[sp], userId: ids.rdr, role: "reader" }, tokens.mgr));
  }
  // dis was a member, then got disabled: it must lose everything.
  must(await s.call("mutation", "spaces:addMember", { spaceId: spaces.S_plain, userId: ids.dis, role: "member" }, tokens.mgr));

  const files = {} as Record<SpaceKey, string>;
  files.P_mem = await addFile(s, tokens.mem!, undefined, FILE_NAMES.P_mem, "PERSONAL-CONTENT-PF55");
  for (const sp of ["S_plain", "S_every", "S_sens"] as const) files[sp] = await addFile(s, tokens.mgr!, spaces[sp], FILE_NAMES[sp], `CONTENT-${sp}`);
  const tasks = {} as Record<SpaceKey, string>;
  for (const sp of ["S_plain", "S_every", "S_sens"] as const) {
    tasks[sp] = must(await s.call("mutation", "tasks:create", { spaceId: spaces[sp], title: TASK_TITLES[sp], assigneeIds: [ids.mem] }, tokens.mgr));
  }
  const dead = must(await s.call("mutation", "tasks:create", { spaceId: spaces.S_plain, title: TASK_TITLES.P_mem, assigneeIds: [ids.mem] }, tokens.mgr));
  must(await s.call("mutation", "tasks:remove", { taskId: dead }, tokens.mgr));
  tasks.P_mem = dead; // tasks can't live in a personal space: every call with this id must be denied
  must(await s.call("mutation", "admin:disable", { userId: ids.dis }, admin));
  // Disabling ends dis's sessions; sign in again so the tests check a disabled account that holds a valid session.
  tokens.dis = (await s.auth("signIn", emails.dis!, PW)).token;
  return { s, tokens, ids, spaces, files, tasks, emails };
}

export async function addFile(s: Server, token: string, spaceId: string | undefined, name: string, content: string) {
  const storageId = await s.upload(token, content);
  return must(await s.call("mutation", "files:create", { storageId, name, ...(spaceId ? { spaceId } : {}) }, token));
}

/** The role model the tests check against, written independently of access.ts. */
export function expectedRole(actor: ActorKey, space: SpaceKey): "owner" | "manager" | "member" | "reader" | "everyone" | null {
  if (["pend", "dis", "anon"].includes(actor)) return null;
  if (space === "P_mem") return actor === "mem" ? "owner" : null;
  if (actor === "mgr") return "manager";
  if (actor === "mem") return "member";
  if (actor === "rdr") return "reader";
  if (space === "S_every") return "everyone"; // admin and out: workspace members, so readers
  return null;
}

/** Phase 3: taskView = named members (manager, member, reader); taskComment = manager, member;
 *  taskManage = manager; taskWork = manager or the task's assignee (mem in the fixture). */
export type TaskNeed = "taskView" | "taskComment" | "taskManage" | "taskWork";
export type Need = "read" | "write" | "manage" | "audit" | TaskNeed;

export function expectedAllowed(actor: ActorKey, space: SpaceKey, need: Need): boolean {
  const role = expectedRole(actor, space);
  if (need.startsWith("task")) {
    // Tasks live in shared spaces and are seen by named members only (not "everyone" readers,
    // not the workspace admin unless named, not a personal space's owner).
    if (space === "P_mem" || role === null || role === "everyone" || role === "owner") return false;
    if (need === "taskView") return true;
    if (need === "taskComment") return role === "manager" || role === "member";
    if (need === "taskManage") return role === "manager";
    return role === "manager" || actor === "mem";
  }
  if (need === "audit") return actor === "admin" || role === "manager";
  if (role === null) return false;
  if (need === "read") return true;
  if (need === "write") return ["owner", "manager", "member"].includes(role);
  return role === "manager";
}
