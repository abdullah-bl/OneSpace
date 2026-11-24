// tools/validate.ts: a model's tool arguments are checked against the tool's schema before the call
// runs, lightly repaired where the meaning is clear, and turned back with what to fix otherwise.

import { describe, expect, test } from "bun:test";
import { tools } from "../onebase/tools";
import { argProblemText, checkToolArgs, idsIn, repairIds } from "../onebase/tools/validate";

const t = (name: string) => tools[name]!;

describe("checkToolArgs", () => {
  test("valid arguments pass unchanged", () => {
    const r = checkToolArgs(t("read_file"), { fileId: "k1", pages: "3-5" });
    expect(r).toEqual({ args: { fileId: "k1", pages: "3-5" }, problems: [] });
  });

  test("a missing required field is named", () => {
    const r = checkToolArgs(t("read_file"), { pages: "2" });
    expect(r.problems).toEqual(["الحقل المطلوب fileId ناقص"]);
    expect(argProblemText(t("read_file"), r.problems)).toContain("الحقول المطلوبة: fileId");
  });

  test("clear slips are repaired: number→string, one value→list, JSON text→list, numeric text→number", () => {
    expect(checkToolArgs(t("read_file"), { fileId: "k1", pages: 2 }).args.pages).toBe("2");
    expect(checkToolArgs(t("search_documents"), { query: "x", spaces: "s1" }).args.spaces).toEqual(["s1"]);
    expect(checkToolArgs(t("search_documents"), { query: "x", spaces: '["s1","s2"]' }).args.spaces).toEqual(["s1", "s2"]);
    expect(checkToolArgs(t("query_records"), { limit: "20" }).args.limit).toBe(20);
    expect(checkToolArgs(t("read_tasks"), { includeDone: "true" }).args.includeDone).toBe(true);
  });

  test("null for an optional field is dropped; extra fields are left alone", () => {
    const r = checkToolArgs(t("read_file"), { fileId: "k1", pages: null, why: "x" });
    expect(r.problems).toEqual([]);
    expect(r.args).toEqual({ fileId: "k1", why: "x" });
  });

  test("enum, type and item counts are enforced, nested too", () => {
    expect(checkToolArgs(t("export_document"), { format: "xlsx" }).problems[0]).toContain('"docx"');
    expect(checkToolArgs(t("create_list"), { title: "x", columns: [] }).problems[0]).toContain("columns");
    expect(checkToolArgs(t("create_list"), { title: "x", columns: [{ name: "a", type: "colour" }] }).problems[0]).toContain("columns[0].type");
    expect(checkToolArgs(t("read_file"), { fileId: { id: "k1" } }).problems[0]).toContain("fileId");
  });

  test("arguments that weren't JSON are reported as such", () => {
    expect(checkToolArgs(t("read_file"), { __invalid: '{"fileId": "k1' }).problems[0]).toContain("JSON");
  });

  test("run_analysis needs code or a skill", () => {
    expect(checkToolArgs(t("run_analysis"), { fileIds: ["k1"] }).problems[0]).toContain("code");
    expect(checkToolArgs(t("run_analysis"), { fileIds: ["k1"], code: "print(1)" }).problems).toEqual([]);
    expect(checkToolArgs(t("run_analysis"), { fileIds: ["k1"], skill: "monthly" }).problems).toEqual([]);
  });

  test("every registered tool accepts a call with its required fields filled", () => {
    for (const tool of Object.values(tools)) {
      const p = tool.parameters as any;
      const args: Record<string, unknown> = {};
      for (const k of p.required ?? []) {
        const s = p.properties[k];
        args[k] = s.enum ? s.enum[0] : s.type === "array" ? [s.items?.type === "object" ? { name: "a", type: "text" } : "x"] : s.type === "object" ? {} : "x";
      }
      if (tool.name === "run_analysis") args.code = "print(1)";
      if (tool.name === "update_artifact") args.content = "نص";
      expect({ tool: tool.name, problems: checkToolArgs(tool, args).problems }).toEqual({ tool: tool.name, problems: [] });
    }
  });
});

describe("repairIds", () => {
  const known = idsIn(["- الموظفون.xlsx (معرّف: k17d4m2q8x3n5p6r9s0t)", "«قائمة» (listId=l3h5j7k9m2n4p6q8r0s1، 12 صف)"]);

  test("finds the ids the model was shown, in any surrounding text", () => {
    expect([...known].sort()).toEqual(["k17d4m2q8x3n5p6r9s0t", "l3h5j7k9m2n4p6q8r0s1"]);
  });

  test("a slipped copy (the one seen in the bench) is put back, nested too", () => {
    const r = repairIds({ fileIds: ["k17d4m2q8x3n5p6r9s0r9s0t"], listId: "l3h5j7k9m2n4p6q8r0s" }, known);
    expect(r.args).toEqual({ fileIds: ["k17d4m2q8x3n5p6r9s0t"], listId: "l3h5j7k9m2n4p6q8r0s1" });
    expect(r.fixed.length).toBe(2);
  });

  test("known ids, far-off ids, numbers and ordinary text are left alone", () => {
    const args = { a: "k17d4m2q8x3n5p6r9s0t", b: "zzzzzzzzzz9999999999", c: "12345678901234567890", d: "مدة الإجازة", e: 5 };
    expect(repairIds(args, known)).toEqual({ args, fixed: [] });
  });

  test("an id equally close to two shown ids is left alone", () => {
    const two = new Set(["aaaaaaaaaa1111111111", "aaaaaaaaaa1111111122"]);
    expect(repairIds({ id: "aaaaaaaaaa1111111112" }, two).fixed).toEqual([]);
  });
});

test("update_artifact with neither content nor a column change is turned back before it runs", () => {
  const t = tools.update_artifact!;
  expect(checkToolArgs(t, { artifactId: "x", note: "n" }).problems.join()).toContain("renameColumns");
  expect(checkToolArgs(t, { artifactId: "x", renameColumns: { أ: "ب" } }).problems).toEqual([]);
  expect(checkToolArgs(t, { artifactId: "x", table: { columns: ["أ"], rows: [] } }).problems).toEqual([]);
});
