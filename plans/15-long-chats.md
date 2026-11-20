# 15 — Long chats («المحادثات الطويلة»)

## What exists

`chat.ts` already keeps a rolling summary:

- **Verbatim window:** each turn sends the last 24 messages word for word (`HISTORY_KEEP`; up to 40 while the summary catches up).
- **Summary:** once 4 more messages leave that window, the fast model folds them into one summary of up to 1200 characters (`compactThread`), saved on `threadMeta.summary`.
- **Prompt:** the summary goes into the system message as context, not instructions.

So summarising starts after about 12 questions and answers.

## What's wrong with it

1. **It counts messages, not size.** Twenty-four messages can be 24 lines or 24 pasted documents and long tables. On a hosted model that is cost on every turn; on a local one it is latency and a full context. Short chats, meanwhile, fold early for no reason.
2. **One flat summary of 1200 characters, from the 1.7B fast model.** In a long chat the numbers, names and decisions the user cares about are the first thing lost, and nothing says so.
3. **Nobody can see it.** The user doesn't know that part of the chat is now a summary, what it says, or that it is wrong.
4. **What was folded is gone for the model.** If the summary lacks a detail («كم كان الرقم اللي قلته أول المحادثة؟»), the model can't look it up even though the messages are still in the thread.

## What

### 1. A size budget instead of a count

- **What stays verbatim:** the newest messages, up to a budget, about 12k tokens by default, approximated from characters. That is at least the last 4 messages, at most the last 40.
  - The budget is `CHAT_HISTORY_TOKENS` on the server.
  - It is lowered automatically when the role's model reports a smaller context (`context_length` from «افحص», `modelInfo`).
- **One very long message** (a pasted document) is cut to its start in the history, with a note: «رسالة طويلة؛ نصها الكامل في المحادثة، اطلبه بأداة read_chat». The thread keeps it whole.
- **Folding:** whatever leaves the window is folded into the summary, as now, in steps rather than every turn.

### 2. A structured summary

The fold returns sections instead of one blob:

```json
{
  "topics": "ما دارت عليه المحادثة",
  "facts": ["الأسماء والأرقام والتواريخ كما وردت"],
  "decisions": ["ما تقرر أو اعتُمد"],
  "open": ["ما بقي مفتوحاً أو وعد به المساعد"],
  "outputs": ["المخرجات والقوائم والتطبيقات المذكورة بأسمائها"]
}
```

- **Cap:** about 3000 characters in all. Facts and decisions are kept before topics when space runs out.
- **Model:** the fast model, as today. The bench gets a long-chat set: a planted fact early on, asked about 30 messages later. That shows whether the fast model is enough or the summary needs the main one. If it does, it becomes a choice on «المزوّدون», not a hard-coded switch.
- **Merging:** the previous summary is merged, never just appended. A fact that changed («الميزانية صارت 40 ألف بدل 30») replaces the old one.

### 3. Shown in the chat

- **Divider:** where the summary starts, the chat shows a thin line: «ما قبل هنا يصل للمساعد ملخصاً · اعرض الملخص».
- **Viewing:** opening it shows the sections as the model sees them.
- **Editing:** whoever can write in the chat can fix or delete a line. An edited summary is marked as edited, and the next fold keeps the user's lines.
- **Shared chats:** the same; the summary is part of the chat, visible to its readers.

### 4. A general tool to look back: `read_chat`

- **What it does:** searches this chat's own older messages by words or by position («أول المحادثة») and returns the matching ones verbatim.
- **Access:** read-only, tier 1, this thread only. It needs no permission beyond reading the chat, which the user already has.
- **When:** the prompt tells the model to use it when the summary lacks a detail, instead of guessing.

Like the other personal tools, it serves any domain.

## Not doing

- **Summarising the files and outputs themselves:** they are already retrieved and linked by id.
- **Cross-chat memory:** that is `remember`/`recall` (plans/09).

## Done when

- The bench's long-chat set:
  - early facts are answered right after 30+ messages;
  - the prompt stays under the budget;
  - the number of model calls per turn doesn't grow.
- Tests:
  - the budget, including one huge message;
  - the merge, where a changed fact replaces the old one;
  - editing, where the user's lines survive the next fold;
  - `read_chat` scope, so it can't read another thread;
  - shared-chat readers.
- **Live check:** a real chat past the budget on 8090. The divider appears, the summary reads right, and a question about an early number is answered from the summary or with `read_chat`.
