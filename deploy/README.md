# North Kitsap United — Project Tracker

Deploy package. Static site, no build step, no server.

## What to upload

```
index.html          the whole app, self-contained
firebase-sync.js    Firebase auth + Firestore wiring — must sit beside index.html
user-guide.html     the User Guide, self-contained (opened from the sidebar's User guide link)
_redirects          single-page fallback for Netlify
```

Drag this folder onto Netlify (or `netlify deploy --prod --dir .`). The three files
above are all that get served; the rest of this folder is documentation and source.

## Before it works

**Read `FIREBASE-SETUP.md` first.** Six steps in the Firebase console: enable the
Google and Email/Password providers, add your Netlify domain to the authorized
domains, create the Firestore database, publish `firestore.rules`, enable Cloud
Storage and publish `storage.rules`, and create the two admin accounts. Until the
rules are published Firestore refuses every read and the app sits empty; until
`storage.rules` is published, document uploads fail with a permission error.

## Files here

| File | What it is |
| --- | --- |
| `index.html` | The app, bundled. Edit `source/app.html`, then run `python3 tools/bundle.py pack` from the repository root |
| `firebase-sync.js` | Auth, live listeners, offline cache, diff-based writer |
| `firestore.rules` | Paste into Firestore → Rules. Enforces per-section write operations and keeps amounts off devices without View $$ |
| `storage.rules` | Paste into Storage → Rules. Uploads need Read / write on Events or Documents; everyone else reads |
| `FIREBASE-SETUP.md` | Console setup, roles, where amounts live, offline behaviour, costs |
| `_redirects` | Netlify SPA fallback |
| `source/` | `app.html` is the app template packed into `index.html` (see `tools/bundle.py`). The `.dc.html` there is an older Design copy and is out of date |

## Donations: certificates, tax receipts and thank-yous

The Events section is retired. Gifts that used to hang under an event are
ordinary donations now, titled and tagged **NKU Dinner Gala**, so they list,
filter and report like any other donation. The move happens once, automatically,
the first time an admin signs in after this version is deployed: each gift loses
its link to the event, a thank-you already ticked on the event carries over as
**Thank-you sent**, and the event record itself is left in place (hidden) so its
attendees, tasks and documents are not lost.

Each donation's header has **Donation / Pledge Certificate**, **Tax Receipt /
Pledge Receipt** and **Thank you sent**. Receipts follow the certificate rules:
a received gift prints what was received, a pledge prints as a pledge receipt
(not a tax-deductible receipt), and each plan payment gets its own receipt with
the pledge progress line (**Payment Tax Receipt** on the pledge). A single
receipt can state the value of goods or services the donor received (a gala
dinner, say) so it shows the deductible amount.

The top of Donations has **Print out Certificates**, **Print out Receipts**
(same filters as certificates) and **Thank you List**, which shows every
Received or Pledged donation still waiting on a thank-you and marks them in
bulk. Plan payments are covered by their pledge's thank-you.

## Upgrading to roles & operations

Publish the new `firestore.rules` and `storage.rules` **before** uploading the new
`index.html` and `firebase-sync.js`. Then sign in once as an admin — that converts
every existing account from its old single role. See FIREBASE-SETUP.md §5.

## Temporary passwords

When an admin adds a user with a password, that password is temporary: the
profile is flagged `mustChangePassword` and the user's first email sign-in opens a
**Choose your own password** screen before anything else. Admin → Users shows a
**Temp password** tag until they do. No rules change is needed.

## Text size

**Admin → Text size** scales the desktop interface (100–150%, default 125%). It is
remembered per browser and does not affect phones or other users.

## Bulk upload

**Admin → Bulk upload** loads records in from a spreadsheet. Pick the section,
press **Download template** for a CSV with the right headers (starred columns are
required) and a guide row showing the expected format, fill it in, save as CSV and
press **Upload CSV**. You get a preview and a count before anything is written.

Link columns match on name or ID against records already in the database, so load
in dependency order: donors and phases first, then workers and task groups, then
tasks, then donations.

## Task groups

**Admin → Task groups** manages the list that replaced the old Location field. A
group is a place or a sub-project — a field, a wing, the utility corridor — and can
be assigned to several phases at once. Tasks belong to one group, and a new group
can also be created inline while entering a task.

## The app in one paragraph

Sections — Donors, Donations, Phases, Workers, Tasks, Documents, Calendar,
Reports, Admin. Desktop gets a sidebar plus list/detail panes; phones get a drawer and a
bottom bar. Everything writes straight to Firestore and appears on every other
signed-in device within about a second, offline edits included. Access is set by
operations (one per section, Off / View only / Read / write, plus View $$) grouped
into roles — Admin, General, View Only and any you add. Dollar figures live in
protected child documents the rules keep off any device without View $$.

## Notes

- The NKU logo loads from `rotaryknk.org`. If that host ever moves, drop a copy
  beside `index.html` and point the two `<img src>` references at it.
- Certificates and reports print from the browser (Cmd/Ctrl-P) at landscape.
- The sidebar footer shows connection state: **Live · Firestore** or
  **Offline · cached**.

## Website API (North Kitsap United site)

The repository root also holds a small API for the public website, as Netlify
Functions in `netlify/functions/` (configured by `netlify.toml`, which publishes
this `deploy/` folder). **Functions don't deploy by drag-and-drop**: deploy from
Git (link the nku-tracker project to this repository) or with
`npx netlify deploy --prod` from the repository root.

| Endpoint | What it does |
| --- | --- |
| `POST /api/submit/:kind` | The website's forms: `contact`, `donation-question`, `gift`, `zeffy`, `pledge`, `inkind`, `volunteer`, `updates`. Each becomes a document in the Firestore `inbox` collection. |
| `GET /api/public/campaign` | Pledged, Received to date and Estimated cost plus the progress bar, computed like the Overview. Totals only. Cached 5 minutes. |
| `GET /api/inbox`, `POST /api/inbox/:id` | The team's review of submissions, used by **inbox.html** (nku-tracker.com/inbox.html). Requires a Tracker sign-in with the texted code and Admin or Donors write access. |

Environment variables on the nku-tracker Netlify project (scope: Functions):

- `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY`: from the Firebase service-account key (Project settings → Service accounts). Netlify caps all variables at about 4 KB, so set just these two fields, not the whole JSON. Keep the key file out of Git (`.gitignore` covers `Keys/`).
- `ZEFFY_CARD_URL` and `ZEFFY_EFT_URL`: the Foundation's Zeffy donation pages. The website records a Zeffy gift here first, then sends the donor on to these links.
- `API_ALLOWED_ORIGINS` (optional): extra website addresses allowed to call the API, comma-separated. The NKU domains, northkitsapunitednew.netlify.app and its deploy previews are already allowed.

No Firestore rules change is needed: the API uses the Admin SDK and checks
access itself.
