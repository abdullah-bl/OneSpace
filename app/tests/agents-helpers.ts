// Helpers for the Phase 6 tests: build agent configs, publish agents, read proposals and the
// requests the (fake) model received.

import { must, type Server } from "./harness";
import type { FakeAI } from "./fake-ai";

export type AgentCfg = {
  name: string;
  description: string;
  instructions: string;
  allowedTools: string[];
  dataScope: "everyone" | "member" | "all";
  modelRole: "main" | "fast";
  maxSteps: number;
  visibility: { kind: "workspace" | "spaces"; spaceIds: string[] };
};

export function cfg(over: Partial<AgentCfg> = {}): AgentCfg {
  return {
    name: "وكيل اختبار",
    description: "",
    instructions: "",
    allowedTools: ["search_documents", "read_file"],
    dataScope: "all",
    modelRole: "main",
    maxSteps: 4,
    visibility: { kind: "workspace", spaceIds: [] },
    ...over,
  };
}

/** Creates an agent as `adminToken` and publishes it (version 1). */
export async function publishedAgent(s: Server, adminToken: string, over: Partial<AgentCfg> = {}): Promise<string> {
  const id = must(await s.call("mutation", "agents:create", { config: cfg(over) }, adminToken));
  must(await s.call("mutation", "agents:publish", { agentId: id }, adminToken));
  return id;
}

/** The proposals shown under the thread's messages, newest last. */
export async function proposalsOf(s: Server, token: string, threadId: string): Promise<any[]> {
  const r = must(await s.call("query", "chat:messages", { threadId }, token));
  return r.messages.flatMap((m: any) => m.proposals ?? []);
}

/** Chat requests whose messages contain `marker` (system prompt, question or sources). The fast
 * model's chat-title requests (JSON with a "title" field, UX redesign) are not answer requests. */
export function chatRequestsWith(ai: FakeAI, marker: string) {
  return ai.requests.filter((r) => r.path === "/v1/chat/completions" && !isTitleRequest(r) && JSON.stringify(r.body.messages ?? []).includes(marker));
}

export function isTitleRequest(r: any) {
  return !!r.body.response_format && JSON.stringify(r.body.response_format).includes('"title"');
}

/** The tool names offered in a chat request: the agent's own (memory tools come with every agent, plans/09). */
export function offered(req: any): string[] {
  return (req.body.tools ?? [])
    .map((t: any) => t.function.name)
    .filter((n: string) => n !== "remember" && n !== "recall" && n !== "create_skill" && n !== "use_skill" && !n.endsWith("_list") && n !== "publish_output" && !n.endsWith("_app"))
    .sort();
}

export function systemOf(req: any): string {
  return (req.body.messages ?? []).filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n");
}
