const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
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
    return {
      pipeline: { ready: true, active: false, reusableBaseData: null },
      schedule: { enabled: false },
      storage: { totalBytes: 0, snapshotBytes: 0, snapshotCount: 0, runCount: 0 },
      runs: this.runs,
    };
  }
  startRun(trigger, options) { return { id: "local", trigger, ...options }; }
  upsertExternalRun(run) { this.runs = [run, ...this.runs.filter((candidate) => candidate.id !== run.id)]; return run; }
}

async function call(service, method, pathname, body, headers = {}) {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const request = Readable.from(payload.length ? [payload] : []);
  request.method = method;
  request.url = pathname;
  request.headers = { host: "localhost:8080", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers };
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
      const registered = await call(master, "POST", "/api/cluster/register", { profile: slaveProfile, baseUrl: "http://127.0.0.1:8081", pipeline: { ready: true } });
      assert.equal(registered.status, 200);
      assert.ok(registered.body.token);
      const nodes = await master.status();
      assert.deepEqual(nodes.nodes.map((node) => node.name), ["Primary", "Edge 1"]);
      assert.deepEqual(master.validateCompute(nodes.nodes[1], "gpu_amd"), { computeConfig: "gpu_amd", computeDevice: "gpu_amd" });

      const originalFetch = global.fetch;
      let dispatched;
      try {
        global.fetch = async (url, options) => {
          dispatched = { url: String(url), options };
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
      } finally {
        global.fetch = originalFetch;
      }

      const updated = await call(master, "PUT", "/api/cluster/runs/run-1", {
        run: { id: "run-1", nodeId: "slave-1", name: "Remote forecast", status: "running", logs: [{ at: new Date().toISOString(), source: "stdout", message: "Inference" }] },
      }, { authorization: `Bearer ${registered.body.token}` });
      assert.equal(updated.status, 200);
      assert.equal(admin.runs[0].nodeName, "Edge 1");

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
  console.log("Node profile, registration, progress ingestion, compute mapping, and forecast transfer passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
