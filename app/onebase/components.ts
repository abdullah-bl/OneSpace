import { defineComponents } from "onebase/components";
import { agent } from "onebase/components/agent";
import { rag } from "onebase/components/rag";
import { rateLimiter, MINUTE } from "onebase/components/rate-limiter";
import { workQueue } from "onebase/components/work-queue";
import { workflow } from "onebase/components/workflow";
// @onebase/teams, installed from GitHub as part of the onebase-components monorepo (bun can not
// install a subdirectory of a git repo, so the package is imported by its path inside the repo).
import { teams } from "onebase-components/packages/teams/src/index.ts";

// The vector size is fixed when the rag mount's index is built: it must match EMBED_DIMENSIONS
// in the server's environment at start-up (embeddinggemma-2: 768). ai.ts also pins the model
// name with the index and refuses to run if either changes.
const EMBED_DIMENSIONS = Number(process.env.EMBED_DIMENSIONS || 768);
const GPU_SLOTS = Math.max(1, Number(process.env.GPU_SLOTS || 4));

// The workspace (department) is one team: admin = workspace admin, member = employee.
// Space membership (manager|member|reader) is in the app's own spaceMembers table.
export default defineComponents({
  workspace: teams({ roles: ["admin", "member"], manageRole: "admin", joinRole: "member" }),
  // Document index: one namespace per space (the permission boundary), key = file id.
  docs: rag({ dimensions: EMBED_DIMENSIONS }),
  // Threads, messages and answer streams. The generation loop is ours (chat.ts runTurn).
  chat: agent({}),
  // File ingestion pipeline (ingest.ts): extract → normalize → chunk → embed, durable.
  ingest: workflow(),
  // Every chat turn goes through this queue: at most GPU_SLOTS generations at once (llama-server --parallel).
  gpu: workQueue({ maxParallelism: GPU_SLOTS, retry: { maxAttempts: 1 }, timeoutMs: 10 * 60_000 }),
  limiter: rateLimiter({
    rates: {
      // Per user: bursts of CHAT_BURST questions (6), then CHAT_RATE_PER_MIN per minute (10).
      chatTurn: { kind: "token bucket", rate: Number(process.env.CHAT_RATE_PER_MIN || 10), period: MINUTE, capacity: Number(process.env.CHAT_BURST || 6) },
    },
  }),
});
