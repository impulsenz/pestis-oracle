-- Pestis: visit types and station types.
-- Run once in Supabase -> SQL Editor (after pestis_settings_update.sql). Safe to run again.

-- 1. The type of the visit that is currently in progress at a site (cleared when it's closed)
alter table public.clients add column if not exists visit_type text;

-- 2. Settings lists can now also hold station types
alter table public.app_options drop constraint if exists app_options_kind_check;
alter table public.app_options add constraint app_options_kind_check
    check (kind in ('prep', 'species', 'station_type'));

-- 3. Starting list of station types (only if none exist yet)
insert into public.app_options (id, kind, label, sort)
select * from (values
    ('seed-station-1', 'station_type', 'External Rodent Station',     1),
    ('seed-station-2', 'station_type', 'Internal Rodent Station',     2),
    ('seed-station-3', 'station_type', 'Flying Insect Station (ILT)', 3),
    ('seed-station-4', 'station_type', 'Crawling Insect Station',     4),
    ('seed-station-5', 'station_type', 'Snap Trap',                   5)
) as v(id, kind, label, sort)
where not exists (select 1 from public.app_options where kind = 'station_type');

notify pgrst, 'reload schema';
