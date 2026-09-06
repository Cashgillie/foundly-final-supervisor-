# Foundly — Supabase Backend

Foundly runs on Supabase: **Postgres** for data, **Storage** for photos,
**Postgres RPC functions** for every write, and **Supabase Auth** for the
admin dashboard.

## Why RPC functions instead of a separate server?

The brief needs edit/delete links that work **without an account** — the
link itself (not a login) proves you own a report. That can't be done
safely with Row Level Security policies alone: RLS can only compare values
already in the database against an incoming write, and if the secret token
lived on the public `reports` row, everyone loading the public feed would
receive it in the response — the "secret" wouldn't be secret.

So the token lives in its own `edit_tokens` table with **no RLS policies at
all** (meaning: nobody, in any role, can read or write it directly — not
even a signed-in user). The only way in is through `SECURITY DEFINER`
Postgres functions, which run with the table owner's privileges and bypass
RLS after doing their own explicit checks in plain SQL. That's what
`create_report`, `update_report_by_token`, `resolve_report_by_token`, and
`delete_report_by_token` do in `supabase/migrations/0001_init.sql`. This is
the same "capability link" pattern you'd use with a separate backend —
Postgres just does the job here without needing one.

## What's in this project

Foundly is now a **single page** (`index.html`) — Home, Lost, Found, and
Bookmarked used to be separate pages; they've been merged, since the item
grid already supported filtering by type and category with the pills at
the top. The bookmark feature was removed entirely at the same time. The
About page's FAQ, Safety Tips, Contact, and Privacy content now live as
anchor sections on the same page instead of a separate `about.html`.

```
public/                       → static site, deploy anywhere (Netlify, Vercel, GitHub Pages, etc.)
  index.html                   → the whole public site: hero, how it works, browse/search,
                                  safety tips, FAQ, contact, privacy — one page, anchor nav
  edit.html                    → token-gated self-service edit/resolve/delete
  console-<random>.html        → admin dashboard — deliberately NOT linked from anywhere;
                                  only reachable if you have the exact URL (see below)
  foundly.css
  js/
    supabase-config.js         → YOUR project's URL + anon key (fill this in)
    supabase-init.js           → shared client bootstrap
    foundly-data.js            → all Postgres/Storage/RPC calls + UI helpers
    home.js                    → the single page's logic (browsing, filters, report
                                  submission, FAQ accordion, contact form)
    admin.js                   → admin dashboard logic
    edit.js                    → edit-link page logic

supabase/
  migrations/0001_init.sql    → tables, RLS policies, storage bucket, RPC functions
```

### Finding the admin dashboard

There's no "Admin" link anywhere on the site anymore — on purpose. The
file is named something like `console-9b2704b6.html` instead of
`admin.html`. Bookmark that exact URL somewhere private (a password
manager note, for instance). This is defense-in-depth, not the real
security boundary — Supabase Auth (see step 4 below) is what actually
gates access; the obscure filename just means a random visitor can't stumble
onto a login screen by guessing `/admin.html`. If you want to rotate it,
just rename the file — nothing else references it by name.

## Data model (`reports` table)

```
id           uuid, primary key, default gen_random_uuid()
type         text — 'lost' | 'found'
category     text
title        text
description  text
location     text
contact      text (email)
image_url    text | null        — public Storage URL
status       text — 'active' | 'resolved' | 'deleted' | 'archived'
created_at   timestamptz
updated_at   timestamptz
resolved_at  timestamptz | null
deleted_at   timestamptz | null
```

Note: `'archived'` is still a valid value at the database level (the check
constraint in `0001_init.sql` allows it), but the admin dashboard no longer
exposes any way to set or filter by it — the archive feature was removed
from the UI. Nothing writes `'archived'` anymore; it's just not worth a
migration to drop it from the constraint. If you want it gone at the
database level too, run:
```sql
alter table public.reports drop constraint reports_status_check;
alter table public.reports add constraint reports_status_check
  check (status in ('active', 'resolved', 'deleted'));
```
(only after confirming no existing rows have `status = 'archived'`).

The client reads these through an aliased query so the app sees the exact
camelCase field names from the spec (`imageUrl`, `createdAt`, etc.) even
though Postgres itself stays snake_case. `edit_token` is **not** a column
on `reports` — it lives in the separate `edit_tokens` table described
above and is never sent to the browser except once, right after you create
a report.

Only `status = 'active'` reports are visible through the public RLS
policy; `index.html` relies on that for every filter view (Lost, Found,
All). The Admin Dashboard can see every status because the signed-in user
is listed in `admin_users`.

## Step-by-step: connecting your Supabase project

### 1. Create the project
Go to [supabase.com](https://supabase.com) → New Project. Pick a name,
password (for the Postgres database itself — save it somewhere safe), and
region. Wait a minute or two for provisioning.

### 2. Run the migration
Dashboard → **SQL Editor** → New query → paste the entire contents of
`supabase/migrations/0001_init.sql` → **Run**.

(If you'd rather use the CLI: `npx supabase login`, `npx supabase link
--project-ref YOUR_PROJECT_REF`, then `npx supabase db push`.)

This one script creates the `reports`, `edit_tokens`, and `admin_users`
tables, turns on Row Level Security with the right policies, creates the
`report-images` Storage bucket (public read, 10MB limit, images only), and
creates all eight RPC functions.

### 3. Get your API credentials
Dashboard → **Project Settings → API**. Copy:
- **Project URL** (e.g. `https://abcdefgh.supabase.co`)
- **anon / public key** (a long JWT — this one is safe to expose in
  client-side code; it's designed to be public)

Paste both into `public/js/supabase-config.js`:
```js
export const SUPABASE_URL = "https://abcdefgh.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOi...";
```

### 4. Create your admin account
Dashboard → **Authentication → Users → Add user**. Set an email and
password (turn off "Auto Confirm User" only if you also plan to set up
email confirmation — for a quick start, leave auto-confirm on).

### 5. Grant that account admin access
Dashboard → **SQL Editor** → run:
```sql
insert into public.admin_users (user_id)
values ('paste-the-user-uuid-here');
```
You'll find the user's UUID on the Authentication → Users page (click the
user, copy the "UID" field). That's it — no service account keys, no
custom claims to refresh, just a row in a table. To revoke admin access
later, delete that row.

### 6. Run it locally to test
Since these are static files with ES module imports, you need to serve
them over HTTP (not `file://`) for the browser to load the modules. From
the `public/` folder:
```bash
npx serve .
# or: python3 -m http.server 8080
```
Open the printed URL, try reporting an item, then open the returned edit
link, then sign in to your admin dashboard file (e.g.
`console-9b2704b6.html`) with the account from step 4.

### 7. Deploy
Supabase doesn't host static files itself — deploy the `public/` folder to
any static host:
- **Netlify / Vercel**: drag-and-drop the `public/` folder, or connect the
  repo and set the publish directory to `public`.
- **GitHub Pages**: push `public/`'s contents to a `gh-pages` branch (or
  use the `/docs` convention).
- **Cloudflare Pages**: same idea — point it at `public/` as the output
  directory.

No build step is needed — everything is plain HTML/CSS/JS loading Supabase
from a CDN (`esm.sh`), so "deploy" really just means "upload these files
somewhere that serves static content over HTTPS."

## Extending to full user accounts / RBAC

The pieces are already in place:

- Auth is real Supabase Authentication (email/password today), so adding
  a public sign-up flow, magic links, or OAuth providers is additive and
  doesn't touch anything here.
- Authorization is a plain `admin_users` table, not a hardcoded password
  or a JWT claim you have to remember to refresh. Adding more roles later
  (e.g. a `moderators` table) is one more table and one more `exists(...)`
  check inside the relevant RPC functions — no restructuring.
- Reports aren't tied to a user id yet (by design — no login required to
  report something). If you later want "my reports" for logged-in users,
  add an optional `owner_id uuid references auth.users(id)` column, set it
  in `create_report` when `auth.uid()` is not null, and add an RLS policy
  like `using (owner_id = auth.uid())` alongside the existing status-based
  one — the token flow and the login flow can coexist.

## New in this update: image validation, admin preview, and resolution emails

**Run the new migration.** `supabase/migrations/0002_fix_image_clear.sql`
must be run in the SQL Editor (same way as `0001_init.sql`) — it fixes a
real bug where removing a report's photo silently failed to clear it,
because the original functions used `COALESCE`, which can't tell "field
not sent" apart from "field explicitly set to null."

**Image upload validation.** Every photo field (public report form, admin
add/edit, self-service edit page) now rejects anything that isn't JPG/PNG
or is over 5MB, and shows an instant preview before you submit — all
client-side, in `validateImageFile()` / `readImageAsDataURL()` in
`js/foundly-data.js`.

**Admin item preview.** Clicking a row's thumbnail or title in the admin
dashboard now opens a quick preview (photo, description, location, status,
contact) without leaving the table — no need to open the full edit form
just to look at something.

**Reported column now shows date + time**, not just the date
(`formatDateTime()` in `js/foundly-data.js`).

**Resolution notification emails.** When an admin marks a report
"Resolved" — either via the ⋮ menu or by changing Status in the edit
form — the report's owner is automatically emailed at the address they
gave when reporting. This is the "Owner receives notification" step of
the Lost → Found → Notification workflow described by product:

```
User reports Lost Item → stored in Supabase (admin-only visibility)
        ↓
Someone reports a matching Found Item → visible on the public site
        ↓
Admin reviews both, recognizes the match
        ↓
Admin marks the Lost report "Resolved"
        ↓
Owner is emailed automatically at their report's contact address
```

This uses [EmailJS](https://www.emailjs.com) rather than a custom backend,
since it runs entirely client-side (no server, no secret keys to deploy) —
consistent with the rest of this project having no backend beyond
Supabase. **To activate it:**

1. Create a free account at emailjs.com
2. Add an Email Service (e.g. connect a Gmail account) — copy its **Service ID**
3. Create an Email Template with variables `{{to_email}}`, `{{item_title}}`,
   `{{item_type}}`, `{{item_category}}`, `{{item_location}}` — copy its **Template ID**
4. Account → General → copy your **Public Key**
5. Paste all three into `public/js/emailjs-config.js`

Until you do this, resolving an item still works exactly the same —
the app just logs a console warning and skips the email, so nothing else
is blocked by it.

## Known trade-offs (worth knowing about)

- **Anonymous image uploads.** The `report-images` bucket accepts uploads
  without login so reporting never requires an account. That also means
  anyone could hit the upload endpoint directly. If abuse becomes a
  problem, look at Supabase's rate limiting or add a lightweight CAPTCHA
  on the report form.
- **Email delivery.** "Email me this link" currently opens the user's own
  mail client via a `mailto:` link rather than sending an email
  automatically. Supabase doesn't include transactional email out of the
  box — wiring up something like Resend or Postmark from a Supabase Edge
  Function is a natural next step if you want that automated.
- **Search is client-side.** Postgres full-text search exists but isn't
  wired up here; filtering by keyword happens in the browser after
  fetching active items by type. Fine at this scale — if the catalog grows
  large, Postgres's built-in `tsvector`/`tsquery` support (or a hosted
  search service) is worth adding.
