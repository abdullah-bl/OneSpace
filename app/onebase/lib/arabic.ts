// Arabic text normalization (plans/03-rag.md §4). OneBase full-text search (SQLite FTS5)
// tokenizes but does not stem, and its handling of Arabic diacritics is undocumented, so we
// normalize ourselves: one function for text that is shown (light), one for the keyword index
// and the question (aggressive, plus light prefix stripping).

const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭ]/g;
const TATWEEL = /ـ/g;
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

function latinDigits(s: string) {
  return s.replace(/[٠-٩۰-۹]/g, (d) => String(AR_DIGITS.indexOf(d) >= 0 ? AR_DIGITS.indexOf(d) : FA_DIGITS.indexOf(d)));
}

/** For text we display and embed: no diacritics/tatweel, Latin digits, tidy whitespace. Letters stay as written. */
export function normalizeDisplay(s: string): string {
  return latinDigits(s.normalize("NFC"))
    .replace(TASHKEEL, "")
    .replace(TATWEEL, "")
    .replace(/ |‏|‎|‪|‫|‬|‭|‮|﻿/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Letter folding used for matching: alef forms → ا, ى → ي, ة → ه, ؤ/ئ → و/ي, lower-case Latin. */
export function foldLetters(s: string): string {
  return normalizeDisplay(s)
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .toLowerCase();
}

// Proclitics (و ف ب ل ك + ال/لل) stripped when what remains is still a word (≥ 3 letters).
const PREFIXES = ["وبال", "وال", "فال", "بال", "كال", "لل", "ال", "و", "ف", "ب", "ل", "ك"];

/** Light prefix stripping for one folded token. */
export function stripPrefix(token: string): string {
  if (!/^[ء-ي]+$/.test(token)) return token;
  for (const p of PREFIXES) {
    if (token.startsWith(p) && token.length - p.length >= 3) {
      // "و"/"ف"/"ب"/"ل"/"ك" alone are only stripped when an article follows or the rest is long enough.
      if (p.length === 1 && token.length - 1 < 4) continue;
      return token.slice(p.length);
    }
  }
  return token;
}

export function tokens(s: string): string[] {
  return foldLetters(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(stripPrefix);
}

/** The shadow copy of a chunk indexed for keyword search. */
export function shadowText(s: string): string {
  return tokens(s).join(" ");
}

// Question words and fillers that would match nearly every chunk in a keyword search.
const STOP = new Set(
  [
    "ما", "ماذا", "هل", "كم", "كيف", "متي", "اين", "من", "لماذا", "اي", "التي", "الذي", "الذين", "في", "علي", "عن", "الي", "او", "ثم",
    "مع", "هو", "هي", "هذا", "هذه", "ذلك", "تلك", "كان", "يكون", "لا", "لم", "لن", "قد", "اذا", "ان", "انا", "انت", "نحن", "عند", "كل",
    "بعد", "قبل", "حتي", "اللي", "وش", "ايش", "شو", "ابي", "ابغي", "ودي", "لو", "يا", "the", "a", "an", "of", "to", "in", "is", "what", "how",
  ].map((w) => foldLetters(w)),
);

/** Keyword query for the shadow index: folded, prefix-stripped tokens without question words. */
export function keywordQuery(q: string): string {
  const out = tokens(q).filter((t) => !STOP.has(t) && t.length > 1);
  return [...new Set(out)].join(" ");
}
