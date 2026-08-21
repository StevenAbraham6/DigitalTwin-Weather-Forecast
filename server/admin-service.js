const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline");

const EVENT_PREFIX = "@@PIPELINE_EVENT@@";
const MAX_RUNS = 100;
const MAX_LOG_LINES = 500;
const PERIOD_MS = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};

function defaultState() {
  return {
    version: 6,
    schedule: {
      enabled: false,
      runsPerPeriod: 1,
      period: "day",
      mode: "full",
      computeDevice: "cpu",
      steps: 8,
      namePrefix: "Forecast run",
      nextRunAt: null,
      updatedAt: null,
    },
    runs: [],
  };
}

function defaultRunName(mode, trigger, timestamp = new Date().toISOString()) {
  const prefix = trigger === "scheduled"
    ? "Scheduled pipeline"
    : mode === "inference"
      ? "Inference run"
      : "Full pipeline";
  return `${prefix} — ${timestamp.slice(0, 16).replace("T", " ")} UTC`;
}

function validateRunName(value, fallback) {
  if (value == null || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error("Execution name cannot be blank.");
  }
  if (typeof value !== "string") throw new Error("Execution name must be text.");
  const name = value.trim();
  if (!name) throw new Error("Execution name cannot be blank.");
  if (name.length > 100) throw new Error("Execution name must be 100 characters or fewer.");
  return name;
}

function validateRunMode(value) {
  const mode = value ?? "full";
  if (mode !== "full" && mode !== "inference") {
    throw new Error("Run mode must be full or inference.");
  }
  return mode;
}

function validateComputeDevice(value) {
  const computeDevice = value === "gpu" ? "gpu_l4" : value ?? "cpu";
  if (!["cpu", "gpu_l4", "gpu_amd"].includes(computeDevice)) {
    throw new Error("Compute device must be cpu, gpu_l4, or gpu_amd.");
  }
  return computeDevice;
}

function validateForecastSteps(value) {
  const steps = Number(value ?? 8);
  if (!Number.isInteger(steps) || steps < 1 || steps > 40) {
    throw new Error("Forecast steps must be a whole number from 1 to 40.");
  }
  return steps;
}

function validateScheduleNamePrefix(value) {
  if (typeof value !== "string") throw new Error("Scheduled execution name must be text.");
  const namePrefix = value.trim();
  if (!namePrefix) throw new Error("Scheduled execution name cannot be blank.");
  if (namePrefix.length > 70) throw new Error("Scheduled execution name must be 70 characters or fewer.");
  return namePrefix;
}

function scheduledRunName(namePrefix, timestamp = new Date().toISOString()) {
  return `${namePrefix} — ${timestamp.slice(0, 16).replace("T", " ")} UTC`;
}

function initializationFromDirectory(name) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/.exec(name);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00Z` : null;
}

function findReusableBaseData(workDir, runs = []) {
  for (const run of runs) {
    if (run.mode !== "inference" && run.baseDataPath && run.initializationTime && fs.existsSync(run.baseDataPath)) {
      return {
        path: path.resolve(run.baseDataPath),
        initializationTime: run.initializationTime,
        sourceRunId: run.id,
      };
    }
  }
  let directories = [];
  try {
    directories = fs.readdirSync(workDir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const candidates = directories
    .filter((entry) => entry.isDirectory() && initializationFromDirectory(entry.name))
    .sort((left, right) => right.name.localeCompare(left.name));
  for (const entry of candidates) {
    const candidate = path.join(workDir, entry.name, "prepared-graphcast-small-1deg.nc");
    if (!fs.existsSync(candidate)) continue;
    const initializationTime = initializationFromDirectory(entry.name);
    const sourceRun = runs.find((run) => run.initializationTime === initializationTime && run.mode !== "inference");
    return { path: candidate, initializationTime, sourceRunId: sourceRun?.id || null };
  }
  return null;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`Could not read ${filePath}: ${error.message}`);
    return fallback;
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function durationMs(start, end = new Date().toISOString()) {
  return Math.max(0, new Date(end).getTime() - new Date(start).getTime());
}

function nextScheduledTime(schedule, from = Date.now()) {
  if (!schedule.enabled) return null;
  const interval = PERIOD_MS[schedule.period] / schedule.runsPerPeriod;
  let candidate = schedule.nextRunAt ? new Date(schedule.nextRunAt).getTime() : from + interval;
  if (!Number.isFinite(candidate)) candidate = from + interval;
  while (candidate <= from) candidate += interval;
  return new Date(candidate).toISOString();
}

function validateSchedule(input) {
  const enabled = Boolean(input?.enabled);
  const period = input?.period === "week" ? "week" : "day";
  const runsPerPeriod = Number(input?.runsPerPeriod);
  const limit = period === "day" ? 24 : 168;
  if (!Number.isInteger(runsPerPeriod) || runsPerPeriod < 1 || runsPerPeriod > limit) {
    throw new Error(`Runs per ${period} must be a whole number from 1 to ${limit}.`);
  }
  const mode = validateRunMode(input?.mode);
  const computeDevice = validateComputeDevice(input?.computeDevice);
  const steps = validateForecastSteps(input?.steps);
  const namePrefix = validateScheduleNamePrefix(input?.namePrefix ?? "Forecast run");
  return { enabled, period, runsPerPeriod, mode, computeDevice, steps, namePrefix };
}

function safeNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

async function directoryStats(root) {
  const result = { totalBytes: 0, snapshotBytes: 0, snapshotCount: 0, runCount: 0 };
  const runsRoot = path.join(root, "models", "google-graphcast-small", "runs");
  const visit = async (directory) => {
    let entries;
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    await Promise.all(entries.map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return visit(filePath);
      if (!entry.isFile()) return undefined;
      const stat = await fs.promises.stat(filePath);
      result.totalBytes += stat.size;
      if (/\.(?:bin|json)$/.test(entry.name) && filePath.includes(`${path.sep}ui-surface${path.sep}`)) {
        result.snapshotBytes += stat.size;
        result.snapshotCount += 1;
      }
      return undefined;
    }));
  };
  try {
    result.runCount = (await fs.promises.readdir(runsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).length;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await visit(root);
  return result;
}

function summarizeRunStorage(runDir) {
  const result = { artifactBytes: 0, snapshotBytes: 0, snapshotCount: 0 };
  if (!runDir || !fs.existsSync(runDir)) return result;
  const stack = [runDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(filePath);
      else if (entry.isFile()) {
        const size = fs.statSync(filePath).size;
        result.artifactBytes += size;
        if (/\.(?:bin|json)$/.test(entry.name) && filePath.includes(`${path.sep}ui-surface${path.sep}`)) {
          result.snapshotBytes += size;
          result.snapshotCount += 1;
        }
      }
    }
  }
  return result;
}

function collectBody(request, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body is too large."));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        return resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        return reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

class AdminService {
  constructor({ projectRoot, publishRoot }) {
    this.projectRoot = projectRoot;
    this.pipelineRoot = path.join(projectRoot, "pipeline");
    this.publishRoot = publishRoot;
    this.workDir = path.join(this.pipelineRoot, "output", "era5t-graphcast-small");
    this.statePath = path.join(this.pipelineRoot, "admin-data", "state.json");
    const loadedState = readJson(this.statePath, defaultState());
    this.state = {
      ...defaultState(),
      ...loadedState,
      version: 6,
      schedule: { ...defaultState().schedule, ...loadedState.schedule },
      runs: Array.isArray(loadedState.runs) ? loadedState.runs : [],
    };
    this.state.schedule.computeDevice = validateComputeDevice(this.state.schedule.computeDevice);
    for (const run of this.state.runs) {
      run.mode ||= "full";
      run.computeDevice = validateComputeDevice(run.computeDevice);
      run.name ||= defaultRunName(run.mode, run.trigger, run.startedAt || run.queuedAt);
    }
    this.activeProcess = null;
    this._recoverInterruptedRuns();
    this.scheduleTimer = setInterval(() => this._tickSchedule(), 15_000);
    this.scheduleTimer.unref();
  }

  close() {
    clearInterval(this.scheduleTimer);
  }

  _recoverInterruptedRuns() {
    const endedAt = new Date().toISOString();
    let changed = false;
    for (const run of this.state.runs) {
      if (run.status === "running" || run.status === "queued") {
        run.status = "failed";
        run.endedAt = endedAt;
        run.durationMs = durationMs(run.startedAt || run.queuedAt, endedAt);
        run.error = "The app server stopped before this execution completed.";
        changed = true;
      }
    }
    if (changed) this._save();
  }

  _save() {
    this.state.runs = this.state.runs.slice(0, MAX_RUNS);
    atomicWriteJson(this.statePath, this.state);
  }

  async status() {
    const storage = await directoryStats(this.publishRoot);
    const python = this._pythonCommand();
    const current = this.state.runs.find((run) => run.status === "running" || run.status === "queued") || null;
    const reusableBaseData = findReusableBaseData(this.workDir, this.state.runs);
    return {
      serverTime: new Date().toISOString(),
      pipeline: {
        ready: fs.existsSync(python),
        python,
        publishRoot: path.relative(this.projectRoot, this.publishRoot),
        active: Boolean(this.activeProcess),
        reusableBaseData: reusableBaseData ? {
          initializationTime: reusableBaseData.initializationTime,
          sourceRunId: reusableBaseData.sourceRunId,
        } : null,
      },
      schedule: this.state.schedule,
      storage,
      currentRun: current,
      runs: this.state.runs,
    };
  }

  _pythonCommand() {
    return process.env.PIPELINE_PYTHON || path.join(this.pipelineRoot, ".venv", "bin", "python");
  }

  async handleRequest(request, response, pathname) {
    if (pathname === "/api/admin/status" && request.method === "GET") {
      this._sendJson(response, 200, await this.status());
      return true;
    }
    if (pathname === "/api/admin/runs" && request.method === "POST") {
      try {
        this._assertSameOrigin(request);
        const body = await collectBody(request);
        const run = this.startRun("manual", {
          steps: body.steps,
          mode: body.mode,
          computeDevice: body.computeDevice,
          name: body.name,
        });
        this._sendJson(response, 202, { run });
      } catch (error) {
        this._sendJson(response, ["RUN_ACTIVE", "NO_BASE_DATA"].includes(error.code) ? 409 : 400, { error: error.message });
      }
      return true;
    }
    const runMatch = /^\/api\/admin\/runs\/([^/]+)$/.exec(pathname);
    if (runMatch && request.method === "PATCH") {
      try {
        this._assertSameOrigin(request);
        const run = this.state.runs.find((candidate) => candidate.id === runMatch[1]);
        if (!run) {
          this._sendJson(response, 404, { error: "Execution not found." });
          return true;
        }
        const body = await collectBody(request);
        run.name = validateRunName(body.name);
        this._save();
        this._sendJson(response, 200, { run });
      } catch (error) {
        this._sendJson(response, 400, { error: error.message });
      }
      return true;
    }
    if (pathname === "/api/admin/schedule" && request.method === "PUT") {
      try {
        this._assertSameOrigin(request);
        const input = validateSchedule(await collectBody(request));
        if (input.enabled && input.mode === "inference" && !findReusableBaseData(this.workDir, this.state.runs)) {
          throw new Error("An inference-only schedule requires base data from a previous full pipeline run.");
        }
        this.state.schedule = {
          ...input,
          nextRunAt: input.enabled ? nextScheduledTime({ ...input, nextRunAt: null }) : null,
          updatedAt: new Date().toISOString(),
        };
        this._save();
        this._sendJson(response, 200, { schedule: this.state.schedule });
      } catch (error) {
        this._sendJson(response, 400, { error: error.message });
      }
      return true;
    }
    return false;
  }

  _assertSameOrigin(request) {
    if (request.headers["content-type"] !== "application/json") {
      throw new Error("Admin changes require an application/json request.");
    }
    const origin = request.headers.origin;
    if (origin && new URL(origin).host !== request.headers.host) {
      throw new Error("Cross-origin admin changes are not allowed.");
    }
  }

  _sendJson(response, status, value) {
    const body = JSON.stringify(value);
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  }

  _tickSchedule() {
    const schedule = this.state.schedule;
    if (!schedule.enabled || !schedule.nextRunAt) return;
    if (Date.now() < new Date(schedule.nextRunAt).getTime()) return;
    schedule.nextRunAt = nextScheduledTime(schedule);
    this._save();
    if (!this.activeProcess) {
      try {
        this.startRun("scheduled", {
          mode: schedule.mode,
          computeDevice: schedule.computeDevice,
          steps: schedule.steps,
          name: scheduledRunName(schedule.namePrefix),
        });
      } catch (error) {
        console.error(`Could not start scheduled pipeline: ${error.message}`);
      }
    }
  }

  startRun(trigger, options = {}) {
    if (this.activeProcess) {
      const error = new Error("A pipeline execution is already running.");
      error.code = "RUN_ACTIVE";
      throw error;
    }
    const python = this._pythonCommand();
    if (!fs.existsSync(python)) {
      throw new Error("Pipeline environment is not installed. Run npm run pipeline:setup first.");
    }
    const steps = validateForecastSteps(options.steps);
    const now = new Date().toISOString();
    const mode = validateRunMode(options.mode);
    const computeDevice = validateComputeDevice(options.computeDevice);
    const reusableBaseData = mode === "inference" ? findReusableBaseData(this.workDir, this.state.runs) : null;
    if (mode === "inference" && !reusableBaseData) {
      const error = new Error("Inference-only requires base data from a previous full pipeline run.");
      error.code = "NO_BASE_DATA";
      throw error;
    }
    const run = {
      id: crypto.randomUUID(),
      name: validateRunName(options.name, defaultRunName(mode, trigger, now)),
      trigger,
      mode,
      computeDevice,
      baseSourceRunId: reusableBaseData?.sourceRunId || null,
      status: "queued",
      stage: "starting",
      steps,
      queuedAt: now,
      startedAt: now,
      endedAt: null,
      durationMs: null,
      downloadDurationMs: null,
      preparationDurationMs: null,
      inferenceDurationMs: null,
      inferenceTimings: [],
      inferenceBackend: null,
      inferenceDevice: null,
      publishDurationMs: null,
      snapshotBytes: null,
      snapshotCount: null,
      artifactBytes: null,
      initializationTime: null,
      publishedRunId: null,
      error: null,
      logs: [],
      skippedStages: [],
    };
    const computeDescriptions = {
      cpu: "CPU (JAX platform: cpu)",
      gpu_l4: "GPU L4 (JAX platform: cuda)",
      gpu_amd: "GPU AMD Radeon AI PRO R9700 (JAX platform: rocm)",
    };
    run.logs.push({
      at: now,
      source: "stdout",
      message: `Compute target: ${computeDescriptions[computeDevice]}`,
    });
    this.state.runs.unshift(run);
    this._save();

    const runner = path.join(this.pipelineRoot, "scripts", "run_admin_pipeline.py");
    const args = [
      runner,
      "--mode", mode,
      "--compute-device", computeDevice,
      "--execution-id", run.id,
      "--steps", String(steps),
      "--work-dir", this.workDir,
      "--publish-dir", this.publishRoot,
    ];
    if (reusableBaseData) {
      args.push(
        "--base-data", reusableBaseData.path,
        "--initialization-time", reusableBaseData.initializationTime,
      );
    }
    const child = spawn(python, args, {
      cwd: this.pipelineRoot,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PYTHONPATH: [path.join(this.pipelineRoot, "src"), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.activeProcess = child;
    run.status = "running";
    this._save();
    this._captureOutput(run, child.stdout, "stdout");
    this._captureOutput(run, child.stderr, "stderr");
    child.on("error", (error) => this._finishRun(run, 1, error));
    child.on("close", (code) => this._finishRun(run, code, null));
    return run;
  }

  _captureOutput(run, stream, source) {
    const lines = readline.createInterface({ input: stream });
    lines.on("line", (line) => {
      if (line.startsWith(EVENT_PREFIX)) {
        try {
          this._applyEvent(run, JSON.parse(line.slice(EVENT_PREFIX.length)));
          return;
        } catch (error) {
          this._appendLog(run, "stderr", `Could not parse pipeline event: ${error.message}`);
        }
      }
      this._appendLog(run, source, line);
    });
  }

  _appendLog(run, source, message) {
    run.logs.push({ at: new Date().toISOString(), source, message });
    if (run.logs.length > MAX_LOG_LINES) run.logs.splice(0, run.logs.length - MAX_LOG_LINES);
    this._save();
  }

  _applyEvent(run, event) {
    if (event.type === "stage") {
      run.stage = event.stage;
      if (event.status === "complete") run[`${event.stage}DurationMs`] = safeNumber(event.durationMs);
      if (event.status === "skipped" && !run.skippedStages.includes(event.stage)) run.skippedStages.push(event.stage);
    } else if (event.type === "metadata") {
      if (event.initializationTime) run.initializationTime = event.initializationTime;
      if (event.runId) run.publishedRunId = event.runId;
      if (event.runDir) run.runDir = event.runDir;
      if (event.baseDataPath) run.baseDataPath = event.baseDataPath;
      if (event.inferenceBackend) run.inferenceBackend = String(event.inferenceBackend).slice(0, 30);
      if (event.inferenceDevice) run.inferenceDevice = String(event.inferenceDevice).slice(0, 200);
    } else if (event.type === "inference_timing") {
      const name = typeof event.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,49}$/.test(event.name)
        ? event.name
        : null;
      const duration = safeNumber(event.durationMs);
      if (name && duration !== null) {
        if (!Array.isArray(run.inferenceTimings)) run.inferenceTimings = [];
        const timing = {
          name,
          label: typeof event.label === "string" ? event.label.slice(0, 100) : name,
          durationMs: duration,
        };
        const existing = run.inferenceTimings.findIndex((entry) => entry.name === name);
        if (existing === -1) run.inferenceTimings.push(timing);
        else run.inferenceTimings[existing] = timing;
      }
    }
    this._save();
  }

  _finishRun(run, code, processError) {
    if (run.status === "complete" || run.status === "failed") return;
    this.activeProcess = null;
    run.endedAt = new Date().toISOString();
    run.durationMs = durationMs(run.startedAt, run.endedAt);
    run.stage = code === 0 ? "complete" : "failed";
    run.status = code === 0 ? "complete" : "failed";
    if (processError) run.error = processError.message;
    else if (code !== 0) {
      run.error = [...run.logs].reverse().find((line) => line.source === "stderr")?.message
        || `Pipeline exited with status ${code}.`;
    }
    if (code === 0 && run.runDir) Object.assign(run, summarizeRunStorage(run.runDir));
    this._save();
  }
}

module.exports = {
  AdminService,
  defaultRunName,
  directoryStats,
  findReusableBaseData,
  nextScheduledTime,
  scheduledRunName,
  validateComputeDevice,
  validateForecastSteps,
  validateRunMode,
  validateRunName,
  validateScheduleNamePrefix,
  validateSchedule,
};
