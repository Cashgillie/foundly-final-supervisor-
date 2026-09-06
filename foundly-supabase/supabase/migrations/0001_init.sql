

create extension if not exists pgcrypto;

-- ─── TABLES ───────────────────────────────────────────────────

create table if not exists public.reports (
  id           uuid primary key default gen_random_uuid(),
  type         text not null check (type in ('lost', 'found')),
  category     text not null,
  title        text not null,
  description  text not null,
  location     text not null,
  contact      text not null,
  image_url    text,
  status       text not null default 'active'
               check (status in ('active', 'resolved', 'deleted', 'archived')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  deleted_at   timestamptz
);

create index if not exists reports_status_idx     on public.reports (status);
create index if not exists reports_type_idx       on public.reports (type);
create index if not exists reports_created_at_idx on public.reports (created_at desc);

-- Maps a random token string -> report id. This is the ONLY thing that
-- proves someone is allowed to edit/resolve/delete a report — no login
-- required. It's deliberately kept out of the `reports` table and out of
-- reach of every client role (see RLS below); only the SECURITY DEFINER
-- functions further down can read it. If the token lived on the report
-- row itself, anyone listing the public feed would receive it in the
-- response and the "secret" link wouldn't be secret anymore.
create table if not exists public.edit_tokens (
  token      text primary key,
  report_id  uuid not null references public.reports (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Marks which auth.users are admins. Deliberately a plain table rather
-- than a JWT custom claim — easy to inspect/manage from the SQL editor,
-- and trivial to extend into real roles later (see README).
create table if not exists public.admin_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ─── ROW LEVEL SECURITY ───────────────────────────────────────

alter table public.reports     enable row level security;
alter table public.edit_tokens enable row level security;
alter table public.admin_users enable row level security;

grant select on public.reports     to anon, authenticated;
grant select on public.admin_users to authenticated;
-- No insert/update/delete grants on reports or edit_tokens for anon/authenticated
-- at all — every mutation goes through the SECURITY DEFINER functions below,
-- which run with the table owner's privileges and bypass RLS after doing
-- their own explicit checks in plain SQL/plpgsql.

-- Public reads only "active" reports; signed-in admins read everything.
drop policy if exists "reports_select_active_or_admin" on public.reports;
create policy "reports_select_active_or_admin"
  on public.reports for select
  using (
    status = 'active'
    or exists (select 1 from public.admin_users a where a.user_id = auth.uid())
  );

-- edit_tokens: intentionally NO policies at all -> every operation denied
-- for anon/authenticated. Only SECURITY DEFINER functions can touch it.

-- A signed-in user can check whether *they themselves* are an admin
-- (needed so the client can show/hide the admin dashboard).
drop policy if exists "admin_users_select_self" on public.admin_users;
create policy "admin_users_select_self"
  on public.admin_users for select
  using (user_id = auth.uid());

-- ─── STORAGE (report photos) ───────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-images', 'report-images', true, 10485760, array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do nothing;

drop policy if exists "report_images_public_read" on storage.objects;
create policy "report_images_public_read"
  on storage.objects for select
  using (bucket_id = 'report-images');

-- Uploads don't require login (reporting an item never needs an account).
-- Consider adding rate limiting / Supabase's built-in abuse protections if
-- this becomes a target for spam.
drop policy if exists "report_images_public_upload" on storage.objects;
create policy "report_images_public_upload"
  on storage.objects for insert
  with check (bucket_id = 'report-images');

-- ============================================================
-- RPC FUNCTIONS — all report writes go through these
-- ============================================================

-- ── PUBLIC: create a report, no login required ────────────────
create or replace function public.create_report(
  p_type text, p_category text, p_title text, p_description text,
  p_location text, p_contact text, p_image_url text default null
) returns table (id uuid, edit_token text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id    uuid;
  v_token text;
begin
  if p_type not in ('lost', 'found') then
    raise exception 'type must be "lost" or "found"';
  end if;
  if coalesce(trim(p_title), '') = ''       then raise exception 'title is required'; end if;
  if coalesce(trim(p_category), '') = ''    then raise exception 'category is required'; end if;
  if coalesce(trim(p_description), '') = '' then raise exception 'description is required'; end if;
  if coalesce(trim(p_location), '') = ''    then raise exception 'location is required'; end if;
  if coalesce(trim(p_contact), '') = ''     then raise exception 'contact is required'; end if;

  insert into public.reports (type, category, title, description, location, contact, image_url)
  values (p_type, trim(p_category), trim(p_title), trim(p_description), trim(p_location), trim(p_contact), p_image_url)
  returning reports.id into v_id;

  v_token := encode(gen_random_bytes(24), 'hex');
  insert into public.edit_tokens (token, report_id) values (v_token, v_id);

  return query select v_id, v_token;
end;
$$;

revoke all on function public.create_report from public;
grant execute on function public.create_report to anon, authenticated;

-- ── PUBLIC (token-gated): edit a report ────────────────────────
create or replace function public.update_report_by_token(
  p_id uuid, p_token text, p_updates jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report_id uuid;
begin
  select report_id into v_report_id from public.edit_tokens where token = p_token;

  if v_report_id is null or v_report_id <> p_id then
    raise exception 'This edit link is invalid or has expired.';
  end if;

  update public.reports set
    type        = coalesce(p_updates->>'type', type),
    category    = coalesce(p_updates->>'category', category),
    title       = coalesce(p_updates->>'title', title),
    description = coalesce(p_updates->>'description', description),
    location    = coalesce(p_updates->>'location', location),
    contact     = coalesce(p_updates->>'contact', contact),
    image_url   = coalesce(p_updates->>'imageUrl', image_url),
    updated_at  = now()
  where id = p_id;

  if not found then
    raise exception 'Report not found.';
  end if;
end;
$$;

revoke all on function public.update_report_by_token from public;
grant execute on function public.update_report_by_token to anon, authenticated;

-- ── PUBLIC (token-gated): mark resolved ────────────────────────
create or replace function public.resolve_report_by_token(p_id uuid, p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report_id uuid;
begin
  select report_id into v_report_id from public.edit_tokens where token = p_token;
  if v_report_id is null or v_report_id <> p_id then
    raise exception 'This edit link is invalid or has expired.';
  end if;

  update public.reports
  set status = 'resolved', resolved_at = now(), updated_at = now()
  where id = p_id;
end;
$$;

revoke all on function public.resolve_report_by_token from public;
grant execute on function public.resolve_report_by_token to anon, authenticated;

-- ── PUBLIC (token-gated): soft delete ──────────────────────────
create or replace function public.delete_report_by_token(p_id uuid, p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report_id uuid;
begin
  select report_id into v_report_id from public.edit_tokens where token = p_token;
  if v_report_id is null or v_report_id <> p_id then
    raise exception 'This edit link is invalid or has expired.';
  end if;

  update public.reports
  set status = 'deleted', deleted_at = now(), updated_at = now()
  where id = p_id;
end;
$$;

revoke all on function public.delete_report_by_token from public;
grant execute on function public.delete_report_by_token to anon, authenticated;

-- ── ADMIN: set status only (archive / restore / resolve / delete) ─
create or replace function public.admin_set_status(p_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    raise exception 'Admin privileges required.';
  end if;
  if p_status not in ('active', 'resolved', 'deleted', 'archived') then
    raise exception 'Invalid status.';
  end if;

  update public.reports set
    status      = p_status,
    resolved_at = case when p_status = 'resolved' then now() else resolved_at end,
    deleted_at  = case when p_status = 'deleted'  then now() else deleted_at end,
    updated_at  = now()
  where id = p_id;
end;
$$;

revoke all on function public.admin_set_status from public;
grant execute on function public.admin_set_status to authenticated;

-- ── ADMIN: update any field on any report ──────────────────────
create or replace function public.admin_update_report(p_id uuid, p_updates jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    raise exception 'Admin privileges required.';
  end if;

  update public.reports set
    type        = coalesce(p_updates->>'type', type),
    category    = coalesce(p_updates->>'category', category),
    title       = coalesce(p_updates->>'title', title),
    description = coalesce(p_updates->>'description', description),
    location    = coalesce(p_updates->>'location', location),
    contact     = coalesce(p_updates->>'contact', contact),
    image_url   = coalesce(p_updates->>'imageUrl', image_url),
    status      = coalesce(p_updates->>'status', status),
    resolved_at = case when p_updates->>'status' = 'resolved' then now() else resolved_at end,
    deleted_at  = case when p_updates->>'status' = 'deleted'  then now() else deleted_at end,
    updated_at  = now()
  where id = p_id;
end;
$$;

revoke all on function public.admin_update_report from public;
grant execute on function public.admin_update_report to authenticated;

-- ── ADMIN: create a report directly ─────────────────────────────
create or replace function public.admin_create_report(
  p_type text, p_category text, p_title text, p_description text,
  p_location text, p_contact text, p_image_url text default null, p_status text default 'active'
) returns table (id uuid, edit_token text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id    uuid;
  v_token text;
begin
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    raise exception 'Admin privileges required.';
  end if;
  if p_type not in ('lost', 'found') then
    raise exception 'type must be "lost" or "found"';
  end if;
  if p_status not in ('active', 'resolved', 'deleted', 'archived') then
    raise exception 'Invalid status.';
  end if;

  insert into public.reports (type, category, title, description, location, contact, image_url, status)
  values (p_type, trim(p_category), trim(p_title), trim(p_description), trim(p_location), trim(p_contact), p_image_url, p_status)
  returning reports.id into v_id;

  v_token := encode(gen_random_bytes(24), 'hex');
  insert into public.edit_tokens (token, report_id) values (v_token, v_id);

  return query select v_id, v_token;
end;
$$;

revoke all on function public.admin_create_report from public;
grant execute on function public.admin_create_report to authenticated;

-- ── ADMIN: permanently delete (hard delete) ─────────────────────
create or replace function public.admin_delete_permanently(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.admin_users where user_id = auth.uid()) then
    raise exception 'Admin privileges required.';
  end if;

  delete from public.reports where id = p_id;
end;
$$;

revoke all on function public.admin_delete_permanently from public;
grant execute on function public.admin_delete_permanently to authenticated;
