# 08 — Sub-agents, tools, data sources and per-employee levels (draft for discussion)

Status: proposal, 2026-11-18. Open decisions are marked **[decide]**.

**Built (2026-11-18):** §A sub-agents and §D levels. Decisions taken:
- Splitting is automatic: the router's `split` flag, then a planner call, and only if the level allows it.
- Parts use read tools only.
- Levels are assigned per person, with a workspace default.
- Per-team levels and the tools tab (§B) are still open.

**Built (2026-11-19):** §C data sources, model providers, the admin console, global search, help center.
- Sources (`onebase/dataSources.ts`, `lib/sourceQuery.ts`, tool `query_source`): PostgreSQL, MySQL/MariaDB, SQLite, a REST system (GET under allowed paths) and a search engine (SearxNG-style JSON). Read only: one SELECT, checked, then run in a read-only transaction with a 15 s timeout and an outer LIMIT (SQLite opens `mode=ro`). Secrets are write-only. A source is for the workspace or members of chosen spaces; `levels.sources` narrows it per level. The model sees the sources it may use (name, description, structure) in the system prompt; every call is audited. MCP servers and synced folders are not built.
- Providers (`onebase/providers.ts`): OpenAI-compatible servers; the main / fast / vision roles each point at one provider's model or stay on the environment. Loaded per action by `primeAi()`. Embeddings stay in the environment (a change means re-indexing).
- «إدارة المنصة» (`src/AdminConsole.tsx`, `#/admin/<page>`): overview, employees, levels and usage, spaces, agents, providers, data sources, audit log. Old `#/agents`, `#/levels`, `#/audit` still open the same pages.
- Confirmations use an in-app dialog (`ask()` in `src/ui.tsx`): embedded browsers cancel `window.confirm()` without showing it, which made «انشر» do nothing.

Already done in this round, so it isn't repeated below:
- The composer no longer shows an agent picker. The agent is picked per question. A picker shows only on an old chat that is pinned to an agent, so the user can unpin it.
- The @ button is gone. Typing @ still opens the list.
- There is a thinking level: «تلقائي» (the router judges each question), «سريع», «عميق». The model's reasoning stays hidden, and the step list shows «يفكّر…».

## A. One chat, several agents (sub-agents)

**Goal.** For a big request («قارن العقود الثلاثة وجهّز عرضاً بالنتائج»), the chat splits the work, runs parts in parallel with the right agent for each, and puts the result together. This produces a better answer than one agent doing everything in one long loop.

**How it would work**
1. **Plan.** The main model, already used by the router, returns either `single` (most questions) or a plan of 2–3 parts. Each part has a goal, an agent and its inputs (which files).
2. **Run the parts.** Each part is a turn without a chat. It uses its agent's tools and scope, intersected with what the user can read, which is the same rule as today. Each part has its own budget and its own step group in the timeline, for example «جزء 1: يقرأ العقد أ…».
3. **Merge.** The main agent writes the final answer from the parts' outputs, treated as data, and cites sources.

**Rules**
- A sub-agent never gets more than the user has. Only the merge step may create files. Writes stay proposals with tiers, as now.
- «إيقاف» stops every part.
- Parts are shown collapsed under the answer, and each can be opened.

**The cost.** The main model runs at about 13 tokens/s with 4 slots. Three parts in parallel take about the same wall time as one, but they hold 3 slots, so other users wait. Limit: at most 3 parts, and only when the router says the request is multi-part, or the user picked «عميق».

**[decide]** Should splitting be automatic (the router decides), or only offered as a button: «قسّم المهمة على عدة وكلاء»?

## B. Agents page: tools

Today a tool is a name in a checkbox list. Proposal: a **«الأدوات»** tab with one card per tool. Each card shows:
- what it does;
- its risk tier (reads / writes in my space / writes shared / sensitive);
- what it can touch;
- which agents use it;
- how often it ran this week and how often it failed.

Tools are still defined in code (`onebase/tools/*`). Admins only choose which agent and which level (§D) may use each one. The AI agent drafter already chooses only from this registry.

## C. Data sources: external systems

Today the only sources are uploaded files and two record tools (`my_records`, `query_records`). Options, in order of risk:

| Source | What it gives | Main risk |
|---|---|---|
| Internal systems (HR, finance, ERP) through **read-only views or a REST API** | live facts: leave balance, budget, contract status | personal data; needs per-row filtering by who is asking |
| Shared folders / SharePoint, synced on a schedule | documents without uploading by hand | permissions must be mirrored, or the files get a space of their own |
| **MCP servers** | a standard way to plug in many systems | each server is code we trust; every call is audited |
| Web search | public information | the deployment may have no internet; leaking questions out |

**Design (all options)**
- A **connector** is registered by an admin. Its secret stays on the server and is never sent to the model.
- A connector becomes one or more tools: `query_<source>`, read only by default.
- A connector has a scope (which teams/levels can use it), a row filter by the asking user, a limit on returned rows, and an audit entry for every call.

**[decide]** Which systems come first, and does the deployment have internet access at all?

## D. Per-employee levels (like Claude's plans)

Claude gives a free user simpler models and fewer tools. Here the same idea applies between employees: by role, team or person.

A **level** («مستوى») is a profile the admin sets:

| Setting | Example: «أساسي» | Example: «متقدم» |
|---|---|---|
| Models | fast model only | main model + «عميق» |
| Tools | search, read, write documents | + analysis, records, export |
| Data sources (§C) | none | HR + finance views |
| Sub-agents (§A) | no | up to 3 |
| Daily limit | 50 questions | 300 questions |
| Longest answer / context | shorter | full |

**Enforcement** happens in one place on the server, where the turn starts:
- tools = agent's tools ∩ level's tools;
- thinking is capped by the level, so «عميق» becomes «سريع» on «أساسي» and the UI greys it out with a reason;
- quotas use the existing rate limiter.

Each employee has exactly one level: the person's own, else the team's, else the workspace default. Changes are audited. The user sees their level and remaining quota in the account menu.

**[decide]** The level names, how many levels, and whether levels follow job roles or are assigned by hand.

## Suggested order

1. **D (levels).** It's small, and it is the frame that A and C plug into, since both are gated per level.
2. **B (tools tab).** UI only, on top of the existing registry.
3. **A (sub-agents).** The largest piece; it needs measurements on the real model before choosing limits.
4. **C (sources).** Starts after the systems and network question is answered.
