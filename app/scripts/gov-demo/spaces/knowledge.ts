// Government demo — the "knowledge" spaces: «السياسات واللوائح» (everyone reads it), «الشؤون القانونية»
// and «مكتب الرئيس التنفيذي». Sets each space up as its real owners would, through the public API.
//
//   bun scripts/gov-demo/spaces/knowledge.ts setup     # files, instructions, memory, tasks, lists,
//                                                      # records, letter template + issued letters, schedule
//   bun scripts/gov-demo/spaces/knowledge.ts chats     # the persona chats (slow: local models), logged to
//                                                      # content/knowledge/chat-log.json
//
// Re-runnable: each space is skipped if it already has files; chats are skipped if already logged.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { login, type Client } from "../lib.ts";

const DIR = join(import.meta.dir, "..", "content", "knowledge");
const LOG = join(DIR, "chat-log.json");
const f = (name: string) => join(DIR, name);
const POL = "السياسات واللوائح";
const LEG = "الشؤون القانونية";
const OFF = "مكتب الرئيس التنفيذي";
const day = (iso: string) => Date.parse(`${iso}T12:00:00+03:00`);

async function users(c: Client, spaceId: string) {
  const rows: any[] = await c.q("spaces:members", { spaceId });
  const by = (name: string) => rows.find((r) => (r.name ?? "").includes(name))?.userId as string;
  return { rows, by };
}

async function hasFiles(c: Client, spaceId: string) {
  const files: any[] = await c.q("files:list", { spaceId });
  return files.length > 0;
}

async function uploadAll(c: Client, spaceId: string, names: string[]) {
  for (const n of names) {
    await c.upload(spaceId, f(n));
    console.log("  uploaded", n);
  }
}

async function list(c: Client, spaceId: string, title: string, description: string, columns: any[], rows: Record<string, unknown>[]) {
  const listId: string = await c.m("lists:create", { spaceId, title, description, columns });
  for (const cells of rows) await c.m("lists:addRow", { listId, cells });
  console.log(`  list «${title}» (${rows.length} rows)`);
  return listId;
}

// ---------------------------------------------------------------- «السياسات واللوائح»
async function setupPolicies() {
  const legal = await login("legal");
  const sp = await legal.space(POL);
  if (await hasFiles(legal, sp)) return console.log(`${POL}: already set up`);
  console.log(POL);
  await uploadAll(legal, sp, [
    "لائحة_الموارد_البشرية_الداخلية.docx",
    "مدونة_قواعد_السلوك_الوظيفي.pdf",
    "مصفوفة_الصلاحيات.xlsx",
    "سياسة_حماية_البيانات_الشخصية_الداخلية.pdf",
    "لائحة_المشتريات_والعقود_الداخلية.docx",
  ]);
  await legal.m("spaces:setInstructions", {
    spaceId: sp,
    instructions: [
      "هذه المساحة هي المرجع الرسمي الموحّد للوائح والسياسات الداخلية للهيئة، ويقرؤها جميع الموظفين.",
      "- أجب من ملفات المساحة فقط، واذكر اسم اللائحة ورقم المادة في كل إجابة (مثال: لائحة الموارد البشرية الداخلية، المادة 8).",
      "- إن لم تجد نصاً صريحاً فقل ذلك بوضوح ووجّه الموظف إلى الشؤون القانونية (legal@gov-demo.test)، ولا تجتهد ولا تفترض.",
      "- عند السؤال عن «من يعتمد» أو «من يوقّع» ارجع إلى مصفوفة الصلاحيات واذكر رقم الصف والحد المالي.",
      "- اكتب بلغة عربية رسمية واضحة ومختصرة، وابدأ بالجواب المباشر ثم التفاصيل.",
      "- لا تقدّم رأياً قانونياً في حالة فردية؛ اشرح النص فقط.",
    ].join("\n"),
  });
  await legal.m("memory:addSpace", { spaceId: sp, kind: "fact", text: "الإصدار المعمول به من لائحة الموارد البشرية الداخلية هو الإصدار الثالث، النافذ من 2026/05/01م." });
  await legal.m("memory:addSpace", { spaceId: sp, kind: "term", text: "«الإدارة المختصة» في اللوائح تعني الإدارة العامة للموارد البشرية ما لم يذكر غير ذلك." });
  await legal.m("memory:addSpace", { spaceId: sp, kind: "decision", text: "عند تعارض حدود الشراء بين اللوائح يُعمل بلائحة الصلاحيات المالية وإجراءات الشراء (المالية) ومصفوفة الصلاحيات المحدّثة في 2026/11." });
  const { by } = await users(legal, sp);
  await list(legal, sp, "خطة مراجعة اللوائح والسياسات 2027", "كل لائحة ومالكها وموعد مراجعتها الدورية", [
    { name: "اللائحة/السياسة", type: "text" },
    { name: "الجهة المالكة", type: "text" },
    { name: "آخر اعتماد", type: "date" },
    { name: "موعد المراجعة", type: "date" },
    { name: "الحالة", type: "status", options: ["لم تبدأ", "قيد المراجعة", "معتمدة"] },
    { name: "المسؤول", type: "person" },
  ], [
    { "اللائحة/السياسة": "لائحة الموارد البشرية الداخلية", "الجهة المالكة": "الموارد البشرية", "آخر اعتماد": "2026-04-19", "موعد المراجعة": "2027-03-31", "الحالة": "لم تبدأ", "المسؤول": by("العنزي") },
    { "اللائحة/السياسة": "مدونة قواعد السلوك الوظيفي", "الجهة المالكة": "الشؤون القانونية", "آخر اعتماد": "2026-02-08", "موعد المراجعة": "2027-01-15", "الحالة": "قيد المراجعة", "المسؤول": by("العنزي") },
    { "اللائحة/السياسة": "مصفوفة الصلاحيات", "الجهة المالكة": "مكتب الرئيس التنفيذي", "آخر اعتماد": "2026-11-01", "موعد المراجعة": "2027-06-30", "الحالة": "معتمدة", "المسؤول": by("العنزي") },
    { "اللائحة/السياسة": "سياسة حماية البيانات الشخصية الداخلية", "الجهة المالكة": "مكتب إدارة البيانات", "آخر اعتماد": "2026-03-15", "موعد المراجعة": "2027-03-15", "الحالة": "لم تبدأ", "المسؤول": by("العنزي") },
    { "اللائحة/السياسة": "لائحة المشتريات والعقود الداخلية", "الجهة المالكة": "المشتريات والعقود", "آخر اعتماد": "2026-01-20", "موعد المراجعة": "2026-12-31", "الحالة": "قيد المراجعة", "المسؤول": by("العنزي") },
  ]);
  const t = await legal.m("tasks:create", {
    spaceId: sp,
    title: "إطلاق الإقرار السنوي بالاطلاع على مدونة السلوك (يناير 2027)",
    body: "وفق المادة (3) من مدونة قواعد السلوك: يوقّع كل موظف في يناير إقراراً بالاطلاع. المطلوب: تجهيز نموذج الإقرار، وتعميمه، ومتابعة النسبة.",
    assigneeIds: [legal.userId],
    due: day("2027-01-05"),
    priority: "normal",
  });
  await legal.m("tasks:comment", { taskId: t, body: "سأجهّز نموذج الإقرار كنموذج منشور في المساحة نفسها، ونربط الردود بقائمة لمتابعة النسبة." });
}

// The yearly acknowledgment of the code of conduct (المادة 3): a page published to the whole
// workspace with a form whose replies land in a list of the space.
async function setupAcknowledgment() {
  const legal = await login("legal");
  const sp = await legal.space(POL);
  const lists: any[] = (await legal.q("lists:forSpace", { spaceId: sp })).lists;
  const TITLE = "إقرارات الاطلاع على مدونة السلوك 2027";
  const listId = lists.find((l) => l.title === TITLE)?._id ?? await list(legal, sp, TITLE, "ردود نموذج الإقرار السنوي (المادة 3 من مدونة قواعد السلوك)", [
    { name: "الإدارة", type: "select", options: ["مكتب الرئيس التنفيذي", "الموارد البشرية", "الشؤون القانونية", "المالية والمشتريات", "خدمة المستفيدين", "التدريب والتطوير", "التخطيط الاستراتيجي", "تقنية المعلومات"] },
    { name: "أقر بالاطلاع والالتزام", type: "check" },
    { name: "لدي تعارض مصالح أرغب في الإفصاح عنه", type: "check" },
    { name: "ملاحظات", type: "text" },
  ], []);
  const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>الإقرار السنوي بمدونة السلوك</title>
<style>body{font-family:'Noto Naskh Arabic',serif;max-width:720px;margin:24px auto;padding:0 16px;line-height:1.8;color:#1d2b25}h1{font-size:1.5rem}li{margin:4px 0}.note{background:#eef4f0;padding:10px 14px;border-radius:8px}</style></head>
<body><h1>الإقرار السنوي بالاطلاع على مدونة قواعد السلوك الوظيفي — 2027</h1>
<p>وفق المادة (3) من مدونة قواعد السلوك الوظيفي، يوقّع كل موظف في شهر يناير إقراراً بالاطلاع على المدونة والالتزام بها. أهم ما تذكّر به المدونة:</p>
<ul><li>لا تُقبل هدية تتجاوز قيمتها 300 ريال، ولا هدايا نقدية مطلقاً، وتُسجّل كل هدية خلال 3 أيام عمل (المواد 7–8).</li>
<li>الإفصاح عن أي تعارض مصالح خلال 7 أيام من العلم به، والإفصاح السنوي في يناير (المادة 5).</li>
<li>لا عمل خارجي إلا بموافقة كتابية من الرئيس التنفيذي (المادة 6).</li>
<li>لا يتحدث باسم الهيئة إلا المتحدث الرسمي (المادة 12).</li>
<li>قناة «نزاهة الداخلية» للإبلاغ، والمبلّغ بحسن نية محمي (المادتان 16–17).</li></ul>
<p class="note">النص الكامل في مساحة «السياسات واللوائح»، ويمكنك سؤال المساعد عن أي مادة.</p></body></html>`;
  const arts: any[] = await legal.q("artifacts:list", { spaceId: sp });
  let artifactId: string = arts.find((a) => a.title === "الإقرار السنوي بمدونة السلوك 2027")?._id;
  if (artifactId && (await legal.q("publications:forArtifact", { artifactId })).publications.length) return console.log("acknowledgment: already published");
  if (!artifactId) {
    const r: any = await legal.m("artifacts:create", { title: "الإقرار السنوي بمدونة السلوك 2027", kind: "html", content: html, spaceId: sp });
    artifactId = typeof r === "string" ? r : r.artifactId;
  }
  try {
    const pub: any = await legal.m("publications:publish", { artifactId, audience: "workspace" });
    const opts: any[] = await legal.q("publications:formOptions", { publicationId: pub.id });
    const cols = opts.find((o) => o._id === listId).columns;
    await legal.m("publications:setForm", {
      publicationId: pub.id,
      form: { listId, fields: cols.map((c: any) => ({ key: c.key, required: c.name !== "ملاحظات" })), recordSender: true, thanks: "شكراً لك، سُجّل إقرارك.", onePerReader: true },
    });
    console.log("  published", pub.state, pub.url);
  } catch (e) {
    console.log("  publish failed:", (e as Error).message);
  }
}

// ---------------------------------------------------------------- «الشؤون القانونية»
async function setupLegal() {
  const legal = await login("legal");
  const sp = await legal.space(LEG);
  if (await hasFiles(legal, sp)) return console.log(`${LEG}: already set up`);
  console.log(LEG);
  await uploadAll(legal, sp, [
    "مسودة_عقد_خدمات_الدعم_الفني_والتشغيل.docx",
    "مذكرة_رأي_قانوني_عقد_صيانة_المباني.pdf",
    "سجل_العقود.xlsx",
    "سجل_القضايا_والتظلمات.xlsx",
  ]);
  await legal.m("spaces:setInstructions", {
    spaceId: sp,
    instructions: [
      "مساحة الشؤون القانونية: مراجعة العقود، والرأي القانوني، ومتابعة القضايا والعقود.",
      "- عند مراجعة أي عقد قارنه بلائحة المشتريات والعقود الداخلية وسياسة حماية البيانات الشخصية (في مساحة «السياسات واللوائح») وبمذكرات الرأي السابقة.",
      "- صنّف كل ملاحظة إلى: «مخالفة نظامية» أو «خطر تعاقدي» أو «ملاحظة صياغة»، واذكر رقم مادة العقد ورقم مادة اللائحة.",
      "- اعرض الملاحظات في جدول: م | البند | الملاحظة | التصنيف | التوصية، ثم قائمة بالبنود الإلزامية الناقصة.",
      "- لا تصدر رأياً نهائياً؛ الرأي يعتمده المستشار القانوني.",
      "- المبالغ بالريال السعودي، والتواريخ ميلادية بصيغة سنة/شهر/يوم.",
    ].join("\n"),
  });
  await legal.m("memory:addSpace", { spaceId: sp, kind: "decision", text: "لا تقبل الهيئة التحكيم خارج المملكة؛ جهة الاختصاص المحاكم الإدارية (ديوان المظالم) ما لم يصدر استثناء نظامي." });
  await legal.m("memory:addSpace", { spaceId: sp, kind: "preference", text: "مذكرات الرأي القانوني تُرقّم بالصيغة: ش ق/السنة/رقم تسلسلي من ثلاث خانات." });
  const { by } = await users(legal, sp);
  const t1 = await legal.m("tasks:create", {
    spaceId: sp,
    title: "مذكرة الرأي القانوني في مسودة عقد الدعم الفني — قرار اللجنة 9/1",
    body: "مراجعة مسودة عقد شركة المدار المتقدم (4,850,000 ريال) مقابل لائحة المشتريات والعقود وسياسة حماية البيانات، وإصدار المذكرة بقائمة المخاطر والبنود الناقصة.",
    assigneeIds: [legal.userId],
    due: day("2026-11-30"),
    priority: "urgent",
  });
  await legal.m("tasks:setStatus", { taskId: t1, status: "inProgress" });
  await legal.m("tasks:comment", { taskId: t1, body: `@نورة القحطاني أبدأ المراجعة اليوم؛ القراءة الأولية تظهر مخالفات في الدفعة المقدمة والتجديد التلقائي والتحكيم. سأرسل لكِ المذكرة لتعدّي خطاب الملاحظات للمورد (قرار 9/2).`, mentions: [by("القحطاني")] });
  const office = await login("office");
  await office.m("tasks:comment", { taskId: t1, body: "تم، سأجهز مسودة الخطاب على النموذج المعتمد بمجرد وصول المذكرة. هل نذكر للمورد مهلة 10 أيام عمل للرد؟" });
  const t2 = await legal.m("tasks:create", {
    spaceId: sp,
    title: "تجهيز ملحقات التمديد للعقود «قيد التجديد» في سجل العقود",
    body: "حصر العقود التي حالتها «قيد التجديد» وإعداد ملحق تمديد لكل منها وفق المادة (10) من لائحة المشتريات (لا تجديد تلقائي).",
    assigneeIds: [by("القحطاني")],
    due: day("2026-12-15"),
    priority: "high",
  });
  await legal.m("tasks:comment", { taskId: t2, body: "@نورة القحطاني الحصر موجود في «سجل العقود»؛ يمكنكِ سؤال المساعد في المساحة عن قائمتها مباشرة.", mentions: [by("القحطاني")] });
  await list(legal, sp, "الجلسات القادمة", "مواعيد الجلسات القادمة من سجل القضايا", [
    { name: "رقم القضية", type: "text" },
    { name: "الموضوع", type: "text" },
    { name: "جهة النظر", type: "text" },
    { name: "موعد الجلسة", type: "date" },
    { name: "المسؤول", type: "person" },
    { name: "المذكرة جاهزة", type: "check" },
  ], [
    { "رقم القضية": "ق-2026-004", "الموضوع": "اعتراض على غرامات تأخير — شركة ركائز للأثاث", "جهة النظر": "المحكمة الإدارية بالرياض", "موعد الجلسة": "2026-12-03", "المسؤول": by("العنزي"), "المذكرة جاهزة": false },
    { "رقم القضية": "ق-2025-011", "الموضوع": "طلب إلغاء قرار ترسية", "جهة النظر": "المحكمة الإدارية بالرياض", "موعد الجلسة": "2026-12-10", "المسؤول": by("العنزي"), "المذكرة جاهزة": true },
    { "رقم القضية": "ق-2026-019", "الموضوع": "تظلم من جزاء حسم", "جهة النظر": "لجنة التظلمات الداخلية", "موعد الجلسة": "2026-12-14", "المسؤول": by("القحطاني"), "المذكرة جاهزة": false },
  ]);
}

// ---------------------------------------------------------------- «مكتب الرئيس التنفيذي»
async function setupOffice() {
  const office = await login("office");
  const sp = await office.space(OFF);
  if (await hasFiles(office, sp)) return console.log(`${OFF}: already set up`);
  console.log(OFF);
  await uploadAll(office, sp, [
    "محضر_اجتماع_اللجنة_التنفيذية_رقم_7.docx",
    "محضر_اجتماع_اللجنة_التنفيذية_رقم_8.docx",
    "محضر_اجتماع_اللجنة_التنفيذية_رقم_9.pdf",
    "دليل_المراسلات_ونموذج_الخطاب_الرسمي.docx",
    "سجل_المراسلات_الصادرة_والواردة.xlsx",
  ]);
  await office.m("spaces:setInstructions", {
    spaceId: sp,
    instructions: [
      "مساحة مكتب الرئيس التنفيذي: المراسلات والخطابات الرسمية، ومحاضر اللجنة التنفيذية، ومتابعة القرارات.",
      "- الخطابات الرسمية تتبع «دليل المراسلات ونموذج الخطاب الرسمي» حرفياً: الرقم ص/1448/....، التاريخ الهجري ثم الميلادي، المخاطبة (معالي/سعادة/السادة)، «السلام عليكم ورحمة الله وبركاته، وبعد:»، الخاتمة المعتمدة، ثم صاحب التوقيع وفق مصفوفة الصلاحيات.",
      "- عند استخراج القرارات من المحاضر اذكر رقم القرار (مثل 9/1) والمسؤول والموعد النهائي كما وردت، ولا تخترع مواعيد.",
      "- القرارات المتأخرة: كل قرار تجاوز موعده ولم يُذكر أنه «منجز» في محضر لاحق.",
      "- لغة رسمية موجزة؛ لا تفصح عن مضمون المحاضر خارج هذه المساحة.",
    ].join("\n"),
  });
  await office.m("memory:addSpace", { spaceId: sp, kind: "fact", text: "الرئيس التنفيذي: د. خالد بن سعد الراشد. نائب الرئيس للخدمات المشتركة: م. سامي بن فهد العتيبي." });
  await office.m("memory:addSpace", { spaceId: sp, kind: "preference", text: "تقرير المتابعة الأسبوعي يُرفع للرئيس التنفيذي صباح كل أحد، مرتباً: المتأخر أولاً ثم المستحق هذا الأسبوع." });
  const { by } = await users(office, sp);
  // Decisions of meeting 9 that fall to members of this space become tasks.
  const tasks: [string, string, string[], string, "normal" | "high" | "urgent"][] = [
    ["قرار 9/2: خطاب رسمي لشركة المدار المتقدم بملاحظات الهيئة على مسودة العقد", "بعد صدور مذكرة الرأي القانوني (قرار 9/1). يوقّعه مدير الإدارة المختصة مع نسخة لمكتب الرئيس التنفيذي وفق مصفوفة الصلاحيات.", [office.userId], "2026-12-03", "high"],
    ["قرار 9/4: تعميم طلب مدخلات التقرير السنوي 2026 على الإدارات", "تسلم الإدارات مدخلاتها قبل 2026/12/10م. المطلوب تعميم + متابعة الاستلام.", [by("الشمري")], "2026-12-10", "normal"],
    ["قرار 9/5: تعميم مساحة العمل الذكية على جميع الإدارات", "تدريب ممثل من كل إدارة، وبدء التعميم 2026/12/01م، مع تقرير متابعة أسبوعي لمكتب الرئيس التنفيذي.", [by("الحربي")], "2026-12-01", "urgent"],
    ["قرار 9/6: تقرير المتابعة الأسبوعي لقرارات اللجنة", "يرفع كل أحد. تم إعداد مهمة مجدولة في المساعد تجهز المسودة تلقائياً.", [office.userId], "2026-11-29", "normal"],
  ];
  const ids: string[] = [];
  for (const [title, body, assigneeIds, due, priority] of tasks) ids.push(await office.m("tasks:create", { spaceId: sp, title, body, assigneeIds, due: day(due), priority }));
  await office.m("tasks:comment", { taskId: ids[1], body: "@لمى الشمري أرفقتُ نص القرار؛ نحتاج نموذجاً موحداً للمدخلات، هل يمكن إعداده كنموذج منشور تجمع ردوده في قائمة؟", mentions: [by("الشمري")] });
  const strategy = await login("strategy");
  await strategy.m("tasks:setStatus", { taskId: ids[1], status: "inProgress" });
  await strategy.m("tasks:comment", { taskId: ids[1], body: "بدأت. سأرسل التعميم غداً وأتابع الاستلام في قائمة." });
  await office.m("tasks:comment", { taskId: ids[2], body: "@فيصل الحربي الرئيس يطلب عرضاً قصيراً في اجتماع اللجنة القادم عن نسبة التعميم.", mentions: [by("الحربي")] });

  // Assignment letters (خطاب تكليف): a record set from Excel + a Word template + letters issued in one batch.
  const xbytes = readFileSync(f("بيانات_خطابات_التكليف.xlsx"));
  const b64 = Buffer.from(xbytes).toString("base64");
  const an: any = await office.a("records:analyzeFile", { spaceId: sp, fileName: "بيانات_خطابات_التكليف.xlsx", dataBase64: b64 });
  if (!an.ok) throw new Error("analyze: " + an.errors.join(" | "));
  const cr: any = await office.a("records:createFromFile", {
    spaceId: sp,
    name: "تكليفات قرارات اللجنة التنفيذية (اجتماع 9)",
    fileName: "بيانات_خطابات_التكليف.xlsx",
    dataBase64: b64,
    // Every column as text: «9/1» is a decision number, not a date (Excel and LibreOffice turn it into one).
    columns: an.columns.map((c: any) => ({ header: c.header, type: "text", required: true })),
    ownerHeader: "الرقم الوظيفي",
    ownerKind: "employeeNo",
    uniqueBy: ["الرقم الوظيفي", "المهمة"],
  });
  if (!cr.ok) throw new Error("records: " + cr.errors.join(" | "));
  console.log(`  record set (${cr.rowCount} rows), owner matched ${an.owner?.matched}/${an.owner?.distinct}`);
  const docx = Buffer.from(readFileSync(f("قالب_خطاب_تكليف.docx"))).toString("base64");
  const chk: any = await office.a("templates:analyzeWord", { spaceId: sp, recordSetId: cr.recordSetId, dataBase64: docx });
  if (chk.unmatched.length) throw new Error("template variables not matched: " + chk.unmatched.join(", "));
  const tv: any = await office.a("templates:saveWord", { spaceId: sp, recordSetId: cr.recordSetId, dataBase64: docx, name: "خطاب تكليف" });
  await office.m("templates:approveVersion", { templateId: tv.templateId, version: tv.version });
  const rows: any = await office.q("documents:rowsForTemplate", { templateId: tv.templateId });
  const req: any = await office.m("documents:requestMany", { templateId: tv.templateId, recordIds: rows.rows.map((r: any) => r.recordId) });
  const iss: any = await office.a("documents:approveAndIssue", { documentIds: req.documents.map((d: any) => d.documentId) });
  console.log(`  letters issued: ${iss.issued.length}, failed: ${iss.failed.length}`, iss.failed);

  // Weekly follow-up summary every Sunday morning.
  await office.m("schedules:create", {
    title: "تقرير المتابعة الأسبوعي لقرارات اللجنة التنفيذية",
    prompt:
      "من محاضر اللجنة التنفيذية في المساحة: أعدّ تقرير متابعة أسبوعي للرئيس التنفيذي بالقرارات غير المنجزة. جدول: رقم القرار | القرار | المسؤول | الموعد النهائي | الحالة (متأخر/مستحق هذا الأسبوع/لاحق). المتأخر أولاً. ثم ثلاث نقاط توصيات قصيرة.",
    spaceId: sp,
    recurrence: { kind: "weekly", weekday: 0, time: "08:00" },
  });
  console.log("  weekly schedule created");
}

// ---------------------------------------------------------------- chats
type Log = { recovered?: boolean; id: string; space: string; as: string; prompt: string; ms: number | null; wall: number; text: string; citations: number; tools: string[]; proposals: number; confirmed?: string; error?: string; threadId: string };

function readLog(): Log[] {
  return existsSync(LOG) ? JSON.parse(readFileSync(LOG, "utf8")) : [];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until the thread has no running turn; returns its last assistant message. */
async function settle(c: Client, threadId: string, timeoutMs = 40 * 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r: any = await c.q("chat:messages", { threadId });
    const msgs: any[] = r.messages ?? r;
    if (!r.turn || r.turn.state === "done" || r.turn.state === "failed" || Date.now() > end) {
      const last = [...msgs].reverse().find((m) => m.role === "assistant");
      return { last, failed: r.turn?.state === "failed" ? (r.turn.error ?? "failed") : null, msgs };
    }
    await sleep(5000);
  }
}

function save(entry: Log) {
  const cur = readLog().filter((l) => l.id !== entry.id);
  cur.push(entry);
  writeFileSync(LOG, JSON.stringify(cur, null, 1));
}

// One chat as a persona. Resumable: a chat that was cut off (timeout) reuses its thread, waits for
// the running answer and records it, then goes on with the remaining prompts.
async function run(id: string, as: string, spaceName: string | null, prompts: string[], opts: { confirm?: boolean; mentionSpaces?: string[]; mentionFiles?: [string, string][]; effort?: "fast" | "deep"; inThreadOf?: string } = {}) {
  const log = readLog();
  if (log.some((l) => l.id === id)) return console.log(`chat ${id}: already done`);
  const c = await login(as);
  const sp = spaceName ? await c.space(spaceName) : undefined;
  let mentions: { kind: "file" | "space"; id: string }[] | undefined = opts.mentionSpaces ? await Promise.all(opts.mentionSpaces.map(async (n) => ({ kind: "space" as const, id: await c.space(n) }))) : undefined;
  if (opts.mentionFiles) {
    const fm: { kind: "file"; id: string }[] = [];
    for (const [space, name] of opts.mentionFiles) {
      const files: any[] = await c.q("files:list", { spaceId: await c.space(space) });
      fm.push({ kind: "file" as const, id: files.find((x) => x.name === name)._id });
    }
    mentions = [...(mentions ?? []), ...fm];
  }
  const prior = log.filter((l) => l.id.startsWith(`${id}.`));
  const threadId = prior[0]?.threadId ?? (opts.inThreadOf ? log.find((l) => l.id === `${opts.inThreadOf}.1`)!.threadId : await c.newChat(sp));
  for (let i = 0; i < prompts.length; i++) {
    const eid = `${id}.${i + 1}`;
    const old = prior.find((l) => l.id === eid);
    let entry: Log;
    if (old && !old.error) continue;
    const t0 = Date.now();
    if (old) {
      // cut off earlier: the turn may have finished (or still be running) on the server
      const s = await settle(c, threadId);
      const userIdx = s.msgs.map((m: any) => m.role === "user" && m.text === prompts[i]).lastIndexOf(true);
      const ans = s.msgs.slice(userIdx + 1).find((m: any) => m.role === "assistant");
      if (!ans) {
        console.log(`[${eid}] previous attempt left no answer (${s.failed ?? "none"}); asking again`);
      } else {
        entry = { ...old, ms: ans.ms, text: ans.text, citations: ans.citations?.length ?? 0, tools: (ans.toolRuns ?? []).map((t: any) => `${t.name}${t.ok ? "" : "✗"}`), proposals: ans.proposals?.length ?? 0, error: undefined, wall: old.wall + (Date.now() - t0), recovered: true } as Log;
        if (opts.confirm && ans.proposals?.length) entry.confirmed = await confirmLast(c, ans.proposals);
        report(entry);
        save(entry);
        continue;
      }
    } else {
      await settle(c, threadId);
    }
    const a = await c.ask(threadId, prompts[i]!, { ...(i === 0 && mentions ? { mentions } : {}), ...(opts.effort ? { effort: opts.effort } : {}), timeoutMs: 40 * 60_000 });
    entry = { id: eid, space: spaceName ?? "(personal)", as, prompt: prompts[i]!, ms: a.ms, wall: Date.now() - t0, text: a.text, citations: a.citations?.length ?? 0, tools: (a.toolRuns ?? []).map((t) => `${t.name}${t.ok ? "" : "✗"}`), proposals: a.proposals?.length ?? 0, error: a.error, threadId };
    if (opts.confirm && a.proposals?.length) {
      entry.confirmed = await confirmLast(c, a.proposals);
      const after = await settle(c, threadId); // «نفّذ» starts a follow-up turn
      if (after.last && after.last.text !== a.text) entry.text += `\n\n[بعد «نفّذ»] ${after.last.text}`;
    }
    report(entry);
    save(entry);
    if (entry.error) return console.log(`chat ${id}: stopped on ${entry.error}`);
  }
  save({ id, space: spaceName ?? "", as, prompt: "(done)", ms: null, wall: 0, text: "", citations: 0, tools: [], proposals: 0, threadId });
  return threadId;
}

async function confirmLast(c: Client, proposals: any[]) {
  try {
    const p = proposals[proposals.length - 1];
    const r = JSON.stringify(await c.confirm(p.id ?? p._id ?? p.proposalId)).slice(0, 300);
    return r;
  } catch (e) {
    return `ERROR ${(e as Error).message}`;
  }
}

function report(e: Log) {
  console.log(`\n=== [${e.id}] ${e.as} @ ${e.space} (${Math.round(e.wall / 1000)}s, cites ${e.citations}, tools ${e.tools.join(",")}, proposals ${e.proposals}${e.confirmed ? ", confirmed " + e.confirmed : ""})\n> ${e.prompt}\n${e.error ?? e.text.slice(0, 1500)}`);
}

export async function chats(only?: string) {
  const all: [string, () => Promise<unknown>][] = [
    // Any employee asks the regulations and gets the article.
    ["P1", () => run("P1", "employee", POL, [
      "توفيت جدتي لأبي أمس، كم يوم إجازة أستحق؟ وهل أحتاج أقدّم شيئاً؟",
      "وإذا احتجت يومين زيادة بعدها، هل أقدر آخذها من رصيدي الاعتيادي مع أن الطلب لازم قبل 14 يوم؟",
    ])],
    ["P2", () => run("P2", "care", POL, [
      "أبغى أطبّق العمل عن بعد لفريقي في مركز الاتصال، ما الشروط والحدود؟ وهل يشمل موظفي خدمة المستفيدين؟",
    ])],
    ["P3", () => run("P3", "employee", POL, [
      "مورد أهداني ساعة قيمتها تقريباً 800 ريال بعد انتهاء مشروع، هل أقبلها؟ وإذا قبلتها بالغلط وش أسوي؟",
    ])],
    ["P4", () => run("P4", "procure", POL, [
      "طلب شراء بقيمة 450 ألف ريال: ما طريقة الشراء؟ ومن يعتمده؟ ومن يوقّع العقد بعد الترسية؟",
    ])],
    ["P4b", () => run("P4b", "procure", POL, [
      "حسب مصفوفة الصلاحيات: طلب شراء بقيمة 450 ألف ريال، من يعتمده؟ ومن يوقّع العقد بعد الترسية؟ اذكر رقم الصف.",
    ], { mentionFiles: [[POL, "مصفوفة_الصلاحيات.xlsx"]] })],
    ["P5", () => run("P5", "employee", POL, [
      "عدّل المادة الخاصة بإجازة الزواج في لائحة الموارد البشرية لتصبح 10 أيام بدل 5.",
    ])],
    // Legal review of the contract draft. A chat inside a shared space can only point at that space's
    // files, so the cross-space review runs from the counsel's own space with both spaces mentioned.
    ["L2", () => run("L2", "legal", LEG, [
      "من سجل العقود: كم عقداً حالته «ساري» وينتهي قبل 2027/03/31؟ اعرضها في جدول، وارسم مخطط أعمدة لقيمة العقود حسب الإدارة المستفيدة.",
      "حوّل العقود التي تنتهي قبل 2027/03/31 إلى قائمة متابعة فيها: رقم العقد، الطرف الثاني، تاريخ الانتهاء، المسؤول، والحالة (لم تبدأ/قيد التنفيذ/منجزة).",
    ], { confirm: true })],
    // follow-ups in the same chats
    ["L2c", () => run("L2c", "legal", LEG, [
      "لا، أريد القائمة للعقود الأربعة «السارية» فقط التي استخرجناها أولاً، والحالة «لم تبدأ» لكل منها. أنشئها الآن.",
    ], { confirm: true, inThreadOf: "L2" })],
    ["O1b", () => run("O1b", "office", OFF, [
      "من هذه المحاضر الثلاثة: ما القرارات التي لم تُنجز بعد؟ جدول: رقم القرار | القرار | المسؤول | الموعد النهائي | الحالة في آخر محضر | متأخر حتى 2026/11/22؟",
      "حوّل القرارات غير المنجزة إلى قائمة متابعة بالأعمدة: رقم القرار، القرار، المسؤول (نص)، الموعد النهائي، الحالة (لم تبدأ/قيد التنفيذ/منجزة).",
    ], { confirm: true, mentionFiles: [[OFF, "محضر_اجتماع_اللجنة_التنفيذية_رقم_7.docx"], [OFF, "محضر_اجتماع_اللجنة_التنفيذية_رقم_8.docx"], [OFF, "محضر_اجتماع_اللجنة_التنفيذية_رقم_9.pdf"]] })],
    ["O2b", () => run("O2b", "office", OFF, [
      "اكتب خطاباً رسمياً من الرئيس التنفيذي إلى السادة شركة المدار المتقدم لتقنية المعلومات بشأن ملاحظات الهيئة على مسودة عقد الدعم الفني (قرار اللجنة 9/2)، يطلب: خفض الدفعة المقدمة إلى 10% مقابل ضمان بنكي، ورفع الضمان النهائي إلى 5%، وحذف التجديد التلقائي، واعتماد المحاكم الإدارية بدل التحكيم، وأيلولة الملكية الفكرية للهيئة، وإضافة بند حماية البيانات الشخصية؛ ويمنحهم 10 أيام عمل للرد. اتبع دليل المراسلات ونموذج الخطاب الرسمي حرفياً واجعله مستنداً قابلاً للتصدير إلى وورد.",
      "من يجب أن يوقّع خطاباً إلى شركة مورّدة وفق مصفوفة الصلاحيات ودليل المراسلات؟ عدّل الخطاب إن لزم.",
    ], { confirm: true })],
    ["O1c", () => run("O1c", "office", OFF, [
      "ما قرارات اجتماع اللجنة التنفيذية رقم 9، ومن المسؤول عن كل قرار وما موعده؟ وما القرارات السابقة التي لم تُنجز بحسب جدول المتابعة في المحضر نفسه؟",
      "أنشئ قائمة «متابعة قرارات اللجنة التنفيذية» بهذه القرارات غير المنجزة، بالأعمدة: رقم القرار، القرار، المسؤول (نص وليس شخصاً)، الموعد النهائي، الحالة (لم تبدأ/قيد التنفيذ/منجزة).",
    ], { confirm: true, mentionFiles: [[OFF, "محضر_اجتماع_اللجنة_التنفيذية_رقم_9.pdf"]] })],
    ["L2d", () => run("L2d", "legal", LEG, [
      "اجعل عمود «المسؤول» نصاً عادياً (بعض المستشارين ليسوا أعضاء في المساحة) وأنشئ القائمة.",
    ], { confirm: true, inThreadOf: "L2" })],
    ["O3c", () => run("O3c", "office", OFF, [
      "التحليل أعطى صفراً. قيمة عمود «النوع» هي «وارد» أو «صادر»، والحالات المطلوبة «متأخر» و«بانتظار الرد» و«قيد الدراسة». أعد التحليل بالجدول والمخطط.",
    ], { confirm: true, inThreadOf: "O3" })],
    ["L3", () => run("L3", "procure", LEG, [
      "ما أبرز ملاحظات الشؤون القانونية على مسودة عقد الدعم الفني؟ وأضف ملاحظة في سجل العقود أن المورد وافق على تعديل الدفعة المقدمة.",
    ])],
    // Executive office.
    ["O1", () => run("O1", "office", OFF, [
      "استخرج كل القرارات من محاضر اجتماعات اللجنة التنفيذية 7 و8 و9 مع المسؤول والموعد والحالة كما وردت في آخر محضر، وحدد المتأخر منها حتى اليوم 2026/11/22.",
      "حوّلها إلى قائمة متابعة للقرارات غير المنجزة: رقم القرار، القرار، المسؤول، الموعد النهائي، الحالة.",
    ], { confirm: true })],
    ["O2", () => run("O2", "office", null, [
      "اكتب خطاباً رسمياً من الرئيس التنفيذي إلى السادة شركة المدار المتقدم لتقنية المعلومات بشأن ملاحظات الهيئة على مسودة عقد الدعم الفني (قرار اللجنة 9/2)، يطلب تعديل الدفعة المقدمة والضمان النهائي والتجديد التلقائي والتحكيم والملكية الفكرية وإضافة بند حماية البيانات، ويمنحهم 10 أيام عمل للرد. اتبع دليل المراسلات حرفياً واجعله مستنداً قابلاً للتصدير.",
      "من يجب أن يوقّع هذا الخطاب وفق مصفوفة الصلاحيات؟ عدّل الخطاب إن لزم.",
    ], { mentionSpaces: [OFF, POL] })],
    ["O3", () => run("O3", "office", OFF, [
      "من سجل المراسلات: كم مراسلة واردة متأخرة أو بانتظار الرد؟ وزّعها حسب الإدارة المختصة في جدول ومخطط، واذكر أقدم ثلاث مراسلات متأخرة.",
    ])],
    ["O4", () => run("O4", "legal", OFF, [
      "أضف قراراً جديداً إلى محضر الاجتماع 9: تكليف الشؤون القانونية بمراجعة جميع عقود التشغيل.",
    ])],
    ["O5", () => run("O5", "care", null, [
      "ما القرارات المتعلقة بخدمة المستفيدين في محاضر اجتماعات اللجنة التنفيذية الأخيرة (7 و8 و9)؟ ومن المسؤول عنها؟",
    ])],
    ["O6", () => run("O6", "strategy", null, [
      "هل صدر لي خطاب تكليف؟ ما المهمة والموعد؟",
    ])],
    ["L1", () => run("L1", "legal", null, [
      "راجع «مسودة عقد خدمات الدعم الفني والتشغيل» مقابل لائحة المشتريات والعقود الداخلية وسياسة حماية البيانات الشخصية. أريد جدول المخالفات والمخاطر مصنفة، ثم قائمة البنود الإلزامية الناقصة.",
      "اكتب الآن مسودة مذكرة رأي قانوني بنفس أسلوب مذكرة عقد صيانة المباني، رقمها ش ق/2026/051، واجعلها مستنداً قابلاً للتصدير إلى وورد.",
    ], { mentionSpaces: [LEG, POL] })],
    // Narrower version of L1: the contract and one regulation at a time, files mentioned.
    ["L1b", () => run("L1b", "legal", null, [
      "قارن مسودة العقد بلائحة المشتريات والعقود الداخلية: ما البنود المخالفة للائحة؟ جدول: م | مادة العقد | ما ورد في المسودة | ما تشترطه اللائحة (رقم المادة) | التصنيف (مخالفة نظامية/خطر تعاقدي/ملاحظة صياغة).",
      "والآن مقابل سياسة حماية البيانات الشخصية الداخلية: ما الذي يخالفها أو ينقص العقد؟ ثم أعطني قائمة البنود الإلزامية الـ15 في المادة 16 من لائحة المشتريات مع ما هو موجود وما هو ناقص في المسودة.",
      "اكتب مسودة مذكرة رأي قانوني بنفس أسلوب «مذكرة رأي قانوني — عقد صيانة المباني»، رقمها ش ق/2026/051، واجعلها مستنداً قابلاً للتصدير إلى وورد.",
    ], { confirm: true, mentionFiles: [[LEG, "مسودة_عقد_خدمات_الدعم_الفني_والتشغيل.docx"], [POL, "لائحة_المشتريات_والعقود_الداخلية.docx"], [POL, "سياسة_حماية_البيانات_الشخصية_الداخلية.pdf"], [LEG, "مذكرة_رأي_قانوني_عقد_صيانة_المباني.pdf"]] })],
    // The review the way that works best: inside «الشؤون القانونية» (the space reaches the everyone-space regulations).
    ["L1c", () => run("L1c", "legal", LEG, [
      "راجع «مسودة عقد خدمات الدعم الفني والتشغيل» مقابل لائحة المشتريات والعقود الداخلية وسياسة حماية البيانات الشخصية. أريد جدول المخالفات والمخاطر مصنفة، ثم قائمة البنود الإلزامية الناقصة.",
      "اكتب مسودة مذكرة رأي قانوني بنفس أسلوب «مذكرة رأي قانوني — عقد صيانة المباني»، رقمها ش ق/2026/051، واجعلها مستنداً قابلاً للتصدير إلى وورد.",
    ], { confirm: true })],
    ["L1d", () => run("L1d", "legal", LEG, [
      "ما أبرز ملاحظات الشؤون القانونية على مسودة عقد الدعم الفني مقابل لائحة المشتريات والعقود وسياسة حماية البيانات؟ جدول مصنّف ثم البنود الإلزامية الناقصة.",
      "اكتب من هذه الملاحظات مسودة مذكرة رأي قانوني رقمها ش ق/2026/051 بنفس أسلوب مذكرة عقد صيانة المباني (الوقائع، الملاحظات في جدول، الرأي)، واحفظها مستنداً أصدّره إلى وورد.",
    ], { confirm: true })],
  ];
  for (const [id, fn] of all) if (!only || only.split(",").includes(id)) await fn();
}

// Skills are made by users from their own chats: the counsel turns the contract review (L1) into
// /مراجعة-عقد and shares it with «الشؤون القانونية»; the office manager turns the letter (O2) into a skill
// and shares it with «مكتب الرئيس التنفيذي».
async function skillFrom(as: string, chatId: string, spaceName: string, fallbackName: string) {
  const c = await login(as);
  const mine: any[] = await c.q("skills:list");
  const entry = readLog().find((l) => l.id === `${chatId}.1`);
  if (!entry) return console.log(`skill: chat ${chatId} not run yet`);
  if (mine.some((s) => s.fromThreadId === entry.threadId || s.name === fallbackName)) return console.log(`skill from ${chatId}: already made`);
  const d: any = await c.a("skills:draftFromThread", { threadId: entry.threadId });
  console.log(`draft from ${chatId}:`, JSON.stringify(d).slice(0, 600));
  const name = /^[\p{L}\p{N}_-]{2,40}$/u.test(d.name ?? "") ? d.name : fallbackName;
  const id = await c.m("skills:create", { name, title: d.title, description: d.description, instructions: d.instructions, fromThreadId: entry.threadId });
  const r: any = await c.m("skills:shareToSpace", { skillId: typeof id === "string" ? id : id.id, spaceId: await c.space(spaceName) });
  console.log(`skill /${name} → ${spaceName}: ${r.state}`);
}

export async function skills() {
  await skillFrom("legal", "L1b", LEG, "مراجعة-عقد");
  await skillFrom("office", "O2", OFF, "خطاب-رسمي");
}

if (import.meta.main) {
  const cmd = process.argv[2] ?? "setup";
  if (cmd === "setup") {
    await setupPolicies();
    await setupAcknowledgment();
    await setupLegal();
    await setupOffice();
    const legal = await login("legal");
    for (const n of [POL, LEG]) await legal.waitIngest(await legal.space(n));
    const office = await login("office");
    const files = await office.waitIngest(await office.space(OFF));
    console.log("ingest:", files.map((x: any) => `${x.name}:${x.ingest}`).join(" | "));
  } else if (cmd === "skills") {
    await skills();
  } else if (cmd === "publish") {
    await setupAcknowledgment();
  } else if (cmd === "chats") {
    await chats(process.argv[3]);
  }
}
