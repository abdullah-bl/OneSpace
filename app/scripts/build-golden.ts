// Builds eval/golden.json from the Phase 0 bench corpus (bench/data/corpus.json + qa.json):
// 12 synthetic-but-realistic Arabic policy documents (10 sections each), one question per section
// written in employees' own words (dialect, paraphrase), plus questions with no answer in the
// documents (abstention). Real employees' questions are added to the same file over time
// (plans/03 §6: 👎 answers are reviewed and appended).
//
//   bun scripts/build-golden.ts [/path/to/bench/data]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const dataDir = process.argv[2] ?? resolve(import.meta.dir, "../../bench/data");
const corpus: { id: string; doc: number; title: string; heading: string; text: string }[] = JSON.parse(readFileSync(join(dataDir, "corpus.json"), "utf8"));
const qa: { chunk_id: string; question: string; key: string; key_in_text: boolean }[] = JSON.parse(readFileSync(join(dataDir, "qa.json"), "utf8"));

const docs = new Map<number, { title: string; sections: { id: string; heading: string; text: string }[] }>();
for (const c of corpus) {
  if (!docs.has(c.doc)) docs.set(c.doc, { title: c.title, sections: [] });
  docs.get(c.doc)!.sections.push({ id: c.id, heading: c.heading, text: c.text });
}
const byId = new Map(corpus.map((c) => [c.id, c]));

// Checked against the corpus text: none of these topics is covered.
const unanswerable = [
  "ما مواعيد عمل المقصف في المبنى الرئيسي؟",
  "هل يوجد نادٍ رياضي للموظفين وكم اشتراكه؟",
  "ما سياسة التدخين داخل مباني الجهة؟",
  "هل توفر الجهة حضانة لأطفال الموظفات؟",
  "كم ساعات الدوام في شهر رمضان؟",
  "أين أجد مواقف السيارات المخصصة للزوار؟",
  "هل يسمح بإحضار الحيوانات الأليفة إلى المكتب؟",
  "ما إجراءات حجز المصلى للمناسبات؟",
  "كم قيمة بدل الوجبات اليومي للموظف؟",
  "ما سياسة الهدايا التي يقدمها الموردون للموظفين؟",
  "متى يقام الحفل السنوي لتكريم الموظفين؟",
  "ما شروط إعارة الموظف إلى جهة حكومية أخرى؟",
  "هل توجد صيدلية داخل مقر العمل؟",
  "ما لون الزي الموحد لموظفي الاستقبال يوم الخميس؟",
  "كم عدد أيام إجازة الحج المدفوعة بعد عشر سنوات خدمة؟",
];

const golden = {
  source: "bench/data (Phase 0 corpus), built by scripts/build-golden.ts",
  docs: [...docs.entries()].map(([doc, d]) => ({ doc, title: d.title, file: `${d.title}.docx`, sections: d.sections })),
  questions: [
    ...qa.map((q) => {
      const c = byId.get(q.chunk_id)!;
      return { id: q.chunk_id, question: q.question, answerable: true, doc: c.doc, file: `${c.title}.docx`, heading: c.heading, key: q.key };
    }),
    ...unanswerable.map((question, i) => ({ id: `none${i}`, question, answerable: false })),
  ],
};
mkdirSync(resolve(import.meta.dir, "../eval"), { recursive: true });
writeFileSync(resolve(import.meta.dir, "../eval/golden.json"), JSON.stringify(golden, null, 1));
console.log(`eval/golden.json: ${golden.docs.length} documents, ${qa.length} answerable + ${unanswerable.length} unanswerable questions`);
