// HTTP client for sandbox-runner (the only process with Docker access). OneBase never touches
// Docker: it sends the code and the exported input bytes, and gets stdout + /output back.

export type SandboxLimits = { timeoutMs: number; memoryMb: number; cpus: number; pids: number; outputMb: number };

export type SandboxResult = {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  oomKilled: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  files: { name: string; size: number; sha256: string; b64: string }[];
  outputBytes: number;
  outputTruncated: boolean;
  error?: string;
  limits: SandboxLimits;
  runtime: string;
  image: string;
  inputs: { name: string; size: number; sha256: string }[];
};

export class SandboxUnavailable extends Error {}

export function sandboxConfig() {
  const url = process.env.SANDBOX_URL?.replace(/\/+$/, "");
  const secret = process.env.SANDBOX_SECRET;
  return url && secret ? { url, secret } : null;
}

export async function callSandbox(req: { code: string; files: { name: string; b64: string }[]; limits: Partial<SandboxLimits> }): Promise<SandboxResult> {
  const cfg = sandboxConfig();
  if (!cfg) throw new SandboxUnavailable("بيئة التحليل غير مفعّلة على الخادم بعد؛ أبلغ مدير المنصة.");
  const timeout = (req.limits.timeoutMs ?? 60_000) + 90_000;
  let res: Response;
  try {
    res = await fetch(`${cfg.url}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.secret}` },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new SandboxUnavailable("تعذّر الوصول إلى بيئة التحليل الآن؛ أعد المحاولة بعد قليل، وإن تكرر فأبلغ مدير المنصة.");
  }
  const body: any = await res.json().catch(() => null);
  if (!res.ok || !body) throw new SandboxUnavailable(`رفضت بيئة التحليل الطلب (${res.status}${body?.error ? `: ${body.error}` : ""})`);
  return body as SandboxResult;
}
