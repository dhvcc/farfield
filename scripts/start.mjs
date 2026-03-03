#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const bunBinary = process.platform === "win32" ? "bun.exe" : "bun";
const nodeBinary = process.execPath;
const ownedRunnerPath = fileURLToPath(new URL("./owned-runner.mjs", import.meta.url));

function spawnOwnedCommand(command) {
  return spawn(
    nodeBinary,
    [
      ownedRunnerPath,
      `--owner-pid=${process.pid}`,
      "--",
      ...command
    ],
    {
      stdio: "inherit",
      env: process.env
    }
  );
}

const serverProcess = spawnOwnedCommand([
  bunBinary,
  "run",
  "--filter",
  "@farfield/server",
  "start"
]);
const webProcess = spawnOwnedCommand([
  bunBinary,
  "run",
  "--filter",
  "@farfield/web",
  "start"
]);

const childProcesses = [serverProcess, webProcess];
let terminating = false;
let firstExit = {
  code: null,
  signal: null
};

const stopChildren = (signal) => {
  if (terminating) {
    return;
  }
  terminating = true;
  for (const child of childProcesses) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
};

process.on("SIGINT", () => stopChildren("SIGINT"));
process.on("SIGTERM", () => stopChildren("SIGTERM"));

let remainingChildren = childProcesses.length;
for (const child of childProcesses) {
  child.on("exit", (code, signal) => {
    if (firstExit.code === null && firstExit.signal === null) {
      firstExit = { code, signal };
    }

    remainingChildren -= 1;
    if (!terminating && remainingChildren > 0) {
      stopChildren("SIGTERM");
    }

    if (remainingChildren === 0) {
      if (firstExit.signal) {
        process.kill(process.pid, firstExit.signal);
        return;
      }
      process.exit(firstExit.code ?? 0);
    }
  });
}
