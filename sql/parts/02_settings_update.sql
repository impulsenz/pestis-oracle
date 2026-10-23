-- Pestis: Settings lists (preparations / chemicals and species).
-- Run once in Supabase -> SQL Editor. Safe to run again.

create table if not exists public.app_options (
    id         text primary key,                       -- created by the app so it works offline
    kind       text not null check (kind in ('prep', 'species')),
    label      text not null,
    sort       integer not null default 0,
    created_at timestamptz not null default now(),
    created_by uuid default auth.uid()
);

alter table public.app_options enable row level security;

-- Approved staff can see the lists
drop policy if exists "Approved staff read options" on public.app_options;
create policy "Approved staff read options"
on public.app_options for select to authenticated
using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.approved));

-- Approved staff can add, rename and remove items
-- (to limit this to admins, change "p.approved" to "p.approved and p.role = 'admin'" in the three policies below)
drop policy if exists "Approved staff add options" on public.app_options;
create policy "Approved staff add options"
on public.app_options for insert to authenticated
with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.approved));

drop policy if exists "Approved staff update options" on public.app_options;
create policy "Approved staff update options"
on public.app_options for update to authenticated
using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.approved))
with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.approved));

drop policy if exists "Approved staff delete options" on public.app_options;
create policy "Approved staff delete options"
on public.app_options for delete to authenticated
using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.approved));

-- Starting lists (only added if the table is empty)
insert into public.app_options (id, kind, label, sort)
select * from (values
    ('seed-prep-1',    'prep',    'Brodifacoum Rodent Blocks', 1),
    ('seed-prep-2',    'prep',    'Alpha-Cypermethrin Spray',  2),
    ('seed-prep-3',    'prep',    'Cockroach Gel Bait',        3),
    ('seed-species-1', 'species', 'Norway Rat',                1),
    ('seed-species-2', 'species', 'Ship Rat',                  2),
    ('seed-species-3', 'species', 'House Mouse',               3),
    ('seed-species-4', 'species', 'German Cockroach',          4),
    ('seed-species-5', 'species', 'American Cockroach',        5),
    ('seed-species-6', 'species', 'House Fly',                 6),
    ('seed-species-7', 'species', 'Ants',                      7)
) as v(id, kind, label, sort)
where not exists (select 1 from public.app_options);
