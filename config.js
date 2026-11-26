// Supabase project the app syncs to. The publishable key is meant to be public: what a signed-in
// user can read or write is decided by the database's row-level security (supabase/schema.sql).
export const SUPABASE_URL = "https://kjllmohuevseekjaeqth.supabase.co";
export const SUPABASE_KEY = "sb_publishable_5lq0Z9O2xCGDLytWrZAC9Q_CZka8mba";

// LINZ Basemaps aerial imagery for the maps (free; CC BY 4.0, attribution shown on the map). Which farms use
// it is each farm's own setting (supabase/basemap.sql).
// Paste the key from LINZ here: a Developer Access key (static, restricted to the app's website), requested
// free from basemaps@linz.govt.nz. Like the Supabase key above, it's meant to sit in public web code.
// Empty: every farm's map shows Esri World Imagery.
export const LINZ_BASEMAPS_KEY = "";
