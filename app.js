// - Funciona en LOCAL i en NETLIFY + RENDER
// - Fa servir OpenRouteService per calcular rutes reals
//   * ECO  = perfil cycling, evita autopistes
//   * RÀPIDA = perfil driving-car, més ràpida
// - Crida el backend per estimar el CO₂
// ======================================================


// -----------------------------------------
// 0) Configuració de backend segons entorn
// -----------------------------------------

// ✔ Backend local (quan treballes al teu PC)
const BACKEND_LOCAL  = "http://127.0.0.1:8000";

// ✔ Backend desplegat a Render (CANVIA A LA TEVA URL REAL)
const BACKEND_RENDER = "https://greenroutes-backend.onrender.com/";

// Detectem on estem (localhost o Netlify)
let API_BASE;
if (window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "localhost") {
  // Estem desenvolupant en local
  API_BASE = BACKEND_LOCAL;
} else {
  // Estem en producció (Netlify, etc.)
  API_BASE = BACKEND_RENDER;
}


// -----------------------------------------
// 1) Configuració OpenRouteService (ORS)
// -----------------------------------------

// ❗ POSA AQUÍ LA TEVA CLAU ORS (la mateixa que has provat abans)
const ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjkyMjZiNTllZDIzMzQzM2Q5NzM1NDUzNDg0YTc3OWUzIiwiaCI6Im11cm11cjY0In0="; 

// Funció genèrica per demanar una ruta a ORS
async function fetchOrsRoute(profile, start, end, optionsExtra = {}) {
  // start/end = [lat, lon]
  const url = "https://api.openrouteservice.org/v2/directions/" + profile + "/geojson";

  // Cos bàsic de la petició: coordenades en [lon, lat]
  const body = {
    coordinates: [
      [start[1], start[0]],
      [end[1],   end[0]]
    ],
    ...optionsExtra
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": ORS_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    console.error("Error ORS:", await resp.text());
    throw new Error("Error obtenint ruta d'OpenRouteService");
  }

  const data = await resp.json();

  if (!data.features || !data.features.length) {
    throw new Error("No s'ha trobat cap ruta a ORS");
  }

  const feature = data.features[0];
  const distance_m = feature.properties?.summary?.distance ?? 0;
  const duration_s = feature.properties?.summary?.duration ?? 0;
  const geometry   = feature.geometry;

  return {
    distance_m,
    duration_s,
    geometry
  };
}

// Ruta ECO: ciclisme, recorreig més curt i evita autopistes/peatges
async function fetchEcoRoute(start, end) {
  return fetchOrsRoute("cycling-regular", start, end, {
    preference: "shortest",
    options: {
      avoid_features: ["highways", "tollways"]
    }
  });
}

// Ruta RÀPIDA: cotxe, recorreig més ràpid
async function fetchFastRoute(start, end) {
  return fetchOrsRoute("driving-car", start, end, {
    preference: "fastest"
  });
}


// -----------------------------------------
// 2) Geocodificació (Nominatim) i suggeriments
// -----------------------------------------

// Converteix un text (nom de lloc) en coordenades
async function geocode(query) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");

  const resp = await fetch(url.toString(), {
    headers: {
      "Accept-Language": "ca"  // resultats en català quan sigui possible
    }
  });

  if (!resp.ok) throw new Error("Error geocodificant");
  const data = await resp.json();

  return data.map(it => ({
    name: it.display_name,
    lat: parseFloat(it.lat),
    lon: parseFloat(it.lon)
  }));
}

// Afegeix suggeriments a un input de text (origen/destí)
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

        listEl.innerHTML = res.map(r =>
          `<div class="sugg-item" data-lat="${r.lat}" data-lon="${r.lon}">${r.name}</div>`
        ).join("");

        listEl.style.display = "block";
      } catch (e) {
        console.error(e);
        listEl.style.display = "none";
        listEl.innerHTML = "";
      }
    }, 300);
  });

  listEl.addEventListener("click", e => {
    const el = e.target.closest(".sugg-item");
    if (!el) return;

    inputEl.value = el.textContent;
    inputEl.dataset.lat = el.dataset.lat;
    inputEl.dataset.lon = el.dataset.lon;

    listEl.style.display = "none";
  });

  document.addEventListener("click", e => {
    if (!listEl.contains(e.target) && e.target !== inputEl) {
      listEl.style.display = "none";
    }
  });
}


// -----------------------------------------
// 3) Inicialització del mapa Leaflet
// -----------------------------------------

const map = L.map("map").setView([41.3851, 2.1734], 13);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap"
}).addTo(map);

let originMarker = null;
let destMarker   = null;
let ecoLayer     = null;
let fastLayer    = null;


// -----------------------------------------
// 4) Inputs i flux principal
// -----------------------------------------

const originInput = document.getElementById("origin_name");
const destInput   = document.getElementById("dest_name");
const modeSelect  = document.getElementById("route_mode");
const resultBox   = document.getElementById("result");

attachSuggest(originInput, document.getElementById("sugg_origin"));
attachSuggest(destInput,   document.getElementById("sugg_dest"));

document.getElementById("calc_btn").addEventListener("click", calculateRoute);
originInput.addEventListener("keydown", e => { if (e.key === "Enter") calculateRoute(); });
destInput  .addEventListener("keydown", e => { if (e.key === "Enter") calculateRoute(); });

// Assegura que tenim coordenades (si no, les busca amb Nominatim)
async function ensureCoords(inputEl) {
  const raw = inputEl.value.trim();
  if (!raw) throw new Error("Introdueix un nom de lloc a origen i destí.");

  let lat = parseFloat(inputEl.dataset.lat || "NaN");
  let lon = parseFloat(inputEl.dataset.lon || "NaN");

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    const list = await geocode(raw);
    const first = list[0];
    if (!first) throw new Error(`No s'ha trobat cap resultat per: ${raw}`);

    lat = first.lat;
    lon = first.lon;

    inputEl.dataset.lat = String(lat);
    inputEl.dataset.lon = String(lon);
    inputEl.value = first.name;  // mostrem nom complet
  }

  return { lat, lon };
}

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

    // 2) Actualitzar marcadors
    if (originMarker) map.removeLayer(originMarker);
    if (destMarker)   map.removeLayer(destMarker);

    originMarker = L.marker(start).addTo(map).bindPopup("Origen");
    destMarker   = L.marker(end).addTo(map).bindPopup("Destí");

    // 3) Demanar rutes ECO i RÀPIDA en paral·lel
    const [ecoRoute, fastRoute] = await Promise.all([
      fetchEcoRoute(start, end),
      fetchFastRoute(start, end)
    ]);

    // 4) Esborrar capes antigues
    if (ecoLayer)  map.removeLayer(ecoLayer);
    if (fastLayer) map.removeLayer(fastLayer);

    // 5) Dibuixar ruta ECO (verd) i RÀPIDA (blau)
    ecoLayer = L.geoJSON(ecoRoute.geometry, {
      style: { color: "#16a34a", weight: 5, opacity: 0.9 }  // verd
    }).addTo(map);

    fastLayer = L.geoJSON(fastRoute.geometry, {
      style: { color: "#2563eb", weight: 4, opacity: 0.8, dashArray: "6 6" }  // blau discontinu
    }).addTo(map);

    // Focalitzem el mapa sobre totes dues rutes
    const group = L.featureGroup([ecoLayer, fastLayer]);
    map.fitBounds(group.getBounds(), { padding: [40, 40] });

    // 6) Distàncies en km
    const ecoKm   = (ecoRoute.distance_m   / 1000).toFixed(2);
    const fastKm  = (fastRoute.distance_m  / 1000).toFixed(2);

    // 7) Crida al backend per estimar CO₂ segons mode triat (eco o fast)
    let co2Text = "—";
    let recText = "";

    try {
      const resp = await fetch(API_BASE + "/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_lat: o.lat,
          start_lon: o.lon,
          end_lat:   d.lat,
          end_lon:   d.lon,
          mode:      mode   // li passem el mode perquè al futur es pugui ajustar
        })
      });

      if (resp.ok) {
        const data = await resp.json();
        co2Text = `${data.co2_estimated_g} g`;
        recText = data.recommendation;
      } else {
        console.warn("Error resposta backend:", resp.status);
      }
    } catch (e) {
      console.warn("No s'ha pogut contactar amb el backend per al CO₂", e);
    }

    // 8) Text explicatiu (mostrem comparació ECO vs RÀPIDA)
    const infoMode = mode === "eco"
      ? "Has prioritzat la ruta ECO (línia verda)."
      : "Has prioritzat la ruta RÀPIDA (línia blava).";

    resultBox.innerHTML = `
      <b>Distància ECO (verd):</b> ${ecoKm} km<br>
      <b>Distància RÀPIDA (blau):</b> ${fastKm} km<br>
      <b>CO₂ estimat (segons mode seleccionat):</b> ${co2Text}<br>
      <b>Recomanació backend:</b> ${recText || "(sense dades específiques)"}<br>
      <span class="muted">${infoMode}</span>
    `;

  } catch (e) {
    console.error(e);
    resultBox.textContent = e.message || "Error en el càlcul de la ruta.";
  } finally {
    btn.disabled = false;
  }
}