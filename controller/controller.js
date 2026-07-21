const protocol = window.DigitalTwinProtocol;
const pairingView = document.querySelector("#pairing-view");
const pairingForm = document.querySelector("#pairing-form");
const pairingCodeInput = document.querySelector("#pairing-code");
const pairingMessage = document.querySelector("#pairing-message");
const controllerUi = document.querySelector("#controller-ui");
const connectionPill = document.querySelector("#connection-pill");
const connectionLabel = connectionPill.querySelector("strong");
const connectionMenu = document.querySelector("#connection-menu");
const disconnectControllerButton = document.querySelector("#disconnect-controller");
const ptzPad = document.querySelector("#ptz-pad");
const ptzKnob = document.querySelector("#ptz-knob");
const zoomIn = document.querySelector("#zoom-in");
const zoomOut = document.querySelector("#zoom-out");
const zoomTrackFill = document.querySelector(".zoom-track i");
const zoomHint = document.querySelector(".zoom-hint");
const controlHint = document.querySelector(".control-hint");
const cameraReset = document.querySelector("#camera-reset");
const cityForm = document.querySelector("#city-search-controller");
const cityInput = document.querySelector("#city-input-controller");
const cityResults = document.querySelector("#city-results-controller");
const cityClear = document.querySelector("#city-clear");
const selectedCity = document.querySelector("#selected-city");
const weatherVisible = document.querySelector("#weather-visible");
const weatherSource = document.querySelector("#weather-source-controller");
const earthStyle = document.querySelector("#earth-style-controller");
const dayNight = document.querySelector("#day-night-controller");
const earthRotation = document.querySelector("#earth-rotation-controller");
const weatherLayers = document.querySelector("#weather-layers-controller");
const timelineCurrent = document.querySelector("#timeline-current");
const timelineFirst = document.querySelector("#timeline-first");
const timelineLast = document.querySelector("#timeline-last");
const timelineSlider = document.querySelector("#timeline-slider-controller");
const timelineDate = document.querySelector("#timeline-date");
const playback = document.querySelector("#playback-controller");

const fragment = new URLSearchParams(window.location.hash.slice(1));
let credentials = fragment.get("pair") ? { pairToken: fragment.get("pair") } : null;
let socket = null;
let paired = false;
let reconnectTimer = null;
let commandId = 0;
let cameraSequence = 0;
let cameraIntent = { pan: 0, tilt: 0, zoom: 0 };
let cameraSendTimer = null;
let currentState = null;
let disconnectingManually = false;

function setConnection(label, mode = "connecting") {
  const connected = mode === "connected";
  connectionLabel.textContent = label;
  connectionPill.classList.toggle("is-connected", connected);
  connectionPill.classList.toggle("is-error", mode === "error");
  connectionPill.disabled = !connected;
  if (!connected) closeConnectionMenu();
}

function closeConnectionMenu() {
  connectionMenu.hidden = true;
  connectionPill.setAttribute("aria-expanded", "false");
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function identify() {
  if (!credentials) {
    pairingView.hidden = false;
    controllerUi.hidden = true;
    setConnection("Enter pairing code");
    return;
  }
  send({ type: "hello", role: protocol.ROLES.CONTROLLER, protocolVersion: protocol.VERSION, ...credentials });
}

function connect() {
  window.clearTimeout(reconnectTimer);
  const socketProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const connectingSocket = new WebSocket(`${socketProtocol}//${window.location.host}/ws`);
  socket = connectingSocket;
  setConnection("Connecting");
  connectingSocket.addEventListener("open", () => { if (socket === connectingSocket) identify(); });
  connectingSocket.addEventListener("message", handleMessage);
  connectingSocket.addEventListener("close", () => {
    if (socket !== connectingSocket) return;
    socket = null;
    const wasManualDisconnect = disconnectingManually;
    disconnectingManually = false;
    paired = false;
    stopCamera();
    controllerUi.hidden = true;
    setConnection("Disconnected", "error");
    if (wasManualDisconnect || !credentials) {
      pairingView.hidden = false;
      return;
    }
    if (credentials) reconnectTimer = window.setTimeout(connect, 1500);
  });
  connectingSocket.addEventListener("error", () => connectingSocket.close());
}

function handleMessage(event) {
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  if (message.type === "session.paired") {
    paired = true;
    pairingView.hidden = true;
    controllerUi.hidden = false;
    setConnection("Globe connected", "connected");
  } else if (message.type === "session.error") {
    credentials = null;
    paired = false;
    pairingView.hidden = false;
    controllerUi.hidden = true;
    pairingMessage.textContent = message.message;
    setConnection("Pairing failed", "error");
  } else if (message.type === "session.ended") {
    setConnection("Globe disconnected", "error");
  } else if (message.type === "state") {
    applyState(message.state);
  }
}

function sendCommand(command) {
  if (!paired) return;
  send({ type: "command", id: ++commandId, command });
}

connectionPill.addEventListener("click", () => {
  if (!paired) return;
  const willOpen = connectionMenu.hidden;
  connectionMenu.hidden = !willOpen;
  connectionPill.setAttribute("aria-expanded", String(willOpen));
});

disconnectControllerButton.addEventListener("click", () => {
  disconnectingManually = true;
  window.clearTimeout(reconnectTimer);
  stopCamera();
  paired = false;
  credentials = null;
  currentState = null;
  closeConnectionMenu();
  controllerUi.hidden = true;
  pairingView.hidden = false;
  pairingCodeInput.value = "";
  pairingMessage.textContent = "Disconnected. Enter the code shown on the globe to reconnect.";
  setConnection("Disconnected", "error");
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
    socket.close(1000, "Controller disconnected");
  } else {
    disconnectingManually = false;
    socket = null;
  }
});

document.addEventListener("pointerdown", (event) => {
  if (!connectionMenu.hidden && !event.target.closest(".connection-control")) closeConnectionMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeConnectionMenu();
});

pairingForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const pairCode = pairingCodeInput.value.replace(/\D/g, "");
  if (pairCode.length !== 6) {
    pairingMessage.textContent = "Enter all six digits shown on the globe.";
    return;
  }
  credentials = { pairCode };
  pairingMessage.textContent = "Connecting…";
  if (socket?.readyState === WebSocket.OPEN) identify();
  else connect();
});

function sendCameraIntent() {
  sendCommand(protocol.makeCameraInput(cameraIntent.pan, cameraIntent.tilt, cameraIntent.zoom, ++cameraSequence));
}

function startCameraTimer() {
  if (!cameraSendTimer) cameraSendTimer = window.setInterval(sendCameraIntent, 33);
  sendCameraIntent();
}

function stopCameraTimerIfIdle() {
  if (cameraIntent.pan || cameraIntent.tilt || cameraIntent.zoom) return;
  window.clearInterval(cameraSendTimer);
  cameraSendTimer = null;
  sendCameraIntent();
}

function updatePad(event) {
  const bounds = ptzPad.getBoundingClientRect();
  const radius = bounds.width * 0.38;
  let x = event.clientX - (bounds.left + bounds.width / 2);
  let y = event.clientY - (bounds.top + bounds.height / 2);
  const distance = Math.hypot(x, y);
  if (distance > radius) {
    x *= radius / distance;
    y *= radius / distance;
  }
  const deadZone = 0.055;
  cameraIntent.pan = Math.abs(x / radius) < deadZone ? 0 : x / radius;
  cameraIntent.tilt = Math.abs(y / radius) < deadZone ? 0 : y / radius;
  ptzKnob.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
}

ptzPad.addEventListener("pointerdown", (event) => {
  ptzPad.setPointerCapture(event.pointerId);
  ptzPad.classList.add("is-active");
  controlHint.textContent = "Navigating…";
  updatePad(event);
  startCameraTimer();
});
ptzPad.addEventListener("pointermove", (event) => {
  if (!ptzPad.hasPointerCapture(event.pointerId)) return;
  updatePad(event);
});
ptzPad.addEventListener("pointerup", stopPad);
ptzPad.addEventListener("pointercancel", stopPad);

function stopPad(event) {
  if (event?.pointerId !== undefined) ptzPad.releasePointerCapture?.(event.pointerId);
  cameraIntent.pan = 0;
  cameraIntent.tilt = 0;
  ptzPad.classList.remove("is-active");
  controlHint.textContent = "Hold & drag to pan · tilt";
  ptzKnob.style.transform = "translate(-50%, -50%)";
  stopCameraTimerIfIdle();
}

function bindZoomButton(button, value) {
  button.addEventListener("pointerdown", (event) => {
    button.setPointerCapture(event.pointerId);
    button.classList.add("is-active");
    zoomTrackFill.style.width = value > 0 ? "82%" : "18%";
    zoomHint.textContent = value > 0 ? "In" : "Out";
    cameraIntent.zoom = value;
    startCameraTimer();
  });
  const stop = () => {
    button.classList.remove("is-active");
    zoomTrackFill.style.width = "50%";
    zoomHint.textContent = "Hold";
    cameraIntent.zoom = 0;
    stopCameraTimerIfIdle();
  };
  button.addEventListener("pointerup", stop);
  button.addEventListener("pointercancel", stop);
  button.addEventListener("lostpointercapture", stop);
}

bindZoomButton(zoomIn, 1);
bindZoomButton(zoomOut, -1);

function stopCamera() {
  cameraIntent = { pan: 0, tilt: 0, zoom: 0 };
  ptzPad.classList.remove("is-active");
  controlHint.textContent = "Hold & drag to pan · tilt";
  zoomIn.classList.remove("is-active");
  zoomOut.classList.remove("is-active");
  zoomTrackFill.style.width = "50%";
  zoomHint.textContent = "Hold";
  ptzKnob.style.transform = "translate(-50%, -50%)";
  window.clearInterval(cameraSendTimer);
  cameraSendTimer = null;
  if (paired) sendCameraIntent();
}

document.addEventListener("visibilitychange", () => { if (document.hidden) stopCamera(); });
cameraReset.addEventListener("click", () => sendCommand({ type: protocol.COMMANDS.CAMERA_RESET }));

cityForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = cityInput.value.trim();
  if (!query) return;
  cityResults.hidden = false;
  cityResults.textContent = "Searching…";
  try {
    const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=en&format=json`);
    if (!response.ok) throw new Error("Search failed");
    const data = await response.json();
    renderCityResults((data.results || []).map((city) => ({
      name: city.name,
      country: city.country || "",
      area: city.admin1 || "",
      lat: city.latitude,
      lon: city.longitude,
    })));
  } catch {
    cityResults.textContent = "City search is unavailable. Check the network and try again.";
  }
});

function renderCityResults(results) {
  cityResults.replaceChildren();
  if (!results.length) {
    cityResults.textContent = "No matching places found.";
    return;
  }
  results.forEach((city) => {
    const button = document.createElement("button");
    button.type = "button";
    const name = document.createElement("strong");
    name.textContent = city.name;
    const context = document.createElement("span");
    context.textContent = [city.area, city.country].filter(Boolean).join(", ");
    button.append(name, context);
    button.addEventListener("click", () => {
      sendCommand({ type: protocol.COMMANDS.CITY_SELECT, city });
      cityResults.hidden = true;
      cityInput.value = city.name;
    });
    cityResults.append(button);
  });
}

cityClear.addEventListener("click", () => {
  cityInput.value = "";
  cityResults.hidden = true;
  sendCommand({ type: protocol.COMMANDS.CITY_CLEAR });
});
weatherVisible.addEventListener("click", () => sendCommand({ type: protocol.COMMANDS.WEATHER_VISIBLE_SET, visible: !currentState?.weather.visible }));
weatherSource.addEventListener("change", () => sendCommand({ type: protocol.COMMANDS.WEATHER_SOURCE_SET, source: weatherSource.value }));
earthStyle.addEventListener("change", () => sendCommand({ type: protocol.COMMANDS.EARTH_STYLE_SET, style: earthStyle.value }));
dayNight.addEventListener("click", () => sendCommand({ type: protocol.COMMANDS.EARTH_DAY_NIGHT_SET, enabled: !currentState?.earth.dayNight }));
earthRotation.addEventListener("click", () => sendCommand({ type: protocol.COMMANDS.EARTH_ROTATION_SET, rotating: !currentState?.earth.rotating }));
playback.addEventListener("click", () => sendCommand({ type: protocol.COMMANDS.PLAYBACK_SET, playing: !currentState?.playback.playing }));
timelineSlider.addEventListener("input", () => sendCommand({ type: protocol.COMMANDS.TIMELINE_FRAME_SET, frame: Number(timelineSlider.value) }));

function syncOptions(select, options, value) {
  const signature = JSON.stringify(options);
  if (select.dataset.options !== signature) {
    select.replaceChildren(...options.map((option) => {
      const element = document.createElement("option");
      element.value = option.id;
      element.textContent = option.label;
      return element;
    }));
    select.dataset.options = signature;
  }
  select.value = value;
}

function makeLayerIcon(layerId) {
  const icons = {
    temperature: '<path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>',
    rain: '<path d="M20 17.58A5 5 0 0 0 18 8h-1.26A8 8 0 1 0 4 16.25"/><path d="M8 16v5M12 14v7M16 16v5"/>',
    pressure: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
    wind: '<path d="M9.59 4.59A2 2 0 1 1 11 8H3M12.59 19.41A2 2 0 1 0 14 16H3M6.59 11.59A2 2 0 1 1 8 15H3"/>',
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = icons[layerId] || icons.wind;
  return svg;
}

function applyState(state) {
  if (!state || (currentState && state.revision <= currentState.revision)) return;
  currentState = state;
  syncOptions(weatherSource, state.capabilities.weatherSources, state.weather.requestedSource);
  syncOptions(earthStyle, state.capabilities.earthStyles, state.earth.style);

  weatherVisible.querySelector(".button-label").textContent = state.weather.visible ? "Weather on" : "Weather off";
  weatherVisible.setAttribute("aria-pressed", String(state.weather.visible));
  weatherSource.disabled = !state.weather.visible;
  dayNight.setAttribute("aria-pressed", String(state.earth.dayNight));
  dayNight.querySelector(".button-label").textContent = "Day / night";
  dayNight.setAttribute("aria-label", `Day and night ${state.earth.dayNight ? "on" : "off"}`);
  earthRotation.setAttribute("aria-pressed", String(state.earth.rotating));
  earthRotation.setAttribute("aria-label", `Auto rotate ${state.earth.rotating ? "on" : "off"}`);
  playback.setAttribute("aria-pressed", String(state.playback.playing));
  playback.classList.toggle("is-playing", state.playback.playing);
  playback.querySelector(".button-label").textContent = state.playback.playing ? "Pause" : "Play";
  playback.setAttribute("aria-label", state.playback.playing ? "Pause forecast" : "Play forecast");
  selectedCity.textContent = state.city
    ? `${state.city.name}${state.city.country ? ` · ${state.city.country}` : ""}`
    : "No location selected";
  selectedCity.classList.toggle("has-selection", Boolean(state.city));

  weatherLayers.replaceChildren(...state.weather.layers.map((layer) => {
    const button = document.createElement("button");
    button.type = "button";
    button.append(makeLayerIcon(layer.id), layer.label);
    button.disabled = !state.weather.visible;
    button.setAttribute("aria-pressed", String(layer.visible));
    button.addEventListener("click", () => sendCommand({
      type: protocol.COMMANDS.WEATHER_LAYER_SET,
      layer: layer.id,
      visible: !layer.visible,
    }));
    return button;
  }));

  const frames = state.timeline.frames;
  timelineSlider.max = String(Math.max(0, frames.length - 1));
  timelineSlider.value = String(state.timeline.activeFrame);
  const progress = frames.length > 1 ? state.timeline.activeFrame / (frames.length - 1) : 0;
  timelineSlider.style.setProperty("--timeline-progress", `${progress * 100}%`);
  const active = frames[state.timeline.activeFrame];
  if (active) {
    timelineCurrent.textContent = `T+${String(active.leadHours).padStart(2, "0")}h`;
    timelineDate.textContent = new Date(active.validTime).toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
  }
  if (frames.length) {
    timelineFirst.textContent = `T+${frames[0].leadHours}h`;
    timelineLast.textContent = `T+${frames.at(-1).leadHours}h`;
  }
}

connect();
