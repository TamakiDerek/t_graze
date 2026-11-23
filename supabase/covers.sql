-- Measured pasture covers, with what the app predicted for the same paddock and day.
-- Run after schema.sql and phones.sql. Safe to run again.
--
-- Every measurement is kept (not just the latest), next to the app's estimate at that moment, so the
-- growth curve and later the season, warmth and moisture factors can be fitted to real data.

create table if not exists public.cover_readings (
  farm_id uuid not null references public.farms(id) on delete cascade,
  paddock text not null,
  day date not null,                 -- day measured
  cover integer not null check (cover between 0 and 10000),   -- measured kg DM/ha
  predicted integer,                 -- what the app showed for that paddock that day (null if never grazed or measured)
  days_since_grazed integer,         -- days from the last grazing to the measurement (null if never grazed)
  model text,                        -- which estimate produced "predicted", e.g. 'curve-2026-11-23'
  entered_by uuid default auth.uid() references auth.users(id) on delete set null,
  entered_at timestamptz not null default now(),
  primary key (farm_id, paddock, day)   -- one reading per paddock per day; re-entering corrects it
);

alter table public.cover_readings enable row level security;

drop policy if exists "members use cover readings" on public.cover_readings;
create policy "members use cover readings" on public.cover_readings
  for all to authenticated using (public.is_farm_member(farm_id)) with check (public.is_farm_member(farm_id));

-- Where "predicted" grew from: the previous measurement, or the 1500 residual the day after grazing.
alter table public.cover_readings add column if not exists start_cover integer;
alter table public.cover_readings add column if not exists start_day date;

-- The newest reading becomes the paddock's current measured cover (paddocks.cover / cover_date),
-- which every phone downloads and shows as "m<days>", growing, until the paddock is next grazed.
create or replace function public.cover_reading_to_paddock()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
begin
  update public.paddocks p
     set cover = new.cover, cover_date = new.day
   where p.farm_id = new.farm_id and lower(p.name) = lower(new.paddock)
     and (p.cover_date is null or p.cover_date <= new.day);
  return new;
end;
$$;

drop trigger if exists cover_reading_to_paddock on public.cover_readings;
create trigger cover_reading_to_paddock after insert or update on public.cover_readings
  for each row execute function public.cover_reading_to_paddock();

-- Renaming a paddock carries through the grazing log and its cover readings.
create or replace function public.rename_paddock(f uuid, old_name text, new_name text)
returns void
language plpgsql security invoker set search_path = ''
as $$
begin
  update public.paddocks set name = new_name where farm_id = f and name = old_name;
  update public.grazing_log set paddock_1 = new_name where farm_id = f and paddock_1 = old_name;
  update public.grazing_log set paddock_2 = new_name where farm_id = f and paddock_2 = old_name;
  update public.cover_readings set paddock = new_name where farm_id = f and paddock = old_name;
end;
$$;
