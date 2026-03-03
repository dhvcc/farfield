#!/usr/bin/env node

import { spawn } from "node:child_process";

const OWNER_CHECK_INTERVAL_MS = 1000;
const FORCE_KILL_DELAY_MS = 2000;

function exitWithError(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  let ownerPidRaw = "";
  let separatorIndex = -1;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      separatorIndex = index;
      break;
    }
    if (arg.startsWith("--owner-pid=")) {
      ownerPidRaw = arg.slice("--owner-pid=".length);
      continue;
    }
    if (arg === "--owner-pid") {
      const nextArg = argv[index + 1];
      if (!nextArg) {
        exitWithError("Missing value for --owner-pid");
      }
      ownerPidRaw = nextArg;
      index += 1;
      continue;
    }

    exitWithError(`Unknown argument: ${arg}`);
  }

  if (!ownerPidRaw) {
    exitWithError("--owner-pid is required");
  }

  if (separatorIndex < 0) {
    exitWithError("Missing -- separator before command");
  }

  const ownerPid = Number.parseInt(ownerPidRaw, 10);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
    exitWithError(`Invalid --owner-pid value: ${ownerPidRaw}`);
  }

  const command = argv.slice(separatorIndex + 1);
  if (command.length === 0) {
    exitWithError("Missing command after --");
  }

  return { ownerPid, command };
}

function isOwnerAlive(ownerPid) {
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    return true;
  }
}

function isChildRunning(childProcess) {
  return (
    childProcess.exitCode === null &&
    childProcess.signalCode === null &&
    !childProcess.killed
  );
}

function terminateChild(childProcess, signal) {
  if (!isChildRunning(childProcess)) {
    return;
  }

  if (process.platform === "win32") {
    childProcess.kill(signal);
    return;
  }

  const childPid = childProcess.pid;
  if (!childPid) {
    return;
  }

  try {
    process.kill(-childPid, signal);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return;
    }
    throw error;
  }
}

const args = parseArgs(process.argv.slice(2));

const childProcess = spawn(args.command[0], args.command.slice(1), {
  stdio: "inherit",
  env: process.env,
  detached: process.platform !== "win32",
});

let shuttingDown = false;
let ownerMissing = false;
let ownerCheckTimer = null;
let forceKillTimer = null;

function clearTimers() {
  if (ownerCheckTimer) {
    clearInterval(ownerCheckTimer);
    ownerCheckTimer = null;
  }
  if (forceKillTimer) {
    clearTimeout(forceKillTimer);
    forceKillTimer = null;
  }
}

function removeSignalHandlers() {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  process.off("SIGHUP", onSighup);
  process.off("uncaughtException", onUncaughtException);
  process.off("unhandledRejection", onUnhandledRejection);
}

function beginShutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearTimers();

  try {
    terminateChild(childProcess, signal);
  } catch (error) {
    process.stderr.write(`Failed to terminate child: ${String(error)}\n`);
  }

  forceKillTimer = setTimeout(() => {
    try {
      terminateChild(childProcess, "SIGKILL");
    } catch (error) {
      process.stderr.write(`Failed to force kill child: ${String(error)}\n`);
    }
  }, FORCE_KILL_DELAY_MS);
  forceKillTimer.unref?.();
}

function onSigint() {
  beginShutdown("SIGINT");
}

function onSigterm() {
  beginShutdown("SIGTERM");
}

function onSighup() {
  beginShutdown("SIGTERM");
}

function onUncaughtException(error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  beginShutdown("SIGTERM");
}

function onUnhandledRejection(reason) {
  const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  process.stderr.write(`${message}\n`);
  beginShutdown("SIGTERM");
}

process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
process.on("SIGHUP", onSighup);
process.on("uncaughtException", onUncaughtException);
process.on("unhandledRejection", onUnhandledRejection);

ownerCheckTimer = setInterval(() => {
  if (isOwnerAlive(args.ownerPid)) {
    return;
  }
  ownerMissing = true;
  beginShutdown("SIGTERM");
}, OWNER_CHECK_INTERVAL_MS);
ownerCheckTimer.unref?.();

childProcess.on("error", (error) => {
  clearTimers();
  removeSignalHandlers();
  process.stderr.write(`Failed to spawn command: ${error.message}\n`);
  process.exit(1);
});

childProcess.on("exit", (code, signal) => {
  clearTimers();
  removeSignalHandlers();

  if (ownerMissing) {
    process.exit(1);
    return;
  }

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
