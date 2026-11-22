// Sets up «خدمة المستفيدين» and «تقنية المعلومات والأمن السيبراني» as their real owners would.
//   bun scripts/gov-demo/spaces/service.ts            # setup (idempotent: each step skips if done)
// The demo chats are run separately (scripts/gov-demo/spaces/service.ts chats) and logged to
// content/service/chat_log.json. Content files come from content/service/build_content.py.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { login, type Client, type Answer } from "../lib.ts";

const DIR = join(import.meta.dir, "..", "content", "service");
const SERVICE = "خدمة المستفيدين";
const IT = "تقنية المعلومات والأمن السيبراني";
const day = (s: string) => new Date(`${s}T12:00:00+03:00`).getTime();

async function idOf(c: Client, spaceId: string, email: string): Promise<string> {
  const ms: any[] = await c.q("spaces:members", { spaceId });
  const m = ms.find((x) => x.email === email);
  if (!m) throw new Error(`${email} not in space`);
  return m.userId;
}

async function uploadAll(c: Client, spaceId: string, files: string[]) {
  const have = new Set(((await c.q("files:list", { spaceId })) as any[]).map((f) => f.name));
  for (const f of files) {
    const name = f.split("/").pop()!;
    if (have.has(name)) continue;
    await c.upload(spaceId, join(DIR, f));
    console.log("  uploaded", name);
  }
  // lib.waitIngest reads `ingest` from files:list, which doesn't return it: poll ingest:statuses instead.
  for (const end = Date.now() + 15 * 60_000; ; ) {
    const st: any[] = await c.q("ingest:statuses", { spaceId });
    if (!st.some((x) => x.state === "pending" || x.state === "processing") || Date.now() > end) {
      console.log("  ingest:", st.map((x) => `${x.state}${x.chunks ? "/" + x.chunks : ""}${x.error ? " " + x.error : ""}`).join(" | "));
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function listByTitle(c: Client, spaceId: string, title: string) {
  const ls: any[] = (await c.q("lists:forSpace", { spaceId })).lists;
  return ls.find((l) => l.title === title);
}

async function setupService() {
  const care = await login("care");
  const emp = await login("employee");
  const sp = await care.space(SERVICE);
  const empId = await idOf(care, sp, "employee@gov-demo.test");
  console.log("== خدمة المستفيدين", sp);

  await uploadAll(care, sp, [
    "سجل_البلاغات_والشكاوى_2026.xlsx",
    "دليل_الخدمات_والأسئلة_الشائعة.docx",
    "ميثاق_مستوى_الخدمة.pdf",
    "إجراء_معالجة_البلاغات_والشكاوى.docx",
    "محضر_اجتماع_فريق_خدمة_المستفيدين.docx",
  ]);
  const files: any[] = await care.q("files:list", { spaceId: sp });
  const fileId = (n: string) => files.find((f) => f.name === n)?._id;

  await care.m("spaces:setInstructions", {
    spaceId: sp,
    instructions: [
      "هذه مساحة فريق خدمة المستفيدين في الهيئة التجريبية للخدمات الحكومية.",
      "- عند الإجابة عن سؤال مستفيد اعتمد على «دليل الخدمات والأسئلة الشائعة» و«ميثاق مستوى الخدمة» فقط، واذكر المصدر، ولا تجتهد في رسوم أو مدد غير مذكورة؛ قل إنها تُحال لمديرة خدمة المستفيدين.",
      "- إذا طُلب «رد جاهز للمستفيد»: ابدأ بالتحية، اذكر رقم البلاغ إن وُجد، استخدم الرد المعتمد من الدليل بصياغة رسمية مختصرة، واختم بـ«نسعد بخدمتكم».",
      "- لا تطلب رقم الهوية كاملاً؛ آخر أربعة أرقام تكفي.",
      "- في تحليل سجل البلاغات: الالتزام بالمدة يُحسب من عمود «الالتزام بالمدة»، والمستهدف 90% ومتوسط رضا 4 من 5 (ميثاق مستوى الخدمة، المادة 3).",
      "- التقارير بالعربية الرسمية، بالأرقام والنسب، مع أهم 3 توصيات.",
    ].join("\n"),
  });
  console.log("  instructions set");

  const mem: any = await care.q("memory:space", { spaceId: sp });
  const memText = (mem.items ?? []).map((m: any) => m.text ?? "").join("\n");
  const facts: [string, "fact" | "decision" | "term" | "preference"][] = [
    ["التقرير الأسبوعي لخدمة المستفيدين يُرفع كل يوم أحد لمكتب الرئيس التنفيذي (نورة القحطاني)", "fact"],
    ["قرار اجتماع الفريق رقم 9: فرز البريد الإلكتروني مرتين يومياً (9 ص و 1 م) بمسؤولية خالد المالكي", "decision"],
    ["«التجاوز» = إغلاق البلاغ بعد المدة المستهدفة أو بقاؤه مفتوحاً بعدها", "term"],
    ["تفضّل أمل الغامدي أن تبدأ التقارير بملخص من 3 أسطر ثم الجداول", "preference"],
  ];
  for (const [text, kind] of facts) if (!memText.includes(text.slice(0, 30))) await care.m("memory:addSpace", { spaceId: sp, text, kind });
  console.log("  space memory:", facts.length);

  // ---- tasks (manager assigns, member works and comments)
  let board: any[] = await care.q("tasks:board", { spaceId: sp });
  if (board.length && board.length < 5) {
    for (const t of board) await care.m("tasks:remove", { taskId: t._id ?? t.task?._id ?? t.id });
    board = [];
  }
  if (!board.length) {
    const careId = care.userId;
    const t1 = await care.m("tasks:create", { spaceId: sp, title: "تحديث الردود المعتمدة لأسئلة الرسوم والاسترداد في دليل الخدمات", body: "تنفيذاً للقرار (2) من محضر اجتماع الفريق رقم 9: صياغة ردود معتمدة جديدة لأسئلة الرسوم المكررة والاسترداد وغرامة التأخير، ومراجعتها مع الشؤون المالية قبل اعتمادها.", assigneeIds: [empId], due: day("2026-11-26"), priority: "high" });
    if (fileId("دليل_الخدمات_والأسئلة_الشائعة.docx")) await care.m("tasks:addLink", { taskId: t1, type: "file", id: fileId("دليل_الخدمات_والأسئلة_الشائعة.docx") });
    await care.m("tasks:comment", { taskId: t1, body: "@ياسر الحارثي ركّز على حالة الدفع المكرر لأنها أكثر ما يتجاوز المدة في سجل البلاغات. أرسل لي المسودة قبل الأربعاء.", mentions: [empId] });
    await emp.m("tasks:setStatus", { taskId: t1, status: "inProgress" });
    await emp.m("tasks:comment", { taskId: t1, body: "@أمل الغامدي جهزت ثلاث صيغ من الدليل الحالي، وسأضيف صيغة غرامة التأخير بعد تأكيد المالية للحد الأقصى (2,400 ريال).", mentions: [careId] });

    const t2 = await care.m("tasks:create", { spaceId: sp, title: "متابعة البلاغات المفتوحة المتجاوزة للمدة المستهدفة", body: "مراجعة قائمة «البلاغات المفتوحة» يومياً، والتواصل مع الإدارات المختصة للبلاغات المتجاوزة، وتحديث الحالة. التصعيد وفق المادة (4) من ميثاق مستوى الخدمة.", assigneeIds: [empId], due: day("2026-11-24"), priority: "urgent" });
    await care.m("tasks:comment", { taskId: t2, body: "@ياسر الحارثي ابدأ بالبلاغات ذات الأولوية العالية والمُصعّدة، وحدّث عمود الحالة في القائمة بعد كل اتصال.", mentions: [empId] });

    const t3 = await care.m("tasks:create", { spaceId: sp, title: "إطلاق استبيان رضا المستفيدين للربع الرابع", body: "القرار (4) من محضر الاجتماع: استبيان قصير ينشر برابط ويجمع الردود في قائمة، عينة 300 مستفيد.", assigneeIds: [careId], due: day("2026-11-25"), priority: "normal" });
    await care.m("tasks:setStatus", { taskId: t3, status: "inProgress" });

    const t4 = await care.m("tasks:create", { spaceId: sp, title: "تقرير مجمّع لبلاغات انقطاع المنصة لإدارة تقنية المعلومات", body: "القرار (5): حصر بلاغات «انقطاع الخدمة الإلكترونية» و«صعوبة استخدام المنصة» منذ يوليو، مع التواريخ والخدمات المتأثرة.", assigneeIds: [empId], due: day("2026-11-20"), priority: "high" });
    await emp.m("tasks:setStatus", { taskId: t4, status: "inProgress" });
    await emp.m("tasks:setStatus", { taskId: t4, status: "review" });
    await emp.m("tasks:comment", { taskId: t4, body: "@أمل الغامدي التقرير جاهز للمراجعة: 15 بلاغ انقطاع و28 بلاغ صعوبة استخدام، أغلبها بعد تحديث صفحة الدفع.", mentions: [careId] });

    const t5 = await care.m("tasks:create", { spaceId: sp, title: "فرز البريد الإلكتروني مرتين يومياً", body: "القرار (1) من محضر الاجتماع رقم 9.", assigneeIds: [empId], due: day("2026-10-15"), priority: "normal" });
    await emp.m("tasks:setStatus", { taskId: t5, status: "inProgress" });
    await emp.m("tasks:setStatus", { taskId: t5, status: "review" });
    await care.m("tasks:comment", { taskId: t5, body: "ممتاز، الالتزام في قناة البريد تحسّن بعد التطبيق. أغلقتها." });
    await care.m("tasks:setStatus", { taskId: t5, status: "done" });
    console.log("  tasks: 5 (with comments and @mentions)");
  } else console.log("  tasks exist:", board.length);

  // ---- team list of open cases (from the log's open rows)
  if (!(await listByTitle(care, sp, "البلاغات المفتوحة"))) {
    const open: any[] = JSON.parse(readFileSync(join(DIR, "open_cases.json"), "utf8"));
    const listId = await care.m("lists:create", {
      spaceId: sp,
      title: "البلاغات المفتوحة",
      description: "البلاغات غير المغلقة من سجل البلاغات والشكاوى 2026، يحدّثها الفريق يومياً.",
      columns: [
        { name: "رقم البلاغ", type: "text" },
        { name: "التصنيف", type: "select", options: [...new Set(open.map((r) => r["التصنيف"]))] },
        { name: "القناة", type: "select", options: [...new Set(open.map((r) => r["القناة"]))] },
        { name: "الأولوية", type: "select", options: ["عاجلة", "عالية", "متوسطة", "منخفضة"] },
        { name: "تاريخ الاستلام", type: "date" },
        { name: "الحالة", type: "status", options: ["قيد المعالجة", "بانتظار المستفيد", "مُصعّد للإدارة المختصة", "مغلق"] },
        { name: "متجاوز للمدة", type: "check" },
        { name: "المتابع", type: "person" },
        { name: "ملاحظات", type: "text" },
      ],
    });
    for (const r of open) {
      await care.m("lists:addRow", {
        listId,
        cells: {
          "رقم البلاغ": r["رقم البلاغ"],
          "التصنيف": r["التصنيف"],
          "القناة": r["القناة"],
          "الأولوية": r["الأولوية"],
          "تاريخ الاستلام": String(r["تاريخ الاستلام"]).slice(0, 10),
          "الحالة": r["الحالة"],
          "متجاوز للمدة": r["الالتزام بالمدة"] === "متجاوز",
          "المتابع": r["الموظف المسؤول"] === "أمل الغامدي" ? care.userId : empId,
        },
      });
    }
    // the member updates a row like on a real day
    const l: any = await emp.q("lists:get", { listId });
    const first = (l.rows ?? [])[0];
    if (first) await emp.m("lists:updateRow", { rowId: first._id, cells: { "ملاحظات": "تم الاتصال بالمستفيد 2026/11/21 وأُبلغ بأن الطلب لدى الإدارة المختصة" } });
    console.log("  list «البلاغات المفتوحة»:", open.length, "rows");
  }

  // ---- weekly scheduled report (Sunday 08:00, the space's files)
  const sch: any[] = await care.q("schedules:mine");
  if (!sch.some((s) => s.title === "التقرير الأسبوعي لخدمة المستفيدين")) {
    await care.m("schedules:create", {
      title: "التقرير الأسبوعي لخدمة المستفيدين",
      spaceId: sp,
      recurrence: { kind: "weekly", weekday: 0, time: "08:00" },
      prompt:
        "أعد التقرير الأسبوعي لخدمة المستفيدين من «سجل البلاغات والشكاوى 2026» وقائمة «البلاغات المفتوحة»: عدد البلاغات الواردة والمغلقة في آخر 7 أيام، نسبة الالتزام بالمدة مقابل المستهدف 90%، أعلى خمسة تصنيفات، البلاغات المفتوحة المتجاوزة بأرقامها، متوسط الرضا مقابل 4 من 5، وثلاث توصيات. ابدأ بملخص من 3 أسطر.",
    });
    console.log("  weekly schedule created");
  }
}

async function setupIT() {
  const admin = await login("admin");
  const emp = await login("employee");
  const sp = await admin.space(IT);
  const empId = await idOf(admin, sp, "employee@gov-demo.test");
  console.log("== تقنية المعلومات والأمن السيبراني", sp);
  await uploadAll(admin, sp, ["it/سياسة_الأمن_السيبراني.pdf", "it/إجراء_الاستجابة_للحوادث_السيبرانية.docx", "it/سجل_الحوادث_الأمنية_2026.xlsx"]);

  await admin.m("spaces:setInstructions", {
    spaceId: sp,
    instructions: [
      "مساحة إدارة تقنية المعلومات والأمن السيبراني.",
      "- أجب عن أسئلة الأمن السيبراني من «سياسة الأمن السيبراني» و«إجراء الاستجابة للحوادث» مع ذكر رقم المادة أو المرحلة.",
      "- إذا وصف الموظف حادثاً محتملاً: ابدأ بما يجب فعله الآن (لا تطفئ الجهاز، أبلغ تحويلة 4444)، ثم حدد مستوى الخطورة المرجح من جدول المستويات.",
      "- لا تطلب كلمات مرور ولا تعرضها أبداً.",
    ].join("\n"),
  });

  if (!(await listByTitle(admin, sp, "الحوادث الأمنية المفتوحة"))) {
    const listId = await admin.m("lists:create", {
      spaceId: sp,
      title: "الحوادث الأمنية المفتوحة",
      description: "الحوادث غير المغلقة من سجل الحوادث الأمنية 2026.",
      columns: [
        { name: "رقم الحادث", type: "text" },
        { name: "النوع", type: "text" },
        { name: "المستوى", type: "select", options: ["P1", "P2", "P3", "P4"] },
        { name: "الإدارة المتأثرة", type: "text" },
        { name: "تاريخ الاكتشاف", type: "date" },
        { name: "الحالة", type: "status", options: ["قيد التحليل", "قيد الاحتواء", "مغلق"] },
        { name: "المسؤول", type: "person" },
      ],
    });
    const rows: any[] = JSON.parse(readFileSync(join(DIR, "open_incidents.json"), "utf8"));
    for (const r of rows) await admin.m("lists:addRow", { listId, cells: { "رقم الحادث": r["رقم الحادث"], "النوع": r["النوع"], "المستوى": r["المستوى"], "الإدارة المتأثرة": r["الإدارة المتأثرة"], "تاريخ الاكتشاف": String(r["تاريخ الاكتشاف"]).slice(0, 10), "الحالة": r["الحالة"], "المسؤول": admin.userId } });
    console.log("  list «الحوادث الأمنية المفتوحة»:", rows.length);
  }

  const board: any[] = await admin.q("tasks:board", { spaceId: sp });
  if (!board.length) {
    const t1 = await admin.m("tasks:create", { spaceId: sp, title: "إكمال دورة التوعية بالتصيّد الاحتيالي ورفع شهادة الإتمام", body: "إلزامية لموظفي الخطوط الأمامية بعد ارتفاع رسائل التصيّد التي تنتحل بوابة الدفع (سجل الحوادث 2026).", assigneeIds: [empId], due: day("2026-11-30"), priority: "normal" });
    await admin.m("tasks:comment", { taskId: t1, body: "@ياسر الحارثي الدورة 40 دقيقة على منصة التدريب، وبعدها جرّب الإبلاغ عن رسالة تجريبية بزر «الإبلاغ عن تصيّد».", mentions: [empId] });
    await emp.m("tasks:comment", { taskId: t1, body: "@فيصل الحربي تم التسجيل وسأكملها يوم الأحد.", mentions: [admin.userId] });
    await admin.m("tasks:create", { spaceId: sp, title: "احتواء الحادث INC-2026-074 (حساب مخترق في الشؤون القانونية) وكتابة تقرير الدروس المستفادة", body: "حادث عالٍ P2: تغيير كلمات المرور وتفعيل التحقق المتعدد، ثم تقرير الدروس المستفادة خلال 5 أيام عمل من الإغلاق (إجراء الاستجابة، المرحلة 6).", assigneeIds: [admin.userId], due: day("2026-11-26"), priority: "urgent" });
    console.log("  tasks: 2");
  }
}

// ---------------------------------------------------------------- chats (run one at a time)
type LogRow = { id: string; who: string; space: string; prompt: string; threadId: string; secs: number; text: string; citations: number; tools: string[]; proposals: any[]; error?: string; confirmed?: any };
const LOG = join(DIR, "chat_log.json");
const log: LogRow[] = existsSync(LOG) ? JSON.parse(readFileSync(LOG, "utf8")) : [];
const save = () => writeFileSync(LOG, JSON.stringify(log, null, 1));

export async function run(id: string, c: Client, who: string, space: string, threadId: string, prompt: string, opts: Parameters<Client["ask"]>[2] = {}): Promise<Answer> {
  // a confirmed card starts a follow-up turn: wait for the chat to go idle first
  for (let i = 0; i < 200; i++) {
    const r: any = await c.q("chat:messages", { threadId });
    if (!r.turn || r.turn.state === "done" || r.turn.state === "failed") break;
    await new Promise((x) => setTimeout(x, 4000));
  }
  const t0 = Date.now();
  const a = await c.ask(threadId, prompt, opts);
  const secs = Math.round((Date.now() - t0) / 1000);
  log.push({ id, who, space, prompt, threadId, secs, text: a.text, citations: a.citations?.length ?? 0, tools: (a.toolRuns ?? []).map((t) => `${t.name}${t.ok ? "" : "✗"}`), proposals: (a.proposals ?? []).map((p: any) => ({ id: p.id ?? p._id, tool: p.tool ?? p.name, state: p.state, label: p.label ?? p.title })), ...(a.error ? { error: a.error } : {}) });
  save();
  console.log(`\n### ${id} [${who}] ${secs}s tools=${log.at(-1)!.tools.join(",")} cites=${log.at(-1)!.citations} props=${JSON.stringify(log.at(-1)!.proposals)}\n> ${prompt}\n${a.error ? "ERROR " + a.error : a.text.slice(0, 1500)}`);
  return a;
}
async function confirmAll(id: string, c: Client, a: Answer) {
  for (const p of a.proposals ?? []) {
    if (p.state && p.state !== "pending") continue;
    try {
      const r = await c.confirm(p.id ?? p._id);
      markConfirmed(id, r);
      console.log("confirmed", p.tool ?? p.label, JSON.stringify(r).slice(0, 300));
    } catch (e) {
      markConfirmed(id, { error: String(e) });
      console.log("confirm failed", String(e));
    }
  }
}
export const markConfirmed = (id: string, r: any) => {
  const row = [...log].reverse().find((x) => x.id === id);
  if (row) row.confirmed = r;
  save();
};

// thread ids by name, so follow-ups land in the same chat
const TH = join(DIR, "threads.json");
const threads: Record<string, string> = existsSync(TH) ? JSON.parse(readFileSync(TH, "utf8")) : {};
async function thread(name: string, c: Client, spaceId: string, shared = false) {
  if (!threads[name]) {
    threads[name] = await c.m("chat:createThread", { spaceId, shared });
    writeFileSync(TH, JSON.stringify(threads, null, 1));
  }
  return threads[name]!;
}
const fileIn = async (c: Client, sp: string, name: string) => ((await c.q("files:list", { spaceId: sp })) as any[]).find((f) => f.name === name)?._id as string;

const steps: Record<string, () => Promise<unknown>> = {
  async S1() {
    const c = await login("employee");
    const sp = await c.space(SERVICE);
    const t = await thread("S1", c, sp);
    await run("S1", c, "employee", SERVICE, t, "مستفيد على الخط الآن: عليه مخالفة غير مسددة ويبغى يجدد الترخيص لمدة سنتين. كم الرسوم؟ وهل يقدر يجدد قبل ما يسدد المخالفة؟ أعطني رداً جاهزاً أرسله له.");
  },
  async S1m() {
    const c = await login("employee");
    const sp = await c.space(SERVICE);
    const t = await thread("S1m", c, sp);
    const guide = await fileIn(c, sp, "دليل_الخدمات_والأسئلة_الشائعة.docx");
    await run("S1m", c, "employee", SERVICE, t, "مستفيد على الخط الآن: عليه مخالفة غير مسددة ويبغى يجدد الترخيص لمدة سنتين. كم الرسوم؟ وهل يقدر يجدد قبل ما يسدد المخالفة؟ أعطني رداً جاهزاً أرسله له.", { mentions: [{ kind: "file", id: guide }] });
  },
  async S2() {
    const c = await login("care");
    const sp = await c.space(SERVICE);
    const t = await thread("S2", c, sp);
    const log_ = await fileIn(c, sp, "سجل_البلاغات_والشكاوى_2026.xlsx");
    const a = await run("S2", c, "care", SERVICE, t, "حلّل سجل البلاغات والشكاوى 2026: أعلى خمسة تصنيفات، ونسبة الالتزام بالمدة المستهدفة لكل قناة ولكل تصنيف مقارنة بالمستهدف 90%، ومتوسط الرضا للبلاغات المتجاوزة وغير المتجاوزة، مع رسم بياني لنسبة التجاوز حسب القناة. ثم لخّص أين تتركز المشكلة.", { mentions: [{ kind: "file", id: log_ }] });
    for (const p of a.proposals ?? []) if (p.state === "pending" || !p.state) { const r = await c.confirm(p.id ?? p._id); markConfirmed("S2", r); console.log("confirmed", JSON.stringify(r).slice(0, 300)); }
  },
  async S2r() {
    const c = await login("care");
    const a = await run("S2r", c, "care", SERVICE, threads.S2!, "التشغيل السابق توقف بخطأ. أعد التحليل نفسه بكود أبسط: قيم عمود «الالتزام بالمدة» هي «ضمن المدة» و«متجاوز»، ونسبة الالتزام = ضمن المدة ÷ الإجمالي. أريد الجداول والرسم البياني.");
    await confirmAll("S2r", c, a);
  },
  async S3() {
    const c = await login("care");
    const sp = await c.space(SERVICE);
    const t = await thread("S3", c, sp);
    const a = await run("S3", c, "care", SERVICE, t, "أريد إطلاق استبيان رضا المستفيدين للربع الرابع (قرار 4 في محضر الاجتماع). أنشئ قائمة لجمع الردود بالأعمدة: قناة التواصل (اختيار: مركز الاتصال 920، البوابة الإلكترونية، تطبيق الجوال، البريد الإلكتروني، الحضور الشخصي)، سهولة الحصول على الخدمة (1-5)، سرعة الحل (1-5)، تعامل الموظف (1-5)، الرضا العام (1-5)، ملاحظات. ثم صفحة تعريفية قصيرة بالاستبيان، وانشرها برابط لموظفي الهيئة مع نموذج الردود.");
    await confirmAll("S3", c, a);
  },
  async S3b() {
    // the one-shot S3 timed out (600 s) on the shared GPU: the same request in two smaller steps
    const c = await login("care");
    const sp = await c.space(SERVICE);
    const t = await thread("S3n", c, sp);
    const a = await run("S3b", c, "care", SERVICE, t, "أنشئ قائمة «استبيان رضا المستفيدين - الربع الرابع 2026» لجمع الردود بالأعمدة: قناة التواصل (اختيار: مركز الاتصال 920، البوابة الإلكترونية، تطبيق الجوال، البريد الإلكتروني، الحضور الشخصي)، سهولة الحصول على الخدمة (1-5)، سرعة الحل (1-5)، تعامل الموظف (1-5)، الرضا العام (1-5)، ملاحظات.");
    await confirmAll("S3b", c, a);
  },
  async S3fill() {
    // stands in for replies arriving through the published form (24 colleagues' answers)
    const c = await login("care");
    const sp = await c.space(SERVICE);
    const ls: any[] = (await c.q("lists:forSpace", { spaceId: sp })).lists;
    const l = ls.find((x) => x.title.includes("استبيان"));
    if (!l) throw new Error("no survey list");
    const full: any = await c.q("lists:get", { listId: l._id });
    if (full.rows.length >= 10) return console.log("survey rows exist", full.rows.length);
    const col = (k: string) => full.list.columns.find((x: any) => x.name.includes(k))?.name;
    const chans = ["مركز الاتصال 920", "البوابة الإلكترونية", "تطبيق الجوال", "البريد الإلكتروني", "الحضور الشخصي"];
    const notes = ["الموظف كان متعاوناً لكن الحل تأخر أسبوعاً", "أرسلت بريداً ولم يرد أحد إلا بعد خمسة أيام", "صفحة الدفع تعلق عند إرفاق الملفات", "خدمة ممتازة وسريعة", "", "أتمنى رسالة نصية بحالة الطلب", "اضطررت للاتصال ثلاث مرات", "", "الشرح في البوابة غير واضح للمتطلبات", "شكراً للموظف ياسر على المتابعة"];
    let seed = 7;
    const r = (a: number, b: number) => { seed = (seed * 9301 + 49297) % 233280; return a + Math.floor((seed / 233280) * (b - a + 1)); };
    for (let i = 0; i < 24; i++) {
      const ch = chans[r(0, 4)]!;
      const slow = ch === "البريد الإلكتروني" ? 2 : 0;
      const cells: Record<string, any> = {};
      if (col("قناة")) cells[col("قناة")!] = ch;
      if (col("سهولة")) cells[col("سهولة")!] = r(3, 5);
      if (col("سرعة")) cells[col("سرعة")!] = Math.max(1, r(2, 5) - slow);
      if (col("تعامل")) cells[col("تعامل")!] = r(4, 5);
      if (col("الرضا")) cells[col("الرضا")!] = Math.max(1, r(3, 5) - (slow ? 1 : 0));
      if (col("ملاحظ")) cells[col("ملاحظ")!] = notes[i % notes.length];
      await c.m("lists:addRow", { listId: l._id, cells });
    }
    console.log("survey rows added: 24 to", l.title, full.list.columns.map((x: any) => `${x.name}:${x.type}`).join(", "));
  },
  async S3p() {
    const c = await login("care");
    const a = await run("S3p", c, "care", SERVICE, threads.S3n!, "الآن اكتب صفحة تعريفية قصيرة بالاستبيان (الهدف، المدة دقيقتان، سرية الإجابات) وانشرها لموظفي الهيئة مع نموذج يضيف كل رد صفاً في هذه القائمة.");
    await confirmAll("S3p", c, a);
  },
  async S3c() {
    const c = await login("care");
    await run("S3c", c, "care", SERVICE, threads.S3n!, "لخّص ردود استبيان الرضا حتى الآن: متوسط كل بند، وأضعف بند، وأهم الملاحظات المتكررة.");
  },
  async S4() {
    // shared chat: manager writes to a colleague (team message), the colleague calls the assistant
    const care = await login("care");
    const emp = await login("employee");
    const sp = await care.space(SERVICE);
    const t = await thread("S4", care, sp, true);
    const empId = await idOf(care, sp, "employee@gov-demo.test");
    await care.m("chat:send", { threadId: t, text: "@ياسر الحارثي صباح الخير، عندنا بلاغات مفتوحة متجاوزة للمدة في القائمة. ممكن تراجعها اليوم وتعطيني الأولويات قبل اجتماع الأحد؟", people: [empId] });
    log.push({ id: "S4-team", who: "care", space: SERVICE, prompt: "(رسالة للفريق إلى ياسر)", threadId: t, secs: 0, text: "", citations: 0, tools: [], proposals: [] });
    save();
    await run("S4", emp, "employee", SERVICE, t, "@المساعد من قائمة «البلاغات المفتوحة»: ما البلاغات المتجاوزة للمدة؟ رتّبها حسب الأولوية ثم الأقدم، واقترح الإجراء التالي لكل بلاغ حسب مصفوفة التصعيد في ميثاق مستوى الخدمة.");
    await emp.m("chat:send", { threadId: t, text: "@أمل الغامدي هذه القائمة مرتبة، سأبدأ بالعالية والمُصعّدة وأرفع لك ما يحتاج تصعيد للمرحلة الثانية.", people: [care.userId] });
  },
  async S5() {
    // reader (strategy) reads and asks; must not be able to write
    const c = await login("strategy");
    const sp = await c.space(SERVICE);
    let t: string;
    try { t = await thread("S5", c, sp); } catch (e) { log.push({ id: "S5", who: "strategy", space: SERVICE, prompt: "createThread", threadId: "", secs: 0, text: "", citations: 0, tools: [], proposals: [], error: String(e) }); save(); console.log("S5 createThread:", String(e)); return; }
    await run("S5", c, "strategy", SERVICE, t, "كم كان متوسط رضا المستفيدين في استبيان الربع الثالث، وما أضعف البنود؟");
    const a = await run("S5b", c, "strategy", SERVICE, t, "أضف صفاً جديداً في قائمة «البلاغات المفتوحة» برقم SR-2026-09999 وتصنيف «اقتراح تحسين».");
    for (const p of a.proposals ?? []) { try { const r = await c.confirm(p.id); markConfirmed("S5b", r); } catch (e) { markConfirmed("S5b", { error: String(e) }); console.log("confirm refused:", String(e)); } }
    try { const l: any = await c.q("lists:forSpace", { spaceId: sp }); const id = l.lists.find((x: any) => x.title === "البلاغات المفتوحة")._id; await c.m("lists:addRow", { listId: id, cells: { "رقم البلاغ": "SR-TEST" } }); console.log("UNEXPECTED: reader added a row"); } catch (e) { console.log("reader addRow refused:", String(e)); }
  },
  async S6() {
    // someone outside the space (hr) asks about its data
    const c = await login("hr");
    const t = await thread("S6", c, "" as any).catch(async () => "");
    const tid = t || (threads.S6 = await c.newChat());
    writeFileSync(TH, JSON.stringify(threads, null, 1));
    await run("S6", c, "hr", "(خارج المساحة)", tid, "ما نسبة الالتزام بالمدة في سجل البلاغات والشكاوى 2026 لدى خدمة المستفيدين؟ وما البلاغات المفتوحة الآن؟");
  },
  async S7() {
    // care makes a skill from her analysis chat
    const c = await login("care");
    const d: any = await c.a("skills:draftFromThread", { threadId: threads.S2! });
    console.log("draft:", JSON.stringify(d).slice(0, 1500));
    const id = await c.m("skills:create", { name: d.name || "تقرير-البلاغات", title: d.title || "تقرير البلاغات والتجاوزات", description: d.description || "", instructions: d.instructions || "", fromThreadId: threads.S2!, ...(d.files ? { files: d.files } : {}) });
    log.push({ id: "S7", who: "care", space: SERVICE, prompt: "(احفظ كمهارة من محادثة التحليل)", threadId: threads.S2!, secs: 0, text: JSON.stringify(d).slice(0, 3000), citations: 0, tools: [], proposals: [], confirmed: { skillId: id } });
    save();
  },
  async S7b() {
    const c = await login("care");
    const sp = await c.space(SERVICE);
    const sk: any[] = await c.q("skills:list");
    const skill = (sk as any).mine?.[0] ?? (Array.isArray(sk) ? sk[0] : null);
    console.log("skills:", JSON.stringify(sk).slice(0, 500));
    const t = await thread("S7b", c, sp);
    const log_ = await fileIn(c, sp, "سجل_البلاغات_والشكاوى_2026.xlsx");
    const a = await run("S7b", c, "care", SERVICE, t, `/${skill?.name ?? "تقرير-البلاغات"} لشهر أكتوبر 2026 فقط`, { skillId: skill?._id ?? skill?.id, mentions: [{ kind: "file", id: log_ }] });
    await confirmAll("S7b", c, a);
  },
  async S8() {
    const c = await login("care");
    const sp = await c.space(SERVICE);
    const t = await thread("S8", c, sp);
    await run("S8", c, "care", SERVICE, t, "قارن بين قرارات محضر اجتماع الفريق رقم 9 وبين «إجراء معالجة البلاغات والشكاوى» و«ميثاق مستوى الخدمة»: هل يوجد قرار يتعارض مع الإجراء أو يحتاج تعديله؟ واذكر المسؤول والموعد لكل قرار.");
  },
  async S9() {
    const c = await login("care");
    const a = await run("S9", c, "care", SERVICE, threads.S2!, "اكتب من هذه النتائج مذكرة رسمية موجزة من مديرة خدمة المستفيدين إلى مديرة مكتب الرئيس التنفيذي بنتائج الالتزام بالمدد وأسباب التجاوز وثلاث توصيات، واحفظها مستنداً أستطيع تصديره Word.");
    await confirmAll("S9", c, a);
  },
  async I1() {
    const c = await login("employee");
    const sp = await c.space(IT);
    const t = await thread("I1", c, sp);
    await run("I1", c, "employee", IT, t, "وصلتني رسالة بريد تقول «حدّث كلمة مرورك خلال 24 ساعة» وضغطت الرابط ودخلت اسم المستخدم وكلمة المرور، وبعدها انتبهت إنها مشبوهة. وش أسوي الحين؟ وهل أطفي الجهاز؟");
  },
  async I1b() {
    const c = await login("employee");
    await run("I1b", c, "employee", IT, threads.I1!, "وهل مسموح أستخدم فلاش USB شخصي عشان أنقل عرض تقديمي للاجتماع؟");
  },
  async S3pub() {
    const c = await login("care");
    const a = await run("S3pub", c, "care", SERVICE, threads.S3n!, "النشر لم يتم (المخرج غير موجود). انشر تطبيق الاستبيان الذي أنشأته الآن لموظفي الهيئة.");
    await confirmAll("S3pub", c, a);
  },
  async S3fix() {
    const c = await login("care");
    const a = await run("S3fix", c, "care", SERVICE, threads.S3n!, "حذفتُ القائمة المكررة الفارغة. عدّل تطبيق الاستبيان ليضيف الردود إلى قائمة «استبيان رضا المستفيدين - الربع الرابع 2026» الموجودة الآن في المساحة (فيها 24 رداً)، جرّبه، ثم انشره لموظفي الهيئة.", { timeoutMs: 15 * 60_000 });
    await confirmAll("S3fix", c, a);
  },
  async S3fix2() {
    const c = await login("care");
    const a = await run("S3fix2", c, "care", SERVICE, threads.S3n!, "لا نريد عمود «المرسل»: الإجابات سرية. حدّث التطبيق بدون مرسل على القائمة نفسها، جرّبه، ثم انشره لموظفي الهيئة.", { timeoutMs: 15 * 60_000 });
    await confirmAll("S3fix2", c, a);
  },
  async I1c() {
    const c = await login("employee");
    const sp = await c.space(IT);
    const f = await fileIn(c, sp, "سياسة_الأمن_السيبراني.pdf");
    await run("I1c", c, "employee", IT, threads.I1!, "وهل مسموح أستخدم فلاش USB شخصي عشان أنقل عرض تقديمي للاجتماع؟", { mentions: [{ kind: "file", id: f }] });
  },
  async I2r() {
    const c = await login("admin");
    const sp = await c.space(IT);
    const f = await fileIn(c, sp, "سجل_الحوادث_الأمنية_2026.xlsx");
    const a = await run("I2r", c, "admin", IT, threads.I2!, "بشكل مختصر: عدد الحوادث حسب النوع وحسب المستوى، ومتوسط «زمن الاستجابة (دقيقة)» لكل مستوى، مع رسم أعمدة لعدد الحوادث حسب النوع.", { mentions: [{ kind: "file", id: f }] });
    await confirmAll("I2r", c, a);
  },
  async I2() {
    const c = await login("admin");
    const sp = await c.space(IT);
    const t = await thread("I2", c, sp);
    const f = await fileIn(c, sp, "سجل_الحوادث_الأمنية_2026.xlsx");
    const a = await run("I2", c, "admin", IT, t, "حلّل سجل الحوادث الأمنية 2026: عدد الحوادث حسب النوع والمستوى، ومتوسط زمن الاستجابة لكل مستوى مقارنة بالأزمنة المستهدفة في إجراء الاستجابة للحوادث (P1 15 دقيقة، P2 ساعة، P3 4 ساعات، P4 يوم عمل)، مع رسم بياني لعدد الحوادث شهرياً حسب النوع.", { mentions: [{ kind: "file", id: f }] });
    await confirmAll("I2", c, a);
  },
  async I3() {
    const c = await login("admin");
    const sp = await c.space(IT);
    const t = await thread("I3", c, sp);
    const a = await run("I3", c, "admin", IT, t, "ابنِ تطبيقاً صغيراً لتسجيل الزوار عند الاستقبال حسب المادة (10) من سياسة الأمن السيبراني: نموذج فيه اسم الزائر، الجهة، رقم الجوال، الإدارة المضيفة (قائمة اختيار)، اسم الموظف المرافق، وقت الدخول، وهل يحتاج شبكة الضيوف. يتحقق أن رقم الجوال سعودي يبدأ بـ05 من 10 أرقام، ويحفظ كل تسجيل في قائمة «سجل الزوار» ويعرض رقم بطاقة زائر. جرّبه قبل ما تعطيني إياه، ثم انشره لموظفي الهيئة.", { timeoutMs: 15 * 60_000 });
    await confirmAll("I3", c, a);
  },
  async I3s() {
    // the full request (I3) timed out at 600 s before write_app: a smaller first version
    const c = await login("admin");
    const sp = await c.space(IT);
    const t = await thread("I3s", c, sp);
    const a = await run("I3s", c, "admin", IT, t, "تطبيق صغير لتسجيل الزوار عند الاستقبال: صفحة واحدة بنموذج (اسم الزائر، الجهة، رقم الجوال، الإدارة المضيفة) يحفظ كل تسجيل في قائمة «سجل الزوار». اجعله بسيطاً وجرّبه.", { timeoutMs: 15 * 60_000 });
    await confirmAll("I3s", c, a);
  },
  async I3t() {
    const c = await login("admin");
    const a = await run("I3t", c, "admin", IT, threads.I3s!, "قائمة «سجل الزوار» أُنشئت الآن. اكتب التطبيق عليها هي (لا على قائمة الحوادث)، وجرّبه بتسجيل زائر تجريبي.", { timeoutMs: 15 * 60_000 });
    await confirmAll("I3t", c, a);
  },
  async S3fix3() {
    const c = await login("care");
    const a = await run("S3fix3", c, "care", SERVICE, threads.S3n!, "النسخة 2 من التطبيق لا تكتب في أي قائمة. أعد ربطه بقائمة «استبيان رضا المستفيدين - الربع الرابع 2026» بحيث تضيف الصفحة صفاً بالأعمدة الستة (بدون مرسل)، جرّبه بـtest_app، ثم انشره لموظفي الهيئة.", { timeoutMs: 15 * 60_000 });
    await confirmAll("S3fix3", c, a);
  },
  async I3u() {
    const c = await login("admin");
    const a = await run("I3u", c, "admin", IT, threads.I3s!, "لا توجد مهارة اسمها visitor-log. اكتب التطبيق من الصفر بـwrite_app (بدون fromSkill) على قائمة «سجل الزوار»، ثم جرّبه بتسجيل زائر تجريبي.", { timeoutMs: 15 * 60_000 });
    await confirmAll("I3u", c, a);
  },
  async I3v() {
    // a fresh chat: the earlier one kept proposing write_app with a skill that doesn't exist
    const c = await login("admin");
    const sp = await c.space(IT);
    const t = await thread("I3v", c, sp);
    const a = await run("I3v", c, "admin", IT, t, "ابنِ تطبيقاً بسيطاً يضيف صفاً إلى قائمة «سجل الزوار» الموجودة في هذه المساحة: نموذج بالأعمدة (اسم الزائر، الجهة، رقم الجوال، الإدارة المضيفة) وزر «تسجيل»، ثم رسالة «تم التسجيل». جرّبه بزائر تجريبي.", { timeoutMs: 15 * 60_000 });
    await confirmAll("I3v", c, a);
  },
  async I3b() {
    const c = await login("admin");
    const a = await run("I3b", c, "admin", IT, threads.I3!, "تابع: أكمل ما تبقى (القائمة، التطبيق، التجربة، النشر).", { timeoutMs: 15 * 60_000 });
    await confirmAll("I3b", c, a);
  },
  async I4() {
    // outsider: legal is not in the IT space
    const c = await login("legal");
    threads.I4 ??= await c.newChat();
    writeFileSync(TH, JSON.stringify(threads, null, 1));
    await run("I4", c, "legal", "(خارج المساحة)", threads.I4!, "ما الحوادث الأمنية المفتوحة الآن في سجل الحوادث الأمنية 2026، وما الحادث المتعلق بالشؤون القانونية؟");
  },
  async S1b() {
    const c = await login("employee");
    await run("S1b", c, "employee", SERVICE, threads.S1m!, "وإذا كان ترخيصه منتهي من شهرين ونص، كم غرامة التأخير؟ أضفها للرد.");
  },
};

if (import.meta.main) {
  if (process.argv[2] === "follow") {
    // waits for the follow-up turn a confirmed proposal starts, logs it, confirms the next card (up to N rounds)
    const [, , , name, who, rounds = "3"] = process.argv;
    const c = await login(who!);
    const tid = threads[name!]!;
    for (let i = 0; i < Number(rounds); i++) {
      const t0 = Date.now();
      let r: any;
      for (;;) {
        r = await c.q("chat:messages", { threadId: tid });
        if (!r.turn || r.turn.state === "done" || r.turn.state === "failed") break;
        await new Promise((x) => setTimeout(x, 4000));
      }
      const last = [...r.messages].reverse().find((m: any) => m.role === "assistant");
      const pend = (last?.proposals ?? []).filter((p: any) => p.state === "pending");
      log.push({ id: `${name}-follow${i + 1}`, who: who!, space: "", prompt: "(متابعة بعد «نفّذ»)", threadId: tid, secs: Math.round((Date.now() - t0) / 1000), text: last?.text ?? "", citations: last?.citations?.length ?? 0, tools: (last?.toolRuns ?? []).map((t: any) => `${t.name}${t.ok ? "" : "✗"}`), proposals: (last?.proposals ?? []).map((p: any) => ({ id: p.id, tool: p.tool, state: p.state })), ...(r.turn?.state === "failed" ? { error: r.turn.error } : {}) });
      save();
      console.log(`\n### ${name}-follow${i + 1} turn=${r.turn?.state} tools=${log.at(-1)!.tools} props=${JSON.stringify(log.at(-1)!.proposals)}\n${(last?.text ?? "").slice(0, 2500)}`);
      if (!pend.length) break;
      await confirmAll(`${name}-follow${i + 1}`, c, { proposals: pend } as any);
    }
  }
  if (process.argv[2] === "chat") for (const id of process.argv.slice(3)) await steps[id]!();
  const mode = process.argv[2] ?? "setup";
  if (mode === "setup") {
    await setupService();
    await setupIT();
    console.log("setup done");
  }
}
