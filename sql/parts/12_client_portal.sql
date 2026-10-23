-- Pestis: client portal (customers see their own sites; staff keep using the main app).
--
-- What this does
--   * client_users / client_access: client accounts (by email) and the sites each one can see. Admins manage both.
--   * A client is never "approved staff": staff rules keep working as before and do not let clients in.
--   * Extra safety rules ("restrictive" policies) on every Pestis table and on the photo/document storage, so that
--     - only approved staff can add, change or delete anything directly, and
--     - clients can only read data for the sites assigned to them.
--     These also close any old "open to everyone" rules left over from before Google sign-in.
--   * Clients change recommendations only through portal_update_recommendation(): status, a note and photos.
--   * Clients get a cleaned copy of their sites (no service notes, contract notes or safety notes) via portal_sites().
--   * site_documents table + private "site-documents" storage bucket for SDSs, insurance, agreements, maps...,
--     with folders (site_document_folders).
--   * recommendation_views: who has opened each recommendation, and when (pestis_mark_rec_viewed()).
--
-- Run once in Supabase -> SQL Editor, after pestis_split_tables.sql. Safe to run again.

set timezone = 'UTC';

do $$ begin
    if to_regclass('public.recommendations') is null or to_regclass('public.recommendation_updates') is null then
        raise exception 'Run pestis_recommendations.sql and pestis_split_tables.sql first.';
    end if;
end $$;

-- ---------------------------------------------------------------
-- 1. Client accounts and the sites they can see
-- ---------------------------------------------------------------
create table if not exists public.client_users (
    email         text primary key check (email = lower(email) and email like '%@%'),
    full_name     text,
    company       text,
    phone         text,
    active        boolean not null default true,      -- untick to suspend access
    notes         text,                               -- staff only
    added_by      text,
    created_at    timestamptz not null default now(),
    last_seen_at  timestamptz
);

create table if not exists public.client_access (
    email      text not null references public.client_users(email) on delete cascade on update cascade,
    client_id  text not null,                          -- clients.id
    added_by   text,
    added_at   timestamptz not null default now(),
    primary key (email, client_id)
);
create index if not exists client_access_client_idx on public.client_access (client_id);

-- ---------------------------------------------------------------
-- 2. Helper functions (used by the rules below)
-- ---------------------------------------------------------------
create or replace function public.pestis_is_approved()
returns boolean language sql security definer stable set search_path = public as $$
    select exists (select 1 from public.profiles where id = auth.uid() and approved);
$$;
create or replace function public.pestis_is_admin()
returns boolean language sql security definer stable set search_path = public as $$
    select exists (select 1 from public.profiles where id = auth.uid() and approved and role = 'admin');
$$;

-- The signed-in user's email, only once that email has been confirmed (Google, or the emailed sign-in link)
create or replace function public.pestis_my_email()
returns text language sql security definer stable set search_path = public, auth as $$
    select lower(u.email) from auth.users u
     where u.id = auth.uid() and u.email_confirmed_at is not null;
$$;

-- An active client account
create or replace function public.pestis_is_client()
returns boolean language sql security definer stable set search_path = public as $$
    select exists (select 1 from public.client_users c where c.email = public.pestis_my_email() and c.active);
$$;

-- Can the signed-in user see this site? (staff: every site; clients: their assigned sites)
create or replace function public.pestis_can_see_site(cid text)
returns boolean language sql security definer stable set search_path = public as $$
    select public.pestis_is_approved()
        or exists (select 1 from public.client_access a
                     join public.client_users c on c.email = a.email
                    where a.email = public.pestis_my_email() and c.active and a.client_id = cid);
$$;

-- Is the signed-in user an active client login for this particular site? (staff access doesn't count)
create or replace function public.pestis_is_site_client(cid text)
returns boolean language sql security definer stable set search_path = public as $$
    select exists (select 1 from public.client_access a join public.client_users c on c.email = a.email
                    where a.email = public.pestis_my_email() and c.active and a.client_id = cid);
$$;

-- Storage files: <site id>/... (photos, floor plans, documents) and site-covers/<site id>/... (site photos)
create or replace function public.pestis_file_site(path text)
returns text language sql immutable as $$
    select case when split_part(path, '/', 1) = 'site-covers' then split_part(path, '/', 2) else split_part(path, '/', 1) end;
$$;
create or replace function public.pestis_client_can_read_file(bucket text, path text)
returns boolean language sql security definer stable set search_path = public as $$
    select bucket in ('station-photos', 'site-documents')
       and public.pestis_is_client()
       and (public.pestis_can_see_site(public.pestis_file_site(path))
            or (bucket = 'station-photos' and split_part(path, '/', 1) = 'staff' and split_part(path, '/', 3) <> '')
            -- the shared library: preparation safety data sheets and pest guide pictures
            or (split_part(path, '/', 1) = 'library' and split_part(path, '/', 2) in ('sds', 'pests') and split_part(path, '/', 3) <> ''));
$$;
-- Clients may only add photos to recommendations, named <site id>/CLIENT_...
create or replace function public.pestis_client_can_upload(bucket text, path text)
returns boolean language sql security definer stable set search_path = public as $$
    select bucket = 'station-photos'
       and split_part(path, '/', 2) like 'CLIENT\_%'
       and split_part(path, '/', 3) = ''
       and public.pestis_is_client()
       and public.pestis_can_see_site(split_part(path, '/', 1));
$$;

do $$ declare f text; begin
    foreach f in array array['pestis_is_approved()', 'pestis_is_admin()', 'pestis_my_email()', 'pestis_is_client()',
                             'pestis_can_see_site(text)', 'pestis_is_site_client(text)', 'pestis_client_can_read_file(text, text)', 'pestis_client_can_upload(text, text)'] loop
        execute format('revoke all on function public.%s from public', f);
        execute format('grant execute on function public.%s to authenticated, anon', f);  -- anon: always "no", but must be allowed to ask
    end loop;
end $$;
grant execute on function public.pestis_file_site(text) to authenticated, anon;

-- ---------------------------------------------------------------
-- 3. Roles: one person can be a technician, an admin and a client (the admin chooses).
--    Staff access only ever comes from an admin approving them; a client login gives portal access only.
-- ---------------------------------------------------------------
drop trigger if exists pestis_keep_clients_out_of_staff on public.profiles;
drop trigger if exists pestis_zz_keep_clients_out_of_staff on public.profiles;
drop function if exists public.pestis_keep_clients_out_of_staff();

-- Only admins can change who is approved or their role (people can still edit their own name/photo)
create or replace function public.pestis_protect_profile_access()
returns trigger language plpgsql set search_path = public as $$
begin
    if auth.uid() is null or public.pestis_is_admin() then return new; end if;  -- sign-up process, or an admin
    if tg_op = 'INSERT' then
        new.approved := false;
        begin
            if to_regclass('public.allowed_emails') is not null then
                execute 'select coalesce(bool_or(true), false) from public.allowed_emails where lower(email) = lower($1)' into new.approved using new.email;
            end if;
        exception when others then new.approved := false;
        end;
    elsif new.approved is distinct from old.approved or new.role is distinct from old.role then
        raise exception 'Only an administrator can change approval or role.';
    end if;
    return new;
end $$;
drop trigger if exists pestis_protect_profile_access on public.profiles;
create trigger pestis_protect_profile_access before insert or update on public.profiles
    for each row execute function public.pestis_protect_profile_access();

-- Adding a client login: emails are kept lower-case (a staff member may also be a client)
create or replace function public.pestis_new_client_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    new.email := lower(trim(new.email));
    return new;
end $$;
drop trigger if exists pestis_new_client_user on public.client_users;
create trigger pestis_new_client_user before insert on public.client_users
    for each row execute function public.pestis_new_client_user();

-- ---------------------------------------------------------------
-- 4. Site documents (SDS, insurance, service agreements, maps ...)
-- ---------------------------------------------------------------
create table if not exists public.site_documents (
    id             text primary key default gen_random_uuid()::text,
    client_id      text not null,
    category       text not null default 'Other',
    title          text not null,
    file_path      text not null,                     -- in the site-documents bucket: <site id>/<file>
    file_name      text,
    mime_type      text,
    size_bytes     bigint,
    expires_on     date,
    notes          text,
    uploaded_by    text,
    uploaded_by_id uuid default auth.uid(),
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);
create index if not exists site_documents_client_idx on public.site_documents (client_id);

insert into storage.buckets (id, name, public, file_size_limit)
values ('site-documents', 'site-documents', false, 52428800)
on conflict (id) do nothing;

-- Folders for site documents (a document's folder is its "folder" name; empty folders are kept here)
alter table public.site_documents add column if not exists folder text;
create table if not exists public.site_document_folders (
    id          text primary key default gen_random_uuid()::text,
    client_id   text not null,
    name        text not null check (length(trim(name)) between 1 and 80),
    created_by  text,
    created_at  timestamptz not null default now(),
    unique (client_id, name)
);

-- ---------------------------------------------------------------
-- 4c. Who has opened each recommendation (one row per person, with first and last time)
-- ---------------------------------------------------------------
create table if not exists public.recommendation_views (
    rec_id         text not null,
    client_id      text not null,
    viewer_key     text not null,                       -- the signed-in user's id
    viewer_name    text,
    is_client      boolean not null default false,
    first_seen_at  timestamptz not null default now(),
    last_seen_at   timestamptz not null default now(),
    view_count     integer not null default 1,
    primary key (rec_id, viewer_key)
);
create index if not exists recommendation_views_client_idx on public.recommendation_views (client_id);

-- ---------------------------------------------------------------
-- 4d. Pest sighting register: the client reports a sighting, the technician actions and signs it off,
--     then the client reviews it. Clients add and review through portal_report_sighting() / portal_review_sighting().
-- ---------------------------------------------------------------
create table if not exists public.pest_sightings (
    id                  text primary key default gen_random_uuid()::text,
    client_id           text not null,
    sighting_no         integer,
    pest                text not null check (length(trim(pest)) between 1 and 80),
    location            text not null check (length(trim(location)) between 1 and 120),
    station_barcode     text,                                  -- nearest station, if the client picked one
    seen_at             timestamptz not null default now(),
    number_seen         integer check (number_seen is null or number_seen >= 0),
    evidence            text,                                  -- live pest, dead pest, droppings, damage...
    urgency             text not null default 'Routine' check (urgency in ('Routine', 'Urgent')),
    reported_by         text not null,
    reporter_contact    text,
    details             text,
    photos              jsonb not null default '[]'::jsonb,
    status              text not null default 'new' check (status in ('new', 'actioned', 'reviewed')),
    action_notes        text,
    actioned_by         text,                                  -- the technician who signed it off
    actioned_at         timestamptz,
    action_photos       jsonb not null default '[]'::jsonb,
    client_reviewed_by  text,
    client_reviewed_at  timestamptz,
    client_review_note  text,
    created_by          text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);
create index if not exists pest_sightings_client_idx on public.pest_sightings (client_id, seen_at);
create index if not exists pest_sightings_open_idx on public.pest_sightings (status) where status = 'new';

-- ---------------------------------------------------------------
-- 4e. Critical limits (rebuilt): each site's own limits, set up by an admin in Admin.
--     A limit has a name and a list of pests, each with how many captures a month are allowed:
--     rules = [{"species": "House fly", "max": 50}, ...]. Insect stations point at a limit by its id
--     (stations.limit_id), so renaming a limit never breaks anything.
--     The old critical limits are purged: their table, backup, functions, log entries and station areas.
-- ---------------------------------------------------------------
drop function if exists public.portal_save_limit(text, text, text, text, numeric, text);
drop function if exists public.portal_delete_limit(text);
drop function if exists public.portal_rename_zone(text, text, text);
drop table if exists public.critical_limits cascade;
do $$ begin
    if to_regclass('pestis_backup.critical_limits') is not null then execute 'drop table pestis_backup.critical_limits cascade'; end if;
    -- once only (before stations.limit_id exists): the old limits' log entries and station areas go
    if to_regclass('public.stations') is not null and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'stations' and column_name = 'limit_id') then
        if to_regclass('public.site_events') is not null then
            delete from public.site_events where action in ('limit', 'limit_breach', 'limit_change');
        end if;
        if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'stations' and column_name = 'zone') then
            execute 'update public.stations set zone = null where zone is not null';
        end if;
    end if;
end $$;

create table if not exists public.site_limits (
    id          text primary key default gen_random_uuid()::text,
    client_id   text not null,
    name        text not null check (length(trim(name)) between 1 and 80),
    rules       jsonb not null default '[]'::jsonb check (jsonb_typeof(rules) = 'array'),
    notes       text,
    created_by  text,
    created_at  timestamptz not null default now(),
    updated_by  text,
    updated_at  timestamptz not null default now()
);
create index if not exists site_limits_client_idx on public.site_limits (client_id);
alter table public.stations add column if not exists limit_id text;   -- site_limits.id (insect stations)

-- 4f. Site contacts: any number per site, each with a role and phone. One is the main contact (shown on the site
--     page). Staff (Service App, Admin) and that site's clients (Client Portal) can add, change and remove them.
--     The main contact (name and phone) is copied into the site's own contact field, so reports and older screens keep
--     working. The site's "email for reports" is left alone.
create table if not exists public.site_contacts (
    id          text primary key default gen_random_uuid()::text,
    client_id   text not null,
    name        text not null check (length(trim(name)) between 1 and 120),
    role        text check (role is null or length(role) <= 80),
    phone       text check (phone is null or length(phone) <= 40),
    email       text check (email is null or length(email) <= 160),
    notes       text check (notes is null or length(notes) <= 500),
    is_primary  boolean not null default false,
    sort        integer not null default 0,
    created_by  text,
    created_at  timestamptz not null default now(),
    updated_by  text,
    updated_at  timestamptz not null default now()
);
create index if not exists site_contacts_client_idx on public.site_contacts (client_id);

-- one main contact per site: making one the main contact makes the others ordinary contacts
create or replace function public.pestis_site_contact_before()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    new.name := trim(new.name);
    new.updated_at := now();
    begin
        new.updated_by := coalesce(public.pestis_my_name(), public.pestis_my_email(), new.updated_by);
    exception when undefined_function then
        new.updated_by := coalesce(public.pestis_my_email(), new.updated_by);
    end;
    if tg_op = 'INSERT' then
        new.created_by := coalesce(new.created_by, new.updated_by);
        -- the first contact of a site is its main contact
        if not exists (select 1 from public.site_contacts where client_id = new.client_id) then new.is_primary := true; end if;
    elsif old.is_primary and not new.is_primary and coalesce(current_setting('pestis.contact_switch', true), '') <> '1' then
        -- the main contact stays the main contact until another one is chosen
        new.is_primary := true;
    end if;
    if new.is_primary then
        perform set_config('pestis.contact_switch', '1', true);
        update public.site_contacts set is_primary = false where client_id = new.client_id and id <> new.id and is_primary;
        perform set_config('pestis.contact_switch', '', true);
    end if;
    return new;
end $$;

-- copy the main contact's name and phone into the site's contact field (anything that reads that keeps working)
create or replace function public.pestis_site_contact_after()
returns trigger language plpgsql security definer set search_path = public as $$
declare cid text := coalesce(new.client_id, old.client_id); m public.site_contacts;
begin
    if tg_op = 'DELETE' and old.is_primary then
        -- the main contact was removed: the next one becomes the main contact
        update public.site_contacts set is_primary = true
         where id = (select id from public.site_contacts where client_id = cid order by sort, created_at limit 1);
        return old;
    end if;
    select * into m from public.site_contacts where client_id = cid and is_primary limit 1;
    -- the site's contact column is "Contact" (or contact in older databases)
    declare col text := (select column_name from information_schema.columns where table_schema = 'public' and table_name = 'clients' and column_name in ('Contact', 'contact') order by column_name limit 1);
    begin
        if col is not null then
            execute format('update public.clients set %I = $1 where id::text = $2 and %I is distinct from $1', col, col)
                using nullif(trim(coalesce(m.name, '') || coalesce(' ' || nullif(trim(m.phone), ''), '')), ''), cid;
        end if;
    end;
    return coalesce(new, old);
end $$;

drop trigger if exists pestis_site_contact_before on public.site_contacts;
create trigger pestis_site_contact_before before insert or update on public.site_contacts
    for each row execute function public.pestis_site_contact_before();
drop trigger if exists pestis_site_contact_after on public.site_contacts;
create trigger pestis_site_contact_after after insert or update or delete on public.site_contacts
    for each row execute function public.pestis_site_contact_after();

-- "Jane Smith 021 123 4567" -> name "Jane Smith", phone "021 123 4567" (the old contact field held both)
create or replace function public.pestis_split_contact(v text, out name text, out phone text)
language sql immutable as $$
    select coalesce(nullif(trim(regexp_replace(replace(trim(v), p, ''), '[\s,·|-]+$', '')), ''), trim(v)), nullif(trim(p), '')
      from (select substring(trim(v) from '(\+?\d[\d\s()-]{6,}\d)') as p) x;
$$;

-- a new site's contact (Register New Site) becomes its first site contact
create or replace function public.pestis_new_site_contact()
returns trigger language plpgsql security definer set search_path = public as $$
declare j jsonb := to_jsonb(new);
begin
    if nullif(trim(coalesce(j->>'Contact', j->>'contact', '')), '') is not null
       and not exists (select 1 from public.site_contacts where client_id = new.id::text) then
        insert into public.site_contacts (client_id, name, phone, email, is_primary)
        select new.id::text, sc.name, sc.phone, nullif(trim(coalesce(j->>'Email', j->>'email', '')), ''), true from public.pestis_split_contact(coalesce(j->>'Contact', j->>'contact')) sc;
    end if;
    return new;
end $$;
drop trigger if exists pestis_new_site_contact on public.clients;
create trigger pestis_new_site_contact after insert on public.clients for each row execute function public.pestis_new_site_contact();

-- existing sites: their current contact becomes the first site contact (only sites with no contacts yet)
do $$
begin
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'clients' and column_name in ('Contact', 'contact')) then
        execute $q$
            insert into public.site_contacts (client_id, name, phone, email, is_primary, created_by)
            select c.id::text, sc.name, sc.phone, nullif(trim(coalesce(j->>'Email', j->>'email', '')), ''), true, 'Site details'
              from public.clients c, lateral (select to_jsonb(c) j) x, lateral public.pestis_split_contact(coalesce(j->>'Contact', j->>'contact')) sc
             where nullif(trim(coalesce(j->>'Contact', j->>'contact', '')), '') is not null
               and not exists (select 1 from public.site_contacts s where s.client_id = c.id::text)
        $q$;
    end if;
end $$;

-- ---------------------------------------------------------------
-- 5. Who can do what
-- ---------------------------------------------------------------
alter table public.client_users   enable row level security;
alter table public.client_access  enable row level security;
alter table public.site_documents enable row level security;
alter table public.site_document_folders enable row level security;
alter table public.recommendation_views enable row level security;
alter table public.pest_sightings enable row level security;
alter table public.site_limits enable row level security;
drop policy if exists "Staff read critical limits"    on public.site_limits;
drop policy if exists "Admins manage critical limits" on public.site_limits;
create policy "Staff read critical limits"    on public.site_limits for select to authenticated using (public.pestis_is_approved());
create policy "Admins manage critical limits" on public.site_limits for all to authenticated using (public.pestis_is_admin()) with check (public.pestis_is_admin());

-- site contacts: staff, and the site's own client logins, read and change them; nobody else sees them
alter table public.site_contacts enable row level security;
drop policy if exists "Site contacts: read"   on public.site_contacts;
drop policy if exists "Site contacts: add"    on public.site_contacts;
drop policy if exists "Site contacts: change" on public.site_contacts;
drop policy if exists "Site contacts: remove" on public.site_contacts;
create policy "Site contacts: read"   on public.site_contacts for select to authenticated using (public.pestis_is_approved() or public.pestis_is_site_client(client_id));
create policy "Site contacts: add"    on public.site_contacts for insert to authenticated with check (public.pestis_is_approved() or public.pestis_is_site_client(client_id));
create policy "Site contacts: change" on public.site_contacts for update to authenticated using (public.pestis_is_approved() or public.pestis_is_site_client(client_id)) with check (public.pestis_is_approved() or public.pestis_is_site_client(client_id));
create policy "Site contacts: remove" on public.site_contacts for delete to authenticated using (public.pestis_is_approved() or public.pestis_is_site_client(client_id));
revoke all on public.site_contacts from anon;

drop policy if exists "Admins manage client accounts" on public.client_users;
drop policy if exists "Staff see client accounts"     on public.client_users;
drop policy if exists "Clients see their own account" on public.client_users;
create policy "Admins manage client accounts" on public.client_users for all to authenticated using (public.pestis_is_admin()) with check (public.pestis_is_admin());
create policy "Staff see client accounts"     on public.client_users for select to authenticated using (public.pestis_is_approved());

drop policy if exists "Admins manage client site access" on public.client_access;
drop policy if exists "Staff see client site access"     on public.client_access;
drop policy if exists "Clients see their own sites"      on public.client_access;
create policy "Admins manage client site access" on public.client_access for all to authenticated using (public.pestis_is_admin()) with check (public.pestis_is_admin());
create policy "Staff see client site access"     on public.client_access for select to authenticated using (public.pestis_is_approved());
create policy "Clients see their own sites"      on public.client_access for select to authenticated using (email = public.pestis_my_email());

drop policy if exists "Staff read site documents"    on public.site_documents;
drop policy if exists "Admins manage site documents" on public.site_documents;
create policy "Staff read site documents"    on public.site_documents for select to authenticated using (public.pestis_is_approved());
create policy "Admins manage site documents" on public.site_documents for all to authenticated using (public.pestis_is_admin()) with check (public.pestis_is_admin());

drop policy if exists "Staff read document folders"    on public.site_document_folders;
drop policy if exists "Admins manage document folders" on public.site_document_folders;
create policy "Staff read document folders"    on public.site_document_folders for select to authenticated using (public.pestis_is_approved());
create policy "Admins manage document folders" on public.site_document_folders for all to authenticated using (public.pestis_is_admin()) with check (public.pestis_is_admin());


drop policy if exists "Staff read pest sightings"   on public.pest_sightings;
drop policy if exists "Staff action pest sightings" on public.pest_sightings;
drop policy if exists "Staff add pest sightings"    on public.pest_sightings;
create policy "Staff read pest sightings"   on public.pest_sightings for select to authenticated using (public.pestis_is_approved());
create policy "Staff action pest sightings" on public.pest_sightings for update to authenticated using (public.pestis_is_approved()) with check (public.pestis_is_approved());
create policy "Staff add pest sightings"    on public.pest_sightings for insert to authenticated with check (public.pestis_is_approved());

drop policy if exists "Staff read recommendation views" on public.recommendation_views;
create policy "Staff read recommendation views" on public.recommendation_views for select to authenticated using (public.pestis_is_approved());

grant select, insert, update, delete on public.client_users, public.client_access, public.site_documents,
    public.site_document_folders, public.recommendation_views, public.pest_sightings, public.site_limits, public.site_contacts to authenticated;

-- a) Clients may READ these for their own sites
do $$ declare t text; begin
    foreach t in array array['service_logs', 'recommendations', 'recommendation_updates', 'stations', 'site_maps', 'visits', 'site_documents',
                             'site_document_folders', 'recommendation_views', 'pest_sightings', 'site_limits'] loop
        if to_regclass('public.' || t) is null then continue; end if;
        execute format('drop policy if exists "Clients read their sites" on public.%I', t);
        execute format('create policy "Clients read their sites" on public.%I for select to authenticated using (public.pestis_is_client() and public.pestis_can_see_site(client_id::text))', t);
    end loop;
    -- the shared lists (preparations etc.) are readable by clients
    foreach t in array array['app_options', 'preparations', 'species', 'station_types'] loop
        if to_regclass('public.' || t) is null then continue; end if;
        execute format('drop policy if exists "Clients read lists" on public.%I', t);
        execute format('create policy "Clients read lists" on public.%I for select to authenticated using (public.pestis_is_client())', t);
    end loop;
end $$;

-- b) Safety net on every Pestis table: staff-only changes, and reads limited to staff or (for site data) that site's clients.
--    "Restrictive" rules are combined with AND on top of the existing rules, so they can only take access away.
do $$
declare
    t text;
    site_tables text[] := array['service_logs', 'recommendations', 'recommendation_updates', 'stations', 'site_maps', 'visits', 'site_documents',
                                'site_document_folders', 'recommendation_views', 'pest_sightings', 'site_limits'];
    list_tables text[] := array['app_options', 'preparations', 'species', 'station_types'];
    staff_tables text[] := array['clients', 'site_events', 'app_settings'];
    read_rule text;
begin
    foreach t in array site_tables || list_tables || staff_tables loop
        if to_regclass('public.' || t) is null then continue; end if;
        read_rule := case
            when t = any(site_tables) then 'public.pestis_is_approved() or (public.pestis_is_client() and public.pestis_can_see_site(client_id::text))'
            when t = any(list_tables) then 'public.pestis_is_approved() or public.pestis_is_client()'
            else 'public.pestis_is_approved()' end;
        execute format('alter table public.%I enable row level security', t);
        execute format('drop policy if exists "Pestis guard: read" on public.%I', t);
        execute format('drop policy if exists "Pestis guard: add" on public.%I', t);
        execute format('drop policy if exists "Pestis guard: change" on public.%I', t);
        execute format('drop policy if exists "Pestis guard: delete" on public.%I', t);
        execute format('create policy "Pestis guard: read" on public.%I as restrictive for select to public using (%s)', t, read_rule);
        execute format('create policy "Pestis guard: add" on public.%I as restrictive for insert to public with check (public.pestis_is_approved())', t);
        execute format('create policy "Pestis guard: change" on public.%I as restrictive for update to public using (public.pestis_is_approved()) with check (public.pestis_is_approved())', t);
        execute format('create policy "Pestis guard: delete" on public.%I as restrictive for delete to public using (public.pestis_is_approved())', t);
    end loop;
end $$;

-- c) Storage: photos and documents
drop policy if exists "Clients read their site files"        on storage.objects;
drop policy if exists "Clients add recommendation photos"    on storage.objects;
drop policy if exists "Staff read site documents files"      on storage.objects;
drop policy if exists "Admins manage site documents files"   on storage.objects;
drop policy if exists "Pestis files guard: read"   on storage.objects;
drop policy if exists "Pestis files guard: add"    on storage.objects;
drop policy if exists "Pestis files guard: change" on storage.objects;
drop policy if exists "Pestis files guard: delete" on storage.objects;

create policy "Clients read their site files" on storage.objects for select to authenticated
    using (public.pestis_client_can_read_file(bucket_id, name));
create policy "Clients add recommendation photos" on storage.objects for insert to authenticated
    with check (public.pestis_client_can_upload(bucket_id, name));
create policy "Staff read site documents files" on storage.objects for select to authenticated
    using (bucket_id = 'site-documents' and public.pestis_is_approved());
create policy "Admins manage site documents files" on storage.objects for all to authenticated
    using (bucket_id = 'site-documents' and public.pestis_is_admin())
    with check (bucket_id = 'site-documents' and public.pestis_is_admin());

-- the safety net only applies to the two Pestis buckets; any other bucket keeps its own rules
create policy "Pestis files guard: read" on storage.objects as restrictive for select to public
    using (bucket_id not in ('station-photos', 'site-documents') or public.pestis_is_approved() or public.pestis_client_can_read_file(bucket_id, name));
create policy "Pestis files guard: add" on storage.objects as restrictive for insert to public
    with check (bucket_id not in ('station-photos', 'site-documents') or public.pestis_is_approved() or public.pestis_client_can_upload(bucket_id, name));
create policy "Pestis files guard: change" on storage.objects as restrictive for update to public
    using (bucket_id not in ('station-photos', 'site-documents') or public.pestis_is_approved())
    with check (bucket_id not in ('station-photos', 'site-documents') or public.pestis_is_approved());
create policy "Pestis files guard: delete" on storage.objects as restrictive for delete to public
    using (bucket_id not in ('station-photos', 'site-documents') or public.pestis_is_approved());

-- ---------------------------------------------------------------
-- 6. What the portal calls
-- ---------------------------------------------------------------
-- Who am I? (the portal and the staff app both use this to send people to the right place)
create or replace function public.portal_whoami()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me text := public.pestis_my_email(); c public.client_users;
begin
    select * into c from public.client_users where email = me;
    if found and c.active then
        update public.client_users set last_seen_at = now() where email = me;
    end if;
    return jsonb_build_object(
        'email', me,
        'staff', public.pestis_is_approved(),
        'admin', public.pestis_is_admin(),
        'client', found,
        'active', coalesce(c.active, false),
        'name', c.full_name,
        'company', c.company,
        'sites', (select count(*) from public.client_access a where a.email = me));
end $$;

-- The sites a client can see, without anything internal
-- (service notes, contract notes, safety/access notes and who started a visit are left out)
create or replace function public.portal_sites()
returns jsonb language sql security definer stable set search_path = public as $$
    select coalesce(jsonb_agg(site order by lower(coalesce(site->>'Name', site->>'name', ''))), '[]'::jsonb)
      from (
        select (to_jsonb(c)
                  - array['Notes', 'notes', 'safety_notes', 'access_notes', 'site_notes', 'contract_notes', 'visit_started_by', 'assigned_to', 'services'])
               || jsonb_build_object(
                    'services', (select coalesce(jsonb_agg(s - 'notes'), '[]'::jsonb)
                                   from jsonb_array_elements(case when jsonb_typeof(to_jsonb(c)->'services') = 'array' then to_jsonb(c)->'services'
                                                                  when jsonb_typeof(to_jsonb(c)->'services') = 'string' then coalesce((to_jsonb(c)->>'services')::jsonb, '[]'::jsonb)
                                                                  else '[]'::jsonb end) s),
                    'technician', (select coalesce(p.full_name, p.email) from public.profiles p where p.id::text = to_jsonb(c)->>'assigned_to')
                  ) as site
          from public.clients c
         where case when public.pestis_is_client() then public.pestis_is_site_client(c.id::text)   -- a client login: only the sites given to it
                    else public.pestis_is_approved() end                                         -- staff previewing: every site
      ) x;
$$;

-- A client (or staff previewing the portal) updates a recommendation: status, note, photos.
-- Logged as a normal recommendation update, so it shows in the staff app's history, activity log and notifications.
alter table public.recommendation_updates add column if not exists by_client boolean not null default false;
create index if not exists recommendation_updates_client_flag_idx on public.recommendation_updates (by_client, at) where by_client;

create or replace function public.portal_update_recommendation(p_rec_id text, p_status text, p_note text, p_photos jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    r public.recommendations;
    me text := public.pestis_my_email();
    who text;
    is_client boolean := public.pestis_is_client() and not public.pestis_is_approved();
    st text := lower(coalesce(nullif(trim(p_status), ''), ''));
    ph jsonb := coalesce(p_photos, '[]'::jsonb);
    new_id text := 'cu_' || replace(gen_random_uuid()::text, '-', '');
begin
    select * into r from public.recommendations where id = p_rec_id;
    if not found or not public.pestis_can_see_site(r.client_id) or not (is_client or public.pestis_is_approved()) then
        raise exception 'Recommendation not found';
    end if;
    if st = '' then st := r.status; end if;
    if st not in ('open', 'pending', 'complete') then raise exception 'Status must be open, pending or complete'; end if;
    if jsonb_typeof(ph) <> 'array' then raise exception 'Photos must be a list'; end if;
    if jsonb_array_length(ph) > 20 then raise exception 'Up to 20 photos at a time'; end if;
    -- photos must be ones this site's client uploaded for this purpose
    if exists (select 1 from jsonb_array_elements_text(ph) p
                where split_part(p, '/', 1) <> r.client_id or split_part(p, '/', 2) not like 'CLIENT\_%' or split_part(p, '/', 3) <> '') then
        raise exception 'Photo path not allowed';
    end if;
    if st = r.status and coalesce(trim(p_note), '') = '' and jsonb_array_length(ph) = 0 then
        raise exception 'Nothing to save';
    end if;
    if st <> r.status and coalesce(trim(p_note), '') = '' then
        raise exception 'Add a note saying why the status is changing';
    end if;
    if is_client then
        select coalesce(nullif(full_name, ''), email) || coalesce(' · ' || nullif(company, ''), '') || ' (client)' into who
          from public.client_users where email = me;
    else
        select coalesce(full_name, email) into who from public.profiles where id = auth.uid();
    end if;
    insert into public.recommendation_updates (id, rec_id, client_id, status, note, photos, technician, at, by_client)
    values (new_id, r.id, r.client_id, st, nullif(trim(p_note), ''), ph, who, now(), is_client);
    return jsonb_build_object('id', new_id, 'status', st);
end $$;

revoke all on function public.portal_whoami() from public;
revoke all on function public.portal_sites() from public;
revoke all on function public.portal_update_recommendation(text, text, text, jsonb) from public;
grant execute on function public.portal_whoami() to authenticated;
grant execute on function public.portal_sites() to authenticated;
grant execute on function public.portal_update_recommendation(text, text, text, jsonb) to authenticated;

-- Who is signed in, as a name to show (client: name and company; staff: their name)
create or replace function public.pestis_my_name()
returns text language sql security definer stable set search_path = public as $$
    select coalesce(
        (select coalesce(nullif(full_name, ''), email) || coalesce(' · ' || nullif(company, ''), '') || ' (client)'
           from public.client_users where email = public.pestis_my_email() and active and not public.pestis_is_approved()),
        (select coalesce(nullif(full_name, ''), email) from public.profiles where id = auth.uid()),
        public.pestis_my_email());
$$;

-- Record that the signed-in person opened a recommendation (staff and clients)
create or replace function public.pestis_mark_rec_viewed(p_rec_id text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.recommendations; is_client boolean := public.pestis_is_client() and not public.pestis_is_approved();
begin
    if auth.uid() is null then return; end if;
    select * into r from public.recommendations where id = p_rec_id;
    if not found or not public.pestis_can_see_site(r.client_id) or not (is_client or public.pestis_is_approved()) then return; end if;
    insert into public.recommendation_views (rec_id, client_id, viewer_key, viewer_name, is_client)
    values (r.id, r.client_id, auth.uid()::text, public.pestis_my_name(), is_client)
    on conflict (rec_id, viewer_key) do update
        set last_seen_at = now(), view_count = public.recommendation_views.view_count + 1, viewer_name = excluded.viewer_name;
end $$;

revoke all on function public.pestis_my_name() from public;
revoke all on function public.pestis_mark_rec_viewed(text) from public;
grant execute on function public.pestis_my_name() to authenticated;
grant execute on function public.pestis_mark_rec_viewed(text) to authenticated;

-- ---------------------------------------------------------------
-- 7. Station location photos, customer sign-off, technician profiles, standard document folders
-- ---------------------------------------------------------------
-- a photo of where each station is, so the next technician can find it
alter table public.stations add column if not exists photo_path text;

-- the customer signs off the visit (or the technician says why they couldn't)
alter table public.visits add column if not exists signed_by           text;
alter table public.visits add column if not exists signature_path      text;
alter table public.visits add column if not exists signed_at           timestamptz;
alter table public.visits add column if not exists no_signature_reason text;

-- recommendations: a type (Housekeeping, Proofing ...) and a description under the title
alter table public.recommendations add column if not exists category text;
alter table public.recommendations add column if not exists details  text;

-- what clients see about their technicians (set by an admin)
alter table public.profiles add column if not exists job_title      text;
alter table public.profiles add column if not exists bio            text;
alter table public.profiles add column if not exists phone          text;
alter table public.profiles add column if not exists contact_email  text;
alter table public.profiles add column if not exists photo_path     text;
alter table public.profiles add column if not exists portal_visible boolean not null default true;

-- Only admins change someone else's profile details (people can still edit their own name and photo)
create or replace function public.pestis_protect_profile_details()
returns trigger language plpgsql set search_path = public as $$
begin
    if auth.uid() is null or public.pestis_is_admin() then return new; end if;
    if new.job_title is distinct from old.job_title or new.bio is distinct from old.bio or new.phone is distinct from old.phone
       or new.contact_email is distinct from old.contact_email or new.portal_visible is distinct from old.portal_visible
       or (new.photo_path is distinct from old.photo_path and new.id <> auth.uid()) then
        raise exception 'Only an administrator can change technician profile details.';
    end if;
    return new;
end $$;
drop trigger if exists pestis_protect_profile_details on public.profiles;
create trigger pestis_protect_profile_details before update on public.profiles
    for each row execute function public.pestis_protect_profile_details();

-- The technicians a client sees for one of their sites: the site's technician first, then the others who visit
create or replace function public.portal_technicians(p_client_id text)
returns jsonb language sql security definer stable set search_path = public as $$
    select coalesce(jsonb_agg(t order by (t->>'assigned')::boolean desc, (t->>'visits')::int desc, lower(t->>'name')), '[]'::jsonb)
      from (
        select jsonb_build_object(
                 'id', p.id, 'name', coalesce(nullif(p.full_name, ''), p.email), 'title', p.job_title, 'bio', p.bio,
                 'phone', p.phone, 'email', coalesce(nullif(p.contact_email, ''), p.email), 'photo_path', p.photo_path,
                 'assigned', exists (select 1 from public.clients c where c.id::text = p_client_id and to_jsonb(c)->>'assigned_to' = p.id::text),
                 'visits', (select count(*) from public.visits v where v.client_id::text = p_client_id and v.technician = coalesce(nullif(p.full_name, ''), p.email)),
                 'last_visit', (select max(v.completed_at) from public.visits v where v.client_id::text = p_client_id and v.technician = coalesce(nullif(p.full_name, ''), p.email))
               ) as t
          from public.profiles p
         where p.approved and p.portal_visible
           and public.pestis_can_see_site(p_client_id)
           and (public.pestis_is_client() or public.pestis_is_approved())
      ) x;
$$;
revoke all on function public.portal_technicians(text) from public;
grant execute on function public.portal_technicians(text) to authenticated;

-- Admins can delete someone from the Users list (their past work stays on record)
drop policy if exists "Admins delete profiles" on public.profiles;
create policy "Admins delete profiles" on public.profiles for delete to authenticated using (public.pestis_is_admin() and id <> auth.uid());

-- Every site has the standard document folders (new sites get them too)
create or replace function public.pestis_standard_folders()
returns text[] language sql immutable as $$
    select array['SDS', 'Service agreement', 'Maps', 'Site specific', 'Meetings', 'Entomology', 'Training', 'Insurance'];
$$;
insert into public.site_document_folders (client_id, name, created_by)
select c.id::text, f, 'Pestis' from public.clients c cross join unnest(public.pestis_standard_folders()) f
on conflict (client_id, name) do nothing;
create or replace function public.pestis_add_standard_folders()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    insert into public.site_document_folders (client_id, name, created_by)
    select new.id::text, f, 'Pestis' from unnest(public.pestis_standard_folders()) f
    on conflict (client_id, name) do nothing;
    return new;
end $$;
drop trigger if exists pestis_add_standard_folders on public.clients;
create trigger pestis_add_standard_folders after insert on public.clients
    for each row execute function public.pestis_add_standard_folders();

-- A client reports a pest sighting on their site
create or replace function public.portal_report_sighting(p_client_id text, p_pest text, p_location text, p_seen_at timestamptz,
    p_number integer default null, p_evidence text default null, p_urgency text default 'Routine', p_reported_by text default null,
    p_contact text default null, p_details text default null, p_photos jsonb default '[]'::jsonb, p_station text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ph jsonb := coalesce(p_photos, '[]'::jsonb); new_id text := gen_random_uuid()::text; no integer;
begin
    if not public.pestis_can_see_site(p_client_id) or not (public.pestis_is_site_client(p_client_id) or public.pestis_is_approved()) then raise exception 'Site not found'; end if;
    if coalesce(trim(p_pest), '') = '' then raise exception 'Say which pest was seen'; end if;
    if coalesce(trim(p_location), '') = '' then raise exception 'Say where it was seen'; end if;
    if p_seen_at is null or p_seen_at > now() + interval '1 hour' then raise exception 'Enter when it was seen'; end if;
    if jsonb_typeof(ph) <> 'array' or jsonb_array_length(ph) > 10 then raise exception 'Up to 10 photos'; end if;
    if exists (select 1 from jsonb_array_elements_text(ph) x
                where split_part(x, '/', 1) <> p_client_id or split_part(x, '/', 2) not like 'CLIENT\_%' or split_part(x, '/', 3) <> '') then
        raise exception 'Photo path not allowed';
    end if;
    perform pg_advisory_xact_lock(hashtext('pest_sightings:' || p_client_id));
    select coalesce(max(sighting_no), 0) + 1 into no from public.pest_sightings where client_id = p_client_id;
    insert into public.pest_sightings (id, client_id, sighting_no, pest, location, station_barcode, seen_at, number_seen, evidence, urgency,
                                       reported_by, reporter_contact, details, photos, created_by)
    values (new_id, p_client_id, no, left(trim(p_pest), 80), left(trim(p_location), 120), nullif(trim(coalesce(p_station, '')), ''), p_seen_at,
            p_number, nullif(trim(coalesce(p_evidence, '')), ''), case when p_urgency = 'Urgent' then 'Urgent' else 'Routine' end,
            coalesce(nullif(trim(coalesce(p_reported_by, '')), ''), public.pestis_my_name()), nullif(trim(coalesce(p_contact, '')), ''),
            nullif(trim(coalesce(p_details, '')), ''), ph, public.pestis_my_name());
    return jsonb_build_object('id', new_id, 'no', no);
end $$;
revoke all on function public.portal_report_sighting(text, text, text, timestamptz, integer, text, text, text, text, text, jsonb, text) from public;
grant execute on function public.portal_report_sighting(text, text, text, timestamptz, integer, text, text, text, text, text, jsonb, text) to authenticated;

-- The client reviews the technician's action on a sighting
create or replace function public.portal_review_sighting(p_id text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pest_sightings;
begin
    select * into r from public.pest_sightings where id = p_id;
    if not found or not public.pestis_can_see_site(r.client_id) or not (public.pestis_is_site_client(r.client_id) or public.pestis_is_approved()) then raise exception 'Sighting not found'; end if;
    if r.status = 'new' then raise exception 'The technician has not actioned this sighting yet'; end if;
    update public.pest_sightings set status = 'reviewed', client_reviewed_by = public.pestis_my_name(), client_reviewed_at = now(),
           client_review_note = nullif(trim(coalesce(p_note, '')), ''), updated_at = now()
     where id = p_id;
end $$;
revoke all on function public.portal_review_sighting(text, text) from public;
grant execute on function public.portal_review_sighting(text, text) to authenticated;

-- Floor plans drawn in the app keep their drawing (walls, rooms, objects) so they can be edited again
do $$ begin
    if to_regclass('public.site_maps') is not null then
        execute 'alter table public.site_maps add column if not exists drawing jsonb';
    end if;
end $$;

-- Staff days: Start day / End day in the Service App log each person's working day
create table if not exists public.staff_days (
    id          text primary key,
    user_id     uuid not null default auth.uid(),
    technician  text,
    started_at  timestamptz not null,
    ended_at    timestamptz,
    sites       jsonb not null default '[]'::jsonb,   -- the sites downloaded for the day: [{ id, name }]
    summary     jsonb not null default '{}'::jsonb,   -- at the end: { minutes, sites_visited, records }
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create index if not exists staff_days_user_idx on public.staff_days (user_id, started_at desc);
alter table public.staff_days enable row level security;
drop policy if exists "staff_days read" on public.staff_days;
create policy "staff_days read" on public.staff_days for select to authenticated using (user_id = auth.uid() or public.pestis_is_admin());
drop policy if exists "staff_days add" on public.staff_days;
create policy "staff_days add" on public.staff_days for insert to authenticated with check (user_id = auth.uid() and public.pestis_is_approved());
drop policy if exists "staff_days change" on public.staff_days;
create policy "staff_days change" on public.staff_days for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update on public.staff_days to authenticated;

-- Each person's own settings (theme, text size, photo size, map logo ...) for the Service App and the Client Portal.
-- Only the person can read or change their own row; they never affect anyone else.
create table if not exists public.user_prefs (
    user_id    uuid primary key default auth.uid(),
    prefs      jsonb not null default '{}'::jsonb,   -- { service_app: {...}, portal: {...} }
    updated_at timestamptz not null default now()
);
alter table public.user_prefs enable row level security;
drop policy if exists "user_prefs own" on public.user_prefs;
create policy "user_prefs own" on public.user_prefs for select to authenticated using (user_id = auth.uid());
revoke insert, update, delete on public.user_prefs from anon, authenticated;
grant select on public.user_prefs to authenticated;

create or replace function public.get_my_prefs()
returns jsonb language sql stable security definer set search_path = public as $$
    select coalesce((select prefs from public.user_prefs where user_id = auth.uid()), '{}'::jsonb);
$$;
revoke all on function public.get_my_prefs() from public;
grant execute on function public.get_my_prefs() to authenticated;

create or replace function public.save_my_pref(p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
    if auth.uid() is null then raise exception 'Not signed in'; end if;
    if p_key is null or p_key !~ '^[A-Za-z0-9_]{1,40}$' then raise exception 'Bad setting name'; end if;
    if length(coalesce(p_value::text, '')) > 250000 then raise exception 'Setting too large'; end if;
    insert into public.user_prefs (user_id, prefs, updated_at) values (auth.uid(), jsonb_build_object(p_key, p_value), now())
    on conflict (user_id) do update set prefs = public.user_prefs.prefs || jsonb_build_object(p_key, p_value), updated_at = now();
end $$;
revoke all on function public.save_my_pref(text, jsonb) from public;
grant execute on function public.save_my_pref(text, jsonb) to authenticated;

-- Admins can see and change another person's settings (Admin -> Users -> tap the person).
create or replace function public.admin_get_user_prefs(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
    if not public.pestis_is_admin() then raise exception 'Only admins can do this'; end if;
    return coalesce((select prefs from public.user_prefs where user_id = p_user), '{}'::jsonb);
end $$;
revoke all on function public.admin_get_user_prefs(uuid) from public;
grant execute on function public.admin_get_user_prefs(uuid) to authenticated;

create or replace function public.admin_save_user_pref(p_user uuid, p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
    if not public.pestis_is_admin() then raise exception 'Only admins can do this'; end if;
    if p_user is null then raise exception 'No person given'; end if;
    if p_key is null or p_key !~ '^[A-Za-z0-9_]{1,40}$' then raise exception 'Bad setting name'; end if;
    if length(coalesce(p_value::text, '')) > 250000 then raise exception 'Setting too large'; end if;
    insert into public.user_prefs (user_id, prefs, updated_at) values (p_user, jsonb_build_object(p_key, p_value), now())
    on conflict (user_id) do update set prefs = public.user_prefs.prefs || jsonb_build_object(p_key, p_value), updated_at = now();
end $$;
revoke all on function public.admin_save_user_pref(uuid, text, jsonb) from public;
grant execute on function public.admin_save_user_pref(uuid, text, jsonb) to authenticated;

-- Preparations carry their safety data sheet (SDS); pests carry a category, a picture and a guide
do $$ begin
    if to_regclass('public.preparations') is not null then
        alter table public.preparations add column if not exists sds_path text;        -- site-documents bucket: library/sds/<file>
        alter table public.preparations add column if not exists sds_name text;
        alter table public.preparations add column if not exists sds_expires date;
        alter table public.preparations add column if not exists sds_updated_at timestamptz;
        alter table public.preparations add column if not exists sds_updated_by text;
    end if;
    if to_regclass('public.species') is not null then
        alter table public.species add column if not exists category text;            -- e.g. Rodents, Crawling insects
        alter table public.species add column if not exists photo_path text;          -- station-photos bucket: library/pests/<file>
        alter table public.species add column if not exists photo_source text;        -- where a web picture came from (e.g. the Wikipedia page)
        alter table public.species add column if not exists subcategory text;         -- e.g. Cockroaches, Ants, Spiders (within its category)
        alter table public.species add column if not exists gallery jsonb;             -- photos: { pest: [{u, p, t}], signs: [{u, p, t}] } (Wikimedia Commons or uploaded)
        alter table public.species add column if not exists about text;
        alter table public.species add column if not exists breeding text;
        alter table public.species add column if not exists control text;
        alter table public.species add column if not exists updated_at timestamptz;
        alter table public.species add column if not exists updated_by text;
    end if;
    if to_regclass('public.station_types') is not null then
        alter table public.station_types add column if not exists color text;         -- the station type's colour, e.g. #dc2626 (Admin -> Lists)
    end if;
end $$;

-- How long the apps can sit unused before signing the person out (Admin -> Team settings; 0 = never)
create or replace function public.pestis_idle_minutes()
returns integer language sql stable security definer set search_path = public as $$
    select coalesce((select case when jsonb_typeof(value) = 'number' then (value::text)::numeric::integer
                                 when jsonb_typeof(value) = 'string' and (value #>> '{}') ~ '^[0-9]+$' then (value #>> '{}')::integer end
                     from public.app_settings where key = 'idle_logout_minutes'), 5);
$$;
revoke all on function public.pestis_idle_minutes() from public;
grant execute on function public.pestis_idle_minutes() to authenticated;

-- Each staff member's screen layout (where the site boxes go and their sizes), so it follows them to any device
alter table public.profiles add column if not exists ui_prefs jsonb not null default '{}'::jsonb;
create or replace function public.save_my_ui_prefs(p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
    if auth.uid() is null then raise exception 'Not signed in'; end if;
    if p_key is null or p_key !~ '^[A-Za-z0-9_]{1,40}$' then raise exception 'Bad setting name'; end if;
    if length(coalesce(p_value::text, '')) > 20000 then raise exception 'Setting too large'; end if;
    update public.profiles set ui_prefs = coalesce(ui_prefs, '{}'::jsonb) || jsonb_build_object(p_key, p_value) where id = auth.uid();
end $$;
revoke all on function public.save_my_ui_prefs(text, jsonb) from public;
grant execute on function public.save_my_ui_prefs(text, jsonb) to authenticated;

-- Live updates: the apps download a site once, then the database pushes every insert, update and delete
-- (Supabase Realtime). Each person only receives rows they are allowed to read.
do $$
declare t text;
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime' and not puballtables) then
        foreach t in array array['service_logs', 'recommendations', 'recommendation_updates', 'stations', 'site_maps', 'visits', 'site_events',
                                 'pest_sightings', 'site_documents', 'site_document_folders', 'recommendation_views', 'clients', 'site_limits', 'site_contacts'] loop
            if to_regclass('public.' || t) is not null
               and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
                execute format('alter publication supabase_realtime add table public.%I', t);
            end if;
        end loop;
    end if;
end $$;

notify pgrst, 'reload schema';
