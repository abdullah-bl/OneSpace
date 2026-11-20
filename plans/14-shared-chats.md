# 14 — Shared space chats («المحادثة المشتركة»)

## Why

A shared space shared everything except the conversation. Files, lists, tasks, skills and the space's memory were the team's, but every chat in the space stayed private to whoever started it (`ownThread` in `chat.ts`, «لا يراها غيرك» on the space page). Two colleagues working on the same thing each had to ask the assistant separately, and the only shared surface was task comments. That breaks the idea of a workspace (plans/07, conflict 6).

## What

A chat in a shared space has a `shared` flag (`threadMeta.shared`).

- **Default.** A new chat in a shared space is shared when its starter can write in the space. The new-chat screen offers «مشتركة مع المساحة» / «خاصة بي». Chats that existed before stay private. Personal-space chats, free-form chats, task, scheduled and test threads are never shared.
- **Access follows the space** (`threadAllows` in `access.ts`):
  - a person who can read the space reads the chat;
  - a person who can write there asks in it;
  - this holds for the owner too: leaving the space ends their access to their own shared chat.
- **Each turn runs as the person who asked**, with their level, tools and permissions. The answer is visible to everyone in the space, so the turn takes nothing that is personal to the asker:
  - **@mentions:** only the space and its own files. Anything else is refused when sending.
  - **Personal memory:** not read, not suggested from the chat, and `recall` skips it. The space's memory is still used.
  - **`my_records`:** not offered, and refused if it is called anyway.
  - **Data sources:** only sources the admin gave to this space. Workspace-wide sources are left out, because members may have different levels.
  - **The model** is told that the chat is shared and who is asking. Earlier questions in its history carry their asker's name.
- **Who does what**:

| Action | Who |
|---|---|
| Read the chat | Anyone who can read the space |
| Ask, retry, change the agent or scope | Anyone who can write in the space |
| Stop an answer | The person who asked, or the owner, or a space manager |
| Confirm a proposal («نفّذ»), «تراجع» | The person whose question made it |
| Rate an answer | The person who asked |
| Rename, pin, «بلا ذاكرة», draft a skill from the chat | The owner |
| Share an existing private chat | The owner, if it has no @mention from outside the space |
| Make it private again, delete it | The owner, or a space manager |

- **Audit:** sharing, unsharing and deleting a colleague's chat are logged (`chat.share`, `chat.delete`).
- **UI:**
  - The space page lists my chats and the shared ones, marked «مشتركة · بدأها …» or «خاصة بك».
  - In the chat, each question shows who asked it. A «مشتركة» badge sits in the header.
  - A reader sees the chat with a note in place of the composer.
  - The chat menu shares the chat or makes it private.

## Following a shared chat

The people following a shared chat are its owner and everyone who has asked in it, as long as they can still read it. It is not the whole space, so a busy space doesn't flood every member.

- **My chat list** (`chat:threads`: the sidebar and «المحادثات») includes the colleagues' shared chats I asked in. A team icon marks them, with «بدأها …» in the tooltip, and there is no pin button on them. A shared chat I only read stays on the space page.
- **Notifications:** when someone asks in a shared chat, each other follower gets «فلان سأل في «…»», with the space and the start of the question (kind `chat.shared`). There is at most one per chat per person per hour (a `dedupeKey` with the hour). The feed hides it once the reader can no longer read the chat: made private, deleted, or they left the space.

## Not done

- A reader can't react to an answer or comment on it. That matches their role in the space (read only).
- No way to follow a shared chat without asking in it, or to stop following one.

## Tests

`tests/shared-chats.test.ts` covers:
- default sharing, listing and the permission matrix for `chat:setShared`;
- asking as yourself, author names, and readers who can't ask;
- refused outside @mentions, and no personal memory or `my_records`;
- who can share, unshare and delete;
- losing access after leaving the space;
- joined chats in my list, and follower notifications with the hourly limit.
