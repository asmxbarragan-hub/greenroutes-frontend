// GreenRoutes - app.js (versió estable, sense OpenRouteService)
// - Geocodificació (Nominatim)
// - Dues rutes reals amb OSRM: ECO (verd) i RÀPIDA (blau)
// - Crida al backend per CO₂ i recomanació
// ======================================================


// -----------------------------
// 1) Helpers de backend (CO₂)
// -----------------------------

// Detecta si el backend està en local (8000/8001) o a producció (Render, etc.)
let API_BASE = null;

async function detectApiBase() {
  // 1) Provar ports locals
  const locals = [
    "http://127.0.0.1:8000",
    "http://127.0.0.1:8001",
  ];

  for (const base of locals) {
    try {
      const r = await fetch(base + "/");
      if (r.ok) return base;
    } catch (_) {}
  }

  // 2) Si no hi ha local, pots posar aquí la URL del backend a Render (si en tens)
  //    Exemple:
  //    const renderBase = "https://greenroutes-backend.onrender.com";
  //    try {
  //      const r = await fetch(renderBase + "/");
  //      if (r.ok) return renderBase;
  //    } catch (_) {}

  // 3) Si no es troba cap backend, retornem null
  return null;
}


// -----------------------------
// 2) Geocodificació (Nominatim)
// -----------------------------

// Converteix un nom de lloc a coordenades amb Nominatim (OpenStreetMap)
async function geocode(query) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");

  const resp = await fetch(url.toString(), {
    headers: { "Accept-Language": "ca" },
  });

  if (!resp.ok) throw new Error("Error geocodificant l'adreça.");

  const data = await resp.json();

  return data.map((it) => ({
    name: it.display_name,
    lat: parseFloat(it.lat),
    lon: parseFloat(it.lon),
  }));
}

// Afegeix suggeriments a un <input> (desplegable de Nominatim)
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
      } catch {
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

  // Tancar el desplegable si es clica fora
  document.addEventListener("click", (e) => {
    if (!listEl.contains(e.target) && e.target !== inputEl) {
      listEl.style.display = "none";
    }
  });
}

// Assegura que tenim coordenades per a un input (si no, geocodifica)
async function ensureCoords(inputEl) {
  const name = inputEl.value.trim();
  if (!name) throw new Error("Introdueix una adreça a origen i destí.");

  let lat = parseFloat(inputEl.dataset.lat || "NaN");
  let lon = parseFloat(inputEl.dataset.lon || "NaN");

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    const [first] = await geocode(name);
    if (!first) throw new Error(`No s'ha trobat cap resultat per: ${name}`);
    lat = first.lat;
    lon = first.lon;
    inputEl.dataset.lat = String(lat);
    inputEl.dataset.lon = String(lon);
    inputEl.value = first.name; // mostrem el nom complet bonic
  }

  return { name, lat, lon };
}


// -----------------------------
// 3) Mapa Leaflet
// -----------------------------

const map = L.map("map").setView([41.3851, 2.1734], 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap",
}).addTo(map);

let originMarker = null;
let destMarker = null;
let ecoLayer = null;
let fastLayer = null;


// -----------------------------
// 4) Rutes OSRM
// -----------------------------

// Distància aproximada amb Haversine (per decidir estratègia ECO)
function approxKm(start, end) {
  const [lat1, lon1] = start;
  const [lat2, lon2] = end;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;

  const dlat = toRad(lat2 - lat1);
  const dlon = toRad(lon2 - lon1);

  const a =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dlon / 2) ** 2;

  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// Construeix la URL d'OSRM segons mode (eco / fast)
function osrmUrl(mode, start, end) {
  const distKm = approxKm(start, end);

  if (mode === "eco") {
    // Per rutes curtes, millor ciclisme; per llargues, evitar autopistes i peatges
    if (distKm <= 20) {
      return `https://router.project-osrm.org/route/v1/cycling/${start[1]},${start[0]};${end[1]},${end[0]}?overview=full&geometries=geojson`;
    } else {
      return `https://router.project-osrm.org/route/v1/driving/${start[1]},${start[0]};${end[1]},${end[0]}?overview=full&geometries=geojson&exclude=motorway,toll`;
    }
  }

  // Mode ràpid: driving amb autopistes
  return `https://router.project-osrm.org/route/v1/driving/${start[1]},${start[0]};${end[1]},${end[0]}?overview=full&geometries=geojson`;
}

// Demana una ruta a OSRM i retorna l'objecte ruta
async function fetchOsrmRoute(mode, start, end) {
  const url = osrmUrl(mode, start, end);
  const resp = await fetch(url).catch(() => null);

  if (!resp || !resp.ok) {
    throw new Error("Error obtenint ruta d'OSRM");
  }

  const data = await resp.json();

  if (data.code !== "Ok" || !data.routes || !data.routes.length) {
    throw new Error("OSRM no ha retornat cap ruta");
  }

  return data.routes[0];
}


// -----------------------------
// 5) Flux principal
// -----------------------------

const originInput = document.getElementById("origin_name");
const destInput = document.getElementById("dest_name");
const modeSelect = document.getElementById("route_mode");
const resultBox = document.getElementById("result");

attachSuggest(originInput, document.getElementById("sugg_origin"));
attachSuggest(destInput, document.getElementById("sugg_dest"));

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
  resultBox.textContent = "Calculant ruta...";

  try {
    // 1) Coordenades
    const o = await ensureCoords(originInput);
    const d = await ensureCoords(destInput);
    const picked = modeSelect.value; // 'eco' o 'fast'

    const start = [o.lat, o.lon];
    const end = [d.lat, d.lon];

    // 2) Marcadors
    if (originMarker) map.removeLayer(originMarker);
    if (destMarker) map.removeLayer(destMarker);

    originMarker = L.marker(start).addTo(map).bindPopup("Origen").openPopup();
    destMarker = L.marker(end).addTo(map).bindPopup("Destí");

    // 3) Demanar rutes ECO i FAST en paral·lel
    const [ecoRoute, fastRoute] = await Promise.all([
      fetchOsrmRoute("eco", start, end),
      fetchOsrmRoute("fast", start, end),
    ]);

    // 4) Neteja capes anteriors
    if (ecoLayer) map.removeLayer(ecoLayer);
    if (fastLayer) map.removeLayer(fastLayer);

    // 5) Dibuixar rutes
    ecoLayer = L.geoJSON(ecoRoute.geometry, {
      style: { color: "#16a34a", weight: picked === "eco" ? 6 : 3, opacity: picked === "eco" ? 0.95 : 0.6, dashArray: picked === "eco" ? null : "6 6" },
    }).addTo(map);

    fastLayer = L.geoJSON(fastRoute.geometry, {
      style: { color: "#2563eb", weight: picked === "fast" ? 6 : 3, opacity: picked === "fast" ? 0.95 : 0.6, dashArray: picked === "fast" ? null : "6 6" },
    }).addTo(map);

    map.fitBounds(ecoLayer.getBounds().extend(fastLayer.getBounds()), {
      padding: [40, 40],
    });

    // 6) Distàncies
    const ecoKm = (ecoRoute.distance / 1000).toFixed(2);
    const fastKm = (fastRoute.distance / 1000).toFixed(2);
    const usedKm = picked === "eco" ? ecoKm : fastKm;

    // 7) CO₂ des del backend
    if (API_BASE === null) API_BASE = await detectApiBase();

    let co2Text = "—";
    let recText =
      picked === "eco"
        ? "Ruta verda prioritzada"
        : "Ruta ràpida prioritzada";

    if (API_BASE) {
      try {
        const r = await fetch(API_BASE + "/route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            start_lat: o.lat,
            start_lon: o.lon,
            end_lat: d.lat,
            end_lon: d.lon,
            mode: picked,
          }),
        });

        if (r.ok) {
          const data = await r.json();
          if (data.co2_estimated_g != null) {
            co2Text = `${data.co2_estimated_g} g`;
          }
          if (data.recommendation) {
            recText = data.recommendation;
          }
        }
      } catch (err) {
        console.warn("Error cridant backend:", err);
      }
    }

    // 8) Text informatiu
    const extraText =
      picked === "eco"
        ? "🌱 Ruta ECO (línia verda) mostrada com a principal; RÀPIDA (blava) visible com a alternativa."
        : "⚡ Ruta RÀPIDA (línia blava) mostrada com a principal; ECO (verda) visible com a alternativa.";

    resultBox.innerHTML = `
      <b>Distància eco:</b> ${ecoKm} km &nbsp; | &nbsp;
      <b>Distància ràpida:</b> ${fastKm} km<br>
      <b>Distància utilitzada:</b> ${usedKm} km<br>
      <b>CO₂ estimat:</b> ${co2Text}<br>
      <b>Recomanació:</b> ${recText}<br>
      <span class="muted">${extraText}</span><br>
      <span class="muted">🟢 ECO = línia verda &nbsp;&nbsp; 🔵 RÀPIDA = línia blava</span>
    `;
  } catch (err) {
    console.error(err);
    resultBox.textContent = err.message || "Error calculant la ruta real.";
  } finally {
    btn.disabled = false;
  }
}