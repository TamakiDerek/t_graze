-- Phone approval: each phone signs itself in anonymously (no email or password) and shows a
-- short code. Approving the code links that phone to a farm. Run after schema.sql; safe to re-run.
-- Needs Authentication → Sign In / Providers → "Allow anonymous sign-ins" switched on.

create table if not exists public.devices (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  code text not null unique check (code ~ '^[0-9A-F]{6}$'),  -- shown on the phone as 3F9-A21
  user_agent text,
  registered_at timestamptz not null default now(),
  approved_at timestamptz
);

alter table public.devices enable row level security;

drop policy if exists "phone registers itself" on public.devices;
create policy "phone registers itself" on public.devices
  for insert to authenticated with check (user_id = auth.uid() and approved_at is null);

drop policy if exists "phone reads itself" on public.devices;
create policy "phone reads itself" on public.devices
  for select to authenticated using (user_id = auth.uid());

-- Run in the SQL editor:  select public.approve_phone('3F9A21', 'Trial farm');
-- Creates the farm if it's new. Only the dashboard (database owner) can call it, never the app.
create or replace function public.approve_phone(phone_code text, farm_name text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  d public.devices;
  f uuid;
begin
  select * into d from public.devices where code = upper(replace(phone_code, '-', ''));
  if not found then
    raise exception 'No phone with code %', phone_code;
  end if;
  insert into public.farms (name) values (farm_name)
  on conflict (name) do update set name = excluded.name
  returning id into f;
  insert into public.farm_members (farm_id, user_id) values (f, d.user_id) on conflict do nothing;
  update public.devices set approved_at = now() where user_id = d.user_id;
  return format('Phone %s approved for %s', d.code, farm_name);
end;
$$;
revoke execute on function public.approve_phone(text, text) from public, anon, authenticated;

-- Phones waiting for approval, newest first:
--   select code, user_agent, registered_at from public.devices where approved_at is null order by registered_at desc;
