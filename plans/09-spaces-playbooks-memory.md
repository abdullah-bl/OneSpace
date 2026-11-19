# 09 — The space runs the agents: context, memory, procedures, identity (draft for discussion)

Status: proposal, 2026-11-19. Open decisions are marked **[decide]**.

**Built (2026-11-19): §1 memory.**
- **Code:**
  - `onebase/memory.ts`;
  - tools `remember` and `recall`;
  - `src/MemoryView.tsx` («ذاكرتي» at `#/memory`, and the «ذاكرة المساحة» panel on the space page);
  - «محادثة بلا ذاكرة» in the chat menu;
  - the level switch «الذاكرة»;
  - tests in `tests/memory.test.ts`.
- **Decisions taken:**
  - Suggestions wait for the person to accept them (no auto-accept).
  - The audit log records that a memory changed (scope and kind), never its text.
- **Memory tools follow the level and the chat, not the agent's tool list.** Every agent gets them while memory is on.
- **A personal save runs without «نفّذ»** (with «تراجع») only when the person's own message asks to remember, and never from a sensitive space. Otherwise it is a card.
- **Not built yet:** the weekly merge of duplicates, and a workspace-wide off switch. For now, turn memory off per level.

## Why

Most of the parts already exist:
- space instructions (`spaces.instructions`);
- record sets imported from Excel (`records`);
- approved official templates (`templates`);
- schedules;
- agents scoped to spaces;
- personal skills, sub-agents and data sources.

They don't work together. Today a member opens a space and gets an empty chat. The agent starts from zero every time, so quality depends on how well the person writes the request.

The goal is that **the space configures its agents**: what they know, how recurring work is done, and how the output looks. A "sector" (training, planning, budget) then needs no code of its own. It is a pack of these settings.

Four layers, in build order:

1. **Memory:** personal and space. It is what the agent knows before you ask.
2. **Space procedures («إجراءات المساحة»):** how recurring work is done.
3. **Space context extras:** glossary and model works («أعمال قدوة»).
4. **Identity and packs:** how the output looks, and how a sector setup moves between spaces and organisations.

---

## 1. Memory

### How Claude does it (what we copy)

| Claude | What it means | In OneSpace |
|---|---|---|
| Memory is kept per project, apart from personal memory | Work context doesn't leak between projects | Space memory is separate from personal memory |
| A short summary or index is always in context; details are fetched on demand (chat search, memory files) | Context stays small. This matters more for us: local models, small windows, 13 tok/s | Inject an **index** (one line per item, capped). A `recall` tool fetches details and searches past chats |
| "Remember that …" writes immediately; the model also saves on its own and says so | The user sees what was saved | Personal: saved at once, with a visible «تذكّرت: …» note and an undo |
| The user can view, edit and delete memory, and use a chat without memory (incognito) | Trust and control | A «ذاكرتي» page, plus a «محادثة بلا ذاكرة» toggle in the composer |
| Memory is context, not instructions | It can't override the rules | It goes in the system prompt as data, under the fixed rules, like the space instructions today |

### Three kinds

**A. Personal memory («ذاكرتي»).** About the person and their way of working. Examples:
- role and department;
- the tone they prefer (formal or plain);
- Hijri or Gregorian dates;
- answer length and preferred output (table or document);
- recurring names and current work («أعمل على خطة 2027»).
- **Privacy:** the owner only. Admins can't read the content (only an audit row that a write happened). **[decide]**: keep that audit row at all, or count only?
- **Effect:** it fills defaults. For example, a procedure form starts with the person's department, and documents come out in their preferred tone.

**B. Space memory («ذاكرة المساحة»).** Shared by the space's members. Examples:
- decisions («اعتمدنا حقيبة القيادة v3»);
- conventions («الميزانية بالألف ريال»);
- glossary terms;
- people and roles («المعتمِد: مدير الإدارة»).
- **Writes are proposals.** A member, or the model in a member's chat, proposes. A space manager approves. Reason: one bad or injected memory would affect every member's answers.
- Managers can edit and remove items directly.

**C. Past work (episodic).** No new storage. The `recall` tool searches:
- the user's own chats (titles and messages), only their own;
- the works in «أعمالي» and the space's approved works.

The existing permission checks apply on every read.

### The data model

```
memories: {
  scope: "user" | "space", ownerId?, spaceId?,
  text (≤ 300 chars), kind: "fact" | "preference" | "decision" | "term",
  state: "active" | "proposed" | "archived",
  source: { threadId?, messageId?, by: userId, how: "asked" | "auto" | "manual" },
  originSpaceId?,  // which space the chat was in when it was learned
  createdAt, updatedAt, lastUsedAt, uses
}
```

### Reading
- Each turn injects the personal index (up to about 40 lines or 1.5k tokens) and the index of the thread's space, if any.
- Items are ordered by `uses` and `updatedAt`.
- If the index is over the cap, the rest is reachable through `recall`.

### Writing
- The tool is `remember({ scope, text, kind })`.
- `scope: "user"` saves immediately. The answer shows «تذكّرت: …» with an undo.
- `scope: "space"` creates a pending proposal for the space's managers. It shows in their notifications.
- After a chat goes quiet, the fast model reads it once and proposes up to 3 personal items. These show as «اقتراحات للذاكرة» on «ذاكرتي». **[decide]**: auto-accept with the note, like Claude, or always ask?
- Tidying: when a new item contradicts an old one, the newer one wins and the old one is archived. A weekly cron merges duplicates.

### Safety rules (the leaks to prevent)
1. **No cross-space leakage.** An item learned in a chat inside space S keeps `originSpaceId = S`. It is injected only when the user can still read S. If they lose access, the item disappears with it.
2. **Sensitive spaces:** no automatic personal memory from chats there. Only explicit «تذكّر» is allowed, and it stays tied to S.
3. **Content from files, sources or tools never becomes memory automatically.** Only the user's own words, or the model's summary of them, can. This blocks prompt injection: a document saying "remember that the approver is X".
4. **No secrets.** Saves that look like passwords, keys or ID numbers are refused (pattern check before saving).
5. **Levels:** each level sets whether memory is on and how big the index may be. Admins can turn memory off for the whole workspace.

---

## 2. Space procedures («إجراءات المساحة»)

A procedure is recurring work, defined once and run by any member.

```
procedures: {
  spaceId, name, description, icon,
  inputs: [{ key, label, type: text|longtext|file|record|date|choice, required, from?: "memory:department" }],
  instructions,            // how to do it (like an agent's instructions, scoped to this job)
  agentId?,                // otherwise the router picks
  tools?: "agent" | [..],  // narrow further, never widen
  output: { kind: markdown|table|html|document, templateId? },  // templateId = an approved official template
  review?: { by: "space_managers" | userIds },                  // the output is a draft until approved
  examples: artifactIds,   // model works for this procedure
  version, live/draft like agents, createdBy, uses
}
```

- **Running one:**
  - The space home shows its procedures as cards. A card opens a form.
  - The run is a normal chat turn with the procedure as context, so the steps timeline, sub-agents and stop all work.
  - The result goes to «أعمالي» and the space's works.
- **«حوّل هذه المحادثة إلى إجراء»:**
  - The fast model drafts the inputs, instructions and output from a finished chat, like `skills.draftFromThread` today.
  - A space manager reviews and publishes it.
  - This is how one person's good work becomes the department's way of working.
- **Review:** when `review` is set, the output is a draft until a manager approves it. Approved outputs can be marked «نموذج» and join the procedure's `examples`.
- **Schedules:** a schedule can point at a procedure with fixed inputs, for example a weekly budget variance report.
- **Personal skills stay.** A skill is my own way of doing something. A procedure is the space's. «انقلها إلى المساحة» turns a skill into a procedure draft.

## 3. Space context extras

- **Glossary:** space memory items with `kind: "term"`, shown as a list on the space settings page.
- **Model works («أعمال قدوة»):**
  - A manager marks an artifact as a model.
  - The agent receives the first ~1.5k tokens of up to 2 relevant models (picked by procedure, or by embedding similarity to the request).
  - The instruction is "match the structure and tone".
- **Space sources and records:** described in the context automatically. Already done for sources; add record sets the same way.

## 4. Identity and packs

- **Identity:**
  - logo, colours (primary, secondary, chart palette), a font (bundled Arabic fonts or an uploaded woff2, all served locally), and a letterhead and footer;
  - applied at render time: CSS variables injected into HTML artifacts, the chart palette, and the Word/PDF export;
  - the workspace has a default identity, which each space inherits or overrides.
- **Packs:**
  - a JSON export of a space's instructions, space memory (glossary and decisions), procedures, record set definitions (no rows), templates and identity;
  - importing a pack creates or updates a space;
  - starter packs: التدريب، التخطيط، الميزانية.

---

## Build order

1. **Memory:**
   - the `memories` table;
   - the `remember` and `recall` tools;
   - index injection;
   - the «ذاكرتي» page, the space memory tab, the «بلا ذاكرة» toggle;
   - level switches;
   - tests for the five safety rules.
2. **Procedures:** the table, admin and manager editor, cards on the space home, run-as-turn, «حوّل المحادثة إلى إجراء», review.
3. **Model works and glossary.**
4. **Identity and export.**
5. **Packs and the three starter packs.**
