# 18 — Working on the same thing («العمل المشترك»)

## Why

A shared chat (plans/14, plans/16) lets several people and the assistant share a conversation. Working on the same thing at the same time broke in three ways:
- saving an output replaced whatever a colleague had saved since, silently;
- «نفّذ» on a proposal did the same, up to 30 minutes later (24 hours for a scheduled one);
- a chat stopped at its first 500 messages: newer ones weren't shown, and the assistant never got the new question.

## Phases

| Phase | What | State |
|---|---|---|
| 0. Safety | No 500-message wall; no save or «نفّذ» over a version its author didn't see | built |
| 1. Live | People can write while the assistant works; who is here now; the output pinned beside the chat | not built |
| 2. In parallel | One running request per person in a chat, each keeping its agent and scope, stopped on its own | not built |
| 3. One document | Edits by section, merged when the sections differ | not built |

Two rules hold for every phase: the assistant works as whoever called it (never as «the team»), and work passes from one person's assistant to another's only through that person.

## Phase 0

### Long chats
- `lib/threadMessages.ts` reads a thread to its end. Every reader uses it: the screen, the turn's context, the router, retry, handoff, `read_chat`, skill drafts and memory suggestions.
- `chat:messages` returns the newest 500 (`limit` for more) and `earlier`, the count before them. The screen has «عرض رسائل أقدم».
- A summary fold sends a bounded batch (`foldUpTo`), so a long backlog is caught up over several answers.

### Saving
- `artifacts:edit` takes `baseVersion` and refuses when the output has moved on, or when none is given (a page opened before this change).
- The check is in the mutation that writes, after the access check: two saves can't both pass, and who can't write learns nothing.
- The editor keeps the draft, says a newer version exists, and saves over it only after showing it beside the draft and asking once more. A version newer still starts that again. An editor with nothing typed follows the newest version instead.

### «نفّذ»
- A tool that writes a new version of an output declares it (`AppTool.edits`: `update_artifact`, `write_app`).
- Its call is pinned to the version current when the answer began (`proposals.baseVersion`, set by the server, never from the model's arguments). A colleague's edit while the assistant was working counts.
- The card says when it is stale and «نفّذ» is off. The server checks at the claim and again at the write.
- Several edits of one output in one answer follow each other in their order. An earlier one can't land on a later one.
- Edits that run without asking (tier 1) are pinned the same way.
- A proposal made before this change has no version and is refused: ask again.

## Known gaps
- **HTML pages are edited as code.** Documents have the visual editor (plans/19).
- **The assistant doesn't read an output before rewriting it.** There is no tool to read a document's text, so `update_artifact` rewrites from what the chat holds. An edit saved *before* the question can still be lost in that rewrite. It needs a read tool, with the version it read as the base (before or with phase 3).
- **Lists** save by cell with no version check: two people on one cell, or a proposal on a cell changed since, is last write wins. A cell being typed in is reset when a colleague changes it.
- **«تراجع»** of an automatic edit restores the earlier version even if the owner edited since (personal space only; versions are kept).
- **`finishProposal`** queues a follow-up answer without `assertIdle`, so two turns can run in one chat while the screen and «إيقاف» know only the last. Phase 2 has to handle it.

## Tests

`tests/collab-safety.test.ts`.
