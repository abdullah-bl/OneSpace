# 09 — The space runs the agents: instructions, memory, skills, identity

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

**Revised (2026-11-19): Claude Code's model, applied to a space.** We don't build tools per sector. People build them from their own work: they do a job with the agent, and a job that went well is saved as a **skill** the agent reuses. A space then has only three things to set up:

| Claude Code | In a space |
|---|---|
| `CLAUDE.md` | the space's instructions and memory (§1) |
| Skills (SKILL.md, scripts), picked by their description | the space's skills (§2): instructions, plus the script and the example output kept from the chat |
| `/name` | `/name` in the chat, or a card on the space page |
| a design system | the space's identity (§3) |

Agents and tools stay underneath: the person never has to pick them. A "sector" (training, ranking, budget) is a pack of these three (§4). It needs no code of its own, and the platform has no sector-specific screens: the old «المفاضلة» page and its engine were removed (2026-11-19); a ranking is now a skill the team builds in a chat.

"Procedures" (an earlier draft of §2) are dropped as a separate idea: a space skill is the procedure.

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

## 2. Space skills («مهارات المساحة»)

A space skill is a personal skill (`skills`, plans/07) that belongs to a shared space: instructions any member can run, approved by a manager.

### How one is made
1. A member does the job in a chat with the ordinary tools and the skills already saved. Example: «سوّ مفاضلة بين الطلبة في هذا الملف: المعدل 40، المقابلة 60», then corrects along the way («التعادل بالأقدمية»). Or a course outline, refined until it looks right.
2. When a multi-step job is done and likely to recur, the assistant offers «أحفظ هذه الطريقة كمهارة للمساحة؟». It can also be asked directly, or a member can share one of «مهاراتي» with the space.
3. It is saved as **proposed**. A space manager approves it (it becomes active) or rejects it. A manager's own save is active at once.
4. Managers edit and delete active skills. Each edit bumps `version`.

### How one is used
- **Index:** every chat in the space gets one line per active skill (`/name: description`), capped like the memory index, plus the person's own skills. The model loads the full instructions with the `use_skill` tool when a request matches. Same pattern as Claude's skills: the description decides.
- **`/name`:** the composer lists the space's skills next to «مهاراتي».
- **Rules:** a skill is instructions only. It never grants a tool, a space or a file: what the answer may touch is still the agent's scope ∩ what the person can read. Proposed skills are never shown to the model.

### What a skill carries (built)
Saved from a chat (`create_skill`, or «اصنع مهارة من المحادثة»), a skill keeps, next to its instructions:
- **`script.py`:** the Python that ran successfully in that chat (the last run, or the runs the model names). File names in it become `INPUTS[i]`. Next time the model calls `run_analysis` with `skill` + `script` and the new `fileIds`: the saved code runs unchanged, with `INPUTS` set to the new files in order. So a number that affects people (a ranking, a budget split) comes from the same code every time, not from the model. The run records the skill, its version and the script (`runs.skill`).
- **`example.<md|html>`:** the last output the assistant wrote itself (not a run's data table). Its structure, headings and formatting are kept the next time; the content is new.
- **Rules:**
  - Anything built on a sensitive space is kept only in a skill of that same space.
  - Secrets are masked.
  - The editor can drop a file, and each edit of an active space skill bumps its version.
  - Sharing a personal skill with the space copies its files.

## 3. Identity

- **What:** a logo, two or three colours, a font (bundled Arabic fonts, or an uploaded woff2 served locally), a letterhead and a footer.
- **Set up by chat:** the manager uploads the logo and says «هذه هويتنا». The assistant pulls the colours from the logo and shows a preview; the manager approves.
- **Inheritance:** the workspace identity is the default, a space inherits or overrides it, and the personal space uses the person's own.
- **Applied at render time, never by the skill:** CSS variables in HTML outputs, the chart palette, and the Word/PDF export (font, letterhead, footer). A skill needs to know nothing about it.

## 4. Packs

- A JSON export of a space's instructions, space memory, skills (with their scripts) and identity.
- Importing a pack creates or updates a space. Starter packs: التدريب، المفاضلة، الميزانية.

---

## Build order

1. **Memory.** Done (§1).
2. **Space skills (§2):** proposed or active skills in a shared space, manager approval, the index and `use_skill`, `/name` in the composer, «شارك مع المساحة», and the assistant's offer to save.
3. **What a skill carries:** the script and example output kept from the chat, rerun with `run_analysis` (skill + script). The «المفاضلة» page is removed. Done.
4. **Identity (§3).**
5. **Packs (§4).**
