const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const {
  defaultRunName,
  AdminService,
  directoryStats,
  findReusableBaseData,
  nextScheduledTime,
  scheduledRunName,
  validateComputeDevice,
  validateForecastSteps,
  validateRunMode,
  validateRunName,
  validateSchedule,
  validateScheduleNamePrefix,
} = require("../server/admin-service.js");

async function adminRequest(service, method, pathname, body) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  request.method = method;
  request.headers = { "content-type": "application/json", host: "localhost" };
  let status;
  let responseBody;
  const ended = new Promise((resolve) => {
    const response = {
      writeHead(value) { status = value; },
      end(value) { responseBody = JSON.parse(value); resolve(); },
    };
    service.handleRequest(request, response, pathname);
  });
  await ended;
  return { status, body: responseBody };
}

async function main() {
  assert.deepEqual(validateSchedule({ enabled: true, runsPerPeriod: 4, period: "day" }), {
    enabled: true,
    runsPerPeriod: 4,
    period: "day",
    mode: "full",
    computeDevice: "cpu",
    steps: 8,
    namePrefix: "Forecast run",
  });
  assert.deepEqual(validateSchedule({
    enabled: true,
    runsPerPeriod: 2,
    period: "week",
    mode: "inference",
    computeDevice: "gpu_amd",
    steps: 20,
    namePrefix: "Weekend model",
  }), {
    enabled: true,
    runsPerPeriod: 2,
    period: "week",
    mode: "inference",
    computeDevice: "gpu_amd",
    steps: 20,
    namePrefix: "Weekend model",
  });
  assert.throws(() => validateSchedule({ enabled: true, runsPerPeriod: 25, period: "day" }), /1 to 24/);
  assert.equal(
    nextScheduledTime({ enabled: true, runsPerPeriod: 4, period: "day", nextRunAt: null }, Date.parse("2026-08-19T00:00:00Z")),
    "2026-08-19T06:00:00.000Z",
  );
  assert.equal(nextScheduledTime({ enabled: false, runsPerPeriod: 1, period: "day" }), null);
  assert.equal(validateRunMode(undefined), "full");
  assert.equal(validateRunMode("inference"), "inference");
  assert.throws(() => validateRunMode("download"), /full or inference/);
  assert.equal(validateComputeDevice(undefined), "cpu");
  assert.equal(validateComputeDevice("gpu_l4"), "gpu_l4");
  assert.equal(validateComputeDevice("gpu_amd"), "gpu_amd");
  assert.equal(validateComputeDevice("gpu"), "gpu_l4");
  assert.throws(() => validateComputeDevice("tpu"), /cpu, gpu_l4, or gpu_amd/);
  assert.throws(
    () => validateSchedule({ enabled: true, runsPerPeriod: 1, period: "day", computeDevice: "tpu" }),
    /cpu, gpu_l4, or gpu_amd/,
  );
  assert.equal(validateForecastSteps(12), 12);
  assert.throws(() => validateForecastSteps(0), /1 to 40/);
  assert.equal(validateScheduleNamePrefix("  Nightly forecast  "), "Nightly forecast");
  assert.throws(() => validateScheduleNamePrefix(" "), /cannot be blank/);
  assert.equal(
    scheduledRunName("Nightly forecast", "2026-08-20T03:15:00.000Z"),
    "Nightly forecast — 2026-08-20 03:15 UTC",
  );
  assert.equal(validateRunName("  Hurricane rerun  "), "Hurricane rerun");
  assert.equal(validateRunName("", "Fallback"), "Fallback");
  assert.throws(() => validateRunName(" "), /cannot be blank/);
  assert.equal(
    defaultRunName("inference", "manual", "2026-08-20T03:15:00.000Z"),
    "Inference run — 2026-08-20 03:15 UTC",
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "digital-twin-admin-test-"));
  try {
    const snapshots = path.join(root, "models", "google-graphcast-small", "runs", "run-1", "data", "ui-surface");
    fs.mkdirSync(snapshots, { recursive: true });
    fs.writeFileSync(path.join(snapshots, "t+0.bin"), Buffer.alloc(16));
    fs.writeFileSync(path.join(snapshots, "t+6.bin"), Buffer.alloc(20));
    fs.writeFileSync(path.join(snapshots, "legacy.json"), Buffer.alloc(4));
    fs.writeFileSync(path.join(root, "catalog.json"), "{}\n");
    const stats = await directoryStats(root);
    assert.deepEqual(stats, { totalBytes: 43, snapshotBytes: 40, snapshotCount: 3, runCount: 1 });

    const workDir = path.join(root, "work");
    const baseDir = path.join(workDir, "20260814T0000Z");
    const basePath = path.join(baseDir, "prepared-graphcast-small-1deg.nc");
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(basePath, "prepared");
    assert.deepEqual(findReusableBaseData(workDir, []), {
      path: basePath,
      initializationTime: "2026-08-14T00:00:00Z",
      sourceRunId: null,
    });
    assert.deepEqual(findReusableBaseData(workDir, [{
      id: "run-1",
      mode: "full",
      initializationTime: "2026-08-14T00:00:00Z",
      baseDataPath: basePath,
    }]), {
      path: basePath,
      initializationTime: "2026-08-14T00:00:00Z",
      sourceRunId: "run-1",
    });

    const inferenceOnly = findReusableBaseData(workDir, [{
      id: "inference-1",
      mode: "inference",
      initializationTime: "2026-08-14T00:00:00Z",
      baseDataPath: basePath,
    }]);
    assert.equal(inferenceOnly.sourceRunId, null);

    const emptyProject = path.join(root, "empty-project");
    const fakePython = path.join(emptyProject, "pipeline", ".venv", "bin", "python");
    fs.mkdirSync(path.dirname(fakePython), { recursive: true });
    fs.writeFileSync(fakePython, "");
    const service = new AdminService({ projectRoot: emptyProject, publishRoot: path.join(emptyProject, "forecasts") });
    try {
      assert.equal(service._pythonCommand("cpu"), fakePython);
      assert.equal(
        service._pythonCommand("gpu_amd"),
        path.join(emptyProject, "pipeline", ".venv-amd", "bin", "python"),
      );
      assert.throws(
        () => service.startRun("manual", { mode: "full", computeDevice: "gpu_amd", steps: 8 }),
        /npm run pipeline:setup:amd/,
      );
      const timingRun = { inferenceTimings: [] };
      service._applyEvent(timingRun, {
        type: "inference_timing",
        name: "jaxCompilation",
        label: "JAX lower and compile",
        durationMs: 1234,
      });
      assert.deepEqual(timingRun.inferenceTimings, [{
        name: "jaxCompilation",
        label: "JAX lower and compile",
        durationMs: 1234,
      }]);
      service._applyEvent(timingRun, {
        type: "inference_timing",
        name: "jaxCompilation",
        label: "JAX lower and compile",
        durationMs: 1500,
      });
      assert.equal(timingRun.inferenceTimings.length, 1);
      assert.equal(timingRun.inferenceTimings[0].durationMs, 1500);

      assert.throws(
        () => service.startRun("manual", { mode: "inference", steps: 8 }),
        /requires base data from a previous full pipeline run/,
      );
      assert.equal(service.state.runs.length, 0);
      const blockedInferenceSchedule = await adminRequest(service, "PUT", "/api/admin/schedule", {
        enabled: true,
        namePrefix: "Scheduled inference",
        mode: "inference",
        computeDevice: "gpu_amd",
        steps: 8,
        runsPerPeriod: 1,
        period: "day",
      });
      assert.equal(blockedInferenceSchedule.status, 400);
      assert.match(blockedInferenceSchedule.body.error, /requires base data/);
      const savedFullSchedule = await adminRequest(service, "PUT", "/api/admin/schedule", {
        enabled: true,
        namePrefix: "Nightly model",
        mode: "full",
        computeDevice: "gpu_amd",
        steps: 12,
        runsPerPeriod: 2,
        period: "day",
      });
      assert.equal(savedFullSchedule.status, 200);
      assert.equal(savedFullSchedule.body.schedule.mode, "full");
      assert.equal(savedFullSchedule.body.schedule.computeDevice, "gpu_amd");
      assert.equal(savedFullSchedule.body.schedule.steps, 12);
      assert.equal(savedFullSchedule.body.schedule.namePrefix, "Nightly model");
      service.state.runs.push({
        id: "rename-me",
        name: "Original name",
        mode: "full",
        trigger: "manual",
        status: "complete",
        logs: [],
      });
      const renamed = await adminRequest(service, "PATCH", "/api/admin/runs/rename-me", { name: "  Custom audit name  " });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      assert.equal(renamed.body.run.name, "Custom audit name");
      const blankName = await adminRequest(service, "PATCH", "/api/admin/runs/rename-me", { name: " " });
      assert.equal(blankName.status, 400);
      assert.equal(service.state.runs[0].name, "Custom audit name");
      const queued = service.queueRun("manual", { mode: "full", computeDevice: "cpu", steps: 8, name: "Waiting forecast" });
      assert.equal(queued.status, "queued");
      assert.equal(queued.startedAt, null);
      assert.throws(
        () => service.queueRun("manual", { mode: "full", computeDevice: "cpu", steps: 8 }),
        /already running/,
      );
      service._recoverInterruptedRuns();
      assert.equal(queued.status, "queued", "intentional queued runs must survive app recovery");
      const canceledQueue = await adminRequest(service, "POST", `/api/admin/runs/${queued.id}/cancel`, {});
      assert.equal(canceledQueue.status, 202);
      assert.equal(canceledQueue.body.run.status, "canceled");
      assert.equal(service.activeProcess, null);
      const activeStartedAt = new Date().toISOString();
      service.state.runs.unshift(
        { id: "active-1", name: "Active one", mode: "full", computeDevice: "cpu", trigger: "manual", status: "running", startedAt: activeStartedAt, logs: [] },
        { id: "active-2", name: "Active two", mode: "full", computeDevice: "cpu", trigger: "manual", status: "queued", startedAt: activeStartedAt, logs: [] },
      );
      const multiRunStatus = await service.status();
      assert.deepEqual(multiRunStatus.activeRuns.map((run) => run.id), ["active-1", "active-2"]);
      assert.equal(multiRunStatus.currentRun.id, "active-1");
      const signals = [];
      service.activeRunId = "active-1";
      service.activeProcess = { kill(signal) { signals.push(signal); return true; } };
      const canceled = await adminRequest(service, "POST", "/api/admin/runs/active-1/cancel", {});
      assert.equal(canceled.status, 202);
      assert.ok(canceled.body.run.cancelRequestedAt);
      assert.deepEqual(signals, ["SIGTERM"]);
      service._finishRun(service.state.runs.find((run) => run.id === "active-1"), null, null);
      assert.equal(service.state.runs.find((run) => run.id === "active-1").status, "canceled");
      const repeatedCancel = await adminRequest(service, "POST", "/api/admin/runs/active-1/cancel", {});
      assert.equal(repeatedCancel.status, 409);
    } finally {
      service.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("Admin run controls, cancellation lifecycle, schedule validation, and storage accounting passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
