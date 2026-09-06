-- ============================================================
-- FOUNDLY — Patch: allow explicitly clearing a report's photo
-- ------------------------------------------------------------
-- The original update_report_by_token / admin_update_report functions
-- used `coalesce(p_updates->>'imageUrl', image_url)` for the photo field.
-- COALESCE can't tell "the caller didn't send imageUrl" apart from
-- "the caller sent imageUrl: null" — both look like SQL NULL, so a
-- deliberate "remove this photo" request was silently ignored and the
-- old photo stuck around.
--
-- Fix: use the `?` jsonb "does this key exist" operator instead, so
-- presence of the key (even with a null value) means "set it",
-- and absence means "leave it alone".
-- ============================================================

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
    image_url   = case when p_updates ? 'imageUrl' then p_updates->>'imageUrl' else image_url end,
    updated_at  = now()
  where id = p_id;

  if not found then
    raise exception 'Report not found.';
  end if;
end;
$$;

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
    image_url   = case when p_updates ? 'imageUrl' then p_updates->>'imageUrl' else image_url end,
    status      = coalesce(p_updates->>'status', status),
    resolved_at = case when p_updates->>'status' = 'resolved' then now() else resolved_at end,
    deleted_at  = case when p_updates->>'status' = 'deleted'  then now() else deleted_at end,
    updated_at  = now()
  where id = p_id;
end;
$$;
