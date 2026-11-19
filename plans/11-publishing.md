# 11 — Publishing: pages, forms and feedback («النشر»)

## Why

People already make good outputs with the assistant: a course outline, a policy summary, an event page, a dashboard. Today those outputs stay inside the app. Two things are missing:

- **A link.** "Send this to the trainees" means downloading a PDF and attaching it.
- **Answers coming back.** A survey, a registration or a feedback request has no way to collect replies.

Claude's model: anything it makes can become a link, private or public, served from a separate domain, and it can take input. We want the same, inside the rules we already have: access follows the space, generated code never runs with the user's session, and every action is audited.

## The decision on `@onebase/static-hosting`

We don't use it for this, for now. It is very good at what it is: one site per mount (the singleton `site` table), deployed from outside the app with a token (the deploy functions are internal to the component), with atomic swaps and rollback.

Publishing needs three things it doesn't have:
- many small sites, one per published output;
- publishing from the app's own functions, by the assistant or a button;
- per-page access rules.

Pages here are mostly a single HTML document, so the artifact and its versions are already the content store. Two later uses:
- serving OneSpace's own frontend with atomic deploys (in place of `--public dist`);
- multi-file sites, once upstream adds a `siteId` and an app-callable publish (plans/06).

## What

### 1. A published page

A **publication** points at one output (`artifacts`) and one fixed version of it. Publishing never shows a draft by accident: a new version stays unpublished until «حدّث المنشور».

| Field | Meaning |
|---|---|
| `artifactId`, `version` | what is shown |
| `slug` | random, 12+ chars (`/p/k7Qm2xWv9aLp`); never guessable, never the title |
| `audience` | `space` (members of the output's space), `workspace` (any active employee), `public` (anyone with the link) |
| `spaceId` | the output's space; access and audit follow it |
| `form?` | a form attached to the page (§3) |
| `createdBy`, `createdAt`, `revokedAt?`, `views` | owner and lifecycle |

- **Who publishes:** whoever can write in the output's space. In a shared space a member's publish is a card a manager approves, like a space skill. A manager's publish goes live at once.
- **Workspace policy (admin):** whether `public` is allowed at all, and for which levels. The default is off.
- **Sensitive spaces:** `space` audience only, never `workspace` or `public`. Outputs whose classification is `sensitive` follow the same rule wherever they sit.
- **Revoking:** «أوقف النشر» answers 410 from then on. Deleting the output revokes its publications.
- **What the reader sees:** the page in a frame, a small footer («نُشر من مساحة»), and nothing else of the app.

### 2. Served from a separate origin

This is the main security point. A published page is content the model wrote. Served from the app's origin, any script in it could act with the reader's session. So:

- Pages are served only from a **content origin**: a separate host (`PUBLISH_ORIGIN`, e.g. `p.example.gov.sa`, or a second port on a local network). The app's origin never serves `/p/`. The content origin serves only `/p/…` and the form endpoint, and never sets or reads the app's cookies.
- **Headers:**
  - `Content-Security-Policy: sandbox allow-scripts allow-forms; default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'sha256-<ours>'; form-action <content origin>/f/; frame-ancestors 'none'`;
  - `X-Content-Type-Options: nosniff`;
  - `Referrer-Policy: no-referrer`;
  - `Cache-Control: private, no-store` for anything not `public`.

  This is the same rule as the in-app frame (`src/sandbox.ts`): no generated `<script>` runs. Only our own hashed scripts run (table tools, the form helper), and no request leaves the page.
- **Private pages (`space`, `workspace`):** the reader opens the link, and the content origin has no session. So the app issues a one-time, short-lived ticket (same scheme as `downloadTickets`): `/p/<slug>` on the content origin redirects to the app's `/p/<slug>/open`. That route checks the reader's session and access, then redirects back with `?t=<ticket>`. The content origin trades the ticket for a short cookie scoped to that slug only. A reader without access gets the same «غير متاح» page whether the slug is missing or forbidden.
- **Public pages:** no ticket. Rate-limited per IP (the `limiter` component). `noindex` unless the publisher ticks «يظهر في محركات البحث», which is off by default.

### 3. Forms and feedback → a list

A form is not generated HTML. Model-written `<form>` + JS is exactly what the sandbox blocks. A form is **declared**: it targets one live list (plans/10), and its fields are that list's columns (or a chosen subset):

- **Rendering:** our own hashed form script renders the fields from the publication's form spec inside the page, below or in place of a `<div data-form>` the model may leave in the HTML. Column types map to inputs:
  - text → input or textarea;
  - number, date → the matching inputs;
  - select and status → a select;
  - check → a checkbox;
  - person → not offered on public forms.
- **Submit:** `POST <content origin>/f/<slug>`. The server checks the publication is live and its audience. For a public form it also checks a time-bound token from the page and a rate limit per IP and per form. Each field is cleaned with the same rules as a list cell (`cleanCell`, secrets masked), and the answers are added as a row: `createdBy` = the reader if signed in, else the publisher, plus a hidden «المصدر» value (`form:<slug>`).
- **Limits:**
  - max replies per form;
  - closing date;
  - one reply per signed-in reader, optionally;
  - required fields;
  - a thank-you text.
- **Feedback:** a ready-made form («ملاحظات») with rating (select 1–5) and comment (text) that any publisher can attach. It is the same mechanism.
- **Replies:** they land in a list in the publisher's space, so the team already has the table, the board, search, and the assistant (`read_list`: «لخّص ردود الاستبيان»). Nothing new to build for reading them.

### 4. In the app and the chat

- **On an output:** a «انشر» menu item. It shows the audience choice (only those the policy and the space allow), whether to attach a form, the link, and «انسخ الرابط». A published output shows a badge with its audience and view count, and «حدّث المنشور» when a newer version exists.
- **«منشوراتي»:** every publication I made, with its audience, views, replies, and «أوقف النشر». Managers see their space's publications on a space tab; admins see all of them, with a policy switch, in «إدارة المنصة».
- **Tool `publish_output`:** `{ artifactId, audience, form?: { listId | columns, ... } }`. It is always a card (tier 2, or tier 3 for `public`). The model can make a survey end to end:
  1. `create_list` with the columns;
  2. `create_artifact` with the intro page;
  3. `publish_output` with the form bound to that list.

  The person sees and approves each step.
- **Audit:** `publish.create`, `publish.update`, `publish.revoke`, `publish.policy`, and a counter (not a log row) per view and per reply.

## Rules (each covered by tests)

1. A page is served only from the content origin. The app's origin returns 404 for `/p/` and `/f/`.
2. Generated scripts never run on a published page: the CSP and the sandbox, as in `src/sandbox.ts`. Tests check the headers and that a `<script>` in the content is inert.
3. A private page needs a valid ticket, bound to that slug and that reader, used once. A ticket for slug A never opens slug B.
4. Sensitive spaces and sensitive outputs are never `workspace` or `public`. `public` is off unless the admin turns it on.
5. A revoked or deleted publication answers 410 at once, and so does its form.
6. A form writes only to its own list, only its declared columns, through the same cell checks as the list page.
7. Missing, forbidden and revoked slugs look the same to a reader without access.
8. The full permission matrix (actor × space × audience) for publish, update, revoke, open and submit.

## Build order

1. **Publications (private only).**
   - The `publications` table.
   - Publish, update and revoke.
   - The content origin with tickets.
   - «انشر» on outputs and «منشوراتي».
   - The rules 1–3, 5 and 7 tests.
2. **Forms → lists.**
   - The form spec and the hashed form script.
   - `/f/<slug>`, with limits.
   - The «ملاحظات» preset.
3. **Public.** Built:
   - **Admin policy:** set in «نظرة عامة» and off by default. Turning it off closes every public page at once.
   - **Opening:** a public page opens with no sign-in. The app's host still never serves `/p/`.
   - **Anonymous replies:**
     - the form token comes from a per-page secret and the hour;
     - there is no sender, and the row is added as the publisher;
     - the score is shown when the quiz says so;
     - «once per reader» is the browser's cookie (soft).
   - **Rate limits:** per client address (views 60/min; replies 4/min, burst 3), and replies per page.
   - **Always `noindex`:** there is no «searchable» option yet.
   - **`publish_output`:** for the public it is a tier-3 card.
4. **`publish_output` for the assistant**, plus a skill example («استبيان رضا المتدربين»).
5. **Later:**
   - multi-file sites on `@onebase/static-hosting` once it has `siteId` and an app-callable publish;
   - a custom domain per space;
   - the space identity (plans/09 §3) applied to published pages.

## Open questions

- **The content origin in each deployment:**
  - Fly: a second hostname on the same app.
  - Local network: a second port, or a hostname the IT team adds.

  This needs one setting and a check on startup that refuses to publish without it.
- **Should `workspace` pages need the reader to be signed in?** This plan says yes (ticket). The alternative is an unlisted link inside the network only. The ticket is safer and costs one redirect.
- **Data protection for public forms:** whether to show a consent line by default, and how long to keep replies (a retention setting on the list).
