// - Geocodificació amb Nominatim (traducció de noms a coordenades)
// - Càlcul de rutes reals amb OSRM (perfil ECO i RÀPID)
// - Dibuixa alhora la ruta ECO (verda) i la RÀPIDA (blava)
// - Crida al backend (FastAPI) per calcular CO₂ i recomanació
// - Inclou caché i canvi de mode instantani
// ======================================================


// -----------------------------
// 1) Configuració general
// -----------------------------

// Si el backend corre en local (FastAPI a 127.0.0.1:8000), deixem això així.
// Si el tens desplegat (Render, etc.), canvia aquesta URL per la teva.
const API_FIXED = "http://127.0.0.1:8000"; // ex: "https://greenroutes-backend.onrender.com"
let API_BASE = null;

// Servei OSRM públic per al càlcul de rutes reals
const OSRM = "https://router.project-osrm.org";


// -----------------------------
// 2) Estructures i eines bàsiques
// -----------------------------

// Petita utilitat per crear retards (si mai els volem fer servir)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Caché en memòria per no repetir peticions iguals
const geocodeCache = new Map(); // Nom → llista de resultats
const routeCache = new Map();   // Clau (origen/destí/mode) → ruta OSRM

// AbortController per cancel·lar peticions velles si l’usuari torna a clicar
let currentRouteAbort = null;
let currentGeoAbort = null;

// Estat global de l’aplicació (últim origen, destí i rutes)
let state = {
  origin: null, // {name, lat, lon}
  dest: null,   // {name, lat, lon}
  routes: null, // {eco, fast}
  picked: "eco" // mode actual seleccionat ('eco' o 'fast')
};


// -----------------------------
// 3) Detecció automàtica del backend
// -----------------------------

async function detectApiBase() {
  // Si hem fixat una URL de backend (local o Render), fem servir aquesta
  if (API_FIXED) {
    API_BASE = API_FIXED;
    return API_BASE;
  }

  // Si no hi ha backend fixat, provem ports locals
  if (API_BASE !== null) return API_BASE;

  const candidats = ["http://127.0.0.1:8000", "http://127.0.0.1:8001"];
  for (const base of candidats) {
    try {
      const r = await fetch(base + "/", { method: "GET" });
      if (r.ok) {
        API_BASE = base;
        return base;
      }
    } catch (_) {}
  }
  API_BASE = null;
  return null; // seguirem sense CO₂ però la ruta es pintarà igualment
}


// -----------------------------
// 4) Geocodificació amb Nominatim
// -----------------------------

let suggestTimer = null;

// Converteix un nom de lloc en una llista de possibles coordenades
async function geocode(query) {
  const key = query.trim().toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  // Si hi havia una geocodificació en curs, la cancel·lem
  if (currentGeoAbort) currentGeoAbort.abort();
  currentGeoAbort = new AbortController();

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");

  const resp = await fetch(url, {
    headers: { "Accept-Language": "ca" },
    signal: currentGeoAbort.signal
  });

  if (!resp.ok) throw new Error("Error en la geocodificació.");
  const data = await resp.json();

  const out = data.map((it) => ({
    name: it.display_name,
    lat: parseFloat(it.lat),
    lon: parseFloat(it.lon)
  }));

  geocodeCache.set(key, out);
  return out;
}

// Connecta un <input> amb un desplegable de suggeriments
function attachSuggest(inputEl, listEl) {
  inputEl.addEventListener("input", () => {
    clearTimeout(suggestTimer);
    const q = inputEl.value.trim();
    if (!q) {
      listEl.style.display = "none";
      listEl.innerHTML = "";
      return;
    }

    suggestTimer = setTimeout(async () => {
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
      } catch {
        listEl.style.display = "none";
        listEl.innerHTML = "";
      }
    }, 250);
  });

  listEl.addEventListener("click", (e) => {
    const el = e.target.closest(".sugg-item");
    if (!el) return;
    inputEl.value = el.textContent;
    inputEl.dataset.lat = el.dataset.lat;
    inputEl.dataset.lon = el.dataset.lon;
    listEl.style.display = "none";
  });

  // Tanca el llistat si fem clic fora
  document.addEventListener("click", (e) => {
    if (!listEl.contains(e.target) && e.target !== inputEl) {
      listEl.style.display = "none";
    }
  });
}

// Assegura que un input tingui lat/lon, geocodificant si cal
async function ensureCoords(inputEl) {
  const name = inputEl.value.trim();
  if (!name) throw new Error("Introdueix un nom de lloc a origen i destí.");
  let lat = parseFloat(inputEl.dataset.lat || "NaN");
  let lon = parseFloat(inputEl.dataset.lon || "NaN");
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    const [first] = await geocode(name);
    if (!first) throw new Error(`No s’ha trobat cap resultat per: ${name}`);
    lat = first.lat;
    lon = first.lon;
    inputEl.dataset.lat = String(lat);
    inputEl.dataset.lon = String(lon);
    // Mostrem un nom més complet per a l’usuari
    inputEl.value = first.name;
  }
  return { name, lat, lon };
}


// -----------------------------
// 5) Configuració del mapa (Leaflet)
// -----------------------------

const map = L.map("map", { preferCanvas: true }).setView([41.3851, 2.1734], 13);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap"
}).addTo(map);

let originMarker = null;
let destMarker = null;
let ecoLayer = null;  // Ruta ECO (verda)
let fastLayer = null; // Ruta RÀPIDA (blava)

// Elimina rutes dibuixades anteriorment
function clearLayers() {
  if (ecoLayer) {
    map.removeLayer(ecoLayer);
    ecoLayer = null;
  }
  if (fastLayer) {
    map.removeLayer(fastLayer);
    fastLayer = null;
  }
}

// Dibuixa una ruta (geoJSON) amb estil
function drawRoute(geo, color, weight = 5, dashed = false) {
  return L.geoJSON(geo, {
    style: {
      color,
      weight,
      opacity: 0.95,
      dashArray: dashed ? "6 6" : null
    }
  }).addTo(map);
}

// Ajusta el mapa perquè es vegin totes les rutes
function fitToRoutes() {
  const group = [];
  if (ecoLayer) group.push(ecoLayer);
  if (fastLayer) group.push(fastLayer);
  if (!group.length) return;
  const fg = L.featureGroup(group);
  map.fitBounds(fg.getBounds(), { padding: [40, 40] });
}


// -----------------------------
// 6) Càlcul de rutes amb OSRM
// -----------------------------

// Distància aproximada entre dos punts (Haversine)
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dlat = toRad(lat2 - lat1);
  const dlon = toRad(lon2 - lon1);
  const a =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dlon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Genera la URL d’OSRM segons mode (forcem perfils diferents)
// - ECO  → sempre 'cycling' (simulem bicicleta / ruta més verda)
// - FAST → sempre 'driving' (vehicle privat, ruta més ràpida)
function osrmUrl(mode, start, end) {
  const [slat, slon] = start;
  const [dlat, dlon] = end;

  if (mode === "eco") {
    // Ruta de bicicleta: acostuma a evitar autopistes i carreteres grans
    return `${OSRM}/route/v1/cycling/${slon},${slat};${dlon},${dlat}?overview=full&geometries=geojson`;
  }

  // Ruta de cotxe: pot usar autopistes i vies ràpides
  return `${OSRM}/route/v1/driving/${slon},${slat};${dlon},${dlat}?overview=full&geometries=geojson`;
}

// Consulta una ruta a OSRM amb caché i "fallbacks" bàsics
async function fetchOsrmRoute(mode, start, end, signal) {
  const key = `${start[0]},${start[1]}|${end[0]},${end[1]}|${mode}`;
  if (routeCache.has(key)) return routeCache.get(key);

  const url = osrmUrl(mode, start, end);
  let r = await fetch(url, { signal })
    .then((x) => x.json())
    .catch(() => ({ code: "Error" }));

  // Si falla en mode ECO, provem un parell d’alternatives
  if (mode === "eco" && (r.code !== "Ok" || !r.routes?.length)) {
    const url2 = `${OSRM}/route/v1/cycling/${start[1]},${start[0]};${end[1]},${end[0]}?overview=full&geometries=geojson`;
    r = await fetch(url2, { signal })
      .then((x) => x.json())
      .catch(() => ({ code: "Error" }));

    if (r.code !== "Ok" || !r.routes?.length) {
      const url3 = `${OSRM}/route/v1/driving/${start[1]},${start[0]};${end[1]},${end[0]}?overview=full&geometries=geojson`;
      r = await fetch(url3, { signal })
        .then((x) => x.json())
        .catch(() => ({ code: "Error" }));
    }
  }

  if (r.code !== "Ok" || !r.routes?.length) {
    throw new Error("No s’ha pogut obtenir la ruta real.");
  }

  const route = r.routes[0];
  const out = {
    geometry: route.geometry,
    distanceKm: +(route.distance / 1000).toFixed(2),
    durationMin: Math.round(route.duration / 60)
  };

  routeCache.set(key, out);
  return out;
}


// -----------------------------
// 7) Dibuix de rutes i panell d’informació
// -----------------------------

// Pinta les dues rutes (ECO i RÀPIDA) destacant la triada
function paintPickedOnly() {
  clearLayers();
  const picked = state.picked;
  const other = picked === "eco" ? "fast" : "eco";

  const mainGeo = state.routes[picked].geometry;
  const altGeo = state.routes[other].geometry;

  const mainCol = picked === "eco" ? "#16a34a" : "#2563eb"; // verd / blau
  const altCol = picked === "eco" ? "#2563eb" : "#16a34a";

  if (picked === "eco") {
    ecoLayer = drawRoute(mainGeo, mainCol, 6, false);
    fastLayer = drawRoute(altGeo, altCol, 3, true);
  } else {
    fastLayer = drawRoute(mainGeo, mainCol, 6, false);
    ecoLayer = drawRoute(altGeo, altCol, 3, true);
  }
  fitToRoutes();
}

// Actualitza el quadre de resultat (distància, CO₂, recomanació)
async function updateInfoPanel() {
  const picked = state.picked;
  const r = state.routes[picked];

  if (API_BASE === null) API_BASE = await detectApiBase();

  let co2Text = "—";
  let recText =
    picked === "eco"
      ? "Ruta verda prioritzada"
      : "Ruta ràpida prioritzada";

  // Cridem al backend només si el tenim disponible
  if (API_BASE) {
    try {
      const resp = await fetch(API_BASE + "/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_lat: state.origin.lat,
          start_lon: state.origin.lon,
          end_lat: state.dest.lat,
          end_lon: state.dest.lon,
          mode: picked
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        co2Text = `${data.co2_estimated_g} g`;
        recText = data.recommendation;
      }
    } catch (_) {
      // Si falla, simplement deixem els valors per defecte
    }
  }

  const extraText =
    picked === "eco"
      ? "🌱 Ruta ECO (verda) com a principal; RÀPIDA (blava) com a alternativa."
      : "⚡ Ruta RÀPIDA (blava) com a principal; ECO (verda) com a alternativa.";

  document.getElementById("result").innerHTML = `
    <b>Distància (ruta real):</b> ${r.distanceKm} km &nbsp;·&nbsp;
    <b>Durada estimada:</b> ${r.durationMin} min<br>
    <b>CO₂ estimat:</b> ${co2Text}<br>
    <b>Recomanació:</b> ${recText}<br>
    <span class="muted">${extraText}</span>
  `;
}


// -----------------------------
// 8) Lògica principal i esdeveniments d’usuari
// -----------------------------

const originInput = document.getElementById("origin_name");
const destInput = document.getElementById("dest_name");
const modeSelect = document.getElementById("route_mode");
const btnCalc = document.getElementById("calc_btn");
const resultEl = document.getElementById("result");
const suggOrigin = document.getElementById("sugg_origin");
const suggDest = document.getElementById("sugg_dest");

attachSuggest(originInput, suggOrigin);
attachSuggest(destInput, suggDest);

// Premer ENTER en els inputs també calcula ruta
originInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") calculateRoute(true);
});
destInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") calculateRoute(true);
});

// Canviar el selector (ECO / RÀPIDA) sense recalcular rutes
modeSelect.addEventListener("change", () => {
  if (state.routes) {
    state.picked = modeSelect.value;
    paintPickedOnly();
    updateInfoPanel();
  }
});

// Funció principal de càlcul de rutes
async function calculateRoute(forceNew = false) {
  // Si ja tenim rutes i només canviem mode, no recalculis
  if (!forceNew && state.routes && state.origin && state.dest) {
    state.picked = modeSelect.value;
    paintPickedOnly();
    updateInfoPanel();
    return;
  }

  btnCalc.disabled = true;
  const oldText = btnCalc.textContent;
  btnCalc.textContent = "Calculant...";
  resultEl.textContent = "Calculant rutes (ECO + RÀPIDA)...";

  try {
    // 1) Coordenades d’origen i destí
    const o = await ensureCoords(originInput);
    const d = await ensureCoords(destInput);

    state.origin = o;
    state.dest = d;
    state.picked = modeSelect.value;

    // 2) Marcadors al mapa
    if (originMarker) map.removeLayer(originMarker);
    if (destMarker) map.removeLayer(destMarker);
    originMarker = L.marker([o.lat, o.lon]).addTo(map).bindPopup("Origen").openPopup();
    destMarker = L.marker([d.lat, d.lon]).addTo(map).bindPopup("Destí");

    // 3) Cancel·lem possible càlcul anterior i creem un de nou
    if (currentRouteAbort) currentRouteAbort.abort();
    currentRouteAbort = new AbortController();

    // 4) Demanem les dues rutes en paral·lel: ECO i RÀPIDA
    const [eco, fast] = await Promise.all([
      fetchOsrmRoute("eco", [o.lat, o.lon], [d.lat, d.lon], currentRouteAbort.signal),
      fetchOsrmRoute("fast", [o.lat, o.lon], [d.lat, d.lon], currentRouteAbort.signal)
    ]);

    state.routes = { eco, fast };

    // 5) Pintem la ruta seleccionada i actualitzem informació
    paintPickedOnly();
    await updateInfoPanel();
  } catch (e) {
    console.error(e);
    resultEl.textContent = e.message || "Error en el càlcul de la ruta.";
  } finally {
    btnCalc.disabled = false;
    btnCalc.textContent = oldText;
  }
}

// Botó principal "Calcular ruta"
btnCalc.addEventListener("click", () => calculateRoute(true));