-- Pestis: contract renewal dates and assigning sites to technicians.
-- Run once in Supabase -> SQL Editor. Safe to run again.

-- 1. New site columns
alter table public.clients add column if not exists contract_start date;
alter table public.clients add column if not exists contract_end   date;
alter table public.clients add column if not exists contract_notes text;
alter table public.clients add column if not exists assigned_to    uuid references public.profiles(id) on delete set null;

create index if not exists clients_assigned_to_idx on public.clients (assigned_to);
create index if not exists clients_contract_end_idx on public.clients (contract_end);

-- 2. Let approved staff see the team list (names/emails of approved users) so sites can be assigned.
--    A helper function is used because a profiles policy that looks at profiles directly
--    makes Postgres loop ("infinite recursion detected in policy").
create or replace function public.pestis_is_approved()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
    select exists (select 1 from public.profiles where id = auth.uid() and approved);
$$;

revoke all on function public.pestis_is_approved() from public;
grant execute on function public.pestis_is_approved() to authenticated;

drop policy if exists "Approved staff can see approved team members" on public.profiles;
create policy "Approved staff can see approved team members"
on public.profiles for select to authenticated
using (approved and public.pestis_is_approved());
