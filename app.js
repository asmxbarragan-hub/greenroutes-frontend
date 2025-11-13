// - Geocodificació amb Nominatim (OpenStreetMap)
// - Càlcul de rutes reals amb OSRM (ECO i RÀPIDA)
// - Dibuixa les dues rutes al mapa (verd/blau)
// - Crida al backend FastAPI per estimar CO₂ i donar
//   una recomanació textual.
// ======================================================


// ------------------------------------------------------
// 1) Detecció del backend (8000 o 8001)
// ------------------------------------------------------

let API_BASE = null;

// Intenta detectar si el backend està en marxa a 127.0.0.1:8000 o :8001
async function detectApiBase() {
  const candidates = ['http://127.0.0.1:8000', 'http://127.0.0.1:8001'];
  for (const base of candidates) {
    try {
      const r = await fetch(base + '/');
      if (r.ok) {
        console.log('[INFO] Backend detectat a', base);
        return base;
      }
    } catch (err) {
      // Si peta, provem el següent
    }
  }
  console.warn('[WARN] Cap backend detectat. Es mostrarà la ruta però sense CO₂.');
  return null;
}


// ------------------------------------------------------
// 2) Geocodificació (Nominatim) i suggeriments
// ------------------------------------------------------

// Converteix un nom de lloc a coordenades (lat, lon)
async function geocode(query) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');

  const resp = await fetch(url.toString(), { headers: { 'Accept-Language': 'ca' } });
  if (!resp.ok) throw new Error('Error geocodificant la ubicació');
  const data = await resp.json();

  return data.map(it => ({
    name: it.display_name,
    lat: parseFloat(it.lat),
    lon: parseFloat(it.lon)
  }));
}

// Afegeix autocompletar / suggeriments a un <input>
function attachSuggest(inputEl, listEl) {
  let timer = null;

  inputEl.addEventListener('input', () => {
    clearTimeout(timer);
    const q = inputEl.value.trim();
    if (!q) {
      listEl.style.display = 'none';
      listEl.innerHTML = '';
      return;
    }

    timer = setTimeout(async () => {
      try {
        const res = await geocode(q);
        if (!res.length) {
          listEl.style.display = 'none';
          listEl.innerHTML = '';
          return;
        }
        listEl.innerHTML = res.map(r =>
          `<div class="sugg-item" data-lat="${r.lat}" data-lon="${r.lon}">${r.name}</div>`
        ).join('');
        listEl.style.display = 'block';
      } catch (err) {
        console.error(err);
        listEl.style.display = 'none';
        listEl.innerHTML = '';
      }
    }, 300); // petita espera perquè no faci massa peticions
  });

  // Quan cliquem un suggeriment, omplim l'input amb el nom i guardem lat/lon
  listEl.addEventListener('click', (e) => {
    const el = e.target.closest('.sugg-item');
    if (!el) return;
    inputEl.value = el.textContent;
    inputEl.dataset.lat = el.dataset.lat;
    inputEl.dataset.lon = el.dataset.lon;
    listEl.style.display = 'none';
  });

  // Amaga el llistat si cliquem fora
  document.addEventListener('click', (e) => {
    if (!listEl.contains(e.target) && e.target !== inputEl) {
      listEl.style.display = 'none';
    }
  });
}


// ------------------------------------------------------
// 3) Inicialització del mapa Leaflet
// ------------------------------------------------------

const map = L.map('map').setView([41.3851, 2.1734], 13); // Barcelona centre
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap'
}).addTo(map);

let originMarker = null;
let destMarker   = null;
let routeLayer   = null;       // capa principal (mode seleccionat)
window._altLayer = null;       // capa alternativa (altre mode)


// ------------------------------------------------------
// 4) Càlcul de rutes amb OSRM
// ------------------------------------------------------

// Petit Haversine per estimar distància (en km) entre 2 punts
function approxKm(start, end) {
  const [lat1, lon1] = start;
  const [lat2, lon2] = end;
  const R = 6371;
  const toRad = d => d * Math.PI / 180;

  const dlat = toRad(lat2 - lat1);
  const dlon = toRad(lon2 - lon1);
  const a =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dlon / 2) ** 2;

  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// Construeix la URL d’OSRM segons el mode i la distància estimada
function osrmUrl(mode, start, end) {
  const distKm = approxKm(start, end);

  if (mode === 'eco') {
    // --------------------------------------------------
    // Ruta ECO:
    //  - Distància curta (<= 10 km) → "walking"
    //    (caminar, o bicicleta de forma aproximada).
    //  - Distància llarga  (> 10 km) → "driving" evitant
    //    autopistes i peatges.
    // --------------------------------------------------
    if (distKm <= 10) {
      return `https://router.project-osrm.org/route/v1/walking/${start[1]},${start[0]};${end[1]},${end[0]}?overview=full&geometries=geojson`;
    } else {
      return `https://router.project-osrm.org/route/v1/driving/${start[1]},${start[0]};${end[1]},${end[0]}?overview=full&geometries=geojson&exclude=motorway,toll`;
    }
  }

  // --------------------------------------------------
  // Ruta RÀPIDA:
  //  - Sempre "driving" normal → pot utilitzar autopistes.
  // --------------------------------------------------
  return `https://router.project-osrm.org/route/v1/driving/${start[1]},${start[0]};${end[1]},${end[0]}?overview=full&geometries=geojson`;
}

// Demana una ruta a OSRM i gestiona errors bàsics
async function fetchOsrmRoute(mode, start, end) {
  const url = osrmUrl(mode, start, end);
  let r;
  try {
    r = await fetch(url).then(x => x.json());
  } catch (err) {
    console.error(err);
    throw new Error("No s'ha pogut contactar amb el servidor de rutes (OSRM).");
  }

  if (r.code !== 'Ok' || !r.routes || !r.routes.length) {
    console.error('[OSRM] Resposta inesperada:', r);
    throw new Error("No s'ha pogut obtenir la ruta real.");
  }
  return r.routes[0]; // agafem la ruta principal
}


// ------------------------------------------------------
// 5) Flux principal: inputs + càlcul + dibuix
// ------------------------------------------------------

const originInput = document.getElementById('origin_name');
const destInput   = document.getElementById('dest_name');
const modeSelect  = document.getElementById('route_mode');

attachSuggest(originInput, document.getElementById('sugg_origin'));
attachSuggest(destInput,   document.getElementById('sugg_dest'));

// Botó calcular
document.getElementById('calc_btn').addEventListener('click', calculateRoute);

// Enter als inputs → també calcula
originInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') calculateRoute();
});
destInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') calculateRoute();
});

// Assegura que un input té coords (si no, geocodifica el text)
async function ensureCoords(inputEl) {
  const name = inputEl.value.trim();
  if (!name) throw new Error('Cal escriure un origen i un destí.');

  let lat = parseFloat(inputEl.dataset.lat || 'NaN');
  let lon = parseFloat(inputEl.dataset.lon || 'NaN');

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    const results = await geocode(name);
    if (!results.length) {
      throw new Error(`No s'ha trobat cap resultat per: ${name}`);
    }
    const first = results[0];
    lat = first.lat;
    lon = first.lon;

    // Guardem coords a data-* per reutilitzar-les
    inputEl.dataset.lat = String(lat);
    inputEl.dataset.lon = String(lon);
    // Mostrem el nom complet (més “bonic”)
    inputEl.value = first.name;
  }

  return { name, lat, lon };
}

// Funció principal que calcula la ruta i actualitza el mapa i el panell
async function calculateRoute() {
  const btn    = document.getElementById('calc_btn');
  const result = document.getElementById('result');

  btn.disabled = true;
  result.textContent = 'Calculant ruta...';

  try {
    // 1) Obtenim coords d’origen i destí
    const o = await ensureCoords(originInput);
    const d = await ensureCoords(destInput);
    const mode = modeSelect.value;  // 'eco' o 'fast'

    const start = [o.lat, o.lon];
    const end   = [d.lat, d.lon];

    // 2) Posem marcadors al mapa
    if (originMarker) map.removeLayer(originMarker);
    if (destMarker)   map.removeLayer(destMarker);

    originMarker = L.marker(start).addTo(map).bindPopup('Origen').openPopup();
    destMarker   = L.marker(end).addTo(map).bindPopup('Destí');

    // 3) Demanem les dues rutes a OSRM en paral·lel
    const [ecoRoute, fastRoute] = await Promise.all([
      fetchOsrmRoute('eco',  start, end),
      fetchOsrmRoute('fast', start, end)
    ]);

    // 4) Eliminem capes anteriors i dibuixem la principal i l’alternativa
    if (routeLayer)       map.removeLayer(routeLayer);
    if (window._altLayer) map.removeLayer(window._altLayer);

    const picked   = (mode === 'eco') ? 'eco' : 'fast';
    const mainGeo  = (picked === 'eco') ? ecoRoute.geometry : fastRoute.geometry;
    const altGeo   = (picked === 'eco') ? fastRoute.geometry : ecoRoute.geometry;
    const mainCol  = (picked === 'eco') ? '#16a34a' : '#2563eb'; // verd / blau
    const altCol   = (picked === 'eco') ? '#2563eb' : '#16a34a';

    // Capa principal (més gruix)
    routeLayer = L.geoJSON(mainGeo, {
      style: { color: mainCol, weight: 6, opacity: 0.95 }
    }).addTo(map);

    // Capa alternativa (més fina i opcionalment discontínua)
    window._altLayer = L.geoJSON(altGeo, {
      style: { color: altCol, weight: 3, opacity: 0.6, dashArray: '6 6' }
    }).addTo(map);

    map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });

    // 5) Distàncies i durades
    const ecoDistKm   = (ecoRoute.distance  / 1000).toFixed(2);
    const fastDistKm  = (fastRoute.distance / 1000).toFixed(2);
    const usedRoute   = (picked === 'eco') ? ecoRoute : fastRoute;
    const usedDistKm  = (usedRoute.distance / 1000).toFixed(2);
    const usedMinutes = Math.round(usedRoute.duration / 60);

    // 6) Crida al backend per CO₂ (si està disponible)
    if (API_BASE === null) {
      API_BASE = await detectApiBase();
    }

    let co2Text = '—';
    let recText = (picked === 'eco')
      ? 'Ruta verda prioritzada'
      : 'Ruta ràpida prioritzada';

    if (API_BASE) {
      try {
        const resp = await fetch(API_BASE + '/route', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            start_lat: o.lat,
            start_lon: o.lon,
            end_lat:   d.lat,
            end_lon:   d.lon,
            mode      // 'eco' o 'fast'
          })
        });

        if (resp.ok) {
          const data = await resp.json();
          if (data.co2_estimated_g != null) {
            co2Text = `${data.co2_estimated_g} g`;
          }
          if (data.recommendation) {
            recText = data.recommendation;
          }
        } else {
          console.warn('[WARN] Backend /route ha respost amb error:', resp.status);
        }
      } catch (err) {
        console.warn('[WARN] No s’ha pogut contactar amb el backend per al CO₂:', err);
      }
    }

    // 7) Missatge extra segons el mode triat
    const extraText = (picked === 'eco')
      ? '🌱 Ruta ECO (línia verda) mostrada com a principal. Ruta ràpida (blava) també visible com a alternativa.'
      : '⚡ Ruta RÀPIDA (línia blava) mostrada com a principal. Ruta eco (verda) també visible com a alternativa.';

    // 8) Escriure resultat al panell lateral
    result.innerHTML = `
      <b>Distància eco:</b> ${ecoDistKm} km &nbsp; | &nbsp;
      <b>Distància ràpida:</b> ${fastDistKm} km<br>
      <b>Distància utilitzada:</b> ${usedDistKm} km &nbsp; · &nbsp;
      <b>Durada estimada:</b> ${usedMinutes} min<br>
      <b>CO₂ estimat:</b> ${co2Text}<br>
      <b>Recomanació:</b> ${recText}<br>
      <span class="muted">${extraText}</span>
    `;

  } catch (err) {
    console.error(err);
    result.textContent = err.message || 'Error en el càlcul de la ruta.';
  } finally {
    btn.disabled = false;
  }
}