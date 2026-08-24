const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const zlib = require("node:zlib");
const {
  ClusterService,
  computeDeviceFor,
  normalizeMasterUrl,
  validateProfile,
} = require("../server/cluster-service.js");

class FakeAdminService {
  constructor() {
    this.runs = [];
    this.callbacks = {};
  }
  setCallbacks(callbacks) { this.callbacks = callbacks; }
  async status() {
    const localActive = this.runs.some((run) => run.id === "local" && ["queued", "running"].includes(run.status));
    return {
      pipeline: { ready: true, active: localActive, reusableBaseData: null },
      schedule: { enabled: false },
      storage: { totalBytes: 0, snapshotBytes: 0, snapshotCount: 0, runCount: 0 },
      runs: this.runs,
    };
  }
  startRun(trigger, options) {
    const run = { id: "local", trigger, status: "running", stage: "inference", startedAt: new Date().toISOString(), logs: [], ...options };
    this.upsertExternalRun(run);
    return run;
  }
  queueRun(trigger, options) {
    const run = { id: "local-queued", trigger, status: "queued", queuedAt: new Date().toISOString(), startedAt: null, logs: [], ...options };
    this.upsertExternalRun(run);
    return run;
  }
  startQueuedRun(runId) {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run) {
      const error = new Error("Execution not found.");
      error.code = "RUN_NOT_FOUND";
      throw error;
    }
    run.status = "running";
    run.startedAt = new Date().toISOString();
    return run;
  }
  cancelRun(runId) {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run) {
      const error = new Error("Execution not found.");
      error.code = "RUN_NOT_FOUND";
      throw error;
    }
    run.cancelRequestedAt = new Date().toISOString();
    run.status = "canceled";
    run.stage = "canceled";
    return run;
  }
  upsertExternalRun(run) { this.runs = [run, ...this.runs.filter((candidate) => candidate.id !== run.id)]; return run; }
}

async function call(service, method, pathname, body, headers = {}) {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const request = Readable.from(payload.length ? [payload] : []);
  request.method = method;
  request.url = pathname;
  request.headers = { host: "localhost:8080", ...(body === undefined || Buffer.isBuffer(body) ? {} : { "content-type": "application/json" }), ...headers };
  let status;
  let responseBody;
  const response = {
    writeHead(value) { status = value; },
    end(value) { responseBody = value ? JSON.parse(value) : null; },
  };
  assert.equal(await service.handleRequest(request, response, new URL(pathname, "http://local").pathname), true);
  return { status, body: responseBody };
}

async function main() {
  assert.equal(normalizeMasterUrl("192.168.1.10:8090"), "http://192.168.1.10:8090");
  assert.equal(computeDeviceFor("cpu_32c"), "cpu");
  assert.equal(computeDeviceFor("gpu_l4"), "gpu_l4");
  assert.throws(() => validateProfile({ role: "slave", name: "Edge", serverModel: "XE130c M8", config: ["cpu_12c"] }), /Master server/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "digital-twin-cluster-test-"));
  try {
    const publishRoot = path.join(root, "published");
    fs.mkdirSync(publishRoot, { recursive: true });
    const admin = new FakeAdminService();
    const master = new ClusterService({ projectRoot: root, publishRoot, adminService: admin, publicUrl: () => "http://127.0.0.1:8080" });
    try {
      assert.equal(master.isConfigured(), false, "saved profiles must still require confirmation for each process start");
      master.configure({ role: "master", name: "Primary", serverModel: "XE150c M8", config: ["cpu_20c", "gpu_l4"] });
      const slaveProfile = { id: "slave-1", role: "slave", name: "Edge 1", serverModel: "XE130c M8", config: ["cpu_12c", "gpu_amd"], masterUrl: "http://127.0.0.1:8080" };
      const heartbeatTelemetry = {
        sampledAt: new Date().toISOString(),
        cpu: { model: "AMD EPYC", logicalCores: 24, utilizationPercent: 42, temperatureC: 58 },
        memory: { usedBytes: 64, totalBytes: 128, utilizationPercent: 50 },
        gpus: [{ id: "gpu-1", vendor: "amd", name: "R9700", utilizationPercent: 75, memoryPercent: 60, temperatureC: 70 }],
      };
      const registered = await call(master, "POST", "/api/cluster/register", { profile: slaveProfile, baseUrl: "http://127.0.0.1:8081", pipeline: { ready: true }, telemetry: heartbeatTelemetry });
      assert.equal(registered.status, 200);
      assert.ok(registered.body.token);
      const nodes = await master.status();
      assert.deepEqual(nodes.nodes.map((node) => node.name), ["Primary", "Edge 1"]);
      assert.equal(nodes.nodes[1].telemetry.cpu.utilizationPercent, 42);
      assert.deepEqual(master.validateCompute(nodes.nodes[1], "gpu_amd"), { computeConfig: "gpu_amd", computeDevice: "gpu_amd" });

      const originalFetch = global.fetch;
      let dispatched;
      try {
        global.fetch = async (url, options) => {
          dispatched = { url: String(url), options };
          if (String(url).endsWith("/api/cluster/runs/remote-trigger/cancel")) {
            return new Response(JSON.stringify({ run: {
              id: "remote-trigger",
              nodeId: "slave-1",
              nodeName: "Edge 1",
              status: "running",
              cancelRequestedAt: new Date().toISOString(),
              logs: [],
            } }), { status: 202, headers: { "Content-Type": "application/json" } });
          }
          return new Response(JSON.stringify({ run: { id: "remote-trigger", nodeId: "slave-1", nodeName: "Edge 1", status: "queued", logs: [] } }), {
            status: 202,
            headers: { "Content-Type": "application/json" },
          });
        };
        const remoteRun = await master.startRun("manual", { nodeId: "slave-1", computeConfig: "gpu_amd", mode: "full", steps: 8, name: "Dispatched" });
        assert.equal(remoteRun.id, "remote-trigger");
        assert.equal(dispatched.url, "http://127.0.0.1:8081/api/cluster/trigger");
        assert.equal(JSON.parse(dispatched.options.body).options.computeDevice, "gpu_amd");
        assert.equal(dispatched.options.headers.Authorization, `Bearer ${registered.body.token}`);
        await assert.rejects(
          master.startRun("manual", { nodeId: "slave-1", computeConfig: "gpu_amd", mode: "full", steps: 8 }),
          /already running/,
        );
        const localRun = await master.startRun("manual", { nodeId: master.profile.id, computeConfig: "gpu_l4", mode: "full", steps: 8, name: "Local concurrent run" });
        assert.equal(localRun.id, "local");
        const concurrentStatus = await master.status();
        assert.equal(concurrentStatus.activeRuns.length, 2);
        assert.deepEqual(concurrentStatus.nodes.map((node) => node.active), [true, true]);

        const localStop = await call(master, "POST", "/api/admin/runs/local/cancel", {});
        assert.equal(localStop.status, 202);
        assert.equal(localStop.body.run.status, "canceled");
        const remoteStop = await call(master, "POST", "/api/admin/runs/remote-trigger/cancel", {});
        assert.equal(remoteStop.status, 202);
        assert.ok(remoteStop.body.run.cancelRequestedAt);
        assert.equal(dispatched.url, "http://127.0.0.1:8081/api/cluster/runs/remote-trigger/cancel");
        assert.equal(dispatched.options.headers.Authorization, `Bearer ${registered.body.token}`);
      } finally {
        global.fetch = originalFetch;
      }

      for (const run of admin.runs) run.status = "complete";

      const queuedLocal = await call(master, "POST", "/api/admin/runs", {
        queueOnly: true,
        nodeId: master.profile.id,
        computeConfig: "gpu_l4",
        mode: "full",
        steps: 8,
        name: "Queued locally",
      });
      assert.equal(queuedLocal.status, 202);
      assert.equal(queuedLocal.body.run.status, "queued");
      assert.equal((await master.status()).nodes[0].active, true, "a queue reservation must mark its node busy");
      const blockedByQueue = await call(master, "POST", "/api/admin/runs", {
        queueOnly: true,
        nodeId: master.profile.id,
        computeConfig: "gpu_l4",
        mode: "full",
        steps: 8,
      });
      assert.equal(blockedByQueue.status, 409);
      const startedQueue = await call(master, "POST", `/api/admin/runs/${queuedLocal.body.run.id}/start`, {});
      assert.equal(startedQueue.status, 202);
      assert.equal(startedQueue.body.run.status, "running");
      startedQueue.body.run.status = "complete";
      admin.runs.find((run) => run.id === startedQueue.body.run.id).status = "complete";

      const updated = await call(master, "PUT", "/api/cluster/runs/run-1", {
        run: { id: "run-1", nodeId: "slave-1", name: "Remote forecast", status: "running", logs: [{ at: new Date().toISOString(), source: "stdout", message: "Inference" }] },
      }, { authorization: `Bearer ${registered.body.token}` });
      assert.equal(updated.status, 200);
      assert.equal(admin.runs[0].nodeName, "Edge 1");

      const telemetryDocument = {
        schemaVersion: 1,
        runId: "run-1",
        nodeId: "slave-1",
        sampleIntervalMs: 2000,
        samples: [{ elapsedMs: 0, stage: "inference", cpu: { utilizationPercent: 50 }, memory: { utilizationPercent: 40 }, gpus: [] }],
        summary: {},
      };
      const telemetryUpload = await call(master, "PUT", "/api/cluster/telemetry/run-1", zlib.gzipSync(JSON.stringify(telemetryDocument)), {
        authorization: `Bearer ${registered.body.token}`,
        "content-type": "application/gzip",
      });
      assert.equal(telemetryUpload.status, 200);
      const telemetryRead = await call(master, "GET", "/api/admin/runs/run-1/telemetry");
      assert.equal(telemetryRead.status, 200);
      assert.equal(telemetryRead.body.samples[0].stage, "inference");

      const slaveAdmin = new FakeAdminService();
      slaveAdmin.runs.push({ id: "slave-local", nodeId: "slave-1", status: "running", logs: [] });
      const slave = new ClusterService({
        projectRoot: root,
        publishRoot,
        adminService: slaveAdmin,
        publicUrl: () => "http://127.0.0.1:8081",
        dataRoot: path.join(root, "slave-admin-data"),
      });
      try {
        slave.profile = slaveProfile;
        slave.masterToken = registered.body.token;
        const unauthorizedStop = await call(slave, "POST", "/api/cluster/runs/slave-local/cancel", {}, { authorization: "Bearer wrong-token" });
        assert.equal(unauthorizedStop.status, 401);
        const authorizedStop = await call(slave, "POST", "/api/cluster/runs/slave-local/cancel", {}, { authorization: `Bearer ${registered.body.token}` });
        assert.equal(authorizedStop.status, 202);
        assert.equal(authorizedStop.body.run.status, "canceled");
      } finally {
        slave.close();
      }

      const incoming = path.join(master.forecastRoot, "slave-1", ".incoming", "run-1");
      fs.mkdirSync(path.join(incoming, "data", "ui-surface"), { recursive: true });
      fs.writeFileSync(path.join(incoming, "manifest.json"), JSON.stringify({ schemaVersion: "2.0", runId: "forecast-1", uiSurface: { files: [{ path: "data/ui-surface/t+0.bin" }] } }));
      fs.writeFileSync(path.join(incoming, "data", "ui-surface", "t+0.bin"), Buffer.alloc(16));
      master.completeUploadedForecast("slave-1", "run-1", "forecast-1");
      assert.ok(fs.existsSync(path.join(master.forecastRoot, "slave-1", "catalog.json")));
      assert.match(master.resolveForecastPath("/node-forecasts/slave-1/catalog.json"), /catalog\.json$/);
    } finally {
      master.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("Node profile, concurrent execution, cancellation routing, progress ingestion, compute mapping, and forecast transfer passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
