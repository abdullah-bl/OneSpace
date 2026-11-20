// The code fallback of the routing decision (plans/12): a request to make something new that
// doesn't point at the files («سوّ لي اختباراً…») needs no search. Kept apart from chat.ts so the
// bench (bench/decisions) measures exactly what the app falls back to.

const MAKE_RE = /^\s*(?:(?:لو سمحت|ممكن|أبي|ابي|ابغى|أبغى|اريد|أريد|ودي|تقدر)\s+)?(?:ت?سو(?:ي|ّ|ّي)?|ت?نشئ|أنشئ|انشئ|ت?كتب|اكتب|ت?صمم|صمّم|جهز|جهّز|تجهز|حضر|حضّر|اعمل|ابن|ارسم|ترجم|صغ|ألّف|الف|اصنع|سوو)(?=\s|$)/;
const FILE_RE = /ملف|ملفات|مستند|المرفق|لائحة|اللائحة|سياسة|السياسة|نظام|النظام|@/;
/** «سوّ لي…/اكتب…/أنشئ…» without pointing at files, policies or an @mention. */
export function makingRequest(q: string) {
  return MAKE_RE.test(q) && !FILE_RE.test(q);
}

// A short follow-up that reworks the previous answer («حولها جدول»، «اختصره»، «ترجمها»،
// «اكتبها كنقاط»): its material is already in the conversation, so a pre-search only drags in
// unrelated files (a "table" request matched a restaurant menu). A rework verb whose object is a
// pronoun pointing back (ـها/ـه/ـهم), or a rework verb + «هذا/هذه/الجواب/الرد/الكلام/النص».
const REWORK_VERB =
  "(?:حو(?:ّ)?ل|اختصر|لخ(?:ّ)?ص|رت(?:ّ)?ب|نس(?:ّ)?ق|ترجم|صغ|صيغ|أعد\\s+صياغت|اعد\\s+صياغت|عد(?:ّ)?ل|قص(?:ّ)?ر|طو(?:ّ)?ل|وس(?:ّ)?ع|بس(?:ّ)?ط|اجعل|خل(?:ّ)?|حط|ضع|اكتب|اعرض|أعرض|قس(?:ّ)?م|جدول|سو(?:ّ)?)";
const REWORK_RE = new RegExp(
  `^\\s*(?:(?:لو سمحت|ممكن|أبي|ابي|ابغى|أبغى|اريد|أريد|ودي|تقدر|طيب|زين|الحين)\\s+)*(?:ت?${REWORK_VERB}(?:ها|ه|هم|هن)(?=\\s|$|[؟?.!،,])|ت?${REWORK_VERB}\\s+(?:لي\\s+)?(?:هذا|هذي|هذه|هاذا|الجواب|الإجابة|الاجابة|الرد|الكلام|النص|الحكمة|القائمة|اللي\\s+فوق|السابق))`,
);
/** A follow-up reworking the previous answer, not pointing at files: no pre-search. Needs history. */
export function reworkRequest(q: string) {
  return q.length <= 120 && REWORK_RE.test(q) && !FILE_RE.test(q);
}
