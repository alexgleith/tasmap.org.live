'use strict';

// ============================================================
// State
// ============================================================
const allLayers = {};        // id → layer descriptor
const addedLayerIds = [];    // ids of layers currently on map
const featureUUIDs = {};     // uuid → GeoJSON feature (for table hover)

const HIDDEN_PROPS = new Set([
  'bbox', 'SHAPE.LEN', 'SHAPE', 'SHAPE.AREA', 'LIST_GUID',
  'OBJECTID', 'Shape', 'Shape.STLength()', 'Shape.STArea()',
  'Shape_Length', 'Shape_Area'
]);

// ============================================================
// URL parameter helpers
// ============================================================
function getParam(name) {
  return new URLSearchParams(location.search).get(name);
}

function setParam(name, value) {
  const url = new URL(location.href);
  if (value) url.searchParams.set(name, value);
  else url.searchParams.delete(name);
  history.replaceState({}, '', url.toString());
}

// ============================================================
// Basemaps
// ============================================================
const LIST_BASE = 'https://services.thelist.tas.gov.au/arcgis/rest/services/Basemaps';
const basemapConfigs = [
  {
    id: 'Topographic',
    tiles: [`${LIST_BASE}/Topographic/MapServer/tile/{z}/{y}/{x}`],
    sourceExtraParams: { tileSize: 256, maxzoom: 18,
      attribution: 'Basemap © <a href="https://www.thelist.tas.gov.au">the LIST</a>, State of Tasmania' }
  },
  {
    id: 'Imagery',
    tiles: [`${LIST_BASE}/Orthophoto/MapServer/tile/{z}/{y}/{x}`],
    sourceExtraParams: { tileSize: 256, maxzoom: 19,
      attribution: 'Imagery © <a href="https://www.thelist.tas.gov.au">the LIST</a>, State of Tasmania' }
  },
  {
    id: 'Hillshade',
    tiles: [`${LIST_BASE}/Hillshade/MapServer/tile/{z}/{y}/{x}`],
    sourceExtraParams: { tileSize: 256, maxzoom: 18,
      attribution: 'Hillshade © <a href="https://www.thelist.tas.gov.au">the LIST</a>, State of Tasmania' }
  },
  {
    id: 'Tasmap-25K',
    tiles: [`${LIST_BASE}/Tasmap25K/MapServer/tile/{z}/{y}/{x}`],
    sourceExtraParams: { tileSize: 256, maxzoom: 18,
      attribution: 'Tasmap25K © <a href="https://www.thelist.tas.gov.au">the LIST</a>, State of Tasmania' }
  }
];

// ============================================================
// Map initialisation
// ============================================================
let initialBase = getParam('baseLayer') || 'Topographic';
if (!basemapConfigs.find(b => b.id === initialBase)) initialBase = 'Topographic';

const initialLayers = getParam('layers') ? getParam('layers').split(';') : [];

// Parse hash for initial center/zoom: #zoom/lat/lng
let initZoom = 8, initCenter = [146.780, -42.070];
if (location.hash) {
  const parts = location.hash.replace('#', '').split('/');
  if (parts.length === 3) {
    initZoom = parseFloat(parts[0]) || 8;
    initCenter = [parseFloat(parts[2]) || 146.780, parseFloat(parts[1]) || -42.070];
  }
}

const map = new maplibregl.Map({
  container: 'map',
  style: { version: 8, sources: {}, layers: [] },
  center: initCenter,
  zoom: initZoom,
  maxZoom: 20
});

// Navigation & geolocation controls
map.addControl(new maplibregl.NavigationControl(), 'top-left');
map.addControl(new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true,
  showUserHeading: true
}), 'top-left');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

// Basemap switcher control (thumbnails on the map)
const basemapControl = new MaplibreGLBasemapsControl({
  basemaps: basemapConfigs,
  initialBasemap: initialBase,
  expandDirection: 'top'
});
map.addControl(basemapControl, 'bottom-right');

// Track basemap changes for URL param
let activeBaseMap = initialBase;
const basemapObserver = new MutationObserver(() => {
  const active = basemapConfigs.find(b => {
    const layer = map.getLayer(b.id);
    return layer && map.getLayoutProperty(b.id, 'visibility') === 'visible';
  });
  if (active && active.id !== activeBaseMap) {
    activeBaseMap = active.id;
    setParam('baseLayer', active.id === 'Topographic' ? null : active.id);
  }
});
// Observe the control container for click-driven changes
map.on('load', () => {
  const el = basemapControl._container || document.querySelector('.basemaps');
  if (el) basemapObserver.observe(el, { attributes: true, subtree: true });
});

// ============================================================
// URL hash sync (zoom/lat/lng)
// ============================================================
function updateHash() {
  const c = map.getCenter();
  const z = map.getZoom().toFixed(1);
  location.hash = `${z}/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}`;
}
map.on('moveend', updateHash);

// ============================================================
// Esri REST layer discovery
// ============================================================
const LIST_REST = 'https://services.thelist.tas.gov.au/arcgis/rest/services/';

async function discoverEsriLayers(baseURL, startFolder, label) {
  const listEl = document.getElementById('layer-list');
  listEl.innerHTML = '<div class="loading-layers"><i class="fa-solid fa-spinner fa-spin"></i> Loading layers…</div>';

  try {
    const catalogResp = await fetch(`${baseURL}${startFolder}?f=pjson`);
    const catalog = await catalogResp.json();
    const services = (catalog.services || []).filter(s => s.type === 'MapServer');

    const layerPromises = services.map(async (service) => {
      const serviceURL = `${baseURL}${service.name}/MapServer`;
      try {
        const resp = await fetch(`${serviceURL}?f=pjson`);
        const data = await resp.json();
        return (data.layers || []).map(lyr => ({
          id: `${label}-${service.name}-${lyr.id}`,
          group: service.name.replace(/^Public\//, ''),
          title: lyr.name,
          meta: lyr,
          url: serviceURL,
          type: 'esri',
          added: false,
          visible: false
        }));
      } catch (e) {
        console.warn(`Failed to load ${serviceURL}`, e);
        return [];
      }
    });

    const results = await Promise.all(layerPromises);
    const layers = results.flat();

    // Sort by group then title
    layers.sort((a, b) => {
      const gc = a.group.localeCompare(b.group);
      return gc !== 0 ? gc : a.title.localeCompare(b.title);
    });

    // Register and render
    listEl.innerHTML = '';
    let currentGroup = null;
    for (const layer of layers) {
      allLayers[layer.id] = layer;

      if (layer.group !== currentGroup) {
        currentGroup = layer.group;
        const header = document.createElement('div');
        header.className = 'layer-group-header';
        header.textContent = currentGroup;
        listEl.appendChild(header);
      }

      const div = document.createElement('div');
      div.className = 'layer-item';
      div.dataset.layerId = layer.id;
      div.innerHTML = `<span class="layer-check"></span><span class="layer-name">${layer.title}</span>`;
      div.addEventListener('click', () => toggleLayer(layer.id));
      listEl.appendChild(div);
    }

    // Auto-add layers from URL
    for (const id of initialLayers) {
      if (allLayers[id]) toggleLayer(id);
    }
  } catch (e) {
    listEl.innerHTML = '<div class="loading-layers">Failed to load layers.</div>';
    console.error('Layer discovery failed', e);
  }
}

// ============================================================
// Add / remove overlay layers on the map
// ============================================================
function toggleLayer(layerId) {
  const layer = allLayers[layerId];
  if (!layer) return;

  const idx = addedLayerIds.indexOf(layerId);
  if (idx !== -1) {
    // Remove
    removeLayerFromMap(layerId);
    addedLayerIds.splice(idx, 1);
  } else {
    // Add
    addLayerToMap(layer);
    addedLayerIds.push(layerId);
  }
  updateLayerListUI();
  updateLayersParam();
}

function addLayerToMap(layer) {
  const srcId = `overlay-${layer.id}`;
  const lyrId = `overlay-layer-${layer.id}`;

  // ArcGIS MapServer export with {bbox-epsg-3857}
  const tileUrl = `${layer.url}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857` +
    `&size=512,512&format=png32&transparent=true&layers=show:${layer.meta.id}&f=image`;

  map.addSource(srcId, {
    type: 'raster',
    tiles: [tileUrl],
    tileSize: 512
  });
  map.addLayer({ id: lyrId, type: 'raster', source: srcId });

  layer.added = true;
  layer.visible = true;
}

function removeLayerFromMap(layerId) {
  const lyrId = `overlay-layer-${layerId}`;
  const srcId = `overlay-${layerId}`;
  if (map.getLayer(lyrId)) map.removeLayer(lyrId);
  if (map.getSource(srcId)) map.removeSource(srcId);
  const layer = allLayers[layerId];
  if (layer) { layer.added = false; layer.visible = false; }
}

function updateLayerListUI() {
  // Update checkmarks in main list
  document.querySelectorAll('#layer-list .layer-item').forEach(el => {
    const id = el.dataset.layerId;
    const isActive = addedLayerIds.includes(id);
    el.classList.toggle('active', isActive);
    el.querySelector('.layer-check').innerHTML = isActive ? '<i class="fa-solid fa-check"></i>' : '';
  });

  // Rebuild pinned active layers section
  const activeSection = document.getElementById('sidebar-active');
  const activeList = document.getElementById('active-layer-list');
  activeList.innerHTML = '';

  if (addedLayerIds.length === 0) {
    activeSection.classList.add('hidden');
    return;
  }

  activeSection.classList.remove('hidden');
  for (const id of addedLayerIds) {
    const layer = allLayers[id];
    if (!layer) continue;
    const div = document.createElement('div');
    div.className = 'layer-item active';
    div.dataset.layerId = id;
    div.innerHTML = `<span class="layer-check"><i class="fa-solid fa-check"></i></span><span class="layer-name">${layer.title}</span>`;
    div.addEventListener('click', () => toggleLayer(id));
    activeList.appendChild(div);
  }
}

function updateLayersParam() {
  const val = addedLayerIds.join(';');
  setParam('layers', val || null);
}

// ============================================================
// Click-to-identify (Esri REST)
// ============================================================
map.on('click', (e) => {
  // Skip if clicking on existing highlighted features
  const features = map.queryRenderedFeatures(e.point, { layers: ['selected-fills', 'selected-lines', 'selected-circles'].filter(id => map.getLayer(id)) });
  
  clearIdentifyResults();
  clearSelectedFeatures();

  const activeLayers = addedLayerIds
    .map(id => allLayers[id])
    .filter(l => l && l.visible);

  if (activeLayers.length === 0) return;

  const { lng, lat } = e.lngLat;
  const bounds = map.getBounds();
  const canvas = map.getCanvas();
  const mapExtent = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`;
  const imageDisplay = `${canvas.width},${canvas.height},96`;

  for (const layer of activeLayers) {
    identifyFeature(layer, lng, lat, mapExtent, imageDisplay);
  }
});

async function identifyFeature(layer, lng, lat, mapExtent, imageDisplay) {
  const url = `${layer.url}/identify?` + new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: 'esriGeometryPoint',
    sr: '4326',
    layers: `visible:${layer.meta.id}`,
    tolerance: '10',
    mapExtent,
    imageDisplay,
    returnGeometry: 'true',
    f: 'json'
  });

  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.results && data.results.length > 0) {
      const geojsonFeatures = data.results.map(r => esriResultToGeoJSON(r));
      handleIdentifyResults(layer, geojsonFeatures);
    }
  } catch (e) {
    console.warn('Identify failed for', layer.title, e);
  }
}

function esriResultToGeoJSON(result) {
  const geom = result.geometry;
  const props = { ...result.attributes };
  const uuid = crypto.randomUUID ? crypto.randomUUID() : guid();
  let geometry = null;

  if (geom) {
    if (geom.x !== undefined && geom.y !== undefined) {
      geometry = { type: 'Point', coordinates: [geom.x, geom.y] };
    } else if (geom.rings) {
      geometry = { type: 'Polygon', coordinates: geom.rings };
    } else if (geom.paths) {
      geometry = {
        type: geom.paths.length > 1 ? 'MultiLineString' : 'LineString',
        coordinates: geom.paths.length > 1 ? geom.paths : geom.paths[0]
      };
    }
  }

  props._uuid = uuid;
  return { type: 'Feature', geometry, properties: props, id: uuid, uuid };
}

function guid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ============================================================
// Display identify results
// ============================================================
function handleIdentifyResults(layer, features) {
  if (!features.length) return;
  features.forEach(f => { featureUUIDs[f.uuid] = f; });
  addDataToTable(layer.title, layer.id, features);
  addDataToMap(features);
  document.getElementById('data-detail').classList.add('active');
}

function addDataToTable(title, layerId, features) {
  const tabId = layerId.replace(/[^a-zA-Z0-9]/g, '');
  const tabs = document.getElementById('data-tabs');
  const contents = document.getElementById('data-tab-contents');

  // Deactivate other tabs
  tabs.querySelectorAll('li').forEach(li => li.classList.remove('active'));
  contents.querySelectorAll('.data-pane').forEach(p => p.classList.remove('active'));

  // Tab
  const li = document.createElement('li');
  li.className = 'active';
  const a = document.createElement('a');
  a.textContent = title;
  a.href = '#';
  a.addEventListener('click', (e) => {
    e.preventDefault();
    tabs.querySelectorAll('li').forEach(t => t.classList.remove('active'));
    contents.querySelectorAll('.data-pane').forEach(p => p.classList.remove('active'));
    li.classList.add('active');
    document.getElementById(`pane-${tabId}`).classList.add('active');
  });
  li.appendChild(a);
  tabs.appendChild(li);

  // Collect visible property names
  const propNames = [];
  if (features.length > 0) {
    for (const name of Object.keys(features[0].properties)) {
      if (!HIDDEN_PROPS.has(name)) propNames.push(name);
    }
  }

  // Table
  let html = '<table><thead><tr>';
  for (const name of propNames) html += `<th>${name}</th>`;
  html += '</tr></thead><tbody>';

  for (const f of features) {
    html += `<tr data-uuid="${f.uuid}">`;
    for (const name of propNames) {
      html += `<td>${linkify(f.properties[name])}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';

  const pane = document.createElement('div');
  pane.className = 'data-pane active';
  pane.id = `pane-${tabId}`;
  pane.innerHTML = html;
  contents.appendChild(pane);

  // Row interactions
  pane.querySelectorAll('tr[data-uuid]').forEach(tr => {
    tr.addEventListener('mouseenter', () => highlightFeatureByUUID(tr.dataset.uuid));
    tr.addEventListener('mouseleave', () => unhighlightFeatureByUUID(tr.dataset.uuid));
    tr.addEventListener('click', () => zoomToFeatureByUUID(tr.dataset.uuid));
  });
}

function addDataToMap(features) {
  const src = map.getSource('selected-features');
  if (src) {
    // Merge with existing
    const existing = src._data || { type: 'FeatureCollection', features: [] };
    existing.features.push(...features);
    src.setData(existing);
  } else {
    const fc = { type: 'FeatureCollection', features };
    map.addSource('selected-features', { type: 'geojson', data: fc });
    map.getSource('selected-features')._data = fc;

    // Polygon fills
    map.addLayer({
      id: 'selected-fills',
      type: 'fill',
      source: 'selected-features',
      filter: ['==', '$type', 'Polygon'],
      paint: { 'fill-color': '#FFD700', 'fill-opacity': 0.25 }
    });
    // Lines (polygons + linestrings)
    map.addLayer({
      id: 'selected-lines',
      type: 'line',
      source: 'selected-features',
      filter: ['any', ['==', '$type', 'Polygon'], ['==', '$type', 'LineString']],
      paint: { 'line-color': '#FFD700', 'line-width': 3 }
    });
    // Points
    map.addLayer({
      id: 'selected-circles',
      type: 'circle',
      source: 'selected-features',
      filter: ['==', '$type', 'Point'],
      paint: {
        'circle-radius': 7,
        'circle-color': '#FFD700',
        'circle-stroke-color': '#000',
        'circle-stroke-width': 2,
        'circle-opacity': 0.7
      }
    });
  }
}

function clearSelectedFeatures() {
  for (const id of ['selected-fills', 'selected-lines', 'selected-circles']) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of ['highlight-line', 'highlight-circle']) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource('selected-features')) map.removeSource('selected-features');
  if (map.getSource('highlight-feature')) map.removeSource('highlight-feature');
  Object.keys(featureUUIDs).forEach(k => delete featureUUIDs[k]);
  hoveredUUID = null;
}

function clearIdentifyResults() {
  document.getElementById('data-tabs').innerHTML = '';
  document.getElementById('data-tab-contents').innerHTML = '';
  document.getElementById('data-detail').classList.remove('active');
}

// ============================================================
// Map hover → highlight feature + table row
// ============================================================
let hoveredUUID = null;
const SELECTABLE_LAYERS = ['selected-fills', 'selected-lines', 'selected-circles'];

map.on('mousemove', (e) => {
  const layers = SELECTABLE_LAYERS.filter(id => map.getLayer(id));
  if (!layers.length) return;

  const features = map.queryRenderedFeatures(e.point, { layers });
  const uuid = features.length ? features[0].properties._uuid : null;

  if (uuid === hoveredUUID) return;

  // Un-highlight previous
  if (hoveredUUID) unhighlightFeatureByUUID(hoveredUUID);

  // Highlight new
  if (uuid) {
    highlightFeatureByUUID(uuid);
    map.getCanvas().style.cursor = 'pointer';
  } else {
    map.getCanvas().style.cursor = '';
  }
  hoveredUUID = uuid;
});

map.on('mouseleave', 'selected-fills', () => {
  if (hoveredUUID) { unhighlightFeatureByUUID(hoveredUUID); hoveredUUID = null; }
  map.getCanvas().style.cursor = '';
});
map.on('mouseleave', 'selected-lines', () => {
  if (hoveredUUID) { unhighlightFeatureByUUID(hoveredUUID); hoveredUUID = null; }
  map.getCanvas().style.cursor = '';
});
map.on('mouseleave', 'selected-circles', () => {
  if (hoveredUUID) { unhighlightFeatureByUUID(hoveredUUID); hoveredUUID = null; }
  map.getCanvas().style.cursor = '';
});

// Feature highlighting from table
function highlightFeatureByUUID(uuid) {
  const f = featureUUIDs[uuid];
  if (!f || !f.geometry) return;

  const src = map.getSource('highlight-feature');
  const fc = { type: 'FeatureCollection', features: [f] };
  if (src) {
    src.setData(fc);
  } else {
    map.addSource('highlight-feature', { type: 'geojson', data: fc });
    map.addLayer({
      id: 'highlight-line', type: 'line', source: 'highlight-feature',
      paint: { 'line-color': '#FF4500', 'line-width': 5 }
    });
    map.addLayer({
      id: 'highlight-circle', type: 'circle', source: 'highlight-feature',
      filter: ['==', '$type', 'Point'],
      paint: { 'circle-radius': 12, 'circle-color': '#FF4500', 'circle-opacity': 0.6 }
    });
  }

  document.querySelector(`tr[data-uuid="${uuid}"]`)?.classList.add('highlighted');
}

function unhighlightFeatureByUUID(uuid) {
  const src = map.getSource('highlight-feature');
  if (src) src.setData({ type: 'FeatureCollection', features: [] });
  document.querySelector(`tr[data-uuid="${uuid}"]`)?.classList.remove('highlighted');
}

function zoomToFeatureByUUID(uuid) {
  const f = featureUUIDs[uuid];
  if (!f || !f.geometry) return;
  const bounds = new maplibregl.LngLatBounds();
  
  function addCoords(coords) {
    if (typeof coords[0] === 'number') {
      bounds.extend(coords);
    } else {
      coords.forEach(addCoords);
    }
  }

  addCoords(f.geometry.coordinates);
  if (!bounds.isEmpty()) {
    map.fitBounds(bounds, { padding: 60, maxZoom: 17 });
  }
}

// ============================================================
// Linkify text values
// ============================================================
function linkify(val) {
  if (val == null) return '';
  const text = String(val);
  return text
    .replace(/(\b(https?|ftp):\/\/[-A-Z0-9+&@#/%?=~_|!:,.;]*[-A-Z0-9+&@#/%=~_|])/gim,
      '<a href="$1" target="_blank">link</a>')
    .replace(/(^|[^/])(www\.[\S]+(\b|$))/gim,
      '$1<a href="http://$2" target="_blank">$2</a>');
}

// ============================================================
// Search (Nominatim / OpenStreetMap)
// ============================================================
let searchTimeout = null;
const searchBox = document.getElementById('searchbox');
const searchResults = document.getElementById('search-results');

searchBox.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  const q = searchBox.value.trim();
  if (q.length < 3) { searchResults.classList.remove('active'); return; }
  searchTimeout = setTimeout(() => searchNominatim(q), 350);
});

searchBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.preventDefault();
});

searchBox.addEventListener('focus', () => searchBox.select());

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-container')) searchResults.classList.remove('active');
});

async function searchNominatim(query) {
  const url = `https://nominatim.openstreetmap.org/search?` + new URLSearchParams({
    format: 'json',
    q: query,
    viewbox: '143.5,-39.5,149,-44',
    bounded: '0',
    limit: '8',
    countrycodes: 'au'
  });

  try {
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json' }
    });
    const results = await resp.json();
    renderSearchResults(results);
  } catch (e) {
    console.warn('Search failed', e);
  }
}

function renderSearchResults(results) {
  searchResults.innerHTML = '';
  if (!results.length) {
    searchResults.classList.remove('active');
    return;
  }
  searchResults.classList.add('active');
  for (const r of results) {
    const div = document.createElement('div');
    div.className = 'search-result-item';
    div.textContent = r.display_name;
    div.addEventListener('click', () => {
      if (r.boundingbox) {
        const [s, n, w, e] = r.boundingbox.map(Number);
        map.fitBounds([[w, s], [e, n]], { padding: 40 });
      } else {
        map.flyTo({ center: [parseFloat(r.lon), parseFloat(r.lat)], zoom: 14 });
      }
      searchBox.value = r.display_name;
      searchResults.classList.remove('active');
    });
    searchResults.appendChild(div);
  }
}

// ============================================================
// Sidebar
// ============================================================
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('hidden');
  // Let MapLibre recalculate size
  setTimeout(() => map.resize(), 350);
}

document.getElementById('sidebar-hide-btn').addEventListener('click', toggleSidebar);
document.getElementById('sidebar-toggle-btn').addEventListener('click', toggleSidebar);
document.getElementById('list-btn').addEventListener('click', toggleSidebar);

// Start with sidebar hidden on mobile
if (window.innerWidth <= 768) {
  document.getElementById('sidebar').classList.add('hidden');
}

// Filter
const filterInput = document.getElementById('filter');
filterInput.addEventListener('input', () => {
  const rex = new RegExp(filterInput.value, 'i');
  document.querySelectorAll('.layer-item').forEach(el => {
    el.style.display = rex.test(el.querySelector('.layer-name').textContent) ? '' : 'none';
  });
  // Hide empty group headers
  document.querySelectorAll('.layer-group-header').forEach(header => {
    let next = header.nextElementSibling;
    let hasVisible = false;
    while (next && !next.classList.contains('layer-group-header')) {
      if (next.style.display !== 'none') hasVisible = true;
      next = next.nextElementSibling;
    }
    header.style.display = hasVisible ? '' : 'none';
  });
});

filterInput.addEventListener('focus', () => filterInput.select());

document.getElementById('searchclear').addEventListener('click', () => {
  filterInput.value = '';
  filterInput.dispatchEvent(new Event('input'));
});

// ============================================================
// Data panel buttons
// ============================================================
document.getElementById('data-detail-close-btn').addEventListener('click', () => {
  document.getElementById('data-detail').classList.remove('active');
});

document.getElementById('data-detail-clear-btn').addEventListener('click', () => {
  clearSelectedFeatures();
  clearIdentifyResults();
});

// ============================================================
// About modal
// ============================================================
document.getElementById('about-btn').addEventListener('click', () => {
  document.getElementById('about-overlay').classList.remove('hidden');
});
document.getElementById('about-close').addEventListener('click', () => {
  document.getElementById('about-overlay').classList.add('hidden');
});
document.getElementById('about-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.classList.add('hidden');
  }
});

// ============================================================
// Boot
// ============================================================
map.on('load', () => {
  discoverEsriLayers(LIST_REST, 'Public', 'list');
});
