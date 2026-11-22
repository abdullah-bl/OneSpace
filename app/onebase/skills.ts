// The user's own skills ("/" in the chat box, plans/07). A skill is instructions the user owns —
// a way of doing a task ("خطاب رسمي بصيغتنا", "تحليل سجل الغياب") — applied to one question with
// /name. Agents stay automatic (the router picks the agent by the kind of task); a skill only adds
// the user's own instructions to that answer. It never grants a tool, a space or a file: what the
// answer may touch is still the agent's scope ∩ what the user can read.
//
// The AI can draft a skill from a finished chat (draftFromThread): it returns a draft for the user
// to review and save; nothing is stored until they do.
//
// A skill saved from a chat also keeps what made the answer (plans/09 §2, captureFiles): the
// Python that ran successfully there (rerun as is on new files, so numbers come from the same
// code) and the last output the assistant wrote (its shape is kept next time). Nothing from a
// sensitive space leaves it this way.

import { OneBaseError, v } from "onebase/values";
import type { Doc, Id } from "./_generated/dataModel";
import { threadMessages } from "./lib/threadMessages";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { actorFor, assertCan, Denied, requireActive, requireUserId, threadAllows } from "./access";
import { chat, primeAi } from "./ai";
import { writeAudit } from "./audit";
import { guardSkill } from "./decisions";
import { maskSecrets } from "./lib/secrets";
import { IMPORT_LIMITS, parseSkillPackage, SkillImportError } from "./lib/skillImport";
import { parseApp } from "./lib/appFiles";

export const NAME_RE = /^[\p{L}\p{N}_-]{2,40}$/u;
const TITLE_MAX = 80;
const DESCRIPTION_MAX = 300;
const INSTRUCTIONS_MAX = 16000;
const MAX_SKILLS = 100;

type Input = { name: string; title: string; description: string; instructions: string };
export type SkillFile = { name: string; kind: "script" | "example" | "reference"; content: string; inputs?: string[] };

const MAX_FILES = 4; // kept from a chat (scripts and an example)
/** An imported skill (SKILL.md / .zip): its files, checked again here whatever the client sent. */
const IMPORT_MAX_FILES = IMPORT_LIMITS.files + 1;
const SCRIPT_MAX = 50_000;
const EXAMPLE_MAX = 20_000;
const APP_SKILL_MAX = 200_000;

function clean(i: Input): Input {
  const name = String(i.name ?? "").trim().replace(/^\//, "").replace(/\s+/g, "-");
  if (!NAME_RE.test(name)) throw new OneBaseError("اسم المهارة من 2 إلى 40 حرفاً أو رقماً، بلا مسافات (يُكتب بعد /)");
  const title = String(i.title ?? "").trim().slice(0, TITLE_MAX) || name;
  const description = String(i.description ?? "").trim().slice(0, DESCRIPTION_MAX);
  const instructions = String(i.instructions ?? "").trim();
  if (!instructions) throw new OneBaseError("اكتب تعليمات المهارة");
  if (instructions.length > INSTRUCTIONS_MAX) throw new OneBaseError(`التعليمات أطول من ${INSTRUCTIONS_MAX} حرف`);
  return { name, title, description, instructions };
}

async function nameTaken(ctx: QueryCtx | MutationCtx, ownerId: Id<"users">, name: string, except?: Id<"skills">) {
  const rows = await ctx.db
    .query("skills")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId).eq("name", name))
    .collect();
  return rows.some((r) => !r.spaceId && r._id !== except);
}

/** My own personal skills (a space skill I wrote belongs to the space, not to «مهاراتي»). */
async function personalOf(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  return (await ctx.db.query("skills").withIndex("by_owner", (q) => q.eq("ownerId", userId)).collect()).filter((s) => !s.spaceId);
}

async function mine(ctx: QueryCtx | MutationCtx, userId: Id<"users">, skillId: string): Promise<Doc<"skills">> {
  const id = ctx.db.normalizeId("skills", skillId);
  const s = id ? await ctx.db.get(id) : null;
  if (!s || s.ownerId !== userId || s.spaceId) throw new Denied();
  return s;
}

function shape(s: Doc<"skills">) {
  return { _id: s._id, name: s.name, title: s.title, description: s.description, instructions: s.instructions, source: s.source, uses: s.uses, updatedAt: s.updatedAt, files: s.files ?? [] };
}

/** Keep only the named files (the editor's «احذف الملف»); unknown names are ignored. */
function keepOnly(files: SkillFile[] | undefined, keep: string[] | undefined): SkillFile[] | undefined {
  if (!keep) return files;
  const k = new Set(keep);
  return (files ?? []).filter((f) => k.has(f.name));
}

// ---------------------------------------------------------------- files kept from the chat

const reEscape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The script as it ran, with its input file names replaced by INPUTS[i], so it runs on whatever
 * files are passed next time (run_analysis defines INPUTS, in fileIds order).
 */
export function generalizeInputs(code: string, names: string[]): string {
  let out = code;
  names.forEach((n, i) => {
    const e = reEscape(n);
    out = out.replace(new RegExp(`([rbuf]?)(["'])/input/${e}\\2`, "g"), (m, pre) => (pre.includes("f") ? m : `INPUTS[${i}]`));
    out = out.replace(new RegExp(`([rbuf]?)(["'])${e}\\2`, "g"), (m, pre) => (pre.includes("f") ? m : `INPUTS[${i}]`));
  });
  return out;
}

/** Python that sets INPUTS: the paths of this run's files, in the order they were passed. */
export function inputsPreamble(names: string[]): string {
  return `INPUTS = [${names.map((n) => JSON.stringify(`/input/${n}`)).join(", ")}]  # files of this run, in order\n`;
}

/**
 * What a skill saved from this chat carries: the successful sandbox runs (the given ones, else the
 * last) and the last output the assistant wrote itself (not a run's data table). Anything built on
 * a sensitive space is kept only when the skill belongs to that same space.
 */
async function captureFiles(ctx: QueryCtx | MutationCtx, userId: Id<"users">, threadId: string, targetSpaceId: Id<"spaces"> | null, runIds?: string[]): Promise<SkillFile[]> {
  const sensitive = new Map<string, boolean>();
  const blocked = async (spaceId: string | undefined) => {
    if (!spaceId) return false;
    if (!sensitive.has(spaceId)) {
      const id = ctx.db.normalizeId("spaces", spaceId);
      const sp = id ? await ctx.db.get(id) : null;
      sensitive.set(spaceId, !sp || !!sp.sensitive);
    }
    return sensitive.get(spaceId)! && spaceId !== targetSpaceId;
  };
  const files: SkillFile[] = [];
  const runs = (await ctx.db.query("runs").withIndex("by_user", (q) => q.eq("userId", userId)).order("desc").take(300)).filter(
    (r) => r.threadId === threadId && r.status === "done" && r.exit?.code === 0 && !!r.code,
  );
  let picked = runIds?.length ? runIds.map((id) => runs.find((r) => r._id === id)).filter((r) => !!r) : runs.slice(0, 1);
  picked = picked.filter((r, i) => picked.findIndex((x) => x.codeHash === r.codeHash) === i).slice(0, MAX_FILES - 1);
  // Oldest first, so the scripts read in the order they ran.
  picked.sort((a, b) => a.createdAt - b.createdAt);
  for (const r of picked) {
    if ((await blocked(r.spaceId)) || (await Promise.all(r.inputs.map((i) => blocked(i.spaceId)))).some(Boolean)) continue;
    const inputs = r.inputs.map((i) => i.name);
    const code = maskSecrets(generalizeInputs(r.skill ? r.code!.replace(/^INPUTS = .*\n/, "") : r.code!, inputs));
    if (code.length > SCRIPT_MAX) continue;
    files.push({ name: files.length ? `script-${files.length + 1}.py` : "script.py", kind: "script", content: code, inputs });
  }
  const arts = (await ctx.db.query("artifacts").withIndex("by_owner", (q) => q.eq("ownerId", userId)).collect())
    .filter((a) => a.sourceThreadId === threadId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const a of arts) {
    if (a.classification === "sensitive" && (a.originSpaceId ?? a.spaceId) !== targetSpaceId) continue;
    if (await blocked(a.spaceId)) continue;
    const ver = await ctx.db.query("artifactVersions").withIndex("by_artifact_version", (q) => q.eq("artifactId", a._id).eq("version", a.currentVersion)).unique();
    if (!ver || ver.runId) continue; // a run's output is data; its script already makes that shape
    if (a.kind === "app") {
      // An app (plans/13 §7): its files and handlers (server/ included), to rebuild the same kind of
      // app with write_app fromSkill. Its grants aren't kept: a new app gets its own lists.
      let total = 0;
      for (const [path, content] of Object.entries(parseApp(ver.content).files)) {
        total += content.length;
        if (total > APP_SKILL_MAX) break;
        files.push({ name: `app/${path}`, kind: "reference", content: maskSecrets(content) });
      }
      break;
    }
    const ext = a.kind === "html" ? "html" : a.kind === "table" ? "csv" : "md";
    files.push({ name: `example.${ext}`, kind: "example", content: maskSecrets(ver.content).slice(0, EXAMPLE_MAX) });
    break;
  }
  return files;
}

/** How a skill's files are put to the model (use_skill and a /name question): run the scripts as saved, keep the example's shape. */
export function skillFilesText(name: string, files: SkillFile[] | undefined): string {
  const parts: string[] = [];
  const all = files ?? [];
  const scripts = all.filter((f) => f.kind === "script");
  // A few short scripts (kept from a chat) are shown; an imported package's are listed and loaded on demand.
  const inline = scripts.length <= 2 && scripts.every((f) => f.content.length <= 6000);
  for (const f of scripts) {
    const ins = f.inputs?.length ? `كُتب على: ${f.inputs.join("، ")}؛ ` : "";
    parts.push(
      `سكربت محفوظ ${f.name} (${ins}INPUTS = مسارات الملفات بالترتيب). شغّله كما هو: run_analysis مع skill="${name}" و script="${f.name}" و fileIds للملفات الجديدة بنفس الترتيب، بدل كتابة كود جديد. لا تعِد كتابته ولا تنسخه في code.` +
        (inline ? ` للاطلاع فقط:\n\`\`\`python\n${f.content}\n\`\`\`` : ` لقراءته: use_skill مع name="${name}" و file="${f.name}".`),
    );
  }
  const app = all.filter((f) => f.name.startsWith("app/"));
  if (app.length)
    parts.push(
      `تطبيق محفوظ في المهارة (${app.length} ملفات: ${app.map((f) => f.name.slice(4)).join("، ")}). لبناء تطبيق من نوعه: write_app مع fromSkill="${name}" ينسخ ملفاته (ومعالجاته في server/)، ثم اقرأه بـ read_app وغيّر ما يخص الطلب الجديد (المحتوى، الأسئلة، المفتاح، النصوص)، وأنشئ قوائمه من جديد واربطها بـ data، ثم test_app.`,
    );
  for (const f of all.filter((x) => x.kind === "example")) parts.push(`نموذج المخرج ${f.name}: حافظ على بنيته وعناوينه وترتيبه وتنسيقه، والمحتوى من الطلب الجديد:\n\n${f.content}`);
  const refs = all.filter((f) => !f.name.startsWith("app/") && (f.kind === "reference" || (f.kind === "script" && !f.name.endsWith(".py"))));
  if (refs.length)
    parts.push(
      `ملفات مرجعية للمهارة (لا تحمّل إلا ما تحتاجه للطلب، بأداة use_skill مع name="${name}" و file=اسم الملف):\n` + refs.map((f) => `- ${f.name} (${f.content.length} حرفاً)`).join("\n"),
    );
  return parts.join("\n\n---\n\n");
}

/** Imported files as the client sent them, checked: kinds, clean names, sizes, count; secrets masked. */
function cleanImportFiles(files: { name: string; kind: string; content: string }[]): SkillFile[] {
  if (files.length > IMPORT_MAX_FILES) throw new OneBaseError(`الحد ${IMPORT_LIMITS.files} ملفاً للمهارة`);
  const seen = new Set<string>();
  const out: SkillFile[] = [];
  let total = 0;
  for (const f of files) {
    const name = String(f.name ?? "").replace(/\\/g, "/").split("/").filter((x) => x && x !== "." && x !== "..").join("/").slice(0, 200);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const kind = f.kind === "script" || f.kind === "example" ? f.kind : "reference";
    const content = maskSecrets(String(f.content ?? "")).slice(0, IMPORT_LIMITS.fileChars);
    total += content.length;
    if (total > IMPORT_LIMITS.totalChars) throw new OneBaseError("ملفات المهارة أكبر من المسموح");
    out.push({ name, kind: kind === "script" && !name.endsWith(".py") ? "reference" : kind, content });
  }
  return out;
}

/** The thread to learn from, if it is the user's own. */
async function ownThread(ctx: QueryCtx | MutationCtx, userId: Id<"users">, threadId: string | undefined) {
  if (!threadId) return undefined;
  const meta = await ctx.db.query("threadMeta").withIndex("by_thread", (q) => q.eq("threadId", threadId)).unique();
  return meta?.userId === userId ? threadId : undefined;
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireActive(ctx);
    const rows = await personalOf(ctx, me.userId);
    return rows.sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name, "ar")).map(shape);
  },
});

type InsertArgs = Input & { fromThreadId?: string; runIds?: string[]; files?: SkillFile[] };

async function insertSkill(ctx: MutationCtx, userId: Id<"users">, a: InsertArgs) {
  const c = clean(a);
  if (await nameTaken(ctx, userId, c.name)) throw new OneBaseError(`لديك مهارة باسم /${c.name}`);
  const count = (await personalOf(ctx, userId)).length;
  if (count >= MAX_SKILLS) throw new OneBaseError(`الحد ${MAX_SKILLS} مهارة`);
  const fromThreadId = await ownThread(ctx, userId, a.fromThreadId);
  const files = a.files ?? (fromThreadId ? await captureFiles(ctx, userId, fromThreadId, null, a.runIds) : []);
  const now = Date.now();
  const id = await ctx.db.insert("skills", { ownerId: userId, ...c, source: fromThreadId ? "chat" : "manual", fromThreadId, uses: 0, createdAt: now, updatedAt: now, ...(files.length ? { files } : {}) });
  await writeAudit(ctx, { userId, action: "skill.create", resourceType: "skill", resourceId: id, detail: { name: c.name, source: fromThreadId ? "chat" : "manual", files: files.map((f) => f.name).join(", ") } });
  return { id, name: c.name, files: files.map((f) => f.name) };
}

const importedFilesV = v.optional(v.array(v.object({ name: v.string(), kind: v.string(), content: v.string() })));

export const create = mutation({
  args: { name: v.string(), title: v.string(), description: v.string(), instructions: v.string(), fromThreadId: v.optional(v.string()), files: importedFilesV },
  handler: async (ctx, { files, ...a }) => {
    const me = await requireActive(ctx);
    return (await insertSkill(ctx, me.userId, { ...a, ...(files ? { files: cleanImportFiles(files) } : {}) })).id;
  },
});

/** Actions can't read the database: an active employee only (pending and disabled accounts can't). */
export const assertActive = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    if (!(await actorFor(ctx, userId))) throw new Denied();
  },
});

/**
 * «استيراد مهارة»: a SKILL.md or a .zip of a skill's folder (skills.sh, GitHub) read into a draft for
 * the person to review; nothing is saved here (create / addSpace save it).
 */
export const parseImport = action({
  args: { fileName: v.string(), dataBase64: v.string() },
  handler: async (ctx, { fileName, dataBase64 }) => {
    const userId = await requireUserId(ctx);
    await ctx.runQuery(internal.skills.assertActive, { userId });
    if (dataBase64.length > IMPORT_LIMITS.zipBytes * 1.4) throw new OneBaseError(`الملف أكبر من ${IMPORT_LIMITS.zipBytes / 1024 / 1024} م.ب`);
    if (!/\.(zip|md|markdown)$/i.test(fileName)) throw new OneBaseError("اختر ملف SKILL.md أو ملف zip لمجلد المهارة");
    let r: ReturnType<typeof parseSkillPackage>;
    try {
      r = parseSkillPackage(fileName, new Uint8Array(Buffer.from(dataBase64, "base64")));
    } catch (e) {
      if (e instanceof SkillImportError) throw new OneBaseError(e.message);
      throw new OneBaseError("تعذّرت قراءة الملف");
    }
    const draft = { ...r, instructions: maskSecrets(r.instructions), files: r.files.map((f) => ({ ...f, content: maskSecrets(f.content) })) };
    // plans/12: text in the skill aimed at taking over the assistant is shown above «احفظ المهارة».
    // The person decides; the skill stays instructions only, whatever the guard says.
    await primeAi(ctx);
    const steering = await guardSkill(draft.instructions, draft.files.filter((f) => f.kind !== "script"), { ctx, userId });
    return { ...draft, steering };
  },
});

/** The create_skill tool: same checks, as the turn's user; errors come back for the model to fix. */
export const createFromTool = internalMutation({
  args: {
    userId: v.id("users"),
    name: v.string(),
    title: v.string(),
    description: v.string(),
    instructions: v.string(),
    threadId: v.optional(v.string()),
    spaceId: v.optional(v.string()),
    runIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { userId, threadId, spaceId, ...a }) => {
    try {
      if (spaceId) {
        const r = await insertSpaceSkill(ctx, userId, spaceId, { ...a, fromThreadId: threadId });
        return { ok: true as const, id: r.id as string, name: r.name, state: r.state, space: r.space, files: r.files };
      }
      const r = await insertSkill(ctx, userId, { ...a, fromThreadId: threadId });
      return { ok: true as const, id: r.id as string, name: r.name, state: "active" as const, space: null, files: r.files };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  },
});

/** «تراجع» for a skill the assistant saved: removes it if it is still mine. */
export async function undoSkills(ctx: MutationCtx, userId: Id<"users">, ids: string[]) {
  for (const raw of ids) {
    const id = ctx.db.normalizeId("skills", raw);
    const s = id ? await ctx.db.get(id) : null;
    if (s && s.ownerId === userId && (!s.spaceId || s.state === "proposed")) {
      await ctx.db.delete(s._id);
      await writeAudit(ctx, { userId, action: "skill.delete", resourceType: "skill", resourceId: s._id, detail: { name: s.name, via: "undo" } });
    }
  }
}

export const update = mutation({
  args: { skillId: v.string(), name: v.string(), title: v.string(), description: v.string(), instructions: v.string(), keepFiles: v.optional(v.array(v.string())) },
  handler: async (ctx, { skillId, keepFiles, ...a }) => {
    const me = await requireActive(ctx);
    const s = await mine(ctx, me.userId, skillId);
    const c = clean(a);
    if (await nameTaken(ctx, me.userId, c.name, s._id)) throw new OneBaseError(`لديك مهارة باسم /${c.name}`);
    await ctx.db.patch(s._id, { ...c, files: keepOnly(s.files, keepFiles), updatedAt: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: "skill.update", resourceType: "skill", resourceId: s._id, detail: { name: c.name } });
  },
});

export const remove = mutation({
  args: { skillId: v.string() },
  handler: async (ctx, { skillId }) => {
    const me = await requireActive(ctx);
    const s = await mine(ctx, me.userId, skillId);
    await ctx.db.delete(s._id);
    await writeAudit(ctx, { userId: me.userId, action: "skill.delete", resourceType: "skill", resourceId: s._id, detail: { name: s.name } });
  },
});

/**
 * The skill a question uses (chat.send and the turn): one of mine, or an active skill of the chat's
 * own shared space that I can read. Anything else answers like a missing skill.
 */
export async function ownSkill(ctx: QueryCtx | MutationCtx, userId: Id<"users">, skillId: string | undefined, spaceId?: Id<"spaces"> | null) {
  if (!skillId) return null;
  const id = ctx.db.normalizeId("skills", skillId);
  const s = id ? await ctx.db.get(id) : null;
  if (s && !s.spaceId && s.ownerId === userId) return s;
  if (s && s.spaceId && s.state === "active" && spaceId && s.spaceId === spaceId) {
    await spaceRole(ctx, userId, s.spaceId);
    return s;
  }
  throw new Denied();
}

// ---------------------------------------------------------------- AI drafts

/** The chat to learn from: only my own thread, its recent messages. */
export const threadForDraft = internalQuery({
  args: { userId: v.id("users"), threadId: v.string() },
  handler: async (ctx, { userId, threadId }) => {
    const meta = await ctx.db.query("threadMeta").withIndex("by_thread", (q) => q.eq("threadId", threadId)).unique();
    if (!meta || meta.userId !== userId) throw new Denied();
    const msgs = (await threadMessages(ctx, threadId)).filter((m) => (m.role === "user" || m.role === "assistant") && m.text).slice(-30);
    const names = (await personalOf(ctx, userId)).map((s) => s.name);
    return { title: meta.title, summary: meta.summary?.text ?? null, msgs: msgs.map((m) => ({ role: m.role, text: m.text!.slice(0, 2000) })), taken: names };
  },
});

const DRAFT_PROMPT = `أنت تكتب «مهارة» لموظف: تعليمات قصيرة يعيد استخدامها لاحقاً بكتابة /الاسم قبل طلب مشابه.
اقرأ المحادثة واستخرج منها طريقة العمل التي يريدها هذا الموظف: نوع المهمة، الخطوات، الصيغة والأسلوب، ما فضّله أو صحّحه، وما يجب تجنبه.
- اكتب التعليمات بصيغة الأمر للمساعد («اكتب…»، «ابدأ بـ…»، «لا تذكر…»)، عامة تصلح لطلبات مشابهة، لا لهذه المحادثة وحدها.
- لا تضع فيها بيانات شخصية ولا أرقاماً أو أسماء خاصة بهذه المحادثة إلا إن كانت جزءاً ثابتاً من طريقة العمل.
- name: كلمة أو كلمتان بلا مسافات (استخدم - بينها)، بالعربية أو الإنجليزية.
- description: جملة تقول متى تُستخدم.
أعد JSON فقط.`;

export const draftFromThread = action({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }): Promise<Input> => {
    await primeAi(ctx);
    const userId = await requireUserId(ctx);
    const t = await ctx.runQuery(internal.skills.threadForDraft, { userId, threadId });
    if (!t.msgs.some((m) => m.role === "assistant")) throw new OneBaseError("لا توجد إجابات في هذه المحادثة بعد");
    const convo = t.msgs.map((m) => `${m.role === "user" ? "الموظف" : "المساعد"}: ${m.text}`).join("\n\n");
    const res = await chat({
      track: { ctx, purpose: "skill_draft", userId },
      role: "main",
      temperature: 0.2,
      maxTokens: 6000,
      messages: [
        { role: "system", content: DRAFT_PROMPT },
        { role: "user", content: `${t.summary ? `ملخص الجزء الأقدم: ${t.summary}\n\n` : ""}عنوان المحادثة: ${t.title}\n\n${convo}` },
      ],
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["name", "title", "description", "instructions"],
        properties: { name: { type: "string" }, title: { type: "string" }, description: { type: "string" }, instructions: { type: "string" } },
      },
    });
    let d: Input;
    try {
      d = JSON.parse(res.text.trim().replace(/^```(?:json)?|```$/g, ""));
    } catch {
      console.error(`skills:draftFromThread: unparsable draft (finish ${res.finishReason}, ${res.text.length} chars)`);
      throw new OneBaseError(res.finishReason === "length" ? "المحادثة أطول من أن تُلخَّص في مهارة دفعة واحدة. جرّب «مهارة جديدة» والصق التعليمات بنفسك." : "تعذّر تجهيز المسودة، حاول مرة أخرى");
    }
    // A usable, free /name: cleaned, and suffixed if the user already has one like it.
    let name = String(d.name ?? "").trim().replace(/^\//, "").replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 36) || "مهارة";
    if (name.length < 2) name = `مهارة-${name}`;
    const base = name;
    for (let i = 2; t.taken.includes(name); i++) name = `${base}-${i}`;
    return {
      name,
      title: String(d.title ?? "").slice(0, TITLE_MAX),
      description: String(d.description ?? "").slice(0, DESCRIPTION_MAX),
      instructions: String(d.instructions ?? "").slice(0, INSTRUCTIONS_MAX),
    };
  },
});

// ---------------------------------------------------------------- «مهارات المساحة» (plans/09 §2)

const MAX_SPACE_SKILLS = 100;
/** Index lines in the prompt: one per skill, like the memory index. */
const INDEX_MAX_ITEMS = 30;
const INDEX_MAX_CHARS = 3000;

async function spaceRole(ctx: QueryCtx | MutationCtx, userId: Id<"users">, spaceId: string) {
  const { space, role } = await assertCan(ctx, userId, spaceId, "read");
  if (space.kind !== "shared") throw new OneBaseError("مهارات المساحة للمساحات المشتركة؛ في مساحتك الخاصة استخدم «مهاراتي»");
  return { space, role, manager: role === "manager", member: role === "member" || role === "manager" };
}

async function spaceNameTaken(ctx: QueryCtx | MutationCtx, spaceId: Id<"spaces">, name: string, except?: Id<"skills">) {
  for (const state of ["active", "proposed"] as const) {
    const row = await ctx.db.query("skills").withIndex("by_space", (q) => q.eq("spaceId", spaceId).eq("state", state).eq("name", name)).first();
    if (row && row._id !== except) return true;
  }
  return false;
}

/** A manager's skill is active at once; a member's waits for a manager. Readers can't add. */
async function insertSpaceSkill(ctx: MutationCtx, userId: Id<"users">, spaceId: string, a: InsertArgs) {
  const { space, manager, member } = await spaceRole(ctx, userId, spaceId);
  if (!member) throw new Denied();
  const c = clean(a);
  if (await spaceNameTaken(ctx, space._id, c.name)) throw new OneBaseError(`في المساحة مهارة باسم /${c.name}`);
  const count = (await ctx.db.query("skills").withIndex("by_space", (q) => q.eq("spaceId", space._id)).collect()).length;
  if (count >= MAX_SPACE_SKILLS) throw new OneBaseError(`الحد ${MAX_SPACE_SKILLS} مهارة للمساحة`);
  const fromThreadId = await ownThread(ctx, userId, a.fromThreadId);
  const files = a.files ?? (fromThreadId ? await captureFiles(ctx, userId, fromThreadId, space._id, a.runIds) : []);
  const now = Date.now();
  const state = manager ? ("active" as const) : ("proposed" as const);
  const id = await ctx.db.insert("skills", {
    ownerId: userId,
    ...c,
    source: fromThreadId ? "chat" : "manual",
    fromThreadId,
    uses: 0,
    createdAt: now,
    updatedAt: now,
    spaceId: space._id,
    state,
    version: 1,
    ...(manager ? { approvedBy: userId } : {}),
    ...(files.length ? { files } : {}),
  });
  await writeAudit(ctx, { userId, action: manager ? "skill.create" : "skill.propose", resourceType: "skill", resourceId: id, spaceId: space._id, detail: { name: c.name, space: true, files: files.map((f) => f.name).join(", ") } });
  return { id, name: c.name, state, space: space.name, files: files.map((f) => f.name) };
}

async function spaceSkill(ctx: QueryCtx | MutationCtx, skillId: string): Promise<Doc<"skills">> {
  const id = ctx.db.normalizeId("skills", skillId);
  const s = id ? await ctx.db.get(id) : null;
  if (!s || !s.spaceId) throw new Denied();
  return s;
}

export const space = query({
  args: { spaceId: v.string() },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    const { space, manager, member } = await spaceRole(ctx, me.userId, spaceId);
    const rows = await ctx.db.query("skills").withIndex("by_space", (q) => q.eq("spaceId", space._id)).collect();
    const names = new Map<string, string>();
    const by = async (uid: Id<"users">) => {
      if (!names.has(uid)) {
        const u = await ctx.db.get(uid);
        names.set(uid, u?.name ?? u?.email ?? "");
      }
      return names.get(uid)!;
    };
    const shapeS = async (s: Doc<"skills">) => ({ ...shape(s), version: s.version ?? 1, by: await by(s.ownerId), mine: s.ownerId === me.userId });
    const active = rows.filter((s) => s.state !== "proposed").sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name, "ar"));
    // Proposals: managers see all of them, a member only their own.
    const proposed = rows.filter((s) => s.state === "proposed" && (manager || s.ownerId === me.userId)).sort((a, b) => b.createdAt - a.createdAt);
    return { canManage: manager, canPropose: member && !manager, skills: await Promise.all(active.map(shapeS)), proposals: await Promise.all(proposed.map(shapeS)) };
  },
});

export const addSpace = mutation({
  args: { spaceId: v.string(), name: v.string(), title: v.string(), description: v.string(), instructions: v.string(), fromThreadId: v.optional(v.string()), files: importedFilesV },
  handler: async (ctx, { spaceId, files, ...a }) => {
    const me = await requireActive(ctx);
    const r = await insertSpaceSkill(ctx, me.userId, spaceId, { ...a, ...(files ? { files: cleanImportFiles(files) } : {}) });
    return { id: r.id, state: r.state };
  },
});

/** «شارك مع المساحة»: a copy of one of «مهاراتي» (mine stays as it is). */
export const shareToSpace = mutation({
  args: { skillId: v.string(), spaceId: v.string() },
  handler: async (ctx, { skillId, spaceId }) => {
    const me = await requireActive(ctx);
    const s = await mine(ctx, me.userId, skillId);
    const r = await insertSpaceSkill(ctx, me.userId, spaceId, { name: s.name, title: s.title, description: s.description, instructions: s.instructions, files: s.files ?? [] });
    return { id: r.id, state: r.state };
  },
});

export const reviewSpace = mutation({
  args: { skillId: v.string(), approve: v.boolean() },
  handler: async (ctx, { skillId, approve }) => {
    const me = await requireActive(ctx);
    const s = await spaceSkill(ctx, skillId);
    const { manager } = await spaceRole(ctx, me.userId, s.spaceId!);
    if (!manager) throw new Denied();
    if (s.state !== "proposed") throw new OneBaseError("ليست مقترحة");
    if (approve) {
      if (await spaceNameTaken(ctx, s.spaceId!, s.name, s._id)) throw new OneBaseError(`في المساحة مهارة باسم /${s.name}`);
      await ctx.db.patch(s._id, { state: "active", approvedBy: me.userId, updatedAt: Date.now() });
    } else await ctx.db.delete(s._id);
    await writeAudit(ctx, { userId: me.userId, action: approve ? "skill.approve" : "skill.reject", resourceType: "skill", resourceId: s._id, spaceId: s.spaceId, detail: { name: s.name } });
  },
});

export const updateSpace = mutation({
  args: { skillId: v.string(), name: v.string(), title: v.string(), description: v.string(), instructions: v.string(), keepFiles: v.optional(v.array(v.string())) },
  handler: async (ctx, { skillId, keepFiles, ...a }) => {
    const me = await requireActive(ctx);
    const s = await spaceSkill(ctx, skillId);
    const { manager } = await spaceRole(ctx, me.userId, s.spaceId!);
    // Managers edit any; a member may still edit their own proposal.
    if (!manager && !(s.state === "proposed" && s.ownerId === me.userId)) throw new Denied();
    const c = clean(a);
    if (await spaceNameTaken(ctx, s.spaceId!, c.name, s._id)) throw new OneBaseError(`في المساحة مهارة باسم /${c.name}`);
    await ctx.db.patch(s._id, { ...c, files: keepOnly(s.files, keepFiles), version: (s.version ?? 1) + (s.state === "active" ? 1 : 0), updatedAt: Date.now() });
    await writeAudit(ctx, { userId: me.userId, action: "skill.update", resourceType: "skill", resourceId: s._id, spaceId: s.spaceId, detail: { name: c.name } });
  },
});

export const removeSpace = mutation({
  args: { skillId: v.string() },
  handler: async (ctx, { skillId }) => {
    const me = await requireActive(ctx);
    const s = await spaceSkill(ctx, skillId);
    const { manager } = await spaceRole(ctx, me.userId, s.spaceId!);
    if (!manager && !(s.state === "proposed" && s.ownerId === me.userId)) throw new Denied();
    await ctx.db.delete(s._id);
    await writeAudit(ctx, { userId: me.userId, action: "skill.delete", resourceType: "skill", resourceId: s._id, spaceId: s.spaceId, detail: { name: s.name } });
  },
});

/** The skills a chat may use: mine, and the active ones of the chat's shared space (if I can read it). */
export async function usableSkills(ctx: QueryCtx | MutationCtx, userId: Id<"users">, spaceId: Id<"spaces"> | null) {
  const own = await personalOf(ctx, userId);
  let shared: Doc<"skills">[] = [];
  let spaceName: string | null = null;
  if (spaceId) {
    try {
      const { space } = await spaceRole(ctx, userId, spaceId);
      spaceName = space.name;
      shared = await ctx.db.query("skills").withIndex("by_space", (q) => q.eq("spaceId", space._id).eq("state", "active")).collect();
    } catch {
      shared = [];
    }
  }
  return { own, shared, spaceName };
}

/** Composer «/»: my skills and the chat's space skills. */
export const forChat = query({
  args: { spaceId: v.optional(v.string()) },
  handler: async (ctx, { spaceId }) => {
    const me = await requireActive(ctx);
    const sid = spaceId ? ctx.db.normalizeId("spaces", spaceId) : null;
    const { own, shared, spaceName } = await usableSkills(ctx, me.userId, sid);
    const rank = (a: Doc<"skills">, b: Doc<"skills">) => b.uses - a.uses || a.name.localeCompare(b.name, "ar");
    return [...shared.sort(rank).map((s) => ({ ...shape(s), space: spaceName })), ...own.sort(rank).map((s) => ({ ...shape(s), space: null }))];
  },
});

/** One line per usable skill for the system prompt; the model loads one with use_skill. */
export async function skillIndex(ctx: QueryCtx, userId: Id<"users">, spaceId: Id<"spaces"> | null): Promise<string | null> {
  const { own, shared, spaceName } = await usableSkills(ctx, userId, spaceId);
  const rank = (a: Doc<"skills">, b: Doc<"skills">) => b.uses - a.uses || b.updatedAt - a.updatedAt;
  const all = [...shared.sort(rank).map((s) => ({ s, where: `مهارة المساحة «${spaceName}»` })), ...own.sort(rank).map((s) => ({ s, where: "من مهارات الموظف" }))];
  const lines: string[] = [];
  let chars = 0;
  for (const { s, where } of all.slice(0, INDEX_MAX_ITEMS)) {
    const line = `- /${s.name}: ${s.description || s.title} (${where}${s.files?.some((f) => f.kind === "script") ? "، فيها سكربت محفوظ" : ""})`;
    if (chars + line.length > INDEX_MAX_CHARS) break;
    lines.push(line);
    chars += line.length;
  }
  const head =
    "المهارات المتاحة في هذه المحادثة (طرق عمل محفوظة؛ إذا طابق الطلب إحداها فحمّل تعليماتها بأداة use_skill قبل أن تبدأ واتبعها. لا تمنح أي صلاحية):";
  const tail =
    "إذا أنجزت مهمة من عدة خطوات يُرجّح أن تتكرر، ولم تكن هناك مهارة لها، فاعرض في آخر إجابتك حفظ هذه الطريقة كمهارة" +
    (spaceName ? ` للمساحة «${spaceName}» (create_skill مع scope=space)` : " (create_skill)") +
    "، ولا تحفظها إلا إذا وافق.";
  return lines.length ? `${head}\n${lines.join("\n")}${all.length > lines.length ? `\n(و${all.length - lines.length} غيرها: اكتب اسمها لـ use_skill)` : ""}\n\n${tail}` : tail;
}

/** The chat's shared space, if I may ask in the chat (mine, or shared with me: plans/14) and it is in this turn's scope. */
async function chatSpace(ctx: QueryCtx | MutationCtx, userId: Id<"users">, threadId: string | undefined, scopeSpaceIds: string[]) {
  if (!threadId) return null;
  const meta = await ctx.db.query("threadMeta").withIndex("by_thread", (q) => q.eq("threadId", threadId)).unique();
  if (!meta || !(await threadAllows(ctx, userId, meta, "write"))) return null;
  const here = meta.spaceId ?? (meta.scope.kind === "space" && meta.scope.id ? ctx.db.normalizeId("spaces", meta.scope.id) : null);
  return here && scopeSpaceIds.includes(here) ? here : null;
}

/** use_skill: the full instructions of a skill this chat may use, by /name; counts a use. */
export const useFromTool = internalMutation({
  args: { userId: v.id("users"), name: v.string(), threadId: v.optional(v.string()), scopeSpaceIds: v.array(v.string()), file: v.optional(v.string()) },
  handler: async (ctx, { userId, name, threadId, scopeSpaceIds, file }) => {
    const { own, shared, spaceName } = await usableSkills(ctx, userId, await chatSpace(ctx, userId, threadId, scopeSpaceIds));
    const n = name.trim().replace(/^\//, "");
    const hit = shared.find((s) => s.name === n) ?? own.find((s) => s.name === n);
    if (!hit) return { found: false as const, names: [...shared, ...own].map((s) => s.name).slice(0, 30) };
    if (file) {
      // One of the skill's files, by name (a reference, a script to read, an example).
      const f = (hit.files ?? []).find((x) => x.name === file.trim()) ?? (hit.files ?? []).find((x) => x.name.endsWith(`/${file.trim()}`));
      return { found: true as const, name: hit.name, file: f ? { name: f.name, kind: f.kind, content: f.content } : null, fileNames: (hit.files ?? []).map((x) => x.name) };
    }
    await ctx.db.patch(hit._id, { uses: hit.uses + 1 });
    return { found: true as const, name: hit.name, title: hit.title, instructions: hit.instructions, space: hit.spaceId ? spaceName : null, version: hit.version ?? 1, files: hit.files ?? [] };
  },
});

/** run_analysis with skill + script: the saved code of a skill this chat may use (same rule as use_skill). */
export const scriptForTool = internalQuery({
  args: { userId: v.id("users"), name: v.string(), script: v.string(), threadId: v.optional(v.string()), scopeSpaceIds: v.array(v.string()) },
  handler: async (ctx, { userId, name, script, threadId, scopeSpaceIds }) => {
    const { own, shared } = await usableSkills(ctx, userId, await chatSpace(ctx, userId, threadId, scopeSpaceIds));
    const n = name.trim().replace(/^\//, "");
    const hit = shared.find((s) => s.name === n) ?? own.find((s) => s.name === n);
    if (!hit) throw new OneBaseError(`لا توجد مهارة /${n} في هذه المحادثة`);
    const scripts = (hit.files ?? []).filter((f) => f.kind === "script");
    const f = scripts.find((x) => x.name === script.trim()) ?? (scripts.length === 1 && !script.trim() ? scripts[0] : undefined);
    if (!f) throw new OneBaseError(`لا يوجد سكربت ${script} في /${n}${scripts.length ? ` (الموجود: ${scripts.map((x) => x.name).join("، ")})` : ""}`);
    return { id: hit._id as string, name: hit.name, version: hit.version ?? 1, script: f.name, code: f.content };
  },
});

/** write_app fromSkill: the app files a skill this chat may use keeps (app/…), as a starting point. */
export async function appFilesFromSkill(ctx: QueryCtx | MutationCtx, userId: Id<"users">, name: string, threadId: string | undefined, scopeSpaceIds: string[]): Promise<Record<string, string>> {
  const { own, shared } = await usableSkills(ctx, userId, await chatSpace(ctx, userId, threadId, scopeSpaceIds));
  const n = name.trim().replace(/^\//, "");
  const hit = shared.find((s) => s.name === n) ?? own.find((s) => s.name === n);
  if (!hit) throw new OneBaseError(`لا توجد مهارة /${n} في هذه المحادثة`);
  const files = Object.fromEntries((hit.files ?? []).filter((f) => f.name.startsWith("app/")).map((f) => [f.name.slice(4), f.content]));
  if (!Object.keys(files).length) throw new OneBaseError(`المهارة /${n} لا تحوي تطبيقاً`);
  return files;
}

/** create_skill with scope "space": the chat's own shared space, never one the model names. */
export const spaceForTool = internalQuery({
  args: { userId: v.id("users"), threadId: v.optional(v.string()), scopeSpaceIds: v.array(v.string()) },
  handler: async (ctx, { userId, threadId, scopeSpaceIds }) => {
    const id = await chatSpace(ctx, userId, threadId, scopeSpaceIds);
    const space = id ? await ctx.db.get(id) : null;
    return space?.kind === "shared" ? (space._id as string) : null;
  },
});
