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

-- ---------- Who each phone belongs to ----------
-- The phone's owner types their name and email in the app (Paddocks → Sync); they can change them
-- any time, but nothing else on their device row. The approver can also set or correct them.
alter table public.devices add column if not exists owner_name text;
alter table public.devices add column if not exists owner_email text;

revoke update on public.devices from anon, authenticated;
grant update (owner_name, owner_email) on public.devices to authenticated;
drop policy if exists "phone names its owner" on public.devices;
create policy "phone names its owner" on public.devices
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- approve_phone gains optional name/email (kept as typed on the phone when left out):
--   select public.approve_phone('3F9-A21', '77207');
--   select public.approve_phone('3F9-A21', '77207', 'Sam Smith', 'sam@example.com');
drop function if exists public.approve_phone(text, text);
create or replace function public.approve_phone(phone_code text, farm_name text,
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
    raise exception 'No phone with code %', phone_code;
  end if;
  insert into public.farms (name) values (farm_name)
  on conflict (name) do update set name = excluded.name
  returning id into f;
  insert into public.farm_members (farm_id, user_id) values (f, d.user_id) on conflict do nothing;
  update public.devices
     set approved_at = coalesce(approved_at, now()),
         owner_name = coalesce(person_name, owner_name),
         owner_email = coalesce(person_email, owner_email)
   where user_id = d.user_id;
  return format('Phone %s approved for %s (%s)', d.code, farm_name,
                coalesce(person_name, d.owner_name, 'no name given'));
end;
$$;
revoke execute on function public.approve_phone(text, text, text, text) from public, anon, authenticated;

-- Every phone, who it belongs to, and which farm it's approved for:
create or replace view public.phone_list with (security_invoker = true) as
select substr(d.code, 1, 3) || '-' || substr(d.code, 4) as code,
       d.owner_name, d.owner_email,
       coalesce(string_agg(f.name, ', '), 'not approved') as farms,
       d.registered_at, d.approved_at, d.user_agent
from public.devices d
left join public.farm_members m on m.user_id = d.user_id
left join public.farms f on f.id = m.farm_id
group by d.user_id, d.code, d.owner_name, d.owner_email, d.registered_at, d.approved_at, d.user_agent;
revoke all on public.phone_list from anon, authenticated;
--   select * from public.phone_list order by approved_at nulls first, registered_at desc;
