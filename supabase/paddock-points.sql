-- Where each paddock is, learnt from accepted photos: one point per photo given a paddock on the laptop
-- page. The laptop uses the nearest points to guess the paddock of a new photo. Points outlive the
-- 3-day photo clean-up (they hold no picture, only the position and the paddock).
create table if not exists public.paddock_points (
  farm_id uuid not null references public.farms(id) on delete cascade,
  photo_file text not null,
  paddock text not null,
  latitude double precision not null,
  longitude double precision not null,
  taken_at timestamptz,
  primary key (farm_id, photo_file)
);
alter table public.paddock_points enable row level security;
drop policy if exists "members use paddock points" on public.paddock_points;
create policy "members use paddock points" on public.paddock_points
  for all to authenticated using (public.is_farm_member(farm_id)) with check (public.is_farm_member(farm_id));
grant select, insert, update, delete on public.paddock_points to authenticated;

-- Start from the photos already given a paddock.
insert into public.paddock_points (farm_id, photo_file, paddock, latitude, longitude, taken_at)
select farm_id, file, paddock, latitude, longitude, taken_at from public.photos where paddock is not null
on conflict (farm_id, photo_file) do update set paddock = excluded.paddock;
