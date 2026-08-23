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
  currentNode: document.querySelector("#current-node"),
  currentNodeDetail: document.querySelector("#current-node-detail"),
  executionNode: document.querySelector("#execution-node"),
  pipelineStatus: document.querySelector("#pipeline-status"),
  snapshotStorage: document.querySelector("#snapshot-storage"),
  snapshotDetail: document.querySelector("#snapshot-detail"),
  lastRun: document.querySelector("#last-run"),
  lastRunDetail: document.querySelector("#last-run-detail"),
  nextRun: document.querySelector("#next-run"),
  nextRunDetail: document.querySelector("#next-run-detail"),
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
  liveLog: document.querySelector("#live-log"),
  history: document.querySelector("#run-history"),
  emptyHistory: document.querySelector("#empty-history"),
  refresh: document.querySelector("#refresh"),
  logDialog: document.querySelector("#log-dialog"),
  dialogTitle: document.querySelector("#dialog-title"),
  dialogSummary: document.querySelector("#dialog-summary"),
  dialogLog: document.querySelector("#dialog-log"),
  closeDialog: document.querySelector("#close-dialog"),
};

const stages = ["download", "preparation", "inference", "publish"];
const stageLabels = { download: "Download data", preparation: "Prepare inputs", inference: "Run inference", publish: "Validate & publish" };
let latestState = null;
let pollTimer = null;
let scheduleHydrated = false;
let nodeOptionsSignature = "";
let selectedActiveRunId = null;

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

function formatDate(value, options = {}) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", ...options }).format(new Date(value));
}

function setMessage(element, message, error = false) {
  element.textContent = message;
  element.classList.toggle("error", error);
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

function render(state) {
  const { pipeline, storage, schedule, runs, currentRun } = state;
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
  elements.currentNode.textContent = state.node.name;
  elements.currentNodeDetail.textContent = `${capitalize(state.node.role)} · ${state.node.serverModel} · ${state.node.config.map((item) => configLabels[item] || item).join(", ")}`;
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
  elements.snapshotStorage.textContent = formatBytes(storage.snapshotBytes);
  elements.snapshotDetail.textContent = `${storage.snapshotCount.toLocaleString()} UI snapshots retained`;

  const last = runs.find((run) => ["complete", "failed", "canceled"].includes(run.status));
  elements.lastRun.textContent = last ? formatDate(last.endedAt || last.startedAt) : "—";
  elements.lastRunDetail.textContent = last ? `${capitalize(last.status)} · ${formatDuration(last.durationMs)}` : "No execution history yet";
  if (schedule.enabled && schedule.nextRunAt) {
    elements.nextRun.textContent = formatDate(schedule.nextRunAt);
    elements.nextRunDetail.textContent = `${schedule.mode === "inference" ? "Inference only" : "Full pipeline"} · ${computeLabel(schedule.computeConfig || schedule.computeDevice)} · ${schedule.steps} frames · ${schedule.runsPerPeriod} ${schedule.runsPerPeriod === 1 ? "time" : "times"} per ${schedule.period}`;
  } else {
    elements.nextRun.textContent = "Off";
    elements.nextRunDetail.textContent = "No recurring schedule";
  }
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
  for (const timing of run.inferenceTimings || []) {
    if (timing.name === "runnerTotal") continue;
    items.push(`Inference · ${timing.label} ${formatDuration(timing.durationMs)}`);
  }
  const runnerTotal = (run.inferenceTimings || []).find((timing) => timing.name === "runnerTotal");
  if (runnerTotal) items.push(`Inference runner total ${formatDuration(runnerTotal.durationMs)}`);
  elements.dialogSummary.replaceChildren(...items.filter(Boolean).map((text) => {
    const span = document.createElement("span"); span.textContent = text; return span;
  }));
  elements.dialogLog.textContent = `${run.error ? `ERROR: ${run.error}\n\n` : ""}${logText(run.logs)}`;
  elements.logDialog.showModal();
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
    const nextNode = latestState?.nodes?.find((node) => (node.self || node.connected) && !node.active && node.pipelineReady && node.id !== launchedNodeId);
    if (nextNode) {
      elements.executionNode.value = nextNode.id;
      updateComputeOptions();
      render(latestState);
    }
  } catch (error) {
    setMessage(elements.runMessage, error.message, true);
    if (latestState) render(latestState);
  }
}

async function queueRun() {
  const mode = elements.runMode.value;
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
  } catch (error) {
    setMessage(elements.runMessage, error.message, true);
    if (latestState) render(latestState);
  }
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
elements.closeDialog.addEventListener("click", () => elements.logDialog.close());
elements.logDialog.addEventListener("click", (event) => { if (event.target === elements.logDialog) elements.logDialog.close(); });

refresh();
