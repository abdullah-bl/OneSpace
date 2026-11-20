// Apps (plans/13): an output of kind "app" whose version is JSON { files, data }. Pure helpers, shared
// by the server (apps.ts, publicationsHttp.ts) and tests:
//   - checking an app's files and grants;
//   - bundling index.html (+ its local .js/.css) into ONE document with our bootstrap first, and the
//     CSP that lets exactly those scripts run (by hash) and talk only to the page's own API;
//   - grants in words, for the publish card.
// `server/…` files are private: nothing here ever puts them into a page.

export type WriteMode = "none" | "page" | "handler";
export type ReadMode = "none" | "own" | "aggregate";
/** A grant as stored: the list, the modes, and column KEYS (renaming a column keeps them). */
export type Grant = { listId: string; write: WriteMode; read: ReadMode; columns?: string[]; sender?: string };
export type AppContent = { files: Record<string, string>; data: Record<string, Grant> };

export const APP_LIMITS = { files: 40, totalChars: 500 * 1024, aliases: 5, handlerRows: 20 };
const PATH_RE = /^(?!.*\.\.)(?!\/)[A-Za-z0-9_\-./]{1,120}$/;
export const ALIAS_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
export const HANDLER_RE = /^server\/([A-Za-z][A-Za-z0-9_]{0,39})\.py$/;

export class AppError extends Error {}

export const isPrivate = (path: string) => path.startsWith("server/");

export function emptyApp(): AppContent {
  return { files: {}, data: {} };
}

export function parseApp(content: string): AppContent {
  try {
    const j = JSON.parse(content);
    return { files: j && typeof j.files === "object" ? j.files : {}, data: j && typeof j.data === "object" && j.data ? j.data : {} };
  } catch {
    return emptyApp();
  }
}

export function cleanPath(p: string): string {
  const s = String(p ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!PATH_RE.test(s) || s.endsWith("/")) throw new AppError(`مسار غير صالح: «${p}» (حروف إنجليزية وأرقام و _ . / - فقط، بلا ..)`);
  if (isPrivate(s) && s.split("/").length !== 2) throw new AppError(`ملفات الخادم في server/ مباشرة بلا مجلدات فرعية: «${p}»`);
  return s;
}

/** The files after a write: new and changed ones set, `null` deletes. Checked against the limits. */
export function applyFiles(current: Record<string, string>, changes: Record<string, string | null>): Record<string, string> {
  const out = { ...current };
  for (const [raw, content] of Object.entries(changes ?? {})) {
    const p = cleanPath(raw);
    if (content === null) delete out[p];
    else if (typeof content !== "string") throw new AppError(`محتوى «${p}» يجب أن يكون نصاً`);
    else out[p] = content.replace(/\u0000/g, "");
  }
  const names = Object.keys(out);
  if (names.length > APP_LIMITS.files) throw new AppError(`الحد ${APP_LIMITS.files} ملفاً للتطبيق`);
  const total = names.reduce((n, k) => n + k.length + out[k]!.length, 0);
  if (total > APP_LIMITS.totalChars) throw new AppError("ملفات التطبيق أكبر من 500 ك.ب");
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function serializeApp(app: AppContent): string {
  return JSON.stringify({ files: app.files, data: app.data });
}

export function handlersOf(files: Record<string, string>): string[] {
  return Object.keys(files).map((p) => p.match(HANDLER_RE)?.[1]).filter((x): x is string => !!x);
}

type Rec = Map<string, string>;
const PAIR_RE = /["']?([A-Za-z_\u0600-\u06FF][\w\u0600-\u06FF]*)["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\[[^\[\]]*\]|-?[\w.]+)/g;
const normVal = (v: string) => v.replace(/^["']|["']$/g, "").replace(/["'\s]/g, "").replace(/\b(True|False)\b/g, (m) => m.toLowerCase());

/** Flat record literals ({ key: value, … }, 2+ pairs) in a file: Python dicts, JS objects, JSON. */
function records(text: string): Rec[] {
  const out: Rec[] = [];
  for (const m of text.matchAll(/\{[^{}]{3,2000}\}/g)) {
    const rec: Rec = new Map();
    for (const p of m[0].matchAll(PAIR_RE)) rec.set(p[1]!.toLowerCase(), normVal(p[2]!));
    if (rec.size >= 2) out.push(rec);
  }
  return out;
}

/** Fields that name or show a record rather than decide anything about it. */
const SHOWN_KEYS = /^(id|key|name|title|label|text|type|slug|stem|question|q|prompt|options|choices|o|description|desc|image|icon|category|section|hint)$/i;
/** A short value (a number, flag or token), the shape of an answer, a price or a rule; long text and lists are what pages show. */
const decisive = (k: string, v: string) => !SHOWN_KEYS.test(k) && !v.startsWith("[") && v.length <= 40;

/**
 * Data of server/ files copied into public files: records whose fields (2+) all reappear, with the same
 * values, in a record of a public file, and that carry a short value field besides what a page shows
 * (ids, texts, options) — the shape of a copied answer, internal price or rule. The page is readable
 * in full, so that leaks it. Returns one line per pair of files.
 */
export function serverDataCopies(files: Record<string, string>): string[] {
  const pub = Object.entries(files).filter(([p]) => !isPrivate(p) && /\.(js|json|html|mjs)$/.test(p)).map(([p, c]) => [p, records(c)] as const);
  const out: string[] = [];
  for (const [sp, sc] of Object.entries(files)) {
    if (!isPrivate(sp)) continue;
    const srv = records(sc);
    if (!srv.length) continue;
    for (const [pp, recs] of pub) {
      const keys = new Set<string>();
      const suspect = new Set<string>();
      let n = 0;
      for (const r of srv) {
        const hit = recs.find((q) => [...r].every(([k, v]) => q.get(k) === v));
        if (hit) {
          n++;
          for (const [k, v] of r) {
            keys.add(k);
            if (decisive(k, v)) suspect.add(k);
          }
        }
      }
      if (n >= 1 && suspect.size)
        out.push(`«${pp}» فيه نسخة من بيانات «${sp}» (${n} سجلاً بالحقول: ${[...keys].join("، ")}؛ منها ${[...suspect].map((k) => `«${k}»`).join("، ")}). الصفحة يقرؤها الزائر كاملة: إن كان حقل منها يحدد النتيجة أو يجب أن يبقى سراً (الإجابة الصحيحة، السعر الداخلي، القاعدة) فاحذفه من الصفحة وأبقِ ما يُعرض فقط؛ الخادم وحده يعرفه.`);
    }
  }
  return out;
}

/** Problems a test or the tool reports (not errors: the model fixes them). */
export function appWarnings(app: AppContent): string[] {
  const out: string[] = [];
  if (!app.files["index.html"]) out.push("لا يوجد index.html (مدخل التطبيق).");
  for (const [p, c] of Object.entries(app.files)) {
    if (isPrivate(p)) continue;
    // Answers, keys, prices: anything the visitor must not see belongs in server/.
    if (/\.(js|json|html)$/.test(p) && /["']?(correct(_?answer)?|answer_?key|solution|is_?correct|الإجابة_?الصحيحة)["']?\s*[:=]/i.test(c))
      out.push(`«${p}» يبدو أنه يحوي إجابات أو مفتاحاً يراه الزائر. انقل ما يجب أن يبقى سراً إلى server/ (ملف بيانات يقرؤه المعالج).`);
    if (/\son[a-z]+\s*=\s*["']/i.test(c) && /\.html$/.test(p)) out.push(`«${p}» فيه معالجات أحداث داخل الوسوم (onclick=…) وهي لا تعمل في الصفحة المنشورة: استخدم addEventListener في السكربت.`);
    if (/\bfetch\s*\(/.test(c) && /\.(js|html)$/.test(p)) out.push(`«${p}» يستخدم fetch: الصفحة لا تتصل إلا بواجهتها، فاستخدم onespace.file/json للملفات و onespace.call/append/mine/stats للبيانات.`);
    if (/\b(localStorage|sessionStorage|document\.cookie)\b/.test(c)) out.push(`«${p}» يستخدم localStorage/cookies: غير متاحة في الصفحة المعزولة؛ احفظ في الذاكرة أو عبر onespace.`);
  }
  out.push(...serverDataCopies(app.files));
  for (const h of handlersOf(app.files)) if (!/^def\s+handle\s*\(/m.test(app.files[`server/${h}.py`]!)) out.push(`server/${h}.py يحتاج دالة def handle(request):`);
  return out;
}

// ---------------------------------------------------------------- the page bundle

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const sha256b64 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("base64");

/** Text safe inside <script>…</script>: no closing tag, no comment opener. */
const scriptSafe = (s: string) => s.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");

function localRef(ref: string): string | null {
  const r = ref.trim().replace(/^\.\//, "").split(/[?#]/)[0]!;
  if (!r || /^[a-z][a-z0-9+.-]*:/i.test(r) || r.startsWith("//") || r.startsWith("/")) return null;
  return r;
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

export type PageConfig = {
  api: string;
  token: string;
  visitor: { signedIn: boolean; name: string | null };
  lists: Record<string, { write: WriteMode; read: ReadMode; columns: { name: string; type: string; options?: string[] }[] }>;
  test?: boolean;
};

/** The bootstrap: `onespace` for the app's code. Its text varies per page (the token), so it is hashed per response. */
export function bootstrapScript(files: Record<string, string>, cfg: PageConfig): string {
  const pub: Record<string, string> = {};
  for (const [p, c] of Object.entries(files)) if (!isPrivate(p) && p !== "index.html" && !/\.(js|css)$/.test(p)) pub[p] = c;
  const C = JSON.stringify({ api: cfg.api, t: cfg.token, visitor: cfg.visitor, lists: cfg.lists, files: pub, test: !!cfg.test }).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, " ");
  return `(function(){var C=${C};
function req(op,b){b=b||{};b.t=C.t;b.op=op;return fetch(C.api,{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify(b)}).then(function(r){return r.json().catch(function(){return{ok:false,error:"HTTP "+r.status};});}).then(function(j){if(!j||!j.ok)throw new Error((j&&j.error)||"تعذّر الطلب");return j.value;});}
window.onespace={visitor:C.visitor,lists:C.lists,test:C.test,
file:function(p){if(!Object.prototype.hasOwnProperty.call(C.files,p))throw new Error("onespace.file: لا يوجد ملف "+p);return C.files[p];},
json:function(p){return JSON.parse(this.file(p));},
call:function(h,payload){return req("call",{handler:h,payload:payload===undefined?null:payload});},
append:function(l,row){return req("append",{list:l,row:row||{}});},
mine:function(l){return req("mine",{list:l});},
stats:function(l){return req("stats",{list:l});}};})();`;
}

/**
 * index.html as one document: <meta> removed (meta refresh would navigate), local stylesheets and
 * scripts inlined, local SVG images as data: URLs, our meta and bootstrap first, a small footer.
 * Returns the HTML and the CSP whose script-src lists the hash of every inline script in it.
 */
export function bundlePage(files: Record<string, string>, cfg: PageConfig, opts: { title: string; footer: string; origin: string }) {
  let html = files["index.html"] ?? "<p>لا يوجد index.html.</p>";
  html = html.replace(/<meta\b[^>]*>/gi, "").replace(/<base\b[^>]*>/gi, "");
  html = html.replace(/<link\b([^>]*)>/gi, (whole, attrs: string) => {
    if (!/\brel\s*=\s*["']?stylesheet/i.test(attrs)) return /\brel\s*=\s*["']?(icon|preload|prefetch|manifest)/i.test(attrs) ? "" : whole;
    const ref = localRef(attr(attrs, "href") ?? "");
    const css = ref && !isPrivate(ref) ? files[ref] : undefined;
    return css !== undefined ? `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>` : whole;
  });
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (whole, attrs: string, body: string) => {
    const src = attr(attrs, "src");
    if (src === null) return whole;
    const ref = localRef(src);
    const js = ref && !isPrivate(ref) ? files[ref] : undefined;
    if (js === undefined) return whole; // an outside script: the CSP blocks it, and the test reports it
    const rest = attrs.replace(/\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "").replace(/\b(defer|async)\b/gi, "");
    // A deferred script ran after parsing; inline it at the end of <body> to keep that order.
    const deferred = /\bdefer\b/i.test(attrs) && !/type\s*=\s*["']?module/i.test(attrs);
    const tag = `<script${rest}>${scriptSafe(js)}</script>`;
    return deferred ? `<!--os-defer-->${tag.replace(/^<script/, "<script data-os-defer")}` : tag;
  });
  // Move deferred scripts to the end of the body.
  const deferred: string[] = [];
  html = html.replace(/<!--os-defer--><script data-os-defer([\s\S]*?<\/script>)/g, (_w, rest: string) => {
    deferred.push(`<script${rest}`);
    return "";
  });
  html = html.replace(/<img\b([^>]*)>/gi, (whole, attrs: string) => {
    const ref = localRef(attr(attrs, "src") ?? "");
    const svg = ref && !isPrivate(ref) && ref.endsWith(".svg") ? files[ref] : undefined;
    return svg !== undefined ? whole.replace(/\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, `src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"`) : whole;
  });
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><script>${bootstrapScript(files, cfg)}</script>`;
  const foot = `${deferred.join("")}<p style="margin:32px 0 8px;color:#94a3b8;font:12px system-ui;text-align:center">${esc(opts.footer)}</p>`;
  if (/<head\b[^>]*>/i.test(html)) html = html.replace(/<head\b[^>]*>/i, (h) => h + head);
  else if (/<html\b[^>]*>/i.test(html)) html = html.replace(/<html\b[^>]*>/i, (h) => `${h}<head>${head}<title>${esc(opts.title)}</title></head>`);
  else html = `<!doctype html><html lang="ar" dir="rtl"><head>${head}<title>${esc(opts.title)}</title></head><body>${html}`;
  if (!/<title\b/i.test(html)) html = html.replace(/<\/head>/i, `<title>${esc(opts.title)}</title></head>`);
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${foot}</body>`) : html + foot;
  if (!/^\s*<!doctype/i.test(html)) html = `<!doctype html>${html}`;
  const hashes = new Set<string>();
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) if (attr(m[1]!, "src") === null) hashes.add(`'sha256-${sha256b64(m[2]!)}'`);
  const csp = [
    "default-src 'none'",
    `script-src ${[...hashes].join(" ") || "'none'"}`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    `connect-src ${cfg.api}`,
    "media-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "sandbox allow-scripts allow-forms",
  ].join("; ");
  return { html, csp };
}

// ---------------------------------------------------------------- grants in words

const WRITE_TEXT: Record<WriteMode, string> = { none: "", page: "يضيف صفوفاً من الصفحة", handler: "يضيف صفوفاً عبر منطق الخادم فقط" };
const READ_TEXT: Record<ReadMode, string> = { none: "", own: "يقرأ ما أضافه الزائر نفسه فقط", aggregate: "يقرأ إحصاءات مجمّعة (أعداد ومتوسطات، دون صفوف)" };

/** «نتائج الاختبار»: يضيف صفوفاً عبر منطق الخادم فقط (الأعمدة: …) · يملأ «المرسل» بالزائر */
export function grantLines(data: Record<string, Grant>, lists: Map<string, { title: string; columns: { key: string; name: string }[] } | null>): string[] {
  const out: string[] = [];
  for (const g of Object.values(data)) {
    const list = lists.get(g.listId);
    const name = (k: string) => list?.columns.find((c) => c.key === k)?.name ?? k;
    const parts = [WRITE_TEXT[g.write], READ_TEXT[g.read]].filter(Boolean);
    if (!parts.length) continue;
    const cols = g.columns?.length ? ` (الأعمدة: ${g.columns.map(name).join("، ")})` : "";
    out.push(`«${list?.title ?? "قائمة محذوفة"}»: ${parts.join("، و")}${cols}${g.sender ? ` · يسجّل في «${name(g.sender)}» من أرسل إن كان مسجّل الدخول` : ""}`);
  }
  return out;
}
