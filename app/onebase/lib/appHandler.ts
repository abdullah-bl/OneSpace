// An app's server-side handler (plans/13 §3): server/<name>.py with def handle(request), run in the
// sandbox (no network, a fresh container) with the app's private server/ files under /input. The
// request is the visitor's payload (untrusted), who they are, and whether this is a test. The
// handler returns { response, rows }; rows are written by apps.ts only within the page's grants.

import { callSandbox, SandboxUnavailable } from "./sandboxClient";
import { APP_LIMITS, isPrivate } from "./appFiles";

export const HANDLER_LIMITS = { timeoutMs: 10_000, memoryMb: 256, cpus: 1, pids: 32, outputMb: 1 };
const MARK = "__ONESPACE_RESULT__";

/** The fixed wrapper: loads the handler from /input, calls handle(request), prints one marked JSON line. */
export const HANDLER_WRAPPER = `import json, sys, importlib.util, traceback
with open("/input/__request.json", encoding="utf-8") as f:
    request = json.load(f)
name = request.pop("__handler")
spec = importlib.util.spec_from_file_location("handler_" + name, "/input/" + name + ".py")
mod = importlib.util.module_from_spec(spec)
sys.path.insert(0, "/input")
import os
os.chdir("/input")
try:
    spec.loader.exec_module(mod)
    out = mod.handle(request)
except Exception:
    traceback.print_exc()
    sys.exit(1)
if not isinstance(out, dict) or ("response" not in out and "rows" not in out):
    out = {"response": out, "rows": []}
print("${MARK}" + json.dumps(out, ensure_ascii=False, default=str))
`;

export type HandlerRequest = { payload: unknown; visitor: { signedIn: boolean; name: string | null; rows: number }; test: boolean };
export type HandlerOutcome =
  | { ok: true; response: unknown; rows: { list: string; cells: Record<string, unknown> }[]; durationMs: number; stdout: string }
  | { ok: false; error: string; trace: string; durationMs: number };

export async function runHandler(files: Record<string, string>, name: string, request: HandlerRequest): Promise<HandlerOutcome> {
  const started = Date.now();
  if (!files[`server/${name}.py`]) return { ok: false, error: `لا يوجد معالج server/${name}.py`, trace: "", durationMs: 0 };
  const input: { name: string; b64: string }[] = [];
  for (const [p, c] of Object.entries(files)) if (isPrivate(p)) input.push({ name: p.slice("server/".length), b64: Buffer.from(c).toString("base64") });
  input.push({ name: "__request.json", b64: Buffer.from(JSON.stringify({ ...request, __handler: name })).toString("base64") });
  let res;
  try {
    res = await callSandbox({ code: HANDLER_WRAPPER, files: input, limits: HANDLER_LIMITS });
  } catch (e) {
    return { ok: false, error: e instanceof SandboxUnavailable ? e.message : "تعذّر تشغيل المعالج", trace: "", durationMs: Date.now() - started };
  }
  const durationMs = Date.now() - started;
  const line = (res.stdout ?? "").split("\n").reverse().find((l) => l.startsWith(MARK));
  if (!res.ok || !line) {
    const why = res.timedOut ? "تجاوز المعالج 10 ثوانٍ" : res.oomKilled ? "تجاوز المعالج حد الذاكرة" : res.error ?? "فشل المعالج";
    return { ok: false, error: why, trace: `${(res.stderr ?? "").slice(-4000)}${line ? "" : res.ok ? "\n(لم يُرجع handle قيمة قابلة للتحويل إلى JSON)" : ""}`.trim(), durationMs };
  }
  let out: any;
  try {
    out = JSON.parse(line.slice(MARK.length));
  } catch {
    return { ok: false, error: "مخرج المعالج ليس JSON", trace: line.slice(0, 500), durationMs };
  }
  const rows = Array.isArray(out?.rows) ? out.rows : [];
  if (rows.length > APP_LIMITS.handlerRows) return { ok: false, error: `المعالج أرجع أكثر من ${APP_LIMITS.handlerRows} صفاً`, trace: "", durationMs };
  const clean = [];
  for (const r of rows) {
    if (!r || typeof r !== "object" || typeof r.list !== "string" || !r.cells || typeof r.cells !== "object") return { ok: false, error: 'كل صف من المعالج: {"list": "<الاسم>", "cells": {...}}', trace: JSON.stringify(r).slice(0, 300), durationMs };
    clean.push({ list: r.list, cells: r.cells as Record<string, unknown> });
  }
  const stdout = (res.stdout ?? "").split("\n").filter((l) => !l.startsWith(MARK)).join("\n").trim();
  return { ok: true, response: out?.response ?? null, rows: clean, durationMs, stdout };
}
