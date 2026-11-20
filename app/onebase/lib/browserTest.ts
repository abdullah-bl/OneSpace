// test_app's browser (plans/13 §4): headless Chrome driven over the DevTools protocol, no extra
// packages. It opens one URL, runs the assistant's steps (fill, click, select, check, wait, expect),
// and reports what a person debugging would look at: console errors and warnings, uncaught
// exceptions, CSP violations, failed requests, and the page's visible text.
//
// Every request goes through Fetch interception: only URLs under `allow` prefixes (the test page and
// its API on the content origin) go out; anything else is blocked and reported. So model-written code
// running here can't reach the network, the intranet or the server's own ports.

import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

export type Step = { do: "fill" | "click" | "select" | "check" | "wait" | "expect"; selector?: string; value?: string | boolean; text?: string; ms?: number };
export type StepResult = { step: Step; ok: boolean; error?: string; text?: string };
export type BrowserReport = {
  ok: boolean;
  error?: string;
  steps: StepResult[];
  console: { level: string; text: string }[];
  exceptions: string[];
  failedRequests: { url: string; reason: string }[];
  blocked: string[];
  text: string;
  title: string;
};

export class BrowserUnavailable extends Error {}

/** Chrome or Chromium on this machine: BROWSER_PATH, the usual names, or Playwright's download. */
export function findBrowser(): string | null {
  const env = process.env.BROWSER_PATH?.trim();
  if (env) return existsSync(env) ? env : null;
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) if (existsSync(p)) return p;
  const pw = join(homedir(), ".cache/ms-playwright");
  try {
    for (const d of readdirSync(pw).filter((x) => x.startsWith("chromium-")).sort().reverse()) {
      for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) if (existsSync(join(pw, d, sub))) return join(pw, d, sub);
    }
  } catch {}
  return null;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

class Cdp {
  private id = 0;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, ((p: any) => void)[]>();
  constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method) for (const h of this.handlers.get(msg.method) ?? []) h(msg.params);
    });
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("browser closed"));
      this.pending.clear();
    });
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method: string, h: (p: any) => void) {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), h]);
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Runs in the page: one step. Returns "" when done, or why it failed. */
const STEP_JS = `async function(step){
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const vis=(el)=>!!el&&!!(el.offsetWidth||el.offsetHeight||el.getClientRects().length);
function byText(t){const want=String(t).trim();const c=[...document.querySelectorAll('button,a,[role=button],input[type=submit],input[type=button],label,summary')];
return c.find(e=>vis(e)&&((e.innerText||e.value||'').trim()===want))||c.find(e=>vis(e)&&((e.innerText||e.value||'').trim().includes(want)));}
function find(){if(step.selector){const all=[...document.querySelectorAll(step.selector)];return all.find(vis)||all[0]||null;}if(step.text)return byText(step.text);return null;}
async function waitFor(fn,ms){const end=Date.now()+ms;for(;;){const v=fn();if(v)return v;if(Date.now()>end)return null;await sleep(100);}}
const ms=Math.min(Math.max(Number(step.ms)||5000,0),20000);
const fire=(el,t)=>el.dispatchEvent(new Event(t,{bubbles:true}));
if(step.do==='wait'){if(!step.selector&&!step.text){await sleep(Math.min(Number(step.ms)||500,10000));return'';}
const ok=await waitFor(()=>step.selector?vis(document.querySelector(step.selector)):document.body.innerText.includes(step.text),ms);return ok?'':'لم يظهر خلال '+ms+'ms';}
if(step.do==='expect'){const want=String(step.text??step.value??'');const ok=await waitFor(()=>{if(step.selector){const el=document.querySelector(step.selector);return el&&el.innerText.includes(want);}return document.body.innerText.includes(want);},ms);return ok?'':'النص «'+want+'» غير موجود في الصفحة';}
const el=await waitFor(find,ms);if(!el)return 'لا يوجد عنصر '+(step.selector?'يطابق '+step.selector:'نصه «'+step.text+'»');
el.scrollIntoView&&el.scrollIntoView({block:'center'});
if(step.do==='click'){if(el.disabled)return 'العنصر معطّل (disabled)';el.click();return'';}
if(step.do==='fill'){if(!('value' in el))return 'العنصر ليس حقل إدخال';const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const set=Object.getOwnPropertyDescriptor(proto,'value').set;el.focus();set.call(el,String(step.value??''));fire(el,'input');fire(el,'change');return'';}
if(step.do==='check'){const want=step.value!==false&&step.value!=='false';if(el.type==='radio'||el.type==='checkbox'){if(el.checked!==want)el.click();return'';}return 'العنصر ليس radio أو checkbox';}
if(step.do==='select'){const v=String(step.value??'');if(el.tagName==='SELECT'){const o=[...el.options].find(o=>o.value===v)||[...el.options].find(o=>o.text.trim()===v.trim());if(!o)return 'لا يوجد خيار «'+v+'». الخيارات: '+[...el.options].map(o=>o.text.trim()).join(' | ');el.value=o.value;fire(el,'input');fire(el,'change');return'';}
const scope=el.querySelectorAll?el:document;const r=[...scope.querySelectorAll('input[type=radio],input[type=checkbox]')].find(i=>i.value===v||((i.labels&&i.labels[0]&&i.labels[0].innerText.trim())===v.trim()));if(r){if(!r.checked)r.click();return'';}
const b=[...scope.querySelectorAll('button,[role=button],[role=radio],label,li')].find(x=>vis(x)&&x.innerText.trim()===v.trim());if(b){b.click();return'';}return 'لم أجد الخيار «'+v+'» داخل '+(step.selector||'العنصر');}
return 'خطوة غير معروفة: '+step.do;}`;

export async function runInBrowser(url: string, steps: Step[], opts: { allow: string[]; timeoutMs?: number }): Promise<BrowserReport> {
  const exe = findBrowser();
  if (!exe) throw new BrowserUnavailable("لا يوجد متصفح Chrome/Chromium على الخادم (BROWSER_PATH) لتجربة التطبيق");
  const dir = mkdtempSync(join(tmpdir(), "onespace-browser-"));
  const proc = Bun.spawn(
    [exe, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking", "--disable-sync", "--metrics-recording-only", "--mute-audio", "--window-size=1100,900", "about:blank"],
    { stdout: "ignore", stderr: "ignore" },
  );
  const report: BrowserReport = { ok: false, steps: [], console: [], exceptions: [], failedRequests: [], blocked: [], text: "", title: "" };
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  let ws: WebSocket | null = null;
  try {
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) {
      try {
        port = Number(readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]);
      } catch {}
      if (!port) await Bun.sleep(100);
    }
    if (!port) throw new BrowserUnavailable("لم يبدأ المتصفح");
    const target: any = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => {
      ws!.addEventListener("open", () => res());
      ws!.addEventListener("error", () => rej(new BrowserUnavailable("تعذّر الاتصال بالمتصفح")));
    });
    const cdp = new Cdp(ws);
    const inflight = new Set<string>();
    let lastNet = Date.now();
    cdp.on("Runtime.consoleAPICalled", (p) => {
      if (report.console.length >= 60) return;
      const text = (p.args ?? []).map((a: any) => (a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : (a.description ?? a.type))).join(" ");
      report.console.push({ level: p.type, text: clip(text, 500) });
    });
    cdp.on("Runtime.exceptionThrown", (p) => {
      const d = p.exceptionDetails ?? {};
      const msg = d.exception?.description ?? d.text ?? "exception";
      if (report.exceptions.length < 20) report.exceptions.push(clip(`${msg}${d.lineNumber !== undefined ? ` (سطر ${d.lineNumber + 1})` : ""}`, 800));
    });
    cdp.on("Log.entryAdded", (p) => {
      const e = p.entry ?? {};
      if ((e.level === "error" || e.level === "warning") && report.console.length < 60) report.console.push({ level: e.level, text: clip(`${e.source ? `[${e.source}] ` : ""}${e.text}`, 500) });
    });
    const urls = new Map<string, string>();
    cdp.on("Network.requestWillBeSent", (p) => {
      inflight.add(p.requestId);
      urls.set(p.requestId, p.request?.url ?? "");
      lastNet = Date.now();
    });
    const done = (p: any) => {
      inflight.delete(p.requestId);
      lastNet = Date.now();
    };
    cdp.on("Network.loadingFinished", done);
    cdp.on("Network.loadingFailed", (p) => {
      done(p);
      if (report.failedRequests.length < 30 && p.errorText !== "net::ERR_BLOCKED_BY_CLIENT") report.failedRequests.push({ url: p.requestId, reason: `${p.errorText}${p.blockedReason ? ` (${p.blockedReason})` : ""}` });
    });
    cdp.on("Network.responseReceived", (p) => {
      if (p.response.status >= 400 && report.failedRequests.length < 30) report.failedRequests.push({ url: clip(p.response.url, 200), reason: `HTTP ${p.response.status}` });
    });
    cdp.on("Fetch.requestPaused", (p) => {
      const u: string = p.request.url;
      const ok = u.startsWith("data:") || opts.allow.some((a) => u.startsWith(a));
      if (ok) void cdp.send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => {});
      else {
        if (report.blocked.length < 20) report.blocked.push(clip(u, 200));
        void cdp.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }).catch(() => {});
      }
    });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Network.enable");
    await cdp.send("Page.enable");
    const loaded = new Promise<void>((res) => cdp.on("Page.loadEventFired", () => res()));
    await cdp.send("Page.navigate", { url });
    await Promise.race([loaded, Bun.sleep(15_000)]);
    const idle = async (max: number) => {
      const end = Math.min(Date.now() + max, deadline);
      while (Date.now() < end) {
        if (!inflight.size && Date.now() - lastNet > 400) return;
        await Bun.sleep(100);
      }
    };
    await idle(15_000);
    const pageText = async () => {
      const r = await cdp.send("Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''", returnByValue: true });
      return String(r.result?.value ?? "");
    };
    let failed = false;
    for (const step of steps.slice(0, 80)) {
      if (Date.now() > deadline) {
        report.steps.push({ step, ok: false, error: "انتهى وقت التجربة" });
        failed = true;
        break;
      }
      const r = await cdp.send("Runtime.callFunctionOn", {
        functionDeclaration: STEP_JS,
        objectId: (await cdp.send("Runtime.evaluate", { expression: "window" })).result.objectId,
        arguments: [{ value: step }],
        awaitPromise: true,
        returnByValue: true,
      });
      const err = r.exceptionDetails ? (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text) : String(r.result?.value ?? "");
      await idle(20_000);
      if (err) {
        report.steps.push({ step, ok: false, error: clip(err, 400), text: clip(await pageText(), 1500) });
        failed = true;
        break;
      }
      report.steps.push({ step, ok: true });
    }
    report.text = clip((await pageText()).replace(/\n{3,}/g, "\n\n"), 4000);
    report.title = String((await cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true })).result?.value ?? "");
    for (const f of report.failedRequests) f.url = urls.get(f.url) ? clip(urls.get(f.url)!, 200) : f.url;
    report.ok = !failed && !report.exceptions.length && !report.console.some((c) => c.level === "error") && !report.blocked.length;
    return report;
  } catch (e) {
    if (e instanceof BrowserUnavailable) throw e;
    report.error = e instanceof Error ? e.message : String(e);
    return report;
  } finally {
    try {
      ws?.close();
    } catch {}
    proc.kill();
    await Promise.race([proc.exited, Bun.sleep(3000)]);
    rmSync(dir, { recursive: true, force: true });
  }
}
