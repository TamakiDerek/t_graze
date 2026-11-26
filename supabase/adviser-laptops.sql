-- An adviser's laptop shares their phone's photo space (run after advisers.sql).
-- Phone and laptop are separate devices (separate sign-ins) until there's email sign-in, so the laptop
-- is approved "like" the phone: it gets the same memberships, so it sees the same photo space and farms.
--   select public.approve_adviser_laptop('LAPTOP-CODE', 'PHONE-CODE');

create or replace function public.approve_adviser_laptop(laptop_code text, phone_code text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  l public.devices;
  p public.devices;
  n int;
begin
  select * into l from public.devices where code = upper(replace(laptop_code, '-', ''));
  if not found then raise exception 'No device with code %', laptop_code; end if;
  select * into p from public.devices where code = upper(replace(phone_code, '-', ''));
  if not found then raise exception 'No device with code %', phone_code; end if;
  if p.account <> 'adviser' or p.approved_at is null then
    raise exception 'Device % is not an approved adviser', phone_code;
  end if;
  insert into public.farm_members (farm_id, user_id, role)
    select m.farm_id, l.user_id, m.role from public.farm_members m where m.user_id = p.user_id
    on conflict do nothing;
  get diagnostics n = row_count;
  update public.devices
     set approved_at = coalesce(approved_at, now()), account = 'adviser',
         owner_name = coalesce(owner_name, p.owner_name), owner_email = coalesce(owner_email, p.owner_email)
   where user_id = l.user_id;
  return format('Laptop %s shares adviser %s''s photo space and farms (%s memberships added)',
                l.code, coalesce(p.owner_name, p.code), n);
end;
$$;
revoke execute on function public.approve_adviser_laptop(text, text) from public, anon, authenticated;

-- Everyone (each of an adviser's devices) sharing a photo space with me: the laptop uses it to pick out
-- the adviser's own photos on a farm, which carry the phone's user as uploaded_by.
create or replace function public.adviser_people()
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select distinct o.user_id
    from public.farm_members me
    join public.farms f on f.id = me.farm_id and f.kind = 'adviser'
    join public.farm_members o on o.farm_id = me.farm_id
   where me.user_id = auth.uid();
$$;
revoke execute on function public.adviser_people() from public, anon;
grant execute on function public.adviser_people() to authenticated;
