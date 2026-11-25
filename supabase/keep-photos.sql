-- Farms that keep their photos: no 3-day delete. Set by Tamaki (a paid option), not from the app:
--   update public.farms set keep_photos = true where name = '77207';
-- The database enforces it, so a phone still running an older app (which deletes photos older than
-- 3 days whenever it syncs) can't delete them either. A photo is only deleted on such a farm when
-- someone asks for that one photo (🗑 on the laptop or the Accept tab): the app first marks it
-- delete_requested, then deletes the picture and the row.
alter table public.farms add column if not exists keep_photos boolean not null default false;
alter table public.photos add column if not exists delete_requested boolean not null default false;

-- May this photo (row or picture) be deleted? Yes unless the farm keeps photos and the photo hasn't
-- been asked to go. A picture with no row (left over) may always go.
create or replace function public.photo_may_go(f uuid, path text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select not coalesce((select keep_photos from public.farms where id = f), false)
      or not exists (select 1 from public.photos p where p.farm_id = f and p.storage_path = path and not p.delete_requested);
$$;

drop policy if exists "members use photos" on public.photos;
drop policy if exists "members read photos" on public.photos;
create policy "members read photos" on public.photos
  for select to authenticated using (public.is_farm_member(farm_id));
drop policy if exists "members add photos" on public.photos;
create policy "members add photos" on public.photos
  for insert to authenticated with check (public.is_farm_member(farm_id));
drop policy if exists "members change photos" on public.photos;
create policy "members change photos" on public.photos
  for update to authenticated using (public.is_farm_member(farm_id)) with check (public.is_farm_member(farm_id));
drop policy if exists "members delete photos" on public.photos;
create policy "members delete photos" on public.photos
  for delete to authenticated using (public.is_farm_member(farm_id) and public.photo_may_go(farm_id, storage_path));

drop policy if exists "members delete farm photos" on storage.objects;
create policy "members delete farm photos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos'
     and public.is_farm_member(((storage.foldername(name))[1])::uuid)
     and public.photo_may_go(((storage.foldername(name))[1])::uuid, name));

update public.farms set keep_photos = true where name = '77207';
