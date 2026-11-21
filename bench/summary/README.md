# Long-chat summary bench (plans/15)

Three long chats (a project, hiring, finance), 24 turns each. Planted early on:
- numbers, names and dates;
- a decision, and a budget that changes later;
- an output (a list, a draft, a Word file);
- an open item.

Everything but the last 8 messages is folded into the summary, in steps of 6, with the app's own prompt and parser (`app/onebase/lib/chatSummary.ts`). The checks then read the final summary: 22 in all.

```bash
cd app && LLM_FAST_BASE_URL=http://127.0.0.1:9931/v1 LLM_FAST_MODEL="AtomicChat/LFM3-1.7B-Uncensored-GGUF:Q6_K" \
  bun ../bench/summary/run.ts
```

## Results (2026-11-21)

| Summarizer | Kept | One fold, p50 |
|---|---|---|
| LFM3-1.7B (the «fast» role, llama.cpp router on 9931), first version | 13/22 | ~5 s |
| + the newest items kept when a section passes 20 (it used to keep the oldest) | 17/22 | ~5 s |
| + **outputs from the records** (`outputLine` / `withCodeOutputs`) | 20/22 | ~5 s |
| + earlier outputs carried forward by code, and the cap (now 4000 characters) drops the oldest facts before outputs and open items | **20/22, steady** (6/8, 7/7, 7/7) | ~5 s |
| Qwen3.8-27B (local main model), for comparison, without the outputs fix | 17/22 (8/8, 2/7, 7/7) | ~28 s |

- **What the small model drops:** the names of outputs. It lists them under `outputs` in only 1 of 3 chats. Code already knows what each action made: every executed action of the folded messages (`proposals`) is added after the fold.
- **Outputs only grow.** A later fold can drop what code added earlier: the hiring chat lost its draft that way. So the previous outputs are added back by code too. And over the cap, the oldest facts go first: the model fills them with chit-chat, while outputs and open items are few.
- **What is still missed:** replacing a fact that changed. The new budget is kept, but the old one stays next to it. One chat also loses one open item. For an exact detail, the assistant reads the old messages with `read_chat`.
- **The bigger model is not steadier:** perfect on two chats, but it collapsed the hiring chat into a few lines, and it is five times slower. The fast role stays the summarizer.
- **Not measured:** gemma-4-E2B on the router stayed «loading» for over 10 minutes, so it has no result.
