// Supabase project the app syncs to. The publishable key is meant to be public: what a signed-in
// user can read or write is decided by the database's row-level security (supabase/schema.sql).
export const SUPABASE_URL = "https://kjllmohuevseekjaeqth.supabase.co";
export const SUPABASE_KEY = "sb_publishable_5lq0Z9O2xCGDLytWrZAC9Q_CZka8mba";

// LINZ Basemaps aerial imagery for the maps (free; CC BY 4.0, attribution shown on the map). Which farms use
// it is each farm's own setting (supabase/basemap.sql).
// The key from LINZ (basemaps@linz.govt.nz): unrestricted, and LINZ have agreed to it sitting in this public
// web code for the rollout. If its traffic shows someone else using it, LINZ will contact us and change it.
// Empty: every farm's map shows Esri World Imagery.
export const LINZ_BASEMAPS_KEY = "d01m5g152e32j17h1ax98gvmfgb";
