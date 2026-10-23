-- Pestis: site photos, contracted services, and editable site details.
-- Run once in Supabase -> SQL Editor. Safe to run again.

-- 1. New columns on the sites table
alter table public.clients add column if not exists image_path text;
alter table public.clients add column if not exists services jsonb not null default '[]'::jsonb;

-- 2. Approved staff can edit site details (contact, email, safety notes, services, photo)
alter table public.clients enable row level security;

drop policy if exists "Approved staff can update clients" on public.clients;
create policy "Approved staff can update clients"
on public.clients for update to authenticated
using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.approved))
with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.approved));

-- 3. Site card photos are stored in the existing private 'station-photos' bucket,
--    in a 'site-covers/' folder. Let approved staff upload, view, replace and remove them.
drop policy if exists "Approved staff manage site covers" on storage.objects;
create policy "Approved staff manage site covers"
on storage.objects for all to authenticated
using (
    bucket_id = 'station-photos'
    and (storage.foldername(name))[1] = 'site-covers'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.approved)
)
with check (
    bucket_id = 'station-photos'
    and (storage.foldername(name))[1] = 'site-covers'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.approved)
);

-- 4. Speeds up the duplicate check the offline queue runs when it retries an upload
create index if not exists service_logs_client_ref_idx
    on public.service_logs ((payload->>'clientRef'));
