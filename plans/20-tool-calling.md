# 20 — Tool calling: a few general tools over one workspace tree

## Why

- **25 tools, most for one feature:** `write_app`, `create_list`, `query_records`, `fill_template`, `create_skill`… A full request is ~8.8K tokens, and roughly 7K of that is tool definitions (30K characters).
- **Every feature adds a tool, and its own way of changing things.** Apps resend whole files, outputs resend the whole content, lists have add/update/remove, memory saves one sentence.
- **Tools with a similar purpose get confused.** An Excel analysis goes to `my_records` or `propose_record_set`; a question for the external system goes to `query_records` (bench/realtools).
- **Everything is addressed by a 20-character id** the model has to copy exactly. Row ids in lists are the same.

## What the bench says, and what this plan can claim

The numbers are from [bench/realtools](../bench/realtools/README.md), first call only, 39 cases.

| | Fully right | Didn't call when it should |
|---|---|---|
| LFM3-1.7B, all 25 tools | 56% | 25% |
| gemma-4-E2B, all 25 tools | 75% | 22% |
| Muse-Glimmer-30B, all 25 tools | 87% | 0% |
| Muse-Glimmer-30B, only the 5 right tools | 95% | 0% |

- **Fewer tools helped the 30B (+8 points) and did not help the small models.** With 5 tools LFM3 called less often, not more (43% no-call). Their weakness is deciding to call at all.
- **Shorter descriptions cost 1–9 points** on every model. The description is what tells tools apart.
- **So the claims are:**
  1. the main model gets a choice it makes well (+8 points with fewer tools);
  2. wrong-tool and wrong-id failures go away, because there is one way to do each thing and no ids;
  3. a new feature adds a kind of path, not a tool.
- **Size is not a reason.** The models' windows are about 256K (262,144 measured on the main model, [bench/REPORT.md](../bench/REPORT.md)), so 8.8K fits with room to spare. The tools are also the same text on every request, which the server keeps cached. And the 5-tool requests were not faster on the 30B (36 s against 27 s). Fewer tokens is a side effect here, not a goal.
- **Not claimed:** that small models will call more often. The familiar names (`read`, `write`, `edit`) may help; the bench decides. The README already says a 1.7B model should not get the calling role.
- **One cost the current bench can't see.** One special call becomes several general ones (an app is 4–6 writes, not one `write_app`). More steps are more chances to fail, so step 1 measures finished tasks, not first calls.

## The idea: the same shape as Claude Code

Claude Code works with a few general tools over a file tree, and models are trained on a great deal of exactly that. It has no tool for any one kind of work. OneSpace takes the same shape:

| Claude Code | OneSpace | |
|---|---|---|
| Read, Write, Edit on files | `read`, `write`, `edit` on paths | the same rules: read before changing, an edit's text must appear once |
| Glob, Grep | `ls`, `search` | `search` is by meaning, because the files are Arabic PDFs and Word files, not code |
| Bash | `run` | a Python sandbox and the app test browser, not a shell |
| The Skill tool, and a list of skills (name and one line each) in the context | `skill`, and the same list | today's `use_skill`, which already works this way |
| A skill is a folder: `SKILL.md`, reference files, scripts | the same | scripts start with `run` |
| Skills for Word, PowerPoint, PDF | the export skill | instructions and a renderer script |
| A tool of its own only for what leaves the machine and needs its own permission (publishing a page) | `share`, `query`, and the two approval tools | |
| The user allows an action before it runs | «نفّذ» and «تراجع» | decided by where the result lands |

OneSpace becomes a tree:

```
/me/
  memory.md                 remember / recall
  tasks.md                  read_tasks (read only)
  records.md                my_records (read only)
  skills/<name>/SKILL.md    create_skill / use_skill, with the skill's scripts beside it
  chats/<title>.md          earlier chats (read only; search finds them)
/spaces/<space>/
  files/<name>.pdf          uploaded files (read only)
  lists/<name>.table        a live list
  outputs/<name>.md | .html | .slides.md | .csv
  apps/<name>/index.html, app.js, data/…, server/*.py, app.json, test.json
  records/<set>.table       record sets (read; query for filters)
  templates/<name>          approved templates (read only; fill_template uses one)
  skills/<name>/SKILL.md    the space's skills
  memory.md                 the space's memory
/chat/this.md               this chat word for word (read_chat)
/skills/<name>/SKILL.md     the platform's own skills: apps, export, slides (read only)
/sources/<source>           external sources (query)
```

A path without a leading `/` is under this chat's space: `lists/حضور الدورة.table`.

## The tools

| Tool | Does | Replaces |
|---|---|---|
| `ls(path)` | names, kind, size, updated | the context lists; part of `read_app` |
| `read(path, lines?, pages?)` | the content, with line numbers | `read_file`, `read_list`, `read_app`, `read_tasks`, `my_records`, `read_chat` |
| `search(query, path?)` | meaning-based search under a path; each result carries its path | `search_documents`, `recall` |
| `write(path, content, append?)` | creates or replaces; `append` adds lines to the end | `create_artifact`, `update_artifact`, `create_list`, `write_app`, `create_skill`, `remember` |
| `edit(path, find, replace, all?)` | changes one exact piece of text, which must appear once (`all`: every place) | partial changes to all of the above; `update_list` |
| `run(path \| code, inputs?)` | a `.py` runs in the sandbox with `inputs` in `/input`; an app runs its `test.json` in the test browser | `run_analysis`, `test_app`, `export_document` (through the export skill) |
| `skill(name)` | loads a skill's instructions; its other files are `read`, its scripts are `run` | `use_skill` |
| `share(path?, to, message?)` | `to` an audience (space / workspace / public) publishes; `to` people sends, with a message | `publish_output`, `notify_colleague` |
| `query(source, …)` | SQL or an API call on an external source; filters on a record set | `query_source`, `query_records` |

**9 tools for every agent, and none of them is for apps, lists, outputs or memory.**

- **`fill_template` and `propose_record_set` stay named tools,** only on the agents that have them, as today. Each ends in its own approval, and an official document comes from code and a fixed template (principle 4). That is the one case where Claude also keeps a named tool.
- **`skill` stays a tool, not a `read` of a path.** Claude loads skills this way, and it is the part of today's set that already works: gemma and the 30B loaded the matching skill in every run of the two skill cases.
- **`append` is the one thing Claude doesn't have.** «أضف منى للقائمة» and «تذكّر أني أفضّل الهجري» add a line. Without it the model reads the whole list first, or resends it and can drop what it didn't repeat. Claude has a shell for this; OneSpace has none.
- **Nothing deletes a whole item.** Rows and memory lines can be removed; a list, output or app is deleted by the user from the screen, as today.

## Tool or skill

| It is… | It goes to… | Examples |
|---|---|---|
| **Knowledge:** how to do something well | a skill, loaded with `skill` when the request matches | how to build an app here, how a slide deck is laid out |
| **A script that needs no special rights** | a file in a skill, started with `run` | rendering Word / PDF / PowerPoint from Markdown |
| **An effect outside the sandbox, or a guarantee** | a tool, in server code | publishing, sending to a colleague, an external query, filling an approved template, proposing a record set |

- **A skill grants nothing** (as today: «لا تمنح أي صلاحية»). It can't publish, send, or promise that an official document matches its template.
- **An app needs no tool.** Its files are `write`, `edit` and `read`. Its test is `run`, with the steps saved in `test.json` so the same test runs again after each fix. Its list grants are `app.json`, checked on write and shown on the publish card. How to write one is the `apps` skill.
- **Export is a skill.** The renderer is already a sandbox script. The `export` skill holds it, and «صدّره PDF» is `skill("export")`, then `run("/skills/export/render.py", inputs: ["outputs/تقرير الحضور.md"])`. The file lands beside the output.
- **The platform's skills are only about its own tools** (apps, export, slides). Skills about someone's work are made by users, not shipped.

## Rules that hold for every kind

- **The kind comes from the path** (folder and extension), never from a `kind` field.
- **Read before changing.** `edit` and a replacing `write` need a `read` of that path in this chat, and are refused if it changed since: «تغيّر منذ قراءته؛ اقرأه من جديد». This is plans/18's version pin, now for lists and apps too. `append` and creating don't need it.
- **Removing asks.** A change that removes list rows or memory lines shows a card with what goes, in `/me` as well.
- **A cut-off call is refused.** If the model's output hit the length limit, nothing is written.
- **Every failure says what to do next:** not found (with what is there), found twice, read-only, wrong value («الموعد: التاريخ بصيغة YYYY-MM-DD»), changed since read.

## Paths

- **Names, as the user sees them.** Two items with the same name get ` (2)`. A `/` in a name is shown as `-`.
- **Resolved in this order:** exact; then normalised (hamza forms, ة/ه, ى/ي, diacritics, spaces, a missing extension); then the one name in that folder within a small edit distance. Otherwise «لا يوجد. الموجود في lists/: …». `repairIds` stays for ids still shown.
- **A card pins the id, not the path.** The path is resolved when the card is proposed, and «نفّذ» runs on that id. A rename in between can't point it at something else.
- **Rows get short ids** (`r12`), numbered per list and never reused. This is one new field on rows.
- **What isn't allowed isn't there.** `access.ts` resolves every path. Outside the turn's scope (spaces, chosen files), in a shared chat (`/me` and `/me/chats`), or with memory off (`memory.md`), the path doesn't exist, and the answer is the same as for a wrong name.
- **The context shows a short tree,** which replaces «ملفات المساحة بمعرّفاتها», «القوائم الحية هنا», «المخرجات هنا» and «المهارات المتاحة»:

```
/spaces/التدريب/   (هذه المحادثة)
  files/    خطة 2026.pdf · الموظفون.xlsx · … و37 غيرها
  lists/    متابعة الدورات.table (12 صفاً)
  outputs/  تقرير الحضور الشهري.md (النسخة 3)
/me/skills/  monthly-attendance · formal-letter
/skills/     apps · export · slides
```

Only this chat's space is listed in full, up to 40 names a folder. Other spaces are one line each.

## How each kind maps

| Kind | `read` gives | `write` / `edit` do | Notes |
|---|---|---|---|
| Uploaded file | the text, `pages=…`, with citations as today | refused: «الملفات المرفوعة للقراءة فقط؛ اكتب في outputs/» | |
| List | a table: a header line with types, then `\| r12 \| … \|` | `append` adds rows (empty id cell); `edit` changes or deletes a row's line; `write` creates | below |
| Output | the Markdown, HTML, slides or CSV | a new version | sources are what the turn read; no `sources` argument |
| App | one file; `ls` gives the files and the version | all writes to one app in one answer are one version | `app.json` holds the list grants (today's `data`); `test.json` holds the test steps |
| Skill | a file beside `SKILL.md` (`skill` loads the instructions) | creates or changes it; a script is a file, so `run` takes its path | the platform's skills are read-only |
| Record set | a table; `query` for filters | refused; `propose_record_set` makes one | |
| Template | its fields | refused; `fill_template` fills one | |
| Memory | one fact a line | `append` saves; `edit` corrects | as today: my own memory saves at once only when my message asked for it, and a member's line in a space's memory is proposed to its managers |
| Tasks, my records, chats | text | refused | |

**Lists in detail** (the riskiest mapping):
- **Header:** `| id | الاسم:text | الموعد:date | الحالة:status(لم تبدأ,منجزة) |`. It can't be changed after creation, as today.
- **Rows are matched by id only,** never by position.
- **A line that comes back exactly as `read` gave it is not touched.** Reading is lossy (`|` becomes `/`, a line break becomes a space, a person is a name, a tick is ✓), so only changed lines are parsed. Same promise as the editor's in plans/19.
- **A person cell** must match one member. Otherwise the error lists who matches.
- **Long lists:** `read` gives 500 rows at a time (`lines`). `edit` works on any row, read or not, because the id is in the line.
- **Checks are `update_list`'s own** (`cleanCell`): numbers, dates as YYYY-MM-DD, and a new status value is added to the column's options, as today. The diff ends in the same `updateFromTool` call.

## What doesn't change

- **Permissions:** every tool still checks the user in code. The model can't reach what the user can't.
- **Tiers, decided by where the result lands:** my own space runs at once with «تراجع»; a shared space waits for «نفّذ»; a sensitive space or an official document waits and is marked. Data read from a sensitive space still stays in it.
- **Behind the tools, the existing code.** `append` to a `.table` calls `updateFromTool`; `run` on an app calls the same browser test.
- **Audit:** the operation and the id (`list.update`, `app.write`…), as now, plus the path the model used.
- **Citations:** `read` and `search` on files return numbered sources as today.

## What has to change besides the tools

One table in `lib/paths.ts` carries most of it: **path pattern → kind → operation → existing function.** Tiers, audit, undo and agent limits all read the operation from it.

- **`tiers.ts`** switches on tool names. It switches on the operation.
- **Agent limits.** `allowedTools` holds old names. A custom agent becomes verbs × kinds, derived from its old list by the «Replaces» column: `search_documents, read_file, create_artifact` → read files, write outputs. `PERSONAL_TOOLS` and `MEMORY_TOOLS` become kinds that are always on, or on with memory.
- **`announcedTool`** looks for a tool's name in the answer and forces a call. `read`, `run` and `write` are ordinary words (`f.read()` in a code sample), so it matches only a name followed by `(` or a path.
- **The system prompt and the context builders** name old tools (`chat.ts`, `lists.ts`, `artifacts.ts`, `skills.ts`). They get a second version for the new set.
- **Users' saved skills** name old tools in their instructions. The old names keep resolving for those agents until the skills are rewritten.
- **`maxSteps` is 10.** An app from nothing is about 11 calls (load the skill, 4–5 files, `app.json`, `test.json`, `run`, fix, `run`, `share`). The limit is set from the bench's step counts.
- **Guides become skills.** `APP_GUIDE` is 3.6K characters inside `write_app`'s description. It moves to the `apps` skill and reaches the model three ways: it loads it with `skill`; the first result under `apps/` in a chat carries it; and a refused write quotes the rule it broke. Tool descriptions keep the two sentences that tell them apart.
- **`test_app`'s steps** become `test.json` in the app. **`export_document`'s renderer** becomes the export skill's script.

## Risks

- **More steps.** The main cost, measured in step 1 by finished tasks, steps and total tokens per task.
- **A skill not loaded.** Moving knowledge to skills only works if the model loads them. In today's bench gemma and the 30B loaded the matching skill in every run of the two skill cases; LFM3 did in 1 of 6. That is two cases, so step 1 adds more. The code checks stay as they are, and a refused write quotes the rule.
- **Export takes two calls instead of one** (load the skill, run its script). `export_document` is right every time today on gemma and the 30B. If the skill measures worse, export stays a tool.
- **List edits through text.** Covered by id-only matching, untouched lines, the removal card and the cut-off check. If the bench still shows damaged rows, lists keep `update_list` and only the rest moves.
- **Names are less exact than ids.** Normalising and the pinned id cover it. A fuzzy match is only ever to one candidate in one folder.
- **Two tool sets for a while.** An agent has one set or the other, never both: 25 + 8 would be worse than either.

## Steps

1. **Prove it in the bench, without changing the app.**
   - A small in-memory tree in `bench/realtools` with the rules above, so a case runs to the end and the end state is checked (the row is there, the paragraph is added).
   - Conditions: `full` (today), `names` (today's 25 tools with names in place of ids), `fs` (the 9 tools, the tree and the platform's skills).
   - The 39 cases with the right first (tool, path), several where more than one is right. Plus 10 multi-step ones: create an app → test fails → fix; add three rows; correct a memory; export an edited report.
   - Per case that moved to a skill (apps, export): `fs` against today's tool. A mapping that loses keeps its tool.
   - Models: gemma-4-E2B and the 30B, 3 runs each. LFM3 for the record only.
   - **Go if,** on the 30B: finished tasks ≥ `full` + 5 points, no-call not higher, total tokens per task not higher. Under 5 points is noise at this sample size.
   - **If `names` gets most of the gain,** ship names alone and stop: it is a week's work, not a migration.
   - **If the 30B gains and gemma doesn't,** go: the main role is what calls tools.
2. **The path resolver** (`lib/paths.ts`): the table above, access, names and collisions, short row ids, the context tree.
3. **`ls`, `read`, `search`** on one test agent with `toolMode: "simple"`.
4. **`write` and `edit`** for outputs and apps; then memory and skills; then lists. The read-before-change pin and the removal card come with the first of them.
5. **`run`, `skill`, `share`, `query`,** with the platform's skills (apps, export, slides).
6. **Move the default agents** to `simple`. Custom agents convert by the table. Old names are removed when no agent or skill uses them.
7. **Measure the main model** (needs approval to spend).

## Open decisions

- **Static tables in outputs:** `.csv` is proposed here. The alternative is a Markdown table inside `.md`.
- **Memory as one file or a folder.** Claude keeps one fact a file with an index. Here it is one `memory.md`, one fact a line, because a fact is a single sentence and `append` adds it in one call.
