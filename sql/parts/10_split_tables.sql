-- Pestis: give each kind of record its own table.
--
--   stations                 one row per station (barcode, name, type, floor plan + pin)
--   site_maps                floor plans
--   visits                   completed visits (type, technician, sign in/out, notes, services done)
--   recommendation_updates   notes / status changes / extra photos on recommendations
--   site_events              site activity (visit started/cancelled, site edits, plans, pins, barcode changes)
--   preparations, species, station_types   the lists in Settings (one table each)
--   app_settings             team-wide settings
--
-- service_logs keeps only station service records. Existing records are copied into the new tables,
-- then the old copies are removed from service_logs.
-- Needs pestis_recommendations.sql to have been run first. Safe to run again.
-- Everything runs as one unit: if any step fails, nothing is changed.

set timezone = 'UTC';

do $$ begin
    if to_regclass('public.recommendations') is null then
        raise exception 'Run pestis_recommendations.sql first, then run this script.';
    end if;
end $$;

-- ---------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------
create or replace function public.pestis_is_approved()
returns boolean language sql security definer stable set search_path = public as $$
    select exists (select 1 from public.profiles where id = auth.uid() and approved);
$$;
create or replace function public.pestis_is_admin()
returns boolean language sql security definer stable set search_path = public as $$
    select exists (select 1 from public.profiles where id = auth.uid() and approved and role = 'admin');
$$;
revoke all on function public.pestis_is_approved() from public;
revoke all on function public.pestis_is_admin() from public;
grant execute on function public.pestis_is_approved() to authenticated;
grant execute on function public.pestis_is_admin() to authenticated;

-- A time written by the app, or null if it can't be read
create or replace function public.pestis_try_ts(t text)
returns timestamptz language plpgsql immutable as $$
begin
    if t is null or t !~ '^\d{4}-\d{2}-\d{2}' then return null; end if;
    return t::timestamptz;
exception when others then
    return null;
end $$;

-- ---------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------
create table if not exists public.site_maps (
    id          text primary key,
    client_id   text not null,
    name        text not null default 'Floor plan',
    image_path  text,                                   -- in the station-photos storage bucket
    width       integer,
    height      integer,
    sort        double precision not null default 0,
    created_by  text,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index if not exists site_maps_client_idx on public.site_maps (client_id);

create table if not exists public.stations (
    id          text primary key,
    client_id   text not null,
    barcode     text not null,
    name        text not null default '',
    type        text,
    map_id      text references public.site_maps(id) on delete set null,
    pin_x       double precision,                       -- 0..1 across the plan
    pin_y       double precision,                       -- 0..1 down the plan
    created_by  text,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    unique (client_id, barcode)
);
create index if not exists stations_client_idx on public.stations (client_id);

create table if not exists public.visits (
    id                 text primary key,
    client_id          text not null,
    visit_type         text,
    technician         text,
    technician_id      uuid default auth.uid(),
    started_at         timestamptz,                     -- when the visit was started in the app
    completed_at       timestamptz not null default now(),
    signed_in_at       timestamptz,                     -- corrected times, if edited
    signed_out_at      timestamptz,
    notes              text,
    services_completed jsonb not null default '[]'::jsonb,
    unscanned_count    integer,
    edited_at          timestamptz,
    edited_by          text,
    created_at         timestamptz not null default now()
);
create index if not exists visits_client_idx on public.visits (client_id);

create table if not exists public.recommendation_updates (
    id          text primary key,
    rec_id      text not null,
    client_id   text not null,
    status      text,
    note        text,
    photos      jsonb not null default '[]'::jsonb,
    technician  text,
    at          timestamptz not null default now(),
    created_at  timestamptz not null default now()
);
create index if not exists recommendation_updates_client_idx on public.recommendation_updates (client_id);
create index if not exists recommendation_updates_rec_idx on public.recommendation_updates (rec_id);

create table if not exists public.site_events (
    id          text primary key,
    client_id   text not null,
    action      text,
    title       text,
    detail      text,
    station     text,
    technician  text,
    at          timestamptz not null default now(),
    created_at  timestamptz not null default now()
);
create index if not exists site_events_client_idx on public.site_events (client_id);

create table if not exists public.preparations (
    id text primary key, label text not null, unit text not null default 'each', sort integer not null default 0,
    created_at timestamptz not null default now()
);
create table if not exists public.species (
    id text primary key, label text not null, sort integer not null default 0,
    created_at timestamptz not null default now()
);
create table if not exists public.station_types (
    id text primary key, label text not null, sort integer not null default 0,
    created_at timestamptz not null default now()
);
create table if not exists public.app_settings (
    key text primary key, value jsonb, updated_by text, updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- 2. Access rules
--    Site records: any approved staff member. Lists and team settings: everyone reads, admins change.
-- ---------------------------------------------------------------
do $$
declare
    t text;
begin
    foreach t in array array['site_maps', 'stations', 'visits', 'recommendation_updates', 'site_events'] loop
        execute format('alter table public.%I enable row level security', t);
        execute format('drop policy if exists "Approved staff read" on public.%I', t);
        execute format('drop policy if exists "Approved staff add" on public.%I', t);
        execute format('drop policy if exists "Approved staff change" on public.%I', t);
        execute format('drop policy if exists "Approved staff remove" on public.%I', t);
        execute format('create policy "Approved staff read" on public.%I for select to authenticated using (public.pestis_is_approved())', t);
        execute format('create policy "Approved staff add" on public.%I for insert to authenticated with check (public.pestis_is_approved())', t);
        execute format('create policy "Approved staff change" on public.%I for update to authenticated using (public.pestis_is_approved()) with check (public.pestis_is_approved())', t);
        execute format('create policy "Approved staff remove" on public.%I for delete to authenticated using (public.pestis_is_approved())', t);
        execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    end loop;
    foreach t in array array['preparations', 'species', 'station_types', 'app_settings'] loop
        execute format('alter table public.%I enable row level security', t);
        execute format('drop policy if exists "Approved staff read" on public.%I', t);
        execute format('drop policy if exists "Admins add" on public.%I', t);
        execute format('drop policy if exists "Admins change" on public.%I', t);
        execute format('drop policy if exists "Admins remove" on public.%I', t);
        execute format('create policy "Approved staff read" on public.%I for select to authenticated using (public.pestis_is_approved())', t);
        execute format('create policy "Admins add" on public.%I for insert to authenticated with check (public.pestis_is_admin())', t);
        execute format('create policy "Admins change" on public.%I for update to authenticated using (public.pestis_is_admin()) with check (public.pestis_is_admin())', t);
        execute format('create policy "Admins remove" on public.%I for delete to authenticated using (public.pestis_is_admin())', t);
        execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    end loop;
end $$;

-- ---------------------------------------------------------------
-- 3. Settings lists: copy from app_options
-- ---------------------------------------------------------------
do $$
declare
    has_unit boolean;
begin
    if to_regclass('public.app_options') is null then return; end if;
    select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'app_options' and column_name = 'unit') into has_unit;
    if has_unit then
        execute $q$ insert into public.preparations (id, label, unit, sort)
                    select id, label, coalesce(nullif(unit, ''), 'each'), coalesce(sort, 0) from public.app_options where kind = 'prep'
                    on conflict (id) do nothing $q$;
    else
        execute $q$ insert into public.preparations (id, label, sort)
                    select id, label, coalesce(sort, 0) from public.app_options where kind = 'prep'
                    on conflict (id) do nothing $q$;
    end if;
    insert into public.species (id, label, sort) select id, label, coalesce(sort, 0) from public.app_options where kind = 'species' on conflict (id) do nothing;
    insert into public.station_types (id, label, sort) select id, label, coalesce(sort, 0) from public.app_options where kind = 'station_type' on conflict (id) do nothing;
end $$;

-- ---------------------------------------------------------------
-- 4. Barcode changes recorded in service_logs: make sure every record uses the new barcode
-- ---------------------------------------------------------------
do $$
declare
    ch record;
begin
    for ch in
        select client_id, created_at, payload::jsonb->>'from' as f, payload::jsonb->>'to' as t
        from public.service_logs
        where barcode_id = 'BARCODE_CHANGE' and coalesce(payload::jsonb->>'from', '') <> '' and coalesce(payload::jsonb->>'to', '') <> ''
        order by created_at
    loop
        update public.service_logs set barcode_id = ch.t
         where client_id = ch.client_id and barcode_id = ch.f and created_at <= ch.created_at;
        update public.recommendations set station_barcode = ch.t
         where client_id = ch.client_id::text and station_barcode = ch.f;
    end loop;
end $$;

-- Follows recorded barcode changes from an old barcode to the station's current one
create or replace function public.pestis_current_barcode(cid text, code text)
returns text language plpgsql stable as $$
declare
    nxt text;
    guard integer := 0;
begin
    loop
        select payload::jsonb->>'to' into nxt from public.service_logs
         where client_id::text = cid and barcode_id = 'BARCODE_CHANGE' and payload::jsonb->>'from' = code
         order by created_at desc limit 1;
        exit when nxt is null or nxt = code or guard > 20;
        code := nxt; guard := guard + 1;
    end loop;
    return code;
end $$;

-- ---------------------------------------------------------------
-- 5. Floor plans
-- ---------------------------------------------------------------
with m as (
    select client_id::text as cid, created_at, payload::jsonb as p
    from public.service_logs where barcode_id = 'SITE_MAP' and coalesce(payload::jsonb->>'mapId', '') <> ''
),
latest as (
    select distinct on (p->>'mapId') * from m order by p->>'mapId', created_at desc
),
first_seen as (
    select p->>'mapId' as id, min(created_at) as at from m group by p->>'mapId'
),
image as (
    select distinct on (p->>'mapId') p->>'mapId' as id,
           coalesce(case when jsonb_typeof(p->'photos') = 'array' then p->'photos'->>0 end, p->>'photo') as path
    from m
    where coalesce(case when jsonb_typeof(p->'photos') = 'array' then p->'photos'->>0 end, p->>'photo') is not null
    order by p->>'mapId', created_at desc
)
insert into public.site_maps (id, client_id, name, image_path, width, height, sort, created_by, created_at, updated_at)
select l.p->>'mapId', l.cid, coalesce(nullif(l.p->>'name', ''), 'Floor plan'), i.path,
       case when (l.p->>'w') ~ '^\d+$' then (l.p->>'w')::int end,
       case when (l.p->>'h') ~ '^\d+$' then (l.p->>'h')::int end,
       case when (l.p->>'order') ~ '^-?\d+(\.\d+)?$' then (l.p->>'order')::double precision else extract(epoch from f.at) end,
       l.p->>'technician', f.at, l.created_at
from latest l
join first_seen f on f.id = l.p->>'mapId'
left join image i on i.id = l.p->>'mapId'
where coalesce(l.p->>'deleted', 'false') <> 'true'
on conflict (id) do nothing;

-- ---------------------------------------------------------------
-- 6. Stations (name and type from their latest record; pin from their latest pin record)
-- ---------------------------------------------------------------
with svc as (
    select client_id::text as cid, barcode_id, created_at, payload::jsonb as p
    from public.service_logs
    where barcode_id not in ('SITE_VISIT_SUMMARY', 'REC_UPDATE', 'SITE_MAP', 'MAP_PIN', 'BARCODE_CHANGE', 'SITE_CHANGE')
      and client_id is not null
),
named as (
    select distinct on (cid, barcode_id) cid, barcode_id, p->>'locationName' as name
    from svc where coalesce(p->>'locationName', '') <> '' order by cid, barcode_id, created_at desc
),
typed as (
    select distinct on (cid, barcode_id) cid, barcode_id, p->>'deviceType' as type
    from svc where coalesce(p->>'deviceType', '') <> '' order by cid, barcode_id, created_at desc
),
firsts as (
    select cid, barcode_id, min(created_at) as at,
           (array_agg(p->>'technician' order by created_at))[1] as by
    from svc group by cid, barcode_id
),
pins as (
    select distinct on (cid, code) cid, code, p
    from (
        select client_id::text as cid, public.pestis_current_barcode(client_id::text, payload::jsonb->>'barcode') as code, created_at, payload::jsonb as p
        from public.service_logs where barcode_id = 'MAP_PIN' and coalesce(payload::jsonb->>'barcode', '') <> ''
    ) x
    order by cid, code, created_at desc
)
insert into public.stations (id, client_id, barcode, name, type, map_id, pin_x, pin_y, created_by, created_at, updated_at)
select gen_random_uuid()::text, f.cid, f.barcode_id, coalesce(n.name, 'Unnamed station'), t.type,
       sm.id,
       case when sm.id is not null and (pn.p->>'x') ~ '^-?\d+(\.\d+)?$' then (pn.p->>'x')::double precision end,
       case when sm.id is not null and (pn.p->>'y') ~ '^-?\d+(\.\d+)?$' then (pn.p->>'y')::double precision end,
       f.by, f.at, now()
from firsts f
left join named n on n.cid = f.cid and n.barcode_id = f.barcode_id
left join typed t on t.cid = f.cid and t.barcode_id = f.barcode_id
left join pins pn on pn.cid = f.cid and pn.code = f.barcode_id
left join public.site_maps sm on sm.id = pn.p->>'mapId'
on conflict (client_id, barcode) do nothing;

-- ---------------------------------------------------------------
-- 7. Visits (the latest version of each completed visit)
-- ---------------------------------------------------------------
with s as (
    select client_id::text as cid, created_at, payload::jsonb as p,
           coalesce(payload::jsonb->>'clientRef', 'SITE_VISIT_SUMMARY@' || (to_json(created_at) #>> '{}')) as key
    from public.service_logs where barcode_id = 'SITE_VISIT_SUMMARY'
),
replaced as (select distinct p->>'supersedes' as ref from s where p ? 'supersedes')
insert into public.visits (id, client_id, visit_type, technician, started_at, completed_at, signed_in_at, signed_out_at,
                           notes, services_completed, unscanned_count, edited_at, edited_by, created_at, technician_id)
select key, cid, coalesce(p->>'visitType', 'Routine Service'), p->>'technician',
       public.pestis_try_ts(p->>'startedAt'),
       coalesce(public.pestis_try_ts(p->>'completedAt'), created_at),
       public.pestis_try_ts(p->>'signedInAt'),
       public.pestis_try_ts(p->>'signedOutAt'),
       p->>'siteNotes',
       case when jsonb_typeof(p->'servicesCompleted') = 'array' then p->'servicesCompleted' else '[]'::jsonb end,
       case when (p->>'unscannedCount') ~ '^\d+$' then (p->>'unscannedCount')::int end,
       public.pestis_try_ts(p->>'editedAt'), p->>'editedBy', created_at, null
from s
where not exists (select 1 from replaced r where r.ref = s.key)
on conflict (id) do nothing;

-- ---------------------------------------------------------------
-- 8. Recommendation updates
-- ---------------------------------------------------------------
insert into public.recommendation_updates (id, rec_id, client_id, status, note, photos, technician, at, created_at)
select coalesce(p->>'clientRef', 'REC_UPDATE@' || (to_json(created_at) #>> '{}')), p->>'recRef', cid,
       case when p->>'status' = 'new' then 'open' else p->>'status' end,
       nullif(p->>'note', ''),
       case when jsonb_typeof(p->'photos') = 'array' then p->'photos'
            when coalesce(p->>'photo', '') <> '' then jsonb_build_array(p->>'photo') else '[]'::jsonb end,
       p->>'technician',
       coalesce(public.pestis_try_ts(p->>'servicedAt'), created_at), created_at
from (select client_id::text as cid, created_at, payload::jsonb as p from public.service_logs where barcode_id = 'REC_UPDATE') u
where coalesce(p->>'recRef', '') <> ''
on conflict (id) do nothing;

-- ---------------------------------------------------------------
-- 9. Site activity (so the activity log keeps its history)
-- ---------------------------------------------------------------
with e as (
    select client_id::text as cid, barcode_id, created_at, payload::jsonb as p,
           coalesce(payload::jsonb->>'clientRef', barcode_id || '@' || (to_json(created_at) #>> '{}')) as key,
           row_number() over (partition by client_id, barcode_id, payload::jsonb->>'mapId' order by created_at) as nth
    from public.service_logs
    where barcode_id in ('SITE_CHANGE', 'SITE_MAP', 'MAP_PIN', 'BARCODE_CHANGE')
)
insert into public.site_events (id, client_id, action, title, detail, station, technician, at, created_at)
select key, cid,
       case barcode_id when 'SITE_CHANGE' then coalesce(p->>'action', 'site_edit')
                       when 'SITE_MAP' then 'floor_plan' when 'MAP_PIN' then 'pin' else 'barcode_change' end,
       case barcode_id
           when 'SITE_CHANGE' then case p->>'action' when 'visit_started' then 'Visit started · ' || coalesce(p->>'visitType', 'Routine Service')
                                                     when 'visit_cancelled' then 'Visit cancelled'
                                                     else coalesce(p->>'title', 'Site details changed') end
           when 'SITE_MAP' then case when p->>'deleted' = 'true' then 'Floor plan "' || coalesce(p->>'name', '') || '" removed'
                                     when nth = 1 then 'Floor plan "' || coalesce(p->>'name', '') || '" added'
                                     else 'Floor plan "' || coalesce(p->>'name', '') || '" updated' end
           when 'MAP_PIN' then case when coalesce(p->>'mapId', '') = '' then 'Removed from floor plan'
                                    when p->>'x' is null then 'Assigned to a floor plan'
                                    else 'Pin placed on a floor plan' end
           else 'Barcode changed ' || coalesce(p->>'from', '') || ' → ' || coalesce(p->>'to', '')
       end,
       case barcode_id when 'SITE_CHANGE' then coalesce(p->>'detail', p->>'note') end,
       case when barcode_id in ('MAP_PIN', 'BARCODE_CHANGE') then p->>'locationName' end,
       p->>'technician',
       coalesce(public.pestis_try_ts(p->>'servicedAt'), created_at), created_at
from e
on conflict (id) do nothing;

-- ---------------------------------------------------------------
-- 10. Recommendation status follows the updates table
-- ---------------------------------------------------------------
drop trigger if exists pestis_apply_rec_update on public.service_logs;
create or replace function public.pestis_apply_rec_update()
returns trigger language plpgsql security definer set search_path = public as $$
declare
    st text := case when new.status = 'new' then 'open' else new.status end;
begin
    if st not in ('open', 'pending', 'complete') then st := 'pending'; end if;
    update public.recommendations
       set status = st,
           completed_at = case when st = 'complete' then new.at else null end,
           updated_at = now()
     where id = new.rec_id;
    return new;
end $$;
drop trigger if exists pestis_apply_rec_update on public.recommendation_updates;
create trigger pestis_apply_rec_update after insert on public.recommendation_updates
    for each row execute function public.pestis_apply_rec_update();

-- ---------------------------------------------------------------
-- 11. Remove the old copies from service_logs (everything above has been copied)
-- ---------------------------------------------------------------
-- a) site-level records
delete from public.service_logs
 where barcode_id in ('SITE_VISIT_SUMMARY', 'REC_UPDATE', 'SITE_MAP', 'MAP_PIN', 'BARCODE_CHANGE', 'SITE_CHANGE');

-- b) recommendations saved as their own record (now in the recommendations table)
delete from public.service_logs s
 where coalesce(s.payload::jsonb->>'recOnly', 'false') = 'true'
   and exists (select 1 from public.recommendations r
                where r.id = coalesce(s.payload::jsonb->>'recRef', s.payload::jsonb->>'clientRef'));

-- c) recommendations stored inside a station service record: keep the service, remove the copied recommendation
update public.service_logs s
   set payload = (s.payload::jsonb - array['recommendation', 'recommendationNote', 'recRef', 'recNo', 'recCreatedAt', 'photos', 'photo'])
 where coalesce(s.payload::jsonb->>'recommendation', s.payload::jsonb->>'recommendationNote', s.payload::jsonb->>'photo') is not null
   and exists (select 1 from public.recommendations r
                where r.id = coalesce(s.payload::jsonb->>'recRef', s.payload::jsonb->>'clientRef', s.barcode_id || '@' || (to_json(s.created_at) #>> '{}')));

notify pgrst, 'reload schema';
