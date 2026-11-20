// A scripted decision model (plans/12) for the tests, speaking the OpenAI chat API. It reads the
// markers in what it is shown:
//   route  «R-NOFILES» → needsFiles false, «R-LIGHT» → effort light (and no files); otherwise needsFiles true.
//          The query is "QUERY-FROM-DECIDE" plus the message (so a test sees whose query was used).
//   cite   a CLAIM containing «CITE-BAD» → contradicts, «CITE-OFF» → unrelated; otherwise supports.
//   guard  a line containing «STEER-ME» → steering, quoting that line.
// `slowMs` delays every answer (a decide server that is too slow).

export type FakeDecide = { url: string; requests: any[]; slowMs: number; stop: () => void };

export function startFakeDecide(): FakeDecide {
  const fd: FakeDecide = { url: "", requests: [], slowMs: 0, stop: () => {} };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET") return Response.json({ data: [{ id: "fake-decide" }] });
      const body: any = await req.json().catch(() => ({}));
      fd.requests.push({ path: url.pathname, body });
      if (fd.slowMs) await Bun.sleep(fd.slowMs);
      const sys = String(body.messages?.[0]?.content ?? "");
      const user = String(body.messages?.at(-1)?.content ?? "");
      let out: unknown;
      if (sys.startsWith("You route")) {
        const msg = /الرسالة: ([\s\S]*)$/.exec(user)?.[1] ?? user;
        out = { needsFiles: !msg.includes("R-NOFILES") && !msg.includes("R-LIGHT"), query: `QUERY-FROM-DECIDE ${msg}`.slice(0, 200), effort: msg.includes("R-LIGHT") ? "light" : "normal" };
      } else if (sys.startsWith("You check citations")) {
        const pairs = [...user.matchAll(/^(\d+)\. CLAIM: (.*)$/gm)];
        out = { verdicts: pairs.map((p) => ({ i: Number(p[1]), verdict: p[2]!.includes("CITE-BAD") ? "contradicts" : p[2]!.includes("CITE-OFF") ? "unrelated" : "supports" })) };
      } else if (sys.startsWith("You screen text")) {
        const line = user.split("\n").find((l) => l.includes("STEER-ME"));
        out = line ? { quote: line.trim(), steering: true } : { quote: "", steering: false };
      } else out = {};
      return Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify(out) }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10 } });
    },
  });
  fd.url = `http://127.0.0.1:${server.port}/v1`;
  fd.stop = () => server.stop(true);
  return fd;
}
