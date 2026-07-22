const assert = require("node:assert/strict");
const { WebSocket } = require("ws");
const protocol = require("../shared/protocol.js");

const websocketUrl = process.env.DIGITAL_TWIN_WS_URL || "ws://127.0.0.1:8080/ws";

function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitFor(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);
    function onMessage(data) {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    }
    socket.on("message", onMessage);
  });
}

async function pairController(display, credentials) {
  const controller = await connect();
  const paired = waitFor(controller, (message) => message.type === "session.paired");
  controller.send(JSON.stringify({
    type: "hello",
    role: protocol.ROLES.CONTROLLER,
    protocolVersion: protocol.VERSION,
    ...credentials,
  }));
  await paired;
  return controller;
}

async function run() {
  const display = await connect();
  const sessionCreated = waitFor(display, (message) => message.type === "session.created");
  display.send(JSON.stringify({
    type: "hello",
    role: protocol.ROLES.DISPLAY,
    protocolVersion: protocol.VERSION,
  }));
  const session = await sessionCreated;
  assert.match(session.pairCode, /^\d{6}$/);
  assert.match(session.qrCodeDataUrl, /^data:image\/png;base64,/);
  assert.match(session.controllerUrl, /\/controller\/#pair=/);

  const displayConnected = waitFor(display, (message) => message.type === "controller.status" && message.connected);
  const controller = await pairController(display, { pairToken: new URL(session.controllerUrl).hash.slice("#pair=".length) });
  await displayConnected;

  const commandReceived = waitFor(display, (message) => message.type === "command");
  controller.send(JSON.stringify({
    type: "command",
    id: 1,
    command: { type: protocol.COMMANDS.CAMERA_RESET },
  }));
  assert.equal((await commandReceived).command.type, protocol.COMMANDS.CAMERA_RESET);

  const stateReceived = waitFor(controller, (message) => message.type === "state");
  display.send(JSON.stringify({ type: "state", state: { revision: 1, test: true } }));
  assert.equal((await stateReceived).state.test, true);

  const displayDisconnected = waitFor(display, (message) => message.type === "controller.status" && !message.connected);
  controller.close();
  await displayDisconnected;

  const displayReconnected = waitFor(display, (message) => message.type === "controller.status" && message.connected);
  const controllerByCode = await pairController(display, { pairCode: session.pairCode });
  await displayReconnected;

  const controllerEnded = waitFor(controllerByCode, (message) => message.type === "session.ended");
  const displayDisconnectedByRequest = waitFor(display, (message) => message.type === "controller.status" && !message.connected);
  display.send(JSON.stringify({ type: "controller.disconnect" }));
  assert.match((await controllerEnded).message, /disconnected this iPad controller/i);
  await displayDisconnectedByRequest;

  display.close();
  console.log("Controller pairing, command routing, state sync, QR token, manual code, and display-side disconnect passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
