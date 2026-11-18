# 07 — UX, agents and tools: roadmap (draft for discussion)

Status: proposal, 2026-11-18. Nothing here is built yet. Decisions marked **[decide]** are open.

## 1. Where we made things conflict

These come from the code as it is today, not from taste.

| # | Conflict | Where | Effect |
|---|---|---|---|
| 1 | **An agent is both a permission boundary and a user choice.** Tools, data scope and grounding are bundled per agent, and the user picks the agent. | `onebase/agents.ts` (`STARTER_AGENTS`), composer agent picker | The user must know that only «التحليل» can read a CSV and only it has `run_analysis`. «المساعد العام» couldn't open `employees.csv`. |
| 2 | **Confirmation everywhere vs. autonomy.** Every write tool waits for «نفّذ», even read-only analysis. Scheduled runs wait up to 24 h. | `requiresConfirmation` in `tools/*`, `SCHEDULED_PROPOSAL_TTL` in `chat.ts` | "Autonomous" scheduled tasks aren't autonomous. A simple summary of a file takes 2 turns and a click. |
| 3 | **Tools overlap.** `run_analysis` can write PNG/PDF, `export_document` writes PDF/Word, and `create_artifact` writes Markdown/HTML. | `tools/run_analysis.ts`, `export_document.ts`, `create_artifact.ts` | Asked for a PDF, the model first proposed a PNG through `run_analysis`. |
| 4 | **Model-facing tool text is shown to users.** | `ProposalCard` shows `p.result` | Cards end with `artifactId=… fileId=…`. |
| 5 | **Two different things are both called "tasks".** Human tasks (board, assignee, review) and scheduled prompts share one «المهام» tab. | `TasksView.tsx`, `SchedulesView.tsx` | No way to give a task to the agent, and no single place to see what's waiting on me. |
| 6 | **A space is a project (my private chats) and also a team (shared files and tasks).** Space chats say «لا يراها غيرك». | `SpaceView.tsx`, `threadMeta` | Colleagues can't work on the same conversation. The only shared work surface is task comments. |
| 7 | **The code has two design systems.** Newer screens use tokens (`ink/muted/line/surface`); 11 older screens use raw `neutral-*/red-*/amber-*`. | e.g. `TasksView` 49 raw vs 8 tokens; `AgentsView` 42 raw; `ArtifactPanel` 15 raw | Spacing, radius and colour drift between screens. The output panel is an old-style card capped at 60vh. |
| 8 | **Docs drift.** `UX.md` says @ lists agents; commit `30807c3` removed them. | `app/UX.md` | The source of truth disagrees with the app. |
| 9 | **Context is counted in messages and characters, not tokens.** It keeps the last 8–12 messages, cuts tool output at 4000/8000 characters, and uses one fixed `max_tokens`. The 262k KV cache is shared by 4 slots, so about 65k per concurrent request. | `HISTORY_KEEP/MAX`, `clip()`, `MAX_RUN_RESULT`, `bench/servers.sh` | It overflows silently or wastes context, and nothing measures it. Today's HTTP 500 was this kind of failure. |
| 10 | **The model is slow for loops.** The 27B model writes about 12–13 tokens/s. | `bench/run/main.log` | Every extra agent step costs 10–60 s. "Smart" must not mean "more main-model calls". |

## 2. Principles for the next round

1. **One assistant, with skills underneath.** The user just asks. The system picks the skill and tools; the user *can* override, but never has to.
2. **Permissions stay where they are** (`access.ts`, scope ∩ mentions). Routing chooses *within* what the user is allowed to do; it never widens access.
3. **Ask for confirmation by risk, not by tool.** Reading never asks. Creating something only I can see doesn't ask (and can be undone). Changing shared or sensitive things asks.
4. **Plan with the fast model, answer with the main model.** Routing, tool selection and titles use the 1.7B model plus embeddings. The 27B model only does the real work.
5. **Count tokens, not messages.** Every request is built against a token budget.
6. **One design system** (§3.A), applied to the app *and* to what it produces (PDF/PPTX/HTML).

## 3. Workstreams

### A. Design system: take what we liked from aitd.surge.sh

What that site actually uses (measured):
- **Type:** IBM Plex Sans Arabic, weights 400/500/700, bundled locally.
- **Colour:** one ink `#0a0a0a`, one blue `#2436ff`, one red `#ff3b1f` accent, grey surfaces `#f3f3f3`/`#dcdcdc`, lines `#cfcfcf`.
- **Type scale:** small 16 / body 18–19 / lead 20–26 / head 30–60 / display 52–116, all fluid `clamp()`.
- **Motion:** a single curve `cubic-bezier(.16,1,.3,1)`:
  - `rise`: fade and move up 22–26 px;
  - `mask`: a line slides up from behind a mask;
  - `pop`: scale up from .92;
  - `drift`: a slow 1.14→1 zoom on images;
  - reveals on scroll, staggered with `--d`.
- **Shape:** flat colour blocks with sharp edges, high contrast, few borders, generous gaps (`--gap` 72–150 px).

The app is a work tool, not a presentation, so:

- **App chrome:**
  - adopt the font, the colours (blue as the one accent for primary actions and links, red only for errors) and the ease curve;
  - spacing on a 4/8 grid: 8 inside controls, 12–16 inside cards, 24 between sections, 40–48 around page headers;
  - keep lists dense.
- **Display moments only:** empty states, page titles, the new-chat hero and task headers get the large type and the `mask`/`rise` entrance.
- **Motion rules:**
  - message enter: `rise`, 180 ms;
  - panel open: slide 240 ms;
  - status chips: `pop`;
  - no motion with `prefers-reduced-motion`;
  - no looping animation except the stream caret.
- **Component kit** in `src/ui/`: Button, IconButton, Card, Tabs, Sheet/SidePanel, Badge, Menu, EmptyState, Field, Table. Migrate the 11 raw-palette screens to it, one screen per commit, with before/after screenshots.
- **House style for outputs:** the same tokens become the PDF stylesheet, the PowerPoint theme (title-slide layout, blue rule, Plex Arabic) and a "presentation" theme for HTML outputs (sections that reveal like aitd). Today's renderer already has the hooks (`CSS` in `render_doc.py`, slide layout code).

**[decide]** Blue accent across the whole app, or neutral chrome with blue only on outputs and presentations? My recommendation: blue as the single accent everywhere, used sparingly.

### B. Outputs (artifacts): compact and full height

- **Layout:**
  - Desktop: the chat and the output side by side at full height, with a draggable divider (default 50/50, remembered per user).
  - Tablet: the output replaces the chat with a back arrow.
  - Phone: a full-screen sheet.
- **One toolbar row:**
  - title (editable inline);
  - version stepper `‹ v3 ›`;
  - a Preview / Edit toggle;
  - a Download menu (Word, PDF, PowerPoint, CSV/XLSX for tables);
  - an overflow ⋯ menu: move to space, share, delete, copy link;
  - close.
  - No more stacked selects and sha lines (the sha moves to ⋯ › Details).
- **Edit:** a Markdown editor with live preview beside it on wide screens. Saving makes a new version (already built: `artifacts:edit`). "Ask the agent to change…" sits in the toolbar and sends a scoped message.
- **Present:** HTML and slide outputs open full screen with arrow keys, using the house style.
- **Chat:** the chat shows one compact output chip per output (icon, title, version, type), not a card.

### C. One assistant: smart routing instead of the agent picker

How a turn would work:

```
question ─► Router (fast 1.7B model + embeddings, about 300 ms)
              │  input: question, the last few messages, @mentions, a list of skills (name + "use when")
              │  output (JSON schema): { skill, tools[≤6], needsFiles, confidence }
              ▼
          Skill resolution (code, not model)
              │  allowed = skills the user may use ∩ space policy ∩ scope ∩ mentions   ← access.ts, unchanged
              │  confidence low → default skill (general) with read tools only
              ▼
          Main model (27B) with that skill's instructions + only the chosen tool specs
```

- **Agents become skills.** Same records as today (`agents` table): name, *when to use* (new, one line for the router), instructions, tools, data scope, grounding. Admins still author them. Users see skills only as a small chip on the answer ("بمهارة: التحليل"), which they can change and retry.
- **Override:** `@التحليل` (or the chip) pins a skill for the chat. That brings back the "agents in @" that commit 30807c3 removed, but as an override, not a requirement.
- **Tool retrieval:** the router names the tools, so the 27B model sees ≤6 tool specs instead of all of them. That means a shorter prompt, fewer wrong picks (fixes conflict #3), and room to grow past the 15-tool cap.
- **Measuring it:** extend `eval/golden.json` with about 100 routing cases (question → expected skill and tools), run them in CI with the fake model, and record real routing accuracy on the local models in `eval/`.

**[decide]** Keep the picker visible as "advanced", or only the chip and `@skill`? My recommendation: chip plus `@skill`; remove the picker from the composer.

### D. The tool loop: dynamic, budgeted, visible

Today's loop is `runTurn`: retrieve → up to `maxSteps` (≤8) generate/tool rounds → answer; write tools become proposals. Next:

1. **Risk tiers instead of `requiresConfirmation`:**

   | tier | examples | rule |
   |---|---|---|
   | 0 read | search, read_file, query_records, read-only `run_analysis` (no `/output` files) | runs immediately |
   | 1 create-private | create/update an output or export a file **in my personal space** | runs, and «تراجع» undoes it (a new version / delete) |
   | 2 change-shared | write to a shared space, create or assign tasks | card with «نفّذ» (today's flow) |
   | 3 sensitive / official | sensitive spaces, `fill_template`, anything leaving a space | «نفّذ» + manager rules (unchanged) |

   The tier is computed by code at call time from the tool and its target space, never claimed by the model. Scheduled and agent-assigned tasks run tiers 0–1 alone and queue tier 2–3 for approval.
2. **Budget per turn:** steps (≤8), main-model tokens, wall time (e.g. 120 s), sandbox runs (≤3). When the budget runs out, the agent answers with what it has and says what's left.
3. **Parallel reads:** independent tier-0 calls in one step run concurrently.
4. **Errors as data:**
   - every tool failure goes back to the model as a short structured error (`{error, hint}`);
   - one retry per kind;
   - the cut-off-call retry from today generalises;
   - the user sees a plain line, never server JSON.
5. **Results:** big tool outputs (sandbox stdout, long files) are stored as an output and passed to the model as a summary plus a reference. Model-facing text never reaches the UI (fixes conflict #4).
6. **Step timeline in the UI:** a collapsible list above the answer:
   - "يقرأ employees.csv ✓";
   - "يشغّل التحليل… 8 ث";
   - "يكتب الإجابة".
7. **Later — sandbox session:** keep one container for the whole turn, so multi-step analysis doesn't reload data each call. The runner gains `/session/open|run|close`; it stays network-less.

### E. Context window

- **Measure:** use llama.cpp `/tokenize` (or a local tokenizer) to count each part. Log the parts per turn into `messageMeta.usage`.
- **Budget** (per request, about 48k of the ~65k per slot):

  | part | share |
  |---|---|
  | system + skill | 4k |
  | summary of older messages | 3k |
  | recent history | 10–16k |
  | retrieved passages | 8–12k |
  | tool results | 8–12k |
  | answer | 6k (`LLM_ANSWER_MAX_TOKENS`) |

  When a part overflows, it is trimmed by its own rule:
  - history: compact older messages into the summary (already built);
  - passages: drop the lowest-ranked;
  - tool results: summarise and reference.
- **Show it:** a thin context meter in the chat header, plus «لخّص المحادثة وابدأ صفحة جديدة» when it's above 80%.
- **Slots:** decide `-np 4` vs `-np 2` (more context per request, fewer concurrent users) from real load. **[decide]** after measuring.

### F. Spaces as groups

- **Shared space chats:** a space chat can be «مشتركة مع المساحة». Members then see it, can add messages, and @mention people. Private stays the default; sharing is per chat, explicit and audited. Sensitive spaces follow their manager rules.
- **Activity feed** on the space home: new files, outputs, task changes, shared chats, scheduled-run results, each with who did it.
- **People:** presence is out of scope. Space roles (manager / member / reader) already exist and are enough.

**[decide]** Can members of the «everyone» space share chats there, or only in named shared spaces?

### G. Tasks and autonomous tasks: one model

```
Task { space, title, body, assignee: person | agent(skill), status, due, priority,
       recurrence?: cron,        ← replaces "scheduled tasks"
       autonomy: tier ≤ 1 | ask for each change,
       thread }                  ← the work happens in the task's thread
```

- **Views:**
  - «لي»: assigned to me, plus «بانتظار موافقتي» (tier 2–3 approvals from agent tasks);
  - board per space (kanban, drag to change status, using the existing transitions);
  - «للوكيل»: agent tasks with their last run, next run and status.
- **Agent tasks:** pick a skill as assignee (or "auto"). Each run posts its result as a task comment, attaches outputs, and moves the status to `review` for a human. Recurring tasks keep a run history (today's schedule runs, moved under the task).
- **Notifications:** one inbox for mentions, approvals and assigned work.

## 4. Order

| Phase | Contents | Why first |
|---|---|---|
| 1 | §A tokens + `src/ui` kit + migrate screens · §B full-height output panel · fix #4 and #8 | Everything after it builds on these; cheap; visible right away |
| 2 | §C router + skills + tool retrieval · §D tiers + budget + step timeline | Removes the agent picker; fixes the overlap and the confirmation friction |
| 3 | §E token budget + meter | Needs D's results-as-references; stops silent overflow |
| 4 | §G unified tasks + agent assignee + approvals inbox · §F shared chats + activity | Needs C (skills as assignees) and D (tiers for autonomy) |
| 5 | House-style outputs + presentation mode · sandbox sessions | Polish on top of a stable core |

Each phase ends with: tests (the permission matrix extended for every new public function), screenshots for desktop/tablet/phone in `docs/ux/`, and `UX.md` updated in the same commit.

## 5. Questions to settle before phase 1–2

1. Blue accent app-wide, or outputs only? (§A)
2. Remove the agent picker (chip + `@skill` only)? (§C)
3. Tier 1 (create in my personal space) runs without «نفّذ», with undo? (§D)
4. Shared chats: opt-in per chat in shared spaces; allowed in «everyone»? (§F)
5. Can an agent be the assignee of a task in a **sensitive** space? (§G) My recommendation: yes, but every change is tier 3.
