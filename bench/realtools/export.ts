// Dumps the app's real agent tools and system prompt to tools.json, so the bench tests what the
// chat loop actually sends (app/onebase/chat.ts). Run: bun export.ts
import { tools, PERSONAL_TOOLS, MEMORY_TOOLS } from "../../app/onebase/tools/index";
import { buildSystemPrompt } from "../../app/onebase/chat";
import { writeFileSync } from "node:fs";

const specs = Object.values(tools).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, write: !!t.requiresConfirmation }));
const agentOnly = Object.keys(tools).filter((t) => !PERSONAL_TOOLS.includes(t) && !MEMORY_TOOLS.includes(t));
const system = {
  open: buildSystemPrompt({ name: "المساعد", instructions: "" }, [], "open"),
  documents: buildSystemPrompt({ name: "المساعد", instructions: "" }, [], "documents"),
};
writeFileSync(new URL("./tools.json", import.meta.url), JSON.stringify({ exportedAt: new Date().toISOString(), specs, personal: PERSONAL_TOOLS, memory: MEMORY_TOOLS, agentOnly, system }, null, 1));
console.log(`${specs.length} tools, ${JSON.stringify(specs).length} chars; system open ${system.open.length} / documents ${system.documents.length}`);
