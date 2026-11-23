-- Reference ("for comparison") photos: pictures of known pasture cover to compare paddock photos with.
-- The images live in the private storage bucket "reference" (not in this public repo: they belong to
-- their publishers). Each row says what the picture shows and where it came from.
create table if not exists public.reference_photos (
  file text primary key,                 -- object name in the "reference" bucket
  cover integer not null,                -- kg DM/ha the source gives for the picture
  kind text not null check (kind in ('pre', 'residual')),  -- pre-grazing cover or post-grazing residual
  view text not null check (view in ('boot', 'paddock')),  -- close-up with a boot in frame, or a wide paddock view
  source text not null,
  page integer,
  note text,
  added_at timestamptz not null default now()
);
alter table public.reference_photos enable row level security;
-- Shared by every farm: any approved phone may read and add them.
drop policy if exists "members read reference photos" on public.reference_photos;
create policy "members read reference photos" on public.reference_photos
  for select to authenticated
  using (exists (select 1 from public.farm_members m where m.user_id = auth.uid()));
drop policy if exists "members add reference photos" on public.reference_photos;
create policy "members add reference photos" on public.reference_photos
  for insert to authenticated
  with check (exists (select 1 from public.farm_members m where m.user_id = auth.uid()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('reference', 'reference', false, 20971520, array['image/jpeg'])
on conflict (id) do nothing;
drop policy if exists "members read reference images" on storage.objects;
create policy "members read reference images" on storage.objects
  for select to authenticated
  using (bucket_id = 'reference' and exists (select 1 from public.farm_members m where m.user_id = auth.uid()));

-- DairyNZ "Perennial ryegrass grazing management pocket guide" (2026).
insert into public.reference_photos (file, cover, kind, view, source, page, note) values
  ('ref01_pre_2000.jpg', 2000, 'pre', 'boot', 'DairyNZ ryegrass pocket guide 2026', 14, null),
  ('ref02_pre_2500.jpg', 2500, 'pre', 'boot', 'DairyNZ ryegrass pocket guide 2026', 14, null),
  ('ref03_pre_3000.jpg', 3000, 'pre', 'boot', 'DairyNZ ryegrass pocket guide 2026', 15, null),
  ('ref04_pre_3500.jpg', 3500, 'pre', 'boot', 'DairyNZ ryegrass pocket guide 2026', 15, null),
  ('ref05_residual_1300.jpg', 1300, 'residual', 'paddock', 'DairyNZ ryegrass pocket guide 2026', 18, '6 clicks, plate meter in view'),
  ('ref06_residual_1300.jpg', 1300, 'residual', 'paddock', 'DairyNZ ryegrass pocket guide 2026', 19, 'below target / over-grazed'),
  ('ref07_residual_1300.jpg', 1300, 'residual', 'paddock', 'DairyNZ ryegrass pocket guide 2026', 19, 'below target / over-grazed'),
  ('ref08_residual_1500.jpg', 1500, 'residual', 'paddock', 'DairyNZ ryegrass pocket guide 2026', 20, '7 clicks'),
  ('ref09_residual_1500.jpg', 1500, 'residual', 'paddock', 'DairyNZ ryegrass pocket guide 2026', 21, 'target residual 7-8 clicks'),
  ('ref10_residual_1500.jpg', 1500, 'residual', 'paddock', 'DairyNZ ryegrass pocket guide 2026', 21, 'target residual 7-8 clicks'),
  ('ref11_residual_1750.jpg', 1750, 'residual', 'paddock', 'DairyNZ ryegrass pocket guide 2026', 22, '9 clicks'),
  ('ref12_residual_1750.jpg', 1750, 'residual', 'paddock', 'DairyNZ ryegrass pocket guide 2026', 23, 'above target / under-grazed'),
  ('ref13_residual_1750.jpg', 1750, 'residual', 'paddock', 'DairyNZ ryegrass pocket guide 2026', 23, 'above target / under-grazed'),
  ('ref14_residual_1900.jpg', 1900, 'residual', 'paddock', 'DairyNZ ryegrass pocket guide 2026', 24, '10 clicks'),
  ('ref15_residual_1900.jpg', 1900, 'residual', 'paddock', 'DairyNZ ryegrass pocket guide 2026', 25, 'above target / under-grazed'),
  ('ref16_residual_1900.jpg', 1900, 'residual', 'paddock', 'DairyNZ ryegrass pocket guide 2026', 25, 'above target / under-grazed'),
  ('ref17_residual_1500.jpg', 1500, 'residual', 'paddock', 'DairyNZ ryegrass pocket guide 2026', 26, null),
  ('ref18_residual_1700.jpg', 1700, 'residual', 'paddock', 'DairyNZ ryegrass pocket guide 2026', 26, 'more leaf remaining'),
  ('ref19_residual_1700.jpg', 1700, 'residual', 'paddock', 'DairyNZ ryegrass pocket guide 2026', 27, null),
  ('ref20_residual_1900.jpg', 1900, 'residual', 'paddock', 'DairyNZ ryegrass pocket guide 2026', 27, 'larger clumps'),
  ('ref21_residual_1300.jpg', 1300, 'residual', 'paddock', 'DairyNZ ryegrass pocket guide 2026', 28, '6 clicks'),
  ('ref22_residual_1900.jpg', 1900, 'residual', 'paddock', 'DairyNZ ryegrass pocket guide 2026', 28, '10 clicks'),
  ('ref23_residual_1500.jpg', 1500, 'residual', 'paddock', 'DairyNZ ryegrass pocket guide 2026', 29, 'from a pre-grazing cover of 2800; green at base'),
  ('ref24_residual_1700.jpg', 1700, 'residual', 'paddock', 'DairyNZ ryegrass pocket guide 2026', 29, 'from a pre-grazing cover of 4000; pale, stemmy base')
on conflict (file) do update set cover = excluded.cover, kind = excluded.kind, view = excluded.view,
  source = excluded.source, page = excluded.page, note = excluded.note;
