-- Adviser accounts: a person (consultant, farm accountant, vet, banker, field rep) who looks at a
-- farm but doesn't run it. View-only: they read everything the farm's phones read, but can't change
-- paddocks, grazing, covers, feed settings or photos, and can't add photos to the farm. The database
-- enforces it (a farm's own phones are role 'member' or 'admin').
-- Run after schema.sql, covers.sql, paddock-points.sql, phones.sql, keep-photos.sql. Safe to run again.
--
-- Sign an adviser on: they open the app, put their name and email in Paddocks → Sync, and read you
-- the code; then
--   select public.approve_adviser('3F9-A21', '77207', 'Pat Smith', 'pat@example.com');
-- Run it again with another farm name to let them see that farm too.

alter table public.farm_members drop constraint if exists farm_members_role_check;
alter table public.farm_members add constraint farm_members_role_check check (role in ('member', 'admin', 'adviser'));
alter table public.devices add column if not exists account text not null default 'farm';
alter table public.devices drop constraint if exists devices_account_check;
alter table public.devices add constraint devices_account_check check (account in ('farm', 'adviser'));

-- May change the farm's data: a member who isn't an adviser.
create or replace function public.is_farm_worker(f uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.farm_members m where m.farm_id = f and m.user_id = auth.uid() and m.role <> 'adviser');
$$;

-- Reading stays is_farm_member; every write becomes is_farm_worker.
drop policy if exists "members use paddocks" on public.paddocks;
drop policy if exists "members read paddocks" on public.paddocks;
drop policy if exists "workers change paddocks" on public.paddocks;
create policy "members read paddocks" on public.paddocks for select to authenticated using (public.is_farm_member(farm_id));
create policy "workers change paddocks" on public.paddocks for all to authenticated
  using (public.is_farm_worker(farm_id)) with check (public.is_farm_worker(farm_id));

drop policy if exists "members use grazing log" on public.grazing_log;
drop policy if exists "members read grazing log" on public.grazing_log;
drop policy if exists "workers change grazing log" on public.grazing_log;
create policy "members read grazing log" on public.grazing_log for select to authenticated using (public.is_farm_member(farm_id));
create policy "workers change grazing log" on public.grazing_log for all to authenticated
  using (public.is_farm_worker(farm_id)) with check (public.is_farm_worker(farm_id));

drop policy if exists "members use cover readings" on public.cover_readings;
drop policy if exists "members read cover readings" on public.cover_readings;
drop policy if exists "workers change cover readings" on public.cover_readings;
create policy "members read cover readings" on public.cover_readings for select to authenticated using (public.is_farm_member(farm_id));
create policy "workers change cover readings" on public.cover_readings for all to authenticated
  using (public.is_farm_worker(farm_id)) with check (public.is_farm_worker(farm_id));

drop policy if exists "members use paddock points" on public.paddock_points;
drop policy if exists "members read paddock points" on public.paddock_points;
drop policy if exists "workers change paddock points" on public.paddock_points;
create policy "members read paddock points" on public.paddock_points for select to authenticated using (public.is_farm_member(farm_id));
create policy "workers change paddock points" on public.paddock_points for all to authenticated
  using (public.is_farm_worker(farm_id)) with check (public.is_farm_worker(farm_id));

drop policy if exists "members set feed settings" on public.farms;
create policy "members set feed settings" on public.farms
  for update to authenticated using (public.is_farm_worker(id)) with check (public.is_farm_worker(id));

-- Photos (keep-photos.sql split these already): reading stays open to members.
drop policy if exists "members add photos" on public.photos;
create policy "members add photos" on public.photos
  for insert to authenticated with check (public.is_farm_worker(farm_id));
drop policy if exists "members change photos" on public.photos;
create policy "members change photos" on public.photos
  for update to authenticated using (public.is_farm_worker(farm_id)) with check (public.is_farm_worker(farm_id));
drop policy if exists "members delete photos" on public.photos;
create policy "members delete photos" on public.photos
  for delete to authenticated using (public.is_farm_worker(farm_id) and public.photo_may_go(farm_id, storage_path));

drop policy if exists "members add farm photos" on storage.objects;
create policy "members add farm photos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and public.is_farm_worker(((storage.foldername(name))[1])::uuid));
drop policy if exists "members replace farm photos" on storage.objects;
create policy "members replace farm photos" on storage.objects
  for update to authenticated
  using (bucket_id = 'photos' and public.is_farm_worker(((storage.foldername(name))[1])::uuid));
drop policy if exists "members delete farm photos" on storage.objects;
create policy "members delete farm photos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos'
     and public.is_farm_worker(((storage.foldername(name))[1])::uuid)
     and public.photo_may_go(((storage.foldername(name))[1])::uuid, name));

drop policy if exists "members add reference photos" on public.reference_photos;
create policy "members add reference photos" on public.reference_photos
  for insert to authenticated
  with check (exists (select 1 from public.farm_members m where m.user_id = auth.uid() and m.role <> 'adviser'));

-- The app asks which farms it's on and in what role.
-- (farm_members is already readable by its own user: "users read their memberships".)

create or replace function public.approve_adviser(phone_code text, farm_name text,
                                                  person_name text default null, person_email text default null)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  d public.devices;
  f uuid;
begin
  select * into d from public.devices where code = upper(replace(phone_code, '-', ''));
  if not found then
    raise exception 'No device with code %', phone_code;
  end if;
  select id into f from public.farms where name = farm_name;
  if f is null then
    raise exception 'No farm called %', farm_name;
  end if;
  if exists (select 1 from public.farm_members where farm_id = f and user_id = d.user_id and role <> 'adviser') then
    raise exception 'Device % is already one of %''s own devices', phone_code, farm_name;
  end if;
  insert into public.farm_members (farm_id, user_id, role) values (f, d.user_id, 'adviser') on conflict do nothing;
  update public.devices
     set approved_at = coalesce(approved_at, now()),
         account = 'adviser',
         owner_name = coalesce(person_name, owner_name),
         owner_email = coalesce(person_email, owner_email)
   where user_id = d.user_id;
  return format('Adviser %s (%s) can now view %s', coalesce(person_name, d.owner_name, 'no name given'), d.code, farm_name);
end;
$$;
revoke execute on function public.approve_adviser(text, text, text, text) from public, anon, authenticated;

-- phone_list shows the account type and role too.
drop view if exists public.phone_list;
create view public.phone_list with (security_invoker = true) as
select substr(d.code, 1, 3) || '-' || substr(d.code, 4) as code,
       d.owner_name, d.owner_email, d.account,
       coalesce(string_agg(f.name || case when m.role = 'adviser' then ' (adviser)' else '' end, ', '), 'not approved') as farms,
       d.registered_at, d.approved_at, d.user_agent
from public.devices d
left join public.farm_members m on m.user_id = d.user_id
left join public.farms f on f.id = m.farm_id
group by d.user_id, d.code, d.owner_name, d.owner_email, d.account, d.registered_at, d.approved_at, d.user_agent;
revoke all on public.phone_list from anon, authenticated;
