# 10 — Lists («القوائم»)

## Why

Asked «رتّب مهامي», the assistant could only write a static table. It looked fine, but nothing could be ticked off, stored or followed up. «المهام» (Phase 3) didn't help either:
- it exists only in shared spaces;
- only a manager adds a task, and it must be assigned to someone;
- the assistant has no tool for it.

Notion solves this with a database: rows with typed properties, several views of the same rows, and every change synced to every open screen. OneBase already does the syncing (reactive queries), so we only needed the generic part.

## What

A **list** is a live table in a space. It works in any space, personal or shared.

- **Columns** have a type:
  - text, number;
  - date (YYYY-MM-DD);
  - status (with options; the default is لم تبدأ / قيد التنفيذ / منجزة);
  - select (options);
  - person (someone who can read the space);
  - check.
- **Rows** are edited in place.
- **Views:** a table (search, sort by column) or a board grouped by the status column. A count shows how many rows are done.
- **Access** follows the space:
  - read: see it;
  - write (the owner of a personal space, or a member or manager of a shared one): edit rows and columns, and create lists;
  - delete a list: its creator or a manager.
- **Columns:** dropping a column, or changing its type, clears its values. Renaming keeps them.
- **Cells:** secrets typed into a cell are masked.
- **Limits:** 20 columns, 2000 rows per list, 200 lists per space.

## The assistant

Every agent gets these tools, like the skill tools:

- `create_list`: used, rather than `create_artifact`, whenever the result is items the user will track. The list lands in the chat's space if the user can write there, else in their personal space.
  - In the personal space it runs at once, with «تراجع».
  - In a shared space it is a card that waits for «نفّذ».
- `update_list`: adds rows, updates rows by row id, and removes rows. It may add a missing status or select option. Same tiers as `create_list`. «تراجع» removes added rows and puts changed or removed rows back.
- `read_list`: reads a list by id or by title, with row ids. It only reads lists in this turn's scope.
- **Index:** the chat's space's lists and the person's own (up to 15 per space) are listed in the prompt. So «وش باقي من مهامي؟» reads the live list instead of guessing.

In the chat, the card has an «افتح القائمة» button, and the answer links to `#/list/<id>`.

## Screens

- `#/lists` lists every list I can read, and has «قائمة جديدة» (in a space I pick).
- `#/list/<id>` is the list page.
- Each space has a new tab, «القوائم».

## Later

- Skills that rely on a list (for example «متابعة المتدربين» reading and updating its list).
- «المهام» as a ready-made list, with its columns, assignment and notifications.
- More views (calendar by a date column), filters saved per list, and reordering rows by drag.
- Tool retrieval (plans/07). The registry is now 17 tools (the test cap went from 15 to 18), and the model sees all of an agent's tools at once.
