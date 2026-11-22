# Brief for the agents that fill the government demo

You are filling one part of a **demo workspace of OneSpace («مساحة»)** that will be shown soon to a
government entity. OneSpace is an Arabic (RTL) workspace with an AI assistant on local models: shared
spaces with permissions, files the assistant reads and cites, chats, tasks with @mentions, lists,
records (tables from Excel), Word templates with {{variables}} → official PDF documents issued in batches
with verification, outputs (documents/tables) exported to Word/PDF/Excel, publishing forms/quizzes/pages,
space instructions and memory, user-made skills ("/name"), scheduled tasks, analysis in a sandbox,
small internal apps, audit log, levels.

## The setup that already exists

- A fresh server at `http://127.0.0.1:8091` (data in `app/onebase_gov_demo`). **Never touch the server on
  :8090** or its data, and never restart/stop servers.
- 11 accounts and 9 shared spaces: see `app/scripts/gov-demo/personas.ts` (keys like `hr`, `legal`,
  `employee`; roles per space). Passwords are in `app/.gov-demo-users.md` — never print them, never
  copy them anywhere else; `login("<key>")` reads them for you.
- Client helpers in `app/scripts/gov-demo/lib.ts`: `login(key)` → `Client` with `q/m/a` (query /
  mutation / action by path such as `"tasks:create"`), `space(name)`, `upload(spaceId, path)`,
  `waitIngest(spaceId)`, `newChat(spaceId?)`, `ask(threadId, text, {mentions, skillId, effort})`
  (waits for the answer; returns text, citations, toolRuns, proposals, skill), `confirm(proposalId)`
  («نفّذ» on a proposal card). Run scripts with `bun` from `app/`.
- The backend's public functions are in `app/onebase/*.ts` (e.g. `tasks.ts`, `lists.ts`, `records.ts`,
  `templates.ts`, `documents.ts`, `publications.ts`, `skills.ts`, `memory.ts`, `schedules.ts`,
  `spaces.ts`, `chat.ts`). **Read a function's `args` before calling it.** The assistant's tools are in
  `app/onebase/tools/`. `app/UX.md` and `plans/*.md` describe the product.
- Answers take ~20–60 s (local models, shared GPU with three other agents doing the same). Run your
  chats **one at a time**, not in parallel.

## What to produce for your spaces

1. **Realistic documents** (fictional agency «الهيئة التجريبية للخدمات الحكومية», invented names and
   numbers, Saudi government style, formal Arabic; never imitate a real entity's branding or real
   people). Put sources and outputs in `app/scripts/gov-demo/content/<slug>/`. 4–7 files per space,
   mixed: Word (.docx), PDF, Excel (.xlsx). Make them substantive (policies with numbered articles,
   tables with 30–200 rows of plausible data, minutes with decisions and owners and dates) so
   questions have real answers. Tools on this machine: `soffice --headless --convert-to docx|pdf
   file.html` (write HTML with `dir="rtl"` and `lang="ar"`), and for Excel write UTF-8 CSV then
   `soffice --headless --infilter="CSV:44,34,76,1" --convert-to xlsx file.csv`. Python has
   `reportlab` but no python-docx/openpyxl (don't pip install). Check a converted file opens (e.g.
   `soffice --convert-to txt` or `unzip -l`).
2. **A domain script** `app/scripts/gov-demo/spaces/<slug>.ts` that sets the space up as its real
   owners would, using the right persona for each action (managers manage, members write, readers
   only read): upload the files, set the space instructions (`spaces:setInstructions`), add space
   memory where it fits, create tasks assigned to people with comments and @mentions, lists with rows,
   records from an Excel file, a Word template + issued documents if your domain has certificates or
   letters, a publication (form/quiz/page) if it fits, a scheduled task if it fits, and a skill that a
   user makes from their own chat (skills are made by users, never preset by the platform). Use what
   genuinely fits the domain; don't force every feature into every space. Keep it re-runnable or
   guard against double-running (e.g. skip if the space already has files).
3. **Real usage as the personas** (this is the heart of it): run 6–10 chats per space that show the
   *best* way to use the system in that domain: questions over the files with citations, drafting a
   formal letter/memo from the files, comparing documents, analysis of an Excel file with a chart,
   turning an answer into an output/list (confirm the proposal), follow-up questions, a question
   from a reader who must NOT be able to write, a person outside a sensitive space who must NOT see
   its files. Leave these chats in the accounts so the presenter can open them live. Record each
   prompt, which account, time taken, and a short verdict on the answer quality.
4. **A presenter's scenario file** `app/scripts/gov-demo/scenarios/<slug>.md` in Arabic: for each
   space, the story (the pain today → what OneSpace does), the 2–3 strongest live moments in order
   with: account to log in as, where to click, the exact prompt to type, what the audience will see,
   and a fallback if the model is slow. Then a short English/Arabic section **"Issues found"**: bugs,
   wrong or weak answers, permission surprises, confusing UI wording, slow steps — with the prompt
   and what happened. Also flag if the assistant ever writes «مقاطع/مقطع» to a user.

## Rules

- **Don't change product code** (`app/onebase/`, `app/src/`, tests). Only add files under
  `app/scripts/gov-demo/` (your slug's files). If something blocks you, work around it through the
  API and report it under "Issues found".
- Don't commit. Don't print or log passwords or tokens.
- Don't contact anything outside localhost.
- Ignore permission errors that are *expected* (that's a good demo moment — record them); report
  unexpected ones.
- Your final message: what you created (spaces → files/tasks/lists/records/templates/publications/
  skills/chats counts), the 3 strongest demo moments, and the issues found, concisely.
