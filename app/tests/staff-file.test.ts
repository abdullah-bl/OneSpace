// plans/17 §2: national ids / employee numbers from a staff file. Matching by email, what the
// preview reports, what apply changes (and never clears), and that only the workspace admin can.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Server, must } from "./harness";
import { ACTORS, buildFixture, type Fixture } from "./fixture";
import { buildOutputs, IDS, xlsxBase64 } from "./outputsFixture";

let s: Server;
let f: Fixture;

beforeAll(async () => {
  s = await new Server().start();
  f = await buildFixture(s);
  await buildOutputs(s, f); // mem, out, rdr get national ids
}, 120_000);

afterAll(async () => {
  await s?.stop();
});

const T = (k: string) => (f.tokens as any)[k] as string | undefined;
const HEAD = ["الاسم", "البريد الإلكتروني", "رقم الهوية", "الرقم الوظيفي"];
const user = async (k: string) => must(await s.call("query", "admin:users", {}, T("admin"))).find((u: any) => u._id === f.ids[k]);

describe("staffFile: from the file the admin already has", () => {
  test("analyze guesses the columns, matches by email (any case) and reports every row; writes nothing", async () => {
    const data = await xlsxBase64(HEAD, [
      ["مدير", f.emails.mgr!.toUpperCase(), "1111111111", "E-100"],
      ["عضو", f.emails.mem, IDS.mem, ""], // already set, no employee number given
      ["قارئ", f.emails.rdr, IDS.out, "E-200"], // out's id: conflict
      ["غريب", "nobody@onespace.test", "5555555555", ""],
      ["بلا بريد", "", "6666666666", ""],
      ["مكرر", f.emails.tmp, "7777777777", "E-300"],
      ["مكرر", f.emails.out, "7777777777", ""], // same id for two emails
      ["صاحب الرقم", f.emails.out, IDS.out, "E-400"], // out holds this id: not blocked by row 4
    ]);
    const a = must(await s.call("action", "staffFile:analyze", { dataBase64: data }, T("admin")));
    expect(a.ok).toBe(true);
    expect(a.mapping).toEqual({ email: "البريد الإلكتروني", nationalId: "رقم الهوية", employeeNo: "الرقم الوظيفي" });
    expect(a.rows.map((r: any) => [r.rowNo, r.status])).toEqual([
      [2, "set"],
      [3, "same"],
      [4, "conflict"],
      [5, "notFound"],
      [6, "invalid"],
      [7, "conflict"],
      [8, "conflict"],
      [9, "invalid"], // out's email twice in the file
    ]);
    expect(a.rows[0]).toMatchObject({ nationalId: "1111111111", employeeNo: "E100", name: "موظف mgr" });
    expect(a.counts).toEqual({ set: 1, same: 1, notFound: 1, conflict: 3, invalid: 2 });
    expect((await user("mgr")).nationalId).toBeNull();
  });

  test("apply sets the clean rows only, never clears a number, and audits each change", async () => {
    const data = await xlsxBase64(HEAD, [
      ["مدير", f.emails.mgr, "1111111111", "E-100"],
      ["عضو", f.emails.mem, "", "E-101"], // keeps mem's national id
      ["قارئ", f.emails.rdr, IDS.out, ""],
    ]);
    const mapping = { email: "البريد الإلكتروني", nationalId: "رقم الهوية", employeeNo: "الرقم الوظيفي" };
    const r = must(await s.call("action", "staffFile:apply", { dataBase64: data, mapping, fileName: "staff.xlsx" }, T("admin")));
    expect(r).toEqual({ set: 2, unchanged: 0, skipped: 1 });
    expect(await user("mgr")).toMatchObject({ nationalId: "1111111111", employeeNo: "E100" });
    expect(await user("mem")).toMatchObject({ nationalId: IDS.mem, employeeNo: "E101" });
    expect((await user("rdr")).nationalId).toBe(IDS.rdr);
    const again = must(await s.call("action", "staffFile:apply", { dataBase64: data, mapping, fileName: "staff.xlsx" }, T("admin")));
    expect(again).toEqual({ set: 0, unchanged: 2, skipped: 1 });
  });

  test("a number twice in the file blocks only the row whose account doesn't hold it", async () => {
    const data = await xlsxBase64(HEAD, [
      ["قارئ", f.emails.rdr, IDS.out, ""],
      ["صاحب الرقم", f.emails.out, IDS.out, "E-400"],
    ]);
    const a = must(await s.call("action", "staffFile:analyze", { dataBase64: data }, T("admin")));
    expect(a.rows.map((r: any) => [r.status, r.reason])).toEqual([
      ["conflict", "رقم الهوية مكرر لأكثر من بريد في الملف"],
      ["set", null],
    ]);
  });

  test("a mapping that misses the email or every number column is refused with a reason", async () => {
    const data = await xlsxBase64(HEAD, [["x", f.emails.mem, IDS.mem, ""]]);
    const a = must(await s.call("action", "staffFile:analyze", { dataBase64: data, mapping: { email: "البريد الإلكتروني", nationalId: null, employeeNo: null } }, T("admin")));
    expect(a).toMatchObject({ ok: false, errors: ["اختر عمود رقم الهوية أو الرقم الوظيفي"] });
    const r = await s.call("action", "staffFile:apply", { dataBase64: data, mapping: { email: "", nationalId: "رقم الهوية", employeeNo: null }, fileName: "x" }, T("admin"));
    expect(r.ok).toBe(false);
  });
});

describe("staffFile: workspace admin only", () => {
  for (const a of ACTORS) {
    test(`staffFile:analyze + staffFile:apply | ${a} → ${a === "admin" ? "allowed" : "denied"}`, async () => {
      const data = await xlsxBase64(HEAD, [["x", f.emails.out, IDS.out, ""]]);
      const mapping = { email: "البريد الإلكتروني", nationalId: "رقم الهوية", employeeNo: null };
      expect((await s.call("action", "staffFile:analyze", { dataBase64: data }, T(a))).ok).toBe(a === "admin");
      expect((await s.call("action", "staffFile:apply", { dataBase64: data, mapping, fileName: "x" }, T(a))).ok).toBe(a === "admin");
    });
  }
});
