-- Pestis r14 database update
--   1. Preparation units (each / ml / L / g / kg)
--   2. Only admins can add or remove preparations, species and station types
--   3. New standard station types (toxic rodent, pest sighting register, inspection point)
--   4. Changing a station's barcode (moves its records)
--   5. Recommendation numbers (R-0001, R-0002 ... across the whole company)
-- Run once in Supabase -> SQL Editor. Safe to run again.

-- ---------------------------------------------------------------
-- Helpers: is the signed-in user approved / an admin?
-- ---------------------------------------------------------------
create or replace function public.pestis_is_approved()
returns boolean language sql security definer stable set search_path = public as $$
    select exists (select 1 from public.profiles where id = auth.uid() and approved);
$$;
revoke all on function public.pestis_is_approved() from public;
grant execute on function public.pestis_is_approved() to authenticated;

create or replace function public.pestis_is_admin()
returns boolean language sql security definer stable set search_path = public as $$
    select exists (select 1 from public.profiles where id = auth.uid() and approved and role = 'admin');
$$;
revoke all on function public.pestis_is_admin() from public;
grant execute on function public.pestis_is_admin() to authenticated;

-- ---------------------------------------------------------------
-- 1. Preparation units
-- ---------------------------------------------------------------
alter table public.app_options add column if not exists unit text;

-- ---------------------------------------------------------------
-- 2. Settings lists: everyone approved can read, only admins can change
-- ---------------------------------------------------------------
drop policy if exists "Approved staff add options"    on public.app_options;
drop policy if exists "Approved staff update options" on public.app_options;
drop policy if exists "Approved staff delete options" on public.app_options;
drop policy if exists "Admins add options"    on public.app_options;
drop policy if exists "Admins update options" on public.app_options;
drop policy if exists "Admins delete options" on public.app_options;

create policy "Admins add options" on public.app_options
    for insert to authenticated with check (public.pestis_is_admin());
create policy "Admins update options" on public.app_options
    for update to authenticated using (public.pestis_is_admin()) with check (public.pestis_is_admin());
create policy "Admins delete options" on public.app_options
    for delete to authenticated using (public.pestis_is_admin());

-- ---------------------------------------------------------------
-- 3. New standard station types (added only if your team already has its own list,
--    and only the ones that aren't there yet)
-- ---------------------------------------------------------------
insert into public.app_options (id, kind, label, sort)
select v.id, 'station_type', v.label, v.sort
from (values
    ('seed-station-6', 'External Toxic Rodent Station', 6),
    ('seed-station-7', 'Internal Toxic Rodent Station', 7),
    ('seed-station-8', 'Pest Sighting Register',        8),
    ('seed-station-9', 'Inspection Point',              9)
) as v(id, label, sort)
where exists (select 1 from public.app_options where kind = 'station_type')
  and not exists (select 1 from public.app_options o where o.kind = 'station_type' and lower(o.label) = lower(v.label))
on conflict (id) do nothing;

-- ---------------------------------------------------------------
-- 4. Changing a station's barcode updates its existing records
-- ---------------------------------------------------------------
drop policy if exists "Approved staff can update service logs" on public.service_logs;
create policy "Approved staff can update service logs" on public.service_logs
    for update to authenticated using (public.pestis_is_approved()) with check (public.pestis_is_approved());

-- ---------------------------------------------------------------
-- 5. Recommendation numbers
--    Every new recommendation gets the next number when it reaches the database.
--    Re-saving the same recommendation keeps its number.
-- ---------------------------------------------------------------
create sequence if not exists public.pestis_rec_no_seq;
create index if not exists service_logs_rec_ref_idx on public.service_logs (client_id, (payload->>'recRef'));

create or replace function public.pestis_assign_rec_no()
returns trigger language plpgsql security definer set search_path = public as $$
declare
    existing bigint;
begin
    if new.payload is null
       or new.barcode_id in ('SITE_VISIT_SUMMARY', 'REC_UPDATE', 'SITE_MAP', 'MAP_PIN', 'BARCODE_CHANGE', 'SITE_CHANGE')
       or new.payload ? 'recNo'
       or coalesce(new.payload->>'recommendation', new.payload->>'recommendationNote', '') = '' then
        return new;
    end if;
    if new.payload ? 'recRef' then
        select (payload->>'recNo')::bigint into existing
        from public.service_logs
        where client_id = new.client_id and payload->>'recRef' = new.payload->>'recRef' and payload ? 'recNo'
        limit 1;
    end if;
    new.payload := new.payload || jsonb_build_object('recNo', coalesce(existing, nextval('public.pestis_rec_no_seq')));
    return new;
end $$;

drop trigger if exists pestis_assign_rec_no on public.service_logs;
create trigger pestis_assign_rec_no
    before insert on public.service_logs
    for each row execute function public.pestis_assign_rec_no();

-- Number the recommendations already on record, oldest first
do $$
declare
    start_no bigint;
    top_no   bigint;
begin
    select coalesce(max((payload->>'recNo')::bigint), 0) into start_no
    from public.service_logs where payload ? 'recNo';

    with rec_rows as (
        select ctid as rid, created_at,
               coalesce(payload->>'recRef', payload->>'clientRef', barcode_id || '@' || created_at::text) as rkey
        from public.service_logs
        where barcode_id not in ('SITE_VISIT_SUMMARY', 'REC_UPDATE', 'SITE_MAP', 'MAP_PIN', 'BARCODE_CHANGE', 'SITE_CHANGE')
          and payload is not null
          and not (payload ? 'recNo')
          and (
              coalesce(payload->>'recommendation', payload->>'recommendationNote', '') <> ''
              or coalesce(payload->>'photo', '') <> ''
              or (case when jsonb_typeof(payload->'photos') = 'array' then jsonb_array_length(payload->'photos') > 0 else false end)
          )
    ),
    firsts as (
        select rkey, min(created_at) as first_at from rec_rows group by rkey
    ),
    numbered as (
        select rkey, start_no + row_number() over (order by first_at, rkey) as n from firsts
    )
    update public.service_logs s
    set payload = s.payload || jsonb_build_object('recNo', numbered.n)
    from rec_rows join numbered using (rkey)
    where s.ctid = rec_rows.rid;

    select coalesce(max((payload->>'recNo')::bigint), 0) into top_no
    from public.service_logs where payload ? 'recNo';
    perform setval('public.pestis_rec_no_seq', greatest(top_no, 1), top_no > 0);
end $$;

notify pgrst, 'reload schema';
