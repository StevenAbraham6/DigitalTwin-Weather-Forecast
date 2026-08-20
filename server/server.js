const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const QRCode = require("qrcode");
const { WebSocketServer, WebSocket } = require("ws");
const { VERSION, ROLES } = require("../shared/protocol.js");
const { AdminService } = require("./admin-service.js");

const projectRoot = path.resolve(__dirname, "..");
const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || "0.0.0.0";
const maxMessageBytes = 32 * 1024;
const sessions = new Map();
const forecastPublishRoot = path.join(projectRoot, "pipeline", "output", "era5t-graphcast-small", "published");
const adminService = new AdminService({ projectRoot, publishRoot: forecastPublishRoot });

const mimeTypes = {
  ".bin": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webp": "image/webp",
};

function sendJson(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function localAddress() {
  const interfaces = os.networkInterfaces();
  const preferredNames = ["en0", "en1", "Wi-Fi", "Ethernet"];
  const candidates = [];
  Object.entries(interfaces).forEach(([name, addresses]) => {
    (addresses || []).forEach((address) => {
      if (address.family === "IPv4" && !address.internal) candidates.push({ name, address: address.address });
    });
  });
  candidates.sort((a, b) => {
    const aIndex = preferredNames.indexOf(a.name);
    const bIndex = preferredNames.indexOf(b.name);
    return (aIndex < 0 ? 99 : aIndex) - (bIndex < 0 ? 99 : bIndex);
  });
  return candidates[0]?.address || "localhost";
}

function publicBaseUrl(request) {
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const protocol = forwardedProtocol || "http";
  const requestHost = request.headers.host || `${localAddress()}:${port}`;
  const hostName = requestHost.split(":")[0];
  const publicHost = ["localhost", "127.0.0.1", "0.0.0.0"].includes(hostName)
    ? `${localAddress()}:${port}`
    : requestHost;
  return `${protocol}://${publicHost}`;
}

function makePairCode() {
  let code;
  do code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  while ([...sessions.values()].some((session) => session.pairCode === code));
  return code;
}

async function createSession(socket, request) {
  const id = crypto.randomUUID();
  const pairToken = crypto.randomBytes(24).toString("base64url");
  const pairCode = makePairCode();
  const baseUrl = publicBaseUrl(request);
  const controllerUrl = `${baseUrl}/controller/#pair=${encodeURIComponent(pairToken)}`;
  const qrCodeDataUrl = await QRCode.toDataURL(controllerUrl, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320,
    color: { dark: "#071510", light: "#ffffff" },
  });
  const session = {
    id,
    pairToken,
    pairCode,
    display: socket,
    controller: null,
    lastState: null,
    createdAt: Date.now(),
  };
  sessions.set(id, session);
  socket.sessionId = id;
  socket.role = ROLES.DISPLAY;
  sendJson(socket, {
    type: "session.created",
    sessionId: id,
    pairCode,
    controllerUrl,
    qrCodeDataUrl,
  });
}

function findSession(credentials = {}) {
  const normalizedCode = String(credentials.pairCode || "").replace(/\D/g, "");
  return [...sessions.values()].find((session) => (
    (credentials.pairToken && safeTokenEqual(String(credentials.pairToken), session.pairToken))
    || (normalizedCode.length === 6 && session.pairCode === normalizedCode)
  ));
}

function safeTokenEqual(candidate, expected) {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length && crypto.timingSafeEqual(candidateBytes, expectedBytes);
}

function attachController(socket, credentials) {
  const session = findSession(credentials);
  if (!session || session.display.readyState !== WebSocket.OPEN) {
    sendJson(socket, { type: "session.error", code: "PAIRING_NOT_FOUND", message: "That display could not be found." });
    return;
  }
  if (session.controller && session.controller.readyState === WebSocket.OPEN) {
    sendJson(socket, { type: "session.error", code: "CONTROLLER_IN_USE", message: "That display already has a controller." });
    return;
  }
  session.controller = socket;
  socket.sessionId = session.id;
  socket.role = ROLES.CONTROLLER;
  sendJson(socket, { type: "session.paired", sessionId: session.id });
  sendJson(session.display, { type: "controller.status", connected: true });
  sendJson(session.display, { type: "state.request" });
  if (session.lastState) sendJson(socket, session.lastState);
}

function handleSocketMessage(socket, request, data, isBinary) {
  if (isBinary || data.length > maxMessageBytes) {
    socket.close(1009, "Message too large");
    return;
  }
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    sendJson(socket, { type: "protocol.error", message: "Messages must be valid JSON." });
    return;
  }

  if (!socket.role) {
    if (message.type !== "hello" || message.protocolVersion !== VERSION) {
      sendJson(socket, { type: "protocol.error", message: "Unsupported controller protocol." });
      socket.close(1002, "Protocol mismatch");
      return;
    }
    if (message.role === ROLES.DISPLAY) createSession(socket, request).catch(() => socket.close(1011, "Could not create session"));
    else if (message.role === ROLES.CONTROLLER) attachController(socket, message);
    else socket.close(1008, "Unknown role");
    return;
  }

  const session = sessions.get(socket.sessionId);
  if (!session) return;
  if (socket.role === ROLES.CONTROLLER && message.type === "command") {
    if (!message.command || typeof message.command.type !== "string") return;
    sendJson(session.display, message);
    return;
  }
  if (socket.role === ROLES.DISPLAY && message.type === "controller.disconnect") {
    const controller = session.controller;
    session.controller = null;
    sendJson(controller, { type: "session.ended", message: "The globe display disconnected this iPad controller." });
    controller?.close(1000, "Disconnected by display");
    sendJson(session.display, { type: "controller.status", connected: false });
    return;
  }
  if (socket.role === ROLES.DISPLAY && ["state", "event", "command.result"].includes(message.type)) {
    if (message.type === "state") session.lastState = message;
    sendJson(session.controller, message);
  }
}

function detachSocket(socket) {
  const session = sessions.get(socket.sessionId);
  if (!session) return;
  if (socket.role === ROLES.DISPLAY) {
    sendJson(session.controller, { type: "session.ended", message: "The globe display disconnected." });
    session.controller?.close(1001, "Display disconnected");
    sessions.delete(session.id);
  } else if (socket.role === ROLES.CONTROLLER && session.controller === socket) {
    session.controller = null;
    sendJson(session.display, { type: "controller.status", connected: false });
  }
}

function safeFilePath(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, "http://local").pathname);
  } catch {
    return null;
  }
  if (pathname === "/") pathname = "/index.html";
  if (pathname === "/controller") pathname = "/controller/";
  if (pathname === "/admin") pathname = "/admin/";
  if (pathname.endsWith("/")) pathname += "index.html";
  if (pathname === "/forecasts" || pathname.startsWith("/forecasts/")) {
    const forecastPath = path.resolve(forecastPublishRoot, `.${pathname.slice("/forecasts".length)}`);
    return forecastPath === forecastPublishRoot || forecastPath.startsWith(`${forecastPublishRoot}${path.sep}`)
      ? forecastPath
      : null;
  }
  const filePath = path.resolve(projectRoot, `.${pathname}`);
  return filePath === projectRoot || filePath.startsWith(`${projectRoot}${path.sep}`) ? filePath : null;
}

function cacheControl(filePath) {
  const relativePath = path.relative(projectRoot, filePath).split(path.sep).join("/");
  const forecastRelativePath = path.relative(forecastPublishRoot, filePath).split(path.sep).join("/");
  const isMutableForecastIndex = forecastRelativePath === "catalog.json"
    || /(^|\/)latest\/manifest\.json$/.test(forecastRelativePath);
  const isAdminAsset = relativePath === "admin" || relativePath.startsWith("admin/");
  return filePath.endsWith(".html") || isMutableForecastIndex || isAdminAsset
    ? "no-cache"
    : "public, max-age=300";
}

const server = http.createServer(async (request, response) => {
  if (!request.url) {
    response.writeHead(400).end("Bad request");
    return;
  }
  let pathname;
  try {
    pathname = new URL(request.url, "http://local").pathname;
  } catch {
    response.writeHead(400).end("Bad request");
    return;
  }
  try {
    if (pathname.startsWith("/api/admin/") && await adminService.handleRequest(request, response, pathname)) return;
  } catch (error) {
    console.error(`Admin API error: ${error.message}`);
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Admin request failed." }));
    return;
  }
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405).end("Method not allowed");
    return;
  }
  const filePath = safeFilePath(pathname);
  if (!filePath) {
    response.writeHead(400).end("Bad request");
    return;
  }
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    const headers = {
      "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": cacheControl(filePath),
      "X-Content-Type-Options": "nosniff",
    };
    response.writeHead(200, headers);
    if (request.method === "HEAD") response.end();
    else fs.createReadStream(filePath).pipe(response);
  });
});

const websocketServer = new WebSocketServer({ server, path: "/ws", maxPayload: maxMessageBytes });
websocketServer.on("error", (error) => {
  if (error.code !== "EADDRINUSE") console.error(`WebSocket server error: ${error.message}`);
});
websocketServer.on("connection", (socket, request) => {
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });
  socket.on("message", (data, isBinary) => handleSocketMessage(socket, request, data, isBinary));
  socket.on("close", () => detachSocket(socket));
  socket.on("error", () => detachSocket(socket));
});

const heartbeat = setInterval(() => {
  websocketServer.clients.forEach((socket) => {
    if (!socket.isAlive) {
      socket.terminate();
      return;
    }
    socket.isAlive = false;
    socket.ping();
  });
}, 20_000);

server.listen(port, host, () => {
  const lanUrl = `http://${localAddress()}:${port}`;
  console.log(`Digital Twin Earth display: http://localhost:${port}`);
  console.log(`iPad controller: ${lanUrl}/controller/`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") console.error(`Port ${port} is already in use. Stop the existing server or run with PORT=8090 npm start.`);
  else if (error.code === "EACCES" || error.code === "EPERM") console.error(`The server is not allowed to listen on ${host}:${port}.`);
  else console.error(`Server error: ${error.message}`);
  process.exitCode = 1;
});

function shutdown() {
  clearInterval(heartbeat);
  adminService.close();
  websocketServer.clients.forEach((socket) => socket.terminate());
  websocketServer.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
