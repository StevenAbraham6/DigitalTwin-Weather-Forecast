#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { RULE_PATH, energyFiles, ruleForGroup } = require("./setup-energy-access.js");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(PROJECT_ROOT, "server", "server.js");
const SETUP_PATH = path.join(__dirname, "setup-energy-access.js");

function needsEnergyAccessSetup() {
  if (process.platform !== "linux") return false;
  const files = energyFiles();
  if (files.length === 0) return false;
  const groupId = typeof process.getgid === "function" ? process.getgid() : null;
  let ruleInstalled = false;
  try {
    ruleInstalled = groupId !== null && fs.readFileSync(RULE_PATH, "utf8") === ruleForGroup(groupId);
  } catch { /* not installed */ }
  const counterUnreadable = files.some((file) => {
    try {
      fs.accessSync(file, fs.constants.R_OK);
      return false;
    } catch {
      return true;
    }
  });
  return !ruleInstalled || counterUnreadable;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: PROJECT_ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function start() {
  if (needsEnergyAccessSetup()) {
    process.stdout.write("One-time setup: CPU energy monitoring needs administrator access.\n");
    run("sudo", [process.execPath, SETUP_PATH]);
  }
  run(process.execPath, [SERVER_PATH]);
}

if (require.main === module) {
  try { start(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { needsEnergyAccessSetup };
