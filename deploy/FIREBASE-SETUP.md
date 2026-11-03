# North Kitsap United Tracker — Firebase setup

The site is one static HTML file plus `firebase-sync.js`. Both are in this folder.
Firestore holds everything; every signed-in device sees edits within about a second.

## 1. Console setup (once)

**Authentication → Sign-in method** — enable **Email/Password** and **Google**.
Both are followed by a texted code once SMS multi-factor is on.

### Text-message codes (MFA), required for everyone

1. Project must be on the **Blaze** plan (already needed for Storage).
2. **Authentication → Settings → "Upgrade to Identity Platform"** if offered (free
   up to 50k monthly users; SMS is billed per text, roughly 1–6¢ in the US).
3. **Authentication → Sign-in method → Advanced → SMS Multi-factor Authentication**
   → **Enable**. Optionally add test phone numbers (e.g. +1 555-555-0100 / 123456)
   for trying it without real texts.
4. **Authentication → Settings → SMS region policy** → Allow **United States**
   (blocks SMS pumping abuse from other regions).
5. Make sure your site domain is under **Authorized domains** (reCAPTCHA needs it).

How it works for users:

- First sign-in: password → choose own password (if invited with a temporary one)
  → verify email (link) → add mobile number → confirm with a texted code.
- After that, each sign-in is password + texted code. The device then stays
  signed in for **30 days** before asking again.
- **30 minutes idle locks the screen**; the password unlocks it (no text).
- **Lost phone:** in **Authentication → Users**, delete that user, then re-add them
  in the tracker's Admin → Users with a new temporary password. They set up their
  new number on first sign-in.

Accounts are **invitation only**: Admin → Users → Add a user, with a temporary
password. A login that isn't on the roster is signed straight out, and the rules
give it nothing.

**Authentication → Settings → Authorized domains** — add your Netlify domain
(`something.netlify.app` and any custom domain). `localhost` is already allowed.

**Firestore Database** — create the database in production mode, region `us-west1`
or whichever is nearest.

## 2. Security rules

Paste `firestore.rules` into **Firestore → Rules → Publish**. Nothing in it needs
editing; the two bootstrap admin addresses are already in place.

## 2b. Cloud Storage (event documents)

Event records can carry attached documents — fliers, guides, anything. They live in
Cloud Storage, which needs the Blaze plan enabled on the project.

1. **Storage → Get started** — accept the default bucket
   (`northkitsapunited.firebasestorage.app`, already in `firebase-sync.js`).
2. **Storage → Rules** — paste `storage.rules` and **Publish**.

The rules read roles from the same `/users/{email}` documents Firestore uses:
anyone with Read / write on Events (or Admin) can upload, replace and delete
event files, anyone with Read / write on Documents can manage the Documents
library; every other signed-in user reads only. Files land under `events/{eventId}/`, capped at 20 MB, and the app
downscales images to about 1600px before upload so a phone photo of a poster
arrives as a few hundred kilobytes. Until these rules are published, uploads fail
with a permission error and the app says so.

## 3. The two admin accounts

`gerry@gb2solutions.net` and `gerandkar@gmail.com` are Admin the moment they sign
in — the role is written into both the app and the security rules, so it holds on
a completely empty database and can never be revoked by accident. They stay a
lockout escape hatch.

Firebase Auth accounts still have to exist. Do this once for each address, either way:

- **In the app** — open the site, type the address and `Winters1!`, press
  **Create account**. You land as Admin.
- **In the console** — Authentication → Users → Add user, same address and
  password.

Signing in with the Google account on either address works too, with no password
at all — same Admin role either way, because the role is keyed to the email.

Change that password once you're in (Authentication → Users → ⋮ → Reset password,
or the app's **Forgot password** link). It is written in this file and in a
deployed source file, so treat it as a setup password rather than a permanent one.

## 4. First run

1. Deploy this folder to Netlify (drag-and-drop works — keep `firebase-sync.js`
   beside `index.html`).
2. Sign in with one of the admin accounts above.
3. **Admin → Data → Load sample data** if you want the demo records (118 donors,
   84 donations, 11 phases, 14 workers, 24 tasks) to look around in. It only runs
   against an empty database.
4. **Admin → Users** — invite the real people by email and pick their roles. When
   they sign in with Google or create an email account on that same address, they
   get the roles you assigned. Use **Edit** to add extra operations.

## 5. Roles and operations

Access is built from **operations**. Each section — Overview, Donors, Donations,
Events, Phases of work, Workers & contractors, Work to do / tasks, Admin, Reports,
Documents, Calendar — is one operation set to Off, View only or Read / write
(Admin is Off or Full access). **View $$** is one more operation: whether dollar
amounts are sent to the device at all.

A **role** is a named set of operations, managed under **Admin → Roles**. A user
holds any number of roles plus extra operations; for each section they get the
highest level any of them gives.

| Built-in role | Operations |
| --- | --- |
| Admin | Every operation, Read / write, View $$. Locked |
| General | Overview, Reports, Documents, Calendar — view only. Held by everyone by default |
| View Only | Every section except Admin, view only. View $$ off (turn it on in Roles if wanted) |

Add your own roles (e.g. "Event Crew") with whichever operations they need.

Anyone signing in with an address no admin invited gets **General** only. Changes
take effect live — the app re-subscribes and a user granted View $$ starts
receiving amounts without signing out.

**Upgrading from the old four roles.** The first time an admin signs in after this
release, every existing account is converted and written back:

| Old role | Becomes |
| --- | --- |
| Admin | General + Admin |
| View Only Full | General + View Only, plus View $$ |
| View Only Limited | General + View Only |
| Entry User | General, plus Read / write on Donors, Donations, Events, Documents, and View $$ |

Until that happens, the new rules still honour the old role field.

**What the rules enforce.** Writes are checked per section, and amounts are
withheld from anyone without View $$. Section visibility is enforced by the app:
Overview, Reports and Calendar roll up every collection, so records stay readable
to any active signed-in user.

## 6. Where amounts live

Money is not stored on the records. Each record carries a protected child
document holding only its figures:

```
donors/{id}                 name, type, tier, contact, status …
donors/{id}/secure/v        proposed
transactions/{id}           donor, date, status, method, task links …
transactions/{id}/secure/v  amount
phases/{id}/secure/v        budget
workers/{id}/secure/v       rate
tasks/{id}/secure/v         cost, costRows
```

The rules deny read on the whole `secure` collection group to anyone without
View $$, so such a browser receives no dollar figure at any point — not
in a document, not in the network payload, not in the local cache. The app draws
`•••` because it genuinely has nothing to draw. Reports and totals come out empty
for those users, by design.

Everything else:

```
meta/schema      data-field definitions (JSON string)
meta/lists       companies, locations
meta/reminders   donor follow-ups
meta/contacts    contact log per donor
meta/roles       role definitions (name + operations)
users/{email}    name, email, roles, ops, perms (effective, read by the rules), active
```

Record ids are the app's own (`d17`, `x42`, `p3`) so links between records survive.
Attendees, event tasks and attached-document records are arrays on the event
document itself; only the uploaded file bytes sit in Cloud Storage, with the
event holding its download URL and path.

## 7. Offline

The local cache is on with multi-tab support. Edits made without signal queue on
the device and commit when it reconnects; the sidebar footer reads **Offline ·
cached** while that is the case. Last write wins on conflict — Firestore has no
merge UI, so avoid two people editing the same record offline at the same time.

A device that never received amounts also never writes them: the writer skips the
protected documents when reads were denied, so a view-only session cannot blank
out a figure it couldn't see.

## 8. Costs

Live listeners charge one read per document on first load and one per change
afterwards. At this size (~250 records, so ~500 documents with the protected
children) a session is a few hundred reads — well inside the free tier for a team
of this size.

Cloud Storage is billed on the Blaze plan by stored bytes and downloads. Event
documents at a few hundred kilobytes each put this in cents per month; the free
allowance (5 GB stored, 1 GB/day downloaded) covers normal use on its own.
