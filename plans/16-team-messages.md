# 16 — Messages to colleagues in shared chats («رسالة للفريق»)

## Why

In a shared chat (plans/14) every message went to the assistant. An @mention only notified the person. So «@محمد خلّص تقرير المصروفات» got an AI answer as if it were addressed to the assistant. Mohammed got a notification and found a reply to something meant for him. There was no way to talk to a colleague, or to hand them work, in the chat the team shares.

## The model: the assistant is a member that answers when called

In a shared chat the conversation is the team's. The assistant answers only when a message calls it with @المساعد.
- It is first in the @ list, and a starter calls it on its own.
- A plain message, or one naming people, goes to them.
- Personal chats are unchanged: everything there is for the assistant.

Three rules:
1. **Who a message is for is visible:** the composer says so before sending.
2. **The assistant works as whoever called it:** with their level, tools and permissions. Each answer says «المساعد · بطلب من فلان».
3. **An answer belongs to whoever asked for it:**
   - only they retry it (`chat:retry` refuses anyone else);
   - only they confirm or undo its actions, or rate it;
   - anyone else asks the assistant themselves.

   Retrying a colleague's question used to run it again with the retrier's permissions.

A turn's question is its own message (`turns.userMessageId`; a retry names it), never a colleague's message posted after it.

## What

- **A message that names people goes to them** (`chat:send` with `people`, `to: "team"` by default):
  - it is saved with `messageMeta.team = { to: [{ userId, state }] }`, and no turn is queued;
  - the people named are notified (`chat.mention`, linked to the chat);
  - recipients are the named people who can read the chat, at most 10;
  - in a private chat, or with «واسأل المساعد أيضاً» (`to: "assistant"`), the assistant answers as before.
- **Everyone sees** who it is for and what each person did with it: بانتظار / سلّمها للمساعد / يتولاها / أنهاها.
- **The person named gets a card** that only they see (`chat:handoff`):
  - **«خلّ المساعد يشتغل عليها»:**
    - a turn runs **as them**, with their level, tools and permissions, and asks them for «نفّذ» where needed;
    - the question is «طلب فلان مني: …», shown as one line («سلّم محمد الطلب للمساعد»);
    - the answer is in the chat for everyone;
    - the author is told it was handed over, and again when the assistant has answered.
    - It needs to be able to ask in the chat: a reader can't hand it over.
  - **«أتولاها بنفسي»**, **«تمت»**: the author is told.
- **The assistant reads messages between colleagues as context.** In its history they are marked «رسالة بين الزملاء وليست سؤالاً لك».
- **Composer:** when a shared chat's message names people, a line says who it goes to and that the assistant won't reply, with «واسأل المساعد أيضاً».

## Why the person named presses, not the author

A message from one person must not make the assistant act with another person's permissions. Only the person named can start a turn as themselves. Every action they would confirm still waits for their «نفّذ».

## Not yet

- **«حوّلها لمهمة»:** a manager turning a team message into a task in «المهام». Creating tasks is for managers (`tasks.create`), so it would sit on the author's side.
- **Telling a request from a remark** («@محمد شف هذا»): the card shows for both. The decision model (plans/12) could later tell them apart and make the card lighter for a remark.

## Tests

`tests/shared-chats.test.ts` covers:
- no turn for a team message; recipients filtered; the notification;
- the «to: assistant» path, and the history marked as between colleagues;
- the permission matrix of `chat:handoff`: only those named; handing to the assistant needs write; a reader can take it;
- the turn runs as the person named; both notifications; «تمت»;
- a private chat unchanged.
