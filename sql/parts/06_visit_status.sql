-- Pestis: "visit in progress" status on each site, so the whole team can see open visits
-- and the app can warn when one has been left open for more than 24 hours.
-- Run once in Supabase -> SQL Editor. Safe to run again.

alter table public.clients add column if not exists visit_started_at timestamptz;
alter table public.clients add column if not exists visit_started_by uuid references public.profiles(id) on delete set null;

create index if not exists clients_visit_started_at_idx on public.clients (visit_started_at);

notify pgrst, 'reload schema';
