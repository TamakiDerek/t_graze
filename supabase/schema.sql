-- t_graze database setup for Supabase. Paste the whole file into the SQL editor and run it.
-- Safe to run again: everything is "if not exists" / "or replace".
--
-- Model: every row belongs to a farm. A user sees and edits only the farms listed for them in
-- farm_members, and the database enforces it (row-level security), not the app.

create table if not exists public.farms (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.farm_members (
  farm_id uuid not null references public.farms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('member', 'admin')),
  primary key (farm_id, user_id)
);

create table if not exists public.paddocks (
  farm_id uuid not null references public.farms(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  created_at timestamptz not null default now(),
  primary key (farm_id, name)
);
-- Latest measured pasture cover in kg DM/ha and the day it was measured. Kept up to date
-- from cover_readings (covers.sql). Until the paddock is next grazed the phones show this instead of
-- their estimate.
alter table public.paddocks add column if not exists cover integer;
alter table public.paddocks add column if not exists cover_date date;
-- Paddock size in hectares (entered with the pencil on the phone, or imported).
alter table public.paddocks add column if not exists area_ha numeric(7,2) check (area_ha is null or area_ha > 0);
-- "Haybarn" and "haybarn" are the same paddock.
create unique index if not exists paddocks_name_ci on public.paddocks (farm_id, lower(name));

-- One row per farm per half-day; paddock names as typed on the phone (matched to the paddock list there).
create table if not exists public.grazing_log (
  farm_id uuid not null references public.farms(id) on delete cascade,
  day date not null,
  half text not null check (half in ('am', 'pm')),
  paddock_1 text,
  paddock_2 text,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid() references auth.users(id) on delete set null,
  primary key (farm_id, day, half)
);

create table if not exists public.photos (
  farm_id uuid not null references public.farms(id) on delete cascade,
  file text not null,              -- 2026_1117_8R9C+W2.jpg
  taken_at timestamptz not null,
  plus_code text not null,         -- full 10-digit code, e.g. 4VJQ676H+WP
  latitude double precision not null,
  longitude double precision not null,
  accuracy_m real,
  altitude_m real,
  storage_path text not null,      -- <farm_id>/<file> in the "photos" bucket
  uploaded_by uuid default auth.uid() references auth.users(id) on delete set null,
  uploaded_at timestamptz not null default now(),
  primary key (farm_id, file)
);
create index if not exists photos_plus_code on public.photos (farm_id, plus_code);

-- Membership check used by every policy. security definer so it can read farm_members
-- without tripping farm_members' own policy.
create or replace function public.is_farm_member(f uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.farm_members m where m.farm_id = f and m.user_id = auth.uid());
$$;

alter table public.farms enable row level security;
alter table public.farm_members enable row level security;
alter table public.paddocks enable row level security;
alter table public.grazing_log enable row level security;
alter table public.photos enable row level security;

drop policy if exists "members read their farms" on public.farms;
create policy "members read their farms" on public.farms
  for select to authenticated using (public.is_farm_member(id));

drop policy if exists "users read their memberships" on public.farm_members;
create policy "users read their memberships" on public.farm_members
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "members use paddocks" on public.paddocks;
create policy "members use paddocks" on public.paddocks
  for all to authenticated using (public.is_farm_member(farm_id)) with check (public.is_farm_member(farm_id));

drop policy if exists "members use grazing log" on public.grazing_log;
create policy "members use grazing log" on public.grazing_log
  for all to authenticated using (public.is_farm_member(farm_id)) with check (public.is_farm_member(farm_id));

drop policy if exists "members use photos" on public.photos;
create policy "members use photos" on public.photos
  for all to authenticated using (public.is_farm_member(farm_id)) with check (public.is_farm_member(farm_id));

-- Renaming a paddock carries through the grazing log, like it does on the phone.
create or replace function public.rename_paddock(f uuid, old_name text, new_name text)
returns void
language plpgsql security invoker set search_path = ''
as $$
begin
  update public.paddocks set name = new_name where farm_id = f and name = old_name;
  update public.grazing_log set paddock_1 = new_name where farm_id = f and paddock_1 = old_name;
  update public.grazing_log set paddock_2 = new_name where farm_id = f and paddock_2 = old_name;
end;
$$;

-- Photo files: private bucket, one folder per farm (<farm_id>/<file>).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 20971520, array['image/jpeg'])
on conflict (id) do nothing;

drop policy if exists "members read farm photos" on storage.objects;
create policy "members read farm photos" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and public.is_farm_member(((storage.foldername(name))[1])::uuid));

drop policy if exists "members add farm photos" on storage.objects;
create policy "members add farm photos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and public.is_farm_member(((storage.foldername(name))[1])::uuid));

drop policy if exists "members replace farm photos" on storage.objects;
create policy "members replace farm photos" on storage.objects
  for update to authenticated
  using (bucket_id = 'photos' and public.is_farm_member(((storage.foldername(name))[1])::uuid));
