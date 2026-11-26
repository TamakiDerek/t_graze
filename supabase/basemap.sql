-- Which aerial imagery a farm's maps (laptop map, phone Accept tab) show: 'linz' (LINZ Basemaps, needs
-- LINZ_BASEMAPS_KEY in app/config.js) or 'esri' (Esri World Imagery). Changed by hand, one farm at a time:
--   update public.farms set basemap = 'esri' where id = '...';
alter table public.farms add column if not exists basemap text not null default 'linz';
alter table public.farms drop constraint if exists farms_basemap_check;
alter table public.farms add constraint farms_basemap_check check (basemap in ('linz', 'esri'));

-- 77207 stays on the imagery it has used so far.
update public.farms set basemap = 'esri' where id = '26a78a3a-6ed2-4a0a-a488-c8c63e927c28';
