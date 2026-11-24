-- Automatic cover estimates: when a photo row is added, ask the estimate-cover Edge Function
-- (supabase/functions/estimate-cover) to look at it. Run after schema.sql and reference.sql.
--
-- PARKED (2026-11-24): the trigger is NOT installed on the live database. Automatic estimates wait for a
-- set of calibrated comparison photos and a cheaper model (cost per photo vs the subscription); until then
-- covers are estimated by hand. To switch it on: add the ANTHROPIC_API_KEY secret, then run this file.
-- To switch it off again: drop trigger if exists photo_added_estimate on public.photos;

-- How many times the estimator has tried a photo (it gives up after 3).
alter table public.photos add column if not exists estimate_attempts smallint not null default 0;
-- The model's own answer, kept apart from cover_estimate / cover_accepted so the two can be compared
-- (0 = looked at, couldn't judge). A photo with no cover estimate yet also gets it as its cover_estimate.
alter table public.photos add column if not exists auto_estimate integer;
alter table public.photos add column if not exists auto_estimate_by text;

-- Reference photos can be switched off without deleting them (e.g. when our own calibrated photos replace
-- the DairyNZ ones).
alter table public.reference_photos add column if not exists active boolean not null default true;

-- Farm photos can become reference photos (kind 'farm'): photos taken with the app whose cover was
-- accepted, copied into the reference bucket by the estimate-cover function
-- ({"add_farm_references": "<farm id>"}). photo_file is the photo it came from, so that photo is never
-- compared with itself.
alter table public.reference_photos add column if not exists photo_file text;
alter table public.reference_photos drop constraint if exists reference_photos_kind_check;
alter table public.reference_photos add constraint reference_photos_kind_check check (kind in ('pre', 'residual', 'farm'));
-- The DairyNZ pictures aren't uploaded (they belong to DairyNZ); the farm's own accepted photos stand in
-- until professionally calibrated photos replace them.
update public.reference_photos set active = false where source like 'DairyNZ%';

create extension if not exists pg_net with schema extensions;

-- Fire and forget: pg_net sends the request after the insert commits, so uploads never wait for it.
-- The function needs no secret from the caller (it only estimates photos that have no estimate yet).
create or replace function public.photo_added_estimate() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform net.http_post(
    url := 'https://kjllmohuevseekjaeqth.supabase.co/functions/v1/estimate-cover',
    body := jsonb_build_object('file', new.file),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 1000);
  return new;
end $$;

drop trigger if exists photo_added_estimate on public.photos;
create trigger photo_added_estimate after insert on public.photos
  for each row execute function public.photo_added_estimate();
