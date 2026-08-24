#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const RULE_PATH = "/etc/udev/rules.d/99-digital-twin-energy.rules";
const POWERCAP_ROOT = "/sys/class/powercap";

function energyFiles(root = POWERCAP_ROOT) {
  const files = [];
  let entries = [];
  try { entries = fs.readdirSync(root); } catch { return files; }
  for (const entry of entries.filter((name) => /^intel-rapl:\d+$/.test(name))) {
    const file = path.join(root, entry, "energy_uj");
    try { if (fs.statSync(file).isFile()) files.push(file); } catch { /* unavailable zone */ }
  }
  return files;
}

function ruleForGroup(groupId) {
  return [
    "# Managed by Digital Twin 2.0. Grants the application group read-only Intel RAPL access.",
    `ACTION=="add", SUBSYSTEM=="powercap", KERNEL=="intel-rapl:[0-9]*", RUN+="/bin/chgrp ${groupId} /sys%p/energy_uj", RUN+="/bin/chmod o-r,g+r /sys%p/energy_uj"`,
    "",
  ].join("\n");
}

function serviceGroupId() {
  const value = process.env.ENERGY_SERVICE_GID || process.env.SUDO_GID;
  if (!/^\d+$/.test(String(value || ""))) {
    throw new Error("Run this through sudo from the account that runs the Digital Twin service.");
  }
  return Number(value);
}

function install() {
  if (process.platform !== "linux") throw new Error("Energy access setup is only required on Linux nodes.");
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("Root access is required. Run: sudo npm run setup:energy-access");
  }
  const groupId = serviceGroupId();
  fs.writeFileSync(RULE_PATH, ruleForGroup(groupId), { encoding: "utf8", mode: 0o644 });
  for (const file of energyFiles()) {
    const stat = fs.statSync(file);
    fs.chownSync(file, stat.uid, groupId);
    fs.chmodSync(file, (stat.mode & 0o770) | 0o040);
  }
  try { execFileSync("udevadm", ["control", "--reload-rules"], { stdio: "ignore" }); } catch { /* rule is still available after reboot */ }
  process.stdout.write("Intel CPU energy access is installed and will persist across reboots.\n");
}

if (require.main === module) {
  try { install(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { RULE_PATH, energyFiles, ruleForGroup, serviceGroupId };
