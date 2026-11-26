-- Advisers may put their own photos on a farm they're on (the phone's "Photos go to" switch).
-- Run after advisers.sql. They still can't change anything else on the farm, or anyone else's photos:
-- every right here is limited to photos the adviser uploaded themself (photos.uploaded_by /
-- storage.objects.owner). Accepting a photo's paddock and cover stays with the farm's own devices.

-- An adviser on this farm.
create or replace function public.is_farm_adviser(f uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.farm_members m where m.farm_id = f and m.user_id = auth.uid() and m.role = 'adviser');
$$;

drop policy if exists "advisers add own photos" on public.photos;
create policy "advisers add own photos" on public.photos
  for insert to authenticated
  with check (public.is_farm_adviser(farm_id) and uploaded_by = auth.uid() and cover_accepted is null);
-- Only the upload's own re-try (upsert) and the delete mark: nothing that accepts it.
drop policy if exists "advisers change own photos" on public.photos;
create policy "advisers change own photos" on public.photos
  for update to authenticated
  using (public.is_farm_adviser(farm_id) and uploaded_by = auth.uid() and cover_accepted is null)
  with check (public.is_farm_adviser(farm_id) and uploaded_by = auth.uid() and cover_accepted is null);
drop policy if exists "advisers delete own photos" on public.photos;
create policy "advisers delete own photos" on public.photos
  for delete to authenticated
  using (public.is_farm_adviser(farm_id) and uploaded_by = auth.uid() and public.photo_may_go(farm_id, storage_path));

drop policy if exists "advisers add own farm photos" on storage.objects;
create policy "advisers add own farm photos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and public.is_farm_adviser(((storage.foldername(name))[1])::uuid));
drop policy if exists "advisers replace own farm photos" on storage.objects;
create policy "advisers replace own farm photos" on storage.objects
  for update to authenticated
  using (bucket_id = 'photos' and owner = auth.uid() and public.is_farm_adviser(((storage.foldername(name))[1])::uuid));
drop policy if exists "advisers delete own farm photos" on storage.objects;
create policy "advisers delete own farm photos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos' and owner = auth.uid()
     and public.is_farm_adviser(((storage.foldername(name))[1])::uuid)
     and public.photo_may_go(((storage.foldername(name))[1])::uuid, name));
