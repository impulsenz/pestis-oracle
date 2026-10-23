-- Pestis: make sure the sites table (clients) has the text columns the app uses:
-- "Name", "Address", "Contact", "Email", "Notes".
-- Run in Supabase -> SQL Editor. Safe to run again.

-- OPTIONAL: to see what columns the table has now, run this line on its own first:
-- select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'clients' order by ordinal_position;

-- 1. If a column exists under a lower-case name (e.g. contact), rename it so existing data lines up with the app.
do $$
declare
    pair text[];
begin
    foreach pair slice 1 in array array[
        array['address', 'Address'],
        array['contact', 'Contact'],
        array['email',   'Email'],
        array['notes',   'Notes']
    ] loop
        if exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'clients' and column_name = pair[1])
           and not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = 'clients' and column_name = pair[2]) then
            execute format('alter table public.clients rename column %I to %I', pair[1], pair[2]);
            raise notice 'Renamed clients.% to clients.%', pair[1], pair[2];
        end if;
    end loop;
end $$;

-- 2. Add any that are still missing
alter table public.clients add column if not exists "Address" text;
alter table public.clients add column if not exists "Contact" text;
alter table public.clients add column if not exists "Email"   text;
alter table public.clients add column if not exists "Notes"   text;

-- 3. Tell the database API to pick up the change straight away
notify pgrst, 'reload schema';
