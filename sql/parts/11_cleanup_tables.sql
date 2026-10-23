-- ===================================================================
-- Pestis: remove two tables the apps no longer use
--   * app_options      - the old settings lists. The lists now live in preparations, species and station_types.
--   * critical_limits  - critical limits are switched off in both apps while they are rebuilt.
-- Also removes the three database functions that only critical limits used.
--
-- Both tables are copied into a private backup schema first (pestis_backup), so nothing is lost.
-- The backup schema is not reachable from the apps or the API.
--
-- Run once in Supabase -> SQL Editor. Safe to run again (it skips what's already done).
-- Run it AFTER uploading the r36 apps (they no longer read either table).
-- ===================================================================

-- Everything runs as one transaction: if any step fails, nothing is changed.
begin;

-- 1. Safety check: the settings lists must already be in their own tables
do $$
declare lists integer := 0; old integer := 0;
begin
    if to_regclass('public.preparations') is null or to_regclass('public.species') is null or to_regclass('public.station_types') is null then
        raise exception 'The settings list tables (preparations, species, station_types) are missing. Run pestis_split_tables.sql first. Nothing was changed.';
    end if;
    select (select count(*) from public.preparations) + (select count(*) from public.species) + (select count(*) from public.station_types) into lists;
    if to_regclass('public.app_options') is not null then
        execute 'select count(*) from public.app_options where kind in (''prep'', ''species'', ''station_type'')' into old;
    end if;
    if lists = 0 and old > 0 then
        raise exception 'The new list tables are empty but app_options still has % items. Run pestis_split_tables.sql first so they are copied across. Nothing was changed.', old;
    end if;
end $$;

-- 2. Back up both tables (only the first time; a later run keeps the original backup)
create schema if not exists pestis_backup;
revoke all on schema pestis_backup from public;
do $$ begin execute 'revoke all on schema pestis_backup from anon, authenticated'; exception when undefined_object then null; end $$;

do $$
begin
    if to_regclass('public.app_options') is not null and to_regclass('pestis_backup.app_options') is null then
        create table pestis_backup.app_options as table public.app_options;
        raise notice 'Backed up app_options: % rows', (select count(*) from pestis_backup.app_options);
    end if;
    if to_regclass('public.critical_limits') is not null and to_regclass('pestis_backup.critical_limits') is null then
        create table pestis_backup.critical_limits as table public.critical_limits;
        raise notice 'Backed up critical_limits: % rows', (select count(*) from pestis_backup.critical_limits);
    end if;
end $$;

-- 3. Remove the critical limits functions and both tables
drop function if exists public.portal_save_limit(text, text, text, text, numeric, text);
drop function if exists public.portal_delete_limit(text);
drop function if exists public.portal_rename_zone(text, text, text);
drop table if exists public.critical_limits cascade;
drop table if exists public.app_options cascade;

commit;

-- 4. What's left: the backups, and confirmation the tables are gone
select 'pestis_backup.app_options' as backup, case when to_regclass('pestis_backup.app_options') is null then 'none' else 'kept' end as status
union all
select 'pestis_backup.critical_limits', case when to_regclass('pestis_backup.critical_limits') is null then 'none' else 'kept' end
union all
select 'public.app_options', case when to_regclass('public.app_options') is null then 'removed' else 'STILL THERE' end
union all
select 'public.critical_limits', case when to_regclass('public.critical_limits') is null then 'removed' else 'STILL THERE' end;

notify pgrst, 'reload schema';

-- -------------------------------------------------------------------
-- To put a table back from the backup (only if ever needed), for example:
--   create table public.critical_limits as table pestis_backup.critical_limits;
-- When you're sure you don't need the backups any more:
--   drop schema pestis_backup cascade;
-- -------------------------------------------------------------------
