// The aerial imagery under a farm's maps. Each farm has its own setting (farms.basemap, see
// supabase/basemap.sql): LINZ Basemaps by default, or Esri World Imagery. Without a LINZ key every farm
// gets Esri. Needs Leaflet (L) loaded.
import { LINZ_BASEMAPS_KEY } from "./config.js";

const LINZ_CREDIT = '© <a href="https://www.linz.govt.nz/linz-copyright" target="_blank" rel="noopener">LINZ CC BY 4.0</a> © <a href="https://www.linz.govt.nz/data/linz-data/linz-basemaps/data-attribution" target="_blank" rel="noopener">Imagery Basemap contributors</a>';
const ESRI_CREDIT = "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS user community";

/** Adds the farm's aerial imagery to a Leaflet map (short credits for a small map). */
export async function addAerial(map, cloud, { short = false } = {}) {
  let which = "linz";
  try {
    const [f] = await cloud.request(`/rest/v1/farms?select=basemap&id=eq.${cloud.state.farmId}`);
    which = f?.basemap ?? which;
  } catch (err) {
    console.warn("map setting:", err);
  }
  const layer = which === "linz" && LINZ_BASEMAPS_KEY
    ? L.tileLayer(`https://basemaps.linz.govt.nz/v1/tiles/aerial/3857/{z}/{x}/{y}.webp?api=${encodeURIComponent(LINZ_BASEMAPS_KEY)}`, {
      maxZoom: 21, maxNativeZoom: 20, attribution: short ? "© LINZ CC BY 4.0" : LINZ_CREDIT,
    })
    : L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 21, maxNativeZoom: 19, attribution: short ? "Imagery © Esri" : ESRI_CREDIT,
    });
  layer.addTo(map);
  layer.bringToBack();
}
