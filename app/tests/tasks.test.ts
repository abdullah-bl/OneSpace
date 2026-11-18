// Phase 3 acceptance criteria (plans/04-phases.md, "المرحلة 3"), one describe per checkbox, plus
// status rules, notifications, space instructions and the audit entries for assign/close.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must, type Result } from "./harness";
import { addFile, buildFixture, TASK_TITLES, type Fixture } from "./fixture";

let s: Server;
let f: Fixture;

beforeAll(async () => {
  s = await new Server().start();
  f = await buildFixture(s);
}, 60_000);

afterAll(async () => {
  await s?.stop();
});

const NOT_FOUND = "غير موجود أو لا تملك صلاحية الوصول إليه";
const T = (k: string) => (f.tokens as any)[k] as string | undefined;
const q = (fn: string, args: any, who: string) => s.call("query", fn, args, T(who));
const m = (fn: string, args: any, who: string) => s.call("mutation", fn, args, T(who));
const denied = (r: Result) => {
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain(NOT_FOUND);
};
const feed = async (who: string) => must(await q("notifications:list", {}, who)) as any[];

async function newTask(title: string, spaceKey: keyof Fixture["spaces"] = "S_plain", assignee = "mem") {
  return must(await m("tasks:create", { spaceId: f.spaces[spaceKey], title, assigneeId: f.ids[assignee] }, "mgr")) as string;
}

describe("✓ a space manager assigns a task, the employee is notified, attaches output, the manager reviews and closes", () => {
  test("the whole flow", async () => {
    must(await m("notifications:markAllRead", {}, "mem"));
    must(await m("notifications:markAllRead", {}, "mgr"));
    expect(must(await q("notifications:unreadCount", {}, "mem"))).toBe(0);

    // 1. Manager assigns.
    const due = Date.now() + 3 * 86_400_000;
    const taskId = must(await m("tasks:create", { spaceId: f.spaces.S_plain, title: "تقرير-الربع-FL01", body: "اجمع العروض", assigneeId: f.ids.mem, due, priority: "high" }, "mgr"));

    // 2. Employee is notified and sees it in "مهامي".
    expect(must(await q("notifications:unreadCount", {}, "mem"))).toBe(1);
    const n1 = (await feed("mem")).find((n) => n.taskId === taskId);
    expect(n1.kind).toBe("task.assigned");
    expect(n1.title).toContain("تقرير-الربع-FL01");
    const mine = must(await q("tasks:mine", {}, "mem"));
    const row = mine.find((t: any) => t._id === taskId);
    expect(row).toMatchObject({ status: "new", priority: "high", due, isAssignee: true, canManage: false, canAttach: true });
    expect(row.nextStatuses).toEqual(["inProgress"]);

    // 3. Starts work, uploads output into the space and attaches it, sends for review.
    must(await m("tasks:setStatus", { taskId, status: "inProgress" }, "mem"));
    const out = await addFile(s, T("mem")!, f.spaces.S_plain, "مخرج-FL01.txt", "OUTPUT");
    must(await m("tasks:addLink", { taskId, type: "file", id: out }, "mem"));
    must(await m("tasks:comment", { taskId, body: "أرفقت المخرج" }, "mem"));
    must(await m("tasks:setStatus", { taskId, status: "review" }, "mem"));

    // The assignee can't close their own task.
    const selfClose = await m("tasks:setStatus", { taskId, status: "done" }, "mem");
    expect(selfClose.ok).toBe(false);

    // 4. Manager is notified (review + comment), sees the attachment, closes.
    const mgrFeed = await feed("mgr");
    expect(mgrFeed.some((n) => n.taskId === taskId && n.kind === "task.review")).toBe(true);
    expect(mgrFeed.some((n) => n.taskId === taskId && n.kind === "task.comment")).toBe(true);
    const detail = must(await q("tasks:get", { taskId }, "mgr"));
    expect(detail.status).toBe("review");
    expect(detail.links).toEqual([expect.objectContaining({ type: "file", id: out, name: "مخرج-FL01.txt", available: true })]);
    expect(detail.comments.map((c: any) => c.body)).toEqual(["أرفقت المخرج"]);
    expect(detail.nextStatuses.sort()).toEqual(["done", "inProgress"]);
    must(await m("tasks:setStatus", { taskId, status: "done" }, "mgr"));

    // 5. Employee is notified it's closed; the task is locked for attachments.
    expect((await feed("mem")).some((n) => n.taskId === taskId && n.kind === "task.closed")).toBe(true);
    const closed = must(await q("tasks:get", { taskId }, "mem"));
    expect(closed).toMatchObject({ status: "done", canAttach: false, nextStatuses: [] });
    expect(closed.closedAt).toBeGreaterThan(0);
    expect((await m("tasks:addLink", { taskId, type: "file", id: f.files.S_plain }, "mem")).ok).toBe(false);

    // Assignment and closing are in the space's audit log.
    const log = must(await q("audit:list", { spaceId: f.spaces.S_plain }, "mgr"));
    const mineLog = log.filter((r: any) => r.resourceId === taskId);
    expect(mineLog.map((r: any) => r.action).sort()).toEqual(["task.assign", "task.close"]);
    expect(mineLog.find((r: any) => r.action === "task.assign").detail).toMatchObject({ taskTitle: "تقرير-الربع-FL01", assigneeId: f.ids.mem });

    // markAllRead clears the bell.
    must(await m("notifications:markAllRead", {}, "mem"));
    expect(must(await q("notifications:unreadCount", {}, "mem"))).toBe(0);
  });

  test("returning from review and reopening notify the assignee; reopen is audited", async () => {
    const taskId = await newTask("إعادة-RT02");
    must(await m("tasks:setStatus", { taskId, status: "inProgress" }, "mem"));
    must(await m("tasks:setStatus", { taskId, status: "review" }, "mem"));
    must(await m("tasks:setStatus", { taskId, status: "inProgress" }, "mgr"));
    expect((await feed("mem")).some((n) => n.taskId === taskId && n.kind === "task.returned")).toBe(true);
    must(await m("tasks:setStatus", { taskId, status: "done" }, "mgr"));
    must(await m("tasks:setStatus", { taskId, status: "inProgress" }, "mgr"));
    const log = must(await q("audit:list", { spaceId: f.spaces.S_plain }, "mgr"));
    expect(log.filter((r: any) => r.resourceId === taskId).map((r: any) => r.action)).toContain("task.reopen");
  });

  test("status rules: only forward moves for the assignee; readers and other members can't move it", async () => {
    const taskId = await newTask("حالات-ST03");
    expect((await m("tasks:setStatus", { taskId, status: "review" }, "mem")).ok).toBe(false); // must go through inProgress
    denied(await m("tasks:setStatus", { taskId, status: "inProgress" }, "rdr"));
    // mgr2: a member of the space who is not the assignee
    must(await m("spaces:addMember", { spaceId: f.spaces.S_plain, userId: f.ids.tmp, role: "member" }, "mgr"));
    try {
      denied(await m("tasks:setStatus", { taskId, status: "inProgress" }, "tmp"));
      denied(await m("tasks:addLink", { taskId, type: "file", id: f.files.S_plain }, "tmp"));
      must(await m("tasks:comment", { taskId, body: "سؤال" }, "tmp")); // members may comment
    } finally {
      must(await m("spaces:removeMember", { spaceId: f.spaces.S_plain, userId: f.ids.tmp }, "mgr"));
    }
    expect((await m("tasks:comment", { taskId, body: "قارئ" }, "rdr")).ok).toBe(false);
  });

  test("the agent thread id is stored on the task (Phase 2 fills it)", async () => {
    const taskId = await newTask("محادثة-TH04");
    must(await m("tasks:setThread", { taskId, threadId: "thr_abc" }, "mem"));
    expect(must(await q("tasks:get", { taskId }, "mgr")).threadId).toBe("thr_abc");
    must(await m("tasks:setThread", { taskId, threadId: null }, "mgr"));
    expect(must(await q("tasks:get", { taskId }, "mem")).threadId).toBeNull();
  });
});

describe("✓ a task is seen only by members of its space, and can't be assigned to a non-member", () => {
  test("outsiders get the same answer as for a task that doesn't exist", async () => {
    const missing = f.tasks.P_mem; // a deleted task
    for (const who of ["out", "admin"]) {
      denied(await q("tasks:get", { taskId: f.tasks.S_plain }, who));
      denied(await q("tasks:get", { taskId: missing }, who));
      denied(await q("tasks:board", { spaceId: f.spaces.S_plain }, who));
    }
    // pending, disabled and signed-out accounts stop earlier, before any lookup
    for (const who of ["pend", "dis", "anon"]) {
      for (const r of [await q("tasks:get", { taskId: f.tasks.S_plain }, who), await q("tasks:board", { spaceId: f.spaces.S_plain }, who)]) {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).not.toContain(TASK_TITLES.S_plain);
      }
    }
    // An "everyone" space: every employee reads its files, but its tasks are for named members only.
    for (const who of ["out", "admin"]) {
      expect((await q("files:list", { spaceId: f.spaces.S_every }, who)).ok).toBe(true);
      denied(await q("tasks:board", { spaceId: f.spaces.S_every }, who));
      denied(await q("tasks:get", { taskId: f.tasks.S_every }, who));
    }
  });

  test("no task title leaks to an outsider through any list or feed", async () => {
    for (const who of ["out", "admin"]) {
      const text = [
        JSON.stringify(await q("tasks:mine", {}, who)),
        JSON.stringify(await q("notifications:list", {}, who)),
        ...(await Promise.all(Object.values(f.spaces).map(async (sp) => JSON.stringify(await q("tasks:board", { spaceId: sp }, who))))),
        ...(await Promise.all(Object.values(f.tasks).map(async (id) => JSON.stringify(await q("tasks:get", { taskId: id }, who))))),
      ].join("\n");
      for (const title of Object.values(TASK_TITLES)) expect(text).not.toContain(title);
    }
  });

  test("the workspace admin's audit view redacts task titles of spaces they can't read", async () => {
    const log = must(await q("audit:list", { spaceId: f.spaces.S_plain }, "admin"));
    const assign = log.find((r: any) => r.action === "task.assign" && r.resourceId === f.tasks.S_plain);
    expect(assign.detail.taskTitle).toBe("•••");
    expect(JSON.stringify(log)).not.toContain(TASK_TITLES.S_plain);
  });

  test("members and readers see the board; readers can't create", async () => {
    for (const who of ["mgr", "mem", "rdr"]) {
      const board = must(await q("tasks:board", { spaceId: f.spaces.S_plain }, who));
      expect(board.some((t: any) => t._id === f.tasks.S_plain)).toBe(true);
    }
    denied(await m("tasks:create", { spaceId: f.spaces.S_plain, title: "x", assigneeId: f.ids.mem }, "rdr"));
    denied(await m("tasks:create", { spaceId: f.spaces.S_plain, title: "x", assigneeId: f.ids.mem }, "mem"));
  });

  test("no tasks in a personal space, not even by its owner", async () => {
    denied(await m("tasks:create", { spaceId: f.spaces.P_mem, title: "x", assigneeId: f.ids.mem }, "mem"));
  });

  test("can't assign to a non-member, a reader, a pending or a disabled account", async () => {
    for (const target of ["out", "rdr", "pend", "dis", "admin"]) {
      const r = await m("tasks:create", { spaceId: f.spaces.S_plain, title: "x", assigneeId: f.ids[target] }, "mgr");
      expect(r.ok).toBe(false);
      const re = await m("tasks:assign", { taskId: f.tasks.S_plain, assigneeId: f.ids[target] }, "mgr");
      expect(re.ok).toBe(false);
    }
    // the candidates list offers managers and members only
    const list = must(await q("tasks:assignees", { spaceId: f.spaces.S_plain }, "mgr"));
    expect(list.map((x: any) => x.userId).sort()).toEqual([f.ids.mgr, f.ids.mem].sort());
  });

  test("a member removed from the space loses the task, its board and its notifications at once", async () => {
    must(await m("spaces:addMember", { spaceId: f.spaces.S_plain, userId: f.ids.tmp, role: "member" }, "mgr"));
    const taskId = must(await m("tasks:create", { spaceId: f.spaces.S_plain, title: "مهمة-مؤقتة-RM05", assigneeId: f.ids.tmp }, "mgr"));
    expect((await feed("tmp")).some((n) => n.taskId === taskId)).toBe(true);
    expect(must(await q("tasks:mine", {}, "tmp")).some((t: any) => t._id === taskId)).toBe(true);
    must(await m("spaces:removeMember", { spaceId: f.spaces.S_plain, userId: f.ids.tmp }, "mgr"));
    denied(await q("tasks:get", { taskId }, "tmp"));
    denied(await q("tasks:board", { spaceId: f.spaces.S_plain }, "tmp"));
    denied(await m("tasks:setStatus", { taskId, status: "inProgress" }, "tmp"));
    expect(must(await q("tasks:mine", {}, "tmp"))).toEqual([]);
    expect((await feed("tmp")).some((n) => n.taskId === taskId)).toBe(false);
    expect(JSON.stringify(await feed("tmp"))).not.toContain("RM05");
    // the manager sees the assignee is no longer a member, and reassigns
    const row = must(await q("tasks:board", { spaceId: f.spaces.S_plain }, "mgr")).find((t: any) => t._id === taskId);
    expect(row.assigneeActive).toBe(false);
    must(await m("tasks:assign", { taskId, assigneeId: f.ids.mem }, "mgr"));
    must(await m("tasks:remove", { taskId }, "mgr"));
  });
});

describe("✓ attachments come from the task's own space only, so a task never exposes another space's file", () => {
  test("files from my personal space or another shared space are refused like a missing file", async () => {
    const taskId = await newTask("مرفقات-AT06");
    must(await m("tasks:setStatus", { taskId, status: "inProgress" }, "mem"));
    // mem can read all of these, but none lives in S_plain
    denied(await m("tasks:addLink", { taskId, type: "file", id: f.files.P_mem }, "mem"));
    denied(await m("tasks:addLink", { taskId, type: "file", id: f.files.S_sens }, "mem"));
    denied(await m("tasks:addLink", { taskId, type: "file", id: f.files.S_every }, "mgr"));
    denied(await m("tasks:addLink", { taskId, type: "file", id: "not-an-id" }, "mem"));
    // artifacts arrive in Phase 4: until then nothing resolves, so nothing can be linked
    denied(await m("tasks:addLink", { taskId, type: "artifact", id: f.files.S_plain }, "mem"));
    must(await m("tasks:addLink", { taskId, type: "file", id: f.files.S_plain }, "mem"));
    const links = must(await q("tasks:get", { taskId }, "rdr")).links;
    expect(links.map((l: any) => l.id)).toEqual([f.files.S_plain]);
  });

  test("a linked file later moved to another space stops showing (no name) on the task", async () => {
    const taskId = await newTask("نقل-MV07");
    const fileId = await addFile(s, T("mgr")!, f.spaces.S_plain, "سري-MV07.txt", "SECRET");
    must(await m("tasks:addLink", { taskId, type: "file", id: fileId }, "mgr"));
    must(await m("files:move", { fileId, toSpaceId: f.spaces.S_sens }, "mgr"));
    for (const who of ["rdr", "mem", "mgr"]) {
      const t = must(await q("tasks:get", { taskId }, who));
      expect(t.links).toEqual([expect.objectContaining({ id: fileId, available: false, name: null })]);
      expect(JSON.stringify(t)).not.toContain("سري-MV07");
    }
    // removing the dangling link still works
    must(await m("tasks:removeLink", { taskId, type: "file", id: fileId }, "mgr"));
    expect(must(await q("tasks:get", { taskId }, "mgr")).links).toEqual([]);
  });
});

describe("space instructions (the space as a project)", () => {
  test("the manager sets them, members read them, nobody else can set them", async () => {
    must(await m("spaces:setInstructions", { spaceId: f.spaces.S_plain, instructions: "  اكتب بلغة رسمية  " }, "mgr"));
    for (const who of ["mem", "rdr"]) expect(must(await q("spaces:get", { spaceId: f.spaces.S_plain }, who)).instructions).toBe("اكتب بلغة رسمية");
    for (const who of ["mem", "rdr", "out", "admin", "anon"]) expect((await m("spaces:setInstructions", { spaceId: f.spaces.S_plain, instructions: "x" }, who)).ok).toBe(false);
    denied(await q("spaces:get", { spaceId: f.spaces.S_plain }, "out"));
    must(await m("spaces:setInstructions", { spaceId: f.spaces.S_plain, instructions: "" }, "mgr"));
    expect(must(await q("spaces:get", { spaceId: f.spaces.S_plain }, "mem")).instructions).toBeNull();
    // personal spaces have no instructions editor
    expect((await m("spaces:setInstructions", { spaceId: f.spaces.P_mem, instructions: "x" }, "mem")).ok).toBe(false);
  });
});
