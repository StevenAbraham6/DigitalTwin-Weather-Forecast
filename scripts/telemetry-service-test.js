const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  TelemetryService,
  counterDeltaMicrojoules,
  cpuUtilization,
  integratedGpuEnergyWh,
  parseAmdEnergyJson,
  parseAmdJson,
  parseNvidiaCsv,
  parseNvidiaEnergyCsv,
} = require("../server/telemetry-service.js");

async function main() {
  assert.equal(cpuUtilization(
    { user: 100, sys: 100, idle: 800 },
    { user: 200, sys: 150, idle: 950 },
  ), 50);

  const nvidia = parseNvidiaCsv("GPU-123, NVIDIA L4, 94, 22000, 23034, 73, 68.5, 72\n");
  assert.equal(nvidia.length, 1);
  assert.equal(nvidia[0].vendor, "nvidia");
  assert.equal(nvidia[0].utilizationPercent, 94);
  assert.equal(nvidia[0].memoryPercent, 95.5);
  assert.equal(nvidia[0].powerWatts, 68.5);
  assert.deepEqual(parseNvidiaEnergyCsv("GPU-123, 7200000\n"), [{
    id: "GPU-123",
    energyMicrojoules: 7200000000,
    maxEnergyMicrojoules: null,
  }]);

  const amd = parseAmdJson(JSON.stringify({
    gpu_0: {
      GPU_NAME: "AMD Radeon AI PRO R9700",
      GFX_UTIL: { value: 88, unit: "%" },
      VRAM_USED: { value: 24576, unit: "MB" },
      VRAM_TOTAL: { value: 32768, unit: "MB" },
      TEMPERATURE_HOTSPOT: { value: 76, unit: "C" },
      CURRENT_SOCKET_POWER: { value: 241, unit: "W" },
    },
  }));
  assert.equal(amd.length, 1);
  assert.equal(amd[0].vendor, "amd");
  assert.equal(amd[0].utilizationPercent, 88);
  assert.equal(amd[0].memoryPercent, 75);
  assert.equal(amd[0].temperatureC, 76);
  assert.deepEqual(parseAmdEnergyJson(JSON.stringify({
    gpu_0: {
      GPU_ID: "amd-0",
      ENERGY: { ENERGY_ACCUMULATOR: 2000000, COUNTER_RESOLUTION: 15.3 },
    },
  })), [{ id: "amd-0", energyMicrojoules: 30600000, maxEnergyMicrojoules: null }]);

  assert.equal(counterDeltaMicrojoules(
    [{ id: "package-0", energyMicrojoules: 950, maxEnergyMicrojoules: 1000 }],
    [{ id: "package-0", energyMicrojoules: 50, maxEnergyMicrojoules: 1000 }],
  ), 100, "CPU energy counters must handle wraparound");
  assert.equal(integratedGpuEnergyWh([
    { sampledAt: "2026-08-23T12:00:02.000Z", gpus: [{ powerWatts: 100 }] },
    { sampledAt: "2026-08-23T12:00:04.000Z", gpus: [{ powerWatts: 200 }] },
  ], "2026-08-23T12:00:00.000Z", "2026-08-23T12:00:06.000Z"), 0.25, "sampled GPU power must cover the run boundaries");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "digital-twin-telemetry-test-"));
  try {
    const service = new TelemetryService({ dataRoot: root, autoStart: false });
    const run = { id: "run-123", nodeId: "node-1", status: "running", stage: "preparation", startedAt: "2026-08-23T12:00:00.000Z" };
    service.setActiveRun(run);
    service.recordSnapshot({
      sampledAt: "2026-08-23T12:00:02.000Z",
      cpu: { utilizationPercent: 50, temperatureC: 60 },
      memory: { utilizationPercent: 40 },
      gpus: [{ id: "gpu-1", utilizationPercent: 25, memoryPercent: 30, temperatureC: 55 }],
    });
    run.stage = "inference";
    service.recordSnapshot({
      sampledAt: "2026-08-23T12:00:04.000Z",
      cpu: { utilizationPercent: 70, temperatureC: 64 },
      memory: { utilizationPercent: 45 },
      gpus: [{ id: "gpu-1", utilizationPercent: 95, memoryPercent: 80, temperatureC: 72 }],
    });
    run.status = "complete";
    run.endedAt = "2026-08-23T12:00:05.000Z";
    await service.finishRun(run);
    assert.equal(run.telemetry.available, true);
    assert.equal(run.telemetry.sampleCount, 2);
    assert.ok(service.has(run.id));
    const document = await service.read(run.id);
    assert.deepEqual(document.samples.map((sample) => sample.stage), ["preparation", "inference"]);
    assert.equal(document.summary.gpuUtilizationPercent.average, 60);
    assert.equal(document.summary.gpuUtilizationPercent.peak, 95);
    service.close();

    const commands = [];
    const configuredService = new TelemetryService({
      dataRoot: root,
      autoStart: false,
      commandRunner: async (command, args) => {
        commands.push({ command, args });
        return { stdout: command === "nvidia-smi" ? "GPU-1, NVIDIA L4, 50, 100, 200, 60, 40, 72\n" : "{}" };
      },
    });
    await configuredService.setGpuConfigs(["cpu_20c"]);
    assert.deepEqual(commands, [], "CPU-only nodes must not invoke GPU telemetry tools");
    await configuredService.setGpuConfigs(["cpu_20c", "gpu_l4"]);
    assert.equal(commands[0].command, "nvidia-smi", "NVIDIA configurations must query only NVIDIA");
    await configuredService.setGpuConfigs(["gpu_amd"]);
    assert.equal(commands[1].command, "amd-smi", "AMD configurations must query only AMD");
    assert.deepEqual(commands[1].args, ["monitor", "-ptumv", "--json"], "single-shot AMD queries must not use iterations without watch mode");
    configuredService.close();

    const cpuEnergyValues = [0, 3_600_000_000, 7_200_000_000];
    const energyService = new TelemetryService({
      dataRoot: root,
      autoStart: false,
      cpuEnergyReader: () => [{
        id: "package-0",
        energyMicrojoules: cpuEnergyValues.shift(),
        maxEnergyMicrojoules: 100_000_000_000,
      }],
    });
    const energyRun = {
      id: "energy-run",
      nodeId: "node-1",
      computeDevice: "cpu",
      status: "running",
      stage: "inference",
      startedAt: new Date(Date.now() - 2_000).toISOString(),
    };
    energyService.setActiveRun(energyRun);
    await energyService.energyStartPromise;
    while (energyService.sampling) await new Promise((resolve) => setImmediate(resolve));
    energyRun.status = "complete";
    energyRun.endedAt = new Date().toISOString();
    await energyService.finishRun(energyRun);
    const energyDocument = await energyService.read(energyRun.id);
    assert.equal(energyDocument.schemaVersion, 2);
    assert.equal(energyDocument.samples[0].energy.cpuEnergyWh, 1);
    assert.equal(energyDocument.summary.energy.cpuEnergyWh, 2);
    assert.equal(energyDocument.summary.energy.gpuEnergyWh, 0);
    assert.equal(energyDocument.summary.energy.totalEnergyWh, 2);
    assert.deepEqual(energyService.latest.gpus, [], "energy accounting must not add fields to heartbeat GPU data");
    energyService.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("CPU, NVIDIA, AMD, energy accounting, run recording, summaries, and compressed telemetry passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
