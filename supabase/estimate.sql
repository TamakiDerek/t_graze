-- Automatic cover estimates: when a photo row is added, ask the estimate-cover Edge Function
-- (supabase/functions/estimate-cover) to look at it. Run after schema.sql and reference.sql.
--
-- PARKED (2026-11-24): the trigger is NOT installed on the live database. Automatic estimates wait for a
-- set of calibrated comparison photos and a cheaper model (cost per photo vs the subscription); until then
-- covers are estimated by hand. To switch it on: add the ANTHROPIC_API_KEY secret, then run this file.
-- To switch it off again: drop trigger if exists photo_added_estimate on public.photos;

-- How many times the estimator has tried a photo (it gives up after 3).
alter table public.photos add column if not exists estimate_attempts smallint not null default 0;

-- Reference photos can be switched off without deleting them (e.g. when our own calibrated photos replace
-- the DairyNZ ones).
alter table public.reference_photos add column if not exists active boolean not null default true;

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
