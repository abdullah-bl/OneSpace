// How much text one request to a model may carry (embedding and decision models). Any server works:
// a local llama.cpp, vLLM, Ollama or a hosted API. Each takes inputs only up to some length, and that
// length depends on how the server runs the model (llama.cpp: the physical batch, 512 tokens by
// default for an embedding or decision model), not on the model alone. So the app finds it out and
// fits what it sends, instead of relying on the server being started with the right flags:
//
// - On «جرّب واحفظ» the role is probed with growing inputs; the largest accepted is saved with it.
// - At run time a "too long" refusal halves the input and retries, and the smaller size is
//   remembered for that server and model until the process restarts.
//
// Sizes are in characters of the text we send (what the chunker and callers measure), not tokens.

/** The probe's steps; a model that takes the last one is treated as unlimited for our inputs. */
export const PROBE_SIZES = [1000, 2000, 4000, 8000, 16000];
/** Never cut below this: a shorter input says too little to embed or judge. */
export const MIN_INPUT_CHARS = 200;

/** A refusal because the input is too long (llama.cpp, vLLM, OpenAI-style, TEI and Ollama wordings). */
export function isTooLong(status: number, body: string): boolean {
  if (status < 400) return false;
  return /too large|too long|exceeds?|maximum context|context length|context_length|max_tokens|n_ctx|batch size|input length|token limit|reduce the length|must have less than \d+ tokens/i.test(body);
}

const learned = new Map<string, number>();
const keyOf = (baseUrl: string | undefined, model: string) => `${baseUrl ?? ""}|${model}`;

/** The input size to keep under for this server and model: the saved one or what a refusal taught. */
export function limitFor(baseUrl: string | undefined, model: string, saved?: number): number {
  const l = learned.get(keyOf(baseUrl, model));
  const s = saved && saved > 0 ? saved : Infinity;
  return Math.min(l ?? Infinity, s);
}

/** After a refusal at `size` characters: remember a limit below it, and return it. */
export function learnLimit(baseUrl: string | undefined, model: string, size: number): number {
  const next = Math.max(MIN_INPUT_CHARS, Math.floor(size / 2));
  const k = keyOf(baseUrl, model);
  learned.set(k, Math.min(learned.get(k) ?? Infinity, next));
  return learned.get(k)!;
}

export function forgetLimits() {
  learned.clear();
}

/** `text` cut to `max` characters, at a word boundary when one is near. */
export function cutText(text: string, max: number): string {
  if (!Number.isFinite(max) || text.length <= max) return text;
  const head = text.slice(0, max);
  const space = head.lastIndexOf(" ");
  return space > max * 0.8 ? head.slice(0, space) : head;
}

/**
 * A JSON value (a decision's state, chat messages) with its longest strings cut until the whole is
 * at most `max` characters as JSON. Short fields (questions, names) are left as they are.
 */
export function fitJson<T>(value: T, max: number): T {
  if (!Number.isFinite(max)) return value;
  let size = JSON.stringify(value).length;
  if (size <= max) return value;
  const copy = JSON.parse(JSON.stringify(value));
  const strings: { holder: any; key: string | number; len: number }[] = [];
  const walk = (o: any) => {
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === "string") strings.push({ holder: o, key: k, len: v.length });
      else walk(v);
    }
  };
  walk(copy);
  strings.sort((a, b) => b.len - a.len);
  for (const s of strings) {
    if (size <= max) break;
    const cur: string = s.holder[s.key];
    const keep = Math.max(MIN_INPUT_CHARS, cur.length - (size - max) - 16);
    if (keep >= cur.length) continue;
    const cut = cutText(cur, keep);
    size -= JSON.stringify(cur).length - JSON.stringify(cut).length;
    s.holder[s.key] = cut;
  }
  return copy;
}

/** Arabic text of `n` characters for probing (real words, so tokens per character are realistic). */
export function probeText(n: number): string {
  const s = "تنص السياسة على تصنيف البيانات وحماية الأجهزة والإبلاغ عن الحوادث خلال ساعتين من اكتشافها. ";
  return s.repeat(Math.ceil(n / s.length)).slice(0, n);
}

/**
 * The largest probe size `send` accepts, or 0 if not even the first. Stops at the first refusal for
 * length; any other failure ends the probe with what was accepted so far.
 */
export async function probeLimit(send: (text: string) => Promise<{ ok: boolean; tooLong: boolean }>): Promise<number> {
  let best = 0;
  for (const n of PROBE_SIZES) {
    const r = await send(probeText(n));
    if (r.ok) best = n;
    else break;
  }
  return best;
}
