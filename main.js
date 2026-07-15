const canvas = document.querySelector("#earth-canvas");
const label = document.querySelector("#forecast-label");
const timeLabel = document.querySelector("#forecast-time");
const textureStatus = document.querySelector("#texture-status");
const forecastSourceLabel = document.querySelector("#forecast-source");
const playToggle = document.querySelector("#play-toggle");
const earthRotationToggle = document.querySelector("#earth-rotation-toggle");
const weatherToggle = document.querySelector("#weather-toggle");
const slider = document.querySelector("#frame-slider");
const timelineStart = document.querySelector("#timeline-start");
const timelineEnd = document.querySelector("#timeline-end");
const timelineTicks = document.querySelector("#timeline-ticks");
const citySearch = document.querySelector("#city-search");
const cityInput = document.querySelector("#city-input");
const citySearchButton = document.querySelector("#city-search-button");
const cityResults = document.querySelector("#city-results");
const citySearchMessage = document.querySelector("#city-search-message");
const locationPanel = document.querySelector("#location-panel");
const locationLeader = document.querySelector("#location-leader");
const mapAttribution = document.querySelector("#map-attribution");
const locationClose = document.querySelector("#location-close");
const locationName = document.querySelector("#location-name");
const locationCoordinates = document.querySelector("#location-coordinates");
const locationTemperature = document.querySelector("#location-temperature");
const locationWind = document.querySelector("#location-wind");
const locationPrecipitation = document.querySelector("#location-precipitation");
const locationModelNote = document.querySelector(".model-note");
const layerControls = document.querySelector("#layer-controls");
const activeLayerLegend = document.querySelector("#active-layer-legend");
let layerInputs = [];
const dayNightToggle = document.querySelector("#day-night-toggle");
const earthStyleSelect = document.querySelector("#earth-style");
const weatherSourceSelect = document.querySelector("#weather-source");
const mapTilesConfig = window.DIGITAL_TWIN_CONFIG?.mapTiles ?? {};

const forecastStart = new Date("2026-07-08T00:00:00Z");
let forecastFrames = Array.from({ length: 9 }, (_, index) => ({
  index,
  leadHours: index * 6,
  validTime: new Date(forecastStart.getTime() + index * 6 * 60 * 60 * 1000),
}));

// A compact built-in gazetteer keeps the MVP usable without a geocoding service.
const cities = [
  { name: "New York", country: "United States", lat: 40.713, lon: -74.006, temp: 20, wind: 17, rain: 2 },
  { name: "London", country: "United Kingdom", lat: 51.507, lon: -0.128, temp: 14, wind: 20, rain: 3 },
  { name: "San Francisco", country: "United States", lat: 37.775, lon: -122.419, temp: 17, wind: 18, rain: 0 },
  { name: "Los Angeles", country: "United States", lat: 34.052, lon: -118.244, temp: 24, wind: 12, rain: 0 },
  { name: "Chicago", country: "United States", lat: 41.878, lon: -87.630, temp: 18, wind: 23, rain: 1 },
  { name: "Miami", country: "United States", lat: 25.762, lon: -80.192, temp: 28, wind: 16, rain: 4 },
  { name: "Mexico City", country: "Mexico", lat: 19.433, lon: -99.133, temp: 21, wind: 11, rain: 6 },
  { name: "Sao Paulo", country: "Brazil", lat: -23.551, lon: -46.633, temp: 23, wind: 14, rain: 5 },
  { name: "Reykjavik", country: "Iceland", lat: 64.147, lon: -21.942, temp: 7, wind: 27, rain: 2 },
  { name: "Paris", country: "France", lat: 48.857, lon: 2.352, temp: 16, wind: 13, rain: 1 },
  { name: "Cairo", country: "Egypt", lat: 30.044, lon: 31.236, temp: 31, wind: 15, rain: 0 },
  { name: "Nairobi", country: "Kenya", lat: -1.292, lon: 36.822, temp: 23, wind: 13, rain: 4 },
  { name: "Cape Town", country: "South Africa", lat: -33.925, lon: 18.424, temp: 16, wind: 24, rain: 1 },
  { name: "Dubai", country: "United Arab Emirates", lat: 25.205, lon: 55.271, temp: 35, wind: 19, rain: 0 },
  { name: "Mumbai", country: "India", lat: 19.076, lon: 72.878, temp: 30, wind: 21, rain: 8 },
  { name: "Singapore", country: "Singapore", lat: 1.352, lon: 103.820, temp: 29, wind: 12, rain: 11 },
  { name: "Tokyo", country: "Japan", lat: 35.676, lon: 139.650, temp: 25, wind: 19, rain: 2 },
  { name: "Sydney", country: "Australia", lat: -33.869, lon: 151.209, temp: 18, wind: 17, rain: 1 },
  { name: "Auckland", country: "New Zealand", lat: -36.851, lon: 174.764, temp: 16, wind: 16, rain: 3 },
];

const textureBase = "https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets";
const localNasaTextures = {
  earth: "./nasa-blue-marble-hd.jpg",
  lights: "./nasa-black-marble-2016.jpg",
};

const scene = new THREE.Scene();
const baseCameraFov = 34;
const cityCameraFov = 40;
const camera = new THREE.PerspectiveCamera(baseCameraFov, window.innerWidth / window.innerHeight, 0.1, 100);
const baseCameraPosition = new THREE.Vector3(0, 0.12, 5.9);
// Earth radius is 1.55 scene units. A 2.10-unit orbital distance is roughly
// 1,400 miles (2,250 km) above the surface: closer than the original city
// view while retaining regional context and Earth's curvature.
const cityCameraPosition = new THREE.Vector3(0, 0.05, 2.1);
const targetCameraPosition = baseCameraPosition.clone();
let targetCameraFov = baseCameraFov;
camera.position.copy(baseCameraPosition);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const textureLoader = new THREE.TextureLoader();
textureLoader.setCrossOrigin("anonymous");
const localTextureLoader = new THREE.TextureLoader();

const root = new THREE.Group();
root.rotation.y = -0.55;
root.rotation.x = 0.06;
scene.add(root);
const baseRotation = { x: root.rotation.x, y: root.rotation.y };

// This group holds the streamed, high-resolution regional imagery. It is part
// of the globe, so it remains geographically aligned with forecast overlays.
const regionalImagery = new THREE.Group();
regionalImagery.visible = false;
root.add(regionalImagery);
const regionalImageryCache = new Map();
let mapTileSession = null;
let regionalImageryRequest = 0;

const locationMarker = makeLocationMarker();
locationMarker.visible = false;
root.add(locationMarker);

const sun = new THREE.DirectionalLight(0xffffff, 3.2);
sun.position.set(3.6, 2.2, 4.5);
scene.add(sun);
const ambientLight = new THREE.AmbientLight(0x8ab8ff, 0.1);
scene.add(ambientLight);

const earthGeometry = new THREE.SphereGeometry(1.55, 192, 128);
const earthRadius = 1.55;

function makeEarthLayer(radius, material) {
  const mesh = new THREE.Mesh(earthGeometry, material);
  mesh.scale.setScalar(radius / earthRadius);
  return mesh;
}

const earthMaterial = new THREE.MeshPhongMaterial({
  map: makeSimplifiedEarthTexture(),
  bumpScale: 0.018,
  specular: new THREE.Color(0x253044),
  shininess: 9,
});
const earth = new THREE.Mesh(earthGeometry, earthMaterial);
root.add(earth);
const earthTextures = { nasa: null, satellite: null };
let activeEarthStyle = "nasa";
loadEarthSurfaceTextures();
loadRemoteTexture(`${textureBase}/earth_bump_2048.jpg`, (texture) => {
  earthMaterial.bumpMap = texture;
  earthMaterial.needsUpdate = true;
});
loadRemoteTexture(`${textureBase}/earth_specular_2048.jpg`, (texture) => {
  earthMaterial.specularMap = texture;
  earthMaterial.needsUpdate = true;
});

function loadEarthSurfaceTextures() {
  loadLocalTexture(localNasaTextures.earth, (texture) => {
    earthTextures.nasa = texture;
    if (activeEarthStyle === "nasa") applyEarthStyle("nasa");
  });

  loadRemoteTexture(`${textureBase}/earth_atmos_2048.jpg`, (texture) => {
    earthTextures.satellite = texture;
    if (activeEarthStyle === "satellite") applyEarthStyle("satellite");
  }, () => {
    if (activeEarthStyle === "satellite") {
      textureStatus.textContent = "Satellite image unavailable";
    }
  });
}

function applyEarthStyle(style) {
  activeEarthStyle = style;
  const texture = earthTextures[style];
  if (!texture) {
    textureStatus.textContent = style === "nasa"
      ? "Loading NASA Blue Marble..."
      : "Loading satellite Earth...";
    return;
  }

  earthMaterial.map = texture;
  earthMaterial.needsUpdate = true;
  textureStatus.textContent = style === "nasa"
    ? "Local NASA Blue Marble surface loaded"
    : "Satellite Earth texture loaded";
}

function loadNasaCityLights() {
  loadLocalTexture(localNasaTextures.lights, (texture) => {
    cityLightMaterial.uniforms.cityLights.value = texture;
    cityLightMaterial.needsUpdate = true;
  }, () => {
    loadRemoteTexture(`${textureBase}/earth_lights_2048.png`, (texture) => {
      cityLightMaterial.uniforms.cityLights.value = texture;
      cityLightMaterial.needsUpdate = true;
    });
  });
}

const cityLightMaterial = makeCityLightMaterial(makeCityLightTexture());
const cityLightLayer = makeEarthLayer(1.558, cityLightMaterial);
root.add(cityLightLayer);
loadNasaCityLights();

// Matches a common FourCastNet-style global surface grid: 0.25 degrees.
const modelGrid = { width: 1440, height: 721 };
const forecastTextureLayers = ["temperature", "rain", "moisture", "pressure"];
const syntheticFrameCache = new Map();
const syntheticFrameRequests = new Map();
const workerFrameRequests = new Map();
let syntheticFrameRequestId = 0;
let frameTransitionRequest = 0;
let forecastWorker = createForecastWorker();
const initialSyntheticFrame = getSyntheticFrame(0);
const temperatureMaterial = new THREE.MeshLambertMaterial({
  map: initialSyntheticFrame.temperature,
  transparent: true,
  opacity: 0.22,
  depthWrite: false,
});
const temperatureLayer = makeEarthLayer(1.568, temperatureMaterial);
temperatureLayer.renderOrder = 10;
root.add(temperatureLayer);

const rainMaterial = new THREE.MeshBasicMaterial({
  map: initialSyntheticFrame.rain,
  transparent: true,
  opacity: 0.72,
  blending: THREE.NormalBlending,
  depthWrite: false,
});
const rainLayer = makeEarthLayer(1.58, rainMaterial);
rainLayer.renderOrder = 11;
root.add(rainLayer);

const moistureMaterial = new THREE.MeshLambertMaterial({
  map: initialSyntheticFrame.moisture,
  transparent: true,
  opacity: 0.26,
  depthWrite: false,
});
const moistureLayer = makeEarthLayer(1.593, moistureMaterial);
moistureLayer.renderOrder = 12;
root.add(moistureLayer);

const pressureMaterial = new THREE.MeshLambertMaterial({
  map: initialSyntheticFrame.pressure,
  transparent: true,
  opacity: 0.58,
  depthWrite: false,
});
const pressureLayer = makeEarthLayer(1.606, pressureMaterial);
pressureLayer.renderOrder = 13;
root.add(pressureLayer);

const transitionLayers = makeTransitionLayers();

const windStreamlines = makeWindStreamlines(900);
root.add(windStreamlines.lines);

const forecastLayers = {
  temperature: temperatureLayer,
  rain: rainLayer,
  moisture: moistureLayer,
  pressure: pressureLayer,
  wind: windStreamlines.lines,
};
const pipelineLayers = new Map();
const pipelineSurfaceCache = new Map();
let pipelineManifest = null;
let activeWeatherSource = "synthetic";
let requestedWeatherSource = localStorage.getItem("digital-twin-earth.weather-source") || "auto";
if (!["auto", "pipeline", "graphcast-era5t", "synthetic"].includes(requestedWeatherSource)) requestedWeatherSource = "auto";

const stars = makeStars();
scene.add(stars);

let isPlaying = true;
let earthRotationEnabled = true;
let activeFrame = 0;
let frameTimer = 0;
let pointerDown = false;
let previousPointerX = 0;
let weatherVisible = false;
let selectedCity = null;
let targetRotation = null;
let dayNightEnabled = true;
let frameTransition = null;
let suggestedCities = [];
let citySuggestionQuery = "";
let citySuggestionTimer = null;
let citySuggestionRequest = 0;

weatherSourceSelect.value = requestedWeatherSource;
setWeatherSource(requestedWeatherSource);

playToggle.addEventListener("click", () => {
  isPlaying = !isPlaying;
  setControlState(playToggle, isPlaying, isPlaying ? "Weather timeline playing" : "Weather timeline paused");
});

earthRotationToggle.addEventListener("click", () => {
  earthRotationEnabled = !earthRotationEnabled;
  setControlState(earthRotationToggle, earthRotationEnabled, earthRotationEnabled ? "Earth rotation on" : "Earth rotation off");
});

slider.addEventListener("input", () => {
  updateFrame(Number(slider.value));
});

weatherToggle.addEventListener("click", () => {
  weatherVisible = !weatherVisible;
  setLayerVisibility();
  setControlState(weatherToggle, weatherVisible, weatherVisible ? "Forecast layers on" : "Forecast layers off");
});

weatherSourceSelect.addEventListener("change", () => {
  requestedWeatherSource = weatherSourceSelect.value;
  localStorage.setItem("digital-twin-earth.weather-source", requestedWeatherSource);
  setWeatherSource(requestedWeatherSource);
});

dayNightToggle.addEventListener("change", () => {
  dayNightEnabled = dayNightToggle.checked;
  updateLighting();
});

earthStyleSelect.addEventListener("change", () => {
  applyEarthStyle(earthStyleSelect.value);
});

citySearch.addEventListener("submit", async (event) => {
  event.preventDefault();
  const requestedCity = cityInput.value.trim().toLocaleLowerCase();
  if (!requestedCity) return;

  citySearchMessage.textContent = "Finding location...";
  citySearchButton.disabled = true;
  const city = cities.find((candidate) => candidate.name.toLocaleLowerCase() === requestedCity)
    ?? (citySuggestionQuery === requestedCity ? suggestedCities[0] : null)
    ?? await findCity(requestedCity);
  citySearchButton.disabled = false;
  if (!city) {
    citySearchMessage.textContent = "Location not found. Check the spelling and try again.";
    return;
  }
  citySearchMessage.textContent = "";
  hideCityResults();
  focusCity(city);
});

cityInput.addEventListener("input", () => {
  const query = cityInput.value.trim();
  window.clearTimeout(citySuggestionTimer);
  citySuggestionQuery = "";
  if (!query) {
    hideCityResults();
    if (selectedCity) closeCity();
    return;
  }
  citySuggestionTimer = window.setTimeout(() => updateCitySuggestions(query), 180);
});

cityResults.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-result-index]");
  if (!button) return;
  const city = suggestedCities[Number(button.dataset.resultIndex)];
  if (!city) return;
  cityInput.value = city.name;
  citySearchMessage.textContent = "";
  hideCityResults();
  focusCity(city);
});

document.addEventListener("pointerdown", (event) => {
  if (!citySearch.contains(event.target)) hideCityResults();
});

locationClose.addEventListener("click", closeCity);

canvas.addEventListener("pointerdown", (event) => {
  pointerDown = true;
  previousPointerX = event.clientX;
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", (event) => {
  if (!pointerDown) return;
  const delta = event.clientX - previousPointerX;
  previousPointerX = event.clientX;
  root.rotation.y += delta * 0.006;
  targetRotation = null;
});

canvas.addEventListener("pointerup", () => {
  pointerDown = false;
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  updateLocationPanelPosition();
});

async function setWeatherSource(mode) {
  const request = mode;
  textureStatus.textContent = mode === "synthetic" ? "Synthetic demo" : "Loading forecast pipeline...";
  try {
    if (mode === "synthetic") throw new Error("Synthetic demo selected");
    const pipeline = mode === "graphcast-era5t"
      ? await loadEra5tGraphCastForecast()
      : await loadPipelineForecast();
    if (request !== requestedWeatherSource) return;
    activatePipeline(pipeline, mode === "graphcast-era5t" ? {
      mode: "graphcast-era5t",
      label: "GraphCast Small — ERA5T",
      status: "ERA5T source data from July 4, 2026.",
      cityNote: "GraphCast Small forecast using ERA5T source data from July 4, 2026",
    } : undefined);
  } catch (error) {
    if (request !== requestedWeatherSource) return;
    console.warn("Forecast pipeline could not load", error);
    if (mode === "auto") {
      activateSynthetic();
      textureStatus.textContent = "Pipeline unavailable; using synthetic demo.";
    } else if (mode === "synthetic") {
      activateSynthetic();
    } else {
      activateUnavailablePipeline(mode === "graphcast-era5t" ? {
        label: "GraphCast Small — ERA5T unavailable",
        message: "GraphCast Small — ERA5T assets could not be loaded.",
        status: "GraphCast Small — ERA5T source data could not be loaded.",
      } : undefined);
    }
  }
}

async function loadPipelineForecast() {
  const { catalog, catalogUrl } = await loadForecastCatalog();
  const model = catalog.models?.[0];
  if (!model?.latestManifestPath) throw new Error("Forecast catalog has no model manifest");
  const { manifest, manifestUrl } = await loadForecastManifest(model, catalogUrl);
  if (!manifest.uiSurface?.pathTemplate || !manifest.leadTimesHours?.length) {
    throw new Error("Forecast manifest has no numeric UI surface");
  }
  const surface = await loadPipelineSurfaceFrame(0, manifest, manifestUrl);
  return { manifest, model, manifestUrl, surface };
}

async function loadEra5tGraphCastForecast() {
  const catalogUrl = new URL("./forecasts/era5t-graphcast-small/catalog.json", window.location.href);
  const { catalog } = await loadForecastCatalog(catalogUrl);
  const model = catalog.models?.find((candidate) => candidate.id === "google-graphcast-small");
  if (!model?.latestManifestPath) throw new Error("ERA5T GraphCast catalog has no model manifest");
  const { manifest, manifestUrl } = await loadForecastManifest(model, catalogUrl);
  const leadTimes = manifest.leadTimesHours;
  if (!manifest.uiSurface?.pathTemplate || !Array.isArray(leadTimes) || !leadTimes.length
    || leadTimes.some((leadHours) => !Number.isFinite(leadHours))) {
    throw new Error("ERA5T GraphCast manifest has no valid forecast lead times");
  }
  const cache = new Map();
  const surfaces = await Promise.all(leadTimes.map((leadHours, index) => (
    loadPipelineSurfaceFrame(index, manifest, manifestUrl, cache).catch((error) => {
      throw new Error(`ERA5T GraphCast frame t+${leadHours}.json could not load: ${error.message}`);
    })
  )));
  return { manifest, model, manifestUrl, surface: surfaces[0], surfaces };
}

async function loadForecastCatalog(catalogUrl = new URL("./forecasts/catalog.json", window.location.href)) {
  return { catalog: await fetchJson(catalogUrl), catalogUrl };
}

async function loadForecastManifest(model, catalogUrl) {
  const latestUrl = new URL(model.latestManifestPath, catalogUrl);
  let manifest = await fetchJson(latestUrl);
  let manifestUrl = latestUrl;
  if (manifest.manifestPath) {
    manifestUrl = new URL(manifest.manifestPath, latestUrl);
    manifest = await fetchJson(manifestUrl);
  }
  return { manifest, manifestUrl };
}

function resolveManifestAssetPath(manifestUrl, pathTemplate, leadHours) {
  const path = pathTemplate.replaceAll("{leadHours}", String(leadHours));
  return new URL(path, new URL(".", manifestUrl));
}

function loadPipelineSurfaceFrame(frameIndex, manifest = pipelineManifest, manifestUrl = pipelineManifest?._url, cache = pipelineSurfaceCache) {
  const cached = cache.get(frameIndex);
  if (cached) return cached instanceof Promise ? cached : Promise.resolve(cached);
  const leadHours = manifest?.leadTimesHours?.[frameIndex];
  if (leadHours === undefined) return Promise.reject(new Error("Unknown forecast lead time"));
  const url = resolveManifestAssetPath(manifestUrl, manifest.uiSurface.pathTemplate, leadHours);
  const request = fetchJson(url).then((surface) => {
    if (!surface.grid || !surface.fields) throw new Error("UI surface is incomplete");
    cache.set(frameIndex, surface);
    return surface;
  });
  cache.set(frameIndex, request);
  return request;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url.pathname}`);
  return response.json();
}

function samplePipelineForecast(lon, lat, frameIndex) {
  const surface = pipelineSurfaceCache.get(frameIndex);
  if (!surface || surface instanceof Promise) return { temperature: null, rain: null, pressure: null, windU: null, windV: null };
  return {
    temperature: samplePipelineField(surface, "temperature", lon, lat),
    rain: samplePipelineField(surface, "rain", lon, lat),
    pressure: samplePipelineField(surface, "pressure", lon, lat),
    windU: samplePipelineField(surface, "windU", lon, lat),
    windV: samplePipelineField(surface, "windV", lon, lat),
  };
}

function samplePipelineField(surface, fieldName, lon, lat) {
  const values = surface.fields?.[fieldName];
  const grid = surface.grid;
  if (!values || !grid) return null;
  const [lonMin, lonMax] = grid.longitudeRange;
  const [latTop, latBottom] = grid.latitudeRange;
  const wrappedLon = wrapLon(lon);
  const x = ((wrappedLon - lonMin) / (lonMax - lonMin)) * (grid.width - 1);
  const y = ((clamp(lat, Math.min(latTop, latBottom), Math.max(latTop, latBottom)) - latTop) / (latBottom - latTop)) * (grid.height - 1);
  const x0 = clamp(Math.floor(x), 0, grid.width - 1);
  const x1 = clamp(x0 + 1, 0, grid.width - 1);
  const y0 = clamp(Math.floor(y), 0, grid.height - 1);
  const y1 = clamp(y0 + 1, 0, grid.height - 1);
  const cells = [values[y0 * grid.width + x0], values[y0 * grid.width + x1], values[y1 * grid.width + x0], values[y1 * grid.width + x1]];
  if (cells.some((value) => value === null || !Number.isFinite(value))) return null;
  const tx = x - x0;
  const ty = y - y0;
  return (cells[0] * (1 - tx) + cells[1] * tx) * (1 - ty) + (cells[2] * (1 - tx) + cells[3] * tx) * ty;
}

function makePipelineForecastFrame(frameIndex) {
  const surface = pipelineSurfaceCache.get(frameIndex);
  if (!surface || surface instanceof Promise) return null;
  return Object.fromEntries(Object.keys(surface.fields).map((field) => [field, makePipelineScalarTexture(surface, field)]));
}

function makePipelineScalarTexture(surface, fieldName) {
  const { width, height } = surface.grid;
  const values = surface.fields[fieldName];
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === null || !Number.isFinite(value)) continue;
    let color = [190, 226, 255]; let alpha = 0;
    if (fieldName === "temperature") { color = temperatureColor(value); alpha = 68; }
    else if (fieldName === "rain") {
      // Values remain the pipeline's six-hour accumulations. Only the hue is
      // classified into human-readable meteorological intensity bands.
      const intensity = clamp(value / 20, 0, 1);
      color = pipelineRainColor(value);
      alpha = rainAlpha(intensity);
    }
    else if (fieldName === "pressure") { color = interpolateStops([[69, 126, 255], [133, 215, 231], [250, 241, 183], [255, 145, 101]], clamp((value - 970) / 75, 0, 1)); alpha = 126; }
    else if (fieldName === "moisture") alpha = Math.round(clamp(value, 0, 1) ** 1.9 * 132);
    const pixel = index * 4;
    pixels[pixel] = color[0]; pixels[pixel + 1] = color[1]; pixels[pixel + 2] = color[2]; pixels[pixel + 3] = alpha;
  }
  const context = createCanvas(width, height);
  context.putImageData(new ImageData(pixels, width, height), 0, 0);
  const texture = new THREE.CanvasTexture(context.canvas);
  texture.encoding = THREE.sRGBEncoding;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function activatePipeline({ manifest, model, manifestUrl, surface, surfaces }, source = {}) {
  activeWeatherSource = source.mode ?? "pipeline";
  weatherVisible = true;
  setControlState(weatherToggle, true, "Forecast layers on");
  pipelineManifest = manifest;
  pipelineManifest._url = manifestUrl;
  pipelineManifest._source = source;
  pipelineSurfaceCache.clear();
  if (surfaces) surfaces.forEach((frame, index) => pipelineSurfaceCache.set(index, frame));
  else pipelineSurfaceCache.set(0, surface);
  forecastFrames = manifest.leadTimesHours.map((leadHours, index) => ({
    index,
    leadHours,
    validTime: new Date(new Date(manifest.initializationTime).getTime() + leadHours * 3_600_000),
  }));
  updateTimelineBounds();
  buildPipelineLayers(surface);
  buildLayerControls(pipelineLayerControls(surface), "pipeline");
  forecastSourceLabel.textContent = source.label ?? "Numeric pipeline sample";
  textureStatus.textContent = source.status ?? "GraphCast Small sample data, not live operational weather.";
  updateFrame(0);
}

function activateSynthetic() {
  activeWeatherSource = "synthetic";
  pipelineManifest = null;
  forecastFrames = Array.from({ length: 9 }, (_, index) => ({
    index, leadHours: index * 6, validTime: new Date(forecastStart.getTime() + index * 6 * 3_600_000),
  }));
  updateTimelineBounds();
  pipelineLayers.forEach((mesh) => { mesh.visible = false; });
  buildLayerControls([
    { id: "temperature", label: "Temperature" }, { id: "rain", label: "Rain" },
    { id: "moisture", label: "Moisture" }, { id: "pressure", label: "Pressure" }, { id: "wind", label: "Wind" },
  ], "synthetic");
  forecastSourceLabel.textContent = "Synthetic demo";
  if (requestedWeatherSource === "synthetic") textureStatus.textContent = "Synthetic demo";
  updateFrame(0);
}

function updateTimelineBounds() {
  const firstFrame = forecastFrames[0];
  const lastFrame = forecastFrames.at(-1);
  slider.min = "0";
  slider.max = String(Math.max(0, forecastFrames.length - 1));
  slider.disabled = forecastFrames.length <= 1;
  timelineStart.textContent = firstFrame ? `${firstFrame.leadHours}h` : "--";
  timelineEnd.textContent = lastFrame ? `${lastFrame.leadHours}h` : "--";
  const intermediateFrames = forecastFrames.slice(1, -1);
  const tickCount = Math.min(3, intermediateFrames.length);
  const tickFrames = Array.from({ length: tickCount }, (_, index) => (
    intermediateFrames[Math.floor(((index + 1) * (intermediateFrames.length + 1)) / (tickCount + 1)) - 1]
  ));
  timelineTicks.replaceChildren(...tickFrames.map((frame) => {
    const tick = document.createElement("span");
    tick.textContent = `${frame.leadHours}h`;
    return tick;
  }));
}

function setControlState(control, isActive, description) {
  control.classList.toggle("is-active", isActive);
  control.setAttribute("aria-pressed", String(isActive));
  control.setAttribute("aria-label", description);
  control.title = description;
}

function activateUnavailablePipeline(source = {}) {
  activeWeatherSource = "pipeline-unavailable";
  pipelineManifest = null;
  pipelineLayers.forEach((mesh) => { mesh.visible = false; });
  Object.values(forecastLayers).forEach((layer) => { layer.visible = false; });
  Object.values(transitionLayers).forEach((layer) => { layer.mesh.visible = false; });
  layerControls.replaceChildren();
  layerInputs = [];
  updateActiveLayerLegend();
  slider.disabled = true;
  forecastSourceLabel.textContent = source.label ?? "Real pipeline unavailable";
  label.textContent = "--";
  timeLabel.textContent = source.message ?? "Published forecast assets could not be loaded.";
  textureStatus.textContent = source.status ?? "Real pipeline mode requires numeric UI-surface JSON in ./forecasts/.";
}

function buildLayerControls(layers, source) {
  layerControls.replaceChildren();
  layerInputs = layers.map((layer, index) => {
    const labelElement = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.layer = layer.id;
    input.checked = index < 2;
    input.addEventListener("change", setLayerVisibility);
    labelElement.append(input, ` ${layer.label}`);
    layerControls.append(labelElement);
    return input;
  });
  setLayerVisibility();
}

function pipelineLayerControls(surface) {
  const fields = surface.fields;
  return [
    fields.temperature && { id: "temperature", label: "Temperature" },
    fields.rain && { id: "rain", label: "Rain" },
    fields.pressure && { id: "pressure", label: "Pressure" },
    fields.windU && fields.windV && { id: "wind", label: "Wind" },
    fields.moisture && { id: "moisture", label: "Moisture" },
  ].filter(Boolean);
}

function isNumericPipelineSource() {
  return activeWeatherSource === "pipeline" || activeWeatherSource === "graphcast-era5t";
}

function buildPipelineLayers(surface) {
  pipelineLayers.forEach((mesh) => {
    root.remove(mesh);
    mesh.material.map?.dispose();
    mesh.material.dispose();
  });
  pipelineLayers.clear();
  ["temperature", "rain", "pressure", "moisture"].filter((field) => surface.fields[field]).forEach((field, index) => {
    const material = new THREE.MeshBasicMaterial({
      map: makePipelineScalarTexture(surface, field), transparent: true,
      opacity: field === "rain" ? 0.72 : field === "pressure" ? 0.58 : 0.42, depthWrite: false,
    });
    const mesh = makeEarthLayer(1.568 + index * 0.012, material);
    // The Google mosaic is transparent, so distance-based transparent sorting
    // can otherwise paint it after the forecast. Keep pipeline surfaces above it.
    mesh.renderOrder = 10 + index;
    mesh.visible = false;
    root.add(mesh);
    pipelineLayers.set(field, mesh);
  });
}

function applyPipelineFrame(index) {
  activeFrame = index;
  updateForecastReadout(index);
  setLayerVisibility();
  loadPipelineSurfaceFrame(index).then((surface) => {
    if (!isNumericPipelineSource() || activeFrame !== index) return;
    ["temperature", "rain", "pressure", "moisture"].forEach((field) => {
      const mesh = pipelineLayers.get(field);
      if (mesh && surface.fields[field]) {
        const previous = mesh.material.map;
        mesh.material.map = makePipelineScalarTexture(surface, field);
        mesh.material.needsUpdate = true;
        previous?.dispose();
      }
    });
    if (selectedCity) updateLocationForecast(selectedCity, forecastFrames[index]);
  }).catch(() => {
    textureStatus.textContent = activeWeatherSource === "graphcast-era5t"
      ? `GraphCast Small — ERA5T frame t+${forecastFrames[index].leadHours}.json could not be loaded.`
      : "Selected pipeline frame could not load.";
  });
}


const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const delta = clock.getDelta();
  frameTimer += delta;

  if (isPlaying) {
    if (frameTransition) {
      frameTransition.progress = Math.min(1, frameTransition.progress + delta / 0.75);
      updateTransitionOpacity(frameTransition.progress);
      if (frameTransition.progress === 1) {
        applyFrameTextures(frameTransition.index, frameTransition.syntheticFrame);
        frameTransition = null;
      }
    } else if (forecastFrames.length > 1 && frameTimer > 0.35) {
      queueFrameTransition((activeFrame + 1) % forecastFrames.length);
      frameTimer = 0;
    }
  }

  if (targetRotation) {
    root.rotation.x = dampAngle(root.rotation.x, targetRotation.x, delta, 4.6);
    root.rotation.y = dampAngle(root.rotation.y, targetRotation.y, delta, 4.6);
    if (
      Math.abs(THREE.MathUtils.euclideanModulo(targetRotation.x - root.rotation.x + Math.PI, Math.PI * 2) - Math.PI) < 0.001
      && Math.abs(THREE.MathUtils.euclideanModulo(targetRotation.y - root.rotation.y + Math.PI, Math.PI * 2) - Math.PI) < 0.001
    ) {
      targetRotation = null;
    }
  } else if (!pointerDown && !selectedCity && earthRotationEnabled) {
    root.rotation.y += delta * 0.07;
  }
  camera.position.lerp(targetCameraPosition, 1 - Math.exp(-4.2 * delta));
  camera.fov += (targetCameraFov - camera.fov) * (1 - Math.exp(-4.2 * delta));
  camera.updateProjectionMatrix();
  camera.lookAt(0, 0, 0);
  advectWindStreamlines(delta);
  updateLighting();
  updateLocationPanelPosition();
  renderer.render(scene, camera);
});

function updateFrame(index) {
  activeFrame = index;
  frameTransition = null;
  frameTransitionRequest++;
  updateForecastReadout(index);
  if (isNumericPipelineSource()) {
    applyPipelineFrame(index);
    return;
  }
  const cachedFrame = syntheticFrameCache.get(index);
  if (cachedFrame) {
    applyFrameTextures(index, cachedFrame);
    return;
  }

  const requestId = frameTransitionRequest;
  requestSyntheticFrame(index).then((syntheticFrame) => {
    if (requestId !== frameTransitionRequest || activeFrame !== index || frameTransition) return;
    applyFrameTextures(index, syntheticFrame);
  });
}

function updateForecastReadout(index) {
  const frame = forecastFrames[index];
  slider.value = String(index);
  label.textContent = `T+${String(frame.leadHours).padStart(2, "0")}h`;
  if (isNumericPipelineSource()) {
    const initialization = new Date(pipelineManifest.initializationTime).toUTCString().replace(":00 GMT", " UTC");
    timeLabel.textContent = activeWeatherSource === "graphcast-era5t"
      ? `Initialized ${initialization} · Valid ${frame.validTime.toUTCString().replace(":00 GMT", " UTC")}`
      : `${pipelineManifest.model?.displayName ?? "Forecast pipeline"} sample demo, initialized ${initialization}, T+${frame.leadHours}h`;
  } else {
    timeLabel.textContent = frame.validTime.toUTCString().replace(":00 GMT", " UTC");
  }
  updateLighting();
  if (selectedCity) updateLocationForecast(selectedCity, frame);
}

function applyFrameTextures(index, syntheticFrame = getSyntheticFrame(index)) {
  forecastTextureLayers.forEach((layer) => {
    const material = forecastLayers[layer].material;
    material.map = syntheticFrame[layer];
    material.opacity = transitionLayers[layer].baseOpacity;
    material.needsUpdate = true;
    transitionLayers[layer].material.opacity = 0;
  });
  prewarmForecastFrame((index + 1) % forecastFrames.length);
}

function prewarmForecastFrame(index) {
  if (syntheticFrameCache.has(index) || syntheticFrameRequests.has(index)) return;
  const build = () => requestSyntheticFrame(index);
  if (forecastWorker) {
    build();
    return;
  }

  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(build, { timeout: 900 });
  } else {
    window.setTimeout(build, 120);
  }
}

function queueFrameTransition(index) {
  if (isNumericPipelineSource()) {
    activeFrame = index;
    updateForecastReadout(index);
    applyPipelineFrame(index);
    return;
  }
  const requestId = ++frameTransitionRequest;
  const cachedFrame = syntheticFrameCache.get(index);
  if (cachedFrame) {
    beginFrameTransition(index, cachedFrame);
    return;
  }

  requestSyntheticFrame(index).then((syntheticFrame) => {
    if (requestId !== frameTransitionRequest || !isPlaying || frameTransition) return;
    beginFrameTransition(index, syntheticFrame);
  });
}

function beginFrameTransition(index, syntheticFrame) {
  forecastTextureLayers.forEach((layer) => {
    transitionLayers[layer].material.map = syntheticFrame[layer];
    transitionLayers[layer].material.opacity = 0;
    transitionLayers[layer].material.needsUpdate = true;
  });
  activeFrame = index;
  updateForecastReadout(index);
  frameTransition = { index, syntheticFrame, progress: 0 };
}

function updateTransitionOpacity(progress) {
  forecastTextureLayers.forEach((layer) => {
    const transition = transitionLayers[layer];
    forecastLayers[layer].material.opacity = transition.baseOpacity * (1 - progress);
    transition.material.opacity = transition.baseOpacity * progress;
  });
}

function makeTransitionLayers() {
  const layers = {};
  const definitions = [
    ["temperature", temperatureMaterial, 1.568],
    ["rain", rainMaterial, 1.58],
    ["moisture", moistureMaterial, 1.593],
    ["pressure", pressureMaterial, 1.606],
  ];
  definitions.forEach(([name, sourceMaterial, radius]) => {
    const material = sourceMaterial.clone();
    material.opacity = 0;
    material.depthWrite = false;
    const mesh = makeEarthLayer(radius + 0.0015, material);
    mesh.renderOrder = 20 + Object.keys(layers).length;
    root.add(mesh);
    layers[name] = { mesh, material, baseOpacity: sourceMaterial.opacity };
  });
  return layers;
}

function setLayerVisibility() {
  // Reset every forecast mesh first. A prior numeric-pipeline selection leaves
  // pipeline meshes in the scene, so per-control updates alone can otherwise
  // leave a synthetic or transition texture visible after its checkbox is off.
  Object.values(forecastLayers).forEach((layer) => { layer.visible = false; });
  pipelineLayers.forEach((mesh) => { mesh.visible = false; });
  Object.values(transitionLayers).forEach((layer) => { layer.mesh.visible = false; });

  layerInputs.forEach((input) => {
    if (input.dataset.layer === "wind") {
      forecastLayers.wind.visible = (isNumericPipelineSource() || activeWeatherSource === "synthetic") && weatherVisible && input.checked;
      return;
    }
    const pipelineLayer = pipelineLayers.get(input.dataset.layer);
    if (pipelineLayer) {
      pipelineLayer.visible = isNumericPipelineSource() && weatherVisible && input.checked;
      return;
    }
    forecastLayers[input.dataset.layer].visible = activeWeatherSource === "synthetic" && weatherVisible && input.checked;
    if (transitionLayers[input.dataset.layer]) {
      transitionLayers[input.dataset.layer].mesh.visible = activeWeatherSource === "synthetic" && weatherVisible && input.checked;
    }
  });
  updateActiveLayerLegend();
}

const layerLegendDefinitions = {
  temperature: {
    title: "Temperature (°C)",
    entries: [["#406fff", "Below 0°"], ["#5fd3ff", "0–10°"], ["#7ef4c2", "10–20°"], ["#ffe672", "20–30°"], ["#ff6f54", "30°+"]],
  },
  rain: {
    title: "6 h precipitation (mm)",
    entries: [["#0948b2", "0.1–1 light"], ["#008450", "1–5"], ["#3eb029", "5–15 moderate"], ["#ebbe0a", "15–30 heavy"], ["#9414a5", "30+ very heavy"]],
  },
  pressure: {
    title: "Pressure (hPa)",
    entries: [["#457eff", "970 low"], ["#85d7e7", "995"], ["#faf1b7", "1020"], ["#ff9165", "1045 high"]],
  },
  wind: {
    title: "10 m wind", entries: [["#8bffd6", "Streamline direction"], ["#dff", "Faster motion = stronger wind"]],
  },
  moisture: { title: "Moisture", entries: [["#bee2ff", "Higher moisture"]] },
};

function updateActiveLayerLegend() {
  const activeLayers = weatherVisible
    ? layerInputs.filter((input) => input.checked && layerLegendDefinitions[input.dataset.layer])
    : [];
  activeLayerLegend.hidden = activeLayers.length === 0;
  activeLayerLegend.replaceChildren();
  if (!activeLayers.length) return;

  const heading = document.createElement("h2");
  heading.textContent = "Active layer legend";
  activeLayerLegend.append(heading);
  activeLayers.forEach((input) => {
    const definition = layerLegendDefinitions[input.dataset.layer];
    const title = document.createElement("h3");
    title.textContent = definition.title;
    const list = document.createElement("ul");
    definition.entries.forEach(([color, label]) => {
      const item = document.createElement("li");
      const swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.style.setProperty("--legend-color", color);
      item.append(swatch, label);
      list.append(item);
    });
    activeLayerLegend.append(title, list);
  });
}

function updateLighting() {
  if (!dayNightEnabled) {
    sun.position.set(3.6, 2.2, 4.5);
    sun.intensity = 2.7;
    ambientLight.intensity = 0.62;
    cityLightMaterial.uniforms.strength.value = 0;
    return;
  }

  const sunPosition = solarPosition(forecastFrames[activeFrame].validTime);
  const localSun = lonLatToVector3(sunPosition.lon, sunPosition.lat, 12);
  root.updateMatrixWorld();
  root.localToWorld(localSun);
  sun.position.copy(localSun);
  sun.intensity = 3.15;
  ambientLight.intensity = 0.14;
  cityLightMaterial.uniforms.sunDirection.value.copy(localSun).normalize();
  cityLightMaterial.uniforms.strength.value = 1;
}

function solarPosition(time) {
  const yearStart = Date.UTC(time.getUTCFullYear(), 0, 0);
  const dayOfYear = (time.getTime() - yearStart) / 86_400_000;
  const utcHours = time.getUTCHours() + time.getUTCMinutes() / 60;
  const latitude = -23.44 * Math.cos((Math.PI * 2 * (dayOfYear + 10)) / 365.25);
  const longitude = wrapLon((12 - utcHours) * 15);
  return { lat: latitude, lon: longitude };
}

function hasMapTilesKey() {
  return typeof mapTilesConfig.apiKey === "string" && mapTilesConfig.apiKey.trim().length > 0;
}

async function getMapTileSession() {
  if (mapTileSession) return mapTileSession;
  const apiKey = mapTilesConfig.apiKey.trim();
  const response = await fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mapType: "satellite",
      language: mapTilesConfig.language || "en-US",
      region: mapTilesConfig.region || "US",
      scale: "scaleFactor1x",
    }),
  });
  if (!response.ok) throw new Error(`Map Tiles session failed (${response.status})`);
  const payload = await response.json();
  if (!payload.session) throw new Error("Map Tiles session token was not returned");
  mapTileSession = payload.session;
  return mapTileSession;
}

async function loadRegionalImagery(city) {
  const requestId = ++regionalImageryRequest;
  clearRegionalImagery();
  if (!hasMapTilesKey()) {
    textureStatus.textContent = "City view loaded. Add a Map Tiles API key in config.js for regional satellite detail.";
    return;
  }

  textureStatus.textContent = `Loading regional satellite imagery for ${city.name}...`;
  try {
    const session = await getMapTileSession();
    if (requestId !== regionalImageryRequest || selectedCity !== city) return;

    // This is a fixed, non-explorable city view. Three zoom-6 tiles across
    // cover roughly 1,900 km, matching the closer camera while retaining the
    // same 9-tile request budget.
    const zoom = 6;
    const radius = 1;
    const worldTiles = 2 ** zoom;
    const centerX = Math.floor(longitudeToTileX(city.lon, zoom));
    const centerY = Math.floor(latitudeToTileY(city.lat, zoom));
    const startX = centerX - radius;
    const endX = centerX + radius;
    const startY = Math.max(0, centerY - radius);
    const endY = Math.min(worldTiles - 1, centerY + radius);
    const jobs = [];
    for (let y = startY; y <= endY; y++) {
      for (let x = startX; x <= endX; x++) {
        const wrappedX = ((x % worldTiles) + worldTiles) % worldTiles;
        jobs.push(loadMapTile(wrappedX, y, zoom, session).then((texture) => ({ x, y, texture })));
      }
    }

    const tiles = await Promise.allSettled(jobs);
    if (requestId !== regionalImageryRequest || selectedCity !== city) return;
    const loadedTiles = tiles
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    const loaded = loadedTiles.length;
    if (loaded) {
      regionalImagery.add(makeRegionalMosaicPatch(loadedTiles, startX, startY, endX, endY, zoom));
    }
    regionalImagery.visible = loaded > 0;
    mapAttribution.hidden = loaded === 0;
    textureStatus.textContent = loaded > 0
      ? `Regional satellite imagery loaded for ${city.name} (${loaded}/${jobs.length} tiles)`
      : `Regional satellite imagery could not be loaded (0/${jobs.length} tiles). Check the Map Tiles API key restriction and quota.`;
  } catch (error) {
    if (requestId !== regionalImageryRequest) return;
    console.warn("Regional map imagery could not load", error);
    textureStatus.textContent = "Regional satellite imagery is unavailable. The globe view is still active.";
  }
}

function clearRegionalImagery() {
  while (regionalImagery.children.length) {
    const mesh = regionalImagery.children[0];
    regionalImagery.remove(mesh);
    mesh.geometry.dispose();
    if (mesh.material.map?.userData?.regionalMosaic) mesh.material.map.dispose();
    mesh.material.dispose();
  }
  regionalImagery.visible = false;
  mapAttribution.hidden = true;
}

async function loadMapTile(x, y, zoom, session) {
  const cacheKey = `${zoom}/${x}/${y}`;
  let texture = regionalImageryCache.get(cacheKey);
  if (!texture) {
    const apiKey = encodeURIComponent(mapTilesConfig.apiKey.trim());
    const url = `https://tile.googleapis.com/v1/2dtiles/${zoom}/${x}/${y}?session=${encodeURIComponent(session)}&key=${apiKey}`;
    texture = await new Promise((resolve, reject) => {
      textureLoader.load(url, resolve, undefined, reject);
    });
    texture.colorSpace = THREE.SRGBColorSpace || texture.colorSpace;
    regionalImageryCache.set(cacheKey, texture);
  }
  return texture;
}

function makeRegionalMosaicPatch(loadedTiles, startX, startY, endX, endY, zoom) {
  const tilesWide = endX - startX + 1;
  const tilesHigh = endY - startY + 1;
  const tileWidth = loadedTiles[0].texture.image.width;
  const tileHeight = loadedTiles[0].texture.image.height;
  const context = createCanvas(tilesWide * tileWidth, tilesHigh * tileHeight);
  loadedTiles.forEach(({ x, y, texture }) => {
    context.drawImage(texture.image, (x - startX) * tileWidth, (y - startY) * tileHeight, tileWidth, tileHeight);
  });

  const mosaicTexture = new THREE.CanvasTexture(context.canvas);
  mosaicTexture.encoding = THREE.sRGBEncoding;
  mosaicTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  mosaicTexture.userData.regionalMosaic = true;

  // One continuous curved mesh avoids seams and missing-looking individual
  // tile cards. The vertical vertices follow Web Mercator latitude exactly.
  const segments = Math.max(48, tilesWide * 12);
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let row = 0; row <= segments; row++) {
    const tileY = startY + (row / segments) * tilesHigh;
    const latitude = tileYToLatitude(tileY, zoom);
    for (let column = 0; column <= segments; column++) {
      const tileX = startX + (column / segments) * tilesWide;
      const longitude = tileXToLongitude(tileX, zoom);
      const point = lonLatToVector3(longitude, latitude, 1.557);
      positions.push(point.x, point.y, point.z);
      uvs.push(column / segments, 1 - row / segments);
    }
  }
  for (let row = 0; row < segments; row++) {
    for (let column = 0; column < segments; column++) {
      const topLeft = row * (segments + 1) + column;
      const bottomLeft = topLeft + segments + 1;
      indices.push(topLeft, bottomLeft, topLeft + 1, topLeft + 1, bottomLeft, bottomLeft + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = makeRegionalTileMaterial(mosaicTexture);
  const mesh = new THREE.Mesh(geometry, material);
  // Draw the satellite imagery after the opaque Earth but before forecast data.
  mesh.renderOrder = 1;
  return mesh;
}

function makeRegionalTileMaterial(texture) {
  return new THREE.MeshBasicMaterial({
    map: texture,
    // Missing source tiles remain transparent, revealing the base globe rather
    // than rendering as black rectangles. There is only one mosaic mesh, so
    // transparent ordering cannot create inter-tile seams.
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function longitudeToTileX(longitude, zoom) {
  return ((longitude + 180) / 360) * (2 ** zoom);
}

function latitudeToTileY(latitude, zoom) {
  const clipped = THREE.MathUtils.clamp(latitude, -85.05112878, 85.05112878);
  const radians = THREE.MathUtils.degToRad(clipped);
  return (1 - Math.asinh(Math.tan(radians)) / Math.PI) * 0.5 * (2 ** zoom);
}

function tileXToLongitude(tileX, zoom) {
  return tileX / (2 ** zoom) * 360 - 180;
}

function tileYToLatitude(tileY, zoom) {
  const mercatorY = Math.PI - (2 * Math.PI * tileY) / (2 ** zoom);
  return THREE.MathUtils.radToDeg(Math.atan(Math.sinh(mercatorY)));
}

function focusCity(city) {
  selectedCity = city;
  stars.visible = false;
  citySuggestionRequest++;
  citySuggestionQuery = "";
  suggestedCities = [];
  hideCityResults();
  // City selection changes the camera only. The selected pipeline timeline
  // should keep playing unless the user explicitly pauses it.
  targetCameraPosition.copy(cityCameraPosition);
  targetCameraFov = cityCameraFov;
  targetRotation = {
    x: THREE.MathUtils.degToRad(city.lat),
    y: -Math.PI / 2 - THREE.MathUtils.degToRad(city.lon),
  };
  locationMarker.position.copy(lonLatToVector3(city.lon, city.lat, 1.64));
  locationMarker.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    locationMarker.position.clone().normalize(),
  );
  locationMarker.visible = true;
  locationName.textContent = city.name;
  locationCoordinates.textContent = `${formatLatitude(city.lat)}, ${formatLongitude(city.lon)} · ${city.country}`;
  locationPanel.hidden = false;
  updateLocationForecast(city, forecastFrames[activeFrame]);
  loadRegionalImagery(city);
  requestAnimationFrame(() => requestAnimationFrame(updateLocationPanelPosition));
}

function closeCity() {
  selectedCity = null;
  regionalImageryRequest++;
  targetRotation = { ...baseRotation };
  targetCameraPosition.copy(baseCameraPosition);
  targetCameraFov = baseCameraFov;
  clearRegionalImagery();
  locationMarker.visible = false;
  locationPanel.hidden = true;
  locationLeader.hidden = true;
  stars.visible = true;
  hideCityResults();
  cityInput.value = "";
  citySearchMessage.textContent = "";
  isPlaying = true;
  setControlState(playToggle, true, "Weather timeline playing");
}

function updateLocationPanelPosition() {
  if (!selectedCity || locationPanel.hidden) {
    locationLeader.hidden = true;
    return;
  }

  const markerPosition = projectWorldPosition(locationMarker.getWorldPosition(new THREE.Vector3()));
  const earthCircle = getEarthScreenCircle();
  const panelWidth = locationPanel.offsetWidth;
  const panelHeight = locationPanel.offsetHeight;
  const markerClearance = 52;
  let directionX = markerPosition.x - earthCircle.x;
  let directionY = markerPosition.y - earthCircle.y;
  const markerDistance = Math.hypot(directionX, directionY);
  if (markerDistance < 1) {
    directionX = 0.7;
    directionY = -0.7;
  } else {
    directionX /= markerDistance;
    directionY /= markerDistance;
  }

  const preferredAngle = Math.atan2(directionY, directionX);
  const panelPosition = chooseLocationPanelPosition({
    earthCircle,
    markerClearance,
    markerPosition,
    panelHeight,
    panelWidth,
    preferredAngle,
  });
  const { left: panelLeft, top: panelTop } = panelPosition;

  const leaderStartDistance = Math.min(markerDistance, earthCircle.radius - 8);
  const lineStartX = earthCircle.x + directionX * leaderStartDistance;
  const lineStartY = earthCircle.y + directionY * leaderStartDistance;
  const lineEndX = clamp(lineStartX, panelLeft, panelLeft + panelWidth);
  const lineEndY = clamp(lineStartY, panelTop, panelTop + panelHeight);
  const lineLength = Math.hypot(lineEndX - lineStartX, lineEndY - lineStartY);
  const lineAngle = Math.atan2(lineEndY - lineStartY, lineEndX - lineStartX);

  locationPanel.style.left = `${panelLeft}px`;
  locationPanel.style.top = `${panelTop}px`;
  locationLeader.hidden = false;
  locationLeader.style.left = `${lineStartX}px`;
  locationLeader.style.top = `${lineStartY}px`;
  locationLeader.style.width = `${lineLength}px`;
  locationLeader.style.transform = `rotate(${lineAngle}rad)`;
}

function distanceToRectangle(x, y, left, top, width, height) {
  const nearestX = clamp(x, left, left + width);
  const nearestY = clamp(y, top, top + height);
  return Math.hypot(x - nearestX, y - nearestY);
}

function chooseLocationPanelPosition({
  earthCircle,
  markerClearance,
  markerPosition,
  panelHeight,
  panelWidth,
  preferredAngle,
}) {
  const panelHalfWidth = panelWidth * 0.5;
  const panelHalfHeight = panelHeight * 0.5;
  const earthInset = 18;
  const halfDiagonal = Math.hypot(panelHalfWidth, panelHalfHeight);
  const safeCenterRadius = Math.max(0, earthCircle.radius - halfDiagonal - earthInset);
  const markerGap = markerClearance + 8;
  const primarySide = markerPosition.x >= earthCircle.x ? "left" : "right";
  const secondarySide = primarySide === "left" ? "right" : "left";
  const primaryVertical = markerPosition.y >= earthCircle.y ? "above" : "below";
  const secondaryVertical = primaryVertical === "above" ? "below" : "above";
  const candidates = [];

  const addRect = (left, top, priority) => {
    candidates.push({ left, top, priority });
  };

  const sideLeft = markerPosition.x - panelWidth - markerGap;
  const sideRight = markerPosition.x + markerGap;
  const sideTop = markerPosition.y - panelHalfHeight;
  const aboveTop = markerPosition.y - panelHeight - markerGap;
  const belowTop = markerPosition.y + markerGap;
  const centerLeft = markerPosition.x - panelHalfWidth;
  const sidePositions = {
    left: sideLeft,
    right: sideRight,
    above: aboveTop,
    below: belowTop,
  };

  addRect(sidePositions[primarySide], sideTop, 0);
  addRect(sidePositions[primarySide], primaryVertical === "above" ? aboveTop : belowTop, 0.2);
  addRect(sidePositions[primarySide], primaryVertical === "above" ? belowTop : aboveTop, 0.4);
  addRect(sidePositions[secondarySide], sideTop, 1);
  addRect(sidePositions[secondarySide], primaryVertical === "above" ? aboveTop : belowTop, 1.2);
  addRect(sidePositions[secondarySide], primaryVertical === "above" ? belowTop : aboveTop, 1.4);
  addRect(centerLeft, sidePositions[primaryVertical], 2);
  addRect(centerLeft, sidePositions[secondaryVertical], 2.4);

  const sweepSteps = 32;
  [safeCenterRadius, safeCenterRadius * 0.78, safeCenterRadius * 0.56, safeCenterRadius * 0.34].forEach((radius, ringIndex) => {
    for (let index = 0; index < sweepSteps; index++) {
      const angle = preferredAngle + (Math.PI * 2 * index) / sweepSteps;
      const centerX = earthCircle.x + Math.cos(angle) * radius;
      const centerY = earthCircle.y + Math.sin(angle) * radius;
      addRect(centerX - panelHalfWidth, centerY - panelHalfHeight, 4 + ringIndex);
    }
  });

  const scored = candidates.map((candidate) => {
    const clearance = distanceToRectangle(markerPosition.x, markerPosition.y, candidate.left, candidate.top, panelWidth, panelHeight);
    const centerX = candidate.left + panelHalfWidth;
    const centerY = candidate.top + panelHalfHeight;
    const centerDistance = Math.hypot(centerX - markerPosition.x, centerY - markerPosition.y);
    const earthOverflow = getRectEarthOverflow(candidate.left, candidate.top, panelWidth, panelHeight, earthCircle, earthInset);
    const markerOverlap = Math.max(0, markerClearance - clearance);
    return {
      left: candidate.left,
      top: candidate.top,
      clearance,
      earthOverflow,
      markerOverlap,
      score:
        candidate.priority * 1000
        + markerOverlap * 500
        + earthOverflow * 300
        + centerDistance * 0.4,
    };
  });

  const validCandidates = scored
    .filter((candidate) => candidate.earthOverflow === 0 && candidate.markerOverlap === 0)
    .sort((a, b) => a.score - b.score);
  if (validCandidates[0]) return validCandidates[0];

  return scored.sort((a, b) => {
    if (a.markerOverlap !== b.markerOverlap) return a.markerOverlap - b.markerOverlap;
    if (a.earthOverflow !== b.earthOverflow) return a.earthOverflow - b.earthOverflow;
    return a.score - b.score;
  })[0];
}

function getRectEarthOverflow(left, top, width, height, earthCircle, inset) {
  const allowedRadius = earthCircle.radius - inset;
  return Math.max(
    0,
    ...[
      [left, top],
      [left + width, top],
      [left, top + height],
      [left + width, top + height],
    ].map(([x, y]) => {
      return Math.hypot(x - earthCircle.x, y - earthCircle.y) - allowedRadius;
    }),
  );
}

function projectWorldPosition(worldPosition) {
  const bounds = canvas.getBoundingClientRect();
  const projected = worldPosition.project(camera);
  return {
    x: bounds.left + (projected.x * 0.5 + 0.5) * bounds.width,
    y: bounds.top + (-projected.y * 0.5 + 0.5) * bounds.height,
  };
}

function getEarthScreenCircle() {
  root.updateMatrixWorld();
  const center = projectWorldPosition(root.localToWorld(new THREE.Vector3()));
  const radius = Math.max(
    ...[
      new THREE.Vector3(1.55, 0, 0), new THREE.Vector3(-1.55, 0, 0),
      new THREE.Vector3(0, 1.55, 0), new THREE.Vector3(0, -1.55, 0),
      new THREE.Vector3(0, 0, 1.55), new THREE.Vector3(0, 0, -1.55),
    ].map((point) => {
      const edge = projectWorldPosition(root.localToWorld(point));
      return Math.hypot(edge.x - center.x, edge.y - center.y);
    }),
  );
  return { ...center, radius };
}

function updateLocationForecast(city, frame) {
  if (isNumericPipelineSource()) {
    const output = samplePipelineForecast(city.lon, city.lat, frame.index);
    locationTemperature.textContent = output.temperature === null ? "Unavailable" : `${output.temperature.toFixed(1)} °C`;
    const windSpeed = output.windU === null || output.windV === null ? null : Math.hypot(output.windU, output.windV);
    locationWind.textContent = windSpeed === null ? "Unavailable" : `${(windSpeed * 3.6).toFixed(1)} km/h`;
    locationPrecipitation.textContent = output.rain === null ? "Unavailable" : `${output.rain.toFixed(1)} mm`;
    locationModelNote.textContent = pipelineManifest._source?.cityNote ?? "GraphCast Small sample data, not live operational weather";
    return;
  }
  const output = sampleForecast(city.lon, city.lat, frame.index);
  const wind = Math.round(Math.hypot(output.windU, output.windV));
  locationTemperature.textContent = `${output.temperature.toFixed(1)} °C`;
  locationWind.textContent = `${wind} km/h`;
  locationPrecipitation.textContent = `${output.rain.toFixed(1)} mm`;
  locationModelNote.textContent = "Illustrative forecast values for this MVP";
}

async function findCity(query) {
  const matches = await findCities(query, 1);
  return matches[0] ?? null;
}

async function findCities(query, count = 6) {
  try {
    const response = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=${count}&language=en&format=json`,
    );
    if (!response.ok) return [];
    return ((await response.json()).results ?? []).map((result) => ({
      name: result.name,
      area: result.admin1 ?? result.admin2 ?? "",
      country: result.country ?? "Selected location",
      lat: result.latitude,
      lon: result.longitude,
      ...makeSyntheticBaseline(result.latitude, result.longitude),
    }));
  } catch {
    return [];
  }
}

async function updateCitySuggestions(query) {
  const requestId = ++citySuggestionRequest;
  const normalizedQuery = query.toLocaleLowerCase();
  const localMatches = cities
    .filter((city) => city.name.toLocaleLowerCase().includes(normalizedQuery))
    .slice(0, 6);
  const remoteMatches = query.length >= 2 ? await findCities(query, 6) : [];
  if (requestId !== citySuggestionRequest || cityInput.value.trim() !== query) return;
  if (selectedCity && normalizedQuery === selectedCity.name.toLocaleLowerCase()) {
    hideCityResults();
    return;
  }

  const seen = new Set();
  suggestedCities = [...localMatches, ...remoteMatches].filter((city) => {
    const key = `${city.name}|${city.country}|${city.lat.toFixed(3)}|${city.lon.toFixed(3)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 7);
  citySuggestionQuery = normalizedQuery;
  renderCitySuggestions();
}

function renderCitySuggestions() {
  cityResults.replaceChildren();
  suggestedCities.forEach((city, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.resultIndex = String(index);
    button.setAttribute("role", "option");
    const name = document.createElement("strong");
    name.textContent = city.name;
    const context = document.createElement("span");
    context.textContent = [city.area, city.country].filter(Boolean).join(", ");
    button.append(name, context);
    cityResults.append(button);
  });
  cityResults.hidden = suggestedCities.length === 0;
  cityInput.setAttribute("aria-expanded", String(suggestedCities.length > 0));
}

function hideCityResults() {
  cityResults.hidden = true;
  cityInput.setAttribute("aria-expanded", "false");
}

function makeSyntheticBaseline(lat, lon) {
  const latitudeFactor = Math.abs(lat) / 90;
  return {
    temp: Math.round(30 - latitudeFactor * 25 + Math.sin(THREE.MathUtils.degToRad(lon)) * 3),
    wind: Math.round(10 + latitudeFactor * 13 + Math.abs(Math.cos(THREE.MathUtils.degToRad(lon))) * 5),
    rain: Math.max(0, Math.round((5 - latitudeFactor * 4 + Math.sin(THREE.MathUtils.degToRad(lat + lon)) * 3) * 10) / 10),
  };
}

function lonLatToVector3(lon, lat, radius) {
  const lonRadians = THREE.MathUtils.degToRad(lon);
  const latRadians = THREE.MathUtils.degToRad(lat);
  return new THREE.Vector3(
    Math.cos(latRadians) * Math.cos(lonRadians) * radius,
    Math.sin(latRadians) * radius,
    -Math.cos(latRadians) * Math.sin(lonRadians) * radius,
  );
}

function makeLocationMarker() {
  const marker = new THREE.Group();
  const shadow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: makeMarkerShadowTexture(),
      transparent: true,
      depthWrite: false,
    }),
  );
  // City view is deliberately close to the globe, so keep the marker compact
  // enough to identify the location without covering the local weather field.
  shadow.scale.set(0.042, 0.042, 1);
  marker.add(shadow);

  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.006, 24, 24),
    new THREE.MeshBasicMaterial({ color: 0xf7fbff }),
  );
  marker.add(dot);

  const ring = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: makeMarkerTexture(),
      transparent: true,
      depthWrite: false,
    }),
  );
  ring.scale.set(0.04, 0.04, 1);
  marker.add(ring);
  return marker;
}

function makeMarkerTexture() {
  const ctx = createCanvas(128, 128);
  const gradient = ctx.createRadialGradient(64, 64, 5, 64, 64, 58);
  gradient.addColorStop(0, "rgba(139,255,214,0)");
  gradient.addColorStop(0.28, "rgba(139,255,214,0)");
  gradient.addColorStop(0.36, "rgba(139,255,214,0.98)");
  gradient.addColorStop(0.43, "rgba(139,255,214,0.46)");
  gradient.addColorStop(0.64, "rgba(139,255,214,0.16)");
  gradient.addColorStop(1, "rgba(139,255,214,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(ctx.canvas);
}

function makeMarkerShadowTexture() {
  const ctx = createCanvas(128, 128);
  const gradient = ctx.createRadialGradient(64, 64, 8, 64, 64, 56);
  gradient.addColorStop(0, "rgba(0,0,0,0.62)");
  gradient.addColorStop(0.42, "rgba(0,0,0,0.28)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(ctx.canvas);
}

function dampAngle(current, target, delta, speed) {
  const difference = THREE.MathUtils.euclideanModulo(target - current + Math.PI, Math.PI * 2) - Math.PI;
  return current + difference * (1 - Math.exp(-speed * delta));
}

function formatLatitude(value) {
  return `${Math.abs(value).toFixed(1)}° ${value >= 0 ? "N" : "S"}`;
}

function formatLongitude(value) {
  return `${Math.abs(value).toFixed(1)}° ${value >= 0 ? "E" : "W"}`;
}

function loadRemoteTexture(url, onLoad, onError) {
  loadTexture(textureLoader, url, onLoad, onError);
}

function loadLocalTexture(url, onLoad, onError) {
  loadTexture(localTextureLoader, url, onLoad, onError);
}

function loadTexture(loader, url, onLoad, onError) {
  loader.load(
    url,
    (texture) => {
      texture.encoding = THREE.sRGBEncoding;
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      onLoad(texture);
    },
    undefined,
    () => {
      console.warn(`Could not load texture: ${url}`);
      onError?.();
      if (url.includes("earth_atmos") && !onError) {
        textureStatus.textContent = "Offline fallback map active";
      }
    },
  );
}

function makeSimplifiedEarthTexture() {
  const width = 2048;
  const height = 1024;
  const ctx = createCanvas(width, height);

  const ocean = ctx.createLinearGradient(0, 0, 0, height);
  ocean.addColorStop(0, "#19467b");
  ocean.addColorStop(0.52, "#0c346b");
  ocean.addColorStop(1, "#071d3e");
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, width, height);

  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  drawGraticule(ctx, width, height);
  drawLand(ctx, width, height, landPolygons());
  drawCoastGlow(ctx, width, height, landPolygons());

  const image = ctx.canvas;
  const texture = new THREE.CanvasTexture(image);
  texture.encoding = THREE.sRGBEncoding;
  texture.anisotropy = 8;
  return texture;
}

function makeCityLightMaterial(cityLightTexture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      cityLights: { value: cityLightTexture },
      sunDirection: { value: new THREE.Vector3(0, 0, 1) },
      strength: { value: 1 },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      void main() {
        vUv = uv;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D cityLights;
      uniform vec3 sunDirection;
      uniform float strength;
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      void main() {
        vec4 lights = texture2D(cityLights, vUv);
        float daylight = dot(normalize(vWorldNormal), normalize(sunDirection));
        float night = 1.0 - smoothstep(-0.12, 0.28, daylight);
        float luminance = dot(lights.rgb, vec3(0.2126, 0.7152, 0.0722));
        float signal = smoothstep(0.025, 0.18, luminance);
        gl_FragColor = vec4(lights.rgb * signal * night * strength, signal * night * strength);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

function makeCityLightTexture() {
  const width = 2048;
  const height = 1024;
  const ctx = createCanvas(width, height);
  const locations = [
    [-74.006, 40.713, 1.0], [-118.244, 34.052, 0.9], [-87.630, 41.878, 0.84],
    [-122.419, 37.775, 0.8], [-80.192, 25.762, 0.72], [-99.133, 19.433, 0.75],
    [-46.633, -23.551, 0.82], [-0.128, 51.507, 0.94], [2.352, 48.857, 0.88],
    [13.405, 52.52, 0.8], [12.496, 41.903, 0.72], [-3.704, 40.417, 0.67],
    [4.904, 52.367, 0.66], [31.236, 30.044, 0.8], [28.979, 41.008, 0.77],
    [55.271, 25.205, 0.75], [72.878, 19.076, 0.94], [77.103, 28.704, 0.88],
    [88.363, 22.572, 0.78], [103.820, 1.352, 0.76], [100.502, 13.756, 0.72],
    [106.846, -6.209, 0.86], [114.169, 22.319, 0.82], [121.474, 31.23, 0.96],
    [116.407, 39.904, 0.94], [126.978, 37.566, 0.82], [139.65, 35.676, 1.0],
    [151.209, -33.869, 0.82], [144.963, -37.814, 0.76], [174.764, -36.851, 0.68],
    [18.424, -33.925, 0.65], [36.822, -1.292, 0.62], [3.379, 6.524, 0.7],
    [-43.173, -22.907, 0.7], [-58.381, -34.603, 0.72], [-70.669, -33.449, 0.62],
    [-79.519, 43.653, 0.67], [-123.121, 49.282, 0.64], [-157.858, 21.307, 0.58],
  ];

  ctx.globalCompositeOperation = "lighter";
  locations.forEach(([lon, lat, intensity], locationIndex) => {
    const count = Math.round(8 + intensity * 26);
    for (let pointIndex = 0; pointIndex < count; pointIndex++) {
      const seed = Math.sin((locationIndex + 1) * 127.1 + (pointIndex + 1) * 311.7) * 43_758.5453;
      const angle = (seed - Math.floor(seed)) * Math.PI * 2;
      const spread = Math.pow(Math.sin(seed * 2.3) * 0.5 + 0.5, 1.9) * (0.45 + intensity * 1.9);
      const pointLon = lon + Math.cos(angle) * spread;
      const pointLat = lat + Math.sin(angle) * spread * 0.54;
      const [x, y] = projectLonLat(pointLon, pointLat, width, height);
      const radius = 1 + (pointIndex % 3) * 0.55;
      const alpha = 0.2 + intensity * (0.18 + (pointIndex % 5) * 0.08);
      ctx.fillStyle = `rgba(255, ${185 + (pointIndex % 4) * 12}, 94, ${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  const texture = new THREE.CanvasTexture(ctx.canvas);
  texture.encoding = THREE.sRGBEncoding;
  texture.anisotropy = 8;
  return texture;
}

function drawGraticule(ctx, width, height) {
  ctx.strokeStyle = "rgba(255,255,255,0.035)";
  ctx.lineWidth = 1;
  for (let lon = -180; lon <= 180; lon += 30) {
    ctx.beginPath();
    const x = ((lon + 180) / 360) * width;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    ctx.beginPath();
    const y = ((90 - lat) / 180) * height;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
}

function drawLand(ctx, width, height, polygons) {
  for (const polygon of polygons) {
    ctx.beginPath();
    polygon.forEach(([lon, lat], index) => {
      const [x, y] = projectLonLat(lon, lat, width, height);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();

  const bounds = polygon.reduce(
      (acc, [, lat]) => [Math.min(acc[0], lat), Math.max(acc[1], lat)],
      [90, -90],
    );
    const isIce = bounds[0] < -62 || bounds[0] > 55;
    const fill = ctx.createLinearGradient(0, 0, width, height);
    if (isIce) {
      fill.addColorStop(0, "#f3f7f2");
      fill.addColorStop(1, "#cfdfe6");
    } else {
      fill.addColorStop(0, "#8da66a");
      fill.addColorStop(0.46, "#53784a");
      fill.addColorStop(1, "#b99561");
    }
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = "rgba(226,242,222,0.28)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawCoastGlow(ctx, width, height, polygons) {
  ctx.save();
  ctx.strokeStyle = "rgba(155,218,205,0.18)";
  ctx.lineWidth = 6;
  for (const polygon of polygons) {
    ctx.beginPath();
    polygon.forEach(([lon, lat], index) => {
      const [x, y] = projectLonLat(lon, lat, width, height);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

function projectLonLat(lon, lat, width, height) {
  return [((lon + 180) / 360) * width, ((90 - lat) / 180) * height];
}

function landPolygons() {
  return [
    [
      [-168, 71], [-156, 58], [-141, 60], [-134, 54], [-127, 50], [-124, 43], [-117, 33],
      [-111, 28], [-105, 23], [-97, 19], [-90, 21], [-83, 25], [-80, 31], [-75, 39],
      [-66, 45], [-60, 52], [-53, 58], [-57, 64], [-70, 68], [-88, 73], [-112, 74],
      [-132, 71], [-150, 72],
    ],
    [
      [-101, 21], [-94, 18], [-89, 17], [-84, 13], [-81, 9], [-77, 8], [-76, 6],
      [-81, 7], [-86, 10], [-91, 14], [-99, 16],
    ],
    [
      [-82, 12], [-74, 11], [-66, 7], [-58, -1], [-50, -7], [-43, -16], [-39, -23],
      [-45, -33], [-53, -46], [-64, -55], [-72, -50], [-75, -39], [-79, -25],
      [-81, -12], [-78, -2],
    ],
    [
      [-73, 60], [-58, 59], [-43, 64], [-25, 73], [-32, 81], [-52, 83], [-68, 78],
      [-75, 69],
    ],
    [
      [-11, 36], [-8, 50], [-24, 64], [-9, 70], [18, 71], [39, 65], [62, 66],
      [91, 76], [125, 72], [160, 61], [178, 55], [168, 46], [145, 42], [128, 35],
      [121, 25], [108, 20], [103, 9], [96, 14], [88, 22], [80, 8], [72, 20],
      [64, 26], [53, 24], [45, 13], [37, 30], [27, 36], [12, 37], [4, 43],
    ],
    [
      [30, 31], [38, 28], [50, 17], [55, 13], [49, 23], [42, 31],
    ],
    [
      [68, 24], [78, 24], [88, 20], [80, 8], [73, 8], [68, 18],
    ],
    [
      [96, 20], [106, 18], [109, 10], [104, 1], [99, 7],
    ],
    [
      [-17, 36], [0, 37], [16, 34], [31, 30], [40, 15], [51, 10], [44, -12],
      [35, -24], [29, -31], [19, -35], [8, -34], [-6, -26], [-13, -12], [-17, 5],
    ],
    [
      [43, -12], [50, -16], [50, -25], [45, -26], [43, -19],
    ],
    [
      [113, -11], [131, -11], [146, -18], [154, -29], [145, -39], [129, -35],
      [115, -31], [112, -21],
    ],
    [
      [166, -34], [178, -38], [174, -46], [166, -45],
    ],
    [
      [-8, 58], [2, 59], [1, 51], [-6, 50],
    ],
    [
      [130, 34], [143, 42], [146, 36], [139, 31],
    ],
    [
      [-180, -66], [-150, -70], [-120, -72], [-90, -68], [-60, -71], [-30, -69],
      [0, -72], [30, -69], [60, -71], [90, -68], [120, -72], [150, -69], [180, -66],
      [180, -90], [-180, -90],
    ],
  ];
}

function createForecastWorker() {
  if (!("Worker" in window) || !("Blob" in window) || !window.URL?.createObjectURL) return null;

  const workerSource = `
    const modelGrid = ${JSON.stringify(modelGrid)};

    self.onmessage = (event) => {
      const { id, frameIndex } = event.data;
      try {
        const frame = makeForecastFramePixels(frameIndex);
        self.postMessage(
          { id, frameIndex, frame },
          Object.values(frame).map((pixels) => pixels.buffer),
        );
      } catch (error) {
        self.postMessage({
          id,
          frameIndex,
          error: error?.message ?? String(error),
        });
      }
    };

    ${makeForecastFramePixels.toString()}
    ${makeScalarPixels.toString()}
    ${forecastSystems.toString()}
    ${forecastRainClouds.toString()}
    ${sampleForecast.toString()}
    ${influence.toString()}
    ${ellipticalInfluence.toString()}
    ${precipitationClimateBias.toString()}
    ${convectiveCell.toString()}
    ${temperatureColor.toString()}
    ${rainColor.toString()}
    ${rainAlpha.toString()}
    ${interpolateStops.toString()}
    ${clamp.toString()}
    ${degToRad.toString()}
    ${wrapLon.toString()}
  `;

  try {
    const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    const worker = new Worker(workerUrl);

    worker.addEventListener("message", (event) => {
      const request = workerFrameRequests.get(event.data.id);
      if (!request) return;
      workerFrameRequests.delete(event.data.id);
      request.resolve(event.data);
    });

    worker.addEventListener("error", (event) => {
      console.warn("Forecast worker error", event.message);
      forecastWorker = null;
      workerFrameRequests.forEach((request) => request.resolve({
        frameIndex: request.frameIndex,
        error: event.message || "Worker error",
      }));
      workerFrameRequests.clear();
    });

    return worker;
  } catch (error) {
    console.warn("Forecast worker could not start", error);
    return null;
  }
}

function getSyntheticFrame(frameIndex) {
  const cached = syntheticFrameCache.get(frameIndex);
  if (cached) return cached;

  return cacheSyntheticFrame(frameIndex, makeForecastFrame(frameIndex));
}

function requestSyntheticFrame(frameIndex) {
  const cached = syntheticFrameCache.get(frameIndex);
  if (cached) return Promise.resolve(cached);

  const pending = syntheticFrameRequests.get(frameIndex);
  if (pending) return pending;

  if (!forecastWorker) {
    const promise = Promise.resolve().then(() => getSyntheticFrame(frameIndex));
    syntheticFrameRequests.set(frameIndex, promise);
    promise.finally(() => syntheticFrameRequests.delete(frameIndex));
    return promise;
  }

  const requestId = ++syntheticFrameRequestId;
  const promise = new Promise((resolve, reject) => {
    workerFrameRequests.set(requestId, { frameIndex, resolve });
    try {
      forecastWorker.postMessage({ id: requestId, frameIndex });
    } catch (error) {
      workerFrameRequests.delete(requestId);
      reject(error);
    }
  }).then((message) => {
    if (message.error) {
      console.warn(`Forecast worker failed for frame ${frameIndex}: ${message.error}`);
      return getSyntheticFrame(frameIndex);
    }
    return cacheSyntheticFrame(frameIndex, makeForecastFrameFromPixels(message.frame));
  }).catch((error) => {
    console.warn(`Forecast worker unavailable for frame ${frameIndex}`, error);
    forecastWorker = null;
    return getSyntheticFrame(frameIndex);
  }).finally(() => {
    syntheticFrameRequests.delete(frameIndex);
  });

  syntheticFrameRequests.set(frameIndex, promise);
  return promise;
}

function cacheSyntheticFrame(frameIndex, frame) {
  const cached = syntheticFrameCache.get(frameIndex);
  if (cached) {
    disposeForecastFrame(frame);
    return cached;
  }

  syntheticFrameCache.set(frameIndex, frame);
  if (syntheticFrameCache.size > 3) {
    const oldestIndex = syntheticFrameCache.keys().next().value;
    const oldest = syntheticFrameCache.get(oldestIndex);
    disposeForecastFrame(oldest);
    syntheticFrameCache.delete(oldestIndex);
  }
  return frame;
}

function disposeForecastFrame(frame) {
  Object.values(frame).forEach((texture) => texture.dispose());
}

function makeForecastFrame(frameIndex) {
  return {
    temperature: makeScalarTexture(frameIndex, "temperature"),
    rain: makeScalarTexture(frameIndex, "rain"),
    moisture: makeScalarTexture(frameIndex, "moisture"),
    pressure: makeScalarTexture(frameIndex, "pressure"),
  };
}

function makeScalarTexture(frameIndex, layer) {
  return makeTextureFromPixels(makeScalarPixels(frameIndex, layer));
}

function makeForecastFrameFromPixels(framePixels) {
  return {
    temperature: makeTextureFromPixels(framePixels.temperature),
    rain: makeTextureFromPixels(framePixels.rain),
    moisture: makeTextureFromPixels(framePixels.moisture),
    pressure: makeTextureFromPixels(framePixels.pressure),
  };
}

function makeTextureFromPixels(pixels) {
  const { width, height } = modelGrid;
  const ctx = createCanvas(width, height);
  const image = ctx.createImageData(width, height);
  image.data.set(pixels);
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(ctx.canvas);
  texture.encoding = THREE.sRGBEncoding;
  texture.anisotropy = 8;
  return texture;
}

function makeForecastFramePixels(frameIndex) {
  return {
    temperature: makeScalarPixels(frameIndex, "temperature"),
    rain: makeScalarPixels(frameIndex, "rain"),
    moisture: makeScalarPixels(frameIndex, "moisture"),
    pressure: makeScalarPixels(frameIndex, "pressure"),
  };
}

function makeScalarPixels(frameIndex, layer) {
  const { width, height } = modelGrid;
  const data = new Uint8ClampedArray(width * height * 4);
  const systems = forecastSystems(frameIndex);
  const rainClouds = layer === "rain" ? forecastRainClouds(frameIndex) : [];

  for (let y = 0; y < height; y++) {
    const lat = 90 - (y / (height - 1)) * 180;
    for (let x = 0; x < width; x++) {
      const lon = (x / (width - 1)) * 360 - 180;
      const output = sampleForecast(lon, lat, frameIndex, systems, rainClouds);
      const index = (y * width + x) * 4;
      let color;
      let alpha;

      if (layer === "temperature") {
        color = temperatureColor(output.temperature);
        alpha = 68;
      } else if (layer === "rain") {
        const intensity = clamp(output.rain / 20, 0, 1);
        color = rainColor(intensity);
        alpha = rainAlpha(intensity);
      } else if (layer === "moisture") {
        const intensity = clamp(output.moisture, 0, 1);
        color = [190, 226, 255];
        alpha = Math.round(Math.pow(intensity, 1.9) * 132);
      } else {
        const intensity = clamp((output.pressure - 970) / 75, 0, 1);
        color = interpolateStops([[69, 126, 255], [133, 215, 231], [250, 241, 183], [255, 145, 101]], intensity);
        alpha = 126;
      }

      data[index] = color[0];
      data[index + 1] = color[1];
      data[index + 2] = color[2];
      data[index + 3] = alpha;
    }
  }

  return data;
}

function forecastSystems(frameIndex) {
  const phase = frameIndex * 0.28;
  return [
    { kind: "L", lon: wrapLon(-62 + frameIndex * 3.2), lat: 32 + Math.sin(phase) * 4.5, strength: 1 },
    { kind: "L", lon: wrapLon(96 - frameIndex * 2.6), lat: -17 + Math.cos(phase) * 4, strength: 0.75 },
    { kind: "H", lon: wrapLon(21 + frameIndex * 1.5), lat: 47 + Math.cos(phase * 0.7) * 3.5, strength: 0.45 },
  ];
}

function forecastRainClouds(frameIndex) {
  const phase = frameIndex * 0.5;
  return [
    { lon: wrapLon(-72 + frameIndex * 4.8), lat: 39 + Math.sin(phase) * 4, width: 34, height: 5.6, intensity: 9.5, angle: -0.34 },
    { lon: wrapLon(-55 + frameIndex * 4.1), lat: -27 + Math.cos(phase * 0.9) * 4, width: 30, height: 6.2, intensity: 8.4, angle: 0.31 },
    { lon: wrapLon(20 + frameIndex * 5.7), lat: -44 + Math.sin(phase * 0.7) * 3, width: 42, height: 5.2, intensity: 7.2, angle: -0.14 },
    { lon: wrapLon(78 + frameIndex * 2.8), lat: 17 + Math.cos(phase * 0.8) * 4, width: 17, height: 11, intensity: 14.8, angle: 0.12 },
    { lon: wrapLon(126 + frameIndex * 3.7), lat: 8 + Math.sin(phase * 1.3) * 5, width: 15, height: 10, intensity: 16.5, angle: -0.28 },
    { lon: wrapLon(-61 + frameIndex * 2.1), lat: -7 + Math.sin(phase * 0.6) * 4, width: 14, height: 9, intensity: 11.5, angle: 0.2 },
    { lon: wrapLon(102 + frameIndex * 1.9), lat: -3 + Math.cos(phase * 1.1) * 5, width: 13, height: 9, intensity: 12.8, angle: -0.18 },
  ];
}

function sampleForecast(
  lon,
  lat,
  frameIndex,
  systems = forecastSystems(frameIndex),
  rainClouds = forecastRainClouds(frameIndex),
) {
  const phase = frameIndex * 0.28;
  const lowNorthSystem = systems[0];
  const lowTropicalSystem = systems[1];
  const highSystem = systems[2];
  const lowNorth = influence(lon, lat, lowNorthSystem.lon, lowNorthSystem.lat, 26);
  const lowTropical = influence(lon, lat, lowTropicalSystem.lon, lowTropicalSystem.lat, 32);
  const high = influence(lon, lat, highSystem.lon, highSystem.lat, 36);
  const latRadians = degToRad(lat);
  const lonRadians = degToRad(lon);
  const jetNorth = Math.exp(-Math.pow((lat - (42 + Math.sin(lonRadians * 2.1 + phase) * 7)) / 10, 2));
  const jetSouth = Math.exp(-Math.pow((lat + (41 + Math.cos(lonRadians * 1.8 - phase) * 8)) / 11, 2));
  const climate = precipitationClimateBias(lon, lat);
  const tropicalWaveLat = 3.5 + Math.sin(lonRadians * 1.25 + phase * 0.9) * 5.5;
  const tropicalBelt = Math.exp(-Math.pow((lat - tropicalWaveLat) / 8.5, 2));
  const cellular = convectiveCell(lon, lat, phase);
  const rainTexture = 0.58 + 0.42 * cellular;
  const movingRain = rainClouds.reduce((total, cloud) => {
    const core = ellipticalInfluence(lon, lat, cloud);
    const shield = ellipticalInfluence(lon, lat, {
      ...cloud,
      width: cloud.width * 1.8,
      height: cloud.height * 1.75,
    });
    return total + (core * rainTexture + shield * 0.16) * cloud.intensity;
  }, 0);
  const frontalLift = (jetNorth * (0.72 + lowNorth * 1.15) + jetSouth * 0.78)
    * (0.45 + convectiveCell(lon + 8, lat - 3, phase + 0.7) * 0.55);
  const tropicalConvection = tropicalBelt * (0.8 + climate.wet * 0.55) * (0.5 + cellular * 1.15);
  const drySuppression = climate.dry * (7.5 + high * 5.5);
  const moisture = clamp(
    0.16 + climate.wet * 0.34 + tropicalBelt * 0.32 + lowNorth * 0.48 + lowTropical * 0.62
      + jetNorth * 0.18 + jetSouth * 0.16 - high * 0.28 - climate.dry * 0.42
      + (Math.sin(lonRadians * 4 - latRadians * 2 + phase) + 1) * 0.055,
    0,
    1,
  );
  const rain = clamp(
    movingRain + frontalLift * 4.8 + tropicalConvection * 7.2 + climate.orographic * moisture * 5.4
      + lowNorth * 3.8 + lowTropical * 4.2 + (moisture - 0.52) * 7.2 - drySuppression,
    0,
    32,
  );
  const temperature = 29 - Math.abs(lat) * 0.36 + Math.sin(lonRadians * 1.3 + phase) * 4
    - lowNorth * 4 - lowTropical * 2.5 + Math.sin(latRadians * 3 - phase) * 1.6;
  const pressure = 1018 + Math.sin(lonRadians * 1.5 - phase) * 5 + Math.cos(latRadians * 2.5) * 3
    - lowNorth * 34 - lowTropical * 25 + high * 17;
  let windU = (jetNorth - jetSouth) * 38 + Math.cos(latRadians * 3 + phase) * 6;
  let windV = Math.sin(lonRadians * 2 - phase) * 5;

  const northDx = wrapLon(lon - lowNorthSystem.lon);
  const northDy = lat - lowNorthSystem.lat;
  const northDistance = Math.max(8, Math.hypot(northDx, northDy));
  windU += (-northDy / northDistance) * lowNorth * 28;
  windV += (northDx / northDistance) * lowNorth * 28;

  const tropicalDx = wrapLon(lon - lowTropicalSystem.lon);
  const tropicalDy = lat - lowTropicalSystem.lat;
  const tropicalDistance = Math.max(8, Math.hypot(tropicalDx, tropicalDy));
  windU += (-tropicalDy / tropicalDistance) * lowTropical * 28;
  windV += (tropicalDx / tropicalDistance) * lowTropical * 28;

  return { temperature, rain, moisture, pressure, windU, windV };
}

function makeWindStreamlines(count) {
  const seeds = [];
  const positions = new Float32Array(count * 2 * 3);
  const colors = new Float32Array(count * 2 * 3);
  for (let index = 0; index < count; index++) {
    const lon = wrapLon(index * 137.508);
    const lat = -68 + ((index * 47.23) % 136);
    seeds.push({ lon, lat, radius: 1.62 + (index % 5) * 0.004 });
    writeStreamline(index, seeds[index], positions, colors, 0);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const lines = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  return { lines, seeds, positions, colors };
}

function advectWindStreamlines(delta) {
  if (!windStreamlines.lines.visible) return;
  windStreamlines.seeds.forEach((seed, index) => {
    const wind = isNumericPipelineSource()
      ? samplePipelineForecast(seed.lon, seed.lat, activeFrame)
      : sampleForecast(seed.lon, seed.lat, activeFrame);
    if (wind.windU === null || wind.windV === null) return;
    seed.lon = wrapLon(seed.lon + wind.windU * delta * 0.12);
    seed.lat = clamp(seed.lat + wind.windV * delta * 0.1, -78, 78);
    writeStreamline(index, seed, windStreamlines.positions, windStreamlines.colors, activeFrame, wind);
  });
  windStreamlines.lines.geometry.attributes.position.needsUpdate = true;
  windStreamlines.lines.geometry.attributes.color.needsUpdate = true;
}

function writeStreamline(index, seed, positions, colors, frameIndex, wind = sampleForecast(seed.lon, seed.lat, frameIndex)) {
  if (wind.windU === null || wind.windV === null) return;
  const speed = Math.hypot(wind.windU, wind.windV);
  const tailLength = clamp(0.11 + speed * 0.009, 0.12, 0.42);
  const direction = Math.max(1, speed);
  const tailLon = wrapLon(seed.lon - (wind.windU / direction) * tailLength * 16);
  const tailLat = clamp(seed.lat - (wind.windV / direction) * tailLength * 10, -80, 80);
  const tail = lonLatToVector3(tailLon, tailLat, seed.radius);
  const head = lonLatToVector3(seed.lon, seed.lat, seed.radius);
  const offset = index * 6;
  tail.toArray(positions, offset);
  head.toArray(positions, offset + 3);

  const color = windColor(speed);
  colors[offset] = color[0] * 0.18;
  colors[offset + 1] = color[1] * 0.18;
  colors[offset + 2] = color[2] * 0.18;
  colors[offset + 3] = color[0];
  colors[offset + 4] = color[1];
  colors[offset + 5] = color[2];
}

function windColor(speed) {
  return interpolateStops(
    [[92, 191, 255], [107, 255, 207], [255, 224, 87], [255, 89, 66]],
    clamp(speed / 52, 0, 1),
  ).map((channel) => channel / 255);
}

function influence(lon, lat, centerLon, centerLat, radius) {
  const dx = wrapLon(lon - centerLon);
  const dy = lat - centerLat;
  return Math.exp(-(dx * dx + dy * dy) / (radius * radius));
}

function ellipticalInfluence(lon, lat, cloud) {
  const dx = wrapLon(lon - cloud.lon);
  const dy = lat - cloud.lat;
  const cosine = Math.cos(cloud.angle);
  const sine = Math.sin(cloud.angle);
  const rotatedX = dx * cosine + dy * sine;
  const rotatedY = -dx * sine + dy * cosine;
  return Math.exp(-((rotatedX / cloud.width) ** 2 + (rotatedY / cloud.height) ** 2));
}

function precipitationClimateBias(lon, lat) {
  const amazon = ellipticalInfluence(lon, lat, { lon: -62, lat: -5, width: 34, height: 18, angle: 0.12 });
  const maritimeContinent = ellipticalInfluence(lon, lat, { lon: 118, lat: -2, width: 30, height: 15, angle: -0.18 });
  const westPacific = ellipticalInfluence(lon, lat, { lon: 143, lat: 12, width: 32, height: 16, angle: -0.22 });
  const indiaMonsoon = ellipticalInfluence(lon, lat, { lon: 78, lat: 21, width: 20, height: 12, angle: 0.12 });
  const centralAfrica = ellipticalInfluence(lon, lat, { lon: 22, lat: 0, width: 28, height: 14, angle: 0.04 });
  const andes = ellipticalInfluence(lon, lat, { lon: -74, lat: -16, width: 5.5, height: 30, angle: -0.08 });
  const himalaya = ellipticalInfluence(lon, lat, { lon: 86, lat: 29, width: 22, height: 5, angle: 0.08 });
  const pacificNorthwest = ellipticalInfluence(lon, lat, { lon: -126, lat: 48, width: 12, height: 8, angle: -0.22 });
  const sahara = ellipticalInfluence(lon, lat, { lon: 16, lat: 23, width: 43, height: 15, angle: 0.02 });
  const arabia = ellipticalInfluence(lon, lat, { lon: 48, lat: 24, width: 23, height: 11, angle: -0.12 });
  const australia = ellipticalInfluence(lon, lat, { lon: 134, lat: -25, width: 33, height: 17, angle: 0.06 });
  const atacama = ellipticalInfluence(lon, lat, { lon: -70, lat: -24, width: 5, height: 13, angle: -0.04 });
  const southwestUs = ellipticalInfluence(lon, lat, { lon: -112, lat: 34, width: 17, height: 10, angle: 0.1 });

  return {
    wet: clamp(amazon * 0.72 + maritimeContinent * 0.8 + westPacific * 0.62 + indiaMonsoon * 0.58
      + centralAfrica * 0.52 + pacificNorthwest * 0.28, 0, 1.35),
    dry: clamp(sahara * 0.92 + arabia * 0.74 + australia * 0.68 + atacama * 0.9 + southwestUs * 0.34, 0, 1.15),
    orographic: clamp(andes * 0.82 + himalaya * 0.72 + pacificNorthwest * 0.45, 0, 1.15),
  };
}

function convectiveCell(lon, lat, phase) {
  const lonRadians = degToRad(lon);
  const latRadians = degToRad(lat);
  const smallCells = Math.sin(lonRadians * 17.2 + latRadians * 5.3 + phase * 2.7);
  const mediumCells = Math.sin(lonRadians * 8.4 - latRadians * 13.1 - phase * 2.1);
  const streaks = Math.sin((lonRadians + latRadians) * 11.6 + phase * 1.6);
  const blended = (smallCells + mediumCells + streaks) / 3;
  return Math.pow(clamp((blended + 0.74) / 1.74, 0, 1), 2.1);
}

function temperatureColor(value) {
  const stops = [
    [64, 111, 255], [95, 211, 255], [126, 244, 194], [255, 230, 114], [255, 111, 84],
  ];
  return interpolateStops(stops, clamp((value + 12) / 48, 0, 1));
}

function rainColor(value) {
  if (value < 0.12) return [9, 72, 178];
  if (value < 0.25) return [0, 132, 229];
  if (value < 0.4) return [0, 134, 80];
  if (value < 0.55) return [62, 176, 41];
  if (value < 0.7) return [235, 190, 10];
  if (value < 0.82) return [235, 96, 10];
  if (value < 0.92) return [210, 20, 36];
  return [148, 20, 165];
}

function pipelineRainColor(sixHourMillimeters) {
  if (sixHourMillimeters < 1) return [9, 72, 178];
  if (sixHourMillimeters < 5) return [0, 132, 80];
  if (sixHourMillimeters < 15) return [62, 176, 41];
  if (sixHourMillimeters < 30) return [235, 190, 10];
  return [148, 20, 165];
}

function rainAlpha(value) {
  if (value < 0.018) return 0;
  const visibleRain = clamp((value - 0.018) / 0.982, 0, 1);
  return Math.round(26 + Math.pow(visibleRain, 0.62) * 212);
}

function interpolateStops(stops, value) {
  const scaled = value * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const amount = scaled - index;
  return stops[index].map((channel, channelIndex) => Math.round(channel + (stops[index + 1][channelIndex] - channel) * amount));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function degToRad(value) {
  return value * Math.PI / 180;
}

function makeStars() {
  const geometry = new THREE.BufferGeometry();
  const positions = [];

  for (let i = 0; i < 1200; i++) {
    const radius = 20 + Math.random() * 35;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions.push(
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi),
    );
  }

  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({ color: 0xffffff, size: 0.035, transparent: true, opacity: 0.82 }),
  );
}

function createCanvas(width, height) {
  const canvasElement = document.createElement("canvas");
  canvasElement.width = width;
  canvasElement.height = height;
  return canvasElement.getContext("2d", { willReadFrequently: true });
}

function swirl(lon, lat, centerLon, centerLat, scale) {
  const dx = wrapLon(lon - centerLon);
  const dy = lat - centerLat;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const ring = Math.exp(-Math.pow(distance / scale, 2));
  const spiral = 0.5 + 0.5 * Math.sin(Math.atan2(dy, dx) * 4 + distance * 0.35);
  return ring * spiral;
}

function wrapLon(value) {
  return ((value + 540) % 360) - 180;
}

function weatherColor(value) {
  if (value < 0.34) return [30, 121, 230];
  if (value < 0.58) return [58, 220, 160];
  if (value < 0.78) return [220, 246, 91];
  return [255, 120, 80];
}
