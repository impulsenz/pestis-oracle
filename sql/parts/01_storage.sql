-- =====================================================================================
-- Pestis on your own Supabase - 01: the private bucket for photos, floor plans and site pictures
-- (site documents get their own bucket in the client portal file). Safe to run again.
-- =====================================================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('station-photos', 'station-photos', false, 52428800)   -- 50 MB a file (videos)
on conflict (id) do nothing;

-- approved staff can add, view, replace and remove anything in it (clients get their own narrower rules later)
drop policy if exists "Staff manage station photos" on storage.objects;
create policy "Staff manage station photos" on storage.objects for all to authenticated
    using (bucket_id = 'station-photos' and public.pestis_is_approved())
    with check (bucket_id = 'station-photos' and public.pestis_is_approved());
