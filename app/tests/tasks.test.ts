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
    expect(mineLog.find((r: any) => r.action === "task.assign").detail).toMatchObject({ taskTitle: "تقرير-الربع-FL01", assigneeIds: f.ids.mem });

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
    expect(row.assignees).toEqual([{ userId: f.ids.tmp, name: "موظف tmp", active: false }]);
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
    // a file id is not an artifact id: the artifact lookup finds nothing
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

describe("✓ a task links an output (Phase 4 artifact) of its own space only", () => {
  const artifact = async (who: string, title: string, spaceKey?: keyof Fixture["spaces"]) =>
    must(await m("artifacts:create", { title, kind: "markdown", content: `# ${title}`, ...(spaceKey ? { spaceId: f.spaces[spaceKey] } : {}) }, who)).artifactId as string;

  test("the assignee attaches an output of the space; every task viewer sees its name, and the manager reviews it", async () => {
    const taskId = await newTask("مخرج-AR01");
    const art = await artifact("mem", "تقرير-العروض-AR01", "S_plain");
    // a member who isn't the assignee can't attach (same rule as files)…
    must(await m("tasks:assign", { taskId, assigneeId: f.ids.mgr }, "mgr"));
    expect((await m("tasks:addLink", { taskId, type: "artifact", id: art }, "mem")).ok).toBe(false);
    must(await m("tasks:assign", { taskId, assigneeId: f.ids.mem }, "mgr"));
    // …the assignee can
    must(await m("tasks:addLink", { taskId, type: "artifact", id: art }, "mem"));
    must(await m("tasks:addLink", { taskId, type: "artifact", id: art }, "mem")); // idempotent
    for (const who of ["mgr", "mem", "rdr"]) {
      const t = must(await q("tasks:get", { taskId }, who));
      expect(t.links).toEqual([expect.objectContaining({ type: "artifact", id: art, name: "تقرير-العروض-AR01", available: true, sensitive: false })]);
      expect(t.linkCount).toBe(1);
    }
    // people who can't see the task learn nothing about the output
    for (const who of ["out", "admin"]) denied(await q("tasks:get", { taskId }, who));
    expect((await q("tasks:get", { taskId }, "anon")).ok).toBe(false);
    // the linked output opens through artifacts.ts for a viewer of the task
    expect(must(await m("artifacts:open", { artifactId: art }, "rdr")).content).toBe("# تقرير-العروض-AR01");
    must(await m("tasks:removeLink", { taskId, type: "artifact", id: art }, "mem"));
    expect(must(await q("tasks:get", { taskId }, "mgr")).links).toEqual([]);
  });

  test("outputs from my personal space, another shared space or a sensitive space are refused like a missing one", async () => {
    const taskId = await newTask("مخرج-AR02");
    const mine = await artifact("mem", "مسودتي-AR02");
    const every = await artifact("mgr", "سياسة-AR02", "S_every");
    const sens = await artifact("mgr", "درجات-AR02", "S_sens");
    for (const id of [mine, every, sens, "not-an-id", f.tasks.S_plain]) denied(await m("tasks:addLink", { taskId, type: "artifact", id }, "mem"));
    for (const id of [every, sens]) denied(await m("tasks:addLink", { taskId, type: "artifact", id }, "mgr"));
    const t = must(await q("tasks:get", { taskId }, "mgr"));
    expect(t.links).toEqual([]);
    for (const name of ["مسودتي-AR02", "سياسة-AR02", "درجات-AR02"]) expect(JSON.stringify(t)).not.toContain(name);
  });

  test("a sensitive output links only to a task in its sensitive space, is flagged, and stops showing once moved out", async () => {
    const taskId = await newTask("مخرج-حساس-AR03", "S_sens");
    // built on a sensitive file → saved in that space, classified sensitive
    const created = must(await m("artifacts:create", { title: "كشف-الدرجات-AR03", kind: "markdown", content: "سري", sources: [{ type: "file", id: f.files.S_sens }] }, "mem"));
    expect(created).toMatchObject({ spaceId: f.spaces.S_sens, classification: "sensitive" });
    must(await m("tasks:addLink", { taskId, type: "artifact", id: created.artifactId }, "mem"));
    for (const who of ["mgr", "mem", "rdr"]) {
      expect(must(await q("tasks:get", { taskId }, who)).links).toEqual([expect.objectContaining({ id: created.artifactId, name: "كشف-الدرجات-AR03", available: true, sensitive: true })]);
    }
    // a task in a non-sensitive space can never pick it up
    const plainTask = await newTask("مخرج-AR03b");
    denied(await m("tasks:addLink", { taskId: plainTask, type: "artifact", id: created.artifactId }, "mgr"));
    // opening it from the task is audited (sensitive output)
    must(await m("artifacts:open", { artifactId: created.artifactId }, "rdr"));
    const log = must(await s.call("query", "audit:list", { userId: f.ids.rdr, limit: 200 }, T("admin")));
    expect(log.some((r: any) => r.action === "artifact.open" && r.resourceId === created.artifactId)).toBe(true);
    // the member can't move it out; its manager can — and then the S_sens task no longer shows it
    expect((await m("artifacts:move", { artifactId: created.artifactId, toSpaceId: f.spaces.S_plain }, "mem")).ok).toBe(false);
    must(await m("artifacts:move", { artifactId: created.artifactId, toSpaceId: f.spaces.S_plain }, "mgr"));
    for (const who of ["mgr", "mem", "rdr"]) {
      const t = must(await q("tasks:get", { taskId }, who));
      expect(t.links).toEqual([expect.objectContaining({ id: created.artifactId, available: false, name: null, sensitive: false })]);
      expect(JSON.stringify(t)).not.toContain("كشف-الدرجات-AR03");
    }
  });

  test("a deleted output shows as unavailable and the dangling link can be removed", async () => {
    const taskId = await newTask("مخرج-AR04");
    const art = await artifact("mgr", "مؤقت-AR04", "S_plain");
    must(await m("tasks:addLink", { taskId, type: "artifact", id: art }, "mgr"));
    must(await m("artifacts:remove", { artifactId: art }, "mgr"));
    expect(must(await q("tasks:get", { taskId }, "mem")).links).toEqual([expect.objectContaining({ id: art, available: false, name: null })]);
    must(await m("tasks:removeLink", { taskId, type: "artifact", id: art }, "mgr"));
    expect(must(await q("tasks:get", { taskId }, "mem")).links).toEqual([]);
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

describe("one task, several assignees", () => {
  const ACTORS = ["admin", "mgr", "mem", "rdr", "out", "pend", "dis", "tmp", "anon"];

  test("each assignee is notified, sees it in «مهامي», works on it; the manager still reviews and closes", async () => {
    must(await m("spaces:addMember", { spaceId: f.spaces.S_plain, userId: f.ids.tmp, role: "member" }, "mgr"));
    const taskId = must(await m("tasks:create", { spaceId: f.spaces.S_plain, title: "مشتركة-MA01", assigneeIds: [f.ids.mem, f.ids.tmp, f.ids.mem] }, "mgr")) as string;
    const row = must(await q("tasks:get", { taskId }, "rdr"));
    expect(row.assigneeIds).toEqual([f.ids.mem, f.ids.tmp]); // repeats dropped, order kept
    expect(row.assignees.map((a: any) => [a.name, a.active])).toEqual([["موظف mem", true], ["موظف tmp", true]]);
    for (const who of ["mem", "tmp"]) {
      expect((await feed(who)).some((n) => n.kind === "task.assigned" && n.taskId === taskId)).toBe(true);
      expect(must(await q("tasks:mine", {}, who)).some((t: any) => t._id === taskId)).toBe(true);
      const mine = must(await q("tasks:get", { taskId }, who));
      expect(mine.isAssignee).toBe(true);
      expect(mine.canAttach).toBe(true);
    }
    // Not an assignee: the reader, and the manager who isn't one (still manages it).
    expect(must(await q("tasks:get", { taskId }, "rdr")).isAssignee).toBe(false);
    expect(must(await q("tasks:mine", {}, "mgr")).some((t: any) => t._id === taskId)).toBe(false);

    // Any assignee moves it forward and attaches; one shared status.
    must(await m("tasks:setStatus", { taskId, status: "inProgress" }, "tmp"));
    must(await m("tasks:addLink", { taskId, type: "file", id: f.files.S_plain }, "mem"));
    must(await m("notifications:markAllRead", {}, "mgr"));
    must(await m("tasks:setStatus", { taskId, status: "review" }, "mem"));
    expect((await feed("mgr")).some((n) => n.kind === "task.review" && n.taskId === taskId && !n.read)).toBe(true);
    // An assignee can't close it; the manager does, and every assignee hears.
    expect((await m("tasks:setStatus", { taskId, status: "done" }, "tmp")).ok).toBe(false);
    must(await m("tasks:setStatus", { taskId, status: "done" }, "mgr"));
    for (const who of ["mem", "tmp"]) expect((await feed(who)).some((n) => n.kind === "task.closed" && n.taskId === taskId)).toBe(true);
    must(await m("tasks:setStatus", { taskId, status: "inProgress" }, "mgr"));
    for (const who of ["mem", "tmp"]) expect((await feed(who)).some((n) => n.kind === "task.returned" && n.taskId === taskId)).toBe(true);

    // A comment by one assignee reaches the other assignee and the manager.
    must(await m("tasks:comment", { taskId, body: "أنهيت الجزء الأول MA01-C" }, "tmp"));
    expect((await feed("mem")).some((n) => n.kind === "task.comment" && n.body?.includes("MA01-C"))).toBe(true);
    expect((await feed("mgr")).some((n) => n.kind === "task.comment" && n.body?.includes("MA01-C"))).toBe(true);
    must(await m("tasks:remove", { taskId }, "mgr"));
    must(await m("spaces:removeMember", { spaceId: f.spaces.S_plain, userId: f.ids.tmp }, "mgr"));
  });

  test("assign sets the whole list: only the added are notified, the removed lose the task's work, one audit row says who", async () => {
    must(await m("spaces:addMember", { spaceId: f.spaces.S_plain, userId: f.ids.tmp, role: "member" }, "mgr"));
    const taskId = must(await m("tasks:create", { spaceId: f.spaces.S_plain, title: "إعادة-إسناد-MA02", assigneeIds: [f.ids.mem] }, "mgr")) as string;
    must(await m("notifications:markAllRead", {}, "mem"));
    must(await m("tasks:assign", { taskId, assigneeIds: [f.ids.mem, f.ids.tmp] }, "mgr"));
    expect((await feed("tmp")).some((n) => n.kind === "task.assigned" && n.taskId === taskId)).toBe(true);
    expect((await feed("mem")).some((n) => n.kind === "task.assigned" && n.taskId === taskId && !n.read)).toBe(false); // already on it
    // Same set again: nothing changes, nothing is logged.
    must(await m("tasks:assign", { taskId, assigneeIds: [f.ids.tmp, f.ids.mem] }, "mgr"));
    must(await m("tasks:assign", { taskId, assigneeIds: [f.ids.tmp] }, "mgr"));
    expect(must(await q("tasks:mine", {}, "mem")).some((t: any) => t._id === taskId)).toBe(false);
    expect(must(await q("tasks:get", { taskId }, "mem")).isAssignee).toBe(false); // still a member: views, can't work
    expect((await m("tasks:setStatus", { taskId, status: "inProgress" }, "mem")).ok).toBe(false);
    expect((await m("tasks:addLink", { taskId, type: "file", id: f.files.S_plain }, "mem")).ok).toBe(false);
    must(await m("tasks:setStatus", { taskId, status: "inProgress" }, "tmp"));

    const log = must(await q("audit:list", { spaceId: f.spaces.S_plain }, "mgr")).filter((r: any) => r.resourceId === taskId && r.action === "task.assign");
    expect(log.length).toBe(3); // created, +tmp, −mem
    const details = log.map((r: any) => r.detail);
    expect(details).toContainEqual(expect.objectContaining({ assigneeIds: `${f.ids.mem},${f.ids.tmp}`, added: f.ids.tmp, removed: null, from: f.ids.mem }));
    expect(details).toContainEqual(expect.objectContaining({ assigneeIds: f.ids.tmp, assigneeNames: "موظف tmp", added: null, removed: f.ids.mem }));
    must(await m("tasks:remove", { taskId }, "mgr"));
    must(await m("spaces:removeMember", { spaceId: f.spaces.S_plain, userId: f.ids.tmp }, "mgr"));
  });

  test("every assignee must be a manager or member; an empty or oversized list is refused; the old single assigneeId still works", async () => {
    const base = { spaceId: f.spaces.S_plain, title: "x" };
    expect((await m("tasks:create", { ...base, assigneeIds: [] }, "mgr")).ok).toBe(false);
    expect((await m("tasks:create", base, "mgr")).ok).toBe(false);
    expect((await m("tasks:create", { ...base, assigneeIds: Array(21).fill(f.ids.mem).map((x, i) => (i ? f.ids.mgr : x)) }, "mgr")).ok).toBe(true); // 21 entries, 2 people
    for (const target of ["out", "rdr", "pend", "dis", "admin"]) {
      expect((await m("tasks:create", { ...base, assigneeIds: [f.ids.mem, f.ids[target]] }, "mgr")).ok).toBe(false);
      expect((await m("tasks:assign", { taskId: f.tasks.S_plain, assigneeIds: [f.ids.mem, f.ids[target]] }, "mgr")).ok).toBe(false);
    }
    expect((await m("tasks:assign", { taskId: f.tasks.S_plain, assigneeIds: [] }, "mgr")).ok).toBe(false);
    expect(must(await q("tasks:get", { taskId: f.tasks.S_plain }, "mgr")).assigneeIds).toEqual([f.ids.mem]); // untouched
    const legacy = must(await m("tasks:create", { ...base, title: "قديم-MA03", assigneeId: f.ids.mem }, "mgr")) as string;
    expect(must(await q("tasks:get", { taskId: legacy }, "mem")).assigneeIds).toEqual([f.ids.mem]);
    for (const t of must(await q("tasks:board", { spaceId: f.spaces.S_plain }, "mgr"))) if (t.title === "x" || t.title === "قديم-MA03") must(await m("tasks:remove", { taskId: t._id }, "mgr"));
  });

  // Per actor: who may set a list of assignees, and who may then work on the task.
  for (const a of ACTORS) {
    const manages = a === "mgr";
    test(`tasks:create / tasks:assign with several assignees | ${a} → ${manages ? "allowed" : "denied"}`, async () => {
      const r = await m("tasks:create", { spaceId: f.spaces.S_plain, title: `قائمة-${a}`, assigneeIds: [f.ids.mem, f.ids.mgr] }, a);
      expect(r.ok).toBe(manages);
      if (r.ok) must(await m("tasks:remove", { taskId: r.value }, "mgr"));
      else if (!["pend", "dis", "anon"].includes(a)) expect(r.error).toContain(NOT_FOUND); // same answer as a missing space
      const re = await m("tasks:assign", { taskId: f.tasks.S_plain, assigneeIds: [f.ids.mem, f.ids.mgr] }, a);
      expect(re.ok).toBe(manages);
      if (re.ok) must(await m("tasks:assign", { taskId: f.tasks.S_plain, assigneeIds: [f.ids.mem] }, "mgr"));
    });
    // On a task assigned to mem and mgr: both work on it; readers, outsiders and inactive accounts can't.
    const works = a === "mem" || a === "mgr";
    test(`an assignee among several moves the task forward | ${a} → ${works ? "allowed" : "denied"}`, async () => {
      const taskId = must(await m("tasks:create", { spaceId: f.spaces.S_plain, title: `عمل-${a}`, assigneeIds: [f.ids.mem, f.ids.mgr] }, "mgr")) as string;
      expect((await m("tasks:setStatus", { taskId, status: "inProgress" }, a)).ok).toBe(works);
      const mine = await q("tasks:mine", {}, a);
      if (mine.ok) expect(mine.value.some((t: any) => t._id === taskId)).toBe(works);
      must(await m("tasks:remove", { taskId }, "mgr"));
    });
  }
});
