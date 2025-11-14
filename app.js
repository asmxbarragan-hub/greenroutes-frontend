// ======================================================
// GreenRoutes - app.js (VERSIÓ COMPLETA DEFINITIVA)
// - Geocodificació (Nominatim)
// - Rutes ECO i RÀPIDA amb OpenRouteService
// - Dibuixa les dues rutes (eco i ràpida) al mapa
// - Crida al backend (local o Render) per CO₂ i recomanació
// ======================================================


// -----------------------------
// 0) Config global
// -----------------------------

// ⚠️ POSA AQUÍ LA TEVA API KEY D'OPENROUTESERVICE
const ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6ImI3YjVjYmRkM2NjNTFmNGEyYjFmZmQ5OGQwM2Y5MTg3M2FjYTljNmRhOTgwODkzMDFmMDg3ODU0IiwiaCI6Im11cm11cjY0In0=";

// Possible backends per al càlcul de CO₂
let API_BASE = null;
const API_CANDIDATES = [
  "https://greenroutes-backend.onrender.com", // canvia-ho si el teu Render té un altre nom
  "http://127.0.0.1:8000"
];

async function detectApiBase() {
  for (const base of API_CANDIDATES) {
    try {
      const r = await fetch(base + "/");
      if (r.ok) return base;
    } catch (_) {
      // ignorem errors i provem el següent
    }
  }
  return null; // si no hi ha backend disponible
}


// -----------------------------
// 1) Geocodificació i suggeriments
// -----------------------------

// Converteix el nom d'un lloc a coordenades amb Nominatim (OSM)
async function geocode(query) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");

  const resp = await fetch(url.toString(), {
    headers: { "Accept-Language": "ca" }
  });

  if (!resp.ok) throw new Error("Error geocodificant");

  const data = await resp.json();
  return data.map((it) => ({
    name: it.display_name,
    lat: parseFloat(it.lat),
    lon: parseFloat(it.lon)
  }));
}

// Afegeix llista de suggeriments sota d'un <input>
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
              `<div class="sugg-item" data-lat="${r.lat}" data-lon="${r.lon}">${r.name}</div>`
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
// 2) Inicialització del mapa Leaflet
// -----------------------------

const map = L.map("map").setView([41.3851, 2.1734], 13);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap"
}).addTo(map);

let originMarker = null;
let destMarker = null;
let ecoLayer = null;   // capa ruta eco (verda)
let fastLayer = null;  // capa ruta ràpida (blava)


// -----------------------------
// 3) Helpers de coordenades
// -----------------------------

const originInput = document.getElementById("origin_name");
const destInput   = document.getElementById("dest_name");
const modeSelect  = document.getElementById("route_mode");
const suggOrigin  = document.getElementById("sugg_origin");
const suggDest    = document.getElementById("sugg_dest");
const resultBox   = document.getElementById("result");

attachSuggest(originInput, suggOrigin);
attachSuggest(destInput,   suggDest);

// Garanteix que tenim (lat, lon) en un input; si no, geocodifica
async function ensureCoords(inputEl) {
  const name = inputEl.value.trim();
  if (!name) throw new Error("Introdueix un nom de lloc a origen i destí.");

  let lat = parseFloat(inputEl.dataset.lat || "NaN");
  let lon = parseFloat(inputEl.dataset.lon || "NaN");

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    const [first] = await geocode(name);
    if (!first) throw new Error(`No s'ha trobat cap resultat per: ${name}`);
    lat = first.lat;
    lon = first.lon;
    inputEl.dataset.lat = String(lat);
    inputEl.dataset.lon = String(lon);
    inputEl.value = first.name; // nom "bonic"
  }

  return { name, lat, lon };
}


// -----------------------------
// 4) Rutes amb OpenRouteService
// -----------------------------

// Crida genèrica a ORS per obtenir una ruta amb un perfil concret
// profile: "cycling-regular", "driving-car", "foot-walking", etc.
async function getORSRoute(profile, start, end) {
  const body = {
    coordinates: [
      [start[1], start[0]],
      [end[1], end[0]]
    ]
  };

  const resp = await fetch(
    `https://api.openrouteservice.org/v2/directions/${profile}`,
    {
      method: "POST",
      headers: {
        Authorization: ORS_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  if (!resp.ok) {
    console.error("Error ORS:", await resp.text());
    throw new Error("Error obtenint ruta d'OpenRouteService");
  }

  const data = await resp.json();
  if (!data.features || !data.features.length) {
    throw new Error("Resposta d'ORS sense rutes");
  }

  const feat = data.features[0];
  return {
    geometry: feat.geometry,
    distance: feat.properties.summary.distance, // en metres
    duration: feat.properties.summary.duration  // en segons
  };
}


// -----------------------------
// 5) Flux principal: calcular rutes
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
    // 1) Coordenades d'origen i destí
    const o = await ensureCoords(originInput);
    const d = await ensureCoords(destInput);
    const mode = modeSelect.value; // "eco" o "fast"

    const start = [o.lat, o.lon];
    const end   = [d.lat, d.lon];

    // 2) Marcadors al mapa
    if (originMarker) map.removeLayer(originMarker);
    if (destMarker)   map.removeLayer(destMarker);

    originMarker = L.marker(start).addTo(map).bindPopup("Origen").openPopup();
    destMarker   = L.marker(end).addTo(map).bindPopup("Destí");

    // 3) Demanar LES DUES rutes a ORS en paral·lel
    //    - ECO: perfil bici (cycling-regular)
    //    - FAST: perfil cotxe (driving-car)
    const [ecoRoute, fastRoute] = await Promise.all([
      getORSRoute("cycling-regular", start, end),
      getORSRoute("driving-car",    start, end)
    ]);

    // 4) Escollim ruta principal segons el mode triat
    const mainIsEco = (mode === "eco");
    const mainRoute = mainIsEco ? ecoRoute : fastRoute;
    const altRoute  = mainIsEco ? fastRoute : ecoRoute;

    const mainColor = mainIsEco ? "#16a34a" : "#2563eb"; // verd o blau
    const altColor  = mainIsEco ? "#2563eb" : "#16a34a";

    // 5) Esborrem capes anteriors i dibuixem les noves
    if (ecoLayer)  map.removeLayer(ecoLayer);
    if (fastLayer) map.removeLayer(fastLayer);

    // Ruta principal (més gruix)
    const mainLayer = L.geoJSON(mainRoute.geometry, {
      style: { color: mainColor, weight: 6, opacity: 0.95 }
    }).addTo(map);

    // Ruta alternativa (més fina i discontínua)
    const altLayerLocal = L.geoJSON(altRoute.geometry, {
      style: { color: altColor, weight: 3, opacity: 0.6, dashArray: "6 6" }
    }).addTo(map);

    // Guardem referències globals (per si cal esborrar després)
    if (mainIsEco) {
      ecoLayer = mainLayer;
      fastLayer = altLayerLocal;
    } else {
      fastLayer = mainLayer;
      ecoLayer = altLayerLocal;
    }

    map.fitBounds(mainLayer.getBounds(), { padding: [30, 30] });

    // 6) Distàncies / durades
    const ecoDistKm   = (ecoRoute.distance  / 1000).toFixed(2);
    const fastDistKm  = (fastRoute.distance / 1000).toFixed(2);
    const mainDistKm  = (mainRoute.distance / 1000).toFixed(2);
    const mainDurMin  = Math.round(mainRoute.duration / 60);

    // 7) CO₂ i recomanació des del backend (si disponible)
    let co2Text = "—";
    let recText = mainIsEco
      ? "Ruta verda prioritzada"
      : "Ruta ràpida prioritzada";

    if (API_BASE === null) {
      API_BASE = await detectApiBase();
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
            mode:      mode // "eco" o "fast"
          })
        });

        if (resp.ok) {
          const data = await resp.json();
          co2Text = `${data.co2_estimated_g} g`;
          recText = data.recommendation;
        }
      } catch (e) {
        console.warn("No s'ha pogut contactar amb el backend per CO₂:", e);
      }
    }

    // 8) Text final
    resultBox.innerHTML = `
      <b>Distància eco:</b> ${ecoDistKm} km &nbsp;|&nbsp;
      <b>Distància ràpida:</b> ${fastDistKm} km<br>
      <b>Distància utilitzada:</b> ${mainDistKm} km &nbsp;·&nbsp;
      <b>Durada estimada:</b> ${mainDurMin} min<br>
      <b>CO₂ estimat:</b> ${co2Text}<br>
      <b>Recomanació:</b> ${recText}<br>
      <span class="muted">
        🌱 Ruta ECO (línia verda) i ⚡ Ruta RÀPIDA (línia blava) es calculen amb perfils diferents d'OpenRouteService,
        per això el camí és diferent en cada mode.
      </span>
    `;
  } catch (err) {
    console.error(err);
    resultBox.textContent = err.message || "Error en el càlcul de la ruta.";
  } finally {
    btn.disabled = false;
  }
}