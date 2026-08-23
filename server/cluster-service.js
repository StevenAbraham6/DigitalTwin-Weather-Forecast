const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const NODE_MODELS = ["XE130c M8", "XE150c M8"];
const NODE_CONFIGS = ["cpu_12c", "cpu_20c", "cpu_32c", "gpu_amd", "gpu_l4"];
const CONFIG_LABELS = {
  cpu_12c: "CPU 12c",
  cpu_20c: "CPU 20c",
  cpu_32c: "CPU 32c",
  gpu_amd: "GPU AMD Radeon AI PRO R9700",
  gpu_l4: "GPU Nvidia L4",
};
const MAX_SLAVES = 3;
const ONLINE_WINDOW_MS = 20_000;

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
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
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function collectJson(request, maxBytes) {
  const body = await collectBody(request, maxBytes);
  if (!body.length) return {};
  try { return JSON.parse(body.toString("utf8")); } catch { throw new Error("Request body must be valid JSON."); }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function sameOrigin(request) {
  if (request.headers["content-type"] !== "application/json") throw new Error("Admin changes require an application/json request.");
  const origin = request.headers.origin;
  if (origin && new URL(origin).host !== request.headers.host) throw new Error("Cross-origin admin changes are not allowed.");
}

function normalizeMasterUrl(value) {
  let text = String(value || "").trim();
  if (!text) throw new Error("Master server IP or URL is required for a slave node.");
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  const url = new URL(text);
  if (!url.hostname || (url.protocol !== "http:" && url.protocol !== "https:")) throw new Error("Enter a valid master server IP or URL.");
  return url.origin;
}

function validateProfile(input, existingId) {
  const role = input?.role;
  if (role !== "master" && role !== "slave") throw new Error("Choose master or slave node.");
  const name = String(input?.name || "").trim();
  if (!name || name.length > 60) throw new Error("Node name is required and must be 60 characters or fewer.");
  const serverModel = String(input?.serverModel || "");
  if (!NODE_MODELS.includes(serverModel)) throw new Error("Choose a supported server model.");
  const config = [...new Set(Array.isArray(input?.config) ? input.config : [])];
  if (!config.length || config.some((item) => !NODE_CONFIGS.includes(item))) throw new Error("Choose at least one supported compute configuration.");
  return {
    id: existingId || crypto.randomUUID(),
    role,
    name,
    serverModel,
    config,
    masterUrl: role === "slave" ? normalizeMasterUrl(input.masterUrl) : null,
  };
}

function computeDeviceFor(config) {
  if (config === "gpu_amd") return "gpu_amd";
  if (config === "gpu_l4") return "gpu_l4";
  if (String(config).startsWith("cpu_")) return "cpu";
  throw new Error("The selected compute option is not available on this node.");
}

function publicNode(profile, extra = {}) {
  return {
    id: profile.id,
    role: profile.role,
    name: profile.name,
    serverModel: profile.serverModel,
    config: profile.config,
    configLabels: profile.config.map((item) => CONFIG_LABELS[item]),
    ...extra,
  };
}

function safeRelativeFile(value) {
  const normalized = path.posix.normalize(String(value || "").replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) return null;
  return normalized;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), ...options });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text || `Request failed (${response.status})` }; }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

class ClusterService {
  constructor({ projectRoot, publishRoot, adminService, publicUrl, dataRoot = null }) {
    this.projectRoot = projectRoot;
    this.publishRoot = publishRoot;
    this.adminService = adminService;
    this.publicUrl = publicUrl;
    this.dataRoot = dataRoot || path.join(projectRoot, "pipeline", "admin-data");
    this.profilePath = path.join(this.dataRoot, "node-profile.json");
    this.registryPath = path.join(this.dataRoot, "cluster-registry.json");
    this.forecastRoot = path.join(this.dataRoot, "node-forecasts");
    this.savedProfile = readJson(this.profilePath, { id: crypto.randomUUID(), role: "master", name: "Master", serverModel: "XE130c M8", config: ["cpu_12c"] });
    this.profile = null;
    this.masterToken = null;
    this.registry = new Map(Object.entries(readJson(this.registryPath, {})));
    for (const entry of this.registry.values()) entry.lastSeen = null;
    this.registrationTimer = null;
    this.reportTimers = new Map();
    adminService.setCallbacks({
      onRunUpdated: (run, finished) => this.reportRun(run, finished),
      onScheduleRun: (trigger, options) => this.startRun(trigger, options),
      onValidateSchedule: (schedule, body) => this.validateScheduledRun(schedule, body),
      canSchedule: () => this.isConfigured(),
      runMetadata: () => this.profile ? this.nodeMetadata(this.profile) : {},
    });
  }

  close() {
    if (this.registrationTimer) clearInterval(this.registrationTimer);
    for (const timer of this.reportTimers.values()) clearTimeout(timer);
  }

  isMaster() { return this.profile?.role === "master"; }
  isSlave() { return this.profile?.role === "slave"; }
  isConfigured() { return Boolean(this.profile); }

  nodeMetadata(profile) {
    return { nodeId: profile.id, nodeName: profile.name, serverModel: profile.serverModel, nodeConfig: profile.config };
  }

  configure(input) {
    const profile = validateProfile(input, this.savedProfile.id);
    this.savedProfile = profile;
    this.profile = profile;
    writeJson(this.profilePath, profile);
    this.masterToken = null;
    if (this.registrationTimer) clearInterval(this.registrationTimer);
    if (this.isSlave()) {
      this.registerWithMaster();
      this.registrationTimer = setInterval(() => this.registerWithMaster(), 5_000);
      this.registrationTimer.unref();
    }
    return profile;
  }

  localNode(status) {
    const profile = this.profile;
    const activeRun = status.runs.find((run) => (
      ["queued", "running"].includes(run.status)
      && (!run.nodeId || run.nodeId === profile.id)
    ));
    return publicNode(profile, {
      self: true,
      connected: true,
      lastSeen: new Date().toISOString(),
      pipelineReady: status.pipeline.ready,
      active: Boolean(activeRun || status.pipeline.active),
      activeRunId: activeRun?.id || null,
      reusableBaseData: status.pipeline.reusableBaseData,
      forecastAvailable: fs.existsSync(path.join(this.publishRoot, "catalog.json")),
    });
  }

  nodes(status) {
    if (!this.profile) return [];
    const nodes = [this.localNode(status)];
    if (!this.isMaster()) return nodes;
    for (const entry of this.registry.values()) {
      const connected = Boolean(entry.lastSeen && Date.now() - new Date(entry.lastSeen).getTime() < ONLINE_WINDOW_MS);
      const activeRun = status.runs.find((run) => ["queued", "running"].includes(run.status) && run.nodeId === entry.profile.id);
      nodes.push(publicNode(entry.profile, {
        self: false,
        connected,
        lastSeen: entry.lastSeen,
        pipelineReady: Boolean(entry.pipeline?.ready),
        active: Boolean(activeRun || entry.pipeline?.active),
        activeRunId: activeRun?.id || null,
        reusableBaseData: entry.pipeline?.reusableBaseData || null,
        forecastAvailable: fs.existsSync(path.join(this.forecastRoot, entry.profile.id, "catalog.json")),
      }));
    }
    return nodes;
  }

  async status() {
    const status = await this.adminService.status();
    if (!this.profile) return { ...status, configured: false, savedProfile: this.savedProfile, node: null, nodes: [] };
    const nodes = this.nodes(status);
    const activeRuns = status.runs.filter((run) => run.status === "running" || run.status === "queued");
    const currentRun = activeRuns[0] || null;
    return {
      ...status,
      configured: true,
      savedProfile: this.savedProfile,
      node: publicNode(this.profile),
      nodes,
      currentRun,
      activeRuns,
      pipeline: { ...status.pipeline, active: nodes.some((node) => node.active) },
    };
  }

  findNode(nodeId, status) {
    return this.nodes(status).find((node) => node.id === nodeId);
  }

  validateCompute(node, computeConfig) {
    const selected = computeConfig || node.config[0];
    if (!node.config.includes(selected)) throw new Error(`Compute ${CONFIG_LABELS[selected] || selected} is not configured on ${node.name}.`);
    return { computeConfig: selected, computeDevice: computeDeviceFor(selected) };
  }

  async validateScheduledRun(schedule, body) {
    const status = await this.adminService.status();
    const node = this.findNode(body.nodeId || this.profile.id, status);
    if (!node || !node.connected) throw new Error("The scheduled node is not connected.");
    const compute = this.validateCompute(node, body.computeConfig);
    schedule.computeDevice = compute.computeDevice;
    if (schedule.enabled && schedule.mode === "inference" && !node.reusableBaseData) throw new Error("An inference-only schedule requires base data from a previous full pipeline run on that node.");
  }

  async startRun(trigger, options = {}) {
    return this.createRun(trigger, options, false);
  }

  async queueRun(trigger, options = {}) {
    return this.createRun(trigger, options, true);
  }

  async createRun(trigger, options = {}, queueOnly = false) {
    if (!this.profile) throw new Error("Configure this server as a master or slave node first.");
    const status = await this.adminService.status();
    const nodeId = options.nodeId || this.profile.id;
    const node = this.findNode(nodeId, status);
    if (!node) throw new Error("Selected node was not found.");
    if (!node.connected) throw new Error(`${node.name} is offline.`);
    if (node.active) {
      const error = new Error(`${node.name} is already running a pipeline execution.`);
      error.code = "RUN_ACTIVE";
      throw error;
    }
    const compute = this.validateCompute(node, options.computeConfig);
    const runOptions = { ...options, ...compute, nodeId };
    if (nodeId === this.profile.id) return queueOnly
      ? this.adminService.queueRun(trigger, runOptions)
      : this.adminService.startRun(trigger, runOptions);
    if (!this.isMaster()) throw new Error("Only a master node can trigger another node.");
    const entry = this.registry.get(nodeId);
    const result = await requestJson(`${entry.baseUrl}/api/cluster/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${entry.token}` },
      body: JSON.stringify({ trigger: "master", options: runOptions, queueOnly }),
    });
    return this.adminService.upsertExternalRun(result.run);
  }

  async startQueuedRun(runId) {
    if (!this.profile) throw new Error("Configure this server as a master or slave node first.");
    const status = await this.adminService.status();
    const run = status.runs.find((candidate) => candidate.id === runId);
    if (!run) {
      const error = new Error("Execution not found.");
      error.code = "RUN_NOT_FOUND";
      throw error;
    }
    if (run.status !== "queued") throw new Error("This pipeline execution is not queued.");
    const nodeId = run.nodeId || this.profile.id;
    if (nodeId === this.profile.id) return this.adminService.startQueuedRun(runId);
    if (!this.isMaster()) throw new Error("Only a master node can start another node's queued execution.");
    const entry = this.registry.get(nodeId);
    const node = this.findNode(nodeId, status);
    if (!entry || !node?.connected) throw new Error("The queued execution node is offline.");
    const result = await requestJson(`${entry.baseUrl}/api/cluster/runs/${encodeURIComponent(runId)}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${entry.token}` },
      body: "{}",
    });
    return this.adminService.upsertExternalRun(result.run);
  }

  async cancelRun(runId) {
    if (!this.profile) throw new Error("Configure this server as a master or slave node first.");
    const status = await this.adminService.status();
    const run = status.runs.find((candidate) => candidate.id === runId);
    if (!run) {
      const error = new Error("Execution not found.");
      error.code = "RUN_NOT_FOUND";
      throw error;
    }
    if (!["queued", "running"].includes(run.status)) {
      const error = new Error("This pipeline execution is no longer running.");
      error.code = "RUN_NOT_ACTIVE";
      throw error;
    }
    const nodeId = run.nodeId || this.profile.id;
    if (nodeId === this.profile.id) return this.adminService.cancelRun(runId);
    if (!this.isMaster()) throw new Error("Only a master node can stop another node's execution.");
    const entry = this.registry.get(nodeId);
    if (!entry) throw new Error("The execution node was not found.");
    const node = this.findNode(nodeId, status);
    if (!node?.connected) throw new Error("The execution node is offline, so the stop request could not be delivered.");
    const result = await requestJson(`${entry.baseUrl}/api/cluster/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${entry.token}` },
      body: "{}",
    });
    return this.adminService.upsertExternalRun(result.run);
  }

  authorized(request, token) {
    const candidate = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token || !candidate) return false;
    const candidateBytes = Buffer.from(candidate);
    const tokenBytes = Buffer.from(token);
    return candidateBytes.length === tokenBytes.length && crypto.timingSafeEqual(candidateBytes, tokenBytes);
  }

  registryEntryForRequest(request, nodeId) {
    const entry = this.registry.get(nodeId);
    return entry && this.authorized(request, entry.token) ? entry : null;
  }

  saveRegistry() {
    const serializable = {};
    for (const [id, entry] of this.registry) serializable[id] = entry;
    writeJson(this.registryPath, serializable);
  }

  async registerWithMaster() {
    if (!this.isSlave()) return;
    try {
      const status = await this.adminService.status();
      const result = await requestJson(`${this.profile.masterUrl}/api/cluster/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: this.profile,
          baseUrl: this.publicUrl(),
          pipeline: { ready: status.pipeline.ready, active: status.pipeline.active, reusableBaseData: status.pipeline.reusableBaseData },
        }),
      });
      this.masterToken = result.token;
    } catch (error) {
      console.warn(`Master registration failed: ${error.message}`);
    }
  }

  reportRun(run, finished) {
    if (!this.isSlave()) return;
    const existing = this.reportTimers.get(run.id);
    if (existing) clearTimeout(existing);
    const send = () => {
      this.reportTimers.delete(run.id);
      this.sendRunToMaster(run, finished).catch((error) => console.warn(`Could not send execution update to master: ${error.message}`));
    };
    if (finished) send();
    else this.reportTimers.set(run.id, setTimeout(send, 750));
  }

  async sendRunToMaster(run, finished) {
    if (!this.masterToken) await this.registerWithMaster();
    if (!this.masterToken) throw new Error("Slave is not registered with the master.");
    await requestJson(`${this.profile.masterUrl}/api/cluster/runs/${encodeURIComponent(run.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.masterToken}` },
      body: JSON.stringify({ run: { ...run, ...this.nodeMetadata(this.profile) } }),
    });
    if (finished && run.status === "complete" && run.runDir) await this.uploadForecast(run);
  }

  async uploadForecast(run) {
    const manifestPath = path.join(run.runDir, "manifest.json");
    const manifest = readJson(manifestPath, null);
    if (!manifest) throw new Error("Completed run has no readable forecast manifest.");
    const files = ["manifest.json", ...(manifest.uiSurface?.files || []).map((file) => file.path)].filter(Boolean);
    for (const relative of files) {
      const safe = safeRelativeFile(relative);
      if (!safe) throw new Error("Forecast manifest contains an unsafe artifact path.");
      const content = await fs.promises.readFile(path.join(run.runDir, safe));
      const response = await fetch(`${this.profile.masterUrl}/api/cluster/results/${encodeURIComponent(run.id)}/file?path=${encodeURIComponent(safe)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", Authorization: `Bearer ${this.masterToken}` },
        body: content,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Artifact upload failed (${response.status}).`);
    }
    await requestJson(`${this.profile.masterUrl}/api/cluster/results/${encodeURIComponent(run.id)}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.masterToken}` },
      body: JSON.stringify({ publishedRunId: run.publishedRunId || manifest.runId }),
    });
  }

  completeUploadedForecast(nodeId, executionId, publishedRunId) {
    const staging = path.join(this.forecastRoot, nodeId, ".incoming", executionId);
    const manifest = readJson(path.join(staging, "manifest.json"), null);
    const runId = safeRelativeFile(publishedRunId || manifest?.runId);
    if (!manifest || !runId || runId.includes("/")) throw new Error("Uploaded forecast manifest is invalid.");
    const nodeRoot = path.join(this.forecastRoot, nodeId);
    const runRoot = path.join(nodeRoot, "models", "google-graphcast-small", "runs", runId);
    fs.mkdirSync(path.dirname(runRoot), { recursive: true });
    if (fs.existsSync(runRoot)) fs.rmSync(runRoot, { recursive: true, force: true });
    fs.renameSync(staging, runRoot);
    writeJson(path.join(nodeRoot, "catalog.json"), {
      schemaVersion: "2.0",
      models: [{ id: "google-graphcast-small", provider: "Google DeepMind", displayName: "Google GraphCast Small", latestManifestPath: "models/google-graphcast-small/latest/manifest.json" }],
    });
    writeJson(path.join(nodeRoot, "models", "google-graphcast-small", "latest", "manifest.json"), {
      schemaVersion: manifest.schemaVersion,
      runId,
      manifestPath: `../runs/${runId}/manifest.json`,
    });
  }

  resolveForecastPath(pathname) {
    const match = /^\/node-forecasts\/([^/]+)(\/.*)?$/.exec(pathname);
    if (!match || !this.isMaster()) return null;
    const nodeId = decodeURIComponent(match[1]);
    if (!this.registry.has(nodeId)) return null;
    const root = path.resolve(this.forecastRoot, nodeId);
    const target = path.resolve(root, `.${match[2] || "/"}`);
    return target === root || target.startsWith(`${root}${path.sep}`) ? target : null;
  }

  async handleRequest(request, response, pathname) {
    if (pathname === "/api/node/config" && request.method === "GET") {
      sendJson(response, 200, { configured: this.isConfigured(), profile: this.profile, savedProfile: this.savedProfile, models: NODE_MODELS, configs: NODE_CONFIGS.map((id) => ({ id, label: CONFIG_LABELS[id] })) });
      return true;
    }
    if (pathname === "/api/node/config" && request.method === "PUT") {
      try { sameOrigin(request); sendJson(response, 200, { profile: this.configure(await collectJson(request)) }); }
      catch (error) { sendJson(response, 400, { error: error.message }); }
      return true;
    }
    if (pathname === "/api/admin/status" && request.method === "GET") {
      sendJson(response, 200, await this.status());
      return true;
    }
    if (pathname === "/api/nodes" && request.method === "GET") {
      const status = await this.adminService.status();
      sendJson(response, 200, { configured: this.isConfigured(), nodes: this.isConfigured() ? this.nodes(status) : [] });
      return true;
    }
    if (pathname === "/api/admin/runs" && request.method === "POST") {
      try { sameOrigin(request); const body = await collectJson(request); sendJson(response, 202, { run: await (body.queueOnly ? this.queueRun("manual", body) : this.startRun("manual", body)) }); }
      catch (error) { sendJson(response, error.code === "RUN_ACTIVE" || /active|running|base data/i.test(error.message) ? 409 : 400, { error: error.message }); }
      return true;
    }
    const adminStart = /^\/api\/admin\/runs\/([^/]+)\/start$/.exec(pathname);
    if (adminStart && request.method === "POST") {
      try {
        sameOrigin(request);
        sendJson(response, 202, { run: await this.startQueuedRun(decodeURIComponent(adminStart[1])) });
      } catch (error) {
        sendJson(response, error.code === "RUN_NOT_FOUND" ? 404 : 409, { error: error.message });
      }
      return true;
    }
    const adminCancel = /^\/api\/admin\/runs\/([^/]+)\/cancel$/.exec(pathname);
    if (adminCancel && request.method === "POST") {
      try {
        sameOrigin(request);
        sendJson(response, 202, { run: await this.cancelRun(decodeURIComponent(adminCancel[1])) });
      } catch (error) {
        sendJson(response, error.code === "RUN_NOT_FOUND" ? 404 : 409, { error: error.message });
      }
      return true;
    }
    if (pathname === "/api/cluster/register" && request.method === "POST") {
      try {
        if (!this.isMaster()) throw new Error("This server is not configured as a master.");
        const body = await collectJson(request);
        const profile = validateProfile({ ...body.profile, role: "slave", masterUrl: this.publicUrl() }, body.profile?.id);
        let entry = this.registry.get(profile.id);
        if (!entry && this.registry.size >= MAX_SLAVES) throw new Error("This master already has the maximum of three slave nodes.");
        entry = { ...entry, profile, baseUrl: normalizeMasterUrl(body.baseUrl), pipeline: body.pipeline || {}, lastSeen: new Date().toISOString(), token: entry?.token || crypto.randomBytes(32).toString("base64url") };
        this.registry.set(profile.id, entry);
        this.saveRegistry();
        sendJson(response, 200, { token: entry.token, master: publicNode(this.profile) });
      } catch (error) { sendJson(response, 400, { error: error.message }); }
      return true;
    }
    const runUpdate = /^\/api\/cluster\/runs\/([^/]+)$/.exec(pathname);
    if (runUpdate && request.method === "PUT") {
      try {
        const body = await collectJson(request, 2 * 1024 * 1024);
        const nodeId = body.run?.nodeId;
        const entry = this.registryEntryForRequest(request, nodeId);
        if (!entry) throw new Error("Unauthorized slave update.");
        entry.lastSeen = new Date().toISOString();
        entry.pipeline = { ...entry.pipeline, active: ["queued", "running"].includes(body.run.status) };
        const run = { ...body.run, ...this.nodeMetadata(entry.profile), logs: Array.isArray(body.run.logs) ? body.run.logs.slice(-500) : [] };
        this.adminService.upsertExternalRun(run);
        sendJson(response, 200, { accepted: true });
      } catch (error) { sendJson(response, 401, { error: error.message }); }
      return true;
    }
    const remoteCancel = /^\/api\/cluster\/runs\/([^/]+)\/cancel$/.exec(pathname);
    if (remoteCancel && request.method === "POST") {
      try {
        if (!this.isSlave() || !this.authorized(request, this.masterToken)) throw new Error("Unauthorized master cancellation.");
        sendJson(response, 202, { run: this.adminService.cancelRun(decodeURIComponent(remoteCancel[1])) });
      } catch (error) {
        sendJson(response, /Unauthorized/.test(error.message) ? 401 : error.code === "RUN_NOT_FOUND" ? 404 : 409, { error: error.message });
      }
      return true;
    }
    const remoteStart = /^\/api\/cluster\/runs\/([^/]+)\/start$/.exec(pathname);
    if (remoteStart && request.method === "POST") {
      try {
        if (!this.isSlave() || !this.authorized(request, this.masterToken)) throw new Error("Unauthorized master start.");
        sendJson(response, 202, { run: this.adminService.startQueuedRun(decodeURIComponent(remoteStart[1])) });
      } catch (error) {
        sendJson(response, /Unauthorized/.test(error.message) ? 401 : error.code === "RUN_NOT_FOUND" ? 404 : 409, { error: error.message });
      }
      return true;
    }
    if (pathname === "/api/cluster/trigger" && request.method === "POST") {
      try {
        if (!this.isSlave() || !this.authorized(request, this.masterToken)) throw new Error("Unauthorized master trigger.");
        const body = await collectJson(request);
        sendJson(response, 202, { run: await (body.queueOnly
          ? this.queueRun("master", { ...body.options, nodeId: this.profile.id })
          : this.startRun("master", { ...body.options, nodeId: this.profile.id })) });
      } catch (error) { sendJson(response, error.code === "RUN_ACTIVE" ? 409 : 400, { error: error.message }); }
      return true;
    }
    const upload = /^\/api\/cluster\/results\/([^/]+)\/file$/.exec(pathname);
    if (upload && request.method === "PUT") {
      try {
        if (!this.isMaster()) throw new Error("Not a master node.");
        const nodeId = [...this.registry.entries()].find(([, entry]) => this.authorized(request, entry.token))?.[0];
        if (!nodeId) throw new Error("Unauthorized artifact upload.");
        const relative = safeRelativeFile(new URL(request.url, "http://local").searchParams.get("path"));
        if (!relative) throw new Error("Invalid artifact path.");
        const target = path.join(this.forecastRoot, nodeId, ".incoming", upload[1], relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, await collectBody(request, 16 * 1024 * 1024));
        sendJson(response, 200, { accepted: true });
      } catch (error) { sendJson(response, 400, { error: error.message }); }
      return true;
    }
    const complete = /^\/api\/cluster\/results\/([^/]+)\/complete$/.exec(pathname);
    if (complete && request.method === "POST") {
      try {
        const nodeId = [...this.registry.entries()].find(([, entry]) => this.authorized(request, entry.token))?.[0];
        if (!this.isMaster() || !nodeId) throw new Error("Unauthorized artifact upload.");
        const body = await collectJson(request);
        this.completeUploadedForecast(nodeId, complete[1], body.publishedRunId);
        sendJson(response, 200, { accepted: true });
      } catch (error) { sendJson(response, 400, { error: error.message }); }
      return true;
    }
    return false;
  }
}

module.exports = { ClusterService, CONFIG_LABELS, NODE_CONFIGS, NODE_MODELS, computeDeviceFor, normalizeMasterUrl, validateProfile };
