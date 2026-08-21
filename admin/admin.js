const elements = {
  pipelineStatus: document.querySelector("#pipeline-status"),
  snapshotStorage: document.querySelector("#snapshot-storage"),
  snapshotDetail: document.querySelector("#snapshot-detail"),
  publishedRuns: document.querySelector("#published-runs"),
  publishedTotal: document.querySelector("#published-total"),
  lastRun: document.querySelector("#last-run"),
  lastRunDetail: document.querySelector("#last-run-detail"),
  nextRun: document.querySelector("#next-run"),
  nextRunDetail: document.querySelector("#next-run-detail"),
  runNow: document.querySelector("#run-now"),
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
  activeTitle: document.querySelector("#active-title"),
  activeElapsed: document.querySelector("#active-elapsed"),
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

function render(state) {
  const { pipeline, storage, schedule, runs, currentRun } = state;
  elements.pipelineStatus.className = `status-pill ${pipeline.active ? "running" : pipeline.ready ? "ready" : "error"}`;
  elements.pipelineStatus.lastChild.textContent = pipeline.active ? " Pipeline running" : pipeline.ready ? " Pipeline ready" : " Setup required";
  elements.runMode.querySelector('option[value="inference"]').disabled = !pipeline.reusableBaseData;
  if (pipeline.reusableBaseData) {
    elements.reusableData.textContent = `Reusable base data: ERA5T ${formatDate(pipeline.reusableBaseData.initializationTime)}`;
    elements.reusableData.classList.add("available");
  } else {
    elements.reusableData.textContent = "No reusable base data yet. Run the full pipeline first.";
    elements.reusableData.classList.remove("available");
  }
  elements.runName.disabled = pipeline.active;
  elements.runMode.disabled = pipeline.active;
  elements.computeDevice.disabled = pipeline.active;
  elements.forecastSteps.disabled = pipeline.active;
  elements.snapshotStorage.textContent = formatBytes(storage.snapshotBytes);
  elements.snapshotDetail.textContent = `${storage.snapshotCount.toLocaleString()} UI snapshots retained`;
  elements.publishedRuns.textContent = storage.runCount.toLocaleString();
  elements.publishedTotal.textContent = `${formatBytes(storage.totalBytes)} total artifacts`;

  const last = runs.find((run) => run.status === "complete" || run.status === "failed");
  elements.lastRun.textContent = last ? formatDate(last.endedAt || last.startedAt) : "—";
  elements.lastRunDetail.textContent = last ? `${capitalize(last.status)} · ${formatDuration(last.durationMs)}` : "No execution history yet";
  if (schedule.enabled && schedule.nextRunAt) {
    elements.nextRun.textContent = formatDate(schedule.nextRunAt);
    elements.nextRunDetail.textContent = `${schedule.mode === "inference" ? "Inference only" : "Full pipeline"} · ${computeLabel(schedule.computeDevice)} · ${schedule.steps} frames · ${schedule.runsPerPeriod} ${schedule.runsPerPeriod === 1 ? "time" : "times"} per ${schedule.period}`;
  } else {
    elements.nextRun.textContent = "Off";
    elements.nextRunDetail.textContent = "No recurring schedule";
  }
  if (!scheduleHydrated) {
    elements.scheduleEnabled.checked = schedule.enabled;
    elements.runName.value = schedule.namePrefix;
    elements.runMode.value = schedule.mode;
    elements.computeDevice.value = schedule.computeDevice || "cpu";
    elements.forecastSteps.value = String(schedule.steps);
    elements.runsPerPeriod.value = schedule.runsPerPeriod;
    elements.schedulePeriod.value = schedule.period;
    updateScheduleLimit();
    scheduleHydrated = true;
  }
  updateRunAvailability();
  renderActive(currentRun);
  if (!elements.history.contains(document.activeElement)) renderHistory(runs);
}

function renderActive(run) {
  elements.activeRun.hidden = !run;
  if (!run) return;
  const stageIndex = Math.max(0, stages.indexOf(run.stage));
  elements.activeTitle.textContent = `${run.name || "Pipeline run"} · ${computeLabel(run.computeDevice)} · ${stageLabels[run.stage] || "Starting pipeline"}…`;
  elements.activeElapsed.textContent = formatDuration(Date.now() - new Date(run.startedAt).getTime());
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
    const actions = document.createElement("td");
    const button = document.createElement("button");
    button.className = "quiet-button";
    button.type = "button";
    button.textContent = "Details";
    button.addEventListener("click", () => showRun(run));
    actions.append(button);
    row.append(actions);
    const values = [
      { text: run.status, className: `run-status ${run.status}` },
      { text: formatDate(run.startedAt) },
      { text: formatDuration(run.durationMs) },
      { text: run.mode === "inference" ? "Reused" : formatDuration(run.downloadDurationMs) },
      { text: formatDuration(run.inferenceDurationMs) },
      { text: run.snapshotBytes == null ? "—" : `${formatBytes(run.snapshotBytes)} · ${run.snapshotCount}` },
      { text: `${capitalize(run.trigger)} · ${run.mode === "inference" ? "Inference only" : "Full pipeline"}` },
      { text: computeLabel(run.computeDevice) },
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
    `Compute ${computeLabel(run.computeDevice)}`,
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
    `${formatBytes(run.snapshotBytes)} snapshots`,
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
function computeLabel(value) { return value === "gpu" ? "GPU · CUDA" : "CPU only"; }

async function startRun() {
  const mode = elements.runMode.value;
  elements.runNow.disabled = true;
  const label = mode === "inference" ? "inference" : "full pipeline";
  setMessage(elements.runMessage, `Starting ${label} on ${computeLabel(elements.computeDevice.value)}…`);
  try {
    await api("/api/admin/runs", {
      method: "POST",
      body: JSON.stringify({
        steps: Number(elements.forecastSteps.value),
        mode,
        computeDevice: elements.computeDevice.value,
        name: elements.runName.value,
      }),
    });
    setMessage(elements.runMessage, `${mode === "inference" ? "Inference" : "Full pipeline"} started. Live timings will appear below.`);
    await refresh();
  } catch (error) {
    setMessage(elements.runMessage, error.message, true);
    if (latestState) render(latestState);
  }
}

elements.runNow.addEventListener("click", startRun);

elements.saveSchedule.addEventListener("click", async () => {
  elements.saveSchedule.disabled = true;
  setMessage(elements.scheduleMessage, "Saving schedule…");
  try {
    const body = {
      enabled: elements.scheduleEnabled.checked,
      namePrefix: elements.runName.value,
      mode: elements.runMode.value,
      computeDevice: elements.computeDevice.value,
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
  const inferenceUnavailable = elements.runMode.value === "inference" && !latestState.pipeline.reusableBaseData;
  elements.runNow.disabled = latestState.pipeline.active || !latestState.pipeline.ready || inferenceUnavailable;
  elements.runNow.title = inferenceUnavailable
    ? "Run the full pipeline first to download base data."
    : "Start one execution using the shared settings.";
}

elements.runMode.addEventListener("change", updateRunAvailability);
elements.schedulePeriod.addEventListener("change", updateScheduleLimit);
elements.refresh.addEventListener("click", refresh);
elements.closeDialog.addEventListener("click", () => elements.logDialog.close());
elements.logDialog.addEventListener("click", (event) => { if (event.target === elements.logDialog) elements.logDialog.close(); });

refresh();
