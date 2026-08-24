const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");
const zlib = require("node:zlib");
const { execFile } = require("node:child_process");

const execFileAsync = util.promisify(execFile);
const gzipAsync = util.promisify(zlib.gzip);
const gunzipAsync = util.promisify(zlib.gunzip);
const SAMPLE_INTERVAL_MS = 2_000;
const MAX_SAMPLES = 10_000;

function finite(value) {
  const number = Number(String(value ?? "").replace(/[^0-9+-.]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function percent(value) {
  const number = finite(value);
  return number === null ? null : Math.max(0, Math.min(100, number));
}

function cpuTimes(cpus = os.cpus()) {
  return cpus.reduce((total, cpu) => {
    for (const [name, value] of Object.entries(cpu.times)) total[name] = (total[name] || 0) + value;
    return total;
  }, {});
}

function cpuUtilization(previous, current) {
  if (!previous || !current) return null;
  const names = new Set([...Object.keys(previous), ...Object.keys(current)]);
  let total = 0;
  for (const name of names) total += Math.max(0, (current[name] || 0) - (previous[name] || 0));
  const idle = Math.max(0, (current.idle || 0) - (previous.idle || 0));
  return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : null;
}

function parseNvidiaCsv(stdout) {
  return String(stdout || "").trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const fields = line.split(",").map((field) => field.trim());
    const memoryUsedMb = finite(fields[3]);
    const memoryTotalMb = finite(fields[4]);
    return {
      id: fields[0] || null,
      vendor: "nvidia",
      name: fields[1] || "NVIDIA GPU",
      utilizationPercent: percent(fields[2]),
      memoryUsedBytes: memoryUsedMb === null ? null : Math.round(memoryUsedMb * 1024 * 1024),
      memoryTotalBytes: memoryTotalMb === null ? null : Math.round(memoryTotalMb * 1024 * 1024),
      memoryPercent: memoryUsedMb !== null && memoryTotalMb ? Math.round(memoryUsedMb / memoryTotalMb * 1000) / 10 : null,
      temperatureC: finite(fields[5]),
      powerWatts: finite(fields[6]),
      powerLimitWatts: finite(fields[7]),
    };
  });
}

function flattenObject(value, prefix = "", result = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ("value" in value && Object.keys(value).some((key) => /unit/i.test(key))) result[prefix] = value.value;
    for (const [key, nested] of Object.entries(value)) flattenObject(nested, prefix ? `${prefix}.${key}` : key, result);
  } else if (!Array.isArray(value)) result[prefix] = value;
  return result;
}

function fieldByPattern(flat, patterns) {
  for (const pattern of patterns) {
    const entry = Object.entries(flat).find(([key]) => pattern.test(key.replace(/[^a-z0-9]/gi, "").toLowerCase()));
    if (entry) return entry[1];
  }
  return null;
}

function amdGpuEntries(parsed) {
  if (Array.isArray(parsed)) return parsed;
  const direct = Object.entries(parsed || {}).filter(([key, value]) => (/gpu|card|device/i.test(key) || /^\d+$/.test(key)) && value && typeof value === "object");
  if (direct.length) return direct.map(([key, value]) => ({ __key: key, ...value }));
  return parsed && typeof parsed === "object" ? [parsed] : [];
}

function parseAmdJson(stdout) {
  let parsed;
  try { parsed = JSON.parse(String(stdout || "{}")); } catch { return []; }
  return amdGpuEntries(parsed).map((gpu, index) => {
    const flat = flattenObject(gpu);
    const usedMb = finite(fieldByPattern(flat, [/vramused/, /memoryused/, /memusageused/]));
    const totalMb = finite(fieldByPattern(flat, [/vramtotal/, /memorytotal/, /memusagetotal/]));
    return {
      id: String(fieldByPattern(flat, [/uuid$/, /bdf$/, /^gpuid$/, /^gpu$/]) ?? gpu.__key ?? index),
      vendor: "amd",
      name: String(fieldByPattern(flat, [/marketname/, /productname/, /gpuname/, /^name$/]) || "AMD GPU"),
      utilizationPercent: percent(fieldByPattern(flat, [/averagegfxactivity/, /gfxutil/, /gpuutil/, /gfxactivity/])),
      memoryUsedBytes: usedMb === null ? null : Math.round(usedMb * 1024 * 1024),
      memoryTotalBytes: totalMb === null ? null : Math.round(totalMb * 1024 * 1024),
      memoryPercent: usedMb !== null && totalMb ? Math.round(usedMb / totalMb * 1000) / 10 : percent(fieldByPattern(flat, [/memutil/, /memoryutil/])),
      temperatureC: finite(fieldByPattern(flat, [/temperaturehotspot/, /hotspottemperature/, /temperatureedge/, /gputemp/, /temperature/])),
      powerWatts: finite(fieldByPattern(flat, [/currentsocketpower/, /averagesocketpower/, /powerusage/, /socketpower/])),
      powerLimitWatts: finite(fieldByPattern(flat, [/powerlimit/])),
    };
  });
}

function readCpuTemperature() {
  if (process.platform !== "linux") return null;
  const readings = [];
  let devices = [];
  try { devices = fs.readdirSync("/sys/class/hwmon"); } catch { /* no hwmon */ }
  for (const device of devices) {
    const base = path.join("/sys/class/hwmon", device);
    let name = "";
    try { name = fs.readFileSync(path.join(base, "name"), "utf8").trim(); } catch { /* unnamed sensor */ }
    if (!/coretemp|k10temp|zenpower|cpu/i.test(name)) continue;
    let files = [];
    try { files = fs.readdirSync(base); } catch { continue; }
    for (const file of files.filter((candidate) => /^temp\d+_input$/.test(candidate))) {
      try {
        const raw = finite(fs.readFileSync(path.join(base, file), "utf8"));
        const temperature = raw !== null && raw > 1000 ? raw / 1000 : raw;
        if (temperature !== null && temperature > 0 && temperature < 130) readings.push(temperature);
      } catch { /* best-effort sensor */ }
    }
  }
  return readings.length ? Math.round(Math.max(...readings) * 10) / 10 : null;
}

function systemMemory() {
  if (process.platform === "linux") {
    try {
      const values = Object.fromEntries(fs.readFileSync("/proc/meminfo", "utf8").trim().split(/\r?\n/).map((line) => {
        const [name, value] = line.split(":");
        return [name, finite(value)];
      }));
      if (values.MemTotal && values.MemAvailable !== null) {
        const totalBytes = values.MemTotal * 1024;
        const usedBytes = Math.max(0, totalBytes - values.MemAvailable * 1024);
        return { totalBytes, usedBytes };
      }
    } catch { /* fall through to Node's portable values */ }
  }
  const totalBytes = os.totalmem();
  return { totalBytes, usedBytes: Math.max(0, totalBytes - os.freemem()) };
}

function telemetrySummary(samples) {
  const metrics = {
    cpuUtilizationPercent: samples.map((sample) => sample.cpu.utilizationPercent),
    systemMemoryPercent: samples.map((sample) => sample.memory.utilizationPercent),
    cpuTemperatureC: samples.map((sample) => sample.cpu.temperatureC),
    gpuUtilizationPercent: samples.flatMap((sample) => sample.gpus.map((gpu) => gpu.utilizationPercent)),
    gpuMemoryPercent: samples.flatMap((sample) => sample.gpus.map((gpu) => gpu.memoryPercent)),
    gpuTemperatureC: samples.flatMap((sample) => sample.gpus.map((gpu) => gpu.temperatureC)),
  };
  const summary = {};
  for (const [name, values] of Object.entries(metrics)) {
    const valid = values.filter(Number.isFinite);
    summary[name] = valid.length ? {
      average: Math.round(valid.reduce((sum, value) => sum + value, 0) / valid.length * 10) / 10,
      peak: Math.max(...valid),
    } : null;
  }
  return summary;
}

class TelemetryService {
  constructor({ dataRoot, intervalMs = SAMPLE_INTERVAL_MS, commandRunner = execFileAsync, autoStart = true } = {}) {
    this.root = path.join(dataRoot, "execution-telemetry");
    this.intervalMs = intervalMs;
    this.commandRunner = commandRunner;
    this.previousCpuTimes = null;
    this.latest = null;
    this.gpuCollectors = new Set();
    this.activeRun = null;
    this.samples = [];
    this.sampling = false;
    this.timer = null;
    fs.mkdirSync(this.root, { recursive: true });
    if (autoStart) {
      this.sample();
      this.timer = setInterval(() => this.sample(), intervalMs);
      this.timer.unref();
    }
  }

  close() { if (this.timer) clearInterval(this.timer); }

  setGpuConfigs(configs = []) {
    this.gpuCollectors = new Set([
      ...(configs.includes("gpu_l4") ? ["nvidia"] : []),
      ...(configs.includes("gpu_amd") ? ["amd"] : []),
    ]);
    if (this.sampling) {
      const timer = setTimeout(() => this.sample(), 0);
      timer.unref();
      return Promise.resolve(this.latest);
    }
    return this.sample();
  }

  setActiveRun(run) {
    if (this.activeRun?.id === run.id) return;
    this.activeRun = run;
    this.samples = [];
    this.sample();
  }

  updateRun(run) { if (this.activeRun?.id === run.id) this.activeRun = run; }

  async sample() {
    if (this.sampling) return this.latest;
    this.sampling = true;
    try {
      const cpus = os.cpus();
      const currentTimes = cpuTimes(cpus);
      const utilizationPercent = cpuUtilization(this.previousCpuTimes, currentTimes);
      this.previousCpuTimes = currentTimes;
      const [nvidia, amd] = await Promise.all([
        this.gpuCollectors.has("nvidia") ? this.collectNvidia() : [],
        this.gpuCollectors.has("amd") ? this.collectAmd() : [],
      ]);
      const { totalBytes: totalMemoryBytes, usedBytes: usedMemoryBytes } = systemMemory();
      const snapshot = {
        sampledAt: new Date().toISOString(),
        cpu: {
          model: cpus[0]?.model?.trim() || os.arch(),
          logicalCores: cpus.length,
          utilizationPercent,
          frequencyMHz: cpus.length ? Math.round(cpus.reduce((sum, cpu) => sum + (cpu.speed || 0), 0) / cpus.length) : null,
          temperatureC: readCpuTemperature(),
        },
        memory: {
          usedBytes: usedMemoryBytes,
          totalBytes: totalMemoryBytes,
          utilizationPercent: totalMemoryBytes ? Math.round(usedMemoryBytes / totalMemoryBytes * 1000) / 10 : null,
        },
        gpus: [...nvidia, ...amd],
      };
      this.latest = snapshot;
      this.recordSnapshot(snapshot);
      return snapshot;
    } finally {
      this.sampling = false;
    }
  }

  async collectNvidia() {
    try {
      const { stdout } = await this.commandRunner("nvidia-smi", [
        "--query-gpu=uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit",
        "--format=csv,noheader,nounits",
      ], { timeout: 1_500, maxBuffer: 512 * 1024 });
      return parseNvidiaCsv(stdout);
    } catch { return []; }
  }

  async collectAmd() {
    try {
      const { stdout } = await this.commandRunner("amd-smi", ["monitor", "-ptumv", "--json", "--iterations", "1"], { timeout: 1_500, maxBuffer: 1024 * 1024 });
      return parseAmdJson(stdout);
    } catch { return []; }
  }

  recordSnapshot(snapshot) {
    if (!this.activeRun || this.activeRun.status !== "running" || this.samples.length >= MAX_SAMPLES) return;
    const started = new Date(this.activeRun.startedAt).getTime();
    this.samples.push({
      elapsedMs: Math.max(0, new Date(snapshot.sampledAt).getTime() - started),
      sampledAt: snapshot.sampledAt,
      stage: this.activeRun.stage || "starting",
      cpu: snapshot.cpu,
      memory: snapshot.memory,
      gpus: snapshot.gpus.map((gpu) => ({
        id: gpu.id,
        vendor: gpu.vendor,
        name: gpu.name,
        utilizationPercent: gpu.utilizationPercent,
        memoryUsedBytes: gpu.memoryUsedBytes,
        memoryTotalBytes: gpu.memoryTotalBytes,
        memoryPercent: gpu.memoryPercent,
        temperatureC: gpu.temperatureC,
      })),
    });
  }

  async finishRun(run) {
    if (this.activeRun?.id !== run.id || !this.samples.length) {
      if (this.activeRun?.id === run.id) this.activeRun = null;
      return null;
    }
    const samples = this.samples;
    this.activeRun = null;
    this.samples = [];
    const document = {
      schemaVersion: 1,
      runId: run.id,
      nodeId: run.nodeId || null,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      sampleIntervalMs: this.intervalMs,
      samples,
      summary: telemetrySummary(samples),
    };
    const content = await gzipAsync(Buffer.from(JSON.stringify(document)));
    await fs.promises.writeFile(this.filePath(run.id), content);
    run.telemetry = {
      available: true,
      sampleCount: samples.length,
      sampleIntervalMs: this.intervalMs,
      summary: document.summary,
    };
    return run.telemetry;
  }

  filePath(runId) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(String(runId))) throw new Error("Invalid execution ID.");
    return path.join(this.root, `${runId}.json.gz`);
  }

  has(runId) { try { return fs.existsSync(this.filePath(runId)); } catch { return false; } }
  readCompressed(runId) { return fs.promises.readFile(this.filePath(runId)); }
  writeCompressed(runId, content) { return fs.promises.writeFile(this.filePath(runId), content); }
  async read(runId) { return JSON.parse((await gunzipAsync(await this.readCompressed(runId))).toString("utf8")); }
}

module.exports = {
  TelemetryService,
  cpuTimes,
  cpuUtilization,
  parseAmdJson,
  parseNvidiaCsv,
  telemetrySummary,
};
