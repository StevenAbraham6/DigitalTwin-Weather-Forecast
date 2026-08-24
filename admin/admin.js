const elements = {
  setup: document.querySelector("#node-setup"),
  dashboard: document.querySelector("#admin-dashboard"),
  displayLink: document.querySelector("#display-link"),
  nodeName: document.querySelector("#node-name"),
  serverModel: document.querySelector("#server-model"),
  masterUrlField: document.querySelector("#master-url-field"),
  masterUrl: document.querySelector("#master-url"),
  saveNode: document.querySelector("#save-node"),
  setupMessage: document.querySelector("#setup-message"),
  nodeTelemetryGrid: document.querySelector("#node-telemetry-grid"),
  executionNode: document.querySelector("#execution-node"),
  pipelineStatus: document.querySelector("#pipeline-status"),
  runNow: document.querySelector("#run-now"),
  queueRun: document.querySelector("#queue-run"),
  runName: document.querySelector("#run-name"),
  runMode: document.querySelector("#run-mode"),
  computeDevice: document.querySelector("#compute-device"),
  forecastSteps: document.querySelector("#forecast-steps"),
  reusableData: document.querySelector("#reusable-data"),
  runMessage: document.querySelector("#run-message"),
  scheduleEnabled: document.querySelector("#schedule-enabled"),
  runsPerPeriod: document.querySelector("#runs-per-period"),
  schedulePeriod: document.querySelector("#schedule-period"),
  saveSchedule: document.querySelector("#save-schedule"),
  scheduleMessage: document.querySelector("#schedule-message"),
  activeRun: document.querySelector("#active-run"),
  activeRunTabs: document.querySelector("#active-run-tabs"),
  activeTitle: document.querySelector("#active-title"),
  activeElapsed: document.querySelector("#active-elapsed"),
  stopRun: document.querySelector("#stop-run"),
  stopMessage: document.querySelector("#stop-message"),
  progressBar: document.querySelector("#progress-bar"),
  stageList: document.querySelector("#stage-list"),
  liveInferenceSteps: document.querySelector("#live-inference-steps"),
  liveInferenceStepList: document.querySelector("#live-inference-step-list"),
  liveLog: document.querySelector("#live-log"),
  history: document.querySelector("#run-history"),
  emptyHistory: document.querySelector("#empty-history"),
  refresh: document.querySelector("#refresh"),
  logDialog: document.querySelector("#log-dialog"),
  dialogTitle: document.querySelector("#dialog-title"),
  dialogSummary: document.querySelector("#dialog-summary"),
  dialogInferenceSteps: document.querySelector("#dialog-inference-steps"),
  dialogInferenceStepList: document.querySelector("#dialog-inference-step-list"),
  dialogLog: document.querySelector("#dialog-log"),
  dialogTelemetry: document.querySelector("#dialog-telemetry"),
  loadTelemetry: document.querySelector("#load-telemetry"),
  telemetryMessage: document.querySelector("#telemetry-message"),
  telemetryContent: document.querySelector("#telemetry-content"),
  telemetrySummary: document.querySelector("#telemetry-summary"),
  telemetryHover: document.querySelector("#telemetry-hover"),
  utilizationChart: document.querySelector("#utilization-chart"),
  utilizationLegend: document.querySelector("#utilization-legend"),
  memoryChart: document.querySelector("#memory-chart"),
  memoryLegend: document.querySelector("#memory-legend"),
  temperatureChart: document.querySelector("#temperature-chart"),
  temperatureLegend: document.querySelector("#temperature-legend"),
  closeDialog: document.querySelector("#close-dialog"),
};

const stages = ["download", "preparation", "inference", "publish"];
const stageLabels = { download: "Download data", preparation: "Prepare inputs", inference: "Run inference", publish: "Validate & publish" };
const inferenceSteps = [
  { name: "processSetup", label: "Process and device setup" },
  { name: "inputLoad", label: "Load prepared input" },
  { name: "targetPreparation", label: "Prepare forecast tensors" },
  { name: "checkpointLoad", label: "Load checkpoint and statistics" },
  { name: "inputExtraction", label: "Extract model inputs and forcings" },
  { name: "jaxCompilation", label: "JAX lower and compile" },
  { name: "modelRollout", label: (run) => `GraphCast rollout (${run.steps || "—"} steps)` },
  { name: "deviceToHost", label: "Transfer forecast to host" },
  { name: "netcdfWrite", label: "Write native NetCDF" },
  { name: "runnerTotal", label: "Inference runner total", total: true },
];
let latestState = null;
let pollTimer = null;
let scheduleHydrated = false;
let nodeOptionsSignature = "";
let selectedActiveRunId = null;
let selectedDialogRun = null;
let telemetryChartState = null;

const configLabels = {
  cpu_12c: "CPU 12c",
  cpu_20c: "CPU 20c",
  cpu_32c: "CPU 32c",
  gpu_amd: "GPU AMD Radeon AI PRO R9700",
  gpu_l4: "GPU Nvidia L4",
};

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(index === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[index]}`;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "—";
  const totalSeconds = Math.round(milliseconds / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatInferenceDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "—";
  const roundedMilliseconds = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(roundedMilliseconds / 3600000);
  const minutes = Math.floor((roundedMilliseconds % 3600000) / 60000);
  const seconds = (roundedMilliseconds % 60000) / 1000;
  if (hours) return `${hours}h ${minutes}m ${seconds.toFixed(3)}s`;
  if (minutes) return `${minutes}m ${seconds.toFixed(3)}s`;
  return `${seconds.toFixed(3)}s`;
}

function formatDate(value, options = {}) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", ...options }).format(new Date(value));
}

function setMessage(element, message, error = false) {
  element.textContent = message;
  element.classList.toggle("error", error);
}

function renderInferenceSteps(container, list, run, { live = false } = {}) {
  const timings = Array.isArray(run.inferenceTimings) ? run.inferenceTimings : [];
  const timingsByName = new Map(timings.map((timing) => [timing.name, timing]));
  const firstIncomplete = inferenceSteps.find((step) => !timingsByName.has(step.name))?.name;
  const inferenceStarted = run.stage === "inference" || stages.indexOf(run.stage) > stages.indexOf("inference") || timings.length > 0;

  list.replaceChildren(...inferenceSteps.map((step) => {
    const timing = timingsByName.get(step.name);
    const active = live && inferenceStarted && run.stage === "inference" && !timing && step.name === firstIncomplete;
    const item = document.createElement("li");
    item.className = `inference-step ${timing ? "complete" : active ? "active" : "pending"}${step.total ? " total" : ""}`;

    const marker = document.createElement("span");
    marker.className = "inference-step-marker";
    marker.setAttribute("aria-hidden", "true");
    marker.textContent = timing ? "✓" : active ? "●" : "○";

    const label = document.createElement("span");
    label.className = "inference-step-label";
    label.textContent = timing?.label || (typeof step.label === "function" ? step.label(run) : step.label);

    const duration = document.createElement("strong");
    duration.className = "inference-step-duration";
    duration.textContent = timing
      ? formatInferenceDuration(timing.durationMs)
      : active
        ? "Running…"
        : live
          ? "Waiting"
          : "Not recorded";

    item.append(marker, label, duration);
    return item;
  }));
  container.hidden = false;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...options.headers } : options.headers,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

async function refresh() {
  try {
    latestState = await api("/api/admin/status");
    if (!latestState.configured) {
      renderSetup(latestState.savedProfile);
      scheduleNextPoll(10000);
      return;
    }
    elements.setup.hidden = true;
    elements.dashboard.hidden = false;
    render(latestState);
    scheduleNextPoll(latestState.pipeline.active ? 2500 : 10000);
  } catch (error) {
    elements.pipelineStatus.className = "status-pill error";
    elements.pipelineStatus.lastChild.textContent = ` ${error.message}`;
    scheduleNextPoll(15000);
  }
}

function scheduleNextPoll(delay) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refresh, delay);
}

function renderSetup(profile = {}) {
  elements.setup.hidden = false;
  elements.dashboard.hidden = true;
  elements.displayLink.hidden = true;
  if (!elements.nodeName.value) {
    const role = profile.role === "slave" ? "slave" : "master";
    document.querySelector(`input[name="node-role"][value="${role}"]`).checked = true;
    elements.nodeName.value = profile.name || (role === "master" ? "Master" : "Slave");
    elements.serverModel.value = profile.serverModel || "XE130c M8";
    elements.masterUrl.value = profile.masterUrl || "";
    const selected = new Set(profile.config || ["cpu_12c"]);
    document.querySelectorAll('input[name="node-config"]').forEach((input) => { input.checked = selected.has(input.value); });
  }
  updateRoleFields();
}

function updateRoleFields() {
  const role = document.querySelector('input[name="node-role"]:checked')?.value || "master";
  elements.masterUrlField.hidden = role !== "slave";
}

function getSelectedNode() {
  return latestState?.nodes?.find((node) => node.id === elements.executionNode.value) || latestState?.nodes?.[0] || null;
}

function updateNodeOptions(nodes = [], schedule = {}) {
  const available = nodes.filter((node) => node.self || node.connected);
  const signature = available.map((node) => `${node.id}:${node.name}:${node.connected}:${node.active}:${node.config.join(",")}`).join("|");
  if (signature === nodeOptionsSignature) return;
  const previous = elements.executionNode.value || schedule.nodeId;
  elements.executionNode.replaceChildren(...available.map((node) => {
    const option = document.createElement("option");
    option.value = node.id;
    option.textContent = `${node.name}${node.self ? " (this node)" : ""}${node.active ? " · busy" : " · available"}`;
    return option;
  }));
  if (available.some((node) => node.id === previous)) elements.executionNode.value = previous;
  nodeOptionsSignature = signature;
  updateComputeOptions();
}

function updateComputeOptions() {
  const node = getSelectedNode();
  const previous = elements.computeDevice.value;
  elements.computeDevice.replaceChildren(...(node?.config || []).map((config) => {
    const option = document.createElement("option");
    option.value = config;
    option.textContent = configLabels[config] || config;
    return option;
  }));
  if (node?.config.includes(previous)) elements.computeDevice.value = previous;
  updateRunAvailability();
}

function formatPercent(value) { return Number.isFinite(value) ? `${Math.round(value)}%` : "—"; }
function formatTemperature(value) { return Number.isFinite(value) ? `${Math.round(value)}°C` : "—"; }
function formatPower(value) { return Number.isFinite(value) ? `${Math.round(value)} W` : "—"; }

function liveStat(label, value, fillPercent, className = "") {
  const stat = document.createElement("div");
  stat.className = `live-stat ${className}`;
  const heading = document.createElement("div");
  heading.className = "live-stat-heading";
  const name = document.createElement("span");
  name.textContent = label;
  const reading = document.createElement("strong");
  reading.textContent = value;
  heading.append(name, reading);
  const bar = document.createElement("div");
  bar.className = "live-stat-bar";
  const fill = document.createElement("span");
  fill.style.width = `${Number.isFinite(fillPercent) ? Math.max(0, Math.min(100, fillPercent)) : 0}%`;
  bar.append(fill);
  stat.append(heading, bar);
  return stat;
}

function renderNodeTelemetry(nodes) {
  elements.nodeTelemetryGrid.replaceChildren(...nodes.map((node) => {
    const telemetry = node.telemetry;
    const card = document.createElement("article");
    const selectable = node.self || node.connected;
    card.className = `node-card ${node.active ? "busy" : ""} ${node.connected ? "" : "offline"} ${selectable ? "selectable" : ""} ${node.id === elements.executionNode.value ? "selected" : ""}`;
    if (selectable) {
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `Select ${node.name} for execution`);
      const select = () => {
        elements.executionNode.value = node.id;
        updateComputeOptions();
        if (latestState) render(latestState);
      };
      card.addEventListener("click", select);
      card.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") select(); });
    }

    const header = document.createElement("div");
    header.className = "node-card-header";
    const title = document.createElement("div");
    title.className = "node-card-title";
    const role = document.createElement("span");
    role.className = "node-role";
    role.textContent = `${capitalize(node.role)}${node.self ? " · this server" : ""}`;
    const heading = document.createElement("h3");
    heading.textContent = node.name;
    const detail = document.createElement("p");
    detail.textContent = [
      node.serverModel,
      telemetry?.cpu?.model,
      Number.isFinite(telemetry?.cpu?.logicalCores) ? `${telemetry.cpu.logicalCores} logical cores` : null,
    ].filter(Boolean).join(" · ");
    const configs = document.createElement("div");
    configs.className = "node-configs";
    configs.replaceChildren(...node.config.map((config) => {
      const chip = document.createElement("span");
      chip.className = "node-config-chip";
      chip.textContent = configLabels[config] || config;
      return chip;
    }));
    title.append(role, heading, detail, configs);
    const state = document.createElement("span");
    state.className = "node-state";
    state.textContent = !node.connected ? "Offline" : node.active ? "Pipeline running" : "Online";
    header.append(title, state);

    const grid = document.createElement("div");
    grid.className = "node-live-grid";
    if (!node.connected || !telemetry) {
      const unavailable = document.createElement("div");
      unavailable.className = "telemetry-unavailable";
      unavailable.textContent = node.connected ? "Waiting for the first hardware sample…" : `Last heartbeat ${formatDate(node.lastSeen)}`;
      grid.append(unavailable);
    } else {
      grid.append(
        liveStat("CPU", formatPercent(telemetry.cpu?.utilizationPercent), telemetry.cpu?.utilizationPercent),
        liveStat(
          "System RAM",
          `${formatBytes(telemetry.memory?.usedBytes)} / ${formatBytes(telemetry.memory?.totalBytes)}`,
          telemetry.memory?.utilizationPercent,
        ),
      );
      if (Number.isFinite(telemetry.cpu?.temperatureC)) {
        grid.append(liveStat("CPU temperature", formatTemperature(telemetry.cpu.temperatureC), telemetry.cpu.temperatureC, "temperature"));
      }
      for (const gpu of telemetry.gpus || []) {
        const block = document.createElement("section");
        block.className = "gpu-live-block";
        const gpuTitle = document.createElement("div");
        gpuTitle.className = "gpu-live-title";
        const gpuName = document.createElement("strong");
        gpuName.textContent = gpu.name;
        const vendor = document.createElement("small");
        vendor.textContent = String(gpu.vendor || "GPU").toUpperCase();
        gpuTitle.append(gpuName, vendor);
        block.append(
          gpuTitle,
          liveStat("GPU", formatPercent(gpu.utilizationPercent), gpu.utilizationPercent),
          liveStat("VRAM", `${formatBytes(gpu.memoryUsedBytes)} / ${formatBytes(gpu.memoryTotalBytes)}`, gpu.memoryPercent),
          liveStat("Temperature", formatTemperature(gpu.temperatureC), gpu.temperatureC, "temperature"),
          liveStat("Power", formatPower(gpu.powerWatts), Number.isFinite(gpu.powerWatts) && gpu.powerLimitWatts ? gpu.powerWatts / gpu.powerLimitWatts * 100 : 0),
        );
        grid.append(block);
      }
      if (!(telemetry.gpus || []).length && node.config.some((config) => config.startsWith("gpu_"))) {
        const unavailable = document.createElement("div");
        unavailable.className = "telemetry-unavailable";
        unavailable.textContent = "GPU telemetry tool or driver is not available.";
        grid.append(unavailable);
      }
      const sampled = document.createElement("small");
      sampled.className = "node-sampled-at";
      sampled.textContent = `Sampled ${new Date(telemetry.sampledAt).toLocaleTimeString()}`;
      grid.append(sampled);
    }
    card.append(header, grid);
    return card;
  }));
}

function render(state) {
  const { pipeline, schedule, runs, currentRun } = state;
  const activeRuns = state.activeRuns || (currentRun ? [currentRun] : []);
  const connectedNodes = state.nodes.filter((node) => node.self || node.connected);
  const activeNodeCount = connectedNodes.filter((node) => node.active).length;
  updateNodeOptions(state.nodes, schedule);
  const selectedNode = getSelectedNode();
  const selectedActive = Boolean(selectedNode?.active);
  elements.pipelineStatus.className = `status-pill ${pipeline.active ? "running" : selectedNode?.pipelineReady ? "ready" : "error"}`;
  elements.pipelineStatus.lastChild.textContent = pipeline.active
    ? ` ${activeNodeCount} of ${connectedNodes.length} nodes busy`
    : selectedNode?.pipelineReady ? " Pipeline ready" : " Setup required";
  elements.displayLink.hidden = state.node.role !== "master";
  renderNodeTelemetry(state.nodes);
  elements.runMode.querySelector('option[value="inference"]').disabled = !selectedNode?.reusableBaseData;
  if (selectedNode?.reusableBaseData) {
    elements.reusableData.textContent = `Reusable base data on ${selectedNode.name}: ERA5T ${formatDate(selectedNode.reusableBaseData.initializationTime)}`;
    elements.reusableData.classList.add("available");
  } else {
    elements.reusableData.textContent = "No reusable base data yet. Run the full pipeline first.";
    elements.reusableData.classList.remove("available");
  }
  elements.runName.disabled = selectedActive;
  elements.runMode.disabled = selectedActive;
  elements.computeDevice.disabled = selectedActive;
  elements.forecastSteps.disabled = selectedActive;
  if (!scheduleHydrated) {
    elements.scheduleEnabled.checked = schedule.enabled;
    elements.runName.value = schedule.namePrefix;
    elements.runMode.value = schedule.mode;
    elements.forecastSteps.value = String(schedule.steps);
    elements.runsPerPeriod.value = schedule.runsPerPeriod;
    elements.schedulePeriod.value = schedule.period;
    if (schedule.nodeId && [...elements.executionNode.options].some((option) => option.value === schedule.nodeId)) elements.executionNode.value = schedule.nodeId;
    updateComputeOptions();
    if (schedule.computeConfig && [...elements.computeDevice.options].some((option) => option.value === schedule.computeConfig)) elements.computeDevice.value = schedule.computeConfig;
    updateScheduleLimit();
    scheduleHydrated = true;
  }
  updateRunAvailability();
  renderActive(activeRuns.filter((run) => run.status === "running"));
  if (!elements.history.contains(document.activeElement)) renderHistory(runs);
}

function renderActive(runs) {
  elements.activeRun.hidden = runs.length === 0;
  if (!runs.length) {
    selectedActiveRunId = null;
    return;
  }
  if (!runs.some((run) => run.id === selectedActiveRunId)) selectedActiveRunId = runs[0].id;
  elements.activeRunTabs.hidden = runs.length < 2;
  elements.activeRunTabs.replaceChildren(...runs.map((run) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "active-run-tab";
    button.setAttribute("aria-pressed", String(run.id === selectedActiveRunId));
    button.textContent = `${run.nodeName || "Local node"} · ${run.name || "Pipeline run"}`;
    button.addEventListener("click", () => {
      selectedActiveRunId = run.id;
      renderActive(runs);
    });
    return button;
  }));
  const run = runs.find((candidate) => candidate.id === selectedActiveRunId) || runs[0];
  elements.stopRun.disabled = Boolean(run.cancelRequestedAt);
  elements.stopRun.textContent = run.cancelRequestedAt ? "Stopping…" : "Stop run";
  elements.stopRun.title = `Stop ${run.name || "this pipeline execution"} on ${run.nodeName || "the local node"}`;
  const stageIndex = Math.max(0, stages.indexOf(run.stage));
  const liveStage = run.cancelRequestedAt ? "Stopping pipeline" : stageLabels[run.stage] || "Starting pipeline";
  elements.activeTitle.textContent = `${run.name || "Pipeline run"} · ${run.nodeName || "Local node"} · ${computeLabel(run.computeConfig || run.computeDevice)} · ${liveStage}…`;
  elements.activeElapsed.textContent = formatDuration(Math.max(0, Date.now() - new Date(run.startedAt).getTime()));
  elements.progressBar.style.width = `${Math.max(4, (stageIndex / stages.length) * 100 + 8)}%`;
  elements.stageList.replaceChildren(...stages.map((stage, index) => {
    const node = document.createElement("div");
    const skipped = run.skippedStages?.includes(stage);
    node.className = `stage ${skipped ? "skipped" : index < stageIndex ? "done" : index === stageIndex ? "active" : ""}`;
    node.textContent = `${skipped ? "↷ " : index < stageIndex ? "✓ " : index === stageIndex ? "● " : "○ "}${stageLabels[stage]}${skipped ? " (reused)" : ""}`;
    return node;
  }));
  renderInferenceSteps(elements.liveInferenceSteps, elements.liveInferenceStepList, run, { live: true });
  elements.liveLog.textContent = logText(run.logs.slice(-80));
  elements.liveLog.scrollTop = elements.liveLog.scrollHeight;
}

function renderHistory(runs) {
  elements.history.replaceChildren(...runs.map((run) => {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    const nameInput = document.createElement("input");
    nameInput.className = "history-name";
    nameInput.type = "text";
    nameInput.maxLength = 100;
    nameInput.value = run.name || `Execution ${run.id.slice(0, 8)}`;
    nameInput.title = "Click to edit this execution name";
    nameInput.setAttribute("aria-label", `Name for execution ${run.id.slice(0, 8)}`);
    nameInput.addEventListener("change", () => saveRunName(run, nameInput));
    nameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") nameInput.blur();
      if (event.key === "Escape") {
        nameInput.value = run.name || `Execution ${run.id.slice(0, 8)}`;
        nameInput.blur();
      }
    });
    nameCell.append(nameInput);
    row.append(nameCell);
    const computeCell = document.createElement("td");
    computeCell.textContent = computeLabel(run.computeConfig || run.computeDevice);
    row.append(computeCell);
    const nodeCell = document.createElement("td");
    nodeCell.textContent = run.nodeName || "Local node";
    row.append(nodeCell);
    const actions = document.createElement("td");
    if (run.status === "queued") {
      const startButton = document.createElement("button");
      startButton.className = "quiet-button";
      startButton.type = "button";
      startButton.textContent = "Start";
      startButton.addEventListener("click", () => startQueuedRun(run, startButton));
      actions.append(startButton);
      const cancelButton = document.createElement("button");
      cancelButton.className = "quiet-button";
      cancelButton.type = "button";
      cancelButton.textContent = "Cancel";
      cancelButton.addEventListener("click", () => cancelQueuedRun(run, cancelButton));
      actions.append(cancelButton);
    }
    const button = document.createElement("button");
    button.className = "quiet-button";
    button.type = "button";
    button.textContent = "Details";
    button.addEventListener("click", () => showRun(run));
    actions.append(button);
    row.append(actions);
    const values = [
      { text: run.status, className: `run-status ${run.status}` },
      { text: formatDuration(run.durationMs) },
      { text: run.mode === "inference" ? "Reused" : formatDuration(run.downloadDurationMs) },
      { text: formatDuration(run.inferenceDurationMs) },
      { text: run.snapshotCount == null ? "—" : run.snapshotCount.toLocaleString() },
      { text: `${capitalize(run.trigger)} · ${run.mode === "inference" ? "Inference only" : "Full pipeline"}` },
      { text: formatDate(run.startedAt || run.queuedAt) },
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      const content = document.createElement(value.className ? "span" : "span");
      content.textContent = value.text;
      if (value.className) content.className = value.className;
      cell.append(content);
      row.append(cell);
    }
    return row;
  }));
  elements.emptyHistory.hidden = runs.length > 0;
}

async function saveRunName(run, input) {
  const name = input.value.trim();
  if (!name || name === run.name) {
    input.value = run.name || `Execution ${run.id.slice(0, 8)}`;
    return;
  }
  input.disabled = true;
  try {
    const result = await api(`/api/admin/runs/${encodeURIComponent(run.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    run.name = result.run.name;
    input.value = result.run.name;
    setMessage(elements.runMessage, `Renamed execution to “${result.run.name}”.`);
  } catch (error) {
    input.value = run.name || `Execution ${run.id.slice(0, 8)}`;
    setMessage(elements.runMessage, error.message, true);
  } finally {
    input.disabled = false;
  }
}

function showRun(run) {
  selectedDialogRun = run;
  elements.dialogTitle.textContent = run.name || run.publishedRunId || `Execution ${run.id.slice(0, 8)}`;
  const items = [
    `${capitalize(run.trigger)} · ${run.mode === "inference" ? "Inference only · reused base data" : "Full pipeline"}`,
    `Node ${run.nodeName || "Local node"} · ${run.serverModel || ""}`,
    `Compute ${computeLabel(run.computeConfig || run.computeDevice)}`,
    `Queued ${formatDate(run.queuedAt)}`,
    `Started ${formatDate(run.startedAt)}`,
    `Ended ${formatDate(run.endedAt)}`,
    `Total ${formatDuration(run.durationMs)}`,
    run.mode === "inference" ? "Download Reused" : `Download ${formatDuration(run.downloadDurationMs)}`,
    run.mode === "inference" ? "Preparation Reused" : `Preparation ${formatDuration(run.preparationDurationMs)}`,
    `Inference ${formatDuration(run.inferenceDurationMs)}`,
    run.inferenceBackend
      ? `Backend ${run.inferenceBackend.toUpperCase()}${run.inferenceDevice ? ` · ${run.inferenceDevice}` : ""}`
      : null,
    `Publish ${formatDuration(run.publishDurationMs)}`,
    `${run.snapshotCount == null ? "—" : run.snapshotCount.toLocaleString()} snapshots`,
    `${formatBytes(run.artifactBytes)} total artifacts`,
  ];
  elements.dialogSummary.replaceChildren(...items.filter(Boolean).map((text) => {
    const span = document.createElement("span"); span.textContent = text; return span;
  }));
  renderInferenceSteps(elements.dialogInferenceSteps, elements.dialogInferenceStepList, run);
  elements.dialogLog.textContent = `${run.error ? `ERROR: ${run.error}\n\n` : ""}${logText(run.logs)}`;
  elements.telemetryContent.hidden = true;
  telemetryChartState = null;
  elements.telemetryHover.textContent = "Move across a graph to inspect a synchronized point in time.";
  elements.telemetrySummary.replaceChildren();
  elements.loadTelemetry.hidden = !run.telemetry?.available;
  elements.loadTelemetry.disabled = false;
  elements.loadTelemetry.textContent = "Load graphs";
  elements.telemetryMessage.classList.remove("error");
  elements.telemetryMessage.textContent = run.telemetry?.available
    ? `${run.telemetry.sampleCount.toLocaleString()} hardware samples are available. Graphs load on request.`
    : run.status === "running"
      ? "Telemetry will be available after this execution finishes."
      : "No hardware telemetry was recorded for this execution.";
  elements.logDialog.showModal();
}

const chartColors = ["#66f0b6", "#55c8ed", "#f7c66b", "#d790ff", "#ff7e7e"];

function elapsedLabel(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function chartSeries(telemetryDocument, kind) {
  const samples = telemetryDocument.samples || [];
  const gpuIds = [...new Set(samples.flatMap((sample) => sample.gpus || []).map((gpu) => gpu.id))];
  const gpuName = (id) => samples.flatMap((sample) => sample.gpus || []).find((gpu) => gpu.id === id)?.name || "GPU";
  if (kind === "utilization") return [
    { label: "CPU", color: chartColors[0], values: samples.map((sample) => sample.cpu?.utilizationPercent) },
    ...gpuIds.map((id, index) => ({ label: gpuName(id), color: chartColors[index + 1] || chartColors.at(-1), values: samples.map((sample) => sample.gpus?.find((gpu) => gpu.id === id)?.utilizationPercent) })),
  ];
  if (kind === "memory") return [
    { label: "System RAM", color: chartColors[0], values: samples.map((sample) => sample.memory?.utilizationPercent) },
    ...gpuIds.map((id, index) => ({ label: `${gpuName(id)} VRAM`, color: chartColors[index + 1] || chartColors.at(-1), values: samples.map((sample) => sample.gpus?.find((gpu) => gpu.id === id)?.memoryPercent) })),
  ];
  return [
    { label: "CPU", color: chartColors[0], values: samples.map((sample) => sample.cpu?.temperatureC) },
    ...gpuIds.map((id, index) => ({ label: gpuName(id), color: chartColors[index + 1] || chartColors.at(-1), values: samples.map((sample) => sample.gpus?.find((gpu) => gpu.id === id)?.temperatureC) })),
  ];
}

function renderLegend(element, series) {
  element.replaceChildren(...series.filter((item) => item.values.some(Number.isFinite)).map((item) => {
    const label = document.createElement("span");
    label.style.setProperty("--legend-color", item.color);
    label.textContent = item.label;
    return label;
  }));
}

function drawTelemetryChart(canvas, samples, series, { percentScale = false, hoverIndex = null } = {}) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(560, Math.floor(canvas.clientWidth || 900));
  const height = 180;
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);
  const bounds = { left: 42, right: 12, top: 9, bottom: 24 };
  const chartWidth = width - bounds.left - bounds.right;
  const chartHeight = height - bounds.top - bounds.bottom;
  const maxTime = Math.max(1, ...samples.map((sample) => sample.elapsedMs));
  const validValues = series.flatMap((item) => item.values).filter(Number.isFinite);
  const minimum = percentScale ? 0 : Math.max(0, Math.floor((Math.min(...validValues, 20) - 10) / 10) * 10);
  const maximum = percentScale ? 100 : Math.max(minimum + 20, Math.ceil((Math.max(...validValues, 80) + 10) / 10) * 10);
  const x = (elapsedMs) => bounds.left + elapsedMs / maxTime * chartWidth;
  const y = (value) => bounds.top + (maximum - value) / (maximum - minimum) * chartHeight;

  const stageColors = { download: "rgba(85,200,237,.035)", preparation: "rgba(247,198,107,.035)", inference: "rgba(102,240,182,.055)", publish: "rgba(215,144,255,.035)" };
  samples.forEach((sample, index) => {
    const next = samples[index + 1];
    context.fillStyle = stageColors[sample.stage] || "transparent";
    context.fillRect(x(sample.elapsedMs), bounds.top, x(next?.elapsedMs ?? maxTime) - x(sample.elapsedMs), chartHeight);
  });
  context.font = "9px system-ui";
  context.textAlign = "left";
  context.fillStyle = "rgba(185,208,200,.58)";
  samples.forEach((sample, index) => {
    if (index && samples[index - 1].stage === sample.stage) return;
    const nextStageIndex = samples.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.stage !== sample.stage);
    const end = nextStageIndex === -1 ? maxTime : samples[nextStageIndex].elapsedMs;
    if (x(end) - x(sample.elapsedMs) > 48) context.fillText(stageLabels[sample.stage] || capitalize(sample.stage), x(sample.elapsedMs) + 4, bounds.top + 10);
  });
  context.strokeStyle = "rgba(161,211,196,.12)";
  context.fillStyle = "#69817a";
  context.font = "10px system-ui";
  context.textAlign = "right";
  for (let index = 0; index <= 4; index += 1) {
    const value = minimum + (maximum - minimum) * index / 4;
    const position = y(value);
    context.beginPath();
    context.moveTo(bounds.left, position);
    context.lineTo(width - bounds.right, position);
    context.stroke();
    context.fillText(`${Math.round(value)}${percentScale ? "%" : "°"}`, bounds.left - 7, position + 3);
  }
  context.textAlign = "center";
  for (let index = 0; index <= 4; index += 1) {
    const elapsed = maxTime * index / 4;
    context.fillText(elapsedLabel(elapsed), x(elapsed), height - 7);
  }
  for (const item of series) {
    context.strokeStyle = item.color;
    context.lineWidth = 2;
    context.beginPath();
    let drawing = false;
    item.values.forEach((value, index) => {
      if (!Number.isFinite(value)) { drawing = false; return; }
      const pointX = x(samples[index].elapsedMs);
      const pointY = y(value);
      if (!drawing) context.moveTo(pointX, pointY);
      else context.lineTo(pointX, pointY);
      drawing = true;
    });
    context.stroke();
  }
  if (Number.isInteger(hoverIndex) && samples[hoverIndex]) {
    const hoverX = x(samples[hoverIndex].elapsedMs);
    context.strokeStyle = "rgba(238,248,244,.5)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(hoverX, bounds.top);
    context.lineTo(hoverX, bounds.top + chartHeight);
    context.stroke();
    for (const item of series) {
      const value = item.values[hoverIndex];
      if (!Number.isFinite(value)) continue;
      context.fillStyle = item.color;
      context.beginPath();
      context.arc(hoverX, y(value), 3, 0, Math.PI * 2);
      context.fill();
    }
  }
}

function redrawTelemetryCharts(hoverIndex = null) {
  if (!telemetryChartState) return;
  const { telemetryDocument, utilization, memory, temperature } = telemetryChartState;
  drawTelemetryChart(elements.utilizationChart, telemetryDocument.samples, utilization, { percentScale: true, hoverIndex });
  drawTelemetryChart(elements.memoryChart, telemetryDocument.samples, memory, { percentScale: true, hoverIndex });
  drawTelemetryChart(elements.temperatureChart, telemetryDocument.samples, temperature, { hoverIndex });
  if (!Number.isInteger(hoverIndex)) {
    elements.telemetryHover.textContent = "Move across a graph to inspect a synchronized point in time.";
    return;
  }
  const sample = telemetryDocument.samples[hoverIndex];
  const gpu = sample.gpus?.[0];
  elements.telemetryHover.textContent = [
    elapsedLabel(sample.elapsedMs),
    stageLabels[sample.stage] || capitalize(sample.stage),
    `CPU ${formatPercent(sample.cpu?.utilizationPercent)}`,
    `RAM ${formatPercent(sample.memory?.utilizationPercent)}`,
    gpu ? `GPU ${formatPercent(gpu.utilizationPercent)}` : null,
    gpu ? `VRAM ${formatPercent(gpu.memoryPercent)}` : null,
    Number.isFinite(gpu?.temperatureC) ? `GPU ${formatTemperature(gpu.temperatureC)}` : null,
  ].filter(Boolean).join(" · ");
}

function bindSynchronizedHover(canvas) {
  canvas.onmousemove = (event) => {
    if (!telemetryChartState?.telemetryDocument.samples.length) return;
    const rectangle = canvas.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - rectangle.left - 42) / Math.max(1, rectangle.width - 54)));
    const samples = telemetryChartState.telemetryDocument.samples;
    const target = fraction * samples.at(-1).elapsedMs;
    let closest = 0;
    for (let index = 1; index < samples.length; index += 1) {
      if (Math.abs(samples[index].elapsedMs - target) < Math.abs(samples[closest].elapsedMs - target)) closest = index;
    }
    redrawTelemetryCharts(closest);
  };
  canvas.onmouseleave = () => redrawTelemetryCharts();
}

function renderTelemetry(telemetryDocument) {
  elements.telemetryContent.hidden = false;
  const summaryLabels = {
    cpuUtilizationPercent: ["CPU utilization", "%"],
    systemMemoryPercent: ["System RAM", "%"],
    gpuUtilizationPercent: ["GPU utilization", "%"],
    gpuMemoryPercent: ["GPU VRAM", "%"],
    cpuTemperatureC: ["CPU temperature", "°C"],
    gpuTemperatureC: ["GPU temperature", "°C"],
  };
  elements.telemetrySummary.replaceChildren(...Object.entries(summaryLabels).flatMap(([key, [label, unit]]) => {
    const value = telemetryDocument.summary?.[key];
    if (!value) return [];
    const item = window.document.createElement("div");
    item.className = "telemetry-summary-item";
    const name = window.document.createElement("span");
    name.textContent = label;
    const reading = window.document.createElement("strong");
    reading.textContent = `${value.average}${unit} avg · ${value.peak}${unit} peak`;
    item.append(name, reading);
    return [item];
  }));
  const utilization = chartSeries(telemetryDocument, "utilization");
  const memory = chartSeries(telemetryDocument, "memory");
  const temperature = chartSeries(telemetryDocument, "temperature");
  telemetryChartState = { telemetryDocument, utilization, memory, temperature };
  redrawTelemetryCharts();
  [elements.utilizationChart, elements.memoryChart, elements.temperatureChart].forEach(bindSynchronizedHover);
  renderLegend(elements.utilizationLegend, utilization);
  renderLegend(elements.memoryLegend, memory);
  renderLegend(elements.temperatureLegend, temperature);
}

async function loadRunTelemetry() {
  if (!selectedDialogRun) return;
  elements.loadTelemetry.disabled = true;
  elements.loadTelemetry.textContent = "Loading…";
  elements.telemetryMessage.classList.remove("error");
  elements.telemetryMessage.textContent = "Loading recorded hardware samples…";
  try {
    const document = await api(`/api/admin/runs/${encodeURIComponent(selectedDialogRun.id)}/telemetry`);
    renderTelemetry(document);
    elements.telemetryMessage.textContent = `${document.samples.length.toLocaleString()} samples · every ${document.sampleIntervalMs / 1000} seconds · shaded by pipeline stage`;
    elements.loadTelemetry.hidden = true;
  } catch (error) {
    elements.telemetryMessage.textContent = error.message;
    elements.telemetryMessage.classList.add("error");
    elements.loadTelemetry.disabled = false;
    elements.loadTelemetry.textContent = "Retry";
  }
}

function logText(logs = []) {
  return logs.map((entry) => `${new Date(entry.at).toLocaleTimeString()}  ${entry.source === "stderr" ? "ERR" : "OUT"}  ${entry.message}`).join("\n");
}

function capitalize(value = "") { return value.charAt(0).toUpperCase() + value.slice(1); }
function computeLabel(value) {
  if (configLabels[value]) return configLabels[value];
  if (value === "gpu" || value === "gpu_l4") return "GPU · NVIDIA L4";
  if (value === "gpu_amd") return "GPU · AMD Radeon AI PRO R9700";
  return "CPU only";
}

async function startRun() {
  const mode = elements.runMode.value;
  const launchedNodeId = elements.executionNode.value;
  elements.runNow.disabled = true;
  const label = mode === "inference" ? "inference" : "full pipeline";
  setMessage(elements.runMessage, `Starting ${label} on ${computeLabel(elements.computeDevice.value)}…`);
  try {
    await api("/api/admin/runs", {
      method: "POST",
      body: JSON.stringify({
        nodeId: elements.executionNode.value,
        steps: Number(elements.forecastSteps.value),
        mode,
        computeConfig: elements.computeDevice.value,
        name: elements.runName.value,
      }),
    });
    setMessage(elements.runMessage, `${mode === "inference" ? "Inference" : "Full pipeline"} started. Live timings will appear below.`);
    await refresh();
    selectNextAvailableNode(launchedNodeId);
  } catch (error) {
    setMessage(elements.runMessage, error.message, true);
    if (latestState) render(latestState);
  }
}

async function queueRun() {
  const mode = elements.runMode.value;
  const queuedNodeId = elements.executionNode.value;
  elements.queueRun.disabled = true;
  setMessage(elements.runMessage, "Adding execution to the queue…");
  try {
    await api("/api/admin/runs", {
      method: "POST",
      body: JSON.stringify({
        queueOnly: true,
        nodeId: elements.executionNode.value,
        steps: Number(elements.forecastSteps.value),
        mode,
        computeConfig: elements.computeDevice.value,
        name: elements.runName.value,
      }),
    });
    setMessage(elements.runMessage, "Execution queued. Start or cancel it from execution history.");
    await refresh();
    selectNextAvailableNode(queuedNodeId);
  } catch (error) {
    setMessage(elements.runMessage, error.message, true);
    if (latestState) render(latestState);
  }
}

function selectNextAvailableNode(previousNodeId) {
  const nextNode = latestState?.nodes?.find((node) => (
    (node.self || node.connected)
    && !node.active
    && node.pipelineReady
    && node.id !== previousNodeId
  ));
  if (!nextNode) return;
  elements.executionNode.value = nextNode.id;
  updateComputeOptions();
  render(latestState);
}

async function startQueuedRun(run, button) {
  button.disabled = true;
  setMessage(elements.runMessage, `Starting “${run.name}”…`);
  try {
    await api(`/api/admin/runs/${encodeURIComponent(run.id)}/start`, { method: "POST", body: "{}" });
    setMessage(elements.runMessage, `“${run.name}” started.`);
    await refresh();
  } catch (error) {
    setMessage(elements.runMessage, error.message, true);
    button.disabled = false;
  }
}

async function cancelQueuedRun(run, button) {
  if (!window.confirm(`Cancel queued execution “${run.name}”?`)) return;
  button.disabled = true;
  try {
    await api(`/api/admin/runs/${encodeURIComponent(run.id)}/cancel`, { method: "POST", body: "{}" });
    setMessage(elements.runMessage, `“${run.name}” canceled.`);
    await refresh();
  } catch (error) {
    setMessage(elements.runMessage, error.message, true);
    button.disabled = false;
  }
}

async function stopRun() {
  const run = latestState?.activeRuns?.find((candidate) => candidate.id === selectedActiveRunId);
  if (!run || run.cancelRequestedAt) return;
  if (!window.confirm(`Stop “${run.name || "Pipeline run"}” on ${run.nodeName || "this node"}?`)) return;
  elements.stopRun.disabled = true;
  elements.stopRun.textContent = "Stopping…";
  setMessage(elements.stopMessage, "Sending stop request…");
  try {
    await api(`/api/admin/runs/${encodeURIComponent(run.id)}/cancel`, { method: "POST", body: "{}" });
    setMessage(elements.stopMessage, "Stop requested. The node will be available after the process exits.");
    await refresh();
  } catch (error) {
    setMessage(elements.stopMessage, error.message, true);
    if (latestState) render(latestState);
  }
}

elements.runNow.addEventListener("click", startRun);
elements.queueRun.addEventListener("click", queueRun);
elements.stopRun.addEventListener("click", stopRun);

elements.saveSchedule.addEventListener("click", async () => {
  elements.saveSchedule.disabled = true;
  setMessage(elements.scheduleMessage, "Saving schedule…");
  try {
    const body = {
      enabled: elements.scheduleEnabled.checked,
      nodeId: elements.executionNode.value,
      namePrefix: elements.runName.value,
      mode: elements.runMode.value,
      computeConfig: elements.computeDevice.value,
      steps: Number(elements.forecastSteps.value),
      runsPerPeriod: Number(elements.runsPerPeriod.value),
      period: elements.schedulePeriod.value,
    };
    const result = await api("/api/admin/schedule", { method: "PUT", body: JSON.stringify(body) });
    latestState.schedule = result.schedule;
    render(latestState);
    setMessage(elements.scheduleMessage, body.enabled ? "Schedule saved and active." : "Schedule disabled.");
  } catch (error) {
    setMessage(elements.scheduleMessage, error.message, true);
  } finally {
    elements.saveSchedule.disabled = false;
  }
});

function updateScheduleLimit() {
  elements.runsPerPeriod.max = elements.schedulePeriod.value === "day" ? "24" : "168";
}

function updateRunAvailability() {
  if (!latestState) return;
  const node = getSelectedNode();
  const inferenceUnavailable = elements.runMode.value === "inference" && !node?.reusableBaseData;
  const connectedNodes = latestState.nodes.filter((candidate) => candidate.self || candidate.connected);
  const freeNodes = connectedNodes.filter((candidate) => !candidate.active && candidate.pipelineReady);
  elements.runNow.disabled = !node || node.active || !node.pipelineReady || inferenceUnavailable;
  elements.queueRun.disabled = elements.runNow.disabled;
  elements.runNow.title = inferenceUnavailable
    ? "Run the full pipeline first to download base data."
    : node?.active && freeNodes.length
      ? "Choose an available node to start another execution."
      : freeNodes.length === 0
        ? `All ${connectedNodes.length} connected nodes are running pipelines.`
        : "Start one execution using the shared settings.";
  elements.queueRun.title = elements.runNow.disabled
    ? elements.runNow.title
    : "Reserve this node and add the execution to history without starting it.";
}

elements.runMode.addEventListener("change", updateRunAvailability);
elements.executionNode.addEventListener("change", () => {
  updateComputeOptions();
  if (latestState) render(latestState);
});
document.querySelectorAll('input[name="node-role"]').forEach((input) => input.addEventListener("change", updateRoleFields));
elements.saveNode.addEventListener("click", async () => {
  elements.saveNode.disabled = true;
  setMessage(elements.setupMessage, "Starting node services…");
  try {
    await api("/api/node/config", {
      method: "PUT",
      body: JSON.stringify({
        role: document.querySelector('input[name="node-role"]:checked')?.value,
        name: elements.nodeName.value,
        serverModel: elements.serverModel.value,
        config: [...document.querySelectorAll('input[name="node-config"]:checked')].map((input) => input.value),
        masterUrl: elements.masterUrl.value,
      }),
    });
    setMessage(elements.setupMessage, "Node configured.");
    await refresh();
  } catch (error) {
    setMessage(elements.setupMessage, error.message, true);
  } finally {
    elements.saveNode.disabled = false;
  }
});
elements.schedulePeriod.addEventListener("change", updateScheduleLimit);
elements.refresh.addEventListener("click", refresh);
elements.loadTelemetry.addEventListener("click", loadRunTelemetry);
elements.closeDialog.addEventListener("click", () => elements.logDialog.close());
elements.logDialog.addEventListener("click", (event) => { if (event.target === elements.logDialog) elements.logDialog.close(); });

refresh();
