// What a model server is and what each of its models can do, read from its model list, and its
// errors explained in Arabic with the fix for that kind of server. Pure: providers.ts calls these
// on «افحص» and when a role is tried before saving.
//
// Servers differ: OpenRouter (hosted), Ollama, LM Studio, llama.cpp (llama-server, also behind
// Unsloth Studio; one model per server, or a router that starts each model on demand), vLLM, or any
// OpenAI-compatible API. Hints are partial (a llama.cpp embedding model reports text output), so a
// model's kinds only order and filter the pickers; trying the model before saving is what decides.

export type Flavor = "openrouter" | "ollama" | "lmstudio" | "llamacpp" | "vllm" | "openai";
/** chat: writes text. vision: also reads images. decide: a decision model (llama.cpp /v1/systemone), no text. */
export type ModelKind = "chat" | "vision" | "decide" | "embed" | "rerank" | "audio" | "media";
export type ModelInfo = { id: string; kinds: ModelKind[] };
export type ServerRole = "main" | "fast" | "vision" | "decide" | "embed";

export const FLAVOR_LABEL: Record<Flavor, string> = {
  openrouter: "OpenRouter",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  llamacpp: "llama.cpp",
  vllm: "vLLM",
  openai: "متوافق مع OpenAI",
};

/** The kind of server, from its address and its GET /models answer. */
export function detectFlavor(baseUrl: string, data: any): Flavor {
  let host = "";
  let port = "";
  try {
    const u = new URL(baseUrl);
    host = u.hostname;
    port = u.port;
  } catch {
    // keep the defaults
  }
  if (/openrouter\.ai$/.test(host)) return "openrouter";
  const list: any[] = Array.isArray(data?.data) ? data.data : [];
  if (list.some((m) => m?.owned_by === "llamacpp" || m?.status?.args || m?.meta?.n_ctx_train) || Array.isArray(data?.models)) return "llamacpp";
  if (list.some((m) => m?.owned_by === "vllm" || m?.max_model_len)) return "vllm";
  if (port === "11434" || list.some((m) => m?.owned_by === "library")) return "ollama";
  if (port === "1234") return "lmstudio";
  return "openai";
}

/** A model's kinds by its usual name (embedding, reranking, speech, image/video generation). */
export function kindByName(id: string): ModelKind | null {
  const m = id.toLowerCase();
  if (/embed|bge-|\be5-|gte-|nomic-embed|minilm/.test(m)) return "embed";
  if (/rerank/.test(m)) return "rerank";
  if (/tts|whisper|speech|phonon|audar/.test(m)) return "audio";
  if (/ltx|diffusion|sdxl|flux|wan2|hunyuan-video/.test(m)) return "media";
  return null;
}

/** Each model of a GET /models answer with what it can do (as far as the server says). */
export function readModels(data: any): ModelInfo[] {
  const raw: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
  const caps = new Map<string, string[]>();
  for (const m of Array.isArray(data?.models) ? data.models : []) if (m?.name && Array.isArray(m.capabilities)) caps.set(String(m.name), m.capabilities.map(String));
  const out = new Map<string, ModelInfo>();
  for (const m of raw) {
    const id = String(m?.id ?? m?.name ?? m ?? "").trim();
    if (!id || out.has(id)) continue;
    const kinds = new Set<ModelKind>();
    const named = kindByName(id);
    const input: string[] = m?.architecture?.input_modalities ?? [];
    const output: string[] = m?.architecture?.output_modalities ?? [];
    const c = caps.get(id) ?? (Array.isArray(m?.capabilities) ? m.capabilities.map(String) : []);
    if (named) kinds.add(named);
    else if (output.includes("decisions") && !output.includes("text")) kinds.add("decide");
    else if (output.includes("embeddings") || c.includes("embedding") || m?.type === "embeddings") kinds.add("embed");
    else {
      kinds.add("chat");
      if (input.includes("image") || c.includes("vision") || m?.type === "vlm") kinds.add("vision");
    }
    out.set(id, { id, kinds: [...kinds] });
  }
  return [...out.values()].slice(0, 300);
}

/** Can a model of these kinds be tried for this role? (Unknown models are kinds of a chat model.) */
export function fitsRole(kinds: ModelKind[], role: ServerRole): boolean {
  if (role === "embed") return kinds.includes("embed");
  if (role === "decide") return kinds.includes("decide") || kinds.includes("chat");
  return kinds.includes("chat");
}

const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A server's error message, from its JSON body when it has one. */
function messageOf(body: string): string {
  try {
    const j = JSON.parse(body);
    const e = j?.error ?? j;
    return String(e?.message ?? e?.detail ?? e?.error ?? body);
  } catch {
    return body;
  }
}

/**
 * A failed try of `model` for `role`, explained: what went wrong and what to do on this kind of
 * server. `status` 0 is no answer (`timeout` when it timed out).
 */
export function explainModelError(a: { role: ServerRole; flavor: Flavor; model: string; status: number; body?: string; timeout?: boolean }): string {
  const msg = messageOf(a.body ?? "");
  const lower = msg.toLowerCase();
  const llama = a.flavor === "llamacpp";
  if (a.status === 0)
    return a.timeout
      ? "لم يرد الخادم في الوقت المحدد. قد يكون النموذج قيد التحميل (أول طلب على نموذج كبير يأخذ وقتاً): أعد المحاولة بعد قليل."
      : "تعذّر الوصول إلى الخادم. تأكد أنه يعمل وأن العنوان صحيح (وأنه ينتهي بـ ‎/v1‎).";
  if (a.status === 401 || a.status === 403) return "المفتاح مرفوض. تحقق من مفتاح API في إعدادات المزوّد.";
  if (a.status === 402 || /credit|insufficient|balance|quota/.test(lower)) return `${a.flavor === "openrouter" ? "رصيد OpenRouter" : "رصيد الحساب"} لا يكفي لهذا النموذج. اشحن الرصيد أو اختر نموذجاً آخر.`;
  if (a.status === 429) return "الخادم يرفض الطلبات الآن لكثرتها (حد الاستخدام). أعد المحاولة بعد قليل، أو اختر مزوّداً آخر.";

  if (a.role === "embed" && (a.status === 501 || /embedding/.test(lower)))
    return llama
      ? "هذا الخادم لا يدعم التضمين: llama.cpp يحتاج تشغيل النموذج بخيار ‎--embeddings‎ (في وضع الموجّه: أضفه لإعدادات هذا النموذج). أو اختر مزوّداً يشغّل نموذج التضمين بهذا الخيار."
      : "هذا الخادم لا يعطي تضميناً لهذا النموذج. اختر نموذج تضمين (مثل embeddinggemma) أو مزوّداً آخر.";
  if (/systemone|decision model|without text generation/.test(lower))
    return "هذا نموذج قرار: يجيب عن أسئلة محددة ولا يكتب نصاً. يصلح لدور «نموذج القرار» فقط.";
  if (a.role === "vision" && (a.status === 400 || a.status === 500) && /image|vision|multimodal|mmproj|modal/.test(lower))
    return llama
      ? "هذا النموذج لا يقرأ الصور: llama.cpp يحتاج ملف الرؤية (‎--mmproj‎) مع النموذج. أو اختر نموذجاً يقرأ الصور."
      : "هذا النموذج لا يقرأ الصور. اختر نموذج رؤية.";
  if (a.status === 404 || /not found|no such model|unknown model|does not exist|not loaded/.test(lower)) {
    const fix =
      a.flavor === "ollama"
        ? `نزّله أولاً (ollama pull ${a.model})`
        : a.flavor === "lmstudio"
          ? "حمّله أولاً في LM Studio"
          : a.flavor === "openrouter"
            ? "تحقق من اسمه في قائمة OpenRouter"
            : "اضغط «افحص» على المزوّد لتحديث قائمة نماذجه";
    return `الخادم لا يعرف النموذج «${a.model}» أو لم يحمّله: ${fix}.`;
  }
  if (a.status === 501) return `هذا الخادم لا يدعم هذا النوع من الطلبات لهذا النموذج. التفاصيل: ${short(msg)}`;
  if (/context|too long|n_ctx/.test(lower)) return "سياق النموذج أقصر من المطلوب. شغّله بسياق أطول (llama.cpp: ‎-c‎).";
  return `ردّ الخادم بخطأ (HTTP ${a.status}). التفاصيل: ${short(msg)}`;
}

/** A 1×1 PNG, to check that a model reads images. */
export const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
