// ======================================================
// GreenRoutes - app.js (VERSIÓ COMPLETA, amb ECO via OpenRouteService)
// - Autocompletat amb Nominatim (OSM)
// - RÀPIDA: OSRM "driving"
// - ECO: OpenRouteService "cycling-regular" (realista); fallback a "foot-walking"
// - Dibuixa alhora ECO (verd) i RÀPIDA (blau) + llegenda
// - Envia la distància real al backend per calcular CO₂
// * Recorda posar la teva API key d’OpenRouteService a ORS_API_KEY
// ======================================================


// =============================
// 0) Config ORS (posa la teva clau)
// =============================
const ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjkyMjZiNTllZDIzMzQzM2Q5NzM1NDUzNDg0YTc3OWUzIiwiaCI6Im11cm11cjY0In0="; // https://openrouteservice.org/dev/#/signup


// -----------------------------
// 1) Helpers de backend
// -----------------------------

// Detecta quin port del backend està actiu (8000 o 8001)
let API_BASE = null;
async function detectApiBase() {
  const candidates = ['http://127.0.0.1:8000', 'http://127.0.0.1:8001'];
  for (const base of candidates) {
    try {
      const r = await fetch(base + '/');
      if (r.ok) return base;
    } catch (_) {}
  }
  return null; // si no hi ha backend, seguim sense CO₂
}


// -----------------------------
// 2) Geocodificació i suggeriments
// -----------------------------

// Converteix un nom de lloc a coordenades amb Nominatim (OpenStreetMap)
async function geocode(query) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');

  const resp = await fetch(url.toString(), { headers: { 'Accept-Language': 'ca' } });
  if (!resp.ok) throw new Error('Error geocodificant');
  const data = await resp.json();

  return data.map(it => ({
    name: it.display_name,
    lat: parseFloat(it.lat),
    lon: parseFloat(it.lon),
  }));
}

// Afegeix un desplegable de suggeriments a un <input>
function attachSuggest(inputEl, listEl) {
  let timer = null;

  inputEl.addEventListener('input', () => {
    clearTimeout(timer);
    const q = inputEl.value.trim();
    if (!q) { listEl.style.display = 'none'; listEl.innerHTML = ''; return; }

    timer = setTimeout(async () => {
      try {
        const res = await geocode(q);
        if (!res.length) { listEl.style.display = 'none'; listEl.innerHTML = ''; return; }
        listEl.innerHTML = res.map(r =>
          `<div class="sugg-item" data-lat="${r.lat}" data-lon="${r.lon}">${r.name}</div>`
        ).join('');
        listEl.style.display = 'block';
      } catch {
        listEl.style.display = 'none';
        listEl.innerHTML = '';
      }
    }, 300);
  });

  listEl.addEventListener('click', e => {
    const el = e.target.closest('.sugg-item');
    if (!el) return;
    inputEl.value = el.textContent;
    inputEl.dataset.lat = el.dataset.lat;
    inputEl.dataset.lon = el.dataset.lon;
    listEl.style.display = 'none';
  });

  // Tanca el llistat si es clica fora
  document.addEventListener('click', (e) => {
    if (!listEl.contains(e.target) && e.target !== inputEl) listEl.style.display = 'none';
  });
}


// -----------------------------
// 3) Inicialització del mapa Leaflet
// -----------------------------

const map = L.map('map').setView([41.3851, 2.1734], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap'
}).addTo(map);

let originMarker = null;
let destMarker   = null;
let routeLayer   = null;       // capa principal (segons mode seleccionat)
window._altLayer = null;       // capa alternativa (l’altre mode)

// Llegenda simple al mapa
const legend = L.control({ position: 'bottomright' });
legend.onAdd = function () {
  const div = L.DomUtil.create('div', 'legend');
  div.style.background = 'white';
  div.style.padding = '6px 10px';
  div.style.borderRadius = '6px';
  div.style.boxShadow = '0 1px 4px rgba(0,0,0,0.2)';
  div.innerHTML = `
    <div style="font-weight:600;margin-bottom:4px;">Llegenda</div>
    <div><span style="display:inline-block;width:14px;height:4px;background:#16a34a;margin-right:6px;"></span>Eco (ORS bicicleta/peató)</div>
    <div><span style="display:inline-block;width:14px;height:4px;background:#2563eb;margin-right:6px;"></span>Ràpida (OSRM conducció)</div>
  `;
  return div;
};
legend.addTo(map);


// -----------------------------
// 4) Rutes (OSRM per ràpida, ORS per eco)
// -----------------------------

// Helper per saber si dues rutes són molt semblants per distància (2% tolerància)
function nearlySameDistanceMeters(aMeters, bMeters, tol = 0.02) {
  if (!aMeters || !bMeters) return false;
  return Math.abs(aMeters - bMeters) / Math.max(aMeters, bMeters) < tol;
}

// --- OSRM: driving (ràpid) ---
async function fetchOsrmFastRoute(start, end) {
  const [slat, slon] = start;
  const [elat, elon] = end;
  const url = `https://router.project-osrm.org/route/v1/driving/${slon},${slat};${elon},${elat}?overview=full&geometries=geojson`;
  const r = await fetch(url).then(x => x.json());
  if (r.code !== 'Ok' || !r.routes?.length) throw new Error("OSRM driving sense ruta");
  const route = r.routes[0];
  return {
    distance: route.distance, // metres
    geometry: route.geometry, // GeoJSON LineString
    source: 'osrm-driving'
  };
}

// --- ORS: cycling (eco) + fallback walking ---
async function fetchOrsEcoRoute(start, end) {
  if (!ORS_API_KEY || ORS_API_KEY.startsWith("PON_")) {
    throw new Error("Falta ORS_API_KEY: registra't gratis a openrouteservice.org i posa la teva clau a ORS_API_KEY.");
  }

  const [slat, slon] = start;
  const [elat, elon] = end;

  // 1) Cicling "regular"
  let url = `https://api.openrouteservice.org/v2/directions/cycling-regular?api_key=${encodeURIComponent(ORS_API_KEY)}&start=${slon},${slat}&end=${elon},${elat}`;
  let r = await fetch(url).then(x => {
    if (!x.ok) throw new Error("ORS cycling error");
    return x.json();
  }).catch(() => null);

  // Si falla o no retorna features, fem walking
  if (!r || !r.features?.length) {
    url = `https://api.openrouteservice.org/v2/directions/foot-walking?api_key=${encodeURIComponent(ORS_API_KEY)}&start=${slon},${slat}&end=${elon},${elat}`;
    const rw = await fetch(url).then(x => {
      if (!x.ok) throw new Error("ORS walking error");
      return x.json();
    });
    const f = rw.features[0];
    return {
      distance: f.properties.summary.distance, // metres
      geometry: f.geometry,
      source: 'ors-walking'
    };
  }

  // OK amb cycling
  const f = r.features[0];
  return {
    distance: f.properties.summary.distance, // metres
    geometry: f.geometry,                    // GeoJSON LineString
    source: 'ors-cycling'
  };
}


// -----------------------------
// 5) Flux principal (inputs + càlcul + dibuix)
// -----------------------------

const originInput = document.getElementById('origin_name');
const destInput   = document.getElementById('dest_name');
const modeSelect  = document.getElementById('route_mode');

attachSuggest(originInput, document.getElementById('sugg_origin'));
attachSuggest(destInput,   document.getElementById('sugg_dest'));

document.getElementById('calc_btn').addEventListener('click', calculateRoute);
originInput.addEventListener('keydown', e => { if (e.key === 'Enter') calculateRoute(); });
destInput  .addEventListener('keydown', e => { if (e.key === 'Enter') calculateRoute(); });

// Obté coords (si l’usuari no ha clicat suggeriment, agafem el 1r resultat)
async function ensureCoords(inputEl) {
  const name = inputEl.value.trim();
  if (!name) throw new Error('Introdueix un nom de lloc a origen i destí.');
  let lat = parseFloat(inputEl.dataset.lat || 'NaN');
  let lon = parseFloat(inputEl.dataset.lon || 'NaN');
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    const [first] = await geocode(name);
    if (!first) throw new Error(`No s'ha trobat cap resultat per: ${name}`);
    lat = first.lat; lon = first.lon;
    inputEl.dataset.lat = String(lat);
    inputEl.dataset.lon = String(lon);
    inputEl.value = first.name; // nom complet "bonic"
  }
  return { name, lat, lon };
}

async function calculateRoute() {
  const btn    = document.getElementById('calc_btn');
  const result = document.getElementById('result');

  btn.disabled = true;
  result.textContent = 'Calculant...';

  try {
    // 1) Coordenades d’origen/destí
    const o = await ensureCoords(originInput);
    const d = await ensureCoords(destInput);
    const picked = modeSelect.value; // 'eco' | 'fast'

    // 2) Marcadors al mapa
    if (originMarker) map.removeLayer(originMarker);
    if (destMarker)   map.removeLayer(destMarker);
    originMarker = L.marker([o.lat, o.lon]).addTo(map).bindPopup('Origen').openPopup();
    destMarker   = L.marker([d.lat, d.lon]).addTo(map).bindPopup('Destí');

    // 3) Obtenir rutes: ECO (ORS) i RÀPIDA (OSRM)
    let [eco, fast] = await Promise.allSettled([
      fetchOrsEcoRoute([o.lat, o.lon], [d.lat, d.lon]),
      fetchOsrmFastRoute([o.lat, o.lon], [d.lat, d.lon]),
    ]);

    if (eco.status !== 'fulfilled') throw eco.reason || new Error('Error ruta ECO');
    if (fast.status !== 'fulfilled') throw fast.reason || new Error('Error ruta RÀPIDA');

    const ecoRoute  = eco.value;
    const fastRoute = fast.value;

    // 4) Si per casualitat les distàncies són quasi iguals, ORS walking com a reforç (ja es fa a fetchOrsEcoRoute)
    // => ja tenim ecoRoute amb 'ors-walking' si cycling ha fallat; aquí opcionalment podríem re-intentar.

    // 5) Neteja capes i dibuixa les dues rutes
    if (routeLayer)       map.removeLayer(routeLayer);
    if (window._altLayer) map.removeLayer(window._altLayer);

    const mainGeo = (picked === 'eco') ? ecoRoute.geometry : fastRoute.geometry;
    const altGeo  = (picked === 'eco') ? fastRoute.geometry : ecoRoute.geometry;
    const mainCol = (picked === 'eco') ? '#16a34a' : '#2563eb'; // verd / blau
    const altCol  = (picked === 'eco') ? '#2563eb' : '#16a34a';

    routeLayer       = L.geoJSON(mainGeo, { style: { color: mainCol, weight: 6, opacity: 0.95 } }).addTo(map);
    window._altLayer = L.geoJSON(altGeo,  { style: { color: altCol,  weight: 3, opacity: 0.6, dashArray: '6 6' } }).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });

    // 6) Distàncies reals (km) i la utilitzada (per al backend)
    const ecoKm  = (ecoRoute.distance  / 1000).toFixed(2);
    const fastKm = (fastRoute.distance / 1000).toFixed(2);
    const usedKmStr = (picked === 'eco') ? ecoKm : fastKm;

    // 7) CO₂ via backend (si està en marxa)
    if (API_BASE === null) API_BASE = await detectApiBase();

    let co2Text = '—';
    let recText = (picked === 'eco')
      ? 'Ruta verda (ORS) prioritzada'
      : 'Ruta blava (OSRM) prioritzada';
    let srcText = (picked === 'eco') ? ecoRoute.source : fastRoute.source;

    if (API_BASE) {
      const resp = await fetch(API_BASE + '/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_lat: o.lat, start_lon: o.lon,
          end_lat:   d.lat, end_lon:   d.lon,
          mode: picked,
          distance_km: parseFloat(usedKmStr) // DISTÀNCIA REAL enviada al backend
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        co2Text = `${data.co2_estimated_g} g`;
        recText = data.recommendation;
        srcText = `${srcText} / distància: ${data.distance_source}`;
      }
    }

    // 8) Panell de resultats
    const extraText = (picked === 'eco')
      ? '🌱 Ruta ECO (línia verda) mostrada com a principal. Ruta ràpida (blava) també visible.'
      : '⚡ Ruta RÀPIDA (línia blava) mostrada com a principal. Ruta eco (verda) també visible.';

    document.getElementById('result').innerHTML = `
      <b>Distància eco (ORS):</b> ${ecoKm} km &nbsp;|&nbsp; <b>Distància ràpida (OSRM):</b> ${fastKm} km<br>
      <b>Distància utilitzada:</b> ${usedKmStr} km<br>
      <b>CO₂ estimat:</b> ${co2Text}<br>
      <b>Recomanació:</b> ${recText}<br>
      <span class="muted">Fonts rutes: ${ecoRoute.source} (eco) i ${fastRoute.source} (ràpida). ${srcText ? '('+srcText+')' : ''}</span><br>
      <span class="muted">${extraText}</span>
    `;

  } catch (e) {
    console.error(e);
    result.textContent = e.message || 'Error en el càlcul de la ruta.';
  } finally {
    btn.disabled = false;
  }
}