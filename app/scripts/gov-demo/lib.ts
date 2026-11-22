// Client helpers for the government demo workspace (scripts/gov-demo). Signs in as a demo persona
// and calls the app's public API exactly like the web client does, so everything a script does is
// checked by the same permissions and lands in the same audit log.
//   const hr = await login("hr");                 // persona key from personas.ts
//   const sp = await hr.space("الموارد البشرية");
//   await hr.upload(sp, "path/to/file.pdf");
//   const t = await hr.newChat(sp); const a = await hr.ask(t, "لخّص سياسة الإجازات");
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export const URL_ = process.env.ONESPACE_URL ?? "http://127.0.0.1:8091";
export const CREDS = join(import.meta.dir, "..", "..", ".gov-demo-users.md");

export function passwords(): Record<string, string> {
  if (!existsSync(CREDS)) throw new Error(`no credentials file ${CREDS}: run scripts/gov-demo/seed.ts first`);
  const out: Record<string, string> = {};
  for (const line of readFileSync(CREDS, "utf8").split("\n")) {
    const m = line.match(/\|\s*([\w.+-]+@[\w.-]+)\s*\|\s*`([^`]+)`/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export async function rawCall(kind: "query" | "mutation" | "action", path: string, args: any, token?: string) {
  const res = await fetch(`${URL_}/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ path, args }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (body.status !== "success") throw new Error(`${path}: ${body.errorMessage ?? body.error ?? res.status}`);
  return body.value;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Answer = {
  text: string;
  citations: any[];
  toolRuns: { name: string; label: string; ok: boolean; summary: string }[];
  proposals: any[];
  skill: string | null;
  ms: number | null;
  error?: string;
};

export class Client {
  constructor(public email: string, public token: string, public userId: string) {}

  q = (path: string, args: any = {}) => rawCall("query", path, args, this.token);
  m = (path: string, args: any = {}) => rawCall("mutation", path, args, this.token);
  a = (path: string, args: any = {}) => rawCall("action", path, args, this.token);

  /** A space I belong to, by (exact) name. */
  async space(name: string): Promise<string> {
    const mine: any[] = await this.q("spaces:mine");
    const s = mine.find((x) => x.name === name);
    if (!s) throw new Error(`${this.email} has no space named ${name}: ${mine.map((x) => x.name).join("، ")}`);
    return s._id;
  }

  /** Uploads a local file into a space (as a new file) and returns its fileId. */
  async upload(spaceId: string | undefined, path: string, name = basename(path)): Promise<string> {
    const uploadUrl: string = await this.m("files:generateUploadUrl");
    const buf = readFileSync(path);
    const type = mimeOf(name);
    const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": type }, body: buf });
    const body: any = await res.json();
    if (!body.storageId) throw new Error(`upload ${name}: ${JSON.stringify(body)}`);
    return await this.m("files:create", { storageId: body.storageId, name, ...(spaceId ? { spaceId } : {}) });
  }

  /** Waits until every file in the space is indexed (or failed). */
  async waitIngest(spaceId: string, timeoutMs = 15 * 60_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const files: any[] = await this.q("ingest:statuses", { spaceId });
      const pending = files.filter((f) => f.state !== "ready" && f.state !== "failed");
      if (!pending.length) return files;
      if (Date.now() > end) throw new Error(`ingest timeout: ${pending.map((f) => f.name).join(", ")}`);
      await sleep(3000);
    }
  }

  /** A private chat by default; `shared: true` makes a space chat colleagues see (the assistant then answers only when called, which ask() does). */
  async newChat(spaceId?: string, shared = false): Promise<string> {
    const r = await this.m("chat:createThread", spaceId ? { spaceId, shared } : {});
    return typeof r === "string" ? r : (r.threadId ?? r._id);
  }

  /** Sends a question and waits for the answer (polling chat:messages, like the UI does). */
  async ask(threadId: string, text: string, opts: { mentions?: { kind: "file" | "space"; id: string }[]; skillId?: string; effort?: "auto" | "fast" | "deep"; timeoutMs?: number } = {}): Promise<Answer> {
    const before: any = await this.q("chat:messages", { threadId });
    const seen = new Set((before.messages ?? before).map((m: any) => m.id));
    await this.m("chat:send", { threadId, text, ...(opts.mentions ? { mentions: opts.mentions } : {}), ...(opts.skillId ? { skillId: opts.skillId } : {}), ...(opts.effort ? { effort: opts.effort } : {}), to: "assistant" });
    const end = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
    for (;;) {
      await sleep(2500);
      const r: any = await this.q("chat:messages", { threadId });
      const msgs: any[] = r.messages ?? r;
      const turn = r.turn;
      if (turn?.state === "failed") return { text: "", citations: [], toolRuns: [], proposals: [], skill: null, ms: null, error: turn.error ?? "failed" };
      if (!turn || turn.state === "done") {
        const fresh = msgs.filter((m) => !seen.has(m.id) && m.role === "assistant");
        const last = fresh[fresh.length - 1];
        if (last) return { text: last.text, citations: last.citations, toolRuns: last.toolRuns, proposals: last.proposals, skill: last.skill?.name ?? null, ms: last.ms };
      }
      if (Date.now() > end) return { text: "", citations: [], toolRuns: [], proposals: [], skill: null, ms: null, error: "timeout" };
    }
  }

  /** «نفّذ» on a proposal card. */
  confirm = (proposalId: string) => this.a("chat:confirmProposal", { proposalId });
}

export async function login(emailOrKey: string): Promise<Client> {
  const { personas } = await import("./personas.ts");
  const email = emailOrKey.includes("@") ? emailOrKey : personas.find((p) => p.key === emailOrKey)?.email;
  if (!email) throw new Error(`unknown persona ${emailOrKey}`);
  const password = passwords()[email];
  if (!password) throw new Error(`no password for ${email}`);
  const res = await fetch(`${URL_}/api/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "password", params: { flow: "signIn", email, password } }),
  });
  const body: any = await res.json();
  if (!body.token) throw new Error(`signIn ${email}: ${JSON.stringify(body)}`);
  return new Client(email, body.token, body.userId);
}

export function mimeOf(name: string) {
  const ext = name.toLowerCase().split(".").pop();
  return (
    {
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      csv: "text/csv",
      txt: "text/plain",
      md: "text/markdown",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
    } as Record<string, string>
  )[ext ?? ""] ?? "application/octet-stream";
}
