// The code fallback of the routing decision (plans/12): a request to make something new that
// doesn't point at the files («سوّ لي اختباراً…») needs no search. Kept apart from chat.ts so the
// bench (bench/decisions) measures exactly what the app falls back to.

const MAKE_RE = /^\s*(?:(?:لو سمحت|ممكن|أبي|ابي|ابغى|أبغى|اريد|أريد|ودي|تقدر)\s+)?(?:ت?سو(?:ي|ّ|ّي)?|ت?نشئ|أنشئ|انشئ|ت?كتب|اكتب|ت?صمم|صمّم|جهز|جهّز|تجهز|حضر|حضّر|اعمل|ابن|ارسم|ترجم|صغ|ألّف|الف|اصنع|سوو)(?=\s|$)/;
const FILE_RE = /ملف|ملفات|مستند|المرفق|لائحة|اللائحة|سياسة|السياسة|نظام|النظام|@/;
/** «سوّ لي…/اكتب…/أنشئ…» without pointing at files, policies or an @mention. */
export function makingRequest(q: string) {
  return MAKE_RE.test(q) && !FILE_RE.test(q);
}
