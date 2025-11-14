// ======================================================
// GreenRoutes - app.js (versió amb fallback de CO₂ al frontend)
// - Geocodificació amb Nominatim
// - Dues rutes amb OpenRouteService (ECO i RÀPIDA)
// - Dibuixa rutes diferents (bici vs cotxe)
// - Calcula CO₂ al frontend i, si pot, el demana també al backend
// ======================================================

// ⚠️ 1) POSA AQUÍ LA TEVA API KEY REAL D'OPENROUTESERVICE
const ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImI3YjVjYmRkM2NjNTFmNGEyYjFmZmQ5OGQwM2Y5MTg3M2FjYTljNmRhOTgwODkzMDFmMDg3ODU0IiwiaCI6Im11cm11cjY0In0=";

// ⚠️ 2) URL del backend (Render i local). Canvia la de Render pel teu URL exacte.
const API_CANDIDATES = [
  "https://greenroutes-backend.onrender.com", // posa aquí el teu backend de Render
  "http://127.0.0.1:8000"
];

let API_BASE = null;

// Detecta quin backend està disponible (Render o local)
async function detectApiBase() {
  for (const base of API_CANDIDATES) {
    try {
      const r = await fetch(base + "/");
      if (r.ok) return base;
    } catch (e) {
      console.warn("No s'ha pogut contactar amb:", base);
    }
  }
  return null;
}

// -----------------------------
// Geocodificació Nominatim
// -----------------------------
async function geocode(query) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");

  const resp = await fetch(url.toString(), {
    headers: { "Accept-Language": "ca" }
  });

  if (!resp.ok) {
    throw new Error("Error en la geocodificació");
  }

  const data = await resp.json();
  return data.map((it) => ({
    name: it.display_name,
    lat: parseFloat(it.lat),
    lon: parseFloat(it.lon)
  }));
}

// Llista de suggeriments sota un <input>
function attachSuggest(inputEl, listEl) {
  let timer = null;

  inputEl.addEventListener("input", () => {
    clearTimeout(timer);
    const q = inputEl.value.trim();
    if (!q) {
      listEl.style.display = "none";
      listEl.innerHTML = "";
      return;
    }

    timer = setTimeout(async () => {
      try {
        const res = await geocode(q);
        if (!res.length) {
          listEl.style.display = "none";
          listEl.innerHTML = "";
          return;
        }
        listEl.innerHTML = res
          .map(
            (r) =>
              `<div class="sugg-item" data-lat="${r.lat}" data-lon="${r.lon}">
                 ${r.name}
               </div>`
          )
          .join("");
        listEl.style.display = "block";
      } catch (e) {
        console.error(e);
        listEl.style.display = "none";
        listEl.innerHTML = "";
      }
    }, 300);
  });

  listEl.addEventListener("click", (e) => {
    const el = e.target.closest(".sugg-item");
    if (!el) return;

    inputEl.value = el.textContent;
    inputEl.dataset.lat = el.dataset.lat;
    inputEl.dataset.lon = el.dataset.lon;
    listEl.style.display = "none";
  });

  document.addEventListener("click", (e) => {
    if (!listEl.contains(e.target) && e.target !== inputEl) {
      listEl.style.display = "none";
    }
  });
}

// -----------------------------
// Mapa Leaflet
// -----------------------------
const map = L.map("map").setView([41.3851, 2.1734], 13);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap"
}).addTo(map);

let originMarker = null;
let destMarker = null;
let ecoLayer = null;    // línia verda
let fastLayer = null;   // línia blava

const originInput = document.getElementById("origin_name");
const destInput   = document.getElementById("dest_name");
const suggOrigin  = document.getElementById("sugg_origin");
const suggDest    = document.getElementById("sugg_dest");
const modeSelect  = document.getElementById("route_mode");
const resultBox   = document.getElementById("result");

attachSuggest(originInput, suggOrigin);
attachSuggest(destInput,   suggDest);

// Assegura que tenim lat/lon a un input; sinó, geocodifica
async function ensureCoords(inputEl) {
  const name = inputEl.value.trim();
  if (!name) throw new Error("Introdueix un nom de lloc a origen i destí.");

  let lat = parseFloat(inputEl.dataset.lat || "NaN");
  let lon = parseFloat(inputEl.dataset.lon || "NaN");

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    const [first] = await geocode(name);
    if (!first) {
      throw new Error(`No s'ha trobat cap resultat per: ${name}`);
    }
    lat = first.lat;
    lon = first.lon;
    inputEl.dataset.lat = String(lat);
    inputEl.dataset.lon = String(lon);
    inputEl.value = first.name;
  }

  return { name, lat, lon };
}

// -----------------------------
// Rutes amb OpenRouteService (GET)
// -----------------------------

// Demana una ruta a ORS amb GET:
// profile = "cycling-regular" (eco) o "driving-car" (ràpida)
async function getORSRoute(profile, start, end) {
  const startLonLat = `${start[1]},${start[0]}`;
  const endLonLat   = `${end[1]},${end[0]}`;

  const url = new URL(
    `https://api.openrouteservice.org/v2/directions/${profile}`
  );
  url.searchParams.set("api_key", ORS_API_KEY);
  url.searchParams.set("start", startLonLat);
  url.searchParams.set("end", endLonLat);

  const resp = await fetch(url.toString());

  if (!resp.ok) {
    const txt = await resp.text();
    console.error("Error ORS HTTP:", txt);
    throw new Error("Error en la petició a OpenRouteService");
  }

  const data = await resp.json();
  console.log("Resposta ORS", profile, data); // DEBUG a consola

  if (!data.features || !data.features.length) {
    throw new Error("Resposta d'ORS sense rutes (revisa la API key o el perfil)");
  }

  const feat = data.features[0];
  return {
    geometry: feat.geometry,
    distance: feat.properties.summary.distance, // metres
    duration: feat.properties.summary.duration  // segons
  };
}

// -----------------------------
// Flux principal: calcular ruta
// -----------------------------
document.getElementById("calc_btn").addEventListener("click", calculateRoute);

originInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") calculateRoute();
});
destInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") calculateRoute();
});

async function calculateRoute() {
  const btn = document.getElementById("calc_btn");
  btn.disabled = true;
  resultBox.textContent = "Calculant rutes...";

  try {
    const o = await ensureCoords(originInput);
    const d = await ensureCoords(destInput);
    const mode = modeSelect.value; // "eco" o "fast"

    const start = [o.lat, o.lon];
    const end   = [d.lat, d.lon];

    // Marcadors
    if (originMarker) map.removeLayer(originMarker);
    if (destMarker)   map.removeLayer(destMarker);

    originMarker = L.marker(start).addTo(map).bindPopup("Origen").openPopup();
    destMarker   = L.marker(end).addTo(map).bindPopup("Destí");

    // Demanem dues rutes: ECO (bici) i RÀPIDA (cotxe)
    const [ecoRoute, fastRoute] = await Promise.all([
      getORSRoute("cycling-regular", start, end),
      getORSRoute("driving-car",    start, end)
    ]);

    const mainIsEco = (mode === "eco");
    const mainRoute = mainIsEco ? ecoRoute : fastRoute;
    const altRoute  = mainIsEco ? fastRoute : ecoRoute;

    const mainColor = mainIsEco ? "#16a34a" : "#2563eb"; // verd o blau
    const altColor  = mainIsEco ? "#2563eb" : "#16a34a";

    // Esborrem capes anteriors
    if (ecoLayer)  map.removeLayer(ecoLayer);
    if (fastLayer) map.removeLayer(fastLayer);

    // Ruta principal (gruixuda, opaca)
    const mainLayer = L.geoJSON(mainRoute.geometry, {
      style: { color: mainColor, weight: 6, opacity: 0.95 }
    }).addTo(map);

    // Ruta alternativa (més fina, discontínua)
    const altLayer = L.geoJSON(altRoute.geometry, {
      style: { color: altColor, weight: 3, opacity: 0.6, dashArray: "6 6" }
    }).addTo(map);

    if (mainIsEco) {
      ecoLayer  = mainLayer;
      fastLayer = altLayer;
    } else {
      fastLayer = mainLayer;
      ecoLayer  = altLayer;
    }

    map.fitBounds(mainLayer.getBounds(), { padding: [30, 30] });

    const ecoDistKm  = (ecoRoute.distance  / 1000).toFixed(2);
    const fastDistKm = (fastRoute.distance / 1000).toFixed(2);
    const mainDistKm = (mainRoute.distance / 1000).toFixed(2);
    const mainDurMin = Math.round(mainRoute.duration / 60);

    // -----------------------------
    // Fallback de CO₂ al frontend
    // -----------------------------
    // Factors d'emissió molt simplificats:
    // - bici: 30 g/km
    // - cotxe: 120 g/km
    const factorEco  = 30;   // g/km (bici)
    const factorFast = 120;  // g/km (cotxe)
    const factor     = mainIsEco ? factorEco : factorFast;

    let co2Text = `${Math.round(mainDistKm * factor)} g`; // valor per defecte
    let recText = mainIsEco
      ? "Ruta ECO prioritzada (bici)"
      : "Ruta RÀPIDA prioritzada (cotxe)";

    // Intentar demanar CO₂ al backend, si està disponible
    if (API_BASE === null) {
      API_BASE = await detectApiBase();
      console.log("API_BASE detectada:", API_BASE);
    }

    if (API_BASE) {
      try {
        const resp = await fetch(API_BASE + "/route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            start_lat: o.lat,
            start_lon: o.lon,
            end_lat:   d.lat,
            end_lon:   d.lon,
            mode:      mode
          })
        });

        if (resp.ok) {
          const data = await resp.json();
          // Si el backend respon bé, sobreescrivim el valor
          co2Text = `${data.co2_estimated_g} g`;
          recText = data.recommendation;
        } else {
          console.warn("Error HTTP backend:", resp.status);
        }
      } catch (e) {
        console.warn("No s'ha pogut contactar amb el backend per CO₂:", e);
      }
    }

    // Resultat final a la interfície
    resultBox.innerHTML = `
      <b>Distància ECO (bici):</b> ${ecoDistKm} km ·
      <b>Distància RÀPIDA (cotxe):</b> ${fastDistKm} km<br>
      <b>Distància usada:</b> ${mainDistKm} km ·
      <b>Durada estimada:</b> ${mainDurMin} min<br>
      <b>CO₂ estimat:</b> ${co2Text}<br>
      <b>Recomanació:</b> ${recText}<br>
      <span class="muted">
        Línia verda = perfil bicicleta (cycling-regular).<br>
        Línia blava = perfil cotxe (driving-car).
      </span>
    `;
  } catch (e) {
    console.error(e);
    resultBox.textContent = e.message || "Error en el càlcul de la ruta.";
  } finally {
    btn.disabled = false;
  }
}